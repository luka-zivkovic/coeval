import { z } from "zod";

export const VerdictLabelSchema = z.enum(["pass", "fail", "ambiguous"]);
export type VerdictLabel = z.infer<typeof VerdictLabelSchema>;

// v2 verdict-kind enum lives near the top so schemas referenced by other
// schemas can bind to it without forward-reference issues.
export const VerdictKindSchema = z.enum(["binary", "scalar", "categorical"]);
export type VerdictKind = z.infer<typeof VerdictKindSchema>;

export const SkillStatusSchema = z.enum([
  "draft",
  "calibrating",
  "validated",
  "approved",
  "production",
  "regressing",
  "failed",
  "needs_review",
  "deprecated"
]);
export type SkillStatus = z.infer<typeof SkillStatusSchema>;

// Skill Bench: how a project gets its evidence. 'tracing' = a trace stream
// (LangSmith/Langfuse/manual imports); 'bench' = curated example datasets, no
// tracing infra. Branches onboarding/IA/copy only — the judging pipe is shared.
export const ProjectModeSchema = z.enum(["tracing", "bench"]);
export type ProjectMode = z.infer<typeof ProjectModeSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  mode: ProjectModeSchema,
  traceProvider: z.enum(["langsmith", "langfuse", "ironside", "manual", "unknown"]),
  importedTraceCount: z.number().int().nonnegative(),
  autoJudgedTraceCount: z.number().int().nonnegative(),
  syncBackCoverage: z.number().min(0).max(1),
  traceRetentionDays: z.number().int().positive().nullable(),
  updatedAt: z.string()
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectSettingsSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  mode: ProjectModeSchema,
  traceRetentionDays: z.number().int().positive().nullable()
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const UpdateProjectSettingsInputSchema = z.object({
  traceRetentionDays: z.number().int().positive().max(3650).nullable(),
  mode: ProjectModeSchema.optional()
});
export type UpdateProjectSettingsInput = z.infer<typeof UpdateProjectSettingsInputSchema>;

export const RetentionPruneResultSchema = z.object({
  projectId: z.string(),
  traceRetentionDays: z.number().int().positive().nullable(),
  cutoff: z.string().nullable(),
  deletedCases: z.number().int().nonnegative(),
  deletedRawTraces: z.number().int().nonnegative(),
  skippedActiveGoldenCases: z.number().int().nonnegative(),
  skippedImmutableRevisionCases: z.number().int().nonnegative()
});
export type RetentionPruneResult = z.infer<typeof RetentionPruneResultSchema>;

export const DeleteProjectInputSchema = z.object({
  confirmProjectName: z.string().min(1)
});
export type DeleteProjectInput = z.infer<typeof DeleteProjectInputSchema>;

export const JudgeProviderIdSchema = z.enum(["mock", "anthropic", "openai", "openrouter", "custom"]);
export type JudgeProviderId = z.infer<typeof JudgeProviderIdSchema>;

// The release gate technically arms at the FIRST promoted golden case (the
// regression runs against whatever golden set exists); 5+ is the recommended
// size before the gate's verdict means much. Copy that mentions a threshold
// must derive from these two numbers — hardcoded fives drifted into three
// mutually contradictory banners once already.
export const GOLDEN_GATE_ARMS_AT = 1;
export const GOLDEN_GATE_RECOMMENDED = 5;

// Agreement statistics are mathematically computable with fewer cases, but
// rendering a precise κ from one or two overlaps invites false confidence.
// The UI shows collection progress until this minimum shared sample exists.
export const KAPPA_MIN_SHARED_CASES = 5;

// Project names are capped by the API on both creation paths (owner setup and
// POST /api/projects); the UI mirrors it via input maxLength.
export const PROJECT_NAME_MAX_LENGTH = 120;

// Canonical JSON identities operate on Unicode scalar values. JavaScript can
// represent isolated UTF-16 surrogate code units, but UTF-8 encoders replace
// them with U+FFFD, making two distinct inputs collapse to the same bytes.
// Reject them on every new criterion/evaluator/suite write instead.
export function containsLoneUtf16Surrogate(value: unknown): boolean {
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
    return false;
  }
  if (Array.isArray(value)) return value.some(containsLoneUtf16Surrogate);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, nested]) =>
      containsLoneUtf16Surrogate(key) || containsLoneUtf16Surrogate(nested)
    );
  }
  return false;
}

const UnicodeScalarValueSchema = z.string().refine((value) => !containsLoneUtf16Surrogate(value), {
  message: "Text must not contain an unpaired UTF-16 surrogate"
});

// Canonicalize raw provider identifiers at explicit input or protocol-check
// boundaries. Persisted bindings use StoredModelBindingSchema and are already
// canonical.
export function normalizeJudgeProviderId(value: string): JudgeProviderId | null {
  const parsed = JudgeProviderIdSchema.safeParse(value.trim().toLowerCase());
  return parsed.success ? parsed.data : null;
}

const HttpUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), { message: "baseUrl must use http or https" });

// Contract-facing model bindings intentionally mirror the frozen receipt-v1
// and skill-format/v1 schemas, where provider and sampling values are not
// restricted to Coeval's current runtime provider catalog.
export const ModelBindingSchema = z.object({
  provider: z.string(),
  modelId: z.string(),
  // Honest limitation: no supported provider catalog exposes an immutable
  // snapshot id separate from the model id, so every pin path today stores
  // modelVersion = modelId. The field records WHAT was requested, not a dated
  // snapshot — an upstream silent model revision is not detectable through it
  // (see spec/skill-format-v1.md § Model binding).
  modelVersion: z.string(),
  temperature: z.number(),
  topP: z.number().optional(),
  baseUrl: z.string().optional()
});
export type ModelBinding = z.infer<typeof ModelBindingSchema>;

const StoredHttpUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), { message: "baseUrl must use http or https" });

// Database-backed bindings are produced only by current, validated writers.
// Keep this separate from ModelBindingSchema so frozen external contracts are
// not reinterpreted when the runtime provider catalog changes.
export const StoredModelBindingSchema = z
  .object({
    provider: JudgeProviderIdSchema,
    modelId: z.string().min(1).max(240),
    modelVersion: z.string().min(1).max(240),
    temperature: z.number().min(0).max(2),
    topP: z.number().min(0).max(1).optional(),
    baseUrl: StoredHttpUrlSchema.optional()
  })
  .strict()
  .superRefine((binding, ctx) => {
    if (binding.provider === "custom" && !binding.baseUrl) {
      ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "custom providers require an OpenAI-compatible baseUrl" });
    }
    if (binding.provider !== "custom" && binding.baseUrl !== undefined) {
      ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "baseUrl is only valid for custom providers" });
    }
  });
export type StoredModelBinding = z.infer<typeof StoredModelBindingSchema>;

export const ModelBindingInputSchema = z
  .object({
    provider: z.preprocess(
      (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
      JudgeProviderIdSchema
    ),
    modelId: z.string().trim().min(1).max(240),
    modelVersion: z.string().trim().min(1).max(240),
    temperature: z.number().min(0).max(2),
    topP: z.number().min(0).max(1).optional(),
    baseUrl: HttpUrlSchema.optional()
  })
  .superRefine((binding, ctx) => {
    if (binding.provider === "custom" && !binding.baseUrl) {
      ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "custom providers require an OpenAI-compatible baseUrl" });
    }
    if (binding.provider !== "custom" && binding.baseUrl !== undefined) {
      ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "baseUrl is only valid for custom providers" });
    }
  });
export type ModelBindingInput = z.infer<typeof ModelBindingInputSchema>;


export const MinimumVerdictOutputSchema = {
  type: "object",
  required: ["label", "score", "reason", "confidence"],
  additionalProperties: false,
  properties: {
    label: { type: "string", enum: ["pass", "fail", "ambiguous"] },
    score: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
    failureCategory: { type: "string" },
    expectedBehavior: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    criteria: { type: "object" }
  }
} as const;

export const JsonSchemaSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchemaSchema>;

// The immutable output contract stored with a version must describe the
// verdict tool that the runtime actually asks the provider to complete. The
// legacy MinimumVerdictOutputSchema remains available for historical imports;
// new guided Checks use this kind-aware contract instead of copying the
// seeded binary schema into categorical or scalar versions.
export function verdictOutputSchema(input: {
  verdictKind: VerdictKind;
  scalarRange?: [number, number] | null;
  categoricalChoiceScores?: Record<string, number> | null;
}): JsonSchema {
  const rationale = { type: "string", description: "Short rationale grounded in the Review guide and recorded Run." };
  const failingStep = {
    type: "integer",
    minimum: 0,
    description: "Optional 0-based recorded step where the failure occurred."
  };
  if (input.verdictKind === "scalar") {
    const [minimum, maximum] = input.scalarRange ?? [0, 1];
    return {
      type: "object",
      additionalProperties: false,
      required: ["score", "rationale"],
      properties: {
        score: { type: "number", minimum, maximum },
        rationale,
        failingStep
      }
    };
  }
  if (input.verdictKind === "categorical") {
    const choices = Object.keys(input.categoricalChoiceScores ?? {});
    return {
      type: "object",
      additionalProperties: false,
      required: ["choice", "rationale"],
      properties: {
        choice: { type: "string", enum: choices },
        rationale,
        failingStep
      }
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["label", "score", "rationale"],
    properties: {
      label: { type: "string", enum: ["pass", "fail", "ambiguous"] },
      score: { type: "number", minimum: 0, maximum: 1 },
      rationale,
      failingStep
    }
  };
}

// The one template variable a compiled prompt may reference. The trace itself
// is injected separately by the judge message builder (<trace_to_judge>), so
// prompts must not carry their own trace placeholders.
export const RUBRIC_TEMPLATE_VARIABLE = "{{rubric_markdown}}";

export type JudgePromptDiagnostic =
  | { code: "implicit-rubric" }
  | { code: "unknown-variable"; variable: string };

export interface CompiledJudgePrompt {
  content: string;
  rubricMode: "template" | "legacy-prepend";
  diagnostics: JudgePromptDiagnostic[];
}

const JUDGE_PROMPT_VARIABLE_PATTERN = /{{[^{}\r\n]+}}/g;

export function promptReferencesRubric(prompt: string): boolean {
  return prompt.includes(RUBRIC_TEMPLATE_VARIABLE);
}

// Compile the stored prompt template into judge-facing instructions and report
// anything the editor should surface. Unknown variables deliberately remain
// literal: {{rubric_markdown}} is the only supported variable, while the trace
// and verdict schema are injected separately by the judge message builder.
export function compileJudgePrompt(input: { rubricMarkdown: string; prompt: string }): CompiledJudgePrompt {
  const referencesRubric = promptReferencesRubric(input.prompt);
  const diagnostics: JudgePromptDiagnostic[] = [];

  if (input.rubricMarkdown.trim() && !referencesRubric) {
    diagnostics.push({ code: "implicit-rubric" });
  }

  const variables = new Set(input.prompt.match(JUDGE_PROMPT_VARIABLE_PATTERN) ?? []);
  for (const variable of variables) {
    if (variable !== RUBRIC_TEMPLATE_VARIABLE) {
      diagnostics.push({ code: "unknown-variable", variable });
    }
  }

  return {
    content: referencesRubric
      ? input.prompt.split(RUBRIC_TEMPLATE_VARIABLE).join(input.rubricMarkdown)
      : `${input.rubricMarkdown}\n\n${input.prompt}`,
    rubricMode: referencesRubric ? "template" : "legacy-prepend",
    diagnostics
  };
}

// Stable rendering entry point used by both judge execution paths, including
// the live implicit-rubric prompt mode retained by ADR-0011.
export function renderJudgePromptContent(input: { rubricMarkdown: string; prompt: string }): string {
  return compileJudgePrompt(input).content;
}

export const RubricProvenanceSchema = z.enum(["human-authored", "agent-drafted"]);
export type RubricProvenance = z.infer<typeof RubricProvenanceSchema>;

// Seed text only. Whether a skill is still the untouched starter is persisted
// separately on the skill row; content matching must never authorize setup.
export const STARTER_RUBRIC_MARKER = "Define pass, fail, and ambiguous criteria before production use";

// The default compiled-prompt template, parameterized by what the judge is
// looking at ("trace" for tracing projects, "case" for bench, "captured
// agent-skill run" for agent bootstrap). Single-sourced so the seed and the
// bootstrap default can't diverge.
export function defaultJudgePromptTemplate(subject: string): string {
  return `Judge the ${subject} against the review guide below. Submit exactly one verdict using the provided structured verdict tool.\n\n<review_guide>\n${RUBRIC_TEMPLATE_VARIABLE}\n</review_guide>`;
}

export const SkillVersionSchema = z
  .object({
    id: z.string(),
    skillId: z.string(),
    criterionVersionId: z.string(),
    version: z.string(),
    status: SkillStatusSchema,
    rubricMarkdown: z.string(),
    prompt: z.string(),
    modelBinding: StoredModelBindingSchema,
    outputSchema: JsonSchemaSchema,
    goldenSetAgreement: z.number().min(0).max(1).nullable(),
    tooStrictCount: z.number().int().nonnegative(),
    tooLenientCount: z.number().int().nonnegative(),
    ambiguousCount: z.number().int().nonnegative(),
    knownLimitations: z.array(z.string()),
    // v2: every skill version is bound to a verdict shape. Binary classifies
    // pass/fail and supports explicit ambiguous abstention. Scalar + categorical
    // kinds carry their range or choiceScores; refine below enforces shape
    // consistency at the boundary.
    verdictKind: VerdictKindSchema,
    scalarRange: z.tuple([z.number(), z.number()]).nullable(),
    categoricalChoiceScores: z.record(z.string(), z.number().min(0).max(1)).nullable(),
    rubricProvenance: RubricProvenanceSchema,
    // Beginner assurance is independent from the legacy regression lifecycle:
    // an empty known-failure gate may approve execution, but it cannot validate
    // the Check. This marker survives that transition until a future governed
    // calibration flow replaces it with a scoped assurance state.
    onboardingAssurance: z.literal("starter_unvalidated").nullable().optional(),
    // Draft and starter-sign-off versions can legitimately have no regression
    // corpus. Every calibrating or gated version carries an immutable pin.
    regressionDatasetRevisionId: z.string().nullable(),
    createdAt: z.string(),
    approvedAt: z.string().nullable()
  })
  .refine(
    (v) => v.verdictKind !== "scalar" || (v.scalarRange !== null && v.scalarRange[0] < v.scalarRange[1]),
    { message: "scalar skill versions require an ascending scalarRange" }
  )
  .refine(
    (v) => v.verdictKind !== "categorical" || (v.categoricalChoiceScores !== null && Object.keys(v.categoricalChoiceScores).length > 0),
    { message: "categorical skill versions require a non-empty categoricalChoiceScores map" }
  )
  .refine((v) => v.verdictKind === "scalar" || v.scalarRange === null, { message: "scalarRange is only valid for scalar kinds" })
  .refine((v) => v.verdictKind === "categorical" || v.categoricalChoiceScores === null, { message: "categoricalChoiceScores is only valid for categorical kinds" });
export type SkillVersion = z.infer<typeof SkillVersionSchema>;

export const SkillSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  criterionId: z.string(),
  name: z.string(),
  description: z.string(),
  ownerName: z.string(),
  status: SkillStatusSchema,
  // Durable onboarding state. It is cleared transactionally by the first
  // human sign-off/edit or by agent bootstrap; rubric text is not authority.
  isStarter: z.boolean(),
  currentVersion: SkillVersionSchema
});
export type Skill = z.infer<typeof SkillSchema>;

export const VerdictDistributionSchema = z.object({
  pass: z.number().int().nonnegative(),
  fail: z.number().int().nonnegative(),
  ambiguous: z.number().int().nonnegative()
});
export type VerdictDistribution = z.infer<typeof VerdictDistributionSchema>;

// v2 verdict primitives (greenfield rebuild). The legacy `VerdictLabelSchema`
// remains during co-existence; new code paths use the tagged-union shape below.
// Inspired by Braintrust's `choice_scores` (autoevals/py/autoevals/llm.py) + Opik
// `ScoreResult` (sdks/python/src/opik/evaluation/metrics/score_result.py).
// VerdictKindSchema is declared near the top — see early in this file.

// `adjudicated` (A2.2b-2): the recorded legacy ruling a human/panel sets on an
// ungoverned disagreement — the decision that closes this diagnostic loop. It is NOT a
// rater: every κ / disagreement computation filters on `human` / `llm_judge`
// explicitly, so an adjudicated verdict never distorts the agreement math; it
// only annotates which disagreements have been resolved and to what label.
export const VerdictSourceSchema = z.enum(["llm_judge", "human", "imported_external", "adjudicated"]);
export type VerdictSource = z.infer<typeof VerdictSourceSchema>;

// optional failingStep (0-based index into the case's steps) — schema
// only here; T3 teaches the judge to populate it. Lives inside the payload,
// consistent with append-only verdicts.
const FailingStepSchema = z.number().int().nonnegative();

export const BinaryClassifiedVerdictPayloadSchema = z.object({
  kind: z.literal("binary"),
  pass: z.boolean(),
  rationale: z.string(),
  failingStep: FailingStepSchema.optional()
}).strict();

// A binary evaluator may explicitly abstain when its rubric does not support
// either pass or fail. Keep `pass` absent so incorrect readers fail loudly
// instead of treating null or another falsy value as a failure.
export const BinaryAbstainedVerdictPayloadSchema = z.object({
  kind: z.literal("binary"),
  label: z.literal("ambiguous"),
  rationale: z.string()
}).strict();

export const BinaryVerdictPayloadSchema = z.union([
  BinaryClassifiedVerdictPayloadSchema,
  BinaryAbstainedVerdictPayloadSchema
]);

export const ScalarVerdictPayloadSchema = z
  .object({
    kind: z.literal("scalar"),
    score: z.number(),
    range: z.tuple([z.number(), z.number()]),
    rationale: z.string(),
    failingStep: FailingStepSchema.optional()
  })
  .refine((v) => v.range[0] < v.range[1], { message: "scalar range must be ascending" })
  .refine((v) => v.score >= v.range[0] && v.score <= v.range[1], { message: "scalar score must lie within range" });

export const CategoricalVerdictPayloadSchema = z
  .object({
    kind: z.literal("categorical"),
    choice: z.string().min(1),
    choiceScores: z.record(z.string(), z.number().min(0).max(1)),
    rationale: z.string(),
    failingStep: FailingStepSchema.optional()
  })
  .refine((v) => v.choice in v.choiceScores, { message: "chosen category must appear in choiceScores" });

export const VerdictPayloadSchema = z.union([
  BinaryVerdictPayloadSchema,
  ScalarVerdictPayloadSchema,
  CategoricalVerdictPayloadSchema
]);
export type VerdictPayload = z.infer<typeof VerdictPayloadSchema>;

export const VerdictRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  caseId: z.string(),
  skillVersionId: z.string().nullable(),
  source: VerdictSourceSchema,
  actorUserId: z.string().nullable(),
  // Read projections resolve a display name from the authenticated user.
  // Mutation responses and imported/external verdicts may omit it; clients
  // fall back to actorUserId without weakening the append-only record.
  actorName: z.string().nullable().optional(),
  payload: VerdictPayloadSchema,
  externalRunId: z.string().nullable(),
  createdAt: z.string()
});
export type VerdictRecord = z.infer<typeof VerdictRecordSchema>;

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

// one step of a supplied agent trajectory. A case with `steps` is a
// trajectory; a case without is exactly what it was before M2. Steps ride
// inside the normalized case payload — no separate table, no per-step verdict
// rows (locked M2 shape).
export const TraceStepSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  input: z.unknown(),
  output: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).optional()
});
export type TraceStep = z.infer<typeof TraceStepSchema>;

export const MAX_TRACE_STEPS = 50;
const TraceStepsSchema = z
  .array(TraceStepSchema)
  .max(MAX_TRACE_STEPS, `a case supports at most ${MAX_TRACE_STEPS} steps`);

export const TracePayloadSchema = z.object({
  id: z.string(),
  input: z.unknown(),
  output: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  steps: TraceStepsSchema.optional()
});
export type TracePayload = z.infer<typeof TracePayloadSchema>;

export const ManualTraceImportInputSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  sourceTraceId: z.string().min(1).optional(),
  input: z.unknown(),
  output: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  steps: TraceStepsSchema.optional()
});
export type ManualTraceImportInput = z.infer<typeof ManualTraceImportInputSchema>;

export const ManualTraceImportResultSchema = z.object({
  rawTraceId: z.string(),
  caseId: z.string(),
  sourceTraceId: z.string(),
  queued: z.boolean(),
  queueJobId: z.string().nullable()
});
export type ManualTraceImportResult = z.infer<typeof ManualTraceImportResultSchema>;

export const TraceSourceSchema = z.enum(["manual", "langsmith", "langfuse", "ironside"]);
export type TraceSource = z.infer<typeof TraceSourceSchema>;

// Where a CASE came from: the trace-import sources plus 'gate_candidate' —
// the derived cases the product deploy gate mints (golden input + candidate
// output; stored in cases.case_type). Gate candidates are judging
// scaffolding, not customer traffic: they are excluded from the exceptions
// dashboard, the approval-time judge backfill (listCaseIdsForProject), and
// the imported-trace/dashboard counts. TraceSource stays the
// import-integration enum (import_jobs has a matching DB check constraint).
export const CaseSourceSchema = z.enum([...TraceSourceSchema.options, "gate_candidate", "release_evidence"]);
export type CaseSource = z.infer<typeof CaseSourceSchema>;

// Closed provenance vocabulary for Analyze population eligibility. Every new
// Every case writer must choose one current purpose explicitly. Keep this
// schema synchronized with the database CHECK constraint.
export const IngestionPurposeSchema = z.enum([
  "analysis_eligible_manual",
  "analysis_eligible_langsmith",
  "analysis_eligible_langfuse",
  "analysis_eligible_ironside",
  "judge_api",
  "judge_batch_general",
  "dataset_example",
  "trace_test_synthetic",
  "release_evidence"
]);
export type IngestionPurpose = z.infer<typeof IngestionPurposeSchema>;

export const RuntimeIngestionPurposeSchema = IngestionPurposeSchema;
export type RuntimeIngestionPurpose = z.infer<typeof RuntimeIngestionPurposeSchema>;

// API keys for the eval-as-a-service surface. The raw secret is never returned
// after creation — only this metadata + a non-secret prefix for identification.
// BYO judge provider keys. The raw key is never in any schema that a
// client can receive — keyDisplay is the only renderable form.
export const JudgeKeyProviderSchema = z.enum(["anthropic", "openai", "openrouter", "custom"]);
export type JudgeKeyProvider = z.infer<typeof JudgeKeyProviderSchema>;

export const JudgeProviderKeySchema = z.object({
  provider: JudgeKeyProviderSchema,
  keyDisplay: z.string(),
  createdAt: z.string()
});
export type JudgeProviderKey = z.infer<typeof JudgeProviderKeySchema>;

export const SetJudgeProviderKeyInputSchema = z.object({
  apiKey: z.string().trim().min(8).max(512)
});
export type SetJudgeProviderKeyInput = z.infer<typeof SetJudgeProviderKeyInputSchema>;

export const ApiKeySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable()
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

export const CreateApiKeyInputSchema = z.object({
  name: z.string().min(1).max(120)
});
export type CreateApiKeyInput = z.infer<typeof CreateApiKeyInputSchema>;

// Returned once, on mint — carries the plaintext `key` alongside the record.
export const CreatedApiKeySchema = ApiKeySchema.extend({ key: z.string() });
export type CreatedApiKey = z.infer<typeof CreatedApiKeySchema>;

export const SetupResponseSchema = z.object({
  ok: z.literal(true),
  projectId: z.string(),
  // Workspace reuse returns the committed project without minting another
  // one-time key. Keep that current response variant explicit.
  apiKey: CreatedApiKeySchema.optional()
}).strict();
export type SetupResponse = z.infer<typeof SetupResponseSchema>;

// An external agent may scaffold a judge and submit runs, while human labels
// and golden-set promotion remain outside the project-key surface. Pairing
// configures the human's existing onboarding project; the optional headless
// deployment-token fallback creates a bench project.
// Keyed providers plus the explicit 'mock' pin. The runtime's missing-
// credential hint tells agents to pin provider "mock" explicitly for
// keyless wiring tests, so the bootstrap input must accept it (issue #150).
// Mock stays explicit-only: strict judge paths still refuse to SILENTLY
// degrade a real-provider binding to mock verdicts.
export const AgentBootstrapProviderSchema = z.enum([...JudgeKeyProviderSchema.options, "mock"]);
export type AgentBootstrapProvider = z.infer<typeof AgentBootstrapProviderSchema>;

export const AgentBootstrapModelInputSchema = z
  .object({
    provider: AgentBootstrapProviderSchema,
    // Optional for catalog providers (server pins the first available model)
    // and for mock (the built-in heuristic has one model). Required for custom.
    modelId: z.string().trim().min(1).max(240).optional(),
    temperature: z.number().min(0).max(2).default(0),
    baseUrl: HttpUrlSchema.optional()
  })
  .superRefine((model, ctx) => {
    if (model.provider === "custom") {
      if (!model.baseUrl) {
        ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "custom providers require an OpenAI-compatible baseUrl" });
      }
      if (!model.modelId) {
        ctx.addIssue({ code: "custom", path: ["modelId"], message: "custom providers require an explicit modelId" });
      }
    } else if (model.baseUrl !== undefined) {
      ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "baseUrl is only valid for custom providers" });
    }
  });
export type AgentBootstrapModelInput = z.infer<typeof AgentBootstrapModelInputSchema>;

export const AgentBootstrapRequestSchema = z.object({
  owner: z.object({
    email: z.string().email(),
    // Required only while creating the instance's first owner. Existing
    // owners are selected by email and need no password in this request.
    password: z.string().min(8).optional(),
    name: z.string().trim().min(1).max(120).optional()
  }),
  project: z.object({
    name: z.string().trim().min(1).max(PROJECT_NAME_MAX_LENGTH),
    apiKeyName: z.string().trim().min(1).max(120).default("Agent bootstrap")
  }),
  // The beginner-visible quality question. Agent bootstrap must append this
  // exact immutable criterion definition and bind the evaluator version to it;
  // hiding it only inside rubricMarkdown would leave a generic seeded
  // criterion underneath a more specific visible Check.
  check: z.object({
    name: UnicodeScalarValueSchema.trim().min(1).max(200),
    question: UnicodeScalarValueSchema.trim().min(1).max(20_000)
  }).strict(),
  skill: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    rubricMarkdown: z.string().trim().min(1).max(100_000),
    // Omit for the safe built-in prompt that references the rubric. A supplied
    // prompt is accepted only after the endpoint's diagnostic validation.
    prompt: z.string().trim().min(1).max(100_000).optional(),
    model: AgentBootstrapModelInputSchema
  }),
  // Optional project-scoped provider credential. If omitted, the deployment's
  // provider environment key must exist. This secret is stored encrypted and
  // is never returned in the response.
  providerApiKey: z.string().trim().min(8).max(512).optional()
}).superRefine((request, ctx) => {
  // The mock judge takes no credential — a key sent alongside it is a caller
  // mistake (probably meant a real provider); reject instead of silently
  // storing or dropping the secret.
  if (request.skill.model.provider === "mock" && request.providerApiKey !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["providerApiKey"],
      message: "providerApiKey is not valid when pinning provider \"mock\" — the mock judge takes no credential"
    });
  }
});
export type AgentBootstrapRequest = z.infer<typeof AgentBootstrapRequestSchema>;

// "Connect your agent" wiring snippets (issue #15). One builder feeds three
// surfaces — Settings → API keys (fresh key pre-filled at the mint moment,
// placeholder afterwards), the bootstrap completion response, and the
// coeval-audit setup script's printed next-steps — so the copy-paste forms
// cannot drift from tools/mcp/README.md's contract. The paths keep the
// README's /path/to/coeval placeholder: no surface knows the user's checkout.
export const AGENT_CONNECT_KEY_PLACEHOLDER = "<your key>";

// The governance boundary, said where it is felt: the project-key surface is
// read + submit only. Adjudication and golden promotion stay human-only.
export const AGENT_CONNECT_BOUNDARY_LINE =
  "Your agent can read findings and submit runs; it can never adjudicate or promote — that stays here, with you.";

const AGENT_CONNECT_MCP_SERVER_PATH = "/path/to/coeval/tools/mcp/index.mjs";
const AGENT_CONNECT_CLI_PATH = "/path/to/coeval/skills/coeval-audit/scripts/coeval-submit.mjs";

export const AgentConnectSnippetsSchema = z.object({
  claudeCode: z.string(),
  mcpJson: z.string(),
  cli: z.string()
});
export type AgentConnectSnippets = z.infer<typeof AgentConnectSnippetsSchema>;

export function buildAgentConnectSnippets(input: { apiBaseUrl: string; apiKey?: string }): AgentConnectSnippets {
  const url = input.apiBaseUrl.replace(/\/+$/, "");
  const key = input.apiKey ?? AGENT_CONNECT_KEY_PLACEHOLDER;
  // The shell forms double-quote the key slot so the placeholder's angle
  // brackets can never reach the shell as redirection when pasted unedited.
  // A real key is coeval_sk_ + base64url, so the quotes are inert — and
  // coeval-submit's masked echo becomes "$VAR", which still expands.
  const shellKey = `"${key}"`;
  return {
    claudeCode: `claude mcp add coeval --env COEVAL_URL=${url} --env COEVAL_API_KEY=${shellKey} -- node ${AGENT_CONNECT_MCP_SERVER_PATH}`,
    // Built through JSON.stringify so the pasted block is always valid JSON,
    // whatever characters the key or URL contain.
    mcpJson: JSON.stringify(
      {
        mcpServers: {
          coeval: {
            command: "node",
            args: [AGENT_CONNECT_MCP_SERVER_PATH],
            env: { COEVAL_URL: url, COEVAL_API_KEY: key }
          }
        }
      },
      null,
      2
    ),
    cli: [
      `export COEVAL_URL=${url}`,
      `export COEVAL_API_KEY=${shellKey}`,
      `node ${AGENT_CONNECT_CLI_PATH} findings`,
      `node ${AGENT_CONNECT_CLI_PATH} submit results.jsonl`
    ].join("\n")
  };
}

export const AgentBootstrapResponseSchema = z.object({
  projectId: z.string(),
  skillId: z.string(),
  skillVersionId: z.string(),
  check: z.object({
    criterionId: z.string().min(1),
    criterionVersionId: z.string().min(1),
    name: z.string().min(1),
    question: z.string().min(1),
    digest: z.string().startsWith("sha256:")
  }).strict(),
  mode: ProjectModeSchema,
  rubricProvenance: z.literal("agent-drafted"),
  modelBinding: StoredModelBindingSchema,
  apiKey: CreatedApiKeySchema,
  // Ready-to-paste wiring with the one-time key pre-filled — the same plaintext
  // already travels in `apiKey.key`, so headless setups end wired, not just
  // keyed. Clients that PRINT these must mask the key first (coeval-submit
  // substitutes the saved env-var name).
  connect: AgentConnectSnippetsSchema,
  next: z.object({
    judgeBatchPath: z.literal("/api/v1/judge/batch"),
    humanReviewPath: z.literal("/exceptions"),
    gateBoundary: z.literal("human-only")
  })
});
export type AgentBootstrapResponse = z.infer<typeof AgentBootstrapResponseSchema>;

export const AgentSetupPairingStatusSchema = z.enum(["pending", "claimed", "completed", "expired", "revoked"]);
export type AgentSetupPairingStatus = z.infer<typeof AgentSetupPairingStatusSchema>;

export const AgentSetupPairingSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  ownerEmail: z.string().email(),
  apiBaseUrl: HttpUrlSchema,
  expiresAt: z.string(),
  claimExpiresAt: z.string().nullable().default(null),
  status: AgentSetupPairingStatusSchema
});
export type AgentSetupPairing = z.infer<typeof AgentSetupPairingSchema>;

// The plaintext pairing token is returned exactly once when the signed-in
// project owner creates it. Status reads expose metadata only.
export const CreatedAgentSetupPairingSchema = AgentSetupPairingSchema.extend({
  token: z.string().startsWith("coeval_pair_")
});
export type CreatedAgentSetupPairing = z.infer<typeof CreatedAgentSetupPairingSchema>;

// Body for POST /api/v1/judge — the eval-as-a-service request. `trace` reuses
// the manual-import shape; `skillVersionId` is optional (defaults to the
// project's current skill version).
export const JudgeServiceRequestSchema = z.object({
  trace: ManualTraceImportInputSchema,
  skillVersionId: z.string().min(1).optional(),
  // Re-POSTing a trace the project has already judged returns the recorded
  // verdict (200, cached: true) instead of burning provider tokens on a
  // client retry. `force: true` bypasses the cache — the path self-consistency
  // probes use to collect intentional repeat verdicts.
  force: z.boolean().optional()
});
export type JudgeServiceRequest = z.infer<typeof JudgeServiceRequestSchema>;

// Trace-to-test: a beginner-facing test derived from one retained source
// conversation. The stable identity owns provenance; every content change and
// validation is append-only so an enabled revision is never rewritten in
// place. Product copy calls these Tests, not eval cases.
export const TraceTestLifecycleSchema = z.enum(["draft", "enabled"]);
export type TraceTestLifecycle = z.infer<typeof TraceTestLifecycleSchema>;

const TraceTestPathSegmentSchema = z.union([
  z.string().min(1).max(200),
  z.number().int().nonnegative()
]);

export const TraceTestSourceScopeSchema = z.object({
  responsePath: z.array(TraceTestPathSegmentSchema).max(32),
  turnIndexes: z.array(z.number().int().nonnegative()).max(200).default([]),
  stepIndexes: z.array(z.number().int().nonnegative()).max(MAX_TRACE_STEPS).default([])
});
export type TraceTestSourceScope = z.infer<typeof TraceTestSourceScopeSchema>;

export const TraceTestDraftFieldSchema = z.enum([
  "scenario",
  "expectedBehavior",
  "mustDo",
  "mustAvoid",
  "goodExample",
  "badExample",
  "checker"
]);
export type TraceTestDraftField = z.infer<typeof TraceTestDraftFieldSchema>;

export const TraceTestDraftProvenanceSchema = z.object({
  origin: z.enum(["human", "generated", "mixed"]),
  generatedFields: z.array(TraceTestDraftFieldSchema).max(7).default([]),
  generator: z.object({
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
    version: z.string().min(1).max(200).optional()
  }).nullable().default(null)
}).superRefine((value, ctx) => {
  if (value.origin === "human" && value.generatedFields.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["generatedFields"],
      message: "human drafts cannot declare generated fields"
    });
  }
  if (value.origin === "human" && value.generator !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["generator"],
      message: "human drafts cannot declare a generator"
    });
  }
  if (value.origin !== "human" && value.generatedFields.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["generatedFields"],
      message: "assisted drafts must identify generated fields"
    });
  }
  if (value.origin !== "human" && value.generator === null) {
    ctx.addIssue({
      code: "custom",
      path: ["generator"],
      message: "assisted drafts must identify their generator"
    });
  }
});
export type TraceTestDraftProvenance = z.infer<typeof TraceTestDraftProvenanceSchema>;

export const TraceTestCheckerSchema = z.object({
  kind: z.enum(["judge", "deterministic", "manual"]),
  label: z.string().min(1).max(120),
  metadata: z.record(z.string(), z.json()).default({})
});
export type TraceTestChecker = z.infer<typeof TraceTestCheckerSchema>;

const TraceTestExampleSchema = z.json();

export const TraceTestDraftContentSchema = z.object({
  scenario: z.string().trim().min(1).max(20_000),
  expectedBehavior: z.string().trim().min(1).max(20_000),
  mustDo: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
  mustAvoid: z.array(z.string().trim().min(1).max(2_000)).max(50).default([]),
  goodExample: TraceTestExampleSchema,
  badExample: TraceTestExampleSchema,
  checker: TraceTestCheckerSchema,
  draftProvenance: TraceTestDraftProvenanceSchema
});
export type TraceTestDraftContent = z.infer<typeof TraceTestDraftContentSchema>;

export const TraceTestValidationOutcomeSchema = z.enum([
  "pass",
  "fail",
  "ambiguous",
  "evaluator_error",
  "unavailable",
  // Backward-compatible values for validations recorded before Batch 5.
  "needs_review",
  "could_not_run"
]);
export type TraceTestValidationOutcome = z.infer<typeof TraceTestValidationOutcomeSchema>;

export const TraceTestValidationStatusSchema = z.enum([
  "passed",
  "failed",
  "non_discriminating",
  "ambiguous",
  "evaluator_error",
  "unavailable",
  // Backward-compatible values for validations recorded before Batch 5.
  "needs_review",
  "could_not_run"
]);
export type TraceTestValidationStatus = z.infer<typeof TraceTestValidationStatusSchema>;

export const TraceTestValidationEvidenceInputSchema = z.object({
  output: TraceTestExampleSchema,
  result: TraceTestValidationOutcomeSchema,
  note: z.string().max(2_000).nullable().default(null)
});
export type TraceTestValidationEvidenceInput = z.infer<typeof TraceTestValidationEvidenceInputSchema>;

export const TraceTestValidationEvidenceSchema = TraceTestValidationEvidenceInputSchema.extend({
  expectedResult: z.enum(["pass", "fail"]),
  attempts: z.number().int().nonnegative().default(0),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative()
  }).nullable().default(null)
});
export type TraceTestValidationEvidence = z.infer<typeof TraceTestValidationEvidenceSchema>;

export const TraceTestValidationMethodSchema = z.enum(["automated", "manual_override"]);
export type TraceTestValidationMethod = z.infer<typeof TraceTestValidationMethodSchema>;

export const TraceTestValidationDiagnosticSchema = z.enum([
  "always_pass",
  "always_fail",
  "reversed",
  "ambiguous",
  "evaluator_error",
  "unavailable"
]);
export type TraceTestValidationDiagnostic = z.infer<typeof TraceTestValidationDiagnosticSchema>;

export const TraceTestValidationEvaluatorSchema = z.object({
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  version: z.string().min(1).max(200).optional()
});
export type TraceTestValidationEvaluator = z.infer<typeof TraceTestValidationEvaluatorSchema>;

export const TraceTestRevisionSchema = TraceTestDraftContentSchema.extend({
  id: z.string(),
  traceTestId: z.string(),
  revision: z.number().int().positive(),
  lifecycle: TraceTestLifecycleSchema,
  desiredBehavior: z.string().trim().min(1).max(20_000),
  validationId: z.string().nullable(),
  validatedRevision: z.number().int().positive().nullable(),
  createdByUserId: z.string().nullable(),
  reviewedByUserId: z.string().nullable(),
  createdAt: z.string(),
  reviewedAt: z.string().nullable()
});
export type TraceTestRevision = z.infer<typeof TraceTestRevisionSchema>;

export const TraceTestValidationSchema = z.object({
  id: z.string(),
  traceTestId: z.string(),
  revision: z.number().int().positive(),
  status: TraceTestValidationStatusSchema,
  badEvidence: TraceTestValidationEvidenceSchema,
  goodEvidence: TraceTestValidationEvidenceSchema,
  method: TraceTestValidationMethodSchema,
  diagnostic: TraceTestValidationDiagnosticSchema.nullable().default(null),
  evaluator: TraceTestValidationEvaluatorSchema.nullable().default(null),
  overrideReason: z.string().max(2_000).nullable().default(null),
  recordedByUserId: z.string().nullable(),
  createdAt: z.string()
});
export type TraceTestValidation = z.infer<typeof TraceTestValidationSchema>;

export const TraceTestSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  sourceCaseId: z.string().nullable(),
  sourceCaseRef: z.string(),
  sourceTraceRef: z.string(),
  lifecycle: TraceTestLifecycleSchema,
  currentRevision: z.number().int().positive(),
  enabledRevision: z.number().int().positive().nullable(),
  hasUnpublishedChanges: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type TraceTestSummary = z.infer<typeof TraceTestSummarySchema>;

export const TraceTestDetailSchema = TraceTestSummarySchema.extend({
  sourceSnapshot: z.unknown(),
  sourceScope: TraceTestSourceScopeSchema,
  createdByUserId: z.string().nullable(),
  revisions: z.array(TraceTestRevisionSchema),
  validations: z.array(TraceTestValidationSchema)
});
export type TraceTestDetail = z.infer<typeof TraceTestDetailSchema>;

export const CreateTraceTestInputSchema = TraceTestDraftContentSchema.extend({
  sourceCaseId: z.string().min(1),
  sourceScope: TraceTestSourceScopeSchema,
  desiredBehavior: z.string().trim().min(1).max(20_000)
});
export type CreateTraceTestInput = z.infer<typeof CreateTraceTestInputSchema>;

// Optional model assistance for the beginner drafting step. The server owns
// source retrieval/redaction; clients identify the retained case and scope
// rather than posting trace content back across the trust boundary.
export const TraceTestDraftJobSchema = z.enum(["response", "preserve"]);
export type TraceTestDraftJob = z.infer<typeof TraceTestDraftJobSchema>;

export const AssistTraceTestDraftInputSchema = z.object({
  sourceCaseId: z.string().min(1),
  skillVersionId: z.string().min(1).optional(),
  sourceScope: TraceTestSourceScopeSchema,
  desiredBehavior: z.string().trim().min(1).max(20_000),
  job: TraceTestDraftJobSchema
});
export type AssistTraceTestDraftInput = z.infer<typeof AssistTraceTestDraftInputSchema>;

export const AssistedTraceTestContentSchema = z.object({
  scenario: z.string().trim().min(1).max(20_000),
  expectedBehavior: z.string().trim().min(1).max(20_000),
  mustDo: z.array(z.string().trim().min(1).max(2_000)).max(50),
  mustAvoid: z.array(z.string().trim().min(1).max(2_000)).max(50),
  goodExample: z.string().max(20_000),
  badExample: z.string().max(20_000),
  checker: TraceTestCheckerSchema.extend({ kind: z.enum(["judge", "manual"]) }),
  inferredContext: z.array(z.string().trim().min(1).max(1_000)).max(10)
});
export type AssistedTraceTestContent = z.infer<typeof AssistedTraceTestContentSchema>;

export const AssistedTraceTestDraftSchema = z.object({
  status: z.literal("generated"),
  content: AssistedTraceTestContentSchema,
  sourceScope: TraceTestSourceScopeSchema,
  draftProvenance: TraceTestDraftProvenanceSchema
});

export const AssistedTraceTestUnavailableSchema = z.object({
  status: z.literal("unavailable"),
  reason: z.enum(["missing_credentials", "unsupported_provider", "provider_error"]),
  message: z.string().min(1).max(500)
});

export const AssistTraceTestDraftResultSchema = z.discriminatedUnion("status", [
  AssistedTraceTestDraftSchema,
  AssistedTraceTestUnavailableSchema
]);
export type AssistTraceTestDraftResult = z.infer<typeof AssistTraceTestDraftResultSchema>;

export const ReviseTraceTestInputSchema = TraceTestDraftContentSchema.extend({
  expectedRevision: z.number().int().positive(),
  desiredBehavior: z.string().trim().min(1).max(20_000)
});
export type ReviseTraceTestInput = z.infer<typeof ReviseTraceTestInputSchema>;

export const RecordManualTraceTestValidationInputSchema = z.object({
  revision: z.number().int().positive(),
  badResult: z.enum(["pass", "fail", "ambiguous"]),
  goodResult: z.enum(["pass", "fail", "ambiguous"]),
  overrideReason: z.string().trim().min(10).max(2_000)
});
export type RecordManualTraceTestValidationInput = z.infer<typeof RecordManualTraceTestValidationInputSchema>;

export const RunTraceTestValidationInputSchema = z.object({
  revision: z.number().int().positive(),
  skillVersionId: z.string().min(1).optional()
});
export type RunTraceTestValidationInput = z.infer<typeof RunTraceTestValidationInputSchema>;

export const EnableTraceTestInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  validationId: z.string().min(1)
});
export type EnableTraceTestInput = z.infer<typeof EnableTraceTestInputSchema>;

// Datasets: named case collections — the generalization of the golden set's
// "cases worth re-judging" role. A dataset is NOT a label registry (the golden
// set keeps promote/retire + health); `expectedLabel` is optional per item so
// eval runs CAN report agreement without requiring ground truth.
export const DatasetKindSchema = z.enum(["custom", "adhoc"]);
export type DatasetKind = z.infer<typeof DatasetKindSchema>;

export const DatasetSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  kind: DatasetKindSchema,
  itemCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  archivedAt: z.string().nullable()
});
export type Dataset = z.infer<typeof DatasetSchema>;

export const DatasetItemSchema = z.object({
  id: z.string(),
  datasetId: z.string(),
  caseId: z.string(),
  traceId: z.string(),
  expectedLabel: VerdictLabelSchema.exclude(["ambiguous"]).nullable(),
  // which step you expect the failure on (0-based; only ever stored
  // alongside expectedLabel "fail" — a re-label to pass clears it).
  expectedFailStep: z.number().int().nonnegative().nullable(),
  note: z.string().nullable(),
  addedAt: z.string()
});
export type DatasetItem = z.infer<typeof DatasetItemSchema>;

export const DatasetDetailSchema = DatasetSchema.extend({
  items: z.array(DatasetItemSchema)
});
export type DatasetDetail = z.infer<typeof DatasetDetailSchema>;

// Immutable evidence revisions sit alongside mutable datasets. Exact input
// identity is deliberately separate from assessment-receipt v1's
// input+output content digest.
export const DatasetRevisionRoleSchema = z.enum([
  "analysis_authoring",
  "iterative_development",
  "sealed_validation",
  "regression_golden"
]);
export type DatasetRevisionRole = z.infer<typeof DatasetRevisionRoleSchema>;

export const DatasetRevisionSourceKindSchema = z.enum([
  "collection_snapshot",
  "golden_snapshot",
  "sealed_intake",
  "analysis_population"
]);
export type DatasetRevisionSourceKind = z.infer<typeof DatasetRevisionSourceKindSchema>;

export const DatasetRevisionProvenanceLevelSchema = z.enum([
  "legacy",
  "unverified",
  "imported_self_attested",
  "imported_verified_attested",
  "reviewed_unblinded",
  "governed_blind"
]);
export type DatasetRevisionProvenanceLevel = z.infer<typeof DatasetRevisionProvenanceLevelSchema>;

export const DatasetExposureStateSchema = z.enum(["visible_by_design", "protected", "exposed"]);
export type DatasetExposureState = z.infer<typeof DatasetExposureStateSchema>;

export const DatasetEvidenceDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const DatasetReferenceProvenanceSchema = z.object({
  kind: z.enum(["unlabeled", "dataset_claim", "human_verdict", "adjudication", "golden_promotion"]),
  sourceId: z.string().nullable(),
  verdictIds: z.array(z.string()),
  actorUserIds: z.array(z.string()),
  basis: z.string()
}).strict();
export type DatasetReferenceProvenance = z.infer<typeof DatasetReferenceProvenanceSchema>;

export const DatasetRevisionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  seriesId: z.string(),
  revisionNumber: z.number().int().positive(),
  sourceDatasetId: z.string().nullable(),
  parentRevisionId: z.string().nullable(),
  role: DatasetRevisionRoleSchema,
  sourceKind: DatasetRevisionSourceKindSchema,
  identityBasis: z.literal("input-identity/v1"),
  contentDigest: DatasetEvidenceDigestSchema,
  revisionDigest: DatasetEvidenceDigestSchema,
  itemCount: z.number().int().nonnegative(),
  provenanceLevel: DatasetRevisionProvenanceLevelSchema,
  exposureState: DatasetExposureStateSchema,
  // Exact digests cannot detect paraphrases or semantic near-duplicates.
  semanticLeakageDetection: z.literal("unsupported"),
  createdByUserId: z.string().nullable(),
  createdAt: z.string()
});
export type DatasetRevision = z.infer<typeof DatasetRevisionSchema>;

export const DatasetRevisionPayloadSnapshotSchema = z.object({
  input: z.unknown(),
  output: z.unknown(),
  metadata: z.record(z.string(), z.unknown()),
  steps: z.array(TraceStepSchema).optional()
}).strict();
export type DatasetRevisionPayloadSnapshot = z.infer<typeof DatasetRevisionPayloadSnapshotSchema>;

export const DatasetRevisionItemSchema = z.object({
  id: z.string(),
  revisionId: z.string(),
  position: z.number().int().nonnegative(),
  sourceCaseId: z.string().nullable(),
  sourceTraceId: z.string().nullable(),
  sourceDatasetItemId: z.string().nullable(),
  sourceGoldenEntryId: z.string().nullable(),
  inputDigest: DatasetEvidenceDigestSchema,
  itemDigest: DatasetEvidenceDigestSchema,
  payloadSnapshot: DatasetRevisionPayloadSnapshotSchema,
  referenceLabel: VerdictLabelSchema.exclude(["ambiguous"]).nullable(),
  referenceFailStep: z.number().int().nonnegative().nullable(),
  referenceProvenance: DatasetReferenceProvenanceSchema,
  note: z.string().nullable(),
  createdAt: z.string()
});
export type DatasetRevisionItem = z.infer<typeof DatasetRevisionItemSchema>;

// Representative Analyze population and one server draw (ADR-0010, Batch
// 6B-1b). The route accepts only the four request fields below; all evidence
// identity, ordering, seed, rows, and digests are server-owned.
export const ANALYSIS_POPULATION_MAX_MEMBERS = 100_000 as const;
export const ANALYSIS_POPULATION_MAX_FIXED_BUDGET = 10_000 as const;
export const ANALYSIS_POPULATION_MIN_WINDOW_LAG_SECONDS = 60 as const;
export const ANALYSIS_POPULATION_CANONICALIZATION_VERSION = "governed-content-json/v1" as const;
export const ANALYSIS_POPULATION_ORDERING_VERSION = "cases-created-at-id/v1" as const;
export const ANALYSIS_POPULATION_RNG_VERSION = "sha256-rank/v1" as const;
export const ANALYSIS_POPULATION_DRAW_ALGORITHM_VERSION = "coeval-analysis-draw/v1" as const;
export const ANALYSIS_POPULATION_MAX_SNAPSHOT_XID8_BYTES = 1_048_576 as const;

export const ANALYSIS_POPULATION_ELIGIBLE_SOURCES = [
  "manual",
  "langsmith",
  "langfuse",
  "ironside"
] as const;
export const AnalysisPopulationEligibleSourcesSchema = z.tuple([
  z.literal("manual"),
  z.literal("langsmith"),
  z.literal("langfuse"),
  z.literal("ironside")
]);

export const ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES = [
  "analysis_eligible_manual",
  "analysis_eligible_langsmith",
  "analysis_eligible_langfuse",
  "analysis_eligible_ironside"
] as const;
export const AnalysisPopulationEligibleIngestionPurposesSchema = z.tuple([
  z.literal("analysis_eligible_manual"),
  z.literal("analysis_eligible_langsmith"),
  z.literal("analysis_eligible_langfuse"),
  z.literal("analysis_eligible_ironside")
]);

const AnalysisPopulationTimestampSchema = z.string().datetime({ offset: true });
const AnalysisPopulationRequestTimestampSchema = AnalysisPopulationTimestampSchema
  .transform((value) => new Date(value).toISOString());
const AnalysisPopulationSnapshotXid8Schema = z.string().min(1)
  .regex(/^[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?$/)
  .max(ANALYSIS_POPULATION_MAX_SNAPSHOT_XID8_BYTES);
const AnalysisPopulationIdSchema = z.string().min(1).max(240);
const AnalysisPopulationCountSchema = z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_MEMBERS);
export const AnalysisPopulationExactCountSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const ANALYSIS_POPULATION_API_PAGE_MAX = 200 as const;
export const ANALYSIS_POPULATION_CURSOR_MAX_LENGTH = 2_048 as const;
const AnalysisPopulationCursorSchema = z.string().min(1).max(ANALYSIS_POPULATION_CURSOR_MAX_LENGTH).nullable();

export const AnalysisPopulationCreateInputSchema = z.object({
  windowStart: AnalysisPopulationRequestTimestampSchema,
  windowEnd: AnalysisPopulationRequestTimestampSchema,
  fixedBudget: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  idempotencyKey: z.string().min(1).max(240)
    .refine((value) => value.trim().length > 0, { message: "must contain non-whitespace content" })
    .refine((value) => value === value.trim(), { message: "must not have leading or trailing whitespace" })
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.windowStart) >= Date.parse(value.windowEnd)) {
    ctx.addIssue({
      code: "custom",
      path: ["windowEnd"],
      message: "windowEnd must be later than windowStart"
    });
  }
});
export type AnalysisPopulationCreateInput = z.infer<typeof AnalysisPopulationCreateInputSchema>;

export const AnalysisPopulationRequestRecordSchema = z.object({
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  idempotencyKey: z.string().min(1).max(240),
  requestDigest: DatasetEvidenceDigestSchema,
  populationId: AnalysisPopulationIdSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict();
export type AnalysisPopulationRequestRecord = z.infer<typeof AnalysisPopulationRequestRecordSchema>;

export const AnalysisPopulationSchema = z.object({
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  datasetRevisionId: AnalysisPopulationIdSchema,
  windowStart: AnalysisPopulationTimestampSchema,
  windowEnd: AnalysisPopulationTimestampSchema,
  eligibleSources: AnalysisPopulationEligibleSourcesSchema,
  eligibleIngestionPurposes: AnalysisPopulationEligibleIngestionPurposesSchema,
  canonicalizationVersion: z.literal(ANALYSIS_POPULATION_CANONICALIZATION_VERSION),
  orderingVersion: z.literal(ANALYSIS_POPULATION_ORDERING_VERSION),
  populationSize: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_MEMBERS),
  exclusionCount: AnalysisPopulationExactCountSchema,
  frameDigest: DatasetEvidenceDigestSchema,
  contentDigest: DatasetEvidenceDigestSchema,
  // pg_current_snapshot() text is ASCII, so this character bound is the exact
  // byte bound enforced by the current baseline.
  snapshotXid8: AnalysisPopulationSnapshotXid8Schema,
  snapshotTakenAt: AnalysisPopulationTimestampSchema,
  createdByUserId: AnalysisPopulationIdSchema,
  createdBySubjectId: AnalysisPopulationIdSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict();
export type AnalysisPopulation = z.infer<typeof AnalysisPopulationSchema>;

const AnalysisPopulationMemberBaseSchema = z.object({
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  populationId: AnalysisPopulationIdSchema,
  revisionItemId: AnalysisPopulationIdSchema,
  caseId: AnalysisPopulationIdSchema,
  caseType: z.enum(ANALYSIS_POPULATION_ELIGIBLE_SOURCES),
  ingestionPurpose: z.enum(ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES),
  position: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_MEMBERS - 1),
  ingestionTime: AnalysisPopulationTimestampSchema,
  inputDigest: DatasetEvidenceDigestSchema,
  itemDigest: DatasetEvidenceDigestSchema,
  frameMemberDigest: DatasetEvidenceDigestSchema,
  lineageDigest: DatasetEvidenceDigestSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict();

function refineAnalysisPopulationMemberOrigin(
  value: { caseType: typeof ANALYSIS_POPULATION_ELIGIBLE_SOURCES[number]; ingestionPurpose: typeof ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES[number] },
  ctx: z.RefinementCtx
): void {
  const valid =
    (value.caseType === "manual" && value.ingestionPurpose === "analysis_eligible_manual") ||
    (value.caseType === "langsmith" && value.ingestionPurpose === "analysis_eligible_langsmith") ||
    (value.caseType === "langfuse" && value.ingestionPurpose === "analysis_eligible_langfuse") ||
    (value.caseType === "ironside" && value.ingestionPurpose === "analysis_eligible_ironside");
  if (!valid) {
    ctx.addIssue({
      code: "custom",
      path: ["ingestionPurpose"],
      message: "ingestionPurpose must match the eligible caseType origin"
    });
  }
}

export const AnalysisPopulationMemberSchema = AnalysisPopulationMemberBaseSchema
  .superRefine(refineAnalysisPopulationMemberOrigin);
export type AnalysisPopulationMember = z.infer<typeof AnalysisPopulationMemberSchema>;

export const AnalysisPopulationMemberRecordSchema = AnalysisPopulationMemberBaseSchema.extend({
  rawTraceId: AnalysisPopulationIdSchema,
  sourceTraceId: z.string().min(1)
}).strict().superRefine(refineAnalysisPopulationMemberOrigin);
export type AnalysisPopulationMemberRecord = z.infer<typeof AnalysisPopulationMemberRecordSchema>;

export const AnalysisPopulationExclusionReasonSchema = z.literal("ineligible_ingestion_purpose");
export type AnalysisPopulationExclusionReason = z.infer<typeof AnalysisPopulationExclusionReasonSchema>;

const AnalysisPopulationExclusionBaseShape = {
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  populationId: AnalysisPopulationIdSchema,
  caseId: AnalysisPopulationIdSchema,
  position: AnalysisPopulationExactCountSchema,
  ingestionTime: AnalysisPopulationTimestampSchema,
  reason: AnalysisPopulationExclusionReasonSchema,
  contentDigest: DatasetEvidenceDigestSchema,
  createdAt: AnalysisPopulationTimestampSchema
} as const;

const AnalysisPopulationManualExclusionSchema = z.object({
  ...AnalysisPopulationExclusionBaseShape,
  rawTraceId: AnalysisPopulationIdSchema,
  sourceTraceId: z.string().min(1),
  caseType: z.literal("manual"),
  ingestionPurpose: z.enum([
    "judge_api",
    "judge_batch_general",
    "dataset_example",
    "trace_test_synthetic"
  ])
}).strict();

const AnalysisPopulationReleaseExclusionSchema = z.object({
  ...AnalysisPopulationExclusionBaseShape,
  rawTraceId: AnalysisPopulationIdSchema.nullable(),
  sourceTraceId: z.string().min(1).nullable(),
  caseType: z.literal("release_evidence"),
  ingestionPurpose: z.literal("release_evidence")
}).strict().superRefine((value, ctx) => {
  if ((value.rawTraceId === null) !== (value.sourceTraceId === null)) {
    ctx.addIssue({ code: "custom", path: ["sourceTraceId"], message: "raw and source trace identity must be present together" });
  }
});

export const AnalysisPopulationExclusionSchema = z.union([
  AnalysisPopulationManualExclusionSchema,
  AnalysisPopulationReleaseExclusionSchema
]);
export type AnalysisPopulationExclusion = z.infer<typeof AnalysisPopulationExclusionSchema>;

export const AnalysisPopulationInclusionProbabilitySchema = z.object({
  numerator: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  denominator: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_MEMBERS)
}).strict().superRefine((value, ctx) => {
  if (value.numerator > value.denominator) {
    ctx.addIssue({ code: "custom", path: ["numerator"], message: "numerator cannot exceed denominator" });
  }
});
export type AnalysisPopulationInclusionProbability = z.infer<typeof AnalysisPopulationInclusionProbabilitySchema>;

export const AnalysisPopulationDrawSelectionSchema = z.object({
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  drawId: AnalysisPopulationIdSchema,
  populationId: AnalysisPopulationIdSchema,
  memberId: AnalysisPopulationIdSchema,
  revisionItemId: AnalysisPopulationIdSchema,
  caseId: AnalysisPopulationIdSchema,
  position: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET - 1),
  frameMemberDigest: DatasetEvidenceDigestSchema,
  rankDigest: DatasetEvidenceDigestSchema,
  contentDigest: DatasetEvidenceDigestSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict();
export type AnalysisPopulationDrawSelection = z.infer<typeof AnalysisPopulationDrawSelectionSchema>;

const AnalysisPopulationDrawBaseSchema = z.object({
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  populationId: AnalysisPopulationIdSchema,
  datasetRevisionId: AnalysisPopulationIdSchema,
  method: z.literal("simple_random"),
  stoppingRule: z.literal("fixed"),
  drawExecutor: z.literal("coeval_server"),
  seed: z.string().regex(/^[0-9a-f]{64}$/),
  rngVersion: z.literal(ANALYSIS_POPULATION_RNG_VERSION),
  algorithmVersion: z.literal(ANALYSIS_POPULATION_DRAW_ALGORITHM_VERSION),
  fixedBudget: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  populationSize: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_MEMBERS),
  inclusionProbability: AnalysisPopulationInclusionProbabilitySchema,
  drawDigest: DatasetEvidenceDigestSchema,
  contentDigest: DatasetEvidenceDigestSchema,
  executedBySubjectId: AnalysisPopulationIdSchema,
  executedAt: AnalysisPopulationTimestampSchema
}).strict();

export const AnalysisPopulationDrawSchema = AnalysisPopulationDrawBaseSchema.extend({
  selections: z.array(AnalysisPopulationDrawSelectionSchema).min(1).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET)
}).strict().superRefine((value, ctx) => {
  if (value.fixedBudget > value.populationSize) {
    ctx.addIssue({ code: "custom", path: ["fixedBudget"], message: "fixedBudget cannot exceed populationSize" });
  }
  if (
    value.inclusionProbability.numerator !== value.fixedBudget ||
    value.inclusionProbability.denominator !== value.populationSize
  ) {
    ctx.addIssue({ code: "custom", path: ["inclusionProbability"], message: "inclusionProbability must be exact K/N" });
  }
  if (value.selections.length !== value.fixedBudget) {
    ctx.addIssue({ code: "custom", path: ["selections"], message: "selection count must equal fixedBudget" });
  }
  const memberIds = new Set<string>();
  const revisionItemIds = new Set<string>();
  const caseIds = new Set<string>();
  value.selections.forEach((selection, index) => {
    if (selection.position !== index) {
      ctx.addIssue({ code: "custom", path: ["selections", index, "position"], message: "selection positions must be contiguous" });
    }
    if (selection.projectId !== value.projectId || selection.populationId !== value.populationId || selection.drawId !== value.id) {
      ctx.addIssue({ code: "custom", path: ["selections", index], message: "selection owner identity mismatch" });
    }
    for (const [set, value, label] of [
      [memberIds, selection.memberId, "memberId"],
      [revisionItemIds, selection.revisionItemId, "revisionItemId"],
      [caseIds, selection.caseId, "caseId"]
    ] as const) {
      if (set.has(value)) {
        ctx.addIssue({ code: "custom", path: ["selections", index, label], message: `${label} must be unique within the draw` });
      }
      set.add(value);
    }
  });
});
export type AnalysisPopulationDraw = z.infer<typeof AnalysisPopulationDrawSchema>;

export const AnalysisPopulationDrawSummarySchema = AnalysisPopulationDrawBaseSchema.superRefine((value, ctx) => {
  if (value.fixedBudget > value.populationSize) {
    ctx.addIssue({ code: "custom", path: ["fixedBudget"], message: "fixedBudget cannot exceed populationSize" });
  }
  if (
    value.inclusionProbability.numerator !== value.fixedBudget ||
    value.inclusionProbability.denominator !== value.populationSize
  ) {
    ctx.addIssue({ code: "custom", path: ["inclusionProbability"], message: "inclusionProbability must be exact K/N" });
  }
});
export type AnalysisPopulationDrawSummary = z.infer<typeof AnalysisPopulationDrawSummarySchema>;

export const AnalysisPopulationClaimSchema = z.object({
  drawnFromPopulationId: AnalysisPopulationIdSchema,
  representativeOfPopulationId: z.null(),
  representativeReason: z.literal("coding_not_complete")
}).strict();
export type AnalysisPopulationClaim = z.infer<typeof AnalysisPopulationClaimSchema>;

export const AnalysisPopulationOverlapSummarySchema = z.object({
  populationId: AnalysisPopulationIdSchema,
  populationSize: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_MEMBERS),
  overlapCount: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_MEMBERS),
  frameDigest: DatasetEvidenceDigestSchema,
  drawId: AnalysisPopulationIdSchema,
  drawDigest: DatasetEvidenceDigestSchema,
  windowStart: AnalysisPopulationTimestampSchema,
  windowEnd: AnalysisPopulationTimestampSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict().superRefine((value, ctx) => {
  if (value.overlapCount > value.populationSize) {
    ctx.addIssue({ code: "custom", path: ["overlapCount"], message: "overlapCount cannot exceed populationSize" });
  }
});
export type AnalysisPopulationOverlapSummary = z.infer<typeof AnalysisPopulationOverlapSummarySchema>;

const AnalysisPopulationSummaryBaseSchema = z.object({
  population: AnalysisPopulationSchema,
  draw: AnalysisPopulationDrawSummarySchema,
  claim: AnalysisPopulationClaimSchema
}).strict();

function refineAnalysisPopulationSummary(
  value: z.infer<typeof AnalysisPopulationSummaryBaseSchema>,
  ctx: z.RefinementCtx
): void {
  if (
    value.draw.projectId !== value.population.projectId ||
    value.draw.populationId !== value.population.id ||
    value.draw.datasetRevisionId !== value.population.datasetRevisionId
  ) {
    ctx.addIssue({ code: "custom", path: ["draw"], message: "draw must belong to the exact population and revision" });
  }
  if (value.claim.drawnFromPopulationId !== value.population.id) {
    ctx.addIssue({ code: "custom", path: ["claim", "drawnFromPopulationId"], message: "claim must bind the exact population" });
  }
}

export const AnalysisPopulationSummarySchema = AnalysisPopulationSummaryBaseSchema
  .superRefine(refineAnalysisPopulationSummary);
export type AnalysisPopulationSummary = z.infer<typeof AnalysisPopulationSummarySchema>;

export const AnalysisPopulationDetailSchema = AnalysisPopulationSummaryBaseSchema.extend({
  overlapCount: AnalysisPopulationExactCountSchema
}).strict().superRefine(refineAnalysisPopulationSummary);
export type AnalysisPopulationDetail = z.infer<typeof AnalysisPopulationDetailSchema>;

export const AnalysisPopulationMembersPageSchema = z.object({
  items: z.array(AnalysisPopulationMemberSchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: AnalysisPopulationCountSchema,
  nextCursor: AnalysisPopulationCursorSchema
}).strict();
export type AnalysisPopulationMembersPage = z.infer<typeof AnalysisPopulationMembersPageSchema>;

export const AnalysisPopulationExclusionsPageSchema = z.object({
  items: z.array(AnalysisPopulationExclusionSchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: AnalysisPopulationExactCountSchema,
  nextCursor: AnalysisPopulationCursorSchema
}).strict();
export type AnalysisPopulationExclusionsPage = z.infer<typeof AnalysisPopulationExclusionsPageSchema>;

export const AnalysisPopulationOverlapsPageSchema = z.object({
  items: z.array(AnalysisPopulationOverlapSummarySchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: AnalysisPopulationExactCountSchema,
  nextCursor: AnalysisPopulationCursorSchema
}).strict();
export type AnalysisPopulationOverlapsPage = z.infer<typeof AnalysisPopulationOverlapsPageSchema>;

export const AnalysisPopulationSelectedItemsPageSchema = z.object({
  items: z.array(AnalysisPopulationDrawSelectionSchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  nextCursor: AnalysisPopulationCursorSchema
}).strict();
export type AnalysisPopulationSelectedItemsPage = z.infer<typeof AnalysisPopulationSelectedItemsPageSchema>;

export const AnalysisPopulationSummariesPageSchema = z.object({
  items: z.array(AnalysisPopulationSummarySchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: AnalysisPopulationExactCountSchema,
  nextCursor: AnalysisPopulationCursorSchema
}).strict();
export type AnalysisPopulationSummariesPage = z.infer<typeof AnalysisPopulationSummariesPageSchema>;

export const AnalysisPopulationCreateResultSchema = AnalysisPopulationSummaryBaseSchema.extend({
  reusedPopulation: z.boolean(),
  reusedDraw: z.boolean()
}).strict().superRefine((value, ctx) => {
  refineAnalysisPopulationSummary(value, ctx);
  if (value.reusedPopulation !== value.reusedDraw) {
    ctx.addIssue({
      code: "custom",
      path: ["reusedDraw"],
      message: "population and its single draw must be reused together"
    });
  }
});
export type AnalysisPopulationCreateResult = z.infer<typeof AnalysisPopulationCreateResultSchema>;

// Governed analysis study, open coding, flat taxonomy, and exact as-of
// coverage (ADR-0010, Batch 6B-2). Immutable artifacts are named separately
// from their derived head/state projections.
export const ANALYSIS_STUDY_CONTRACT_VERSION = "analysis-study/v1" as const;
export const ANALYSIS_TAXONOMY_CONTRACT_VERSION = "analysis-taxonomy/v1" as const;
export const ANALYSIS_TAXONOMY_COVERAGE_VERSION = "analysis-taxonomy-coverage/v1" as const;
export const ANALYSIS_REPRESENTATIVE_ASSESSMENT_VERSION = "representative-assessment-time/v1" as const;
export const ANALYSIS_MAX_TAXONOMY_CODES = 1_000 as const;
export const ANALYSIS_MAX_TAXONOMY_REVISIONS = 10_000 as const;
export const ANALYSIS_MAX_FAILURE_LABEL_LENGTH = 500 as const;
export const ANALYSIS_MAX_RATIONALE_LENGTH = 5_000 as const;
export const ANALYSIS_MAX_REASON_LENGTH = 2_000 as const;
export const ANALYSIS_MAX_EVENT_VERSION = "9223372036854775807" as const;
export const ANALYSIS_MAX_EXPECTED_EVENT_VERSION = "9223372036854775806" as const;

function isAnalysisEventVersion(value: string): boolean {
  return value.length < ANALYSIS_MAX_EVENT_VERSION.length ||
    (value.length === ANALYSIS_MAX_EVENT_VERSION.length && value <= ANALYSIS_MAX_EVENT_VERSION);
}

const AnalysisEventVersionSchema = AnalysisPopulationExactCountSchema.refine(isAnalysisEventVersion, {
  message: "must fit the PostgreSQL bigint event-version domain"
});
const AnalysisPositiveEventVersionSchema = z.string().regex(/^[1-9][0-9]*$/)
  .refine(isAnalysisEventVersion, { message: "must fit the PostgreSQL bigint event-version domain" });
const AnalysisExpectedEventVersionSchema = AnalysisPopulationExactCountSchema.refine(
  (value) => value.length < ANALYSIS_MAX_EXPECTED_EVENT_VERSION.length ||
    (value.length === ANALYSIS_MAX_EXPECTED_EVENT_VERSION.length && value <= ANALYSIS_MAX_EXPECTED_EVENT_VERSION),
  { message: "must leave room for a successor in the PostgreSQL bigint event-version domain" }
);
const AnalysisCanonicalText = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => value.trim().length > 0, { message: "must contain non-whitespace content" })
  .refine((value) => value === value.trim(), { message: "must not have leading or trailing whitespace" });
const AnalysisIdempotencyKeySchema = AnalysisCanonicalText(240);
const AnalysisCommandIdempotencyKeySchema = AnalysisIdempotencyKeySchema.refine(
  (value) => !value.startsWith("analysis-deadline-close_"),
  { message: "is reserved for database-owned deadline closure" }
);

export const AnalysisStudyStateSchema = z.enum([
  "draft", "coding_open", "coding_closed", "completed", "abandoned"
]);
export type AnalysisStudyState = z.infer<typeof AnalysisStudyStateSchema>;

export const AnalysisStudyItemStateSchema = z.enum(["uncoded", "in_progress", "completed"]);
export type AnalysisStudyItemState = z.infer<typeof AnalysisStudyItemStateSchema>;

export const AnalysisStudyStoppingRuleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("server_deadline"),
    closeAt: AnalysisPopulationRequestTimestampSchema
  }).strict(),
  z.object({
    kind: z.literal("explicit_owner_close"),
    closeAt: z.null()
  }).strict()
]);
export type AnalysisStudyStoppingRule = z.infer<typeof AnalysisStudyStoppingRuleSchema>;

export const AnalysisEvidenceAnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("case_output") }).strict(),
  z.object({
    kind: z.literal("step"),
    stepIndex: z.number().int().min(0).max(MAX_TRACE_STEPS - 1)
  }).strict()
]);
export type AnalysisEvidenceAnchor = z.infer<typeof AnalysisEvidenceAnchorSchema>;

export const AnalysisStudyCreateInputSchema = z.object({
  populationId: AnalysisPopulationIdSchema,
  idempotencyKey: AnalysisCommandIdempotencyKeySchema
}).strict();
export type AnalysisStudyCreateInput = z.infer<typeof AnalysisStudyCreateInputSchema>;

export const AnalysisStudyOpenInputSchema = z.object({
  expectedVersion: AnalysisExpectedEventVersionSchema,
  stoppingRule: AnalysisStudyStoppingRuleSchema,
  idempotencyKey: AnalysisCommandIdempotencyKeySchema
}).strict();
export type AnalysisStudyOpenInput = z.infer<typeof AnalysisStudyOpenInputSchema>;

export const AnalysisStudyCloseInputSchema = z.object({
  expectedVersion: AnalysisExpectedEventVersionSchema,
  reason: AnalysisCanonicalText(ANALYSIS_MAX_REASON_LENGTH),
  idempotencyKey: AnalysisCommandIdempotencyKeySchema
}).strict();
export type AnalysisStudyCloseInput = z.infer<typeof AnalysisStudyCloseInputSchema>;

export const AnalysisStudyCompleteInputSchema = z.object({
  expectedVersion: AnalysisExpectedEventVersionSchema,
  expectedClosureDigest: DatasetEvidenceDigestSchema,
  idempotencyKey: AnalysisCommandIdempotencyKeySchema
}).strict();
export type AnalysisStudyCompleteInput = z.infer<typeof AnalysisStudyCompleteInputSchema>;

export const AnalysisStudyAbandonInputSchema = z.object({
  expectedVersion: AnalysisExpectedEventVersionSchema,
  reason: AnalysisCanonicalText(ANALYSIS_MAX_REASON_LENGTH),
  idempotencyKey: AnalysisCommandIdempotencyKeySchema
}).strict();
export type AnalysisStudyAbandonInput = z.infer<typeof AnalysisStudyAbandonInputSchema>;

export const AnalysisStudyArtifactSchema = z.object({
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  populationId: AnalysisPopulationIdSchema,
  drawId: AnalysisPopulationIdSchema,
  datasetRevisionId: AnalysisPopulationIdSchema,
  contractVersion: z.literal(ANALYSIS_STUDY_CONTRACT_VERSION),
  idempotencyKey: AnalysisIdempotencyKeySchema,
  requestDigest: DatasetEvidenceDigestSchema,
  contentDigest: DatasetEvidenceDigestSchema,
  createdByUserId: AnalysisPopulationIdSchema,
  createdBySubjectId: AnalysisPopulationIdSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict();
export type AnalysisStudyArtifact = z.infer<typeof AnalysisStudyArtifactSchema>;

export const AnalysisStudyItemArtifactSchema = z.object({
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  studyId: AnalysisPopulationIdSchema,
  drawItemId: AnalysisPopulationIdSchema,
  memberId: AnalysisPopulationIdSchema,
  revisionItemId: AnalysisPopulationIdSchema,
  caseId: AnalysisPopulationIdSchema,
  position: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET - 1),
  contentDigest: DatasetEvidenceDigestSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict();
export type AnalysisStudyItemArtifact = z.infer<typeof AnalysisStudyItemArtifactSchema>;

export const AnalysisStudyEventTypeSchema = z.enum([
  "coding_opened", "coding_closed", "study_completed", "study_abandoned"
]);
export type AnalysisStudyEventType = z.infer<typeof AnalysisStudyEventTypeSchema>;

const AnalysisStudyEventCommonShape = {
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  studyId: AnalysisPopulationIdSchema,
  version: AnalysisPositiveEventVersionSchema,
  predecessorEventId: AnalysisPopulationIdSchema.nullable(),
  predecessorEventDigest: DatasetEvidenceDigestSchema.nullable(),
  actorUserId: AnalysisPopulationIdSchema.nullable(),
  actorSubjectId: AnalysisPopulationIdSchema.nullable(),
  actorRole: z.enum(["owner", "system"]),
  idempotencyKey: AnalysisIdempotencyKeySchema,
  requestDigest: DatasetEvidenceDigestSchema,
  eventDigest: DatasetEvidenceDigestSchema,
  occurredAt: AnalysisPopulationTimestampSchema
} as const;

export const AnalysisStudyEventArtifactSchema = z.discriminatedUnion("eventType", [
  z.object({
    ...AnalysisStudyEventCommonShape,
    eventType: z.literal("coding_opened"),
    fromState: z.literal("draft"),
    toState: z.literal("coding_open"),
    stoppingRule: AnalysisStudyStoppingRuleSchema,
    closeCause: z.null(),
    closureId: z.null(), closureDigest: z.null(), expectedClosureDigest: z.null(), reason: z.null()
  }).strict(),
  z.object({
    ...AnalysisStudyEventCommonShape,
    eventType: z.literal("coding_closed"),
    fromState: z.literal("coding_open"),
    toState: z.literal("coding_closed"),
    stoppingRule: z.null(),
    closeCause: z.enum(["server_deadline", "explicit_owner_close"]),
    closureId: AnalysisPopulationIdSchema,
    closureDigest: DatasetEvidenceDigestSchema,
    expectedClosureDigest: z.null(),
    reason: AnalysisCanonicalText(ANALYSIS_MAX_REASON_LENGTH).nullable()
  }).strict(),
  z.object({
    ...AnalysisStudyEventCommonShape,
    eventType: z.literal("study_completed"),
    fromState: z.literal("coding_closed"),
    toState: z.literal("completed"),
    stoppingRule: z.null(), closeCause: z.null(), closureId: z.null(), closureDigest: z.null(),
    expectedClosureDigest: DatasetEvidenceDigestSchema,
    reason: z.null()
  }).strict(),
  z.object({
    ...AnalysisStudyEventCommonShape,
    eventType: z.literal("study_abandoned"),
    fromState: z.enum(["draft", "coding_open"]),
    toState: z.literal("abandoned"),
    stoppingRule: z.null(), closeCause: z.null(), closureId: z.null(), closureDigest: z.null(), expectedClosureDigest: z.null(),
    reason: AnalysisCanonicalText(ANALYSIS_MAX_REASON_LENGTH)
  }).strict()
]).superRefine((value, ctx) => {
  refineAnalysisEventPredecessor(value.version, value.predecessorEventId, value.predecessorEventDigest, ctx);
  if (value.eventType === "coding_closed" && value.closeCause === "server_deadline") {
    if (value.actorUserId !== null || value.actorSubjectId !== null || value.actorRole !== "system" || value.reason !== null) {
      ctx.addIssue({ code: "custom", path: ["actorRole"], message: "deadline close requires reasonless system actor" });
    }
  } else if (value.actorUserId === null || value.actorSubjectId === null || value.actorRole !== "owner") {
    ctx.addIssue({ code: "custom", path: ["actorRole"], message: "study administration requires durable owner actor" });
  }
  if (value.eventType === "coding_closed" && value.closeCause === "explicit_owner_close" && value.reason === null) {
    ctx.addIssue({ code: "custom", path: ["reason"], message: "owner close requires reason" });
  }
});
export type AnalysisStudyEventArtifact = z.infer<typeof AnalysisStudyEventArtifactSchema>;

export const AnalysisStudyProjectionSchema = z.object({
  study: AnalysisStudyArtifactSchema,
  state: AnalysisStudyStateSchema,
  currentVersion: AnalysisEventVersionSchema,
  currentEventId: AnalysisPopulationIdSchema.nullable(),
  currentEventDigest: DatasetEvidenceDigestSchema.nullable(),
  stoppingRule: AnalysisStudyStoppingRuleSchema.nullable(),
  closureId: AnalysisPopulationIdSchema.nullable(),
  closureDigest: DatasetEvidenceDigestSchema.nullable()
}).strict().superRefine((value, ctx) => {
  const zero = value.currentVersion === "0";
  if (zero !== (value.currentEventId === null && value.currentEventDigest === null)) {
    ctx.addIssue({ code: "custom", path: ["currentVersion"], message: "version zero must have no event head" });
  }
  if ((value.currentEventId === null) !== (value.currentEventDigest === null)) {
    ctx.addIssue({ code: "custom", path: ["currentEventId"], message: "event head ID and digest must be present together" });
  }
  const hasClosure = value.closureId !== null && value.closureDigest !== null;
  if ((value.closureId === null) !== (value.closureDigest === null)) {
    ctx.addIssue({ code: "custom", path: ["closureId"], message: "closure ID and digest must be present together" });
  }
  if (value.state === "draft" && (!zero || value.stoppingRule !== null || hasClosure)) {
    ctx.addIssue({ code: "custom", path: ["state"], message: "draft has no events, stopping rule, or closure" });
  }
  if (value.state === "coding_open" && (value.stoppingRule === null || hasClosure)) {
    ctx.addIssue({ code: "custom", path: ["state"], message: "open coding requires its frozen stopping rule and no closure" });
  }
  if (["coding_closed", "completed"].includes(value.state) && (value.stoppingRule === null || !hasClosure)) {
    ctx.addIssue({ code: "custom", path: ["state"], message: "closed/completed study requires stopping and closure evidence" });
  }
  if (value.state === "abandoned" && hasClosure) {
    ctx.addIssue({ code: "custom", path: ["state"], message: "abandoned study cannot have closure evidence" });
  }
});
export type AnalysisStudyProjection = z.infer<typeof AnalysisStudyProjectionSchema>;

export const AnalysisStudyItemEventTypeSchema = z.enum([
  "failure_observed", "failure_withdrawn", "no_failure_observed",
  "no_failure_withdrawn", "coding_completed", "coding_reopened"
]);
export type AnalysisStudyItemEventType = z.infer<typeof AnalysisStudyItemEventTypeSchema>;

const AnalysisStudyItemEventRequestBase = {
  expectedVersion: AnalysisExpectedEventVersionSchema,
  idempotencyKey: AnalysisCommandIdempotencyKeySchema
} as const;
export const AnalysisStudyItemEventInputSchema = z.discriminatedUnion("eventType", [
  z.object({ ...AnalysisStudyItemEventRequestBase, eventType: z.literal("failure_observed"),
    failureLabel: AnalysisCanonicalText(ANALYSIS_MAX_FAILURE_LABEL_LENGTH),
    rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
    evidenceAnchor: AnalysisEvidenceAnchorSchema }).strict(),
  z.object({ ...AnalysisStudyItemEventRequestBase, eventType: z.literal("failure_withdrawn"),
    targetEventId: AnalysisPopulationIdSchema, targetEventDigest: DatasetEvidenceDigestSchema,
    rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH) }).strict(),
  z.object({ ...AnalysisStudyItemEventRequestBase, eventType: z.literal("no_failure_observed"),
    rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH) }).strict(),
  z.object({ ...AnalysisStudyItemEventRequestBase, eventType: z.literal("no_failure_withdrawn"),
    targetEventId: AnalysisPopulationIdSchema, targetEventDigest: DatasetEvidenceDigestSchema,
    rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH) }).strict(),
  z.object({ ...AnalysisStudyItemEventRequestBase, eventType: z.literal("coding_completed") }).strict(),
  z.object({ ...AnalysisStudyItemEventRequestBase, eventType: z.literal("coding_reopened"),
    targetEventId: AnalysisPopulationIdSchema, targetEventDigest: DatasetEvidenceDigestSchema,
    rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH) }).strict()
]);
export type AnalysisStudyItemEventInput = z.infer<typeof AnalysisStudyItemEventInputSchema>;

const AnalysisStudyItemEventArtifactCommonShape = {
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  studyId: AnalysisPopulationIdSchema,
  studyItemId: AnalysisPopulationIdSchema,
  version: AnalysisPositiveEventVersionSchema,
  predecessorEventId: AnalysisPopulationIdSchema.nullable(),
  predecessorEventDigest: DatasetEvidenceDigestSchema.nullable(),
  actorUserId: AnalysisPopulationIdSchema,
  actorSubjectId: AnalysisPopulationIdSchema,
  actorRole: z.enum(["owner", "member"]),
  idempotencyKey: AnalysisIdempotencyKeySchema,
  requestDigest: DatasetEvidenceDigestSchema,
  eventDigest: DatasetEvidenceDigestSchema,
  occurredAt: AnalysisPopulationTimestampSchema
} as const;
export const AnalysisStudyItemEventArtifactSchema = z.discriminatedUnion("eventType", [
  z.object({ ...AnalysisStudyItemEventArtifactCommonShape, eventType: z.literal("failure_observed"),
    failureLabel: AnalysisCanonicalText(ANALYSIS_MAX_FAILURE_LABEL_LENGTH),
    rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH), evidenceAnchor: AnalysisEvidenceAnchorSchema }).strict(),
  z.object({ ...AnalysisStudyItemEventArtifactCommonShape, eventType: z.literal("failure_withdrawn"),
    targetEventId: AnalysisPopulationIdSchema, targetEventDigest: DatasetEvidenceDigestSchema,
    rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH) }).strict(),
  z.object({ ...AnalysisStudyItemEventArtifactCommonShape, eventType: z.literal("no_failure_observed"),
    rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH) }).strict(),
  z.object({ ...AnalysisStudyItemEventArtifactCommonShape, eventType: z.literal("no_failure_withdrawn"),
    targetEventId: AnalysisPopulationIdSchema, targetEventDigest: DatasetEvidenceDigestSchema,
    rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH) }).strict(),
  z.object({ ...AnalysisStudyItemEventArtifactCommonShape, eventType: z.literal("coding_completed") }).strict(),
  z.object({ ...AnalysisStudyItemEventArtifactCommonShape, eventType: z.literal("coding_reopened"),
    targetEventId: AnalysisPopulationIdSchema, targetEventDigest: DatasetEvidenceDigestSchema,
    rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH) }).strict()
]).superRefine((value, ctx) => {
  refineAnalysisEventPredecessor(value.version, value.predecessorEventId, value.predecessorEventDigest, ctx);
});
export type AnalysisStudyItemEventArtifact = z.infer<typeof AnalysisStudyItemEventArtifactSchema>;

export const AnalysisStudyItemProjectionSchema = z.object({
  item: AnalysisStudyItemArtifactSchema,
  state: AnalysisStudyItemStateSchema,
  currentVersion: AnalysisEventVersionSchema,
  currentEventId: AnalysisPopulationIdSchema.nullable(),
  currentEventDigest: DatasetEvidenceDigestSchema.nullable(),
  viewEventIds: z.array(AnalysisPopulationIdSchema),
  viewEventDigests: z.array(DatasetEvidenceDigestSchema),
  activeFailureObservationEventIds: z.array(AnalysisPopulationIdSchema),
  activeFailureObservationEventDigests: z.array(DatasetEvidenceDigestSchema),
  activeFailureAssignmentEventIds: z.array(AnalysisPopulationIdSchema.nullable()),
  activeFailureAssignmentEventDigests: z.array(DatasetEvidenceDigestSchema.nullable()),
  activeNoFailureEventId: AnalysisPopulationIdSchema.nullable(),
  activeNoFailureEventDigest: DatasetEvidenceDigestSchema.nullable(),
  completionEventId: AnalysisPopulationIdSchema.nullable(),
  completionEventDigest: DatasetEvidenceDigestSchema.nullable()
}).strict().superRefine(refineAnalysisStudyItemProjection);
export type AnalysisStudyItemProjection = z.infer<typeof AnalysisStudyItemProjectionSchema>;

export const AnalysisRepresentativeReasonSchema = z.enum([
  "method_not_eligible", "frame_not_reproducible", "draw_not_complete", "coding_not_complete"
]);
export type AnalysisRepresentativeReason = z.infer<typeof AnalysisRepresentativeReasonSchema>;

export const AnalysisStudyClosureItemArtifactSchema = z.object({
  id: AnalysisPopulationIdSchema, projectId: AnalysisPopulationIdSchema,
  closureId: AnalysisPopulationIdSchema, studyId: AnalysisPopulationIdSchema,
  studyItemId: AnalysisPopulationIdSchema, drawItemId: AnalysisPopulationIdSchema,
  caseId: AnalysisPopulationIdSchema,
  position: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET - 1),
  itemState: AnalysisStudyItemStateSchema,
  itemEventVersion: AnalysisEventVersionSchema,
  currentEventId: AnalysisPopulationIdSchema.nullable(),
  currentEventDigest: DatasetEvidenceDigestSchema.nullable(),
  viewEventIds: z.array(AnalysisPopulationIdSchema),
  viewEventDigests: z.array(DatasetEvidenceDigestSchema),
  activeFailureObservationEventIds: z.array(AnalysisPopulationIdSchema),
  activeFailureObservationEventDigests: z.array(DatasetEvidenceDigestSchema),
  activeFailureAssignmentEventIds: z.array(AnalysisPopulationIdSchema.nullable()),
  activeFailureAssignmentEventDigests: z.array(DatasetEvidenceDigestSchema.nullable()),
  activeNoFailureEventId: AnalysisPopulationIdSchema.nullable(),
  activeNoFailureEventDigest: DatasetEvidenceDigestSchema.nullable(),
  completionEventId: AnalysisPopulationIdSchema.nullable(),
  completionEventDigest: DatasetEvidenceDigestSchema.nullable(),
  contentDigest: DatasetEvidenceDigestSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict().superRefine((value, ctx) => {
  refineAnalysisItemEvidence(value, ctx, ["itemState"]);
});
export type AnalysisStudyClosureItemArtifact = z.infer<typeof AnalysisStudyClosureItemArtifactSchema>;

export const AnalysisStudyClosureArtifactSchema = z.object({
  id: AnalysisPopulationIdSchema, projectId: AnalysisPopulationIdSchema,
  studyId: AnalysisPopulationIdSchema, populationId: AnalysisPopulationIdSchema,
  drawId: AnalysisPopulationIdSchema, datasetRevisionId: AnalysisPopulationIdSchema,
  stoppingRule: AnalysisStudyStoppingRuleSchema,
  closeCause: z.enum(["server_deadline", "explicit_owner_close"]),
  closeActorUserId: AnalysisPopulationIdSchema.nullable(),
  closeActorSubjectId: AnalysisPopulationIdSchema.nullable(),
  closeActorRole: z.enum(["owner", "system"]),
  closeReason: AnalysisCanonicalText(ANALYSIS_MAX_REASON_LENGTH).nullable(),
  effectiveClosedAt: AnalysisPopulationTimestampSchema,
  recordedAt: AnalysisPopulationTimestampSchema,
  selectedItemCount: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  viewedItemCount: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  completedItemCount: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  viewSetDigest: DatasetEvidenceDigestSchema,
  assessmentVersion: z.literal(ANALYSIS_REPRESENTATIVE_ASSESSMENT_VERSION),
  method: z.string().min(1).max(100),
  frozenFrameDigest: DatasetEvidenceDigestSchema,
  recomputedFrameDigest: DatasetEvidenceDigestSchema.nullable(),
  frozenDrawDigest: DatasetEvidenceDigestSchema,
  recomputedDrawDigest: DatasetEvidenceDigestSchema.nullable(),
  methodEligible: z.boolean(), frameReproducible: z.boolean(), drawComplete: z.boolean(), codingComplete: z.boolean(),
  closureItemCount: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  drawnFromPopulationId: AnalysisPopulationIdSchema,
  representativeOfPopulationId: AnalysisPopulationIdSchema.nullable(),
  representativeReason: AnalysisRepresentativeReasonSchema.nullable(),
  assessmentDigest: DatasetEvidenceDigestSchema,
  contentDigest: DatasetEvidenceDigestSchema,
  closureDigest: DatasetEvidenceDigestSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict().superRefine((value, ctx) => {
  if (value.viewedItemCount > value.selectedItemCount || value.completedItemCount > value.selectedItemCount ||
      value.closureItemCount !== value.selectedItemCount) {
    ctx.addIssue({ code: "custom", path: ["selectedItemCount"], message: "viewed/completed/closure counts cannot exceed selected" });
  }
  const frameReproducible = value.recomputedFrameDigest !== null && value.frozenFrameDigest === value.recomputedFrameDigest;
  const drawComplete = value.recomputedDrawDigest !== null && value.frozenDrawDigest === value.recomputedDrawDigest;
  const codingComplete = drawComplete && value.completedItemCount === value.selectedItemCount;
  if (value.frameReproducible !== frameReproducible || value.drawComplete !== drawComplete || value.codingComplete !== codingComplete) {
    ctx.addIssue({ code: "custom", path: ["assessmentDigest"], message: "assessment booleans must match immutable derivation inputs" });
  }
  if (value.methodEligible !== (value.method === "simple_random")) {
    ctx.addIssue({ code: "custom", path: ["methodEligible"], message: "v1 only admits simple_random" });
  }
  const expectedReason: AnalysisRepresentativeReason | null = !value.methodEligible ? "method_not_eligible"
    : !value.frameReproducible ? "frame_not_reproducible"
      : !value.drawComplete ? "draw_not_complete"
        : !value.codingComplete ? "coding_not_complete" : null;
  if (value.drawnFromPopulationId !== value.populationId || value.representativeReason !== expectedReason ||
      value.representativeOfPopulationId !== (expectedReason === null ? value.populationId : null)) {
    ctx.addIssue({ code: "custom", path: ["representativeReason"], message: "representative claim must follow the closed precedence" });
  }
  const effective = Date.parse(value.effectiveClosedAt);
  const recorded = Date.parse(value.recordedAt);
  if (recorded < effective) ctx.addIssue({ code: "custom", path: ["recordedAt"], message: "recordedAt cannot precede effective close" });
  if (value.closeCause !== value.stoppingRule.kind) {
    ctx.addIssue({ code: "custom", path: ["closeCause"], message: "close cause must match stopping rule" });
  } else if (value.closeCause === "server_deadline") {
    if (value.closeActorUserId !== null || value.closeActorSubjectId !== null || value.closeActorRole !== "system" ||
        value.closeReason !== null || value.stoppingRule.closeAt !== normalizeAnalysisSharedTimestamp(value.effectiveClosedAt)) {
      ctx.addIssue({ code: "custom", path: ["closeActorRole"], message: "deadline close must freeze effective closeAt with a reasonless system actor" });
    }
  } else if (value.closeActorUserId === null || value.closeActorSubjectId === null || value.closeActorRole !== "owner" || value.closeReason === null || effective !== recorded) {
    ctx.addIssue({ code: "custom", path: ["closeActorRole"], message: "explicit close requires owner evidence and effective recorded time" });
  }
});
export type AnalysisStudyClosureArtifact = z.infer<typeof AnalysisStudyClosureArtifactSchema>;

export const AnalysisStudyItemViewArtifactSchema = z.object({
  id: AnalysisPopulationIdSchema, projectId: AnalysisPopulationIdSchema,
  studyId: AnalysisPopulationIdSchema, studyItemId: AnalysisPopulationIdSchema,
  viewerUserId: AnalysisPopulationIdSchema, viewerSubjectId: AnalysisPopulationIdSchema,
  datasetExposureEventId: AnalysisPopulationIdSchema,
  countsTowardClosure: z.boolean(),
  idempotencyKey: AnalysisIdempotencyKeySchema,
  requestDigest: DatasetEvidenceDigestSchema, contentDigest: DatasetEvidenceDigestSchema,
  viewedAt: AnalysisPopulationTimestampSchema
}).strict();
export type AnalysisStudyItemViewArtifact = z.infer<typeof AnalysisStudyItemViewArtifactSchema>;

export const AnalysisFailureTaxonomyArtifactSchema = z.object({
  id: AnalysisPopulationIdSchema, projectId: AnalysisPopulationIdSchema,
  contractVersion: z.literal(ANALYSIS_TAXONOMY_CONTRACT_VERSION),
  name: AnalysisCanonicalText(240),
  description: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  idempotencyKey: AnalysisIdempotencyKeySchema,
  requestDigest: DatasetEvidenceDigestSchema,
  contentDigest: DatasetEvidenceDigestSchema,
  createdByUserId: AnalysisPopulationIdSchema, createdBySubjectId: AnalysisPopulationIdSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict();
export type AnalysisFailureTaxonomyArtifact = z.infer<typeof AnalysisFailureTaxonomyArtifactSchema>;

export const AnalysisFailureCodeArtifactSchema = z.object({
  id: AnalysisPopulationIdSchema, projectId: AnalysisPopulationIdSchema,
  taxonomyId: AnalysisPopulationIdSchema,
  createdInRevisionId: AnalysisPopulationIdSchema,
  contentDigest: DatasetEvidenceDigestSchema,
  createdByUserId: AnalysisPopulationIdSchema, createdBySubjectId: AnalysisPopulationIdSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict();
export type AnalysisFailureCodeArtifact = z.infer<typeof AnalysisFailureCodeArtifactSchema>;

export const AnalysisTaxonomyCodeStatusSchema = z.enum(["active", "retired"]);
export type AnalysisTaxonomyCodeStatus = z.infer<typeof AnalysisTaxonomyCodeStatusSchema>;

export const AnalysisTaxonomyRevisionCodeArtifactSchema = z.object({
  id: AnalysisPopulationIdSchema, projectId: AnalysisPopulationIdSchema,
  taxonomyId: AnalysisPopulationIdSchema, taxonomyRevisionId: AnalysisPopulationIdSchema,
  codeId: AnalysisPopulationIdSchema,
  position: z.number().int().min(0).max(ANALYSIS_MAX_TAXONOMY_CODES - 1),
  label: AnalysisCanonicalText(ANALYSIS_MAX_FAILURE_LABEL_LENGTH),
  definition: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  status: AnalysisTaxonomyCodeStatusSchema,
  entryDigest: DatasetEvidenceDigestSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict();
export type AnalysisTaxonomyRevisionCodeArtifact = z.infer<typeof AnalysisTaxonomyRevisionCodeArtifactSchema>;

export const AnalysisTaxonomyRevisionArtifactSchema = z.object({
  id: AnalysisPopulationIdSchema, projectId: AnalysisPopulationIdSchema,
  taxonomyId: AnalysisPopulationIdSchema,
  sequence: z.number().int().min(1).max(ANALYSIS_MAX_TAXONOMY_REVISIONS),
  predecessorRevisionId: AnalysisPopulationIdSchema.nullable(),
  predecessorRevisionDigest: DatasetEvidenceDigestSchema.nullable(),
  reason: AnalysisCanonicalText(ANALYSIS_MAX_REASON_LENGTH),
  codeCount: z.number().int().min(1).max(ANALYSIS_MAX_TAXONOMY_CODES),
  contentDigest: DatasetEvidenceDigestSchema, revisionDigest: DatasetEvidenceDigestSchema,
  createdByUserId: AnalysisPopulationIdSchema, createdBySubjectId: AnalysisPopulationIdSchema,
  idempotencyKey: AnalysisIdempotencyKeySchema, requestDigest: DatasetEvidenceDigestSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict();
export type AnalysisTaxonomyRevisionArtifact = z.infer<typeof AnalysisTaxonomyRevisionArtifactSchema>;

export const AnalysisTaxonomyRevisionProjectionSchema = z.object({
  revision: AnalysisTaxonomyRevisionArtifactSchema,
  codes: z.array(AnalysisTaxonomyRevisionCodeArtifactSchema).min(1).max(ANALYSIS_MAX_TAXONOMY_CODES)
}).strict().superRefine((value, ctx) => {
  if (value.codes.length !== value.revision.codeCount) {
    ctx.addIssue({ code: "custom", path: ["codes"], message: "codes must match revision codeCount" });
  }
  const ids = new Set<string>();
  const labels = new Set<string>();
  value.codes.forEach((code, index) => {
    if (code.projectId !== value.revision.projectId || code.taxonomyId !== value.revision.taxonomyId ||
        code.taxonomyRevisionId !== value.revision.id || code.position !== index || ids.has(code.codeId)) {
      ctx.addIssue({ code: "custom", path: ["codes", index], message: "revision code owner, identity, and position must be exact" });
    }
    ids.add(code.codeId);
    if (code.status === "active" && labels.has(code.label)) {
      ctx.addIssue({ code: "custom", path: ["codes", index, "label"], message: "active labels must be exact-string unique" });
    }
    if (code.status === "active") labels.add(code.label);
  });
});
export type AnalysisTaxonomyRevisionProjection = z.infer<typeof AnalysisTaxonomyRevisionProjectionSchema>;

const AnalysisAssignmentEventCommonShape = {
  id: AnalysisPopulationIdSchema, projectId: AnalysisPopulationIdSchema,
  taxonomyId: AnalysisPopulationIdSchema, taxonomyRevisionId: AnalysisPopulationIdSchema,
  taxonomyRevisionSequence: z.number().int().min(1).max(ANALYSIS_MAX_TAXONOMY_REVISIONS),
  studyId: AnalysisPopulationIdSchema, studyItemId: AnalysisPopulationIdSchema,
  observationEventId: AnalysisPopulationIdSchema,
  version: AnalysisPositiveEventVersionSchema,
  predecessorEventId: AnalysisPopulationIdSchema.nullable(),
  predecessorEventDigest: DatasetEvidenceDigestSchema.nullable(),
  rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  actorUserId: AnalysisPopulationIdSchema, actorSubjectId: AnalysisPopulationIdSchema,
  actorRole: z.enum(["owner", "member"]),
  idempotencyKey: AnalysisIdempotencyKeySchema, requestDigest: DatasetEvidenceDigestSchema,
  eventDigest: DatasetEvidenceDigestSchema, occurredAt: AnalysisPopulationTimestampSchema
} as const;
export const AnalysisObservationAssignmentEventArtifactSchema = z.discriminatedUnion("eventType", [
  z.object({ ...AnalysisAssignmentEventCommonShape, eventType: z.literal("assigned"), codeId: AnalysisPopulationIdSchema }).strict(),
  z.object({ ...AnalysisAssignmentEventCommonShape, eventType: z.literal("withdrawn"), codeId: z.null() }).strict()
]).superRefine((value, ctx) => {
  refineAnalysisEventPredecessor(value.version, value.predecessorEventId, value.predecessorEventDigest, ctx);
});
export type AnalysisObservationAssignmentEventArtifact = z.infer<typeof AnalysisObservationAssignmentEventArtifactSchema>;

export const AnalysisTaxonomyCoverageSchema = z.object({
  projectId: AnalysisPopulationIdSchema, studyId: AnalysisPopulationIdSchema, taxonomyId: AnalysisPopulationIdSchema,
  taxonomyRevisionId: AnalysisPopulationIdSchema,
  taxonomyRevisionSequence: z.number().int().min(1).max(ANALYSIS_MAX_TAXONOMY_REVISIONS),
  calculationVersion: z.literal(ANALYSIS_TAXONOMY_COVERAGE_VERSION),
  selectedItemCount: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  completedItemCount: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  noFailureObservedItemCount: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  activeFailureObservationCount: AnalysisPopulationExactCountSchema,
  categorized: AnalysisPopulationExactCountSchema,
  assignedToRetiredCode: AnalysisPopulationExactCountSchema,
  uncategorized: AnalysisPopulationExactCountSchema,
  categorizedItemCount: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  assignedToRetiredCodeItemCount: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  uncategorizedItemCount: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET)
}).strict().superRefine((value, ctx) => {
  if (value.completedItemCount > value.selectedItemCount || value.noFailureObservedItemCount > value.selectedItemCount ||
      value.categorizedItemCount > value.selectedItemCount || value.assignedToRetiredCodeItemCount > value.selectedItemCount ||
      value.uncategorizedItemCount > value.selectedItemCount) {
    ctx.addIssue({ code: "custom", path: ["selectedItemCount"], message: "item counts cannot exceed selected" });
  }
  if (BigInt(value.categorized) + BigInt(value.assignedToRetiredCode) + BigInt(value.uncategorized) !== BigInt(value.activeFailureObservationCount)) {
    ctx.addIssue({ code: "custom", path: ["activeFailureObservationCount"], message: "taxonomy buckets must conserve active failure observations" });
  }
});
export type AnalysisTaxonomyCoverage = z.infer<typeof AnalysisTaxonomyCoverageSchema>;

export const AnalysisTaxonomyNewCodeInputSchema = z.object({
  kind: z.literal("new"),
  clientToken: AnalysisCanonicalText(120),
  label: AnalysisCanonicalText(ANALYSIS_MAX_FAILURE_LABEL_LENGTH),
  definition: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH)
}).strict();
export type AnalysisTaxonomyNewCodeInput = z.infer<typeof AnalysisTaxonomyNewCodeInputSchema>;

export const AnalysisTaxonomyExistingCodeInputSchema = z.object({
  kind: z.literal("existing"),
  codeId: AnalysisPopulationIdSchema,
  label: AnalysisCanonicalText(ANALYSIS_MAX_FAILURE_LABEL_LENGTH),
  definition: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  status: AnalysisTaxonomyCodeStatusSchema
}).strict();
export type AnalysisTaxonomyExistingCodeInput = z.infer<typeof AnalysisTaxonomyExistingCodeInputSchema>;

export const AnalysisTaxonomyRevisionCodeInputSchema = z.discriminatedUnion("kind", [
  AnalysisTaxonomyNewCodeInputSchema,
  AnalysisTaxonomyExistingCodeInputSchema
]);
export type AnalysisTaxonomyRevisionCodeInput = z.infer<typeof AnalysisTaxonomyRevisionCodeInputSchema>;

export const AnalysisFailureTaxonomyCreateInputSchema = z.object({
  name: AnalysisCanonicalText(240),
  description: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  reason: AnalysisCanonicalText(ANALYSIS_MAX_REASON_LENGTH),
  codes: z.array(AnalysisTaxonomyNewCodeInputSchema).min(1).max(ANALYSIS_MAX_TAXONOMY_CODES),
  idempotencyKey: AnalysisCommandIdempotencyKeySchema
}).strict().superRefine((value, ctx) => refineAnalysisTaxonomyCommandCodes(value.codes, ctx));
export type AnalysisFailureTaxonomyCreateInput = z.infer<typeof AnalysisFailureTaxonomyCreateInputSchema>;

export const AnalysisTaxonomyRevisionCreateInputSchema = z.object({
  expectedPredecessorRevisionId: AnalysisPopulationIdSchema,
  expectedPredecessorRevisionDigest: DatasetEvidenceDigestSchema,
  expectedPredecessorSequence: z.number().int().min(1).max(ANALYSIS_MAX_TAXONOMY_REVISIONS - 1),
  reason: AnalysisCanonicalText(ANALYSIS_MAX_REASON_LENGTH),
  codes: z.array(AnalysisTaxonomyRevisionCodeInputSchema).min(1).max(ANALYSIS_MAX_TAXONOMY_CODES),
  idempotencyKey: AnalysisCommandIdempotencyKeySchema
}).strict().superRefine((value, ctx) => refineAnalysisTaxonomyCommandCodes(value.codes, ctx));
export type AnalysisTaxonomyRevisionCreateInput = z.infer<typeof AnalysisTaxonomyRevisionCreateInputSchema>;

const AnalysisAssignmentInputCommonShape = {
  observationEventId: AnalysisPopulationIdSchema,
  taxonomyRevisionId: AnalysisPopulationIdSchema,
  expectedVersion: AnalysisExpectedEventVersionSchema,
  expectedPredecessorEventId: AnalysisPopulationIdSchema.nullable(),
  expectedPredecessorEventDigest: DatasetEvidenceDigestSchema.nullable(),
  rationale: AnalysisCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  idempotencyKey: AnalysisCommandIdempotencyKeySchema
} as const;
export const AnalysisObservationAssignmentEventInputSchema = z.discriminatedUnion("eventType", [
  z.object({ ...AnalysisAssignmentInputCommonShape, eventType: z.literal("assigned"), codeId: AnalysisPopulationIdSchema }).strict(),
  z.object({ ...AnalysisAssignmentInputCommonShape, eventType: z.literal("withdrawn"), codeId: z.null() }).strict()
]).superRefine((value, ctx) => {
  const zero = value.expectedVersion === "0";
  const noPredecessor = value.expectedPredecessorEventId === null && value.expectedPredecessorEventDigest === null;
  if (zero !== noPredecessor || (value.expectedPredecessorEventId === null) !== (value.expectedPredecessorEventDigest === null)) {
    ctx.addIssue({ code: "custom", path: ["expectedVersion"], message: "version zero iff predecessor ID/digest are null" });
  }
});
export type AnalysisObservationAssignmentEventInput = z.infer<typeof AnalysisObservationAssignmentEventInputSchema>;

export const AnalysisStudySummarySchema = z.object({
  study: AnalysisStudyProjectionSchema,
  selectedItemCount: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  viewedItemCount: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  completedItemCount: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  closure: AnalysisStudyClosureArtifactSchema.nullable()
}).strict().superRefine((value, ctx) => {
  if (value.viewedItemCount > value.selectedItemCount || value.completedItemCount > value.selectedItemCount) {
    ctx.addIssue({ code: "custom", path: ["selectedItemCount"], message: "viewed/completed counts cannot exceed selected" });
  }
  if (value.closure !== null && (value.closure.studyId !== value.study.study.id ||
      value.closure.projectId !== value.study.study.projectId || value.closure.populationId !== value.study.study.populationId ||
      value.closure.drawId !== value.study.study.drawId || value.closure.datasetRevisionId !== value.study.study.datasetRevisionId ||
      value.closure.selectedItemCount !== value.selectedItemCount || value.closure.viewedItemCount !== value.viewedItemCount ||
      value.closure.completedItemCount !== value.completedItemCount)) {
    ctx.addIssue({ code: "custom", path: ["closure"], message: "closure must bind the exact study and summary counts" });
  }
  if ((value.study.state === "coding_closed" || value.study.state === "completed") !== (value.closure !== null)) {
    ctx.addIssue({ code: "custom", path: ["closure"], message: "only closed/completed studies have closure" });
  }
});
export type AnalysisStudySummary = z.infer<typeof AnalysisStudySummarySchema>;

export const AnalysisStudyDetailSchema = z.object({
  summary: AnalysisStudySummarySchema,
  taxonomyCoverage: AnalysisTaxonomyCoverageSchema.nullable()
}).strict().superRefine((value, ctx) => {
  if (value.taxonomyCoverage !== null && value.taxonomyCoverage.studyId !== value.summary.study.study.id) {
    ctx.addIssue({ code: "custom", path: ["taxonomyCoverage"], message: "coverage must bind the exact study" });
  }
});
export type AnalysisStudyDetail = z.infer<typeof AnalysisStudyDetailSchema>;

export const AnalysisStudySummariesPageSchema = z.object({
  items: z.array(AnalysisStudySummarySchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: AnalysisPopulationExactCountSchema,
  unavailableDueClosureCount: z.number().int().min(0).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  nextCursor: AnalysisPopulationCursorSchema
}).strict().superRefine((value, ctx) => {
  if (value.items.length + value.unavailableDueClosureCount > ANALYSIS_POPULATION_API_PAGE_MAX) {
    ctx.addIssue({
      code: "custom",
      path: ["unavailableDueClosureCount"],
      message: "available and unavailable rows cannot exceed the bounded raw page"
    });
  }
});
export type AnalysisStudySummariesPage = z.infer<typeof AnalysisStudySummariesPageSchema>;

export const AnalysisStudyItemsPageSchema = z.object({
  items: z.array(AnalysisStudyItemProjectionSchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: z.number().int().min(1).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET),
  nextCursor: AnalysisPopulationCursorSchema
}).strict();
export type AnalysisStudyItemsPage = z.infer<typeof AnalysisStudyItemsPageSchema>;

export const AnalysisStudyItemEventsPageSchema = z.object({
  items: z.array(AnalysisStudyItemEventArtifactSchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: AnalysisPopulationExactCountSchema,
  nextCursor: AnalysisPopulationCursorSchema
}).strict();
export type AnalysisStudyItemEventsPage = z.infer<typeof AnalysisStudyItemEventsPageSchema>;

export const AnalysisStudyCreateResultSchema = z.object({
  study: AnalysisStudyProjectionSchema,
  reused: z.boolean()
}).strict();
export type AnalysisStudyCreateResult = z.infer<typeof AnalysisStudyCreateResultSchema>;

export const AnalysisStudyEventResultSchema = z.object({
  study: AnalysisStudyProjectionSchema,
  event: AnalysisStudyEventArtifactSchema,
  replayed: z.boolean()
}).strict().superRefine((value, ctx) => {
  const ownerMismatch = value.event.studyId !== value.study.study.id || value.event.projectId !== value.study.study.projectId;
  const headMismatch = value.study.currentEventId !== value.event.id || value.study.currentEventDigest !== value.event.eventDigest ||
    value.study.currentVersion !== value.event.version || value.study.state !== value.event.toState;
  const historicalInvalid = BigInt(value.event.version) > BigInt(value.study.currentVersion);
  if (ownerMismatch || (!value.replayed && headMismatch) || (value.replayed && historicalInvalid)) {
    ctx.addIssue({ code: "custom", path: ["event"], message: "event must be the returned study head" });
  }
});
export type AnalysisStudyEventResult = z.infer<typeof AnalysisStudyEventResultSchema>;

export const AnalysisStudyItemEventResultSchema = z.object({
  item: AnalysisStudyItemProjectionSchema,
  event: AnalysisStudyItemEventArtifactSchema,
  replayed: z.boolean()
}).strict().superRefine((value, ctx) => {
  const ownerMismatch = value.event.studyId !== value.item.item.studyId || value.event.studyItemId !== value.item.item.id ||
    value.event.projectId !== value.item.item.projectId;
  const headMismatch = value.item.currentEventId !== value.event.id || value.item.currentEventDigest !== value.event.eventDigest ||
    value.item.currentVersion !== value.event.version;
  const historicalInvalid = BigInt(value.event.version) > BigInt(value.item.currentVersion);
  if (ownerMismatch || (!value.replayed && headMismatch) || (value.replayed && historicalInvalid)) {
    ctx.addIssue({ code: "custom", path: ["event"], message: "event must be the returned item head" });
  }
});
export type AnalysisStudyItemEventResult = z.infer<typeof AnalysisStudyItemEventResultSchema>;

export const AnalysisTaxonomySummarySchema = z.object({
  taxonomy: AnalysisFailureTaxonomyArtifactSchema,
  currentRevision: AnalysisTaxonomyRevisionArtifactSchema
}).strict().superRefine((value, ctx) => {
  if (value.currentRevision.taxonomyId !== value.taxonomy.id || value.currentRevision.projectId !== value.taxonomy.projectId) {
    ctx.addIssue({ code: "custom", path: ["currentRevision"], message: "revision must belong to taxonomy" });
  }
});
export type AnalysisTaxonomySummary = z.infer<typeof AnalysisTaxonomySummarySchema>;

export const AnalysisTaxonomyDetailSchema = z.object({
  taxonomy: AnalysisFailureTaxonomyArtifactSchema,
  revision: AnalysisTaxonomyRevisionProjectionSchema
}).strict().superRefine((value, ctx) => {
  if (value.revision.revision.taxonomyId !== value.taxonomy.id || value.revision.revision.projectId !== value.taxonomy.projectId) {
    ctx.addIssue({ code: "custom", path: ["revision"], message: "revision must belong to taxonomy" });
  }
});
export type AnalysisTaxonomyDetail = z.infer<typeof AnalysisTaxonomyDetailSchema>;

export const AnalysisTaxonomyRevisionsPageSchema = z.object({
  items: z.array(AnalysisTaxonomyRevisionArtifactSchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: z.number().int().min(1).max(ANALYSIS_MAX_TAXONOMY_REVISIONS),
  nextCursor: AnalysisPopulationCursorSchema
}).strict();
export type AnalysisTaxonomyRevisionsPage = z.infer<typeof AnalysisTaxonomyRevisionsPageSchema>;

export const AnalysisTaxonomyRevisionResultSchema = z.object({
  taxonomy: AnalysisFailureTaxonomyArtifactSchema,
  revision: AnalysisTaxonomyRevisionProjectionSchema,
  replayed: z.boolean()
}).strict().superRefine((value, ctx) => {
  if (value.revision.revision.taxonomyId !== value.taxonomy.id || value.revision.revision.projectId !== value.taxonomy.projectId) {
    ctx.addIssue({ code: "custom", path: ["revision"], message: "revision must belong to taxonomy" });
  }
});
export type AnalysisTaxonomyRevisionResult = z.infer<typeof AnalysisTaxonomyRevisionResultSchema>;

export const AnalysisObservationAssignmentsPageSchema = z.object({
  items: z.array(AnalysisObservationAssignmentEventArtifactSchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: AnalysisPopulationExactCountSchema,
  nextCursor: AnalysisPopulationCursorSchema
}).strict();
export type AnalysisObservationAssignmentsPage = z.infer<typeof AnalysisObservationAssignmentsPageSchema>;

export const AnalysisObservationAssignmentEventResultSchema = z.object({
  event: AnalysisObservationAssignmentEventArtifactSchema,
  replayed: z.boolean()
}).strict();
export type AnalysisObservationAssignmentEventResult = z.infer<typeof AnalysisObservationAssignmentEventResultSchema>;

function refineAnalysisEventPredecessor(
  version: string,
  predecessorId: string | null,
  predecessorDigest: string | null,
  ctx: z.RefinementCtx
): void {
  const first = version === "1";
  const empty = predecessorId === null && predecessorDigest === null;
  if (first !== empty || (predecessorId === null) !== (predecessorDigest === null)) {
    ctx.addIssue({ code: "custom", path: ["version"], message: "version one iff predecessor ID/digest are null" });
  }
}

function refineAnalysisStudyItemProjection(value: z.infer<typeof AnalysisStudyItemProjectionSchema>, ctx: z.RefinementCtx): void {
  refineAnalysisItemEvidence(value, ctx, ["state"]);
  const zero = value.currentVersion === "0";
  if (zero !== (value.currentEventId === null && value.currentEventDigest === null)) {
    ctx.addIssue({ code: "custom", path: ["currentVersion"], message: "version zero must have no coding-event head" });
  }
  if (value.state === "uncoded" && (!zero || value.viewEventIds.length > 0 ||
      value.activeFailureObservationEventIds.length > 0 || value.activeNoFailureEventId !== null)) {
    ctx.addIssue({ code: "custom", path: ["state"], message: "uncoded item has no view or coding evidence" });
  }
  if (value.state === "completed" && value.completionEventId === null) {
    ctx.addIssue({ code: "custom", path: ["completionEventId"], message: "completed item requires completion head" });
  }
  if (value.state !== "completed" && value.completionEventId !== null) {
    ctx.addIssue({ code: "custom", path: ["completionEventId"], message: "reopened/incomplete item cannot retain completion head" });
  }
}

function refineAnalysisItemEvidence(
  value: {
    currentEventId: string | null; currentEventDigest: string | null;
    viewEventIds: string[]; viewEventDigests: string[];
    activeFailureObservationEventIds: string[]; activeFailureObservationEventDigests: string[];
    activeFailureAssignmentEventIds: (string | null)[]; activeFailureAssignmentEventDigests: (string | null)[];
    activeNoFailureEventId: string | null; activeNoFailureEventDigest: string | null;
    completionEventId: string | null; completionEventDigest: string | null;
  },
  ctx: z.RefinementCtx,
  path: PropertyKey[]
): void {
  const failureCount = value.activeFailureObservationEventIds.length;
  if (value.activeFailureObservationEventDigests.length !== failureCount ||
      value.activeFailureAssignmentEventIds.length !== failureCount ||
      value.activeFailureAssignmentEventDigests.length !== failureCount ||
      value.viewEventIds.length !== value.viewEventDigests.length) {
    ctx.addIssue({ code: "custom", path, message: "evidence ID/digest arrays must be aligned" });
  }
  if (new Set(value.viewEventIds).size !== value.viewEventIds.length ||
      new Set(value.activeFailureObservationEventIds).size !== value.activeFailureObservationEventIds.length) {
    ctx.addIssue({ code: "custom", path, message: "evidence IDs must be unique in their causal order" });
  }
  if ((value.currentEventId === null) !== (value.currentEventDigest === null) ||
      (value.activeNoFailureEventId === null) !== (value.activeNoFailureEventDigest === null) ||
      (value.completionEventId === null) !== (value.completionEventDigest === null)) {
    ctx.addIssue({ code: "custom", path, message: "evidence ID/digest pairs must be present together" });
  }
  value.activeFailureAssignmentEventIds.forEach((id, index) => {
    if ((id === null) !== (value.activeFailureAssignmentEventDigests[index] === null)) {
      ctx.addIssue({ code: "custom", path: [...path, "activeFailureAssignmentEventIds", index], message: "assignment ID/digest pair mismatch" });
    }
  });
  if (failureCount > 0 && value.activeNoFailureEventId !== null) {
    ctx.addIssue({ code: "custom", path, message: "failure and no-failure evidence are mutually exclusive" });
  }
}

function refineAnalysisTaxonomyCommandCodes(
  codes: readonly ({ kind: "new"; clientToken: string; label: string } | { kind: "existing"; codeId: string; label: string; status: "active" | "retired" })[],
  ctx: z.RefinementCtx
): void {
  const newTokens = new Set<string>();
  const existingIds = new Set<string>();
  const activeLabels = new Set<string>();
  codes.forEach((code, index) => {
    const key = code.kind === "new" ? code.clientToken : code.codeId;
    const set = code.kind === "new" ? newTokens : existingIds;
    if (set.has(key)) ctx.addIssue({ code: "custom", path: ["codes", index], message: "code identity must be unique in request" });
    set.add(key);
    const active = code.kind === "new" || code.status === "active";
    if (active && activeLabels.has(code.label)) {
      ctx.addIssue({ code: "custom", path: ["codes", index, "label"], message: "active exact labels must be unique" });
    }
    if (active) activeLabels.add(code.label);
  });
}

function normalizeAnalysisSharedTimestamp(value: string): string {
  return new Date(value).toISOString();
}

export const DatasetExposureEventSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  revisionId: z.string(),
  revisionItemId: z.string().nullable(),
  kind: z.enum([
    "created", "legacy_pretracking", "human_access", "evaluator_execution",
    "development_use", "declassification", "superseded", "overlap_detected", "exported"
  ]),
  exposureClass: z.enum(["lineage", "provenance", "development"]),
  activity: z.enum([
    "revision_create", "legacy_import", "content_view", "export", "analysis_authoring",
    "criterion_authoring", "rubric_authoring", "prompt_tuning", "example_selection", "model_selection",
    "development_run", "final_validation_run", "regression_run", "declassify",
    "supersede", "exact_overlap"
  ]),
  subjectKind: z.enum(["person", "api_key", "evaluator_version", "activity", "system"]),
  subjectId: z.string().nullable(),
  actorUserId: z.string().nullable(),
  evidenceRefKind: z.string().nullable(),
  evidenceRefId: z.string().nullable(),
  reason: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  occurredAt: z.string()
});
export type DatasetExposureEvent = z.infer<typeof DatasetExposureEventSchema>;

export const DatasetRevisionDetailSchema = DatasetRevisionSchema.extend({
  items: z.array(DatasetRevisionItemSchema),
  exposures: z.array(DatasetExposureEventSchema)
});
export type DatasetRevisionDetail = z.infer<typeof DatasetRevisionDetailSchema>;

export const CreateDatasetRevisionInputSchema = z.object({
  role: DatasetRevisionRoleSchema,
  expectedParentRevisionId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).max(200).optional()
}).strict();
export type CreateDatasetRevisionInput = z.infer<typeof CreateDatasetRevisionInputSchema>;

export const CreateDatasetInputSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional()
});
export type CreateDatasetInput = z.infer<typeof CreateDatasetInputSchema>;

export const AddDatasetItemsInputSchema = z.object({
  items: z.array(z.object({
    caseId: z.string().min(1),
    expectedLabel: VerdictLabelSchema.exclude(["ambiguous"]).optional(),
    note: z.string().max(2000).optional()
  })).min(1).max(500)
});
export type AddDatasetItemsInput = z.infer<typeof AddDatasetItemsInputSchema>;

// Skill Bench ingestion: paste examples as content, not case refs. Each item
// mints (or content-dedups into) a manual case and lands in the dataset with
// its expected label. Unlike trace imports, this path never auto-judges —
// bench judging happens only through explicit eval runs.
// a step-targeted expectation is valid only alongside expectedLabel
// "fail" and must index a step supplied IN THE SAME item — labeling an
// existing case without resupplying its steps is rejected by the same rule.
export function validateStepExpectation(
  item: { expectedLabel?: "pass" | "fail" | undefined; expectedFailStep?: number | undefined; steps?: unknown[] | undefined },
  ctx: z.RefinementCtx
): void {
  if (item.expectedFailStep === undefined) return;
  if (item.expectedLabel !== "fail") {
    ctx.addIssue({
      code: "custom",
      path: ["expectedFailStep"],
      message: 'expectedFailStep is only valid alongside expectedLabel "fail"'
    });
  }
  if (!item.steps || item.expectedFailStep >= item.steps.length) {
    ctx.addIssue({
      code: "custom",
      path: ["expectedFailStep"],
      message: "expectedFailStep must index (0-based) a step supplied in the same item's steps"
    });
  }
}

export const DatasetExampleInputSchema = z.object({
  input: z.unknown(),
  output: z.unknown(),
  // Optional human title; becomes the case title via normalized metadata.name.
  name: z.string().trim().min(1).max(200).optional(),
  expectedLabel: VerdictLabelSchema.exclude(["ambiguous"]).optional(),
  expectedFailStep: z.number().int().nonnegative().optional(),
  note: z.string().max(2000).optional(),
  steps: z.array(TraceStepSchema).max(MAX_TRACE_STEPS, `a case supports at most ${MAX_TRACE_STEPS} steps`).optional()
}).superRefine(validateStepExpectation);
export type DatasetExampleInput = z.infer<typeof DatasetExampleInputSchema>;

export const ImportDatasetExamplesInputSchema = z.object({
  items: z.array(DatasetExampleInputSchema).min(1).max(500)
});
export type ImportDatasetExamplesInput = z.infer<typeof ImportDatasetExamplesInputSchema>;

export const ImportDatasetExamplesResultSchema = z.object({
  items: z.array(z.object({
    caseId: z.string(),
    datasetItemId: z.string().nullable(),
    created: z.boolean()
  })),
  // Items whose content matched an existing case (re-paste of an unchanged
  // example) — deduped, stored content untouched.
  reusedCount: z.number().int().nonnegative(),
  // Items refused by the anti-recursion guard.
  skippedCount: z.number().int().nonnegative()
});
export type ImportDatasetExamplesResult = z.infer<typeof ImportDatasetExamplesResultSchema>;

// GET /api/judge/providers — credential availability (no secrets).
// Lets the skill editor default to a runnable provider instead of dead-ending
// on the regression gate's 503.
export const JudgeProviderCredentialSourceSchema = z.enum(["built_in", "project", "environment"]);
export type JudgeProviderCredentialSource = z.infer<typeof JudgeProviderCredentialSourceSchema>;

export const JudgeProviderAvailabilityItemSchema = z.object({
  provider: JudgeProviderIdSchema,
  label: z.string(),
  available: z.boolean(),
  credentialSource: JudgeProviderCredentialSourceSchema.nullable(),
  modelSelection: z.enum(["catalog", "custom"])
});
export type JudgeProviderAvailabilityItem = z.infer<typeof JudgeProviderAvailabilityItemSchema>;

export const JudgeProviderAvailabilitySchema = z.object({
  providers: z.array(JudgeProviderAvailabilityItemSchema)
});
export type JudgeProviderAvailability = z.infer<typeof JudgeProviderAvailabilitySchema>;

export const JudgeModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  version: z.string().min(1),
  createdAt: z.string().nullable()
});
export type JudgeModel = z.infer<typeof JudgeModelSchema>;

export const JudgeModelCatalogSchema = z.object({
  provider: JudgeProviderIdSchema,
  models: z.array(JudgeModelSchema)
});
export type JudgeModelCatalog = z.infer<typeof JudgeModelCatalogSchema>;

export const ProviderResponseMetadataSchema = z.object({
  model: z.string().nullable(),
  requestId: z.string().nullable(),
  responseId: z.string().nullable(),
  systemFingerprint: z.string().nullable()
});
export type ProviderResponseMetadata = z.infer<typeof ProviderResponseMetadataSchema>;

// Eval runs: judge a set of cases with one skill version via queue fan-out.
// Aggregates are incremental counters (completion detection is an atomic
// per-item update, not a scan).
export const EvalRunStatusSchema = z.enum(["pending", "running", "completed", "failed", "canceled"]);
export type EvalRunStatus = z.infer<typeof EvalRunStatusSchema>;

// 'backfill' = a durable re-evaluation of existing cases after a version gate.
// It is deliberately distinct from 'regression_gate', which is evaluator-
// version governance over the pinned known-failure revision.
// 'product_gate' = the retained run kind behind deprecated product-gate reads.
export const EvalRunTriggerSchema = z.enum(["manual", "api_batch", "backfill", "regression_gate", "product_gate", "release_evidence"]);
export type EvalRunTrigger = z.infer<typeof EvalRunTriggerSchema>;

export const EvalRunItemStatusSchema = z.enum(["pending", "completed", "failed", "skipped"]);
export type EvalRunItemStatus = z.infer<typeof EvalRunItemStatusSchema>;

export const TraceTestRunSourceSchema = z.object({
  traceTestId: z.string().min(1),
  revision: z.number().int().positive(),
  validationRevision: z.number().int().positive(),
  validationId: z.string().min(1),
  sourceCaseRef: z.string().min(1),
  caseId: z.string().min(1),
  datasetItemId: z.string().min(1)
});
export type TraceTestRunSource = z.infer<typeof TraceTestRunSourceSchema>;

export const EvalRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  datasetId: z.string().nullable(),
  datasetRevisionId: z.string().nullable().optional(),
  skillVersionId: z.string(),
  trigger: EvalRunTriggerSchema,
  status: EvalRunStatusSchema,
  blocking: z.boolean(),
  totalItems: z.number().int().nonnegative(),
  completedItems: z.number().int().nonnegative(),
  failedItems: z.number().int().nonnegative(),
  // Items with an expectedLabel whose result matched; items without ground
  // truth never count here.
  agreedItems: z.number().int().nonnegative(),
  error: z.string().nullable(),
  sourceTraceTest: TraceTestRunSourceSchema.nullable().default(null),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable()
});
export type EvalRun = z.infer<typeof EvalRunSchema>;

export const EvalRunItemSchema = z.object({
  id: z.string(),
  evalRunId: z.string(),
  caseId: z.string(),
  datasetItemId: z.string().nullable(),
  datasetRevisionItemId: z.string().nullable().optional(),
  clientItemId: z.string().nullable(),
  contentDigest: z.string().nullable(),
  status: EvalRunItemStatusSchema,
  verdictId: z.string().nullable(),
  expectedLabel: VerdictLabelSchema.exclude(["ambiguous"]).nullable(),
  // snapshot of the dataset item's step expectation at run time.
  expectedFailStep: z.number().int().nonnegative().nullable(),
  // The step the judge named (from the verdict payload). Schema-only until T3
  // populates it.
  failingStep: z.number().int().nonnegative().nullable(),
  resultLabel: z.string().nullable(),
  agreement: z.boolean().nullable(),
  // True/false only when BOTH expectedFailStep and failingStep exist; never
  // blended into overall agreement (counts reported separately).
  stepAgreement: z.boolean().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  // this item's judge-call token usage (null = cached item, failed
  // item, or provider didn't report — see the run-level spend summary).
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  // Metadata from THIS item's provider call. Null means cached/pending/failed
  // before a provider response; nullable fields inside mean unreported.
  providerMetadata: ProviderResponseMetadataSchema.nullable().optional(),
  // True when the item reused an already-recorded verdict (batch idempotency)
  // instead of spending provider tokens.
  cached: z.boolean(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable()
});
export type EvalRunItem = z.infer<typeof EvalRunItemSchema>;

// run-level spend — tokens and counts, never dollars. Token sums are
// null when NOTHING reported usage (no fresh calls, or all unreported);
// usageMissingCount names the fresh completed items whose call didn't report.
export const EvalRunSpendSchema = z.object({
  freshItems: z.number().int().nonnegative(),
  cachedItems: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  usageMissingCount: z.number().int().nonnegative(),
  totalLatencyMs: z.number().int().nonnegative().nullable()
});
export type EvalRunSpend = z.infer<typeof EvalRunSpendSchema>;

export const EvalRunDetailSchema = EvalRunSchema.extend({
  items: z.array(EvalRunItemSchema),
  spend: EvalRunSpendSchema
});
export type EvalRunDetail = z.infer<typeof EvalRunDetailSchema>;

export const TraceTestRunOutcomeSchema = z.enum(["running", "passed", "regressed", "needs_review", "could_not_run"]);
export type TraceTestRunOutcome = z.infer<typeof TraceTestRunOutcomeSchema>;

export function traceTestRunOutcome(run: EvalRunDetail): TraceTestRunOutcome {
  if (run.status === "pending" || run.status === "running") return "running";
  if (run.status === "failed" || run.status === "canceled") return "could_not_run";
  const source = run.sourceTraceTest;
  const item = source
    ? run.items.find((candidate) => candidate.datasetItemId === source.datasetItemId || candidate.caseId === source.caseId)
    : run.items.length === 1 ? run.items[0] : undefined;
  if (!item || item.status === "failed" || item.status === "skipped") return "could_not_run";
  if (item.status !== "completed" || item.resultLabel === "ambiguous" || item.agreement === null) return "needs_review";
  return item.agreement ? "passed" : "regressed";
}

export const StartTraceTestRunInputSchema = z.object({
  datasetId: z.string().min(1).optional()
});
export type StartTraceTestRunInput = z.infer<typeof StartTraceTestRunInputSchema>;

export const TraceTestRunResultSchema = z.object({
  dataset: DatasetSchema,
  run: EvalRunDetailSchema,
  outcome: TraceTestRunOutcomeSchema
});
export type TraceTestRunResult = z.infer<typeof TraceTestRunResultSchema>;

// Privacy-bounded activation telemetry for the beginner trace-to-test journey.
// This schema is intentionally closed: source ids, prompts, outputs, draft
// fields, and arbitrary metadata cannot cross the analytics boundary.
export const TraceTestFunnelEventNameSchema = z.enum([
  "started",
  "draft_saved",
  "validation_completed",
  "enabled",
  "correction_recorded",
  "run_started",
  "abandoned"
]);
export type TraceTestFunnelEventName = z.infer<typeof TraceTestFunnelEventNameSchema>;

export const TraceTestFunnelEventInputSchema = z.object({
  journeyId: z.string().uuid(),
  event: TraceTestFunnelEventNameSchema,
  elapsedMs: z.number().int().min(0).max(86_400_000),
  intent: z.enum(["prevent", "protect", "make"])
}).strict();
export type TraceTestFunnelEventInput = z.infer<typeof TraceTestFunnelEventInputSchema>;

export const CreateEvalRunInputSchema = z.object({
  datasetId: z.string().min(1).optional(),
  datasetRevisionId: z.string().min(1).optional(),
  // Defaults to the project's current skill version.
  skillVersionId: z.string().min(1).optional()
}).superRefine((input, ctx) => {
  if ((input.datasetId ? 1 : 0) + (input.datasetRevisionId ? 1 : 0) !== 1) {
    ctx.addIssue({ code: "custom", message: "Provide exactly one of datasetId or datasetRevisionId" });
  }
});
export type CreateEvalRunInput = z.infer<typeof CreateEvalRunInputSchema>;

// Response for GET /api/v1/project — the free connection check for API-key
// callers (skills, CI). currentSkillVersionId is null when the project has no
// active judging skill version yet, so clients can warn before a submit that
// would 400.
export const V1ProjectResponseSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  mode: ProjectModeSchema,
  currentSkillVersionId: z.string().nullable()
});
export type V1ProjectResponse = z.infer<typeof V1ProjectResponseSchema>;

// Run comparisons ("Incident Bisect", compare-on-dataset slice): one dataset,
// two skill versions, two ordinary eval runs created through the standard
// eval-run path. The persisted row only pins the participants; the per-case
// diff is computed at read time by joining both runs' items on caseId.
export const RunComparisonSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  datasetId: z.string(),
  datasetRevisionId: z.string().nullable().optional(),
  versionAId: z.string(),
  versionBId: z.string(),
  runAId: z.string(),
  runBId: z.string(),
  createdAt: z.string()
});
export type RunComparison = z.infer<typeof RunComparisonSchema>;

export const CreateRunComparisonInputSchema = z.object({
  datasetId: z.string().min(1),
  versionAId: z.string().min(1),
  versionBId: z.string().min(1)
});
export type CreateRunComparisonInput = z.infer<typeof CreateRunComparisonInputSchema>;

// Per-case diff buckets. Labels are projected pass / non-pass for bucketing
// (an ambiguous verdict is a non-pass for bisect purposes — the incident
// question is "where did passes stop passing"), so fail↔ambiguous is
// same-fail, not a flip. `pending` = either run hasn't judged the case yet;
// `missing` = the case has no judgment in one run (absent from the snapshot,
// failed, or skipped) — named, never silently dropped from a denominator.
export const RunComparisonBucketSchema = z.enum([
  "same-pass",
  "same-fail",
  "flipped-now-failing",
  "flipped-now-passing",
  "pending",
  "missing"
]);
export type RunComparisonBucket = z.infer<typeof RunComparisonBucketSchema>;

export const RunComparisonCaseSchema = z.object({
  caseId: z.string(),
  // Snapshot expectation (from either run's item — identical when both
  // snapshotted the same dataset row).
  expectedLabel: VerdictLabelSchema.exclude(["ambiguous"]).nullable(),
  // The judge's recorded label per run, null when the case never completed
  // in that run (status tells why: pending / failed / skipped / absent).
  // string, not VerdictLabelSchema: snapshots EvalRunItem.resultLabel, which
  // is string-typed end-to-end — tighten both together or neither.
  labelA: z.string().nullable(),
  labelB: z.string().nullable(),
  // null status = the case is absent from that run's snapshot.
  statusA: EvalRunItemStatusSchema.nullable(),
  statusB: EvalRunItemStatusSchema.nullable(),
  bucket: RunComparisonBucketSchema
});
export type RunComparisonCase = z.infer<typeof RunComparisonCaseSchema>;

export const RunComparisonBucketCountsSchema = z.object({
  "same-pass": z.number().int().nonnegative(),
  "same-fail": z.number().int().nonnegative(),
  "flipped-now-failing": z.number().int().nonnegative(),
  "flipped-now-passing": z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative()
});
export type RunComparisonBucketCounts = z.infer<typeof RunComparisonBucketCountsSchema>;

// Per-version agreement over the comparison's run: agreed of labeled, where
// labeled counts only items that carried an expectedLabel AND completed —
// the honest denominator (an infrastructure failure is not a disagreement).
export const RunComparisonAgreementSchema = z.object({
  agreed: z.number().int().nonnegative(),
  labeled: z.number().int().nonnegative()
});
export type RunComparisonAgreement = z.infer<typeof RunComparisonAgreementSchema>;

export const RunComparisonDetailSchema = RunComparisonSchema.extend({
  // 'pending' until BOTH runs reached a terminal status — the poll signal.
  status: z.enum(["pending", "completed"]),
  runA: EvalRunSchema,
  runB: EvalRunSchema,
  agreementA: RunComparisonAgreementSchema,
  agreementB: RunComparisonAgreementSchema,
  buckets: RunComparisonBucketCountsSchema,
  cases: z.array(RunComparisonCaseSchema)
});
export type RunComparisonDetail = z.infer<typeof RunComparisonDetailSchema>;

// Body for POST /api/v1/judge/batch — fire-and-poll variant of /api/v1/judge.
// Each item reuses the manual-import trace shape; the response is 202 with an
// eval run id to poll. `datasetId` optionally appends the imported cases to an
// existing dataset so the batch is re-runnable later.
// batch items may carry the caller's expected label so CI runs report
// agreement. Labels are claims, not reviews (locked decision) — they land on
// dataset items / eval-run snapshots, never as verdict rows.
export const JudgeBatchItemSchema = ManualTraceImportInputSchema.extend({
  // Caller-owned join identity: preserve every code unit exactly. Trimming
  // would make the receipt impossible to join back to a valid submitted id.
  clientItemId: z.string().min(1).max(240).optional(),
  expectedLabel: VerdictLabelSchema.exclude(["ambiguous"]).optional(),
  // same cross-field rule as dataset examples (fail-only, in range of
  // THIS item's steps).
  expectedFailStep: z.number().int().nonnegative().optional()
}).superRefine(validateStepExpectation);
export type JudgeBatchItem = z.infer<typeof JudgeBatchItemSchema>;

export const JudgeBatchRequestSchema = z.object({
  purpose: z.enum(["general", "release_evidence"]).default("general"),
  items: z.array(JudgeBatchItemSchema).min(1),
  skillVersionId: z.string().min(1).optional(),
  datasetId: z.string().min(1).optional()
}).superRefine((request, ctx) => {
  if (request.purpose !== "release_evidence") return;
  const seen = new Set<string>();
  request.items.forEach((item, index) => {
    if (!item.clientItemId) {
      ctx.addIssue({
        code: "custom",
        path: ["items", index, "clientItemId"],
        message: "clientItemId is required when purpose is release_evidence"
      });
      return;
    }
    if (seen.has(item.clientItemId)) {
      ctx.addIssue({
        code: "custom",
        path: ["items", index, "clientItemId"],
        message: "clientItemId must be unique within release_evidence batches"
      });
    }
    seen.add(item.clientItemId);
  });
});
export type JudgeBatchRequest = z.infer<typeof JudgeBatchRequestSchema>;

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const AssessmentReceiptItemSchema = z.object({
  clientItemId: z.string().min(1),
  caseId: z.string().min(1),
  status: EvalRunItemStatusSchema,
  judgedLabel: VerdictLabelSchema.nullable(),
  verdictId: z.string().nullable(),
  error: z.string().nullable(),
  contentDigest: Sha256DigestSchema,
  providerMetadata: ProviderResponseMetadataSchema.strict()
}).strict();
export type AssessmentReceiptItem = z.infer<typeof AssessmentReceiptItemSchema>;

export const AssessmentReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  receiptId: z.string().min(1),
  evalRunId: z.string().min(1),
  projectId: z.string().min(1),
  skillId: z.string().min(1),
  skillVersionId: z.string().min(1),
  status: z.enum(["complete", "incomplete"]),
  run: z.object({
    status: EvalRunStatusSchema,
    totalItems: z.number().int().nonnegative(),
    completedItems: z.number().int().nonnegative(),
    failedItems: z.number().int().nonnegative(),
    agreedItems: z.number().int().nonnegative()
  }).strict(),
  requestedModelBinding: ModelBindingSchema.strict(),
  skillDigest: Sha256DigestSchema,
  datasetDigest: Sha256DigestSchema,
  items: z.array(AssessmentReceiptItemSchema),
  evidenceDigest: Sha256DigestSchema
}).strict();
export type AssessmentReceipt = z.infer<typeof AssessmentReceiptSchema>;

// Evaluator suite manifest v1 is a separate, policy-free artifact. It binds
// immutable criterion definitions to exact evaluator versions while leaving
// every criterion's assessment in its existing receipt-v1 artifact. Keep all
// nested objects strict: release roles, thresholds, weights, compensation,
// and composite decisions are intentionally not representable here.
const EvaluatorSuiteSha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const CriterionSourceKindSchema = z.enum(["native", "analysis_promotion"]);
export type CriterionSourceKind = z.infer<typeof CriterionSourceKindSchema>;

export const CriterionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  stableKey: z.string().min(1),
  sourceKind: CriterionSourceKindSchema,
  createdByUserId: z.string().nullable(),
  createdAt: z.string()
}).strict();
export type Criterion = z.infer<typeof CriterionSchema>;

export const CriterionVersionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  criterionId: z.string().min(1),
  revision: z.number().int().positive(),
  name: z.string().min(1),
  definition: z.string().min(1),
  criterionDigest: EvaluatorSuiteSha256DigestSchema,
  sourceKind: CriterionSourceKindSchema,
  createdByUserId: z.string().nullable(),
  createdAt: z.string()
}).strict();
export type CriterionVersion = z.infer<typeof CriterionVersionSchema>;

// Failure-code promotion is the narrow ADR-0010 bridge from governed Analyze
// evidence into one criterion definition. It creates no evaluator or truth.
export const ANALYSIS_CRITERION_PROMOTION_CONTRACT_VERSION = "analysis-criterion-promotion/v1" as const;
export const ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION = "analysis-criterion-promotion-handoff/v1" as const;
export const ANALYSIS_MAX_PROMOTION_SUPPORTS = 1_000 as const;

const AnalysisPromotionCanonicalText = (maximum: number) => UnicodeScalarValueSchema
  .min(1)
  .max(maximum)
  .refine((value) => value.trim().length > 0, { message: "must contain non-whitespace content" })
  .refine((value) => value === value.trim(), { message: "must not have leading or trailing whitespace" });

export const AnalysisCriterionPromotionSupportInputSchema = z.object({
  studyItemId: AnalysisPopulationIdSchema,
  closureItemId: AnalysisPopulationIdSchema,
  closureItemDigest: DatasetEvidenceDigestSchema,
  observationEventId: AnalysisPopulationIdSchema,
  observationEventDigest: DatasetEvidenceDigestSchema,
  assignmentEventId: AnalysisPopulationIdSchema,
  assignmentEventDigest: DatasetEvidenceDigestSchema
}).strict();
export type AnalysisCriterionPromotionSupportInput = z.infer<typeof AnalysisCriterionPromotionSupportInputSchema>;

export const AnalysisCriterionPromotionCreateInputSchema = z.object({
  studyId: AnalysisPopulationIdSchema,
  expectedClosureId: AnalysisPopulationIdSchema,
  expectedClosureDigest: DatasetEvidenceDigestSchema,
  taxonomyId: AnalysisPopulationIdSchema,
  taxonomyRevisionId: AnalysisPopulationIdSchema,
  expectedTaxonomyRevisionDigest: DatasetEvidenceDigestSchema,
  codeId: AnalysisPopulationIdSchema,
  expectedCodeEntryDigest: DatasetEvidenceDigestSchema,
  criterionName: AnalysisPromotionCanonicalText(200),
  criterionDefinition: AnalysisPromotionCanonicalText(20_000),
  rationale: AnalysisPromotionCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  supportingObservations: z.array(AnalysisCriterionPromotionSupportInputSchema)
    .min(1)
    .max(ANALYSIS_MAX_PROMOTION_SUPPORTS),
  idempotencyKey: AnalysisCommandIdempotencyKeySchema
}).strict().superRefine((value, ctx) => {
  const observationIds = new Set<string>();
  value.supportingObservations.forEach((support, index) => {
    if (observationIds.has(support.observationEventId)) {
      ctx.addIssue({
        code: "custom",
        path: ["supportingObservations", index, "observationEventId"],
        message: "supporting observations must have unique observation identities"
      });
    }
    observationIds.add(support.observationEventId);
  });
});
export type AnalysisCriterionPromotionCreateInput = z.infer<typeof AnalysisCriterionPromotionCreateInputSchema>;

export const AnalysisCriterionPromotionArtifactSchema = z.object({
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  contractVersion: z.literal(ANALYSIS_CRITERION_PROMOTION_CONTRACT_VERSION),
  studyId: AnalysisPopulationIdSchema,
  studyClosureId: AnalysisPopulationIdSchema,
  studyClosureDigest: DatasetEvidenceDigestSchema,
  populationId: AnalysisPopulationIdSchema,
  drawId: AnalysisPopulationIdSchema,
  sourceDatasetRevisionId: AnalysisPopulationIdSchema,
  sourceDatasetRevisionContentDigest: DatasetEvidenceDigestSchema,
  sourceDatasetRevisionDigest: DatasetEvidenceDigestSchema,
  taxonomyId: AnalysisPopulationIdSchema,
  taxonomyRevisionId: AnalysisPopulationIdSchema,
  taxonomyRevisionSequence: z.number().int().min(1).max(ANALYSIS_MAX_TAXONOMY_REVISIONS),
  taxonomyRevisionDigest: DatasetEvidenceDigestSchema,
  codeId: AnalysisPopulationIdSchema,
  codeEntryId: AnalysisPopulationIdSchema,
  codeEntryDigest: DatasetEvidenceDigestSchema,
  codeLabel: AnalysisPromotionCanonicalText(ANALYSIS_MAX_FAILURE_LABEL_LENGTH),
  codeDefinition: AnalysisPromotionCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  criterionId: AnalysisPopulationIdSchema,
  criterionVersionId: AnalysisPopulationIdSchema,
  criterionStableKey: AnalysisPromotionCanonicalText(200),
  criterionName: AnalysisPromotionCanonicalText(200),
  criterionDefinition: AnalysisPromotionCanonicalText(20_000),
  criterionDigest: DatasetEvidenceDigestSchema,
  rationale: AnalysisPromotionCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  supportCount: z.number().int().min(1).max(ANALYSIS_MAX_PROMOTION_SUPPORTS),
  supportSetDigest: DatasetEvidenceDigestSchema,
  criterionAuthoringExposureEventId: AnalysisPopulationIdSchema,
  promotedByUserId: AnalysisPopulationIdSchema,
  promotedBySubjectId: AnalysisPopulationIdSchema,
  promoterRole: z.literal("owner"),
  idempotencyKey: AnalysisIdempotencyKeySchema,
  requestDigest: DatasetEvidenceDigestSchema,
  contentDigest: DatasetEvidenceDigestSchema,
  handoffVersion: z.literal(ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION),
  handoffDigest: DatasetEvidenceDigestSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict().superRefine((value, ctx) => {
  if (value.criterionStableKey !== `analysis-failure-code:${value.codeId}`) {
    ctx.addIssue({
      code: "custom",
      path: ["criterionStableKey"],
      message: "promoted criterion stable key must bind the exact failure code"
    });
  }
});
export type AnalysisCriterionPromotionArtifact = z.infer<typeof AnalysisCriterionPromotionArtifactSchema>;

export const AnalysisCriterionPromotionSupportArtifactSchema = z.object({
  id: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  promotionId: AnalysisPopulationIdSchema,
  position: z.number().int().min(0).max(ANALYSIS_MAX_PROMOTION_SUPPORTS - 1),
  studyId: AnalysisPopulationIdSchema,
  studyItemId: AnalysisPopulationIdSchema,
  closureId: AnalysisPopulationIdSchema,
  closureItemId: AnalysisPopulationIdSchema,
  closureItemDigest: DatasetEvidenceDigestSchema,
  sourceDatasetRevisionId: AnalysisPopulationIdSchema,
  sourceDatasetRevisionItemId: AnalysisPopulationIdSchema,
  sourceItemDigest: DatasetEvidenceDigestSchema,
  observationEventId: AnalysisPopulationIdSchema,
  observationEventDigest: DatasetEvidenceDigestSchema,
  assignmentEventId: AnalysisPopulationIdSchema,
  assignmentEventDigest: DatasetEvidenceDigestSchema,
  observationAuthorSubjectId: AnalysisPopulationIdSchema,
  exampleSelectionExposureEventId: AnalysisPopulationIdSchema,
  contentDigest: DatasetEvidenceDigestSchema,
  createdAt: AnalysisPopulationTimestampSchema
}).strict();
export type AnalysisCriterionPromotionSupportArtifact = z.infer<typeof AnalysisCriterionPromotionSupportArtifactSchema>;

export const AnalysisCriterionPromotionHandoffSchema = z.object({
  handoffVersion: z.literal(ANALYSIS_CRITERION_PROMOTION_HANDOFF_VERSION),
  promotionId: AnalysisPopulationIdSchema,
  projectId: AnalysisPopulationIdSchema,
  criterionId: AnalysisPopulationIdSchema,
  criterionVersionId: AnalysisPopulationIdSchema,
  criterionDigest: DatasetEvidenceDigestSchema,
  sourceDatasetRevisionId: AnalysisPopulationIdSchema,
  sourceDatasetRevisionContentDigest: DatasetEvidenceDigestSchema,
  sourceDatasetRevisionDigest: DatasetEvidenceDigestSchema,
  roleIntent: z.literal("analysis_authoring"),
  sourceKind: z.literal("analysis_promotion_handoff"),
  evidenceClass: z.literal("development_authoring_not_truth"),
  createsTruth: z.literal(false),
  createsEvaluator: z.literal(false),
  handoffDigest: DatasetEvidenceDigestSchema
}).strict();
export type AnalysisCriterionPromotionHandoff = z.infer<typeof AnalysisCriterionPromotionHandoffSchema>;

export const AnalysisCriterionPromotionCandidateSchema = z.object({
  projectId: AnalysisPopulationIdSchema,
  studyId: AnalysisPopulationIdSchema,
  studyState: z.enum(["coding_closed", "completed"]),
  closureId: AnalysisPopulationIdSchema,
  closureDigest: DatasetEvidenceDigestSchema,
  taxonomyId: AnalysisPopulationIdSchema,
  taxonomyRevisionId: AnalysisPopulationIdSchema,
  taxonomyRevisionSequence: z.number().int().min(1).max(ANALYSIS_MAX_TAXONOMY_REVISIONS),
  taxonomyRevisionDigest: DatasetEvidenceDigestSchema,
  codeId: AnalysisPopulationIdSchema,
  codeEntryId: AnalysisPopulationIdSchema,
  codeEntryDigest: DatasetEvidenceDigestSchema,
  codeLabel: AnalysisPromotionCanonicalText(ANALYSIS_MAX_FAILURE_LABEL_LENGTH),
  codeDefinition: AnalysisPromotionCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  codeStatus: z.literal("active"),
  studyItemId: AnalysisPopulationIdSchema,
  closureItemId: AnalysisPopulationIdSchema,
  closureItemDigest: DatasetEvidenceDigestSchema,
  position: z.number().int().min(0).max(ANALYSIS_POPULATION_MAX_FIXED_BUDGET - 1),
  sourceDatasetRevisionId: AnalysisPopulationIdSchema,
  sourceDatasetRevisionItemId: AnalysisPopulationIdSchema,
  sourceItemDigest: DatasetEvidenceDigestSchema,
  observationEventId: AnalysisPopulationIdSchema,
  observationEventDigest: DatasetEvidenceDigestSchema,
  failureLabel: AnalysisPromotionCanonicalText(ANALYSIS_MAX_FAILURE_LABEL_LENGTH),
  observationRationale: AnalysisPromotionCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  evidenceAnchor: AnalysisEvidenceAnchorSchema,
  assignmentEventId: AnalysisPopulationIdSchema,
  assignmentEventDigest: DatasetEvidenceDigestSchema,
  assignmentRationale: AnalysisPromotionCanonicalText(ANALYSIS_MAX_RATIONALE_LENGTH),
  observationAuthorSubjectId: AnalysisPopulationIdSchema
}).strict();
export type AnalysisCriterionPromotionCandidate = z.infer<typeof AnalysisCriterionPromotionCandidateSchema>;

const AnalysisCriterionPromotionSummaryBaseSchema = z.object({
  promotion: AnalysisCriterionPromotionArtifactSchema,
  criterion: CriterionSchema,
  criterionVersion: CriterionVersionSchema,
  handoff: AnalysisCriterionPromotionHandoffSchema
}).strict();

function refineAnalysisCriterionPromotionSummary(
  value: z.infer<typeof AnalysisCriterionPromotionSummaryBaseSchema>,
  ctx: z.RefinementCtx
): void {
  const { promotion, criterion, criterionVersion, handoff } = value;
  if (
    criterion.projectId !== promotion.projectId ||
    criterion.id !== promotion.criterionId ||
    criterion.stableKey !== promotion.criterionStableKey ||
    criterion.sourceKind !== "analysis_promotion" ||
    criterion.createdByUserId !== promotion.promotedByUserId ||
    criterion.createdAt !== promotion.createdAt ||
    criterionVersion.projectId !== promotion.projectId ||
    criterionVersion.id !== promotion.criterionVersionId ||
    criterionVersion.criterionId !== criterion.id ||
    criterionVersion.revision !== 1 ||
    criterionVersion.name !== promotion.criterionName ||
    criterionVersion.definition !== promotion.criterionDefinition ||
    criterionVersion.criterionDigest !== promotion.criterionDigest ||
    criterionVersion.sourceKind !== "analysis_promotion" ||
    criterionVersion.createdByUserId !== promotion.promotedByUserId ||
    criterionVersion.createdAt !== promotion.createdAt
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["criterionVersion"],
      message: "criterion and initial version must exactly match the promotion"
    });
  }
  if (
    handoff.handoffVersion !== promotion.handoffVersion ||
    handoff.promotionId !== promotion.id ||
    handoff.projectId !== promotion.projectId ||
    handoff.criterionId !== promotion.criterionId ||
    handoff.criterionVersionId !== promotion.criterionVersionId ||
    handoff.criterionDigest !== promotion.criterionDigest ||
    handoff.sourceDatasetRevisionId !== promotion.sourceDatasetRevisionId ||
    handoff.sourceDatasetRevisionContentDigest !== promotion.sourceDatasetRevisionContentDigest ||
    handoff.sourceDatasetRevisionDigest !== promotion.sourceDatasetRevisionDigest ||
    handoff.handoffDigest !== promotion.handoffDigest
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["handoff"],
      message: "handoff must bind the exact promotion, criterion, and source revision"
    });
  }
}

export const AnalysisCriterionPromotionSummarySchema = AnalysisCriterionPromotionSummaryBaseSchema
  .superRefine(refineAnalysisCriterionPromotionSummary);
export type AnalysisCriterionPromotionSummary = z.infer<typeof AnalysisCriterionPromotionSummarySchema>;

export const AnalysisCriterionPromotionDetailSchema = AnalysisCriterionPromotionSummarySchema;
export type AnalysisCriterionPromotionDetail = z.infer<typeof AnalysisCriterionPromotionDetailSchema>;

export const AnalysisCriterionPromotionCreateResultSchema = AnalysisCriterionPromotionSummaryBaseSchema.extend({
  supports: z.array(AnalysisCriterionPromotionSupportArtifactSchema)
    .min(1)
    .max(ANALYSIS_MAX_PROMOTION_SUPPORTS),
  replayed: z.boolean()
}).strict().superRefine((value, ctx) => {
  refineAnalysisCriterionPromotionSummary(value, ctx);
  if (value.supports.length !== value.promotion.supportCount) {
    ctx.addIssue({ code: "custom", path: ["supports"], message: "supports must match promotion supportCount" });
  }
  const supportIds = new Set<string>();
  const observationIds = new Set<string>();
  const exposureIds = new Set<string>();
  value.supports.forEach((support, index) => {
    if (
      support.projectId !== value.promotion.projectId ||
      support.promotionId !== value.promotion.id ||
      support.studyId !== value.promotion.studyId ||
      support.closureId !== value.promotion.studyClosureId ||
      support.sourceDatasetRevisionId !== value.promotion.sourceDatasetRevisionId ||
      support.createdAt !== value.promotion.createdAt ||
      support.position !== index
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["supports", index],
        message: "support must bind the exact promotion evidence and canonical position"
      });
    }
    if (supportIds.has(support.id) || observationIds.has(support.observationEventId) ||
        exposureIds.has(support.exampleSelectionExposureEventId)) {
      ctx.addIssue({
        code: "custom",
        path: ["supports", index],
        message: "support, observation, and exposure identities must be unique"
      });
    }
    supportIds.add(support.id);
    observationIds.add(support.observationEventId);
    exposureIds.add(support.exampleSelectionExposureEventId);
  });
});
export type AnalysisCriterionPromotionCreateResult = z.infer<typeof AnalysisCriterionPromotionCreateResultSchema>;

export const AnalysisCriterionPromotionCandidatesPageSchema = z.object({
  items: z.array(AnalysisCriterionPromotionCandidateSchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: AnalysisPopulationExactCountSchema,
  nextCursor: AnalysisPopulationCursorSchema
}).strict().superRefine((value, ctx) => {
  const observationIds = new Set<string>();
  value.items.forEach((candidate, index) => {
    if (observationIds.has(candidate.observationEventId)) {
      ctx.addIssue({
        code: "custom",
        path: ["items", index, "observationEventId"],
        message: "candidate observation identities must be unique within a page"
      });
    }
    observationIds.add(candidate.observationEventId);
  });
  if (BigInt(value.totalCount) < BigInt(value.items.length)) {
    ctx.addIssue({ code: "custom", path: ["totalCount"], message: "totalCount cannot be smaller than the page" });
  }
});
export type AnalysisCriterionPromotionCandidatesPage = z.infer<typeof AnalysisCriterionPromotionCandidatesPageSchema>;

export const AnalysisCriterionPromotionSummariesPageSchema = z.object({
  items: z.array(AnalysisCriterionPromotionSummarySchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: AnalysisPopulationExactCountSchema,
  nextCursor: AnalysisPopulationCursorSchema
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  value.items.forEach((summary, index) => {
    if (ids.has(summary.promotion.id)) {
      ctx.addIssue({ code: "custom", path: ["items", index], message: "promotion identities must be unique within a page" });
    }
    ids.add(summary.promotion.id);
  });
  if (BigInt(value.totalCount) < BigInt(value.items.length)) {
    ctx.addIssue({ code: "custom", path: ["totalCount"], message: "totalCount cannot be smaller than the page" });
  }
});
export type AnalysisCriterionPromotionSummariesPage = z.infer<typeof AnalysisCriterionPromotionSummariesPageSchema>;

export const AnalysisCriterionPromotionSupportsPageSchema = z.object({
  items: z.array(AnalysisCriterionPromotionSupportArtifactSchema).max(ANALYSIS_POPULATION_API_PAGE_MAX),
  totalCount: z.number().int().min(1).max(ANALYSIS_MAX_PROMOTION_SUPPORTS),
  nextCursor: AnalysisPopulationCursorSchema
}).strict().superRefine((value, ctx) => {
  const supportIds = new Set<string>();
  const observationIds = new Set<string>();
  const exposureIds = new Set<string>();
  value.items.forEach((support, index) => {
    if (supportIds.has(support.id) || observationIds.has(support.observationEventId) ||
        exposureIds.has(support.exampleSelectionExposureEventId)) {
      ctx.addIssue({
        code: "custom",
        path: ["items", index],
        message: "support, observation, and exposure identities must be unique within a page"
      });
    }
    supportIds.add(support.id);
    observationIds.add(support.observationEventId);
    exposureIds.add(support.exampleSelectionExposureEventId);
  });
  if (value.totalCount < value.items.length) {
    ctx.addIssue({ code: "custom", path: ["totalCount"], message: "totalCount cannot be smaller than the page" });
  }
});
export type AnalysisCriterionPromotionSupportsPage = z.infer<typeof AnalysisCriterionPromotionSupportsPageSchema>;

export const CriterionDetailSchema = z.object({
  criterion: CriterionSchema,
  versions: z.array(CriterionVersionSchema)
}).strict();
export type CriterionDetail = z.infer<typeof CriterionDetailSchema>;

export const CriterionEvaluatorDraftInputSchema = z.object({
  rubricMarkdown: z.string().trim().min(1).max(100_000),
  prompt: z.string().trim().min(1).max(100_000),
  modelBinding: ModelBindingInputSchema,
  outputSchema: JsonSchemaSchema.default(MinimumVerdictOutputSchema),
  verdictKind: VerdictKindSchema.default("binary"),
  scalarRange: z.tuple([z.number(), z.number()]).optional(),
  categoricalChoiceScores: z.record(z.string(), z.number().min(0).max(1)).optional()
}).strict()
  .refine((value) => !containsLoneUtf16Surrogate(value), {
    message: "Evaluator input must not contain an unpaired UTF-16 surrogate"
  })
  .refine(
    (value) => value.verdictKind !== "scalar" || (
      value.scalarRange !== undefined && value.scalarRange[0] < value.scalarRange[1]
    ),
    { message: "scalar evaluator drafts require an ascending scalarRange" }
  )
  .refine(
    (value) => value.verdictKind !== "categorical" || (
      value.categoricalChoiceScores !== undefined && Object.keys(value.categoricalChoiceScores).length > 0
    ),
    { message: "categorical evaluator drafts require non-empty categoricalChoiceScores" }
  )
  .refine((value) => value.verdictKind === "scalar" || value.scalarRange === undefined, {
    message: "scalarRange is only valid for scalar evaluator drafts"
  })
  .refine((value) => value.verdictKind === "categorical" || value.categoricalChoiceScores === undefined, {
    message: "categoricalChoiceScores is only valid for categorical evaluator drafts"
  });
export type CriterionEvaluatorDraftInput = z.infer<typeof CriterionEvaluatorDraftInputSchema>;

export const CreateCriterionInputSchema = z.object({
  stableKey: UnicodeScalarValueSchema.trim().min(1).max(200),
  name: UnicodeScalarValueSchema.trim().min(1).max(200),
  definition: UnicodeScalarValueSchema.trim().min(1).max(20_000),
  evaluator: CriterionEvaluatorDraftInputSchema
}).strict();
export type CreateCriterionInput = z.infer<typeof CreateCriterionInputSchema>;

export const CreatedCriterionSchema = CriterionDetailSchema.extend({
  evaluator: SkillSchema
}).strict();
export type CreatedCriterion = z.infer<typeof CreatedCriterionSchema>;

export const CreateCriterionVersionInputSchema = z.object({
  name: UnicodeScalarValueSchema.trim().min(1).max(200),
  definition: UnicodeScalarValueSchema.trim().min(1).max(20_000)
}).strict();
export type CreateCriterionVersionInput = z.infer<typeof CreateCriterionVersionInputSchema>;

export const EvaluatorSuiteApplicabilitySchema = z.object({
  kind: z.literal("all_items")
}).strict();
export type EvaluatorSuiteApplicability = z.infer<typeof EvaluatorSuiteApplicabilitySchema>;

export const EvaluatorSuiteTrialPlanSchema = z.object({
  kind: z.literal("independent_repetitions"),
  trialsPerItem: z.number().int().min(2).max(10)
}).strict();
export type EvaluatorSuiteTrialPlan = z.infer<typeof EvaluatorSuiteTrialPlanSchema>;

export const EvaluatorSuiteManifestMemberSchema = z.object({
  position: z.number().int().nonnegative(),
  criterionId: z.string().min(1),
  criterionVersionId: z.string().min(1),
  criterionName: z.string().min(1),
  criterionDefinition: z.string().min(1),
  criterionDigest: EvaluatorSuiteSha256DigestSchema,
  skillId: z.string().min(1),
  skillVersionId: z.string().min(1),
  skillDigest: EvaluatorSuiteSha256DigestSchema,
  outputContractDigest: EvaluatorSuiteSha256DigestSchema,
  applicability: EvaluatorSuiteApplicabilitySchema
}).strict();
export type EvaluatorSuiteManifestMember = z.infer<typeof EvaluatorSuiteManifestMemberSchema>;

export const EvaluatorSuiteManifestSchema = z.object({
  contract: z.literal("coeval/evaluator-suite-manifest/v1"),
  schemaVersion: z.literal(1),
  manifestId: z.string().min(1),
  suiteId: z.string().min(1),
  projectId: z.string().min(1),
  revision: z.number().int().positive(),
  members: z.array(EvaluatorSuiteManifestMemberSchema).min(1),
  trialPlan: EvaluatorSuiteTrialPlanSchema.nullable(),
  manifestDigest: EvaluatorSuiteSha256DigestSchema
}).strict();
export type EvaluatorSuiteManifest = z.infer<typeof EvaluatorSuiteManifestSchema>;

export const EvaluatorSuiteSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  createdByUserId: z.string().nullable(),
  createdAt: z.string()
}).strict();
export type EvaluatorSuite = z.infer<typeof EvaluatorSuiteSchema>;

export const EvaluatorSuiteManifestBindingSchema = z.object({
  criterionVersionId: UnicodeScalarValueSchema.min(1),
  skillVersionId: UnicodeScalarValueSchema.min(1)
}).strict();
export type EvaluatorSuiteManifestBinding = z.infer<typeof EvaluatorSuiteManifestBindingSchema>;

export const CreateEvaluatorSuiteManifestInputSchema = z.object({
  idempotencyKey: UnicodeScalarValueSchema.trim().min(1).max(200),
  suiteId: UnicodeScalarValueSchema.min(1).optional(),
  members: z.array(EvaluatorSuiteManifestBindingSchema).min(1).max(100),
  trialPlan: EvaluatorSuiteTrialPlanSchema.nullable().default(null)
}).strict();
export type CreateEvaluatorSuiteManifestInput = z.infer<typeof CreateEvaluatorSuiteManifestInputSchema>;

// Binary calibration v1 is a closed aggregate evidence contract. Counts are
// bounded by governed review's public 5,000-item selection cap, and every
// digest-covered number is an integer which is exactly representable by
// ECMAScript. Derived rates remain exact numerator/denominator pairs; Wilson
// bounds travel as their big-endian IEEE-754 binary64 bit patterns.
const BinaryCalibrationCountSchema = z.number().int().min(0).max(5_000);
const BinaryCalibrationPositiveCountSchema = z.number().int().min(1).max(5_000);
const BinaryCalibrationMetricComponentSchema = z.number().int().min(0).max(10_000);
const BinaryCalibrationSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const BinaryCalibrationNonEmptyStringSchema = z.string().min(1)
  .refine((value) => Array.from(value).length <= 4_096, {
    message: "Text must contain no more than 4,096 Unicode code points"
  })
  .refine((value) => !containsLoneUtf16Surrogate(value), {
    message: "Text must not contain an unpaired UTF-16 surrogate"
  });
const BinaryCalibrationCanonicalDecimalSchema = z.string().max(32).regex(
  /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/
);

export const BinaryCalibrationSha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const BinaryCalibrationBinary64BitsSchema = z.string().regex(/^[a-f0-9]{16}$/);
export const BinaryCalibrationUtcTimestampSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
);

export const BinaryCalibrationDefinedWilsonRateSchema = z.object({
  state: z.literal("defined"),
  numerator: BinaryCalibrationCountSchema,
  denominator: BinaryCalibrationPositiveCountSchema,
  interval: z.object({
    method: z.literal("wilson-score/v1"),
    confidenceBasisPoints: z.literal(9_500),
    lowerBinary64: BinaryCalibrationBinary64BitsSchema,
    upperBinary64: BinaryCalibrationBinary64BitsSchema
  }).strict()
}).strict();

export const BinaryCalibrationUndefinedWilsonRateSchema = z.object({
  state: z.literal("undefined"),
  numerator: z.literal(0),
  denominator: z.literal(0),
  undefinedReason: z.literal("zero_denominator"),
  interval: z.null()
}).strict();

export const BinaryCalibrationWilsonRateSchema = z.discriminatedUnion("state", [
  BinaryCalibrationDefinedWilsonRateSchema,
  BinaryCalibrationUndefinedWilsonRateSchema
]);
export type BinaryCalibrationWilsonRate = z.infer<typeof BinaryCalibrationWilsonRateSchema>;

export const BinaryCalibrationDefinedExactRateSchema = z.object({
  state: z.literal("defined"),
  numerator: BinaryCalibrationMetricComponentSchema,
  denominator: BinaryCalibrationMetricComponentSchema.refine((value) => value > 0)
}).strict();

export const BinaryCalibrationUndefinedExactRateSchema = z.object({
  state: z.literal("undefined"),
  numerator: BinaryCalibrationMetricComponentSchema,
  denominator: BinaryCalibrationMetricComponentSchema,
  undefinedReason: z.enum(["zero_denominator", "no_positive_truth_support"])
}).strict();

export const BinaryCalibrationExactRateSchema = z.discriminatedUnion("state", [
  BinaryCalibrationDefinedExactRateSchema,
  BinaryCalibrationUndefinedExactRateSchema
]);
export type BinaryCalibrationExactRate = z.infer<typeof BinaryCalibrationExactRateSchema>;

export const BinaryCalibrationOutcomeCountsSchema = z.object({
  classified: BinaryCalibrationCountSchema,
  abstained: BinaryCalibrationCountSchema,
  errored: BinaryCalibrationCountSchema,
  unevaluated: BinaryCalibrationCountSchema
}).strict();
export type BinaryCalibrationOutcomeCounts = z.infer<typeof BinaryCalibrationOutcomeCountsSchema>;

export const BinaryCalibrationMatrixSchema = z.object({
  truthPassEvaluatorPass: BinaryCalibrationCountSchema,
  truthPassEvaluatorFail: BinaryCalibrationCountSchema,
  truthFailEvaluatorPass: BinaryCalibrationCountSchema,
  truthFailEvaluatorFail: BinaryCalibrationCountSchema
}).strict();
export type BinaryCalibrationMatrix = z.infer<typeof BinaryCalibrationMatrixSchema>;

export const BinaryCalibrationProviderIdentityStrengthSchema = z.enum([
  "observed_version",
  "observed_fingerprint",
  "observed_model",
  "requested_only"
]);
export type BinaryCalibrationProviderIdentityStrength = z.infer<
  typeof BinaryCalibrationProviderIdentityStrengthSchema
>;

export const BinaryCalibrationProviderIdentityGroupSchema = z.object({
  provider: BinaryCalibrationNonEmptyStringSchema,
  observedModel: BinaryCalibrationNonEmptyStringSchema.nullable(),
  observedVersion: BinaryCalibrationNonEmptyStringSchema.nullable(),
  systemFingerprint: BinaryCalibrationNonEmptyStringSchema.nullable(),
  identityStrength: BinaryCalibrationProviderIdentityStrengthSchema,
  observationCount: BinaryCalibrationPositiveCountSchema
}).strict();
export type BinaryCalibrationProviderIdentityGroup = z.infer<
  typeof BinaryCalibrationProviderIdentityGroupSchema
>;

export const BinaryCalibrationErrorCodeSchema = z.enum([
  "provider_unavailable",
  "provider_authentication",
  "provider_rate_limit",
  "provider_timeout",
  "provider_transport",
  "provider_protocol",
  "invalid_evaluator_output",
  "outcome_unknown",
  "internal"
]);
export type BinaryCalibrationErrorCode = z.infer<typeof BinaryCalibrationErrorCodeSchema>;

export const BinaryCalibrationPrivateProviderObservationSchema = z.object({
  provider: BinaryCalibrationNonEmptyStringSchema,
  observedModel: BinaryCalibrationNonEmptyStringSchema.nullable(),
  observedVersion: BinaryCalibrationNonEmptyStringSchema.nullable(),
  systemFingerprint: BinaryCalibrationNonEmptyStringSchema.nullable()
}).strict();
export type BinaryCalibrationPrivateProviderObservation = z.infer<
  typeof BinaryCalibrationPrivateProviderObservationSchema
>;

export const BinaryCalibrationPrivateLedgerRecordSchema = z.object({
  datasetRevisionItemDigest: BinaryCalibrationSha256DigestSchema,
  trialIndex: z.number().int().min(0).max(9),
  truthLabel: z.enum(["pass", "fail"]),
  terminalEvaluatorOutcome: z.enum([
    "evaluator_pass",
    "evaluator_fail",
    "abstained",
    "errored",
    "unevaluated"
  ]),
  attemptState: z.enum(["not_started", "started", "terminal"]),
  errorCode: BinaryCalibrationErrorCodeSchema.nullable(),
  physicalProviderCalls: BinaryCalibrationSafeIntegerSchema,
  providerObservation: BinaryCalibrationPrivateProviderObservationSchema,
  commitmentSalt: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export type BinaryCalibrationPrivateLedgerRecord = z.infer<
  typeof BinaryCalibrationPrivateLedgerRecordSchema
>;

export const BinaryCalibrationPrivateLedgerSchema = z.object({
  contract: z.literal("coeval/binary-calibration-private-ledger/v1"),
  schemaVersion: z.literal(1),
  canonicalizationVersion: z.literal("coeval-canonical-json/v1"),
  artifactId: BinaryCalibrationNonEmptyStringSchema,
  calibrationRunId: BinaryCalibrationNonEmptyStringSchema,
  projectId: BinaryCalibrationNonEmptyStringSchema,
  revisionDigest: BinaryCalibrationSha256DigestSchema,
  requestedProvider: BinaryCalibrationNonEmptyStringSchema,
  itemCount: BinaryCalibrationPositiveCountSchema,
  trialsPerItem: z.number().int().min(1).max(10),
  records: z.array(BinaryCalibrationPrivateLedgerRecordSchema).min(1).max(50_000)
}).strict();
export type BinaryCalibrationPrivateLedger = z.infer<typeof BinaryCalibrationPrivateLedgerSchema>;

export const BinaryCalibrationTrialSchema = z.object({
  trialIndex: z.number().int().min(0).max(9),
  status: z.enum(["complete", "incomplete"]),
  outcomes: z.object({
    planned: BinaryCalibrationPositiveCountSchema,
    classified: BinaryCalibrationCountSchema,
    abstained: BinaryCalibrationCountSchema,
    errored: BinaryCalibrationCountSchema,
    unevaluated: BinaryCalibrationCountSchema,
    providerCalls: BinaryCalibrationSafeIntegerSchema,
    byTruth: z.object({
      pass: BinaryCalibrationOutcomeCountsSchema,
      fail: BinaryCalibrationOutcomeCountsSchema
    }).strict(),
    errors: z.array(z.object({
      code: BinaryCalibrationErrorCodeSchema,
      count: BinaryCalibrationPositiveCountSchema
    }).strict()).max(9)
  }).strict(),
  confusionMatrix: BinaryCalibrationMatrixSchema,
  errorDirections: z.object({
    falsePass: BinaryCalibrationCountSchema,
    falseFail: BinaryCalibrationCountSchema
  }).strict(),
  metrics: z.object({
    accuracy: BinaryCalibrationWilsonRateSchema,
    truthPassRecall: BinaryCalibrationWilsonRateSchema,
    truthFailRecall: BinaryCalibrationWilsonRateSchema,
    positiveClassPrecision: BinaryCalibrationWilsonRateSchema,
    positiveClassRecall: BinaryCalibrationWilsonRateSchema,
    positiveClassF1: BinaryCalibrationExactRateSchema,
    classifiedCoverage: z.object({
      overall: BinaryCalibrationWilsonRateSchema,
      truthPass: BinaryCalibrationWilsonRateSchema,
      truthFail: BinaryCalibrationWilsonRateSchema
    }).strict()
  }).strict(),
  providerIdentityGroups: z.array(BinaryCalibrationProviderIdentityGroupSchema).min(1).max(5_000)
}).strict();
export type BinaryCalibrationTrial = z.infer<typeof BinaryCalibrationTrialSchema>;

export const BinaryCalibrationCompletionEligibilityReasonSchema = z.enum([
  "authorization_snapshot_changed",
  "development_exposure_detected",
  "evaluator_reuse_ineligible",
  "exposure_state_unknown"
]);
export type BinaryCalibrationCompletionEligibilityReason = z.infer<
  typeof BinaryCalibrationCompletionEligibilityReasonSchema
>;

export const BinaryCalibrationIncompleteReasonSchema = z.enum([
  "trial_incomplete",
  "completion_exposure_exposed",
  "completion_exposure_ineligible"
]);
export type BinaryCalibrationIncompleteReason = z.infer<typeof BinaryCalibrationIncompleteReasonSchema>;

export const BinaryCalibrationRepresentativeIneligibleReasonSchema = z.enum([
  "selection_method_not_eligible",
  "population_frame_incomplete",
  "collection_provenance_unverified",
  "draw_not_server_executed",
  "draw_not_reproducible",
  "fixed_budget_mismatch",
  "strata_incomplete",
  "review_coverage_incomplete",
  "deferred_assignments",
  "cannot_determine_present",
  "unresolved_items"
]);
export type BinaryCalibrationRepresentativeIneligibleReason = z.infer<
  typeof BinaryCalibrationRepresentativeIneligibleReasonSchema
>;

export const BinaryCalibrationArtifactSchema = z.object({
  contract: z.literal("coeval/binary-calibration/v1"),
  schemaVersion: z.literal(1),
  canonicalizationVersion: z.literal("coeval-canonical-json/v1"),
  artifactId: BinaryCalibrationNonEmptyStringSchema,
  calibrationRunId: BinaryCalibrationNonEmptyStringSchema,
  projectId: BinaryCalibrationNonEmptyStringSchema,
  lineage: z.object({
    artifactRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    predecessorArtifactId: BinaryCalibrationNonEmptyStringSchema.nullable(),
    correctionReason: BinaryCalibrationNonEmptyStringSchema.nullable()
  }).strict(),
  status: z.enum(["complete", "incomplete"]),
  incompleteReasons: z.array(BinaryCalibrationIncompleteReasonSchema).max(3),
  createdAt: BinaryCalibrationUtcTimestampSchema,
  startedAt: BinaryCalibrationUtcTimestampSchema,
  completedAt: BinaryCalibrationUtcTimestampSchema,
  criterion: z.object({
    criterionId: BinaryCalibrationNonEmptyStringSchema,
    criterionVersionId: BinaryCalibrationNonEmptyStringSchema,
    criterionDigest: BinaryCalibrationSha256DigestSchema
  }).strict(),
  evaluator: z.object({
    skillId: BinaryCalibrationNonEmptyStringSchema,
    skillVersionId: BinaryCalibrationNonEmptyStringSchema,
    skillDigest: BinaryCalibrationSha256DigestSchema,
    outputContractDigest: BinaryCalibrationSha256DigestSchema,
    requestedModelBinding: z.object({
      provider: BinaryCalibrationNonEmptyStringSchema,
      modelId: BinaryCalibrationNonEmptyStringSchema,
      modelVersion: BinaryCalibrationNonEmptyStringSchema,
      temperatureDecimal: BinaryCalibrationCanonicalDecimalSchema,
      topPDecimal: BinaryCalibrationCanonicalDecimalSchema.nullable(),
      endpointKind: z.enum(["managed", "custom"]),
      baseUrlDigest: BinaryCalibrationSha256DigestSchema.nullable(),
      requestedBindingDigest: BinaryCalibrationSha256DigestSchema
    }).strict()
  }).strict(),
  suiteBinding: z.object({
    manifestId: BinaryCalibrationNonEmptyStringSchema,
    manifestDigest: BinaryCalibrationSha256DigestSchema,
    memberPosition: z.number().int().min(0).max(99)
  }).strict().nullable(),
  truth: z.object({
    datasetRevisionId: BinaryCalibrationNonEmptyStringSchema,
    revisionDigest: BinaryCalibrationSha256DigestSchema,
    contentDigest: BinaryCalibrationSha256DigestSchema,
    itemCount: BinaryCalibrationPositiveCountSchema,
    role: z.literal("sealed_validation"),
    sourceKind: z.literal("sealed_intake"),
    provenanceLevel: z.literal("governed_blind"),
    semanticLeakageDetection: z.literal("unsupported"),
    representativeOfPopulationId: BinaryCalibrationNonEmptyStringSchema.nullable(),
    representativeIneligibleReasons: z.array(BinaryCalibrationRepresentativeIneligibleReasonSchema).max(11),
    selectionMethod: z.enum([
      "simple_random",
      "systematic",
      "stratified_random",
      "convenience",
      "uncertainty",
      "failure_hunting",
      "manual"
    ]),
    origin: z.object({
      governedReviewBatchId: BinaryCalibrationNonEmptyStringSchema,
      governedReviewBatchDigest: BinaryCalibrationSha256DigestSchema,
      reviewInstructionVersionId: BinaryCalibrationNonEmptyStringSchema,
      reviewInstructionDigest: BinaryCalibrationSha256DigestSchema,
      populationId: BinaryCalibrationNonEmptyStringSchema,
      populationDigest: BinaryCalibrationSha256DigestSchema,
      drawDigest: BinaryCalibrationSha256DigestSchema
    }).strict()
  }).strict(),
  exposure: z.object({
    authorization: z.object({
      state: z.literal("protected"),
      snapshotDigest: BinaryCalibrationSha256DigestSchema,
      eventId: BinaryCalibrationNonEmptyStringSchema,
      recordedAt: BinaryCalibrationUtcTimestampSchema
    }).strict(),
    completion: z.object({
      state: z.enum(["protected", "exposed"]),
      snapshotDigest: BinaryCalibrationSha256DigestSchema,
      eventId: BinaryCalibrationNonEmptyStringSchema,
      recordedAt: BinaryCalibrationUtcTimestampSchema,
      eligibility: z.object({
        result: z.enum(["eligible", "ineligible"]),
        reasons: z.array(BinaryCalibrationCompletionEligibilityReasonSchema).max(4)
      }).strict()
    }).strict()
  }).strict(),
  execution: z.object({
    definitionVersion: z.literal("sealed-binary-calibration-execution/v1"),
    providerDataHandling: z.object({
      executionEnvironment: z.enum(["external_provider", "self_hosted_provider", "local_provider"]),
      policyId: BinaryCalibrationNonEmptyStringSchema,
      policyDigest: BinaryCalibrationSha256DigestSchema,
      payloadTransmission: z.literal("sealed_payload_to_pinned_provider")
    }).strict()
  }).strict(),
  positiveClass: z.enum(["pass", "fail"]),
  errorDirectionDefinitions: z.object({
    falsePass: z.literal("evaluator_pass_when_truth_fail"),
    falseFail: z.literal("evaluator_fail_when_truth_pass")
  }).strict(),
  metricDefinitionVersion: z.literal("binary-classification/v1"),
  intervalDefinitionVersion: z.literal("wilson-score/v1"),
  trialPlan: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("single"),
      trialsPerItem: z.literal(1)
    }).strict(),
    z.object({
      kind: z.literal("independent_repetitions"),
      trialsPerItem: z.number().int().min(2).max(10)
    }).strict()
  ]),
  truthSupport: z.object({
    total: BinaryCalibrationPositiveCountSchema,
    pass: BinaryCalibrationCountSchema,
    fail: BinaryCalibrationCountSchema
  }).strict(),
  privateLedger: z.object({
    contract: z.literal("coeval/binary-calibration-private-ledger/v1"),
    commitmentDigest: BinaryCalibrationSha256DigestSchema
  }).strict(),
  trials: z.array(BinaryCalibrationTrialSchema).min(1).max(10),
  evidenceDigest: BinaryCalibrationSha256DigestSchema
}).strict();
export type BinaryCalibrationArtifact = z.infer<typeof BinaryCalibrationArtifactSchema>;

// Product deploy gate (gate checks): the regression-gate idea pointed at the
// CUSTOMER'S product instead of the judge skill. Before deploying a new
// prompt/model/agent, the customer re-runs their product against the golden
// cases' inputs and submits the candidate outputs; Coeval judges each with the
// APPROVED skill version and compares the judged label against the golden
// set's historical human-approved label. A gate check persists identity + config and
// points at a regular eval run — its status is DERIVED from that run's
// counters (deriveGateCheckDecision below), never dual-written, so the eval
// run stays the single source of truth and no completion hook can drift.
// Deprecated: new integrations consume policy-free assessment receipts and
// make release decisions in their release layer.
export const GateCheckStatusSchema = z.enum(["pending", "running", "passed", "blocked", "error"]);
export type GateCheckStatus = z.infer<typeof GateCheckStatusSchema>;

// One candidate output, addressed at a golden case either by the case id
// (`goldenCaseId`) or by the golden entry's source trace id (`caseKey`) —
// the stable key CI pipelines usually carry.
export const GateCheckCandidateSchema = z.object({
  goldenCaseId: z.string().min(1).optional(),
  caseKey: z.string().min(1).optional(),
  output: z.unknown()
}).superRefine((candidate, ctx) => {
  if (!candidate.goldenCaseId && !candidate.caseKey) {
    ctx.addIssue({ code: "custom", message: "Each candidate needs goldenCaseId or caseKey" });
  }
  if (candidate.goldenCaseId && candidate.caseKey) {
    ctx.addIssue({ code: "custom", message: "Give goldenCaseId or caseKey, not both" });
  }
});
export type GateCheckCandidate = z.infer<typeof GateCheckCandidateSchema>;

export const CreateGateCheckRequestSchema = z.object({
  // One skill per project (locked decision) — when provided this must be the
  // project's skill; the gate always judges with its approved version.
  skillId: z.string().min(1).optional(),
  candidates: z.array(GateCheckCandidateSchema).min(1),
  // Free-form deploy label (e.g. a git sha) + metadata for CI traceability.
  label: z.string().trim().min(1).max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // The gate passes iff disagreements <= maxDisagreements (default 0).
  maxDisagreements: z.number().int().nonnegative().optional()
});
export type CreateGateCheckRequest = z.infer<typeof CreateGateCheckRequestSchema>;

export const GateCheckItemSchema = z.object({
  id: z.string(),
  gateCheckId: z.string(),
  goldenEntryId: z.string(),
  goldenCaseId: z.string(),
  // Snapshot of the golden entry's trace id at submission — the CI-facing key.
  caseKey: z.string(),
  // The derived case: golden input + candidate output, judged like any trace.
  candidateCaseId: z.string(),
  expectedLabel: VerdictLabelSchema.exclude(["ambiguous"]),
  status: z.enum(["pending", "completed", "failed"]),
  judgedLabel: z.string().nullable(),
  agreement: z.boolean().nullable(),
  // True when the candidate output was already judged by this skill version
  // (re-running an unchanged product spends nothing).
  cached: z.boolean(),
  error: z.string().nullable(),
  createdAt: z.string()
});
export type GateCheckItem = z.infer<typeof GateCheckItemSchema>;

export const GateCheckSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  skillVersionId: z.string(),
  evalRunId: z.string(),
  label: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  maxDisagreements: z.number().int().nonnegative(),
  status: GateCheckStatusSchema,
  totalCandidates: z.number().int().nonnegative(),
  judgedCandidates: z.number().int().nonnegative(),
  erroredCandidates: z.number().int().nonnegative(),
  disagreements: z.number().int().nonnegative(),
  createdAt: z.string(),
  finishedAt: z.string().nullable()
});
export type GateCheck = z.infer<typeof GateCheckSchema>;

export const GateCheckDetailSchema = GateCheckSchema.extend({
  items: z.array(GateCheckItemSchema)
});
export type GateCheckDetail = z.infer<typeof GateCheckDetailSchema>;

// The gate decision as a pure projection of the linked eval run's counters.
// Every gate item carries an expected label, so agreement is defined for every
// completed item: disagreements = completed - agreed.
//
// Locked invariant — infrastructure failures must NEVER masquerade as passing
// gates: a failed run, a canceled run, or ANY failed item is 'error', never
// 'passed' (and never 'blocked' either — an un-judged deploy is unknown, not
// regressed).
export function deriveGateCheckDecision(input: {
  runStatus: EvalRunStatus;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  agreedItems: number;
  maxDisagreements: number;
}): { status: GateCheckStatus; disagreements: number } {
  const disagreements = Math.max(0, input.completedItems - input.agreedItems);
  if (input.runStatus === "failed" || input.runStatus === "canceled") return { status: "error", disagreements };
  if (input.runStatus === "pending") return { status: "pending", disagreements };
  if (input.runStatus === "running") return { status: "running", disagreements };
  // Belt-and-braces: an unrecognized run status (schema drift, a bad cast)
  // must read as 'error' — it must never fall through to pass/blocked.
  if (input.runStatus !== "completed") return { status: "error", disagreements };
  // Run completed. Belt-and-braces: even if a run somehow completes with
  // fewer completed items than total, the shortfall reads as 'error'.
  if (input.failedItems > 0 || input.completedItems < input.totalItems) return { status: "error", disagreements };
  return { status: disagreements <= input.maxDisagreements ? "passed" : "blocked", disagreements };
}

export const TraceRedactionConfigSchema = z.object({
  excludedPaths: z.array(z.string().min(1).refine((path) => !/\[(?!\d+\]|\*\])/.test(path), {
    message: "Only numeric indexes like [0] and wildcards like [*] are supported in redaction paths"
  })).optional(),
  sensitiveKeyPatterns: z.array(z.string().min(1)).optional(),
  maxStringChars: z.number().int().positive().max(100_000).optional()
});
export type TraceRedactionConfig = z.infer<typeof TraceRedactionConfigSchema>;

export const LangSmithIntegrationInputSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  apiKey: z.string().min(1),
  projectName: z.string().min(1).optional(),
  endpointUrl: z.url().optional(),
  redaction: TraceRedactionConfigSchema.optional(),
  pollEnabled: z.boolean().optional(),
  pollIntervalSeconds: z.number().int().positive().max(86_400).optional(),
  pollLimit: z.number().int().positive().max(100).optional()
});
export type LangSmithIntegrationInput = z.infer<typeof LangSmithIntegrationInputSchema>;

export const UpdateLangSmithIntegrationInputSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  pollEnabled: z.boolean().optional(),
  pollIntervalSeconds: z.number().int().positive().max(86_400).optional(),
  pollLimit: z.number().int().positive().max(100).optional()
}).refine((input) => Object.keys(input).length > 0, {
  message: "At least one LangSmith integration setting is required"
});
export type UpdateLangSmithIntegrationInput = z.infer<typeof UpdateLangSmithIntegrationInputSchema>;

export const LangSmithConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  checkedAt: z.string(),
  sampleRunCount: z.number().int().nonnegative().optional(),
  status: z.number().int().positive().optional(),
  error: z.string().optional()
});
export type LangSmithConnectionTestResult = z.infer<typeof LangSmithConnectionTestResultSchema>;

export const LangSmithIntegrationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  provider: z.literal("langsmith"),
  skillVersionId: z.string().nullable(),
  projectName: z.string().nullable(),
  endpointUrl: z.string().nullable(),
  pollEnabled: z.boolean(),
  pollIntervalSeconds: z.number().int().positive(),
  pollLimit: z.number().int().positive().max(100),
  lastTestedAt: z.string().nullable(),
  lastTestResult: LangSmithConnectionTestResultSchema.nullable(),
  createdAt: z.string()
});
export type LangSmithIntegration = z.infer<typeof LangSmithIntegrationSchema>;

export const LangfuseIntegrationInputSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  publicKey: z.string().min(1),
  secretKey: z.string().min(1),
  endpointUrl: z.url().optional(),
  redaction: TraceRedactionConfigSchema.optional(),
  pollEnabled: z.boolean().optional(),
  pollIntervalSeconds: z.number().int().positive().max(86_400).optional(),
  pollLimit: z.number().int().positive().max(100).optional()
});
export type LangfuseIntegrationInput = z.infer<typeof LangfuseIntegrationInputSchema>;

export const UpdateLangfuseIntegrationInputSchema = UpdateLangSmithIntegrationInputSchema;
export type UpdateLangfuseIntegrationInput = z.infer<typeof UpdateLangfuseIntegrationInputSchema>;

export const LangfuseConnectionTestResultSchema = LangSmithConnectionTestResultSchema;
export type LangfuseConnectionTestResult = z.infer<typeof LangfuseConnectionTestResultSchema>;

export const LangfuseIntegrationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  provider: z.literal("langfuse"),
  skillVersionId: z.string().nullable(),
  projectName: z.string().nullable(),
  endpointUrl: z.string().nullable(),
  pollEnabled: z.boolean(),
  pollIntervalSeconds: z.number().int().positive(),
  pollLimit: z.number().int().positive().max(100),
  lastTestedAt: z.string().nullable(),
  lastTestResult: LangfuseConnectionTestResultSchema.nullable(),
  createdAt: z.string()
});
export type LangfuseIntegration = z.infer<typeof LangfuseIntegrationSchema>;

export const IRONSIDE_EVALUATOR_PROTOCOL_VERSION = "ironside/evaluator/v1" as const;

export const IronsideEvaluatorContextSchema = z.object({
  protocolVersion: z.literal(IRONSIDE_EVALUATOR_PROTOCOL_VERSION),
  project: z.object({
    id: z.string().min(1),
    name: z.string().min(1)
  }),
  // Capability names are additive. Require the two native evaluator grants
  // in the client, but tolerate future unrelated capabilities on the key.
  capabilities: z.array(z.string().min(1)),
  settlement: z.object({
    kind: z.literal("quiet_period"),
    quietPeriodSeconds: z.number().int().nonnegative()
  })
});
export type IronsideEvaluatorContext = z.infer<typeof IronsideEvaluatorContextSchema>;

export const IronsideEvaluatorTraceSummarySchema = z.object({
  traceId: z.string().min(1),
  traceVersion: z.iso.datetime({ offset: true }),
  timestamp: z.iso.datetime({ offset: true }),
  name: z.string().nullable(),
  userId: z.string().nullable(),
  sessionId: z.string().nullable(),
  environment: z.string().nullable(),
  tags: z.array(z.string()),
  metadata: z.record(z.string(), z.string())
});
export type IronsideEvaluatorTraceSummary = z.infer<typeof IronsideEvaluatorTraceSummarySchema>;

export const IronsideEvaluatorTraceFeedSchema = z.object({
  protocolVersion: z.literal(IRONSIDE_EVALUATOR_PROTOCOL_VERSION),
  traces: z.array(IronsideEvaluatorTraceSummarySchema),
  nextCursor: z.string().min(1),
  hasMore: z.boolean()
});
export type IronsideEvaluatorTraceFeed = z.infer<typeof IronsideEvaluatorTraceFeedSchema>;

export interface IronsideEvaluatorObservationNode {
  id: string;
  parentObservationId?: string | null | undefined;
  type: string;
  name?: string | null | undefined;
  startTime: string;
  endTime?: string | null | undefined;
  level?: string | null | undefined;
  statusMessage?: string | null | undefined;
  model?: string | null | undefined;
  modelParameters?: Record<string, string> | undefined;
  input?: unknown;
  output?: unknown;
  usageDetails?: Record<string, number> | undefined;
  costDetails?: Record<string, number> | undefined;
  completionStartTime?: string | null | undefined;
  metadata?: Record<string, string> | undefined;
  children: IronsideEvaluatorObservationNode[];
}

export const IronsideEvaluatorObservationNodeSchema: z.ZodType<IronsideEvaluatorObservationNode> = z.lazy(() => z.object({
  id: z.string(),
  parentObservationId: z.string().nullish(),
  type: z.string(),
  name: z.string().nullish(),
  startTime: z.string(),
  endTime: z.string().nullish(),
  level: z.string().nullish(),
  statusMessage: z.string().nullish(),
  model: z.string().nullish(),
  modelParameters: z.record(z.string(), z.string()).optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  usageDetails: z.record(z.string(), z.number()).optional(),
  costDetails: z.record(z.string(), z.number()).optional(),
  completionStartTime: z.string().nullish(),
  metadata: z.record(z.string(), z.string()).optional(),
  children: z.array(IronsideEvaluatorObservationNodeSchema)
}));

export const IronsideEvaluatorTraceSchema = z.object({
  id: z.string().min(1),
  traceVersion: z.iso.datetime({ offset: true }),
  timestamp: z.iso.datetime({ offset: true }),
  name: z.string().nullable(),
  userId: z.string().nullable(),
  sessionId: z.string().nullable(),
  environment: z.string().nullable(),
  release: z.string().nullable(),
  version: z.string().nullable(),
  tags: z.array(z.string()),
  metadata: z.record(z.string(), z.string()),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  observations: z.array(IronsideEvaluatorObservationNodeSchema)
});
export type IronsideEvaluatorTrace = z.infer<typeof IronsideEvaluatorTraceSchema>;

// A native connection is one Ironside project plus a scoped machine key. The
// remote service owns settlement and exposes immutable trace versions; Coeval
// persists only the opaque continuation cursor it receives from that feed.
export const IronsideIntegrationInputSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  url: z.url(),
  apiKey: z.string().min(1),
  redaction: TraceRedactionConfigSchema.optional(),
  pollEnabled: z.boolean().optional(),
  pollIntervalSeconds: z.number().int().positive().max(86_400).optional(),
  pollLimit: z.number().int().positive().max(100).optional()
});
export type IronsideIntegrationInput = z.infer<typeof IronsideIntegrationInputSchema>;

export const UpdateIronsideIntegrationInputSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  url: z.url().optional(),
  apiKey: z.string().min(1).optional(),
  pollEnabled: z.boolean().optional(),
  pollIntervalSeconds: z.number().int().positive().max(86_400).optional(),
  pollLimit: z.number().int().positive().max(100).optional()
}).refine((input) => Object.keys(input).length > 0, {
  message: "At least one Ironside integration setting is required"
});
export type UpdateIronsideIntegrationInput = z.infer<typeof UpdateIronsideIntegrationInputSchema>;

export const IronsideConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  checkedAt: z.string(),
  status: z.number().int().positive().optional(),
  error: z.string().optional(),
  protocolVersion: z.literal(IRONSIDE_EVALUATOR_PROTOCOL_VERSION).optional(),
  remoteProjectId: z.string().min(1).optional(),
  remoteProjectName: z.string().min(1).optional()
});
export type IronsideConnectionTestResult = z.infer<typeof IronsideConnectionTestResultSchema>;

export const IronsideIntegrationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  provider: z.literal("ironside"),
  skillVersionId: z.string().nullable(),
  url: z.string(),
  remoteProjectId: z.string().min(1),
  remoteProjectName: z.string().min(1),
  protocolVersion: z.literal(IRONSIDE_EVALUATOR_PROTOCOL_VERSION),
  settlementQuietPeriodSeconds: z.number().int().nonnegative(),
  revalidationRequired: z.boolean(),
  pollEnabled: z.boolean(),
  pollIntervalSeconds: z.number().int().positive(),
  pollLimit: z.number().int().positive().max(100),
  lastTestedAt: z.string().nullable(),
  lastTestResult: IronsideConnectionTestResultSchema.nullable(),
  createdAt: z.string()
});
export type IronsideIntegration = z.infer<typeof IronsideIntegrationSchema>;

// The cursor is intentionally opaque: ordering, settlement, bootstrap and
// recovery remain Ironside concerns rather than duplicated Coeval policy.
export const IronsideSyncStateSchema = z.object({
  cursor: z.string().nullable()
});
export type IronsideSyncState = z.infer<typeof IronsideSyncStateSchema>;

export const LangSmithImportJobSchema = z.object({
  projectId: z.string(),
  integrationId: z.string(),
  skillVersionId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).default(25),
  importJobId: z.string().optional()
});
export type LangSmithImportJob = z.infer<typeof LangSmithImportJobSchema>;

export const LangSmithImportTargetSchema = z.object({
  projectId: z.string(),
  integrationId: z.string(),
  skillVersionId: z.string().min(1),
  limit: z.number().int().positive().max(100)
});
export type LangSmithImportTarget = z.infer<typeof LangSmithImportTargetSchema>;

export const LangSmithImportRequestSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).default(25)
});
export type LangSmithImportRequest = z.infer<typeof LangSmithImportRequestSchema>;

export const LangfuseImportJobSchema = LangSmithImportJobSchema;
export type LangfuseImportJob = z.infer<typeof LangfuseImportJobSchema>;

export const LangfuseImportTargetSchema = LangSmithImportTargetSchema;
export type LangfuseImportTarget = z.infer<typeof LangfuseImportTargetSchema>;

export const LangfuseImportRequestSchema = LangSmithImportRequestSchema;
export type LangfuseImportRequest = z.infer<typeof LangfuseImportRequestSchema>;

export const IronsideImportJobSchema = LangSmithImportJobSchema;
export type IronsideImportJob = z.infer<typeof IronsideImportJobSchema>;

export const IronsideImportTargetSchema = LangSmithImportTargetSchema;
export type IronsideImportTarget = z.infer<typeof IronsideImportTargetSchema>;

export const IronsideImportRequestSchema = LangSmithImportRequestSchema;
export type IronsideImportRequest = z.infer<typeof IronsideImportRequestSchema>;

export const ImportJobStatusSchema = z.enum(["queued", "running", "completed", "failed"]);
export type ImportJobStatus = z.infer<typeof ImportJobStatusSchema>;

export const ImportJobRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  source: TraceSourceSchema,
  sourceIntegrationId: z.string().nullable(),
  // Null only for a terminal failed scheduling attempt that could not select
  // one evaluator safely (for example an unconfigured multi-criterion poller).
  skillVersionId: z.string().min(1).nullable(),
  actorUserId: z.string().nullable(),
  actorEmail: z.string().nullable(),
  actorName: z.string().nullable(),
  queueJobId: z.string().nullable(),
  status: ImportJobStatusSchema,
  requestedLimit: z.number().int().positive().nullable(),
  importedCount: z.number().int().nonnegative(),
  queuedJudgeCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  error: z.string().nullable()
});
export type ImportJobRecord = z.infer<typeof ImportJobRecordSchema>;

export const LangSmithImportEnqueueResultSchema = z.object({
  queued: z.boolean(),
  queueJobId: z.string().nullable(),
  importJob: ImportJobRecordSchema
});
export type LangSmithImportEnqueueResult = z.infer<typeof LangSmithImportEnqueueResultSchema>;

export const LangfuseImportEnqueueResultSchema = LangSmithImportEnqueueResultSchema;
export type LangfuseImportEnqueueResult = z.infer<typeof LangfuseImportEnqueueResultSchema>;

export const IronsideImportEnqueueResultSchema = LangSmithImportEnqueueResultSchema;
export type IronsideImportEnqueueResult = z.infer<typeof IronsideImportEnqueueResultSchema>;

export const JudgeRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  caseId: z.string(),
  skillVersionId: z.string(),
  verdict: VerdictLabelSchema,
  score: z.number().min(0).max(1),
  reasoning: z.string(),
  // Wall-clock duration of the provider call when the provider execution path
  // captures it; other current run sources may not report a duration.
  latencyMs: z.number().int().nonnegative().optional(),
  // Provider-observed response identity. Null fields mean the provider did
  // not report that datum; this is distinct from the requested model binding.
  providerMetadata: ProviderResponseMetadataSchema.optional(),
  createdAt: z.string()
});
export type JudgeRun = z.infer<typeof JudgeRunSchema>;

// the case's dataset expectations — YOUR labels (never reviews),
// listed per dataset because a case can sit in several with different labels;
// showing all of them beats silently picking one.
export const CaseDatasetExpectationSchema = z.object({
  datasetName: z.string(),
  expectedLabel: VerdictLabelSchema.exclude(["ambiguous"]).nullable(),
  expectedFailStep: z.number().int().nonnegative().nullable()
});
export type CaseDatasetExpectation = z.infer<typeof CaseDatasetExpectationSchema>;

export const GoldenSetEntrySchema = z.object({
  id: z.string(),
  caseId: z.string(),
  traceId: z.string(),
  agreedLabel: VerdictLabelSchema.exclude(["ambiguous"]),
  reason: z.string(),
  promotedBy: z.string(),
  promotedAt: z.string(),
  sourceSkillVersionId: z.string(),
  criterionVersionId: z.string()
});
export type GoldenSetEntry = z.infer<typeof GoldenSetEntrySchema>;

export const ExceptionDetailSchema = z.object({
  exception: ExceptionCaseSchema,
  trace: TracePayloadSchema,
  judgeRun: JudgeRunSchema,
  datasetExpectations: z.array(CaseDatasetExpectationSchema),
  // Label of the latest human or adjudicated verdict on the case, when one
  // exists. Review surfaces must prefer this over the judge's label anywhere
  // a human decision is being frozen (golden-set promotion) — a recorded
  // override outranks the verdict it overrode.
  latestHumanLabel: VerdictLabelSchema.nullish(),
  // Append-only legacy decision evidence shown on the case: evaluator outputs
  // plus human and owner rulings. The effective human ruling is projected with
  // effectiveHumanVerdict; callers must not silently treat an evaluator output
  // or a later plain-human row as outranking an owner adjudication.
  verdictHistory: z.array(VerdictRecordSchema),
  // Active regression reference for this exact case and criterion, when one
  // exists. This is intentionally separate from the human-ruling evidence.
  goldenSetEntry: GoldenSetEntrySchema.nullable(),
  rawRequest: z.unknown().optional(),
  rawResponse: z.unknown().optional()
});
export type ExceptionDetail = z.infer<typeof ExceptionDetailSchema>;

// Single-sourced cap for project-scope verdict listing: the web's audit-trail
// page requests exactly this, and the API validates against it — sharing the
// constant keeps a client bump from turning into a 400 on the whole screen.
export const VERDICT_LIST_MAX_LIMIT = 500;

export const GOLDEN_SET_REASON_MAX_LENGTH = 1000;

export const PromoteGoldenSetInputSchema = z.object({
  skillVersionId: z.string().min(1).optional(),
  agreedLabel: VerdictLabelSchema.exclude(["ambiguous"]),
  reason: z.string().min(1).max(GOLDEN_SET_REASON_MAX_LENGTH)
});
export type PromoteGoldenSetInput = z.infer<typeof PromoteGoldenSetInputSchema>;

export const RetireGoldenSetEntryInputSchema = z.object({
  reason: z.string().min(1).max(GOLDEN_SET_REASON_MAX_LENGTH).optional()
});
export type RetireGoldenSetEntryInput = z.infer<typeof RetireGoldenSetEntryInputSchema>;

export const GoldenSetRetirementContextSchema = z.object({
  retiredAt: z.string().nullable(),
  retiredByUserId: z.string().nullable(),
  retiredBy: z.string().nullable(),
  reason: z.string().nullable()
});
export type GoldenSetRetirementContext = z.infer<typeof GoldenSetRetirementContextSchema>;

export const JudgeRunJobSchema = z.object({
  projectId: z.string(),
  caseId: z.string(),
  skillVersionId: z.string().optional(),
  evalRunId: z.string().optional(),
  evalRunItemId: z.string().optional()
}).superRefine((value, context) => {
  if ((value.evalRunId === undefined) !== (value.evalRunItemId === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "evalRunId and evalRunItemId must be supplied together"
    });
  }
});
export type JudgeRunJob = z.infer<typeof JudgeRunJobSchema>;

export const FeedbackSyncJobSchema = z.object({
  projectId: z.string(),
  feedbackSyncJobId: z.string()
});
export type FeedbackSyncJob = z.infer<typeof FeedbackSyncJobSchema>;

// eval.run fans out one eval.item per pending run item; each item job judges
// one case via judgeAndRecord and atomically updates the run's counters.
// gate.run payload (M0 C5): executes the golden-set regression gate for a
// pending (calibrating) skill version asynchronously. timeScope rides along so
// the worker can create the existing/both backfill EvalRun AFTER the gate
// outcome is known (a blocked version must never judge traffic).
export const GateRunJobSchema = z.object({
  projectId: z.string(),
  skillVersionId: z.string(),
  datasetRevisionId: z.string(),
  overrideReason: z.string().optional(),
  actorUserId: z.string().optional(),
  timeScope: z.enum(["new", "existing", "both"])
});
export type GateRunJob = z.infer<typeof GateRunJobSchema>;

export const EvalRunJobSchema = z.object({
  projectId: z.string(),
  evalRunId: z.string()
});
export type EvalRunJob = z.infer<typeof EvalRunJobSchema>;

export const EvalItemJobSchema = z.object({
  projectId: z.string(),
  evalRunId: z.string(),
  evalRunItemId: z.string(),
  caseId: z.string(),
  skillVersionId: z.string()
});
export type EvalItemJob = z.infer<typeof EvalItemJobSchema>;

export const FeedbackSyncStatusSchema = z.enum(["pending", "sending", "synced", "failed"]);
export type FeedbackSyncStatus = z.infer<typeof FeedbackSyncStatusSchema>;

export const FeedbackSyncJobListItemSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  judgeRunId: z.string(),
  provider: z.enum(["langsmith", "langfuse", "ironside"]),
  status: FeedbackSyncStatusSchema,
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  createdAt: z.string()
});
export type FeedbackSyncJobListItem = z.infer<typeof FeedbackSyncJobListItemSchema>;

export const GOLDEN_SET_STALE_AFTER_DAYS = 90;

export const GoldenSetHealthStatusSchema = z.enum(["healthy", "needs_action"]);
export type GoldenSetHealthStatus = z.infer<typeof GoldenSetHealthStatusSchema>;

export const GoldenSetHealthEntrySchema = z.object({
  id: z.string(),
  traceId: z.string(),
  agreedLabel: VerdictLabelSchema.exclude(["ambiguous"]),
  promotedAt: z.string(),
  ageDays: z.number().int().nonnegative(),
  reason: z.string()
});
export type GoldenSetHealthEntry = z.infer<typeof GoldenSetHealthEntrySchema>;

export const GoldenSetDuplicateGroupSchema = z.object({
  traceId: z.string(),
  entryCount: z.number().int().min(2),
  entries: z.array(GoldenSetHealthEntrySchema)
});
export type GoldenSetDuplicateGroup = z.infer<typeof GoldenSetDuplicateGroupSchema>;

export const GoldenSetHealthSummarySchema = z.object({
  projectId: z.string(),
  status: GoldenSetHealthStatusSchema,
  totalActive: z.number().int().nonnegative(),
  // Server-authoritative threshold; can become project-specific without changing clients.
  staleAfterDays: z.number().int().positive(),
  staleCount: z.number().int().nonnegative(),
  freshCount: z.number().int().nonnegative(),
  passCount: z.number().int().nonnegative(),
  failCount: z.number().int().nonnegative(),
  oldestPromotedAt: z.string().nullable(),
  newestPromotedAt: z.string().nullable(),
  staleEntries: z.array(GoldenSetHealthEntrySchema),
  duplicateCount: z.number().int().nonnegative(),
  duplicateGroups: z.array(GoldenSetDuplicateGroupSchema),
  recommendations: z.array(z.string())
});
export type GoldenSetHealthSummary = z.infer<typeof GoldenSetHealthSummarySchema>;

// the trust digest — four recorded-evidence signals + drift nudges.
// Every signal is one signal among several (never composited); empty states
// are explicit "no signal yet" facts, never fabricated numbers.
export const TrustNudgeSchema = z.object({
  signal: z.enum(["golden_health", "judge_human_kappa", "self_consistency"]),
  // A recorded-evidence sentence with counts.
  sentence: z.string(),
  // What would prove this wrong — the falsifier travels with the nudge.
  falsifier: z.string()
});
export type TrustNudge = z.infer<typeof TrustNudgeSchema>;

export const TrustDigestSpendSchema = z.object({
  // The aggregation window constant, echoed so the UI never hardcodes it.
  windowRuns: z.number().int().positive(),
  runsCounted: z.number().int().nonnegative(),
  freshItems: z.number().int().nonnegative(),
  cachedItems: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  usageMissingCount: z.number().int().nonnegative()
});
export type TrustDigestSpend = z.infer<typeof TrustDigestSpendSchema>;

export const TrustDigestSchema = z.object({
  generatedAt: z.string(),
  skillVersionId: z.string(),
  version: z.string(),
  goldenSetHealth: GoldenSetHealthSummarySchema,
  // κ pairs for the CURRENT version's judge rater vs each human (A2.2c:
  // pinned to the version, never latest-wins).
  judgeHumanKappa: z.array(z.object({
    humanRater: z.string(),
    kappa: z.number(),
    interpretation: KappaInterpretationSchema,
    cases: z.number().int().nonnegative()
  })),
  selfConsistency: SelfConsistencyReportSchema,
  spend: TrustDigestSpendSchema,
  nudges: z.array(TrustNudgeSchema),
  // "No signal yet" facts for absent signals — explicit, never implied.
  noSignal: z.array(z.string())
});
export type TrustDigest = z.infer<typeof TrustDigestSchema>;


export const DashboardSummarySchema = z.object({
  project: ProjectSchema,
  skill: SkillSchema,
  // Exact successful coverage for the evaluator version shown in `skill`.
  // `project.autoJudgedTraceCount` is intentionally historical/project-wide
  // and cannot prove that this version has produced a Result.
  currentVersionResultCount: z.number().int().nonnegative(),
  verdictDistribution: VerdictDistributionSchema,
  exceptions: z.array(ExceptionCaseSchema),
  topCapabilityGaps: z.array(CapabilityGapSchema),
  goldenSetSize: z.number().int().nonnegative(),
  // Lets owner-only affordances (agent pairing) hide from members instead of
  // rendering a guaranteed-403 card.
  viewerRole: z.enum(["owner", "member"])
});
export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;

// time-scope on skill edits. Per Langfuse's evaluator time-scope
// (docs/08, high-priority borrow #5). "new" is the product default.
// "existing" + "both" create one durable backfill EvalRun over project cases
// against the new skill version.
export const SkillVersionTimeScopeSchema = z.enum(["new", "existing", "both"]);
export type SkillVersionTimeScope = z.infer<typeof SkillVersionTimeScopeSchema>;

export const CreateSkillVersionInputSchema = z
  .object({
    criterionVersionId: z.string().min(1).optional(),
    rubricMarkdown: z.string().min(1),
    prompt: z.string().min(1),
    modelBinding: ModelBindingInputSchema,
    outputSchema: JsonSchemaSchema.default(MinimumVerdictOutputSchema),
    verdictKind: VerdictKindSchema.default("binary"),
    scalarRange: z.tuple([z.number(), z.number()]).optional(),
    categoricalChoiceScores: z.record(z.string(), z.number().min(0).max(1)).optional(),
    timeScope: SkillVersionTimeScopeSchema.default("new"),
    overrideReason: z.string().optional()
  })
  .refine((value) => !containsLoneUtf16Surrogate(value), {
    message: "Evaluator input must not contain an unpaired UTF-16 surrogate"
  })
  .refine(
    (v) => v.verdictKind !== "scalar" || (v.scalarRange !== undefined && v.scalarRange[0] < v.scalarRange[1]),
    { message: "scalar skill versions require an ascending scalarRange" }
  )
  .refine(
    (v) => v.verdictKind !== "categorical" || (v.categoricalChoiceScores !== undefined && Object.keys(v.categoricalChoiceScores).length > 0),
    { message: "categorical skill versions require a non-empty categoricalChoiceScores map" }
  )
  .refine((v) => v.verdictKind === "scalar" || v.scalarRange === undefined, { message: "scalarRange is only valid for scalar kinds" })
  .refine((v) => v.verdictKind === "categorical" || v.categoricalChoiceScores === undefined, { message: "categoricalChoiceScores is only valid for categorical kinds" });
export type CreateSkillVersionInput = z.infer<typeof CreateSkillVersionInputSchema>;

// Beginner onboarding creates the first real Check over the project's seeded
// native criterion. The visible quality question and evaluator draft travel in
// one request so the repository can append the criterion definition and bind
// the evaluator version atomically. Ordinary evaluator edits keep using
// CreateSkillVersionInputSchema and cannot change criterion identity.
export const CreateOnboardingCheckInputSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(240),
  criterion: CreateCriterionVersionInputSchema,
  evaluator: CreateSkillVersionInputSchema
}).strict().superRefine((value, context) => {
  if (value.evaluator.criterionVersionId !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["evaluator", "criterionVersionId"],
      message: "Onboarding creates and binds its own criterion version"
    });
  }
  if (value.evaluator.overrideReason !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["evaluator", "overrideReason"],
      message: "Onboarding cannot override a regression result"
    });
  }
});
export type CreateOnboardingCheckInput = z.infer<typeof CreateOnboardingCheckInputSchema>;

// Exact, project-scoped inventory shown before the beginner creates a Check.
// Counts describe the customer Runs currently stored after ingestion
// redaction; they do not imply that missing fields can be reconstructed.
export const OnboardingEvidenceInventorySchema = z.object({
  runCount: z.number().int().nonnegative(),
  inputCount: z.number().int().nonnegative(),
  outputCount: z.number().int().nonnegative(),
  stepsCount: z.number().int().nonnegative(),
  metadataCount: z.number().int().nonnegative()
}).strict().superRefine((value, context) => {
  for (const field of ["inputCount", "outputCount", "stepsCount", "metadataCount"] as const) {
    if (value[field] > value.runCount) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `${field} cannot exceed runCount`
      });
    }
  }
});
export type OnboardingEvidenceInventory = z.infer<typeof OnboardingEvidenceInventorySchema>;

// Backfill summary returned alongside the regression run when timeScope is
// 'existing' or 'both'. This aggregate is retained for the synchronous demo
// response; the EvalRun is the authoritative lifecycle record.
export const SkillVersionBackfillSummarySchema = z.object({
  timeScope: SkillVersionTimeScopeSchema,
  cases: z.number().int().nonnegative(),
  enqueued: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative()
});
export type SkillVersionBackfillSummary = z.infer<typeof SkillVersionBackfillSummarySchema>;

// Per-case detail from a golden-set regression run. The gate's "teeth": a CI
// tool that says "3 cases regressed" without showing WHICH and HOW the verdict
// changed isn't usable CI. `change` classifies each compared case:
//   regress  — the new version disagrees with the golden-set agreed label
//   agree    — the new version still matches the agreed label
//   improve  — RESERVED: matched the agreed label where the PRIOR version did
//              not. Not emitted yet — computing it requires loading the previous
//              version's per-case verdict, which lands with the convergence loop
//              (roadmap A2). Until then every match is `agree`, not `improve`.
export const RegressionCaseChangeSchema = z.enum(["regress", "agree", "improve"]);
export type RegressionCaseChange = z.infer<typeof RegressionCaseChangeSchema>;

// Persisted + returned rationale is capped: the full judge reasoning already
// lives on the JudgeRun. The diff only needs a readable snippet, and an
// uncapped field × a 500-case golden set would bloat the JSONB row.
export const REGRESSION_RATIONALE_MAX_LENGTH = 280;

export const RegressionCaseDiffSchema = z.object({
  caseId: z.string(),
  traceId: z.string(),
  agreedLabel: VerdictLabelSchema.exclude(["ambiguous"]),
  newLabel: VerdictLabelSchema,
  change: RegressionCaseChangeSchema,
  rationale: z.string().max(REGRESSION_RATIONALE_MAX_LENGTH)
});
export type RegressionCaseDiff = z.infer<typeof RegressionCaseDiffSchema>;

// Direction split of a run's regressions. Golden labels are pass|fail only,
// so every regression is exactly one of: judge stricter than the team
// (agreed pass, judged fail), judge more lenient (agreed fail, judged pass),
// or judge hedging (judged ambiguous against either label). The three buckets
// sum to `regressed` — lumping them all into "strict" misreads lenient flips,
// which are the dangerous direction for a gate.
export function regressionDirectionCounts(cases: RegressionCaseDiff[]): {
  tooStrict: number;
  tooLenient: number;
  ambiguous: number;
} {
  let tooStrict = 0;
  let tooLenient = 0;
  let ambiguous = 0;
  for (const diff of cases) {
    if (diff.change !== "regress") continue;
    if (diff.newLabel === "ambiguous") ambiguous += 1;
    else if (diff.agreedLabel === "pass") tooStrict += 1;
    else tooLenient += 1;
  }
  return { tooStrict, tooLenient, ambiguous };
}

export const RegressionRunResultSchema = z.object({
  id: z.string(),
  skillVersionId: z.string(),
  datasetRevisionId: z.string(),
  status: z.enum(["passed", "blocked", "overridden", "error"]),
  compared: z.number().int().nonnegative(),
  regressed: z.number().int().nonnegative(),
  improved: z.number().int().nonnegative(),
  flipped: z.number().int().nonnegative(),
  overrideReason: z.string().optional(),
  error: z.string().nullable().optional(),
  goldenSetMissing: z.boolean(),
  // Per-case breakdown emitted for every current regression run.
  cases: z.array(RegressionCaseDiffSchema),
  createdAt: z.string()
});
export type RegressionRunResult = z.infer<typeof RegressionRunResultSchema>;

export const CreateOnboardingCheckResponseSchema = z.discriminatedUnion("queued", [
  z.object({
    criterionVersion: CriterionVersionSchema,
    version: SkillVersionSchema,
    regressionRun: z.null(),
    queued: z.literal(true)
  }).strict(),
  z.object({
    criterionVersion: CriterionVersionSchema,
    version: SkillVersionSchema,
    regressionRun: RegressionRunResultSchema,
    queued: z.literal(false)
  }).strict()
]);
export type CreateOnboardingCheckResponse = z.infer<typeof CreateOnboardingCheckResponseSchema>;

export const ApiErrorSchema = z.object({
  error: z.string(),
  details: z.unknown().optional()
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// Governed human truth (ADR-0008). These contracts are deliberately separate
// from the legacy verdict and annotation-queue shapes above: historical rows
// cannot be inferred to have been independently assigned or evaluator-blind.
const governedNonBlankString = (maxLength: number) => z.string()
  .min(1)
  .max(maxLength)
  .refine((value) => value.trim().length > 0, { message: "must contain non-whitespace content" });

export const GovernedReviewLabelValueSchema = z.enum(["pass", "fail", "cannot_determine"]);
export type GovernedReviewLabelValue = z.infer<typeof GovernedReviewLabelValueSchema>;

export const GovernedReviewActorSnapshotSchema = z.object({
  subjectId: z.string().min(1),
  roleAtReview: governedNonBlankString(100)
}).strict();
export type GovernedReviewActorSnapshot = z.infer<typeof GovernedReviewActorSnapshotSchema>;

export const GovernedReviewRoleIntentSchema = z.enum([
  "analysis_authoring",
  "iterative_development",
  "sealed_validation"
]);
export type GovernedReviewRoleIntent = z.infer<typeof GovernedReviewRoleIntentSchema>;

export const GovernedReviewSelectionMethodSchema = z.enum([
  "simple_random",
  "stratified_random",
  "systematic",
  "convenience",
  "uncertainty",
  "failure_hunting",
  "manual"
]);
export type GovernedReviewSelectionMethod = z.infer<typeof GovernedReviewSelectionMethodSchema>;

export const GovernedReviewInstructionVersionSchema = z.object({
  contract: z.literal("coeval/governed-review-instruction/v1"),
  schemaVersion: z.literal(1),
  instructionVersionId: z.string().min(1),
  projectId: z.string().min(1),
  criterionId: z.string().min(1),
  criterionVersionId: z.string().min(1),
  revision: z.number().int().positive(),
  predecessorInstructionVersionId: z.string().min(1).nullable(),
  title: governedNonBlankString(240),
  instructions: governedNonBlankString(100_000),
  failureCodeGuidance: z.string().max(50_000),
  allowedLabels: z.tuple([
    z.literal("pass"),
    z.literal("fail"),
    z.literal("cannot_determine")
  ]),
  instructionDigest: DatasetEvidenceDigestSchema,
  createdBySubjectId: z.string().min(1),
  createdAt: z.string().datetime({ offset: true })
}).strict();
export type GovernedReviewInstructionVersion = z.infer<typeof GovernedReviewInstructionVersionSchema>;

export const GovernedReviewItemSourceKindSchema = z.enum(["dataset_revision_item", "sealed_intake"]);
export type GovernedReviewItemSourceKind = z.infer<typeof GovernedReviewItemSourceKindSchema>;

// This is the complete reviewer-visible data surface. It is intentionally
// narrower than DatasetRevisionPayloadSnapshotSchema: source metadata and
// step metadata are never copied into governed review evidence.
export const GovernedReviewPayloadStepSchema = z.object({
  name: governedNonBlankString(200),
  input: z.json(),
  output: z.json()
}).strict();
export type GovernedReviewPayloadStep = z.infer<typeof GovernedReviewPayloadStepSchema>;

export const GovernedReviewPayloadSnapshotSchema = z.object({
  // The pure verifier additionally enforces a 2 MiB canonical JSON limit.
  input: z.json(),
  output: z.json(),
  steps: z.array(GovernedReviewPayloadStepSchema).max(1_000).optional()
}).strict();
export type GovernedReviewPayloadSnapshot = z.infer<typeof GovernedReviewPayloadSnapshotSchema>;

export const GovernedReviewItemSchema = z.object({
  contract: z.literal("coeval/governed-review-item/v1"),
  schemaVersion: z.literal(1),
  reviewItemId: z.string().min(1),
  projectId: z.string().min(1),
  sourceKind: GovernedReviewItemSourceKindSchema,
  sourceRevisionId: z.string().min(1).nullable(),
  sourceRevisionItemId: z.string().min(1).nullable(),
  sourceItemDigest: DatasetEvidenceDigestSchema.nullable(),
  sealedIntakePopulationId: z.string().min(1).nullable(),
  inputIdentityBasis: z.literal("input-identity/v1"),
  inputDigest: DatasetEvidenceDigestSchema,
  payloadSnapshot: GovernedReviewPayloadSnapshotSchema,
  itemDigest: DatasetEvidenceDigestSchema,
  createdAt: z.string().datetime({ offset: true })
}).strict().superRefine((value, ctx) => {
  if (value.sourceKind === "dataset_revision_item") {
    if (
      value.sourceRevisionId === null ||
      value.sourceRevisionItemId === null ||
      value.sourceItemDigest === null
    ) {
      ctx.addIssue({ code: "custom", path: ["sourceRevisionItemId"], message: "nonsealed review items require an exact immutable dataset revision item" });
    }
    if (value.sealedIntakePopulationId !== null) {
      ctx.addIssue({ code: "custom", path: ["sealedIntakePopulationId"], message: "nonsealed review items cannot name sealed intake" });
    }
  } else {
    if (value.sealedIntakePopulationId === null) {
      ctx.addIssue({ code: "custom", path: ["sealedIntakePopulationId"], message: "sealed review items require sealed intake identity" });
    }
    if (
      value.sourceRevisionId !== null ||
      value.sourceRevisionItemId !== null ||
      value.sourceItemDigest !== null
    ) {
      ctx.addIssue({ code: "custom", path: ["sourceRevisionItemId"], message: "sealed intake cannot bind an ordinary dataset revision item" });
    }
  }
});
export type GovernedReviewItem = z.infer<typeof GovernedReviewItemSchema>;

export const GovernedReviewSelectionStratumSchema = z.object({
  key: governedNonBlankString(240),
  definition: governedNonBlankString(20_000),
  populationSize: z.number().int().nonnegative(),
  membershipDigest: DatasetEvidenceDigestSchema,
  inclusionProbability: z.number().positive().max(1),
  weight: z.number().positive(),
  fixedBudget: z.number().int().nonnegative(),
  drawItemDigests: z.array(DatasetEvidenceDigestSchema).max(10_000),
  drawDigest: DatasetEvidenceDigestSchema
}).strict();
export type GovernedReviewSelectionStratum = z.infer<typeof GovernedReviewSelectionStratumSchema>;

export const GovernedReviewSelectionPlanSchema = z.object({
  contract: z.literal("coeval/governed-review-selection/v1"),
  schemaVersion: z.literal(1),
  method: GovernedReviewSelectionMethodSchema,
  sourcePopulationId: z.string().min(1),
  sourcePopulationDefinition: governedNonBlankString(20_000),
  timeWindow: z.object({
    startInclusive: z.string().datetime({ offset: true }),
    endExclusive: z.string().datetime({ offset: true })
  }).strict(),
  populationSize: z.number().int().positive(),
  populationDigest: DatasetEvidenceDigestSchema,
  collectionProvenance: z.json(),
  collectionProvenanceDigest: DatasetEvidenceDigestSchema,
  frozenFrameDigest: DatasetEvidenceDigestSchema,
  seed: z.string().min(1).nullable(),
  rngVersion: z.string().min(1).nullable(),
  selectionAlgorithmVersion: z.string().min(1).max(200),
  inclusionProbability: z.number().positive().max(1).nullable(),
  weight: z.number().positive().nullable(),
  fixedBudget: z.number().int().positive(),
  stoppingRule: z.literal("fixed"),
  drawExecutor: z.literal("coeval_server"),
  drawItemDigests: z.array(DatasetEvidenceDigestSchema).min(1).max(10_000),
  drawDigest: DatasetEvidenceDigestSchema,
  strata: z.array(GovernedReviewSelectionStratumSchema).max(1_000),
  selectionPlanDigest: DatasetEvidenceDigestSchema
}).strict();
export type GovernedReviewSelectionPlan = z.infer<typeof GovernedReviewSelectionPlanSchema>;

export const GovernedReviewBatchMemberSchema = z.object({
  reviewItemId: z.string().min(1),
  reviewItemDigest: DatasetEvidenceDigestSchema,
  servePosition: z.number().int().nonnegative(),
  taskIds: z.array(z.string().min(1)).min(1).max(20)
}).strict();
export type GovernedReviewBatchMember = z.infer<typeof GovernedReviewBatchMemberSchema>;

export const GovernedReviewBatchSchema = z.object({
  contract: z.literal("coeval/governed-review-batch/v1"),
  schemaVersion: z.literal(1),
  batchId: z.string().min(1),
  projectId: z.string().min(1),
  criterionId: z.string().min(1),
  criterionVersionId: z.string().min(1),
  instructionVersionId: z.string().min(1),
  instructionDigest: DatasetEvidenceDigestSchema,
  roleIntent: GovernedReviewRoleIntentSchema,
  sourcePopulationKind: z.enum(["dataset_revision", "analysis_promotion_handoff", "sealed_intake"]),
  selectionPlan: GovernedReviewSelectionPlanSchema,
  requiredIndependentLabels: z.number().int().positive().max(20),
  evaluatorBlind: z.boolean(),
  peerBlindUntilLabelingClosed: z.boolean(),
  separationOfDutiesRequired: z.boolean(),
  custodianSubjectId: z.string().min(1),
  custodianRoleAtReview: governedNonBlankString(100).nullable(),
  developmentIdentityStatus: z.enum(["resolved", "unknown"]),
  developmentCapabilitySubjectIds: z.array(z.string().min(1).max(240)).max(10_000),
  developmentExposureSubjectIds: z.array(z.string().min(1).max(240)).max(10_000),
  stateMachineVersion: z.literal("governed-review-state/v1"),
  idempotencyKey: z.string().min(1).max(200),
  requestDigest: DatasetEvidenceDigestSchema,
  members: z.array(GovernedReviewBatchMemberSchema).min(1).max(10_000),
  batchDigest: DatasetEvidenceDigestSchema,
  fixedStopAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true })
}).strict().superRefine((batch, ctx) => {
  const validSource = batch.roleIntent === "sealed_validation"
    ? batch.sourcePopulationKind === "sealed_intake"
    : batch.roleIntent === "iterative_development"
      ? batch.sourcePopulationKind === "dataset_revision"
      : batch.sourcePopulationKind !== "sealed_intake";
  if (!validSource) {
    ctx.addIssue({
      code: "custom",
      path: ["sourcePopulationKind"],
      message: "Governed review source kind must match its exact role intent"
    });
  }
});
export type GovernedReviewBatch = z.infer<typeof GovernedReviewBatchSchema>;

export const GovernedReviewTaskSchema = z.object({
  contract: z.literal("coeval/governed-review-task/v1"),
  schemaVersion: z.literal(1),
  taskId: z.string().min(1),
  projectId: z.string().min(1),
  batchId: z.string().min(1),
  reviewItemId: z.string().min(1),
  criterionVersionId: z.string().min(1),
  instructionVersionId: z.string().min(1),
  reviewerSubjectId: z.string().min(1),
  reviewerRoleAtReview: governedNonBlankString(100),
  assignmentOrdinal: z.number().int().nonnegative(),
  servePosition: z.number().int().nonnegative(),
  taskDigest: DatasetEvidenceDigestSchema,
  createdAt: z.string().datetime({ offset: true })
}).strict();
export type GovernedReviewTask = z.infer<typeof GovernedReviewTaskSchema>;

export const GovernedReviewLabelSchema = z.object({
  contract: z.literal("coeval/governed-review-label/v1"),
  schemaVersion: z.literal(1),
  labelId: z.string().min(1),
  projectId: z.string().min(1),
  batchId: z.string().min(1),
  taskId: z.string().min(1),
  reviewItemId: z.string().min(1),
  criterionVersionId: z.string().min(1),
  instructionVersionId: z.string().min(1),
  reviewerSubjectId: z.string().min(1),
  attemptNumber: z.number().int().positive(),
  replacesLabelId: z.string().min(1).nullable(),
  value: GovernedReviewLabelValueSchema,
  rationale: governedNonBlankString(20_000),
  failureCodes: z.array(governedNonBlankString(240)).max(100),
  blindViewDigest: DatasetEvidenceDigestSchema,
  labelDigest: DatasetEvidenceDigestSchema,
  submittedAt: z.string().datetime({ offset: true })
}).strict().superRefine((value, ctx) => {
  if (new Set(value.failureCodes).size !== value.failureCodes.length) {
    ctx.addIssue({ code: "custom", path: ["failureCodes"], message: "failure codes must be unique" });
  }
  if (value.attemptNumber === 1 && value.replacesLabelId !== null) {
    ctx.addIssue({ code: "custom", path: ["replacesLabelId"], message: "first label attempt cannot replace another label" });
  }
  if (value.attemptNumber > 1 && value.replacesLabelId === null) {
    ctx.addIssue({ code: "custom", path: ["replacesLabelId"], message: "replacement label attempts must name the withdrawn label" });
  }
});
export type GovernedReviewLabel = z.infer<typeof GovernedReviewLabelSchema>;

const GovernedReviewTaskEventBaseSchema = z.object({
  contract: z.literal("coeval/governed-review-task-event/v1"),
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  projectId: z.string().min(1),
  batchId: z.string().min(1),
  taskId: z.string().min(1),
  reviewItemId: z.string().min(1),
  criterionVersionId: z.string().min(1),
  instructionVersionId: z.string().min(1),
  sequence: z.number().int().positive(),
  stateVersion: z.number().int().positive(),
  expectedPreviousStateVersion: z.number().int().nonnegative(),
  actorSubjectId: z.string().min(1),
  actorRoleAtReview: governedNonBlankString(100),
  previousEventDigest: DatasetEvidenceDigestSchema.nullable(),
  eventDigest: DatasetEvidenceDigestSchema,
  occurredAt: z.string().datetime({ offset: true })
}).strict();

export const GovernedReviewTaskEventSchema = z.discriminatedUnion("type", [
  GovernedReviewTaskEventBaseSchema.extend({
    type: z.literal("viewed"),
    viewContractVersion: z.literal("coeval/governed-blind-task-view/v1"),
    canonicalizationVersion: z.literal("coeval-canonical-json/v1"),
    canonicalViewBytesBase64: z.string().min(1).max(2_796_204),
    viewDigest: DatasetEvidenceDigestSchema,
    exposureClass: z.literal("provenance"),
    activity: z.literal("governed_review")
  }).strict(),
  GovernedReviewTaskEventBaseSchema.extend({
    type: z.literal("deferred"),
    reason: governedNonBlankString(2_000)
  }).strict(),
  GovernedReviewTaskEventBaseSchema.extend({
    type: z.literal("resumed"),
    reason: governedNonBlankString(2_000).nullable()
  }).strict(),
  GovernedReviewTaskEventBaseSchema.extend({
    type: z.literal("label_submitted"),
    labelId: z.string().min(1)
  }).strict(),
  GovernedReviewTaskEventBaseSchema.extend({
    type: z.literal("label_withdrawn"),
    labelId: z.string().min(1),
    reason: governedNonBlankString(2_000)
  }).strict(),
  GovernedReviewTaskEventBaseSchema.extend({
    type: z.literal("expired"),
    reason: z.literal("fixed_stop_reached")
  }).strict()
]);
export type GovernedReviewTaskEvent = z.infer<typeof GovernedReviewTaskEventSchema>;

export const GovernedReviewBatchStateSchema = z.enum([
  "draft",
  "open",
  "labeling_closed",
  "alignment_open",
  "adjudicating",
  "resolved",
  "abandoned",
  "incomplete",
  "frozen"
]);
export type GovernedReviewBatchState = z.infer<typeof GovernedReviewBatchStateSchema>;

const GovernedReviewBatchEventBaseSchema = z.object({
  contract: z.literal("coeval/governed-review-batch-event/v1"),
  schemaVersion: z.literal(1),
  batchEventId: z.string().min(1),
  projectId: z.string().min(1),
  batchId: z.string().min(1),
  sequence: z.number().int().positive(),
  stateVersion: z.number().int().positive(),
  expectedPreviousStateVersion: z.number().int().nonnegative(),
  actorSubjectId: z.string().min(1),
  actorRoleAtReview: governedNonBlankString(100),
  previousEventDigest: DatasetEvidenceDigestSchema.nullable(),
  eventDigest: DatasetEvidenceDigestSchema,
  occurredAt: z.string().datetime({ offset: true })
}).strict();

export const GovernedReviewBatchEventSchema = z.discriminatedUnion("type", [
  GovernedReviewBatchEventBaseSchema.extend({ type: z.literal("opened") }).strict(),
  GovernedReviewBatchEventBaseSchema.extend({
    type: z.literal("labeling_closed"),
    activeLabelIds: z.array(z.string().min(1)).max(200_000),
    deferredTaskIds: z.array(z.string().min(1)).max(200_000),
    expiredTaskIds: z.array(z.string().min(1)).max(200_000),
    closedAtFixedStop: z.boolean()
  }).strict(),
  GovernedReviewBatchEventBaseSchema.extend({ type: z.literal("alignment_opened") }).strict(),
  GovernedReviewBatchEventBaseSchema.extend({ type: z.literal("adjudication_started") }).strict(),
  GovernedReviewBatchEventBaseSchema.extend({
    type: z.literal("resolved"),
    resolvedReviewItemIds: z.array(z.string().min(1)).min(1).max(10_000)
  }).strict(),
  GovernedReviewBatchEventBaseSchema.extend({
    type: z.literal("incomplete"),
    gapReviewItemIds: z.array(z.string().min(1)).min(1).max(10_000)
  }).strict(),
  GovernedReviewBatchEventBaseSchema.extend({
    type: z.literal("frozen"),
    datasetRevisionId: z.string().min(1),
    representativeOfPopulationId: z.string().min(1).nullable()
  }).strict(),
  GovernedReviewBatchEventBaseSchema.extend({
    type: z.literal("abandoned"),
    reason: governedNonBlankString(2_000)
  }).strict()
]);
export type GovernedReviewBatchEvent = z.infer<typeof GovernedReviewBatchEventSchema>;

export const GovernedReviewAlignmentEventSchema = z.object({
  contract: z.literal("coeval/governed-review-alignment-event/v1"),
  schemaVersion: z.literal(1),
  alignmentEventId: z.string().min(1),
  projectId: z.string().min(1),
  batchId: z.string().min(1),
  sequence: z.number().int().positive(),
  expectedPreviousSequence: z.number().int().nonnegative(),
  actorSubjectId: z.string().min(1),
  actorRoleAtReview: governedNonBlankString(100),
  visibleActiveLabelIds: z.array(z.string().min(1)).max(200_000),
  kind: z.enum(["comment_recorded", "instruction_change_proposed", "closed"]),
  content: governedNonBlankString(20_000),
  previousEventDigest: DatasetEvidenceDigestSchema.nullable(),
  eventDigest: DatasetEvidenceDigestSchema,
  occurredAt: z.string().datetime({ offset: true })
}).strict();
export type GovernedReviewAlignmentEvent = z.infer<typeof GovernedReviewAlignmentEventSchema>;

export const GovernedReviewAdjudicationSchema = z.object({
  contract: z.literal("coeval/governed-review-adjudication/v1"),
  schemaVersion: z.literal(1),
  adjudicationId: z.string().min(1),
  projectId: z.string().min(1),
  batchId: z.string().min(1),
  reviewItemId: z.string().min(1),
  criterionVersionId: z.string().min(1),
  instructionVersionId: z.string().min(1),
  adjudicatorSubjectId: z.string().min(1),
  adjudicatorRoleAtReview: governedNonBlankString(100),
  sequence: z.number().int().positive(),
  expectedPreviousChainVersion: z.number().int().nonnegative(),
  consideredLabelIds: z.array(z.string().min(1)).min(1).max(20),
  decision: z.enum(["pass", "fail", "unresolvable"]),
  rationale: governedNonBlankString(20_000),
  basis: governedNonBlankString(20_000),
  predecessorAdjudicationId: z.string().min(1).nullable(),
  correctionReason: governedNonBlankString(2_000).nullable(),
  adjudicationDigest: DatasetEvidenceDigestSchema,
  createdAt: z.string().datetime({ offset: true })
}).strict().superRefine((value, ctx) => {
  if (new Set(value.consideredLabelIds).size !== value.consideredLabelIds.length) {
    ctx.addIssue({ code: "custom", path: ["consideredLabelIds"], message: "considered labels must be unique" });
  }
});
export type GovernedReviewAdjudication = z.infer<typeof GovernedReviewAdjudicationSchema>;

export const ImportedTruthClassificationSchema = z.enum([
  "imported_verified_attested",
  "imported_self_attested",
  "unverified"
]);
export type ImportedTruthClassification = z.infer<typeof ImportedTruthClassificationSchema>;

export const ImportedHumanTruthSchema = z.object({
  contract: z.literal("coeval/imported-human-truth/v1"),
  schemaVersion: z.literal(1),
  importedTruthId: z.string().min(1),
  projectId: z.string().min(1),
  criterionId: z.string().min(1),
  criterionVersionId: z.string().min(1),
  issuer: governedNonBlankString(500).nullable(),
  subject: governedNonBlankString(500).nullable(),
  sourceSystem: governedNonBlankString(500).nullable(),
  sourceRecordId: governedNonBlankString(2_000).nullable(),
  sourceDigest: DatasetEvidenceDigestSchema.nullable(),
  sourceArtifact: z.json().nullable(),
  transportMethod: governedNonBlankString(500).nullable(),
  verificationMethod: z.enum([
    "verified_signature",
    "independently_verified_transport",
    "self_attested",
    "unverified"
  ]).nullable(),
  verificationEvidence: z.json().nullable(),
  verificationEvidenceDigest: DatasetEvidenceDigestSchema.nullable(),
  instructionText: governedNonBlankString(100_000).nullable(),
  instructionDigest: DatasetEvidenceDigestSchema.nullable(),
  raters: z.array(GovernedReviewActorSnapshotSchema).max(100),
  label: GovernedReviewLabelValueSchema.nullable(),
  rationale: governedNonBlankString(20_000).nullable(),
  failureCodes: z.array(governedNonBlankString(240)).max(100),
  adjudicatorSubjectId: z.string().min(1).nullable(),
  adjudicationDecision: z.enum(["pass", "fail", "unresolvable"]).nullable(),
  adjudicationRationale: governedNonBlankString(20_000).nullable(),
  blindAttestation: z.object({
    attestedBySubjectId: z.string().min(1),
    statement: governedNonBlankString(20_000),
    attestationDigest: DatasetEvidenceDigestSchema,
    attestedAt: z.string().datetime({ offset: true })
  }).strict().nullable(),
  classification: ImportedTruthClassificationSchema,
  importDigest: DatasetEvidenceDigestSchema,
  importedAt: z.string().datetime({ offset: true })
}).strict().superRefine((value, ctx) => {
  if (new Set(value.raters.map((rater) => rater.subjectId)).size !== value.raters.length) {
    ctx.addIssue({ code: "custom", path: ["raters"], message: "imported rater subjects must be unique" });
  }
  if (new Set(value.failureCodes).size !== value.failureCodes.length) {
    ctx.addIssue({ code: "custom", path: ["failureCodes"], message: "failure codes must be unique" });
  }
});
export type ImportedHumanTruth = z.infer<typeof ImportedHumanTruthSchema>;

export const GovernedBlindTaskViewSchema = z.object({
  contract: z.literal("coeval/governed-blind-task-view/v1"),
  schemaVersion: z.literal(1),
  canonicalizationVersion: z.literal("coeval-canonical-json/v1"),
  taskId: z.string().min(1),
  batchId: z.string().min(1),
  servePosition: z.number().int().nonnegative(),
  criterion: z.object({
    criterionId: z.string().min(1),
    criterionVersionId: z.string().min(1),
    name: governedNonBlankString(500),
    definition: governedNonBlankString(100_000),
    criterionDigest: DatasetEvidenceDigestSchema
  }).strict(),
  instruction: z.object({
    instructionVersionId: z.string().min(1),
    title: governedNonBlankString(240),
    instructions: governedNonBlankString(100_000),
    failureCodeGuidance: z.string(),
    allowedLabels: z.tuple([
      z.literal("pass"),
      z.literal("fail"),
      z.literal("cannot_determine")
    ]),
    instructionDigest: DatasetEvidenceDigestSchema
  }).strict(),
  payloadSnapshot: GovernedReviewPayloadSnapshotSchema
}).strict();
export type GovernedBlindTaskView = z.infer<typeof GovernedBlindTaskViewSchema>;

// Relational materialization uses this separate linkage rather than coercing
// pseudonymous governed IDs into DatasetReferenceProvenance's legacy
// verdictIds/actorUserIds fields.
const GovernedDatasetReferenceProvenanceBaseSchema = z.object({
  contract: z.literal("coeval/governed-dataset-reference-provenance/v1"),
  schemaVersion: z.literal(1),
  projectId: z.string().min(1),
  datasetRevisionId: z.string().min(1),
  datasetRevisionItemId: z.string().min(1),
  criterionVersionId: z.string().min(1),
  referenceLabel: z.enum(["pass", "fail"]),
  provenanceDigest: DatasetEvidenceDigestSchema,
  createdAt: z.string().datetime({ offset: true })
}).strict();

export const GovernedDatasetReferenceProvenanceSchema = z.discriminatedUnion("kind", [
  GovernedDatasetReferenceProvenanceBaseSchema.extend({
    kind: z.literal("governed_labels"),
    batchItemId: z.string().min(1),
    labelIds: z.array(z.string().min(1)).min(1).max(20),
    resolutionBasis: z.enum(["unanimous", "single_rater"])
  }).strict(),
  GovernedDatasetReferenceProvenanceBaseSchema.extend({
    kind: z.literal("adjudication"),
    batchItemId: z.string().min(1),
    adjudicationId: z.string().min(1)
  }).strict(),
  GovernedDatasetReferenceProvenanceBaseSchema.extend({
    kind: z.literal("imported_truth"),
    importedTruthId: z.string().min(1),
    classification: ImportedTruthClassificationSchema
  }).strict()
]);
export type GovernedDatasetReferenceProvenance = z.infer<typeof GovernedDatasetReferenceProvenanceSchema>;

export const GovernedTruthResolutionSchema = z.object({
  status: z.enum(["resolved", "unresolved"]),
  referenceLabel: z.enum(["pass", "fail"]).nullable(),
  basis: z.enum([
    "unanimous",
    "single_rater",
    "adjudicated",
    "coverage_gap",
    "requires_adjudication",
    "unresolvable"
  ]),
  singleRater: z.boolean(),
  consideredLabelIds: z.array(z.string().min(1)),
  requiredIndependentLabels: z.number().int().positive(),
  activeIndependentLabels: z.number().int().nonnegative()
}).strict();
export type GovernedTruthResolution = z.infer<typeof GovernedTruthResolutionSchema>;

export const RepresentativeClaimReasonSchema = z.enum([
  "eligible",
  "selection_method_not_eligible",
  "population_frame_incomplete",
  "collection_provenance_unverified",
  "draw_not_server_executed",
  "draw_not_reproducible",
  "fixed_budget_mismatch",
  "strata_incomplete",
  "review_coverage_incomplete",
  "deferred_assignments",
  "cannot_determine_present",
  "unresolved_items"
]);
export type RepresentativeClaimReason = z.infer<typeof RepresentativeClaimReasonSchema>;

export const RepresentativeClaimEligibilitySchema = z.object({
  representativeClaimEligible: z.boolean(),
  representativeOfPopulationId: z.string().min(1).nullable(),
  reasons: z.array(RepresentativeClaimReasonSchema),
  selectedItems: z.number().int().nonnegative(),
  resolvedItems: z.number().int().nonnegative()
}).strict();
export type RepresentativeClaimEligibility = z.infer<typeof RepresentativeClaimEligibilitySchema>;

// Batch 6B-4: explicit evaluator lifecycle for analysis-promotion criteria.
// Legacy skill_versions.status remains a compatibility projection only; once
// a lineage has this contract, the append-only lifecycle is authoritative.
export const EVALUATOR_LIFECYCLE_CONTRACT_VERSION = "coeval/evaluator-lifecycle/v1" as const;
export const EVALUATOR_LIFECYCLE_EVENT_CONTRACT_VERSION = "coeval/evaluator-lifecycle-event/v1" as const;
export const EVALUATOR_EXECUTION_AUTHORIZATION_VERSION = "coeval/evaluator-execution-authorization/v1" as const;

const EvaluatorLifecycleIdSchema = z.string().trim().min(1).max(240);
const EvaluatorLifecycleDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const EvaluatorLifecycleTimestampSchema = z.string().datetime({ offset: true });
const EvaluatorLifecycleIdempotencyKeySchema = z.string().trim().min(1).max(240);
const EvaluatorLifecycleExpectedSequenceSchema = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);

export const EvaluatorLifecycleStateSchema = z.enum([
  "candidate",
  "active",
  "needs_review",
  "retired"
]);
export type EvaluatorLifecycleState = z.infer<typeof EvaluatorLifecycleStateSchema>;

export const EvaluatorLifecycleTransitionSchema = z.enum([
  "candidate_created",
  "activated",
  "calibration_revoked",
  "retired"
]);
export type EvaluatorLifecycleTransition = z.infer<typeof EvaluatorLifecycleTransitionSchema>;

export const EvaluatorExecutionContextSchema = z.enum([
  "implicit_production",
  "manual_import",
  "scheduled_import",
  "suite_publication",
  "trace_test",
  "release_gate",
  "explicit_nonproduction_dataset",
  "governed_nonsealed_evaluation",
  "binary_calibration_evidence",
  "candidate_regression_evidence"
]);
export type EvaluatorExecutionContext = z.infer<typeof EvaluatorExecutionContextSchema>;

export const EvaluatorCandidateCreateInputSchema = z.object({
  criterionId: EvaluatorLifecycleIdSchema,
  criterionVersionId: EvaluatorLifecycleIdSchema,
  governedBatchId: EvaluatorLifecycleIdSchema,
  expectedBatchDigest: EvaluatorLifecycleDigestSchema,
  truthDatasetRevisionId: EvaluatorLifecycleIdSchema,
  expectedTruthRevisionDigest: EvaluatorLifecycleDigestSchema,
  expectedTruthContentDigest: EvaluatorLifecycleDigestSchema,
  skillName: z.string().trim().min(1).max(200),
  skillDescription: z.string().trim().min(1).max(2_000),
  rubricMarkdown: z.string().trim().min(1).max(100_000),
  prompt: z.string().trim().min(1).max(100_000),
  modelBinding: ModelBindingInputSchema,
  outputSchema: JsonSchemaSchema.default(MinimumVerdictOutputSchema),
  idempotencyKey: EvaluatorLifecycleIdempotencyKeySchema
}).strict();
export type EvaluatorCandidateCreateInput = z.infer<typeof EvaluatorCandidateCreateInputSchema>;

export const EvaluatorLifecycleArtifactSchema = z.object({
  id: EvaluatorLifecycleIdSchema,
  contractVersion: z.literal(EVALUATOR_LIFECYCLE_CONTRACT_VERSION),
  projectId: EvaluatorLifecycleIdSchema,
  criterionId: EvaluatorLifecycleIdSchema,
  criterionVersionId: EvaluatorLifecycleIdSchema,
  skillId: EvaluatorLifecycleIdSchema,
  skillVersionId: EvaluatorLifecycleIdSchema,
  promotionId: EvaluatorLifecycleIdSchema,
  governedBatchId: EvaluatorLifecycleIdSchema,
  governedBatchDigest: EvaluatorLifecycleDigestSchema,
  truthDatasetRevisionId: EvaluatorLifecycleIdSchema,
  truthRevisionDigest: EvaluatorLifecycleDigestSchema,
  truthContentDigest: EvaluatorLifecycleDigestSchema,
  truthItemCount: z.number().int().positive().max(10_000),
  regressionDatasetRevisionId: EvaluatorLifecycleIdSchema,
  regressionRevisionDigest: EvaluatorLifecycleDigestSchema,
  regressionContentDigest: EvaluatorLifecycleDigestSchema,
  regressionItemCount: z.number().int().positive().max(10_000),
  developerExposureEventId: EvaluatorLifecycleIdSchema,
  createdByUserId: EvaluatorLifecycleIdSchema,
  createdBySubjectId: EvaluatorLifecycleIdSchema,
  idempotencyKey: EvaluatorLifecycleIdempotencyKeySchema,
  requestDigest: EvaluatorLifecycleDigestSchema,
  contentDigest: EvaluatorLifecycleDigestSchema,
  createdAt: EvaluatorLifecycleTimestampSchema
}).strict().superRefine((value, context) => {
  if (value.truthItemCount !== value.regressionItemCount) {
    context.addIssue({ code: "custom", message: "candidate regression item count must equal frozen truth item count" });
  }
});
export type EvaluatorLifecycleArtifact = z.infer<typeof EvaluatorLifecycleArtifactSchema>;

const EvaluatorLifecycleActivationEvidenceSchema = z.object({
  calibrationArtifactId: EvaluatorLifecycleIdSchema,
  calibrationArtifactDigest: EvaluatorLifecycleDigestSchema,
  calibrationEvidenceDigest: EvaluatorLifecycleDigestSchema,
  regressionRunId: EvaluatorLifecycleIdSchema,
  regressionDatasetRevisionId: EvaluatorLifecycleIdSchema
}).strict();

export const EvaluatorLifecycleEventSchema = z.object({
  id: EvaluatorLifecycleIdSchema,
  contractVersion: z.literal(EVALUATOR_LIFECYCLE_EVENT_CONTRACT_VERSION),
  lifecycleId: EvaluatorLifecycleIdSchema,
  projectId: EvaluatorLifecycleIdSchema,
  criterionId: EvaluatorLifecycleIdSchema,
  skillVersionId: EvaluatorLifecycleIdSchema,
  sequence: EvaluatorLifecycleExpectedSequenceSchema.refine((value) => value !== "0"),
  transition: EvaluatorLifecycleTransitionSchema,
  state: EvaluatorLifecycleStateSchema,
  predecessorEventId: EvaluatorLifecycleIdSchema.nullable(),
  predecessorEventDigest: EvaluatorLifecycleDigestSchema.nullable(),
  activationBundleId: EvaluatorLifecycleIdSchema.nullable(),
  activationEvidence: EvaluatorLifecycleActivationEvidenceSchema.nullable(),
  replacedSkillVersionId: EvaluatorLifecycleIdSchema.nullable(),
  actorUserId: EvaluatorLifecycleIdSchema.nullable(),
  actorSubjectId: EvaluatorLifecycleIdSchema.nullable(),
  actorRole: z.enum(["owner", "system"]),
  reason: z.string().trim().min(1).max(5_000),
  idempotencyKey: EvaluatorLifecycleIdempotencyKeySchema,
  requestDigest: EvaluatorLifecycleDigestSchema,
  contentDigest: EvaluatorLifecycleDigestSchema,
  occurredAt: EvaluatorLifecycleTimestampSchema
}).strict().superRefine((value, context) => {
  const initial = value.transition === "candidate_created";
  if ((value.sequence === "1") !== initial || (value.predecessorEventId === null) !== initial ||
      (value.predecessorEventDigest === null) !== initial) {
    context.addIssue({ code: "custom", message: "candidate seed must be the sole predecessor-free sequence-one event" });
  }
  if ((value.transition === "activated") !== (value.activationEvidence !== null)) {
    context.addIssue({ code: "custom", message: "activation evidence is required only for activated events" });
  }
  if (value.transition === "candidate_created" && value.state !== "candidate") {
    context.addIssue({ code: "custom", message: "candidate_created must project candidate" });
  }
  if (value.transition === "activated" && value.state !== "active") {
    context.addIssue({ code: "custom", message: "activated must project active" });
  }
  if (value.transition === "calibration_revoked" && (value.state !== "needs_review" || value.actorRole !== "system")) {
    context.addIssue({ code: "custom", message: "calibration revocation must be a system needs_review event" });
  }
  if (value.transition === "retired" && value.state !== "retired") {
    context.addIssue({ code: "custom", message: "retired transition must project retired" });
  }
  if ((value.transition === "calibration_revoked") !== (value.actorRole === "system")) {
    context.addIssue({
      code: "custom",
      message: "only calibration revocation is system-authored; all owner commands require an owner actor"
    });
  }
  if (value.transition === "activated" && value.activationBundleId === null) {
    context.addIssue({ code: "custom", message: "activation requires one exact activation bundle" });
  }
  if (value.transition !== "activated" && value.replacedSkillVersionId !== null) {
    context.addIssue({ code: "custom", message: "only activation may name a replaced evaluator version" });
  }
  if ((value.transition === "candidate_created" || value.transition === "calibration_revoked") &&
      value.activationBundleId !== null) {
    context.addIssue({ code: "custom", message: "candidate and revocation events cannot claim an activation bundle" });
  }
  if (value.actorRole === "owner" && (value.actorUserId === null || value.actorSubjectId === null)) {
    context.addIssue({ code: "custom", message: "owner lifecycle events require durable actor identities" });
  }
  if (value.actorRole === "system" && (value.actorUserId !== null || value.actorSubjectId !== null)) {
    context.addIssue({ code: "custom", message: "system lifecycle events cannot claim a human actor" });
  }
});
export type EvaluatorLifecycleEvent = z.infer<typeof EvaluatorLifecycleEventSchema>;

export const EvaluatorLifecycleProjectionSchema = z.object({
  lifecycle: EvaluatorLifecycleArtifactSchema,
  currentEvent: EvaluatorLifecycleEventSchema,
  currentCalibrationAdmissibility: z.enum(["admissible", "revoked", "unknown", "not_applicable"]),
  implicitExecutionAllowed: z.boolean(),
  implicitDenialReasons: z.array(z.enum([
    "not_active",
    "calibration_incomplete",
    "calibration_revoked",
    "calibration_status_unknown",
    "activation_evidence_mismatch"
  ])).max(5)
}).strict().superRefine((value, context) => {
  if (value.currentEvent.lifecycleId !== value.lifecycle.id ||
      value.currentEvent.projectId !== value.lifecycle.projectId ||
      value.currentEvent.criterionId !== value.lifecycle.criterionId ||
      value.currentEvent.skillVersionId !== value.lifecycle.skillVersionId) {
    context.addIssue({ code: "custom", message: "lifecycle projection identities must be reciprocal" });
  }
  if (value.implicitExecutionAllowed !== (
    value.currentEvent.state === "active" &&
    value.currentCalibrationAdmissibility === "admissible" &&
    value.implicitDenialReasons.length === 0
  )) {
    context.addIssue({ code: "custom", message: "implicit execution must derive from active and admissible evidence" });
  }
});
export type EvaluatorLifecycleProjection = z.infer<typeof EvaluatorLifecycleProjectionSchema>;

export const EvaluatorCandidateCreateResultSchema = z.object({
  skill: SkillSchema,
  projection: EvaluatorLifecycleProjectionSchema,
  replayed: z.boolean()
}).strict().superRefine((value, context) => {
  if (value.skill.id !== value.projection.lifecycle.skillId ||
      value.skill.criterionId !== value.projection.lifecycle.criterionId ||
      value.skill.currentVersion.id !== value.projection.lifecycle.skillVersionId ||
      value.skill.currentVersion.criterionVersionId !== value.projection.lifecycle.criterionVersionId) {
    context.addIssue({ code: "custom", message: "candidate create result must bind one exact skill lifecycle" });
  }
});
export type EvaluatorCandidateCreateResult = z.infer<typeof EvaluatorCandidateCreateResultSchema>;

const EvaluatorLifecycleExpectedHeadSchema = z.object({
  expectedState: z.enum(["candidate", "active", "needs_review"]),
  expectedSequence: EvaluatorLifecycleExpectedSequenceSchema.refine((value) => value !== "0"),
  expectedEventId: EvaluatorLifecycleIdSchema,
  expectedEventDigest: EvaluatorLifecycleDigestSchema,
  idempotencyKey: EvaluatorLifecycleIdempotencyKeySchema
}).strict();

export const EvaluatorLifecycleActivateInputSchema = EvaluatorLifecycleExpectedHeadSchema.extend({
  calibrationArtifactId: EvaluatorLifecycleIdSchema,
  expectedCalibrationArtifactDigest: EvaluatorLifecycleDigestSchema,
  expectedCalibrationEvidenceDigest: EvaluatorLifecycleDigestSchema,
  regressionRunId: EvaluatorLifecycleIdSchema,
  expectedPriorActiveSkillVersionId: EvaluatorLifecycleIdSchema.nullable(),
  expectedPriorActiveEventId: EvaluatorLifecycleIdSchema.nullable(),
  expectedPriorActiveEventDigest: EvaluatorLifecycleDigestSchema.nullable(),
  rationale: z.string().trim().min(1).max(5_000)
}).strict().superRefine((value, context) => {
  if (value.expectedState === "active") {
    context.addIssue({ code: "custom", message: "activation requires candidate or needs_review state" });
  }
  const allPriorNull = value.expectedPriorActiveSkillVersionId === null &&
    value.expectedPriorActiveEventId === null && value.expectedPriorActiveEventDigest === null;
  const allPriorSet = value.expectedPriorActiveSkillVersionId !== null &&
    value.expectedPriorActiveEventId !== null && value.expectedPriorActiveEventDigest !== null;
  if (!allPriorNull && !allPriorSet) {
    context.addIssue({ code: "custom", message: "expected prior active identity must be wholly null or wholly specified" });
  }
});
export type EvaluatorLifecycleActivateInput = z.infer<typeof EvaluatorLifecycleActivateInputSchema>;

export const EvaluatorLifecycleRetireInputSchema = EvaluatorLifecycleExpectedHeadSchema.extend({
  rationale: z.string().trim().min(1).max(5_000)
}).strict();
export type EvaluatorLifecycleRetireInput = z.infer<typeof EvaluatorLifecycleRetireInputSchema>;

export const EvaluatorLifecycleTransitionResultSchema = z.object({
  projection: EvaluatorLifecycleProjectionSchema,
  event: EvaluatorLifecycleEventSchema,
  replacedEvent: EvaluatorLifecycleEventSchema.nullable(),
  replayed: z.boolean()
}).strict().superRefine((value, context) => {
  if (value.event.lifecycleId !== value.projection.lifecycle.id ||
      value.event.skillVersionId !== value.projection.lifecycle.skillVersionId ||
      (!value.replayed && value.event.id !== value.projection.currentEvent.id)) {
    context.addIssue({ code: "custom", message: "transition result must bind the exact lifecycle event" });
  }
});
export type EvaluatorLifecycleTransitionResult = z.infer<typeof EvaluatorLifecycleTransitionResultSchema>;

export const EvaluatorLifecycleListPageSchema = z.object({
  items: z.array(EvaluatorLifecycleProjectionSchema).max(100),
  nextCursor: z.string().max(2_048).nullable(),
  totalCount: z.string().regex(/^(0|[1-9][0-9]*)$/)
}).strict();
export type EvaluatorLifecycleListPage = z.infer<typeof EvaluatorLifecycleListPageSchema>;

// Batch 6B-5: component-only Analyze measurements. This report is a
// versioned read projection over immutable evidence plus explicitly named
// read-time calibration admissibility. It deliberately has no composite,
// threshold, trust, promotion, block, or release field.
export const ANALYSIS_WORKFLOW_MEASUREMENT_CONTRACT_VERSION =
  "coeval/analysis-workflow-measurement/v1" as const;
export const ANALYSIS_WORKFLOW_MEASUREMENT_CALCULATION_VERSION =
  "analysis-workflow-components/v1" as const;

const AnalysisMeasurementIdSchema = z.string().trim().min(1).max(240);
const AnalysisMeasurementDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const AnalysisMeasurementTimestampSchema = z.string().datetime({ offset: true });
const AnalysisMeasurementCountSchema = z.number().int().min(0).max(10_000);

export const AnalysisCodingMeasurementSchema = z.object({
  selectedItemCount: z.number().int().min(1).max(10_000),
  viewedItemCount: AnalysisMeasurementCountSchema,
  inProgressItemCount: AnalysisMeasurementCountSchema,
  completedItemCount: AnalysisMeasurementCountSchema,
  noFailureObservedItemCount: AnalysisMeasurementCountSchema,
  missingItemCount: AnalysisMeasurementCountSchema
}).strict().superRefine((value, context) => {
  if (value.viewedItemCount > value.selectedItemCount ||
      value.noFailureObservedItemCount > value.selectedItemCount ||
      value.completedItemCount + value.inProgressItemCount + value.missingItemCount !== value.selectedItemCount) {
    context.addIssue({ code: "custom", message: "coding measurement counts must conserve the selected frame" });
  }
});
export type AnalysisCodingMeasurement = z.infer<typeof AnalysisCodingMeasurementSchema>;

export const AnalysisTaxonomyChurnSchema = z.object({
  taxonomyRevisionId: AnalysisMeasurementIdSchema,
  taxonomyRevisionDigest: AnalysisMeasurementDigestSchema,
  taxonomyRevisionSequence: z.number().int().min(1).max(10_000),
  predecessorRevisionId: AnalysisMeasurementIdSchema.nullable(),
  predecessorRevisionDigest: AnalysisMeasurementDigestSchema.nullable(),
  additions: AnalysisMeasurementCountSchema,
  labelChanges: AnalysisMeasurementCountSchema,
  definitionChanges: AnalysisMeasurementCountSchema,
  retirements: AnalysisMeasurementCountSchema,
  observationReassignments: AnalysisMeasurementCountSchema
}).strict().superRefine((value, context) => {
  if ((value.predecessorRevisionId === null) !== (value.predecessorRevisionDigest === null) ||
      (value.taxonomyRevisionSequence === 1) !== (value.predecessorRevisionId === null)) {
    context.addIssue({ code: "custom", message: "taxonomy churn must bind the exact predecessor" });
  }
});
export type AnalysisTaxonomyChurn = z.infer<typeof AnalysisTaxonomyChurnSchema>;

export const AnalysisTaxonomyMeasurementSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_requested") }).strict(),
  z.object({
    state: z.literal("available"),
    coverage: AnalysisTaxonomyCoverageSchema,
    churn: AnalysisTaxonomyChurnSchema
  }).strict().superRefine((value, context) => {
    if (value.coverage.taxonomyRevisionId !== value.churn.taxonomyRevisionId ||
        value.coverage.taxonomyRevisionSequence !== value.churn.taxonomyRevisionSequence) {
      context.addIssue({ code: "custom", message: "taxonomy coverage and churn must name one revision" });
    }
  })
]);
export type AnalysisTaxonomyMeasurement = z.infer<typeof AnalysisTaxonomyMeasurementSchema>;

export const AnalysisGovernedDisagreementMeasurementSchema = z.object({
  governedBatchId: AnalysisMeasurementIdSchema,
  governedBatchDigest: AnalysisMeasurementDigestSchema,
  selectedItemCount: z.number().int().min(1).max(10_000),
  unanimous: AnalysisMeasurementCountSchema,
  mixedPassFail: AnalysisMeasurementCountSchema,
  cannotDetermine: AnalysisMeasurementCountSchema,
  coverageGap: AnalysisMeasurementCountSchema,
  unresolvable: AnalysisMeasurementCountSchema,
  singleRater: AnalysisMeasurementCountSchema,
  adjudicated: AnalysisMeasurementCountSchema
}).strict().superRefine((value, context) => {
  const primary = value.unanimous + value.mixedPassFail + value.cannotDetermine +
    value.coverageGap + value.unresolvable + value.singleRater;
  if (primary !== value.selectedItemCount || value.adjudicated > value.selectedItemCount) {
    context.addIssue({ code: "custom", message: "governed disagreement must be a disjoint primary partition" });
  }
});
export type AnalysisGovernedDisagreementMeasurement = z.infer<
  typeof AnalysisGovernedDisagreementMeasurementSchema
>;

export const AnalysisCalibrationTrialMeasurementSchema = z.object({
  trialIndex: z.number().int().min(0).max(9),
  status: z.enum(["complete", "incomplete"]),
  planned: z.number().int().min(1).max(5_000),
  classified: AnalysisMeasurementCountSchema,
  abstained: AnalysisMeasurementCountSchema,
  errored: AnalysisMeasurementCountSchema,
  unevaluated: AnalysisMeasurementCountSchema,
  falsePass: AnalysisMeasurementCountSchema,
  falseFail: AnalysisMeasurementCountSchema,
  classifiedCoverage: z.object({
    overall: BinaryCalibrationWilsonRateSchema,
    truthPass: BinaryCalibrationWilsonRateSchema,
    truthFail: BinaryCalibrationWilsonRateSchema
  }).strict()
}).strict().superRefine((value, context) => {
  if (value.classified + value.abstained + value.errored + value.unevaluated !== value.planned ||
      value.falsePass + value.falseFail > value.classified) {
    context.addIssue({ code: "custom", message: "calibration trial outcomes must conserve planned support" });
  }
});
export type AnalysisCalibrationTrialMeasurement = z.infer<typeof AnalysisCalibrationTrialMeasurementSchema>;

const AnalysisCalibrationCommonShape = {
  calibrationRunId: AnalysisMeasurementIdSchema,
  runCreatedAt: AnalysisMeasurementTimestampSchema,
  plannedObservations: z.number().int().min(1).max(5_000),
  accountedObservations: z.number().int().min(0).max(5_000)
} as const;

export const AnalysisCalibrationMeasurementSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("missing") }).strict(),
  z.object({
    state: z.enum(["queued", "running", "recovery_required", "rejected"]),
    ...AnalysisCalibrationCommonShape,
    rejectionReason: z.string().min(1).max(5_000).nullable()
  }).strict(),
  z.object({
    state: z.enum(["complete", "incomplete"]),
    ...AnalysisCalibrationCommonShape,
    artifactId: AnalysisMeasurementIdSchema,
    artifactDigest: AnalysisMeasurementDigestSchema,
    evidenceDigest: AnalysisMeasurementDigestSchema,
    artifactCreatedAt: AnalysisMeasurementTimestampSchema,
    currentAdmissibility: z.enum(["admissible", "revoked", "unknown"]),
    currentAdmissibilityReasons: z.array(z.enum([
      "development_exposure", "provider_policy_invalidated", "provenance_invalidated",
      "artifact_superseded", "current_status_unavailable"
    ])).max(5),
    positiveClass: z.enum(["pass", "fail"]),
    truthSupport: z.object({
      total: z.number().int().min(1).max(5_000),
      pass: AnalysisMeasurementCountSchema,
      fail: AnalysisMeasurementCountSchema
    }).strict(),
    trials: z.array(AnalysisCalibrationTrialMeasurementSchema).min(1).max(10)
  }).strict().superRefine((value, context) => {
    if (value.truthSupport.pass + value.truthSupport.fail !== value.truthSupport.total ||
        (value.currentAdmissibility === "admissible") !== (value.currentAdmissibilityReasons.length === 0)) {
      context.addIssue({ code: "custom", message: "calibration artifact support and current status must be exact" });
    }
  })
]);
export type AnalysisCalibrationMeasurement = z.infer<typeof AnalysisCalibrationMeasurementSchema>;

export const AnalysisArtifactDurationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("missing") }).strict(),
  z.object({
    state: z.literal("defined"),
    artifactId: AnalysisMeasurementIdSchema,
    artifactCreatedAt: AnalysisMeasurementTimestampSchema,
    durationMilliseconds: z.string().regex(/^(0|[1-9][0-9]*)$/)
  }).strict()
]);
export type AnalysisArtifactDuration = z.infer<typeof AnalysisArtifactDurationSchema>;

export const AnalysisEvaluatorMeasurementSchema = z.object({
  lifecycleId: AnalysisMeasurementIdSchema,
  promotionId: AnalysisMeasurementIdSchema,
  criterionId: AnalysisMeasurementIdSchema,
  criterionVersionId: AnalysisMeasurementIdSchema,
  skillId: AnalysisMeasurementIdSchema,
  skillVersionId: AnalysisMeasurementIdSchema,
  governedDisagreement: AnalysisGovernedDisagreementMeasurementSchema,
  calibration: AnalysisCalibrationMeasurementSchema,
  timeToFirstCompletedCalibrationArtifact: AnalysisArtifactDurationSchema,
  timeToFirstCurrentlyAdmissibleCalibrationArtifact: AnalysisArtifactDurationSchema
}).strict();
export type AnalysisEvaluatorMeasurement = z.infer<typeof AnalysisEvaluatorMeasurementSchema>;

export const AnalysisEvaluatorMeasurementOptionSchema = z.object({
  lifecycleId: AnalysisMeasurementIdSchema,
  promotionId: AnalysisMeasurementIdSchema,
  criterionId: AnalysisMeasurementIdSchema,
  criterionVersionId: AnalysisMeasurementIdSchema,
  skillId: AnalysisMeasurementIdSchema,
  skillVersionId: AnalysisMeasurementIdSchema
}).strict();
export type AnalysisEvaluatorMeasurementOption = z.infer<typeof AnalysisEvaluatorMeasurementOptionSchema>;

export const AnalysisWorkflowMeasurementReportSchema = z.object({
  contractVersion: z.literal(ANALYSIS_WORKFLOW_MEASUREMENT_CONTRACT_VERSION),
  calculationVersion: z.literal(ANALYSIS_WORKFLOW_MEASUREMENT_CALCULATION_VERSION),
  projectId: AnalysisMeasurementIdSchema,
  studyId: AnalysisMeasurementIdSchema,
  populationId: AnalysisMeasurementIdSchema,
  drawId: AnalysisMeasurementIdSchema,
  datasetRevisionId: AnalysisMeasurementIdSchema,
  studyCreatedAt: AnalysisMeasurementTimestampSchema,
  studyState: AnalysisStudyStateSchema,
  coding: AnalysisCodingMeasurementSchema,
  taxonomy: AnalysisTaxonomyMeasurementSchema,
  evaluatorOptions: z.array(AnalysisEvaluatorMeasurementOptionSchema).max(1_000),
  evaluator: AnalysisEvaluatorMeasurementSchema.nullable(),
  reportDigest: AnalysisMeasurementDigestSchema,
  calculatedAt: AnalysisMeasurementTimestampSchema
}).strict().superRefine((value, context) => {
  if (value.taxonomy.state === "available" &&
      (value.taxonomy.coverage.projectId !== value.projectId ||
       value.taxonomy.coverage.studyId !== value.studyId)) {
    context.addIssue({ code: "custom", message: "taxonomy measurement must bind the report study" });
  }
  const identities = new Set(value.evaluatorOptions.map((option) => option.skillVersionId));
  if (identities.size !== value.evaluatorOptions.length ||
      (value.evaluator !== null && !identities.has(value.evaluator.skillVersionId))) {
    context.addIssue({ code: "custom", message: "evaluator measurement must bind one listed study evaluator" });
  }
});
export type AnalysisWorkflowMeasurementReport = z.infer<typeof AnalysisWorkflowMeasurementReportSchema>;

// ---------------------------------------------------------------------------
// Findings export + machine case/golden reads (GET /api/v1/findings,
// /api/v1/cases, /api/v1/golden-set — issue #10). The aggregation is bounded
// and deterministic: no LLM calls; "clustering" is exact grouping on the
// normalized first sentence of each rationale. All three endpoints are
// read-only and project-key authed — the machine surface never adjudicates
// or promotes (those dashboard actions remain ungoverned legacy evidence).

// Scan bounds. The findings surface reads at most this many newest rows per
// feed, so one request stays cheap and its output deterministic for a given
// data state; consumers needing history beyond the window page /api/v1/cases.
export const FINDINGS_VERDICT_SCAN_LIMIT = 500;
export const FINDINGS_CASE_SCAN_LIMIT = 500;
export const FINDINGS_OVERRIDE_LIMIT = 100;
export const FINDINGS_CLUSTER_LIMIT = 20;
export const FINDINGS_CLUSTER_CASE_SAMPLE = 10;
export const V1_CASES_MAX_LIMIT = 200;
export const V1_CASES_DEFAULT_LIMIT = 50;

// A human decision that contradicts the judge on the same case — the highest
// value rows in the system for skill maintenance. `source` distinguishes a
// reviewer verdict from an owner-recorded legacy adjudication. Both remain
// ungoverned evidence.
export const FindingsHumanOverrideSchema = z.object({
  caseId: z.string(),
  source: z.enum(["human", "adjudicated"]),
  label: z.string(),
  judgeLabel: z.string(),
  rationale: z.string(),
  skillVersionId: z.string().nullable(),
  createdAt: z.string()
});
export type FindingsHumanOverride = z.infer<typeof FindingsHumanOverrideSchema>;

export const FindingsFailureClusterSchema = z.object({
  // Normalized first sentence shared by every rationale in the cluster.
  key: z.string(),
  source: z.enum(["human_override", "judge"]),
  count: z.number().int().positive(),
  // Distinct cases in the cluster, capped at FINDINGS_CLUSTER_CASE_SAMPLE.
  caseIds: z.array(z.string()),
  // One full rationale from the cluster (the earliest, for determinism).
  sampleRationale: z.string()
});
export type FindingsFailureCluster = z.infer<typeof FindingsFailureClusterSchema>;

export const FindingsStratumDistributionSchema = z.object({
  // cases carry an optional metadata.stratum string; null = unstratified.
  stratum: z.string().nullable(),
  cases: z.number().int().nonnegative(),
  // Label -> count of cases whose LATEST verdict from that source has the
  // label (latest-wins per case, counts not percentages).
  judge: z.record(z.string(), z.number().int().nonnegative()),
  human: z.record(z.string(), z.number().int().nonnegative())
});
export type FindingsStratumDistribution = z.infer<typeof FindingsStratumDistributionSchema>;

export const FindingsGoldenSetSummarySchema = z.object({
  size: z.number().int().nonnegative(),
  // Entries promoted strictly after the `since` cursor; null when no cursor
  // was given (absent ≠ zero).
  entriesSince: z.number().int().nonnegative().nullable(),
  latestPromotedAt: z.string().nullable()
});
export type FindingsGoldenSetSummary = z.infer<typeof FindingsGoldenSetSummarySchema>;

export const V1FindingsResponseSchema = z.object({
  generatedAt: z.string(),
  since: z.string().nullable(),
  humanOverrides: z.array(FindingsHumanOverrideSchema),
  judgeHumanDisagreements: JudgeHumanDisagreementSummarySchema,
  verdictDistribution: z.array(FindingsStratumDistributionSchema),
  failureClusters: z.array(FindingsFailureClusterSchema),
  goldenSet: FindingsGoldenSetSummarySchema
});
export type V1FindingsResponse = z.infer<typeof V1FindingsResponseSchema>;

// GET /api/v1/cases — full stored (ingest-redacted) inputs and outputs, so a
// skill patch can be re-run on the exact cases the judge saw.
export const V1CaseVerdictSchema = z.object({
  label: z.string(),
  rationale: z.string(),
  source: VerdictSourceSchema,
  skillVersionId: z.string().nullable(),
  createdAt: z.string()
});
export type V1CaseVerdict = z.infer<typeof V1CaseVerdictSchema>;

export const V1CaseEntrySchema = z.object({
  caseId: z.string(),
  sourceTraceId: z.string(),
  createdAt: z.string(),
  stratum: z.string().nullable(),
  input: z.unknown(),
  output: z.unknown(),
  metadata: z.record(z.string(), z.unknown()),
  steps: TraceStepsSchema.optional(),
  // Latest discrete verdicts. `human` prefers adjudicated over reviewer rows
  // (a recorded override outranks the verdict it overrode).
  judge: V1CaseVerdictSchema.nullable(),
  human: V1CaseVerdictSchema.nullable(),
  // human label when present, else the judge's — what `verdict=` filters on.
  effectiveLabel: z.string().nullable()
});
export type V1CaseEntry = z.infer<typeof V1CaseEntrySchema>;

export const V1CasesResponseSchema = z.object({
  cases: z.array(V1CaseEntrySchema)
});
export type V1CasesResponse = z.infer<typeof V1CasesResponseSchema>;

// GET /api/v1/golden-set — locked truth plus each entry's stored trace, so a
// gate check can be assembled from golden inputs without dashboard access.
export const V1GoldenEntrySchema = GoldenSetEntrySchema.extend({
  trace: z.object({
    input: z.unknown(),
    output: z.unknown(),
    metadata: z.record(z.string(), z.unknown())
  }).nullable()
});
export type V1GoldenEntry = z.infer<typeof V1GoldenEntrySchema>;

export const V1GoldenResponseSchema = z.object({
  entries: z.array(V1GoldenEntrySchema),
  // Registry size before any `since` filter (absent cursor ≠ empty registry).
  totalEntries: z.number().int().nonnegative()
});
export type V1GoldenResponse = z.infer<typeof V1GoldenResponseSchema>;
