import { randomUUID } from "node:crypto";
import { demoProject } from "@coeval/db";
import type {
  ExceptionDetail,
  TraceTestDetail,
  TraceTestSummary,
  TraceTestValidation
} from "@coeval/shared";
import type {
  CreateTraceTestInputDb,
  EnableTraceTestInputDb,
  RecordTraceTestFunnelEventInputDb,
  RecordTraceTestValidationInputDb,
  ReviseTraceTestInputDb
} from "./contracts.js";
import type { DemoRepositoryStore } from "./demo-store.js";
import {
  TraceTestNotFoundError,
  TraceTestRevisionConflictError,
  TraceTestSourceNotFoundError,
  TraceTestValidationNotReadyError
} from "./errors.js";
import {
  traceTestValidationDiagnostic,
  traceTestValidationIsEnableEligible,
  traceTestValidationStatus
} from "./helpers.js";
import type { TraceTestRepositoryPort } from "./ports.js";

interface DemoTraceTestRepositoryDependencies {
  getCaseDetail(projectId: string, caseId: string): Promise<ExceptionDetail | null>;
}

// Internal DemoRepository trace-test lifecycle slice. Append-only drafts,
// validations, and enablement records stay on the exact shared store; source
// fallback remains a lazy facade callback so subclass overrides stay visible.
export class DemoTraceTestRepository implements TraceTestRepositoryPort {
  constructor(
    private readonly store: DemoRepositoryStore,
    private readonly dependencies: DemoTraceTestRepositoryDependencies
  ) {}

  async createTraceTest(input: CreateTraceTestInputDb): Promise<TraceTestDetail> {
    if (input.projectId !== demoProject.id) throw new TraceTestSourceNotFoundError(input.sourceCaseId);
    const stored = this.store.traces.get(input.sourceCaseId);
    const detail = stored ? null : await this.dependencies.getCaseDetail(input.projectId, input.sourceCaseId);
    if (!stored && !detail) throw new TraceTestSourceNotFoundError(input.sourceCaseId);
    const source = stored ?? detail!.trace;
    const sourceSnapshot = {
      input: source.input,
      output: source.output,
      metadata: source.metadata ?? {},
      ...(source.steps ? { steps: source.steps } : {})
    };
    const traceSource = this.store.traceSources.get(input.sourceCaseId);
    const createdAt = new Date().toISOString();
    const record = {
      id: `tt_${randomUUID()}`,
      projectId: input.projectId,
      sourceCaseId: input.sourceCaseId,
      sourceCaseRef: input.sourceCaseId,
      sourceTraceRef: traceSource?.sourceTraceId ?? source.id,
      sourceSnapshot: structuredClone(sourceSnapshot),
      sourceScope: structuredClone(input.sourceScope),
      currentRevision: 1,
      enabledRevision: null,
      createdByUserId: input.createdByUserId ?? null,
      createdAt,
      updatedAt: createdAt
    };
    this.store.traceTests.push(record);
    this.store.traceTestRevisions.push({
      id: `ttr_${randomUUID()}`,
      traceTestId: record.id,
      revision: 1,
      lifecycle: "draft",
      desiredBehavior: input.desiredBehavior,
      scenario: input.scenario,
      expectedBehavior: input.expectedBehavior,
      mustDo: structuredClone(input.mustDo),
      mustAvoid: structuredClone(input.mustAvoid),
      goodExample: structuredClone(input.goodExample),
      badExample: structuredClone(input.badExample),
      checker: structuredClone(input.checker),
      draftProvenance: structuredClone(input.draftProvenance),
      validationId: null,
      validatedRevision: null,
      createdByUserId: input.createdByUserId ?? null,
      reviewedByUserId: null,
      createdAt,
      reviewedAt: null
    });
    return this.toTraceTestDetail(record);
  }

  async listTraceTests(projectId: string, sourceCaseRef?: string): Promise<TraceTestSummary[]> {
    return this.store.traceTests
      .filter((test) => test.projectId === projectId && (!sourceCaseRef || test.sourceCaseRef === sourceCaseRef))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
      .map((test) => this.toTraceTestSummary(test));
  }

  async getTraceTest(projectId: string, traceTestId: string): Promise<TraceTestDetail | null> {
    const test = this.store.traceTests.find((candidate) => candidate.id === traceTestId && candidate.projectId === projectId);
    return test ? this.toTraceTestDetail(test) : null;
  }

  async reviseTraceTest(input: ReviseTraceTestInputDb): Promise<TraceTestDetail> {
    const test = this.store.traceTests.find((candidate) => candidate.id === input.traceTestId && candidate.projectId === input.projectId);
    if (!test) throw new TraceTestNotFoundError(input.traceTestId);
    if (test.currentRevision !== input.expectedRevision) {
      throw new TraceTestRevisionConflictError(input.expectedRevision, test.currentRevision);
    }
    const createdAt = new Date().toISOString();
    const revision = test.currentRevision + 1;
    this.store.traceTestRevisions.push({
      id: `ttr_${randomUUID()}`,
      traceTestId: test.id,
      revision,
      lifecycle: "draft",
      desiredBehavior: input.desiredBehavior,
      scenario: input.scenario,
      expectedBehavior: input.expectedBehavior,
      mustDo: structuredClone(input.mustDo),
      mustAvoid: structuredClone(input.mustAvoid),
      goodExample: structuredClone(input.goodExample),
      badExample: structuredClone(input.badExample),
      checker: structuredClone(input.checker),
      draftProvenance: structuredClone(input.draftProvenance),
      validationId: null,
      validatedRevision: null,
      createdByUserId: input.createdByUserId ?? null,
      reviewedByUserId: null,
      createdAt,
      reviewedAt: null
    });
    test.currentRevision = revision;
    test.updatedAt = createdAt;
    return this.toTraceTestDetail(test);
  }

  async recordTraceTestValidation(input: RecordTraceTestValidationInputDb): Promise<TraceTestValidation> {
    const test = this.store.traceTests.find((candidate) => candidate.id === input.traceTestId && candidate.projectId === input.projectId);
    if (!test) throw new TraceTestNotFoundError(input.traceTestId);
    if (test.currentRevision !== input.revision) {
      throw new TraceTestRevisionConflictError(input.revision, test.currentRevision);
    }
    const validation: TraceTestValidation = {
      id: `ttv_${randomUUID()}`,
      traceTestId: test.id,
      revision: input.revision,
      status: traceTestValidationStatus(input.badEvidence.result, input.goodEvidence.result),
      badEvidence: {
        output: structuredClone(input.badEvidence.output),
        result: input.badEvidence.result,
        note: input.badEvidence.note,
        expectedResult: "fail",
        attempts: input.badAttempts ?? 0,
        usage: input.badUsage ?? null
      },
      goodEvidence: {
        output: structuredClone(input.goodEvidence.output),
        result: input.goodEvidence.result,
        note: input.goodEvidence.note,
        expectedResult: "pass",
        attempts: input.goodAttempts ?? 0,
        usage: input.goodUsage ?? null
      },
      method: input.method ?? "automated",
      diagnostic: input.diagnostic ?? traceTestValidationDiagnostic(input.badEvidence.result, input.goodEvidence.result),
      evaluator: input.evaluator ?? null,
      overrideReason: input.overrideReason ?? null,
      recordedByUserId: input.recordedByUserId ?? null,
      createdAt: new Date().toISOString()
    };
    this.store.traceTestValidations.push(validation);
    return structuredClone(validation);
  }

  async enableTraceTest(input: EnableTraceTestInputDb): Promise<TraceTestDetail> {
    const test = this.store.traceTests.find((candidate) => candidate.id === input.traceTestId && candidate.projectId === input.projectId);
    if (!test) throw new TraceTestNotFoundError(input.traceTestId);
    if (test.currentRevision !== input.expectedRevision) {
      throw new TraceTestRevisionConflictError(input.expectedRevision, test.currentRevision);
    }
    const validation = this.store.traceTestValidations.find(
      (candidate) => candidate.id === input.validationId && candidate.traceTestId === test.id && candidate.revision === input.expectedRevision
    );
    if (!validation || !traceTestValidationIsEnableEligible(validation)) {
      throw new TraceTestValidationNotReadyError("A successful validation for the current draft is required before enabling this test");
    }
    const current = this.store.traceTestRevisions.find(
      (candidate) => candidate.traceTestId === test.id && candidate.revision === input.expectedRevision
    );
    if (!current) throw new TraceTestRevisionConflictError(input.expectedRevision, test.currentRevision);
    if (current.lifecycle !== "draft") {
      throw new TraceTestValidationNotReadyError("Create a new draft revision before enabling this test again");
    }
    const reviewedAt = new Date().toISOString();
    const revision = test.currentRevision + 1;
    this.store.traceTestRevisions.push({
      ...structuredClone(current),
      id: `ttr_${randomUUID()}`,
      revision,
      lifecycle: "enabled",
      validationId: validation.id,
      validatedRevision: input.expectedRevision,
      createdByUserId: current.createdByUserId,
      reviewedByUserId: input.reviewedByUserId,
      createdAt: reviewedAt,
      reviewedAt
    });
    test.currentRevision = revision;
    test.enabledRevision = revision;
    test.updatedAt = reviewedAt;
    return this.toTraceTestDetail(test);
  }

  async recordTraceTestFunnelEvent(input: RecordTraceTestFunnelEventInputDb): Promise<void> {
    // Demo mode mirrors production idempotency without retaining source or
    // draft content. The set is intentionally not exposed as a product API.
    this.store.traceTestFunnelEvents.add(`${input.projectId}:${input.journeyId}:${input.event}`);
  }

  private toTraceTestSummary(test: (typeof this.store.traceTests)[number]): TraceTestSummary {
    return {
      id: test.id,
      projectId: test.projectId,
      sourceCaseId: test.sourceCaseId,
      sourceCaseRef: test.sourceCaseRef,
      sourceTraceRef: test.sourceTraceRef,
      lifecycle: test.enabledRevision === null ? "draft" : "enabled",
      currentRevision: test.currentRevision,
      enabledRevision: test.enabledRevision,
      hasUnpublishedChanges: test.enabledRevision !== null && test.currentRevision !== test.enabledRevision,
      createdAt: test.createdAt,
      updatedAt: test.updatedAt
    };
  }

  private toTraceTestDetail(test: (typeof this.store.traceTests)[number]): TraceTestDetail {
    return {
      ...this.toTraceTestSummary(test),
      sourceSnapshot: structuredClone(test.sourceSnapshot),
      sourceScope: structuredClone(test.sourceScope),
      createdByUserId: test.createdByUserId,
      revisions: this.store.traceTestRevisions
        .filter((revision) => revision.traceTestId === test.id)
        .sort((left, right) => left.revision - right.revision)
        .map((revision) => structuredClone(revision)),
      validations: this.store.traceTestValidations
        .filter((validation) => validation.traceTestId === test.id)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
        .map((validation) => structuredClone(validation))
    };
  }
}
