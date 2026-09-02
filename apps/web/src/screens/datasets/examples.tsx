import {
  useMemo,
  useState
} from "react";
import {
  X
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import {
  Button
} from "@/components/ui/button";
import {
  Input
} from "@/components/ui/input";
import {
  createDataset,
  importDatasetExamples
} from "@/lib/api";
import {
  useDialogFocus
} from "@/hooks/use-dialog-focus";
import {
  type Dataset,
  type DatasetExampleInput
} from "@coeval/shared";

// --- Add examples: forgiving JSONL/JSON parse + import -----------------------

interface ParsedExamples {
  items: DatasetExampleInput[];
  errors: Array<{ line: number; message: string }>;
  unlabeled: number;
}

// Accepts JSONL (one object per line) or a single JSON array. Malformed rows
// surface with line numbers instead of failing the whole paste — a 200-row
// file with two bad lines should still load 198. `expected` is accepted as an
// alias for `expectedLabel`; null/missing means "no expected label" (a named
// state downstream, never silently defaulted).
export function parseExamplesText(text: string): ParsedExamples {
  const items: DatasetExampleInput[] = [];
  const errors: Array<{ line: number; message: string }> = [];
  let unlabeled = 0;

  const pushRow = (row: unknown, line: number) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      errors.push({ line, message: "not a JSON object" });
      return;
    }
    const record = row as Record<string, unknown>;
    // Empty/whitespace strings mean "absent" — an empty expectedLabel must
    // fall through to the `expected` alias instead of shadowing it.
    const normalize = (value: unknown) =>
      typeof value === "string" && value.trim() === "" ? undefined : value;
    const rawLabel = normalize(record.expectedLabel) ?? normalize(record.expected);
    let expectedLabel: "pass" | "fail" | undefined;
    if (rawLabel === "pass" || rawLabel === "fail") expectedLabel = rawLabel;
    else if (rawLabel !== undefined && rawLabel !== null) {
      errors.push({ line, message: `expected label must be "pass" or "fail" (got ${JSON.stringify(rawLabel)})` });
      return;
    }
    if (!("input" in record) && !("output" in record)) {
      errors.push({ line, message: "needs at least an input or an output field" });
      return;
    }
    if (!expectedLabel) unlabeled += 1;
    items.push({
      input: record.input ?? null,
      output: record.output ?? null,
      ...(typeof record.name === "string" && record.name.trim() ? { name: record.name.trim() } : {}),
      ...(expectedLabel ? { expectedLabel } : {}),
      ...(typeof record.note === "string" && record.note ? { note: record.note } : {})
    });
  };

  const trimmed = text.trim();
  if (!trimmed) return { items, errors, unlabeled };
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
      parsed.forEach((row, index) => pushRow(row, index + 1));
    } catch (err) {
      errors.push({ line: 1, message: err instanceof Error ? err.message.slice(0, 80) : String(err) });
    }
    return { items, errors, unlabeled };
  }
  trimmed.split("\n").forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    try {
      pushRow(JSON.parse(line), index + 1);
    } catch (err) {
      errors.push({ line: index + 1, message: err instanceof Error ? err.message.slice(0, 80) : String(err) });
    }
  });
  return { items, errors, unlabeled };
}

const NEW_DATASET = "__new__";
const SAMPLE_EXAMPLES = `{"input": "Where is my refund??", "output": "Order is past the window; I can't help.", "expected": "fail"}
{"input": "Thanks, that fixed it!", "output": "Glad to hear it — anything else?", "expected": "pass"}
{"input": "ok", "output": "Let me know if you need anything.", "expected": null}`;

export function AddExamplesModal({
  datasets,
  onClose,
  onImported
}: {
  datasets: Dataset[];
  onClose: () => void;
  onImported: (datasetId: string) => Promise<void>;
}) {
  const [datasetChoice, setDatasetChoice] = useState<string>(datasets[0]?.id ?? NEW_DATASET);
  const [newName, setNewName] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>({ onClose, closeOnEscape: !busy });

  const parsed = useMemo(() => parseExamplesText(text), [text]);
  const needsName = datasetChoice === NEW_DATASET;
  const canSubmit = parsed.items.length > 0 && !busy && (!needsName || newName.trim().length > 0);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setServerError(null);
    try {
      const datasetId = needsName
        ? (await createDataset({ name: newName.trim() })).id
        : datasetChoice;
      await importDatasetExamples(datasetId, parsed.items);
      await onImported(datasetId);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-examples-title"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 sm:items-center"
      onClick={(e) => {
        if (!busy && e.target === e.currentTarget) onClose();
      }}
    >
      <Card className="max-h-[calc(100dvh-2rem)] w-full max-w-full overflow-y-auto shadow-elev sm:w-[720px]" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <div className="min-w-0 flex-1">
            <CardTitle id="add-examples-title">Add examples</CardTitle>
            <CardDescription>
              Paste JSONL — one <code>{'{"input", "output", "expected"}'}</code> object per line — or a
              JSON array. Nothing is judged on upload; run an eval when you're ready. Re-pasting an
              unchanged example reuses its case; an edited one becomes a fresh case.
            </CardDescription>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close add examples dialog"
            className="-mr-1 inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-sm text-ink-3 hover:bg-paper-3"
          >
            <X className="size-3.5" />
          </button>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="add-examples-dataset" className="eyebrow">Dataset</label>
              <select
                id="add-examples-dataset"
                data-dialog-initial-focus
                value={datasetChoice}
                onChange={(e) => setDatasetChoice(e.target.value)}
                className="h-9 rounded-sm border border-rule-soft bg-card-2 px-2 text-[12.5px] text-ink focus-visible:border-ink"
              >
                {datasets.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>
                    {dataset.name} · {dataset.itemCount} case{dataset.itemCount === 1 ? "" : "s"}
                  </option>
                ))}
                <option value={NEW_DATASET}>+ New dataset…</option>
              </select>
            </div>
            {needsName ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="add-examples-dataset-name" className="eyebrow">New dataset name</label>
                <Input
                  id="add-examples-dataset-name"
                  placeholder="e.g. Support replies · v1"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between">
              <label htmlFor="add-examples-input" className="eyebrow">Examples · JSONL or JSON array</label>
              <span className="font-mono text-[10.5px] tracking-[0.04em] text-ink-3">
                {parsed.items.length} parsed
                {parsed.unlabeled > 0 ? ` · ${parsed.unlabeled} without expected label` : ""}
                {parsed.errors.length > 0 ? ` · ${parsed.errors.length} malformed` : ""}
              </span>
            </div>
            <textarea
              id="add-examples-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={SAMPLE_EXAMPLES}
              spellCheck={false}
              className="min-h-[180px] resize-y rounded-sm border border-rule-soft bg-card-2 px-2 py-1.5 font-mono text-[11.5px] leading-[1.5] text-ink focus-visible:border-ink"
            />
            {parsed.errors.length > 0 ? (
              <div role="alert" className="max-h-[72px] overflow-y-auto font-mono text-[10.5px] leading-[1.6] text-signal">
                {parsed.errors.slice(0, 8).map((error) => (
                  <div key={`${error.line}-${error.message}`}>
                    line {error.line}: {error.message}
                  </div>
                ))}
                {parsed.errors.length > 8 ? <div>… {parsed.errors.length - 8} more</div> : null}
              </div>
            ) : null}
            <div className="text-[11px] leading-[1.5] text-ink-3">
              <code>expected</code> is optional — <code>"pass"</code> or <code>"fail"</code>. Rows
              without it are stored and judged, but never counted in agreement. Malformed rows are
              skipped, good rows still load.
            </div>
          </div>

          {serverError ? <div role="alert" className="text-[12px] text-signal">{serverError}</div> : null}

          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <div className="flex-1" />
            <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit}>
              {busy
                ? "Adding…"
                : `Add ${parsed.items.length || ""} example${parsed.items.length === 1 ? "" : "s"}`}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
