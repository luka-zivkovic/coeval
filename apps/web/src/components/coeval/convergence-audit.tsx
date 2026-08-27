import { Link } from "react-router-dom";
import { ArrowRight, Minus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Table } from "@/components/ui/table";
import { Eyebrow } from "./eyebrow";
import { MarginNote } from "./margin-note";
import { Chip, LabelChip } from "./chip";
import type { ConvergenceAudit, ConvergenceCaseChange } from "@coeval/shared";

// Below this many re-judged adjudicated cases, the improved/regressed counts are
// noise — the card shows the data but withholds a confident headline (per the
// A2.2c min-N acceptance criterion).
const MIN_RELIABLE_N = 3;

// Label rendering is single-sourced in LabelChip (chip.tsx).

const CHANGE_META: Record<ConvergenceCaseChange, { label: string; variant: "pass" | "fail" | "ambig" | "outline" }> = {
  improved: { label: "fixed", variant: "pass" },
  regressed: { label: "broke", variant: "fail" },
  still_agree: { label: "on track", variant: "outline" },
  still_disagree: { label: "still off", variant: "ambig" }
};

export function ConvergenceCard({
  audit,
  versionLabel,
  beforeVersionLabel
}: {
  audit: ConvergenceAudit;
  versionLabel: string;
  beforeVersionLabel: string | null;
}) {
  // No recorded legacy adjudication to compare against yet.
  if (audit.adjudicatedTotal === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-4">
          <Eyebrow>Convergence on adjudicated cases</Eyebrow>
          <div className="mt-2 max-w-[70ch] text-[13px] text-ink-3">
            No adjudicated cases yet. Resolve judge-vs-reviewer disagreements on the{" "}
            <Link to="/reliability" className="underline decoration-rule-soft underline-offset-2 hover:text-ink">
              Reliability
            </Link>{" "}
            screen to record legacy rulings. This card will then compare the evaluator with those
            ungoverned, self-selected references.
          </div>
        </CardContent>
      </Card>
    );
  }

  // Recorded rulings exist, but this version never re-judged any of them.
  if (audit.comparedCases === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-4">
          <Eyebrow>Convergence on adjudicated cases</Eyebrow>
          <div className="mt-2 max-w-[70ch] text-[13px] text-ink-3">
            This version has not evaluated any of the {audit.adjudicatedTotal} adjudicated case
            {audit.adjudicatedTotal === 1 ? "" : "s"}. Run it over those cases before comparing its
            results with the recorded rulings.
          </div>
        </CardContent>
      </Card>
    );
  }

  const hasPredecessor = audit.beforeVersionId !== null;
  const reliable = audit.comparedCases >= MIN_RELIABLE_N;
  const vsLabel = hasPredecessor ? `vs ${beforeVersionLabel ?? "previous version"}` : "current agreement";

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-baseline justify-between gap-3">
          <Eyebrow>Convergence on adjudicated cases · {vsLabel}</Eyebrow>
          <span className="font-mono text-[10.5px] text-ink-3">
            {audit.comparedCases} of {audit.adjudicatedTotal} adjudicated re-judged
          </span>
        </div>

        <div className="mt-2 max-w-[72ch] text-[13px] text-ink-3">
          This comparison uses only the legacy adjudicated cases that {versionLabel} evaluated.
          The slice is ungoverned and self-selected, so it does not represent broader quality or governed human truth.
        </div>

        {hasPredecessor ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
            <Stat label="Fixed" value={audit.improved} hint={`now agrees with the recorded ruling (${beforeVersionLabel ?? "prior"} didn't)`} />
            <Stat label="Broke" value={audit.regressed} hint={`${beforeVersionLabel ?? "prior"} matched the recorded ruling; this version does not`} tone={audit.regressed > 0 ? "alert" : "default"} />
            <Stat label="Agree now" value={`${audit.afterAgreed}/${audit.comparedCases}`} hint={`was ${audit.beforeAgreed}/${audit.beforeKnown} on ${beforeVersionLabel ?? "prior"}`} />
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
            <Stat label="Agree with rulings" value={`${audit.afterAgreed}/${audit.comparedCases}`} hint="no predecessor to compare — baseline" />
          </div>
        )}

        {!reliable ? (
          <MarginNote tone="neutral" who="Small sample" className="mt-3 max-w-[72ch]">
            Only {audit.comparedCases} adjudicated case{audit.comparedCases === 1 ? "" : "s"} re-judged
            by this version. That is too few to describe a trend, so inspect the cases individually
            until the comparison set grows.
          </MarginNote>
        ) : null}

        <div className="mt-4 rounded-sm border border-rule-soft">
          <Table>
            <thead>
              <tr>
                <th>Case</th>
                <th style={{ width: 110 }}>Recorded ruling</th>
                <th style={{ width: 130 }}>{beforeVersionLabel ?? "Previous"}</th>
                <th style={{ width: 120 }}>This version</th>
                <th style={{ width: 110 }}>Change</th>
              </tr>
            </thead>
            <tbody>
              {audit.cases.map((c) => {
                const meta = c.beforeLabel === null
                  ? c.afterLabel === c.adjudicatedLabel
                    ? { label: "matches ruling", variant: "outline" as const }
                    : { label: "differs from ruling", variant: "ambig" as const }
                  : CHANGE_META[c.change];
                return (
                  <tr key={c.caseId} className="row-signal">
                    <td>
                      <Link
                        to={`/cases/${c.caseId}`}
                        className="font-mono text-[11px] tracking-[0.04em] text-ink-2 underline decoration-rule-soft underline-offset-2 hover:text-ink"
                      >
                        {c.caseId}
                      </Link>
                    </td>
                    <td>
                      <LabelChip label={c.adjudicatedLabel} />
                    </td>
                    <td>
                      {c.beforeLabel ? <LabelChip label={c.beforeLabel} /> : <span className="text-[11px] text-ink-4">No prior judgment</span>}
                    </td>
                    <td>
                      <span className="inline-flex items-center gap-1.5">
                        {c.beforeLabel !== null ? (
                          c.beforeLabel !== c.afterLabel
                            ? <ArrowRight className="size-3 text-ink-4" />
                            : <Minus className="size-3 text-ink-4" />
                        ) : null}
                        <LabelChip label={c.afterLabel} />
                      </span>
                    </td>
                    <td>
                      <Chip variant={meta.variant}>{meta.label}</Chip>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>

        {audit.cases.length < audit.comparedCases ? (
          <div className="mt-2 text-[10.5px] text-ink-4">
            Showing the first {audit.cases.length} of {audit.comparedCases} exact cases. Open Reliability to page through the full ledger.
          </div>
        ) : null}

        <div className="mt-3 font-mono text-[10px] tracking-[0.03em] text-ink-4">
          Adjudicated labels may post-date this version's verdict; read this as “did the edit fix the
          known errors,” not proof the edit alone caused the change.
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = "default"
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "default" | "alert";
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-baseline gap-1.5">
        <span
          className={
            tone === "alert"
              ? "font-serif text-[22px] font-medium tabular-nums text-signal"
              : "font-serif text-[22px] font-medium tabular-nums text-ink"
          }
        >
          {value}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-3">{label}</span>
      </div>
      {hint ? <span className="mt-0.5 text-[11px] text-ink-4">{hint}</span> : null}
    </div>
  );
}
