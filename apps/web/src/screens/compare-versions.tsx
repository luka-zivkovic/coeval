import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table } from "@/components/ui/table";
import { RowLink } from "@/components/row-action";
import {
  Chip,
  Eyebrow,
  GateChip,
  gateStateForVersion,
  KPI,
  KPIRow,
  Ref,
  SectionHead
} from "@/components/coeval";
import {
  fetchCurrentSkill,
  fetchSkillVersionRegression,
  fetchSkillVersions
} from "@/lib/api";
import type { RegressionRunResult, SkillVersion } from "@coeval/shared";
import { useCriterion } from "@/lib/criterion-context";

interface ChainStep {
  version: SkillVersion;
  run: RegressionRunResult | null;
}

// P1-3 · run comparison. Compare any two versions over the known-failure set by
// chaining the RECORDED per-save regression runs between them — every number
// comes from a run that actually happened; nothing synthetic is computed.
export function CompareVersionsScreen() {
  const navigate = useNavigate();
  const { selectedCriterionId } = useCriterion();
  const [searchParams, setSearchParams] = useSearchParams();

  const [skillId, setSkillId] = useState<string | null>(null);
  const [versions, setVersions] = useState<SkillVersion[]>([]); // newest → oldest
  const [loadError, setLoadError] = useState<string | null>(null);
  const [steps, setSteps] = useState<ChainStep[] | null>(null);

  const fromId = searchParams.get("from");
  const toId = searchParams.get("to");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const skill = await fetchCurrentSkill(selectedCriterionId ?? undefined);
        const list = await fetchSkillVersions(skill.id, 200);
        if (cancelled) return;
        setSkillId(skill.id);
        setVersions(list);
        // Default pair: previous → newest. A criterion switch can leave
        // the other lineage's version ids in the URL, so replace stale pairs
        // while preserving the criterion selector and other query state.
        const hasSelectedPair = Boolean(
          fromId && toId
          && list.some((version) => version.id === fromId)
          && list.some((version) => version.id === toId),
        );
        if (!hasSelectedPair && list.length >= 2) {
          setSearchParams(
            (current) => {
              const next = new URLSearchParams(current);
              next.set("from", list[1]!.id);
              next.set("to", list[0]!.id);
              return next;
            },
            { replace: true }
          );
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCriterionId]);

  const iFrom = versions.findIndex((v) => v.id === fromId);
  const iTo = versions.findIndex((v) => v.id === toId);
  const valid = iFrom >= 0 && iTo >= 0 && iFrom > iTo; // from must be older
  const from = (valid ? versions[iFrom] : null) ?? null;
  const to = (valid ? versions[iTo] : null) ?? null;

  // The chain: each version between `to` (inclusive) and `from` (exclusive),
  // newest → oldest. Each one's regression run is the record of the save
  // that produced it.
  const chainVersions = useMemo(
    () => (valid ? versions.slice(iTo, iFrom) : []),
    [versions, valid, iTo, iFrom]
  );

  useEffect(() => {
    if (!skillId || chainVersions.length === 0) {
      setSteps(chainVersions.length === 0 ? [] : null);
      return;
    }
    let cancelled = false;
    setSteps(null);
    void (async () => {
      const loaded = await Promise.all(
        chainVersions.map(async (version) => ({
          version,
          run: await fetchSkillVersionRegression(skillId, version.id).catch(() => null)
        }))
      );
      if (!cancelled) setSteps(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, [skillId, chainVersions]);

  const totals = useMemo(() => {
    const out = { regressed: 0, improved: 0, recorded: 0 };
    for (const step of steps ?? []) {
      if (!step.run) continue;
      out.recorded += 1;
      out.regressed += step.run.regressed;
      out.improved += step.run.improved;
    }
    return out;
  }, [steps]);

  // The newest step's per-case diff — the recorded record of the final hop.
  const newestRun = steps?.[0]?.run ?? null;

  function setPair(nextFrom: string, nextTo: string) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("from", nextFrom);
      next.set("to", nextTo);
      return next;
    }, { replace: true });
  }

  if (loadError) {
    return (
      <div className="fadeUp">
        <SectionHead eyebrow="Run comparison" title="Could not load versions" sub={loadError} />
      </div>
    );
  }

  if (versions.length < 2) {
    return (
      <div className="fadeUp">
        <SectionHead
          eyebrow="Run comparison"
          title="Nothing to compare yet"
          sub="Save at least two evaluator versions before comparing them. Each successful save adds one immutable version to the history."
        />
        <Button variant="default" onClick={() => navigate("/skill/versions")}>
          <ArrowLeft /> All versions
        </Button>
      </div>
    );
  }

  const agreementPct = (v: SkillVersion | null) =>
    v?.goldenSetAgreement == null ? null : Math.round(v.goldenSetAgreement * 100);
  const fromPct = agreementPct(from);
  const toPct = agreementPct(to);

  return (
    <div className="fadeUp max-w-[1760px]">
      <SectionHead
        eyebrow="Evaluator-version comparison · known-failure set"
        title="What changed between two versions"
        sub="Compare the recorded Golden-set checks for two evaluator versions. If the versions are not adjacent, this page combines the saved checks between them; it does not invent missing results."
        right={
          <Button variant="ghost" size="sm" onClick={() => navigate("/skill/versions")}>
            <ArrowLeft /> All versions
          </Button>
        }
      />

      <Card className="mb-5">
        <CardContent className="flex flex-wrap items-center gap-3 py-3.5">
          <Eyebrow>From</Eyebrow>
          <VersionPick
            versions={versions}
            value={fromId}
            exclude={toId}
            onChange={(id) => setPair(id, toId ?? versions[0]!.id)}
          />
          <span className="font-mono text-ink-4">→</span>
          <Eyebrow>To</Eyebrow>
          <VersionPick
            versions={versions}
            value={toId}
            exclude={fromId}
            onChange={(id) => setPair(fromId ?? versions[versions.length - 1]!.id, id)}
          />
          <div className="flex-1" />
          {valid ? (
            <span className="font-mono text-[11px] text-ink-4">
              {chainVersions.length} recorded {chainVersions.length === 1 ? "run" : "runs"} between them
            </span>
          ) : (
            <span className="font-mono text-[11px] text-signal">
              "from" must be the older version — swap the pickers
            </span>
          )}
        </CardContent>
      </Card>

      {valid && from && to ? (
        <>
          <KPIRow className="mb-5">
            <KPI
              label="Known-failure agreement"
              num={
                fromPct == null || toPct == null ? "—" : `${fromPct} → ${toPct}`
              }
              {...(fromPct != null && toPct != null ? { unit: "%" } : {})}
              delta={
                fromPct == null || toPct == null
                  ? "not measured on both"
                  : toPct >= fromPct
                    ? "improved"
                    : "declined"
              }
              deltaKind={
                fromPct != null && toPct != null && toPct < fromPct ? "signal" : "up"
              }
            />
            <KPI
              label="Regressions across versions"
              num={totals.regressed}
              delta="changes against recorded labels"
              deltaKind={totals.regressed ? "signal" : "default"}
            />
            <KPI label="Improvements" num={totals.improved} delta="flips toward the label" />
            <KPI
              label="Saves between"
              num={chainVersions.length}
              foot={`${totals.recorded} with a recorded run`}
            />
          </KPIRow>

          <Card className="mb-5">
            <CardHeader>
              <div>
                <CardTitle>The path, run by run</CardTitle>
                <CardDescription>Each row is a recorded evaluator-version regression check.</CardDescription>
              </div>
            </CardHeader>
            <Table>
              <thead>
                <tr>
                  <th style={{ width: 180 }}>Run</th>
                  <th style={{ width: 170 }}>Regression check</th>
                  <th style={{ width: 170 }}>Pinned corpus</th>
                  <th style={{ width: 100 }} className="text-right">Regressed</th>
                  <th style={{ width: 100 }} className="text-right">Improved</th>
                  <th>On the record</th>
                </tr>
              </thead>
              <tbody>
                {steps === null ? (
                  <tr>
                    <td colSpan={6} className="text-center text-ink-3">Loading recorded runs…</td>
                  </tr>
                ) : (
                  steps.map(({ version, run }) => (
                    <tr
                      key={version.id}
                      className="row-link"
                      onClick={() => navigate(`/skill/versions/${version.id}`)}
                    >
                      <td>
                        <RowLink to={`/skill/versions/${version.id}`} className="font-mono">
                          v{version.version}
                        </RowLink>
                      </td>
                      <td>
                        <GateChip
                          state={gateStateForVersion(version)}
                          title={version.knownLimitations.join(" · ")}
                        />
                      </td>
                      <td
                        className="font-mono text-[10px] text-ink-3"
                        title={run?.datasetRevisionId ?? version.regressionDatasetRevisionId ?? undefined}
                      >
                        {(run?.datasetRevisionId ?? version.regressionDatasetRevisionId)?.slice(0, 18) ?? "not pinned"}
                        {(run?.datasetRevisionId ?? version.regressionDatasetRevisionId) ? "…" : ""}
                      </td>
                      <td
                        className="text-right font-mono tabular-nums"
                        style={run && run.regressed ? { color: "var(--signal)" } : undefined}
                      >
                        {run ? run.regressed : "—"}
                      </td>
                      <td className="text-right font-mono tabular-nums">{run ? run.improved : "—"}</td>
                      <td className="text-[12.5px] text-ink-3">
                        {run
                          ? run.overrideReason
                            ? `override on file · "${run.overrideReason}"`
                            : run.goldenSetMissing
                              ? "no promoted reference cases at version creation"
                              : `${run.compared} reference cases compared`
                          : "no run recorded for this save"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </Table>
          </Card>

          {newestRun && newestRun.cases.length > 0 ? (
            <Card className="mb-5">
              <CardHeader>
                <div>
                  <CardTitle>
                    Case-by-case · the {steps && steps.length > 1 ? "newest hop" : "run"} (v
                    {steps?.[0]?.version.version})
                  </CardTitle>
                  <CardDescription>
                    The recorded per-case diff for this save. Click a case to open it.
                  </CardDescription>
                </div>
                <div className="flex-1" />
                <div className="flex gap-2">
                  <Chip variant="fail">{newestRun.regressed} regressed</Chip>
                  <Chip>{newestRun.improved} improved</Chip>
                  <Chip variant="outline">
                    {Math.max(0, newestRun.compared - newestRun.regressed - newestRun.improved)} unchanged
                  </Chip>
                </div>
              </CardHeader>
              <Table>
                <tbody>
                  {newestRun.cases.map((diff) => (
                    <tr
                      key={diff.caseId}
                      className={diff.change === "regress" ? "row-link row-signal" : "row-link"}
                      onClick={() => navigate(`/cases/${diff.caseId}`)}
                    >
                      <td style={{ width: 230 }}>
                        <RowLink to={`/cases/${diff.caseId}`}>
                          <Ref kind="golden" label={diff.traceId} id={diff.caseId} />
                        </RowLink>
                      </td>
                      <td
                        className="font-mono"
                        style={{
                          width: 140,
                          color: diff.change === "regress" ? "var(--signal)" : "var(--ink-3)"
                        }}
                      >
                        {diff.agreedLabel} → {diff.newLabel}
                      </td>
                      <td className="text-[12.5px] text-ink-3">{diff.rationale || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : null}
        </>
      ) : null}

      <Card className="max-w-[80ch] border-dashed">
        <CardContent className="py-4">
          <Eyebrow>Datasets and comparisons</Eyebrow>
          <div className="mt-2 font-serif text-[14px] leading-[1.55] tracking-[-0.005em] text-ink-2">
            Promotion and retirement advance the reference set for future evaluator versions; existing
            versions keep their original immutable corpus. Different corpus IDs therefore mean the path
            includes both evaluator and reference-set changes. For an explicit same-corpus comparison: filter{" "}
            <Link className="border-b border-ink-3 text-inherit no-underline hover:border-ink" to="/traces">
              Traces
            </Link>{" "}
            and save it as a queue — once reviewed, its verdicts are a labeled dataset you can hold
            future versions against.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function VersionPick({
  versions,
  value,
  exclude,
  onChange
}: {
  versions: SkillVersion[];
  value: string | null;
  exclude: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 cursor-pointer rounded-sm border border-rule-soft bg-card px-2 font-mono text-[11.5px] text-ink-2 hover:bg-card-2"
    >
      {versions.map((v) => (
        <option key={v.id} value={v.id} disabled={v.id === exclude}>
          v{v.version}
        </option>
      ))}
    </select>
  );
}
