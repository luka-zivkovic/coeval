import type { JudgeProvider, Trace } from "@coeval/audit/runtime";
import {
  demoExceptions,
  demoGoldenSet,
  demoProject,
  demoSkill,
  demoSkillPrevVersion,
  demoVerdicts
} from "@coeval/db";
import type { GoldenSetEntry } from "@coeval/shared";
import { datasetInputIdentity } from "../lib/dataset-revision.js";
import { evaluatorSuiteCriterionDigest } from "../lib/evaluator-suite.js";
import type {
  ApiKeyRepositoryPort,
  AssessmentReceiptRepositoryPort,
  CaseEvidenceRepositoryPort,
  CriterionSuiteRepositoryPort,
  DatasetRepositoryPort,
  EvalRunRepositoryPort,
  GoldenEvidenceRepositoryPort,
  HistoricalGateEvidenceRepositoryPort,
  IntegrationRepositoryPort,
  JudgeCredentialRepositoryPort,
  JudgeFeedbackRepositoryPort,
  ProjectRepositoryPort,
  ReviewQueueRepositoryPort,
  RunComparisonRepositoryPort,
  SkillLifecycleRepositoryPort,
  TraceImportRepositoryPort,
  TraceTestRepositoryPort
} from "./ports.js";
import { DatasetRevisionConflictError } from "./errors.js";
import { DemoCaseEvidenceRepository } from "./demo-case-evidence.js";
import { DemoCredentialRepository } from "./demo-credentials.js";
import { DemoCriterionSuiteRepository } from "./demo-criteria.js";
import { DemoDatasetRepository } from "./demo-datasets.js";
import { DemoEvaluationRepository } from "./demo-evaluation.js";
import { DemoJudgeFeedbackRepository } from "./demo-feedback.js";
import { DemoGoldenEvidenceRepository } from "./demo-golden.js";
import { DemoHistoricalGateEvidenceRepository } from "./demo-historical-gates.js";
import { DemoIntegrationRepository } from "./demo-integrations.js";
import { DemoProjectRepository } from "./demo-projects.js";
import { DemoReviewQueueRepository } from "./demo-review-queues.js";
import { DemoRunComparisonRepository } from "./demo-run-comparisons.js";
import { DemoSkillLifecycleRepository } from "./demo-skills.js";
import type { DemoRepositoryStore } from "./demo-store.js";
import { DemoTraceImportRepository } from "./demo-trace-import.js";
import { DemoTraceTestRepository } from "./demo-trace-tests.js";
import {
  buildGoldenSetHealthSummary,
  previousVerdictsFromRun,
  runGoldenSetRegression
} from "./golden-helpers.js";

type DemoRepositoryFacade =
  ProjectRepositoryPort &
  CriterionSuiteRepositoryPort &
  Omit<SkillLifecycleRepositoryPort, "getCurrentSkill"> &
  { getCurrentSkill(projectId?: string): ReturnType<SkillLifecycleRepositoryPort["getCurrentSkill"]> } &
  GoldenEvidenceRepositoryPort &
  TraceImportRepositoryPort &
  IntegrationRepositoryPort &
  JudgeFeedbackRepositoryPort &
  CaseEvidenceRepositoryPort &
  ReviewQueueRepositoryPort &
  ApiKeyRepositoryPort &
  TraceTestRepositoryPort &
  DatasetRepositoryPort &
  JudgeCredentialRepositoryPort &
  EvalRunRepositoryPort &
  AssessmentReceiptRepositoryPort &
  RunComparisonRepositoryPort &
  HistoricalGateEvidenceRepositoryPort;

export interface DemoRepositoryComposition {
  readonly caseEvidenceRepository: DemoCaseEvidenceRepository;
  readonly credentialRepository: DemoCredentialRepository;
  readonly projectRepository: DemoProjectRepository;
  readonly reviewQueueRepository: DemoReviewQueueRepository;
  readonly runComparisonRepository: DemoRunComparisonRepository;
  readonly criterionSuiteRepository: DemoCriterionSuiteRepository;
  readonly datasetRepository: DemoDatasetRepository;
  readonly evaluationRepository: DemoEvaluationRepository;
  readonly skillLifecycleRepository: DemoSkillLifecycleRepository;
  readonly goldenEvidenceRepository: DemoGoldenEvidenceRepository;
  readonly historicalGateEvidenceRepository: DemoHistoricalGateEvidenceRepository;
  readonly integrationRepository: DemoIntegrationRepository;
  readonly judgeFeedbackRepository: DemoJudgeFeedbackRepository;
  readonly traceImportRepository: DemoTraceImportRepository;
  readonly traceTestRepository: DemoTraceTestRepository;
}

// B12 (M0 C8): demo parity with PG's attachActorNames — the seeded demo
// reviewers resolve to display names so the trust feeds read "Maya · Pass" in
// demo exactly like prod, and the web needs no id-prettifying fallback.
const DEMO_ACTOR_NAMES = new Map<string, string>([
  ["user_maya", "Maya"],
  ["user_jules", "Jules"],
  ["user_priya", "Priya"]
]);

function demoTraceForGoldenEntry(entry: GoldenSetEntry): Trace {
  return {
    id: entry.traceId,
    input: { caseId: entry.caseId },
    output: entry.agreedLabel === "pass"
      ? { message: `${entry.reason} Minor borderline tone note for strict regression testing.` }
      : { message: `${entry.reason} incorrect failure signal.` },
    metadata: { goldenSetEntryId: entry.id }
  };
}

function syntheticTraceForBuiltinCase(caseId: string): Trace | null {
  const exception = demoExceptions.find((candidate) => candidate.id === caseId);
  if (exception) {
    // Embedding the judge's original reason keeps the mock heuristic
    // coherent: a failing exception re-judges as fail.
    return {
      id: exception.traceId,
      input: { text: "Demo customer support question" },
      output: { text: `Demo AI answer. Judge note: ${exception.reason}` },
      metadata: { source: "demo" }
    };
  }
  const golden = demoGoldenSet.find((entry) => entry.caseId === caseId);
  if (golden) return demoTraceForGoldenEntry(golden);
  return null;
}

function seedDemoRepositoryStore(
  store: DemoRepositoryStore,
  options: { seedVerdicts?: boolean }
): void {
  const criterionId = demoSkill.criterionId;
  const criterionVersionId = demoSkill.currentVersion.criterionVersionId;
  store.criteria.push({
    id: criterionId,
    projectId: demoProject.id,
    stableKey: `skill:${demoSkill.id}`,
    sourceKind: "native",
    createdByUserId: null,
    createdAt: demoProject.updatedAt
  });
  store.criterionVersions.push({
    id: criterionVersionId,
    projectId: demoProject.id,
    criterionId,
    revision: 1,
    name: demoSkill.name,
    definition: demoSkill.description,
    criterionDigest: evaluatorSuiteCriterionDigest({
      criterionId,
      criterionVersionId,
      criterionName: demoSkill.name,
      criterionDefinition: demoSkill.description
    }),
    sourceKind: "native",
    createdByUserId: null,
    createdAt: demoProject.updatedAt
  });
  store.skillVersionCriteria.set(demoSkillPrevVersion.id, criterionVersionId);
  store.skillVersionCriteria.set(demoSkill.currentVersion.id, criterionVersionId);
  store.criterionSkills.set(criterionId, demoSkill);
  if (options.seedVerdicts) store.verdicts.push(...demoVerdicts);
  // Demo fixtures are authored in source rather than imported through the
  // runtime redaction path. Capture their original input identity up front
  // so the demo never hashes a redacted fallback while calling it exact.
  for (const entry of demoGoldenSet) {
    store.caseInputIdentities.set(
      entry.caseId,
      datasetInputIdentity({ input: demoTraceForGoldenEntry(entry).input })
    );
  }
  for (const exception of demoExceptions) {
    const trace = syntheticTraceForBuiltinCase(exception.id);
    if (trace) store.caseInputIdentities.set(exception.id, datasetInputIdentity({ input: trace.input }));
  }
  // A2.2c: when seeding, expose the predecessor version too so the convergence
  // audit has a real before→after to compare. Without seeding, the version
  // list lazy-inits to just the current version (existing behaviour).
  store.skillVersions = options.seedVerdicts
    ? [structuredClone(demoSkillPrevVersion), structuredClone(demoSkill.currentVersion)]
    : null;
}

// Derived product-gate cases (case source 'gate_candidate') are judging
// scaffolding: excluded from dashboards, exceptions, and backfills.
function isEvidenceScaffoldingCase(store: DemoRepositoryStore, caseId: string): boolean {
  const source = store.traceSources.get(caseId)?.source;
  return source === "gate_candidate" || source === "release_evidence";
}

async function resolveImportSkillVersionId(
  facade: DemoRepositoryFacade,
  projectId: string,
  requested?: string | undefined
): Promise<string> {
  if (requested) {
    const version = await facade.getSkillVersion(projectId, requested);
    if (!version) throw new DatasetRevisionConflictError(`Unknown import skillVersionId for this project: ${requested}`);
    return version.id;
  }
  return (await facade.getCurrentSkill(projectId)).currentVersion.id;
}

async function resolveGoldenCriterionVersion(
  facade: DemoRepositoryFacade,
  store: DemoRepositoryStore,
  projectId: string,
  requested?: string | undefined
): Promise<string> {
  if (requested) {
    const exists = store.criterionVersions.some((candidate) =>
      candidate.projectId === projectId && candidate.id === requested
    );
    if (!exists) {
      throw new DatasetRevisionConflictError(
        `Criterion version does not belong to this project: ${requested}`
      );
    }
    return requested;
  }
  const current = await facade.getCurrentSkill(projectId);
  const criterionVersionId = store.skillVersionCriteria.get(current.currentVersion.id);
  if (!criterionVersionId) {
    throw new DatasetRevisionConflictError("Current evaluator has no immutable criterion version binding");
  }
  return criterionVersionId;
}

// Creates the stateless domain slices around the one facade-owned store. The
// lazy callbacks preserve facade polymorphism and are not invoked by slice
// construction.
export function createDemoRepositoryComposition(
  facade: DemoRepositoryFacade,
  store: DemoRepositoryStore,
  judgeProvider: JudgeProvider,
  options: { seedVerdicts?: boolean } = {}
): DemoRepositoryComposition {
  seedDemoRepositoryStore(store, options);

  const caseEvidenceRepository = new DemoCaseEvidenceRepository(store, {
    caseExistsForProject: (projectId, caseId) => facade.caseExistsForProject(projectId, caseId),
    getCaseDetail: (projectId, caseId, skillVersionId) => facade.getCaseDetail(projectId, caseId, skillVersionId),
    getCurrentSkill: (projectId) => facade.getCurrentSkill(projectId),
    getDemoActorName: (actorUserId) => DEMO_ACTOR_NAMES.get(actorUserId),
    getSkillVersion: (projectId, skillVersionId) => facade.getSkillVersion(projectId, skillVersionId),
    isEvidenceScaffoldingCase: (caseId) => isEvidenceScaffoldingCase(store, caseId),
    listSkillVersions: (projectId, skillId, limit) => facade.listSkillVersions(projectId, skillId, limit),
    resolveGoldenCriterionVersion: (projectId, requested) =>
      resolveGoldenCriterionVersion(facade, store, projectId, requested)
  });
  const credentialRepository = new DemoCredentialRepository(store);
  const projectRepository = new DemoProjectRepository(store, {
    getCurrentSkill: (projectId) => facade.getCurrentSkill(projectId),
    getCurrentSkillForCriterion: (projectId, criterionId) => facade.getCurrentSkillForCriterion(projectId, criterionId),
    isEvidenceScaffoldingCase: (caseId) => isEvidenceScaffoldingCase(store, caseId),
    listGoldenSet: (projectId, criterionVersionId) => facade.listGoldenSet(projectId, criterionVersionId),
    syntheticTraceForBuiltinCase
  });
  const reviewQueueRepository = new DemoReviewQueueRepository(store, {
    caseExistsForProject: (projectId, caseId) => facade.caseExistsForProject(projectId, caseId),
    getCurrentSkill: (projectId) => facade.getCurrentSkill(projectId)
  });
  const runComparisonRepository = new DemoRunComparisonRepository(store);
  const criterionSuiteRepository = new DemoCriterionSuiteRepository(store);
  const datasetRepository = new DemoDatasetRepository(store, {
    addDatasetItems: (input) => facade.addDatasetItems(input),
    caseExistsForProject: (projectId, caseId) => facade.caseExistsForProject(projectId, caseId),
    getDatasetDetail: (projectId, datasetId) => facade.getDatasetDetail(projectId, datasetId),
    getDatasetRevisionDetail: (projectId, revisionId) => facade.getDatasetRevisionDetail(projectId, revisionId),
    importTrace: (projectId, source, input, context) => facade.importTrace(projectId, source, input, context),
    listGoldenSet: (projectId, criterionVersionId) => facade.listGoldenSet(projectId, criterionVersionId),
    traceForGoldenEntry: demoTraceForGoldenEntry
  });
  const evaluationRepository = new DemoEvaluationRepository(store, {
    armEvalRunItemDeliveryDeadline: (projectId, evalRunId) => facade.armEvalRunItemDeliveryDeadline(projectId, evalRunId),
    createConvergenceEvalRun: (input) => facade.createConvergenceEvalRun(input),
    createEvalRun: (input) => facade.createEvalRun(input),
    getEvalRun: (projectId, evalRunId) => facade.getEvalRun(projectId, evalRunId),
    getEvalRunDetail: (projectId, evalRunId) => facade.getEvalRunDetail(projectId, evalRunId),
    getOrFreezeAssessmentReceipt: (projectId, evalRunId) => facade.getOrFreezeAssessmentReceipt(projectId, evalRunId),
    getSkillVersion: (projectId, skillVersionId) => facade.getSkillVersion(projectId, skillVersionId),
    listPendingEvalRunItems: (projectId, evalRunId) => facade.listPendingEvalRunItems(projectId, evalRunId)
  });
  const skillLifecycleRepository = new DemoSkillLifecycleRepository(store, judgeProvider, {
    createSkillVersionPending: (skillId, input, context) => facade.createSkillVersionPending(skillId, input, context),
    getDatasetRevisionDetail: (projectId, revisionId) => facade.getDatasetRevisionDetail(projectId, revisionId),
    getOrCreateRegressionDatasetRevision: (projectId, actorUserId, resolvedCriterionVersionId) =>
      facade.getOrCreateRegressionDatasetRevision(projectId, actorUserId, resolvedCriterionVersionId),
    previousVerdictsFromRun,
    runRegressionGateForVersion: (job) => facade.runRegressionGateForVersion(job),
    runGoldenSetRegression
  });
  const goldenEvidenceRepository = new DemoGoldenEvidenceRepository(store, {
    buildGoldenSetHealthSummary,
    getCaseDetail: (projectId, caseId, skillVersionId) => facade.getCaseDetail(projectId, caseId, skillVersionId),
    getDemoActorName: (actorUserId) => DEMO_ACTOR_NAMES.get(actorUserId),
    getOrCreateRegressionDatasetRevision: (projectId, actorUserId, criterionVersionId) =>
      facade.getOrCreateRegressionDatasetRevision(projectId, actorUserId, criterionVersionId),
    listGoldenSet: (projectId, criterionVersionId) => facade.listGoldenSet(projectId, criterionVersionId),
    resolveGoldenCriterionVersion: (projectId, requested) =>
      resolveGoldenCriterionVersion(facade, store, projectId, requested),
    syntheticTraceForBuiltinCase
  });
  const historicalGateEvidenceRepository = new DemoHistoricalGateEvidenceRepository(store, {
    getEvalRun: (projectId, evalRunId) => facade.getEvalRun(projectId, evalRunId),
    getEvalRunDetail: (projectId, evalRunId) => facade.getEvalRunDetail(projectId, evalRunId),
    getGateCheckDetail: (projectId, gateCheckId) => facade.getGateCheckDetail(projectId, gateCheckId)
  });
  const integrationRepository = new DemoIntegrationRepository(store, {
    resolveImportSkillVersionId: (projectId, requested) => resolveImportSkillVersionId(facade, projectId, requested)
  });
  const judgeFeedbackRepository = new DemoJudgeFeedbackRepository(store, {
    loadFeedbackSyncContext: (job) => facade.loadFeedbackSyncContext(job),
    syntheticTraceForBuiltinCase
  });
  const traceImportRepository = new DemoTraceImportRepository(store, {
    resolveImportSkillVersionId: (projectId, requested) => resolveImportSkillVersionId(facade, projectId, requested)
  });
  const traceTestRepository = new DemoTraceTestRepository(store, {
    getCaseDetail: (projectId, caseId) => facade.getCaseDetail(projectId, caseId)
  });

  return {
    caseEvidenceRepository,
    credentialRepository,
    projectRepository,
    reviewQueueRepository,
    runComparisonRepository,
    criterionSuiteRepository,
    datasetRepository,
    evaluationRepository,
    skillLifecycleRepository,
    goldenEvidenceRepository,
    historicalGateEvidenceRepository,
    integrationRepository,
    judgeFeedbackRepository,
    traceImportRepository,
    traceTestRepository
  };
}
