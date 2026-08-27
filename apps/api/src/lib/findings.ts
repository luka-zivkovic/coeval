import {
  FINDINGS_CLUSTER_CASE_SAMPLE,
  FINDINGS_CLUSTER_LIMIT,
  FINDINGS_OVERRIDE_LIMIT,
  type FindingsFailureCluster,
  type FindingsHumanOverride,
  type FindingsStratumDistribution,
  type GoldenSetEntry,
  type JudgeHumanDisagreementSummary,
  type V1FindingsResponse,
  type VerdictRecord
} from "@coeval/shared";
import type { CaseListEntry } from "../repository.js";
import { toDiscreteCategory } from "./kappa.js";

/**
 * Findings aggregation (GET /api/v1/findings, issue #10): the judgment
 * intelligence that accumulates in Coeval — overrides, disagreements,
 * per-stratum verdict shape, golden-set growth — as one bounded,
 * machine-readable snapshot for skill maintenance.
 *
 * Deliberately deterministic and LLM-free: "failure clustering" is exact
 * grouping on the normalized first sentence of each rationale. Same inputs,
 * same output — a consumer can diff two snapshots and trust the delta.
 */

/**
 * First sentence of a rationale, normalized for exact grouping: cut at the
 * first sentence terminator (. ! ? or newline), lowercase, collapse runs of
 * whitespace, strip trailing punctuation.
 */
export function normalizeFirstSentence(text: string): string {
  const firstSentence = text.split(/(?<=[.!?])\s|\n/, 1)[0] ?? "";
  return firstSentence
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.!?,;:]+$/g, "")
    .trim();
}

interface LatestVerdict {
  label: string;
  rationale: string;
  source: VerdictRecord["source"];
  skillVersionId: string | null;
  createdAt: string;
}

/**
 * Latest discrete verdict per case for the given sources (latest-wins by
 * createdAt, id as the deterministic tiebreak). Scalar payloads carry no
 * discrete label and are skipped — same rule as the κ math in kappa.ts.
 */
export function latestDiscreteVerdictByCase(
  verdicts: VerdictRecord[],
  sources: ReadonlyArray<VerdictRecord["source"]>
): Map<string, LatestVerdict> {
  const latest = new Map<string, { verdict: LatestVerdict; id: string }>();
  for (const verdict of verdicts) {
    if (!sources.includes(verdict.source)) continue;
    const label = toDiscreteCategory(verdict.payload);
    if (label === null) continue;
    const existing = latest.get(verdict.caseId);
    if (
      !existing ||
      verdict.createdAt > existing.verdict.createdAt ||
      (verdict.createdAt === existing.verdict.createdAt && verdict.id > existing.id)
    ) {
      latest.set(verdict.caseId, {
        id: verdict.id,
        verdict: {
          label,
          rationale: verdict.payload.rationale,
          source: verdict.source,
          skillVersionId: verdict.skillVersionId,
          createdAt: verdict.createdAt
        }
      });
    }
  }
  const out = new Map<string, LatestVerdict>();
  for (const [caseId, { verdict }] of latest) out.set(caseId, verdict);
  return out;
}

export interface BuildFindingsInput {
  generatedAt: string;
  since: string | null;
  // Human, adjudicated, AND llm_judge rows (each feed already bounded by the
  // caller's scan limit).
  verdicts: VerdictRecord[];
  disagreements: JudgeHumanDisagreementSummary;
  golden: GoldenSetEntry[];
  cases: CaseListEntry[];
}

export function buildFindings(input: BuildFindingsInput): V1FindingsResponse {
  const judgeByCase = latestDiscreteVerdictByCase(input.verdicts, ["llm_judge"]);

  // Human overrides: every human/adjudicated verdict whose discrete label
  // contradicts the judge's latest label on the same case. Rows on cases the
  // judge never verdicted are reviews, not overrides.
  const overrides: FindingsHumanOverride[] = [];
  for (const verdict of input.verdicts) {
    if (verdict.source !== "human" && verdict.source !== "adjudicated") continue;
    if (input.since !== null && verdict.createdAt <= input.since) continue;
    const label = toDiscreteCategory(verdict.payload);
    if (label === null) continue;
    const judge = judgeByCase.get(verdict.caseId);
    if (!judge || judge.label === label) continue;
    overrides.push({
      caseId: verdict.caseId,
      source: verdict.source,
      label,
      judgeLabel: judge.label,
      rationale: verdict.payload.rationale,
      skillVersionId: verdict.skillVersionId,
      createdAt: verdict.createdAt
    });
  }
  overrides.sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt) || a.caseId.localeCompare(b.caseId) || a.source.localeCompare(b.source)
  );
  const humanOverrides = overrides.slice(0, FINDINGS_OVERRIDE_LIMIT);

  // Failure clusters: override rationales + judge fail rationales, grouped by
  // normalized first sentence. Deterministic: count desc, then key asc; the
  // sample rationale is the earliest row in the cluster.
  const clusters = new Map<string, {
    key: string;
    source: "human_override" | "judge";
    count: number;
    caseIds: string[];
    sampleRationale: string;
    sampleCreatedAt: string;
  }>();
  const addToCluster = (
    source: "human_override" | "judge",
    caseId: string,
    rationale: string,
    createdAt: string
  ): void => {
    const key = normalizeFirstSentence(rationale);
    if (key === "") return;
    const mapKey = `${source}\u0000${key}`;
    const cluster = clusters.get(mapKey);
    if (!cluster) {
      clusters.set(mapKey, { key, source, count: 1, caseIds: [caseId], sampleRationale: rationale, sampleCreatedAt: createdAt });
      return;
    }
    cluster.count += 1; // counts verdict ROWS (rationales), not distinct cases — caseIds is the deduped sample
    if (!cluster.caseIds.includes(caseId) && cluster.caseIds.length < FINDINGS_CLUSTER_CASE_SAMPLE) {
      cluster.caseIds.push(caseId);
    }
    if (createdAt < cluster.sampleCreatedAt) {
      cluster.sampleRationale = rationale;
      cluster.sampleCreatedAt = createdAt;
    }
  };
  for (const override of overrides) {
    addToCluster("human_override", override.caseId, override.rationale, override.createdAt);
  }
  for (const verdict of input.verdicts) {
    if (verdict.source !== "llm_judge") continue;
    // Symmetric window semantics with human overrides above: a `since`
    // cursor bounds BOTH cluster sources, not just overrides.
    if (input.since !== null && verdict.createdAt <= input.since) continue;
    if (toDiscreteCategory(verdict.payload) !== "fail") continue;
    addToCluster("judge", verdict.caseId, verdict.payload.rationale, verdict.createdAt);
  }
  const failureClusters: FindingsFailureCluster[] = [...clusters.values()]
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key) || a.source.localeCompare(b.source))
    .slice(0, FINDINGS_CLUSTER_LIMIT)
    .map(({ key, source, count, caseIds, sampleRationale }) => ({
      key,
      source,
      count,
      caseIds: [...caseIds].sort(),
      sampleRationale
    }));

  // Verdict distribution per stratum. `human` prefers adjudicated over
  // reviewer rows (a recorded override outranks the verdict it overrode) —
  // latestDiscreteVerdictByCase already handles latest-wins; adjudicated
  // precedence comes from layering the maps.
  const humanByCase = latestDiscreteVerdictByCase(input.verdicts, ["human"]);
  const adjudicatedByCase = latestDiscreteVerdictByCase(input.verdicts, ["adjudicated"]);
  const strata = new Map<string | null, { cases: number; judge: Record<string, number>; human: Record<string, number> }>();
  for (const entry of input.cases) {
    const rawStratum = entry.trace.metadata["stratum"];
    const stratum = typeof rawStratum === "string" && rawStratum !== "" ? rawStratum : null;
    let row = strata.get(stratum);
    if (!row) {
      row = { cases: 0, judge: {}, human: {} };
      strata.set(stratum, row);
    }
    row.cases += 1;
    const judge = judgeByCase.get(entry.caseId);
    if (judge) row.judge[judge.label] = (row.judge[judge.label] ?? 0) + 1;
    const human = adjudicatedByCase.get(entry.caseId) ?? humanByCase.get(entry.caseId);
    if (human) row.human[human.label] = (row.human[human.label] ?? 0) + 1;
  }
  const verdictDistribution: FindingsStratumDistribution[] = [...strata.entries()]
    .sort(([a], [b]) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return a.localeCompare(b);
    })
    .map(([stratum, row]) => ({
      stratum,
      cases: row.cases,
      judge: sortedCounts(row.judge),
      human: sortedCounts(row.human)
    }));

  const promotedAts = input.golden.map((entry) => entry.promotedAt).sort();
  const goldenSet = {
    size: input.golden.length,
    entriesSince: input.since === null
      ? null
      : input.golden.filter((entry) => entry.promotedAt > input.since!).length,
    latestPromotedAt: promotedAts.at(-1) ?? null
  };

  return {
    generatedAt: input.generatedAt,
    since: input.since,
    humanOverrides,
    judgeHumanDisagreements: input.disagreements,
    verdictDistribution,
    failureClusters,
    goldenSet
  };
}

// Stable key order so two snapshots of the same state serialize identically.
function sortedCounts(counts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(counts).sort()) out[key] = counts[key]!;
  return out;
}
