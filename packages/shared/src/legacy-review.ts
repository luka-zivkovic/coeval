import { z } from "zod";
import {
  JsonSchemaSchema,
  ModelBindingSchema,
  RubricProvenanceSchema,
  SkillStatusSchema,
  StoredModelBindingSchema,
  VerdictKindSchema,
  VerdictLabelSchema
} from "./judge.js";
import type { VerdictLabel } from "./judge.js";
import type { VerdictPayload } from "./verdicts.js";

// Annotation queue primitive (PR #47). Named cohort of cases assembled for
// explicit reviewer attention. Foundation for overlap-sampling + assignment.
export const ReviewQueueStatusSchema = z.enum(["open", "closed"]);
export type ReviewQueueStatus = z.infer<typeof ReviewQueueStatusSchema>;

export const ReviewQueueItemStatusSchema = z.enum(["pending", "completed"]);
export type ReviewQueueItemStatus = z.infer<typeof ReviewQueueItemStatusSchema>;

export const ReviewQueueItemSchema = z.object({
  id: z.string(),
  queueId: z.string(),
  caseId: z.string(),
  // Immutable criterion definition this review task governs.
  criterionVersionId: z.string(),
  status: ReviewQueueItemStatusSchema,
  position: z.number().int().nonnegative(),
  // per-item assignment. null = unassigned (any reviewer can pull);
  // string user id = this item belongs to that reviewer's pile. Two items on
  // the same case with two different assignees = a κ-eligible overlap pair.
  assignedToUserId: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable()
});
export type ReviewQueueItem = z.infer<typeof ReviewQueueItemSchema>;

// shape for adding items to an existing queue, with optional per-item
// assignment. Same bounds as CreateReviewQueueInputSchema for caseIds.
export const AddReviewQueueItemsInputSchema = z.object({
  items: z
    .array(
      z.object({
        caseId: z.string().min(1),
        criterionVersionId: z.string().min(1).optional(),
        assignedToUserId: z.string().min(1).optional()
      })
    )
    .min(1)
    .max(500)
});
export type AddReviewQueueItemsInput = z.infer<typeof AddReviewQueueItemsInputSchema>;

// overlap-sampling planner. Given a cohort + reviewers + rate, returns
// (caseId, assignedToUserId) pairs ready to feed into addReviewQueueItems.
// Pure + deterministic (hash-keyed shuffle) so the same input always produces
// the same plan — important for κ replays and for previewing the plan in the
// UI before submitting.
export const PlanQueueAssignmentsInputSchema = z
  .object({
    caseIds: z.array(z.string().min(1)).min(1).max(500),
    criterionVersionId: z.string().min(1).optional(),
    reviewers: z.array(z.string().min(1)).min(1).max(20),
    // Fraction of cases that get assigned to ALL reviewers (the κ-overlap set).
    // The remainder get one reviewer round-robin. 0 → no overlap; 1 → every
    // case to every reviewer.
    overlapRate: z.number().min(0).max(1),
    // Optional seed for the deterministic shuffle. Defaults to "default" so a
    // call without a seed is still reproducible.
    seed: z.string().max(200).optional()
  })
  .refine(
    (v) => new Set(v.reviewers).size === v.reviewers.length,
    { message: "reviewers must be unique" }
  )
  .refine(
    (v) => new Set(v.caseIds).size === v.caseIds.length,
    { message: "caseIds must be unique" }
  );
export type PlanQueueAssignmentsInput = z.infer<typeof PlanQueueAssignmentsInputSchema>;

export interface PlannedQueueAssignment {
  caseId: string;
  assignedToUserId: string;
  criterionVersionId?: string | undefined;
}

// FNV-1a 32-bit hash — cross-platform, synchronous, deterministic. Not for
// cryptographic use; we only need stable ordering across runs.
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function planQueueAssignments(input: PlanQueueAssignmentsInput): PlannedQueueAssignment[] {
  const seed = input.seed ?? "default";
  // Deterministic shuffle: sort by hash(caseId + seed). Same input → same plan.
  const shuffled = [...input.caseIds]
    .map((caseId) => ({ caseId, key: fnv1a(`${caseId}|${seed}`) }))
    .sort((a, b) => a.key - b.key || a.caseId.localeCompare(b.caseId))
    .map((entry) => entry.caseId);
  const overlapCount = Math.floor(shuffled.length * input.overlapRate);
  const overlapCases = shuffled.slice(0, overlapCount);
  const soloCases = shuffled.slice(overlapCount);
  const assignments: PlannedQueueAssignment[] = [];
  // Overlap cases → every reviewer.
  for (const caseId of overlapCases) {
    for (const reviewer of input.reviewers) {
      assignments.push({
        caseId,
        assignedToUserId: reviewer,
        ...(input.criterionVersionId ? { criterionVersionId: input.criterionVersionId } : {})
      });
    }
  }
  // Solo cases → round-robin across reviewers, using a deterministic offset
  // derived from the seed so the round-robin start point is also reproducible.
  const offset = fnv1a(`rr|${seed}`) % input.reviewers.length;
  for (let i = 0; i < soloCases.length; i += 1) {
    const caseId = soloCases[i]!;
    const reviewer = input.reviewers[(offset + i) % input.reviewers.length]!;
    assignments.push({
      caseId,
      assignedToUserId: reviewer,
      ...(input.criterionVersionId ? { criterionVersionId: input.criterionVersionId } : {})
    });
  }
  return assignments;
}

export const ReviewQueueSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: ReviewQueueStatusSchema,
  createdByUserId: z.string().nullable(),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
  // Counters denormalized into the response so the dashboard doesn't have to
  // hydrate items just to render progress bars. Always derived server-side
  // from review_queue_items at read time.
  pendingCount: z.number().int().nonnegative(),
  completedCount: z.number().int().nonnegative()
});
export type ReviewQueue = z.infer<typeof ReviewQueueSchema>;

export const ReviewQueueDetailSchema = z.object({
  queue: ReviewQueueSchema,
  items: z.array(ReviewQueueItemSchema)
});
export type ReviewQueueDetail = z.infer<typeof ReviewQueueDetailSchema>;

export const CreateReviewQueueInputSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  criterionVersionId: z.string().min(1).optional(),
  // Bounded to keep a single create call from importing a project's entire
  // case backlog into one queue. Operators that need more can create multiple
  // queues or add items in subsequent calls (follow-up PR).
  caseIds: z.array(z.string().min(1)).min(1).max(500)
});
export type CreateReviewQueueInput = z.infer<typeof CreateReviewQueueInputSchema>;

// Anti-recursion guard. When Coeval invokes a judge LLM, the trace platform
// (LangSmith / Langfuse / etc.) may emit that LLM call as a trace, which can
// then loop back into Coeval's ingest. Producers tag those internal calls under
// the reserved `coeval` metadata namespace so Coeval refuses to ingest them.
// Inspired by Langfuse's `langfuse-internal-llm-judge` tag pattern (docs/08).
export const COEVAL_INTERNAL_METADATA_KEY = "coeval";

export function isInternalTraceMetadata(metadata: Record<string, unknown> | null | undefined): boolean {
  if (!metadata) return false;
  const namespace = metadata[COEVAL_INTERNAL_METADATA_KEY];
  if (!namespace || typeof namespace !== "object" || Array.isArray(namespace)) return false;
  return (namespace as { internal?: unknown }).internal === true;
}

// Comparable scalar in [0,1] for cross-kind aggregation (κ, agreement,
// regression deltas). Classified binary → 0/1, binary abstention → 0.5
// for display only, scalar → normalized to range, categorical → choiceScores[choice].
export function verdictComparableScore(payload: VerdictPayload): number {
  if (payload.kind === "binary") return "pass" in payload ? (payload.pass ? 1 : 0) : 0.5;
  if (payload.kind === "scalar") {
    const [lo, hi] = payload.range;
    if (hi === lo) return 0;
    return (payload.score - lo) / (hi - lo);
  }
  return payload.choiceScores[payload.choice] ?? 0;
}

// Type guard for the canonical label universe. UI code keeps re-declaring
// private {pass,fail,ambiguous} sets that drift independently — use this.
export function isVerdictLabel(value: unknown): value is VerdictLabel {
  return VerdictLabelSchema.safeParse(value).success;
}

// Coarse label projection of any verdict payload — single-sourced so the
// legacy judge_runs row, eval-run agreement, the exceptions queue, and the
// dashboard distribution can't disagree about the same verdict.
//
// A categorical verdict whose chosen choice IS one of the canonical labels
// keeps it verbatim: an "ambiguous" choice must surface as ambiguous (it is
// an exception for humans), never be folded into pass by its 0.5
// choice-score.
//
// Score-projected verdicts (classified binary, scalar, non-canonical
// categorical) use three bands: ≥ 2/3 pass, ≤ 1/3 fail, the middle is
// ambiguous. Classified binary can only ever hit 0 or 1; explicit binary
// abstention returns before projection. A mid-confidence scalar verdict is the "a human
// should look" case, and collapsing it to pass/fail would silently delete
// the exceptions-queue affordance for scalar-verdict projects.
export function verdictLabelFromPayload(payload: VerdictPayload): VerdictLabel {
  if (payload.kind === "binary" && "label" in payload) return payload.label;
  if (payload.kind === "categorical") {
    const canonical = VerdictLabelSchema.safeParse(payload.choice);
    if (canonical.success) return canonical.data;
  }
  const score = verdictComparableScore(payload);
  if (score >= 2 / 3) return "pass";
  if (score <= 1 / 3) return "fail";
  return "ambiguous";
}

// The label a human decision settles on for a case, when one exists.
// ONE precedence rule, used by every legacy review surface that freezes or
// displays "what the team said" (golden-set promotion, case detail, demo
// repo): an owner adjudication outranks plain human verdicts
// regardless of recency; within the same source tier the latest verdict wins,
// with id as a deterministic tiebreak for same-timestamp writes. Verdicts
// from other sources are ignored; pass entries pre-projected or raw.
export function effectiveHumanVerdict<
  T extends { id: string; source: string; payload: VerdictPayload; createdAt: string }
>(verdicts: ReadonlyArray<T>): T | null {
  const human = verdicts.filter((v) => v.source === "human" || v.source === "adjudicated");
  if (human.length === 0) return null;
  return [...human].sort((a, b) => {
    const tier = Number(b.source === "adjudicated") - Number(a.source === "adjudicated");
    if (tier !== 0) return tier;
    const recency = b.createdAt.localeCompare(a.createdAt);
    if (recency !== 0) return recency;
    return b.id.localeCompare(a.id);
  })[0]!;
}

export function effectiveHumanLabel(
  verdicts: ReadonlyArray<{ id: string; source: string; payload: VerdictPayload; createdAt: string }>
): VerdictLabel | null {
  const best = effectiveHumanVerdict(verdicts);
  return best ? verdictLabelFromPayload(best.payload) : null;
}

// Inter-rater agreement (Landis & Koch 1977 interpretation bands). Coeval's
// flagship differentiator — none of the surveyed competitors compute this.
export const KappaInterpretationSchema = z.enum([
  "poor",
  "slight",
  "fair",
  "moderate",
  "substantial",
  "almost_perfect"
]);
export type KappaInterpretation = z.infer<typeof KappaInterpretationSchema>;

export const PairwiseKappaSchema = z.object({
  reviewerA: z.string(),
  reviewerB: z.string(),
  cases: z.number().int().nonnegative(),
  observedAgreement: z.number().min(0).max(1),
  expectedAgreement: z.number().min(0).max(1),
  kappa: z.number(),
  interpretation: KappaInterpretationSchema
});
export type PairwiseKappa = z.infer<typeof PairwiseKappaSchema>;

// Cohen's kappa is undefined when chance-expected agreement is 1 because its
// denominator, 1 - p_e, is zero. Keep these pairs separate from unsupported
// verdict kinds: the observations are valid and their raw agreement is still
// useful, but reporting a favorable kappa would manufacture evidence.
export const KappaUndefinedReasonSchema = z.enum([
  "expected_agreement_one"
]);
export type KappaUndefinedReason = z.infer<typeof KappaUndefinedReasonSchema>;

export const UndefinedPairwiseKappaSchema = z.object({
  reviewerA: z.string(),
  reviewerB: z.string(),
  cases: z.number().int().nonnegative(),
  observedAgreement: z.number().min(0).max(1),
  expectedAgreement: z.literal(1),
  kappa: z.null(),
  interpretation: z.null(),
  reason: KappaUndefinedReasonSchema
});
export type UndefinedPairwiseKappa = z.infer<typeof UndefinedPairwiseKappaSchema>;

export const KappaSummarySchema = z.object({
  raterCount: z.number().int().nonnegative(),
  overlappingCases: z.number().int().nonnegative(),
  pairs: z.array(PairwiseKappaSchema),
  meanKappa: z.number().nullable(),
  meanInterpretation: KappaInterpretationSchema.nullable(),
  // Discrete reviewer pairs whose observations are valid but whose kappa is
  // mathematically undefined.
  undefinedPairs: z.array(UndefinedPairwiseKappaSchema),
  // Reviewer pairs whose verdicts could not be compared (e.g. one rater used a
  // scalar verdict that κ math doesn't apply to without binning). Surfaced so
  // the dashboard can explain "9 of 10 pairs computed" rather than silently
  // dropping rows.
  unsupportedPairs: z.number().int().nonnegative()
});
export type KappaSummary = z.infer<typeof KappaSummarySchema>;

// disagreement surfacing — the cases that drag κ down. The κ summary
// gives one number; this names the specific cases where human reviewers split,
// so they can be routed into skill refinement (the convergence loop). A case
// "disagrees" when ≥2 human reviewers gave it different discrete verdicts.
export const ReviewerLabelSchema = z.object({
  actorUserId: z.string(),
  // Display name resolved by the API (PG mode joins the user table). Absent
  // when the actor is unknown — the UI then falls back to the raw id.
  actorName: z.string().nullish(),
  label: z.string()
});
export type ReviewerLabel = z.infer<typeof ReviewerLabelSchema>;

export const DisagreementCaseSchema = z.object({
  caseId: z.string(),
  reviewerCount: z.number().int().nonnegative(),
  distinctLabels: z.number().int().nonnegative(),
  // Each human reviewer's discrete verdict on this case (first-verdict-wins).
  labels: z.array(ReviewerLabelSchema),
  // [0,1] split severity: 0 = unanimous, →1 = maximally split. Drives ranking.
  // Defined as 1 - (size of the largest agreeing bloc / reviewerCount).
  severity: z.number().min(0).max(1),
  // The recorded legacy adjudication, or null if still open. When set, this
  // ungoverned disagreement has been closed by a human/panel for diagnostics.
  adjudicatedLabel: z.string().nullable()
});
export type DisagreementCase = z.infer<typeof DisagreementCaseSchema>;

export const DisagreementSummarySchema = z.object({
  // Cases with 2+ human reviewers whose verdicts could be compared.
  comparedCases: z.number().int().nonnegative(),
  // Of those, how many had any disagreement.
  disagreedCases: z.number().int().nonnegative(),
  // Of the disagreeing cases, how many have a recorded legacy adjudication.
  resolvedCases: z.number().int().nonnegative(),
  // The disagreeing cases, ranked most-split first.
  cases: z.array(DisagreementCaseSchema)
});
export type DisagreementSummary = z.infer<typeof DisagreementSummarySchema>;

// judge-vs-human disagreement. Where the human-human
// surface needs reviewer overlap (rare under single-reviewer exception triage),
// THIS surface is non-empty whenever a human reviewed an exception the judge
// also verdicted — i.e. every reviewed exception. It's the cold-start-proof
// entry point to the convergence loop: "the judge and your reviewers disagree
// on these — adjudicate, then refine the skill."
export const JudgeHumanDisagreementCaseSchema = z.object({
  caseId: z.string(),
  // The judge's discrete verdict on this case (latest llm_judge verdict).
  judgeLabel: z.string(),
  // Each human reviewer's discrete verdict (first-verdict-wins per reviewer).
  humanLabels: z.array(ReviewerLabelSchema),
  agreeingHumans: z.number().int().nonnegative(),
  disagreeingHumans: z.number().int().nonnegative(),
  // [0,1] = disagreeingHumans / humanCount. 1 = every human contradicted the
  // judge (strongest "the judge is wrong here" signal). Drives ranking.
  severity: z.number().min(0).max(1),
  // The recorded legacy adjudication, or null if still open. When set, a
  // human/panel has closed this ungoverned disagreement for diagnostics.
  adjudicatedLabel: z.string().nullable()
});
export type JudgeHumanDisagreementCase = z.infer<typeof JudgeHumanDisagreementCaseSchema>;

export const JudgeHumanDisagreementSummarySchema = z.object({
  // Cases with a judge verdict AND ≥1 human verdict (both discrete).
  comparedCases: z.number().int().nonnegative(),
  // Of those, how many had ≥1 human differ from the judge.
  disagreedCases: z.number().int().nonnegative(),
  // Of the disagreeing cases, how many have a recorded legacy adjudication.
  resolvedCases: z.number().int().nonnegative(),
  cases: z.array(JudgeHumanDisagreementCaseSchema)
});
export type JudgeHumanDisagreementSummary = z.infer<typeof JudgeHumanDisagreementSummarySchema>;

// A2.2c: the legacy convergence audit. On the ungoverned ADJUDICATED slice,
// did a skill edit move the judge toward the recorded rulings? It compares an
// audited version against its predecessor, both measured against those legacy
// adjudications. Judge verdicts are pinned to an explicit skillVersionId (NOT
// latest-wins); this diagnostic never upgrades the slice to governed truth.
export const ConvergenceCaseChangeSchema = z.enum([
  "improved", // audited version agrees with the recorded ruling where the prior didn't
  "regressed", // audited version disagrees where the prior agreed
  "still_agree", // both versions agree with the recorded ruling (or no prior, audited agrees)
  "still_disagree" // both versions disagree (or no prior, audited disagrees)
]);
export type ConvergenceCaseChange = z.infer<typeof ConvergenceCaseChangeSchema>;

export const ConvergenceAuditCaseSchema = z.object({
  caseId: z.string(),
  adjudicatedLabel: z.string(),
  // The prior version's discrete judge label, or null if it never judged this
  // case (a newer adjudicated case the prior version predates).
  beforeLabel: z.string().nullable(),
  // The audited version's discrete judge label. Always present (a case is only
  // "compared" once the audited version has judged it).
  afterLabel: z.string(),
  change: ConvergenceCaseChangeSchema
});
export type ConvergenceAuditCase = z.infer<typeof ConvergenceAuditCaseSchema>;

export const ConvergenceAuditSchema = z.object({
  afterVersionId: z.string(),
  // The immediate predecessor, or null if the audited version is the baseline
  // (no before/after delta — only the current agreement is shown).
  beforeVersionId: z.string().nullable(),
  // Every recorded legacy adjudication in scope — the COVERAGE denominator. The
  // audit only measures cases the audited version actually re-judged
  // (comparedCases); surfacing the total keeps "improved 3" from reading as
  // "improved 3 of everything" when it's "improved 3 of comparedCases re-judged,
  // out of adjudicatedTotal resolved." Guards against a cherry-picked headline.
  adjudicatedTotal: z.number().int().nonnegative(),
  // Adjudicated cases the audited version has judged (the audit's denominator).
  comparedCases: z.number().int().nonnegative(),
  // Of compared, how many the audited version agrees with the recorded ruling on.
  afterAgreed: z.number().int().nonnegative(),
  // Of compared, how many the prior version had judged (the before denominator).
  beforeKnown: z.number().int().nonnegative(),
  // Of beforeKnown, how many the prior version agreed with the recorded ruling on.
  beforeAgreed: z.number().int().nonnegative(),
  // Net movement toward the recorded rulings.
  improved: z.number().int().nonnegative(),
  regressed: z.number().int().nonnegative(),
  cases: z.array(ConvergenceAuditCaseSchema)
});
export type ConvergenceAudit = z.infer<typeof ConvergenceAuditSchema>;

// The convergence headline is computed over the complete adjudicated slice,
// while its exact per-case ledger is keyset-paginated independently. Keeping
// those two concerns in one response prevents a bounded UI page from silently
// becoming the agreement denominator.
export const CONVERGENCE_CASE_PAGE_DEFAULT_LIMIT = 50;
export const CONVERGENCE_CASE_PAGE_MAX_LIMIT = 100;
export const ConvergenceAuditPageSchema = z.object({
  audit: ConvergenceAuditSchema,
  nextCursor: z.string().nullable(),
  // The server-selected next adjudicated case this exact evaluator version
  // has not judged. Mutations re-resolve this value server-side before
  // spending provider tokens; clients use it only to explain the next action.
  nextUncoveredCaseId: z.string().nullable()
});
export type ConvergenceAuditPage = z.infer<typeof ConvergenceAuditPageSchema>;

// judge self-consistency — does the judge return the SAME verdict when re-run
// on identical input? An LLM judge at temperature 0 should be near-deterministic;
// flips under re-run are a reliability red flag (the 2025 research critique of
// LLM judges). Computed per skill version from repeated llm_judge verdicts on a
// case: agreement = size of the majority label bloc / total runs.
export const SelfConsistencyCaseSchema = z.object({
  caseId: z.string(),
  runs: z.number().int().nonnegative(),
  distinctLabels: z.number().int().nonnegative(),
  // The label the judge landed on most often across re-runs.
  majorityLabel: z.string(),
  // [0,1]: 1 = every re-run agreed (consistent); →1/runs = maximally split.
  agreement: z.number().min(0).max(1)
});
export type SelfConsistencyCase = z.infer<typeof SelfConsistencyCaseSchema>;

export const SelfConsistencyReportSchema = z.object({
  skillVersionId: z.string(),
  // Cases this version judged 2+ times (the only cases consistency can be
  // measured on — a single run is trivially "consistent").
  comparedCases: z.number().int().nonnegative(),
  // Of those, how many were perfectly consistent (every re-run agreed).
  consistentCases: z.number().int().nonnegative(),
  // Mean per-case agreement across compared cases; null when none were probed.
  meanAgreement: z.number().min(0).max(1).nullable(),
  // Probed cases, ranked least-consistent first (the flips to investigate).
  cases: z.array(SelfConsistencyCaseSchema)
});
export type SelfConsistencyReport = z.infer<typeof SelfConsistencyReportSchema>;

// the Judge Card — a shareable artifact assembling ONLY recorded data
// about one skill version. Absent signals are explicit nulls with a basis
// note; never fabricated, never a composite score (locked honesty rules).
export const JudgeCardAuditEntrySchema = z.object({
  id: z.string(),
  action: z.string(),
  actorUserId: z.string().nullable(),
  createdAt: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable()
});
export type JudgeCardAuditEntry = z.infer<typeof JudgeCardAuditEntrySchema>;

export const JudgeCardSchema = z.object({
  generatedAt: z.string(),
  project: z.object({ id: z.string(), name: z.string() }),
  skill: z.object({ id: z.string(), name: z.string(), ownerName: z.string() }),
  version: z.object({
    id: z.string(),
    version: z.string(),
    status: SkillStatusSchema,
    verdictKind: VerdictKindSchema,
    rubricProvenance: RubricProvenanceSchema,
    createdAt: z.string(),
    approvedAt: z.string().nullable()
  }),
  modelBinding: StoredModelBindingSchema,
  goldenSet: z.object({
    size: z.number().int().nonnegative(),
    agreement: z.number().min(0).max(1).nullable(),
    tooStrict: z.number().int().nonnegative(),
    tooLenient: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative()
  }),
  regression: z.object({
    status: z.enum(["passed", "blocked", "overridden", "error"]),
    compared: z.number().int().nonnegative(),
    regressed: z.number().int().nonnegative(),
    improved: z.number().int().nonnegative(),
    flipped: z.number().int().nonnegative(),
    overrideReason: z.string().nullable(),
    error: z.string().nullable().optional(),
    createdAt: z.string()
  }).nullable(),
  // One entry per human rater this judge version overlaps with; empty when no
  // human verdicts exist yet (the basis note says so).
  judgeHumanKappa: z.array(z.object({
    humanRater: z.string(),
    kappa: z.number(),
    interpretation: KappaInterpretationSchema,
    cases: z.number().int().nonnegative()
  })),
  selfConsistency: z.object({
    comparedCases: z.number().int().positive(),
    consistentCases: z.number().int().nonnegative(),
    meanAgreement: z.number().min(0).max(1).nullable()
  }).nullable(),
  audit: z.array(JudgeCardAuditEntrySchema),
  // Honest notes: what each absent signal means and what would light it up.
  basis: z.array(z.string())
});
export type JudgeCard = z.infer<typeof JudgeCardSchema>;

// portable SkillFormat v1 export — a skill version rendered as the
// implementation-independent document defined in spec/skill-format-v1.md. A
// mapping, not a spec change: everything comes from Skill + SkillVersion +
// the golden set (examples), nothing fabricated.
export const SKILL_FORMAT_EXAMPLES_CAP = 50;

export const SkillFormatExampleSchema = z.object({
  id: z.string(),
  label: VerdictLabelSchema, // pass | fail | ambiguous
  // Redacted trace input/output for the golden case (same redaction as every
  // trace surface). Null only when the case's payload is genuinely absent.
  input: z.unknown(),
  output: z.unknown(),
  reason: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional()
});
export type SkillFormatExample = z.infer<typeof SkillFormatExampleSchema>;

export const SkillFormatV1Schema = z.object({
  formatVersion: z.literal("skill-format/v1"),
  name: z.string(),
  description: z.string(),
  owner: z.string(),
  version: z.string(),
  status: SkillStatusSchema,
  modelBinding: ModelBindingSchema,
  rubricMarkdown: z.string(),
  examples: z.array(SkillFormatExampleSchema),
  outputSchema: JsonSchemaSchema,
  // Honest notes about anything the export could not source (e.g. an empty
  // golden set → no examples) — never a fabricated value.
  basis: z.array(z.string())
});
export type SkillFormatV1 = z.infer<typeof SkillFormatV1Schema>;

// Pure interpretation band from a κ value (Landis & Koch 1977).
export function interpretKappa(kappa: number): KappaInterpretation {
  if (kappa < 0) return "poor";
  if (kappa <= 0.2) return "slight";
  if (kappa <= 0.4) return "fair";
  if (kappa <= 0.6) return "moderate";
  if (kappa <= 0.8) return "substantial";
  return "almost_perfect";
}

export const CapabilityGapSchema = z.object({
  id: z.string(),
  name: z.string(),
  count: z.number().int().nonnegative(),
  severity: z.enum(["low", "medium", "high"])
});
export type CapabilityGap = z.infer<typeof CapabilityGapSchema>;

export const ExceptionCaseSchema = z.object({
  id: z.string(),
  traceId: z.string(),
  title: z.string(),
  judgeRunId: z.string().optional(),
  skillVersionId: z.string().optional(),
  criterionVersionId: z.string().optional(),
  verdict: VerdictLabelSchema,
  reason: z.string(),
  rejudgedSince: z.object({
    judgeRunId: z.string(),
    verdict: VerdictLabelSchema,
    reason: z.string(),
    createdAt: z.string()
  }).nullable().optional(),
  capabilityGap: z.string().optional(),
  reviewerState: z.enum(["needs_review", "accepted", "corrected", "ambiguous"]),
  createdAt: z.string()
});
export type ExceptionCase = z.infer<typeof ExceptionCaseSchema>;
