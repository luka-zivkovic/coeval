import { randomUUID } from "node:crypto";
import type { Trace } from "@coeval/audit/runtime";
import { demoExceptions, demoGoldenSet } from "@coeval/db";
import { verdictLabelFromPayload } from "@coeval/shared";
import type {
  Dataset,
  DatasetDetail,
  DatasetExposureEvent,
  DatasetItem,
  DatasetKind,
  DatasetReferenceProvenance,
  DatasetRevision,
  DatasetRevisionDetail,
  DatasetRevisionItem,
  DatasetRevisionPayloadSnapshot,
  GoldenSetEntry
} from "@coeval/shared";
import {
  datasetRevisionContentDigest,
  datasetRevisionDigest,
  datasetRevisionItemDigest,
  decidePublicDatasetRevisionCreation
} from "../lib/dataset-revision.js";
import type {
  AddDatasetItemsInputDb,
  CreateDatasetInputDb,
  CreateDatasetRevisionDbInput,
  ImportDatasetExamplesDbInput,
  ImportDatasetExamplesDbResult
} from "./contracts.js";
import type { DemoRepositoryStore } from "./demo-store.js";
import {
  CaseNotFoundError,
  DatasetNameTakenError,
  DatasetNotFoundError,
  DatasetRevisionConflictError,
  DatasetRevisionNotFoundError,
  SealedValidationUnavailableError
} from "./errors.js";
import type {
  CaseEvidenceRepositoryPort,
  DatasetRepositoryPort,
  GoldenEvidenceRepositoryPort,
  TraceImportRepositoryPort
} from "./ports.js";

interface DemoDatasetRepositoryDependencies extends
  Pick<DatasetRepositoryPort, "addDatasetItems" | "getDatasetDetail" | "getDatasetRevisionDetail">,
  Pick<CaseEvidenceRepositoryPort, "caseExistsForProject">,
  Pick<GoldenEvidenceRepositoryPort, "listGoldenSet">,
  Pick<TraceImportRepositoryPort, "importTrace"> {
  traceForGoldenEntry(entry: GoldenSetEntry): Trace;
}

// Internal DemoRepository dataset and immutable-revision slice. Its lazy
// facade callbacks preserve subclass dispatch, including the four-collection
// import rollback boundary, while all state remains on the one shared store.
export class DemoDatasetRepository implements DatasetRepositoryPort {
  constructor(
    private readonly store: DemoRepositoryStore,
    private readonly dependencies: DemoDatasetRepositoryDependencies
  ) {}

  async createDataset(input: CreateDatasetInputDb): Promise<Dataset> {
    const name = input.name.trim();
    const duplicate = this.store.datasets.find(
      (candidate) => candidate.projectId === input.projectId && candidate.name === name && !candidate.archivedAt
    );
    if (duplicate) throw new DatasetNameTakenError(name);
    const record = {
      id: `ds_${randomUUID()}`,
      projectId: input.projectId,
      name,
      description: input.description ?? null,
      kind: input.kind ?? ("custom" as DatasetKind),
      createdAt: new Date().toISOString(),
      archivedAt: null as string | null
    };
    this.store.datasets.push(record);
    return this.toDataset(record);
  }

  async listDatasets(projectId: string): Promise<Dataset[]> {
    return this.store.datasets
      .filter((dataset) => dataset.projectId === projectId && !dataset.archivedAt)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((dataset) => this.toDataset(dataset));
  }

  async getDatasetDetail(projectId: string, datasetId: string): Promise<DatasetDetail | null> {
    const dataset = this.store.datasets.find((candidate) => candidate.id === datasetId && candidate.projectId === projectId);
    if (!dataset) return null;
    return {
      ...this.toDataset(dataset),
      items: this.store.datasetItems
        .filter((item) => item.datasetId === datasetId)
        .sort((left, right) => left.addedAt.localeCompare(right.addedAt))
    };
  }

  async archiveDataset(projectId: string, datasetId: string): Promise<boolean> {
    const dataset = this.store.datasets.find(
      (candidate) => candidate.id === datasetId && candidate.projectId === projectId && !candidate.archivedAt
    );
    if (!dataset) return false;
    dataset.archivedAt = new Date().toISOString();
    return true;
  }

  async addDatasetItems(input: AddDatasetItemsInputDb): Promise<DatasetItem[]> {
    const dataset = this.store.datasets.find(
      (candidate) => candidate.id === input.datasetId && candidate.projectId === input.projectId && !candidate.archivedAt
    );
    if (!dataset) throw new DatasetNotFoundError(input.datasetId);
    // Validate every case before inserting any — matches addReviewQueueItems.
    for (const item of input.items) {
      if (!(await this.dependencies.caseExistsForProject(input.projectId, item.caseId))) {
        throw new CaseNotFoundError(item.caseId);
      }
    }
    const addedAt = new Date().toISOString();
    for (const item of input.items) {
      // Idempotent add with label upsert (PG parity): a repeat can update the
      // expected label / note, but a label-less append never nulls a stored one.
      const existing = this.store.datasetItems.find(
        (candidate) => candidate.datasetId === input.datasetId && candidate.caseId === item.caseId
      );
      if (existing) {
        existing.expectedLabel = item.expectedLabel ?? existing.expectedLabel;
        // Locked M2 invariant (PG parity): an explicit re-label to pass
        // CLEARS the stored step; a fail/label-less upsert without a step
        // keeps it.
        if (item.expectedLabel === "pass") existing.expectedFailStep = null;
        else if (item.expectedFailStep !== undefined) existing.expectedFailStep = item.expectedFailStep;
        existing.note = item.note ?? existing.note;
        continue;
      }
      this.store.datasetItems.push({
        id: `dsi_${randomUUID()}`,
        datasetId: input.datasetId,
        caseId: item.caseId,
        traceId: this.traceIdForCase(item.caseId),
        expectedLabel: item.expectedLabel ?? null,
        expectedFailStep: item.expectedFailStep ?? null,
        note: item.note ?? null,
        addedAt
      });
    }
    return this.store.datasetItems
      .filter((item) => item.datasetId === input.datasetId)
      .sort((left, right) => left.addedAt.localeCompare(right.addedAt));
  }

  async importDatasetExamples(input: ImportDatasetExamplesDbInput): Promise<ImportDatasetExamplesDbResult> {
    const dataset = this.store.datasets.find(
      (candidate) => candidate.id === input.datasetId && candidate.projectId === input.projectId && !candidate.archivedAt
    );
    if (!dataset) throw new DatasetNotFoundError(input.datasetId);

    // In-memory "transaction": snapshot the collections this flow mutates and
    // restore them on any failure, so a mid-flow throw can't strand cases
    // without dataset membership (PG gets the same guarantee from a real
    // transaction).
    const tracesSnapshot = new Map(this.store.traces);
    const traceSourcesSnapshot = new Map(this.store.traceSources);
    const inputIdentitiesSnapshot = new Map(this.store.caseInputIdentities);
    const datasetItemsSnapshot = [...this.store.datasetItems];
    try {
      const results: ImportDatasetExamplesDbResult["items"] = [];
      for (const item of input.items) {
        const imported = await this.dependencies.importTrace(input.projectId, "manual", {
          sourceTraceId: item.sourceTraceId,
          input: item.input,
          output: item.output,
          metadata: item.metadata,
          ...(item.steps ? { steps: item.steps } : {})
        }, { ingestionPurpose: input.ingestionPurpose });
        const [datasetItem] = await this.dependencies.addDatasetItems({
          projectId: input.projectId,
          datasetId: input.datasetId,
          items: [{
            caseId: imported.caseId,
            ...(item.expectedLabel ? { expectedLabel: item.expectedLabel } : {}),
            ...(item.expectedFailStep !== undefined ? { expectedFailStep: item.expectedFailStep } : {}),
            ...(item.note ? { note: item.note } : {})
          }]
        }).then((items) => [items.find((candidate) => candidate.caseId === imported.caseId)]);
        results.push({
          sourceTraceId: imported.sourceTraceId,
          caseId: imported.caseId,
          created: imported.created,
          datasetItemId: datasetItem ? datasetItem.id : null
        });
      }
      return { items: results };
    } catch (error) {
      this.store.traces.clear();
      for (const [key, value] of tracesSnapshot) this.store.traces.set(key, value);
      this.store.traceSources.clear();
      for (const [key, value] of traceSourcesSnapshot) this.store.traceSources.set(key, value);
      this.store.caseInputIdentities.clear();
      for (const [key, value] of inputIdentitiesSnapshot) this.store.caseInputIdentities.set(key, value);
      this.store.datasetItems.length = 0;
      this.store.datasetItems.push(...datasetItemsSnapshot);
      throw error;
    }
  }

  async createDatasetRevision(input: CreateDatasetRevisionDbInput): Promise<DatasetRevisionDetail> {
    const creation = decidePublicDatasetRevisionCreation(input.role);
    if (!creation.allowed) {
      if (creation.code === "rejected_public_sealed_creation_unavailable") throw new SealedValidationUnavailableError();
      if (creation.code === "rejected_public_regression_creation_unavailable") {
        throw new DatasetRevisionConflictError(
          "Regression/golden revisions are created only by promotion and retirement governance"
        );
      }
      throw new DatasetRevisionConflictError("Unknown dataset revision role");
    }
    const dataset = await this.dependencies.getDatasetDetail(input.projectId, input.datasetId);
    if (!dataset || dataset.archivedAt) throw new DatasetNotFoundError(input.datasetId);
    if (dataset.items.length === 0) throw new DatasetRevisionConflictError("Cannot freeze an empty working collection");

    const idempotencyLookup = input.idempotencyKey ? `${input.projectId}:${input.idempotencyKey}` : null;
    if (idempotencyLookup) {
      const priorId = this.store.datasetRevisionIdempotency.get(idempotencyLookup);
      if (priorId) {
        const prior = await this.dependencies.getDatasetRevisionDetail(input.projectId, priorId);
        if (!prior) throw new DatasetRevisionConflictError("Idempotent dataset revision vanished");
        if (prior.sourceDatasetId !== input.datasetId || prior.role !== input.role) {
          throw new DatasetRevisionConflictError("Idempotency key was already used for a different dataset revision request");
        }
        return prior;
      }
    }

    const seriesId = `dataset:${dataset.id}`;
    const series = this.store.datasetRevisions
      .filter((revision) => revision.projectId === input.projectId && revision.seriesId === seriesId)
      .sort((left, right) => right.revisionNumber - left.revisionNumber);
    const parent = series[0] ?? null;
    if (input.expectedParentRevisionId !== undefined && input.expectedParentRevisionId !== parent?.id) {
      throw new DatasetRevisionConflictError(
        `Working collection revision changed from ${input.expectedParentRevisionId} to ${parent?.id ?? "none"}`
      );
    }

    const now = new Date().toISOString();
    const revisionId = `dsr_${randomUUID()}`;
    const items = dataset.items.map((item, position) => {
      const trace = this.store.traces.get(item.caseId);
      if (!trace) throw new DatasetRevisionConflictError(`Case ${item.caseId} has no retained payload to freeze`);
      const payloadSnapshot: DatasetRevisionPayloadSnapshot = {
        input: structuredClone(trace.input),
        output: structuredClone(trace.output),
        metadata: structuredClone(trace.metadata ?? {}),
        ...(trace.steps ? { steps: structuredClone(trace.steps) } : {})
      };
      const inputIdentity = this.store.caseInputIdentities.get(item.caseId);
      if (!inputIdentity) {
        throw new DatasetRevisionConflictError(
          `Case ${item.caseId} has no retained pre-redaction input identity and cannot be frozen as exact evidence`
        );
      }
      const matching = item.expectedLabel
        ? this.store.verdicts.filter((verdict) =>
            verdict.caseId === item.caseId && verdictLabelFromPayload(verdict.payload) === item.expectedLabel
          )
        : [];
      const adjudicated = matching.filter((verdict) => verdict.source === "adjudicated");
      const human = matching.filter((verdict) => verdict.source === "human");
      const supporting = adjudicated.length > 0 ? adjudicated : human;
      const referenceProvenance: DatasetReferenceProvenance = !item.expectedLabel
        ? {
            kind: "unlabeled",
            sourceId: item.id,
            verdictIds: [],
            actorUserIds: [],
            basis: "No reference label was present when the collection was frozen."
          }
        : supporting.length > 0
          ? {
              kind: adjudicated.length > 0 ? "adjudication" : "human_verdict",
              sourceId: item.id,
              verdictIds: supporting.map((verdict) => verdict.id),
              actorUserIds: supporting.flatMap((verdict) => verdict.actorUserId ? [verdict.actorUserId] : []),
              basis: adjudicated.length > 0
                ? "Dataset expectation matched retained adjudicated truth."
                : "Dataset expectation matched retained human verdict history."
            }
          : {
              kind: "dataset_claim",
              sourceId: item.id,
              verdictIds: [],
              actorUserIds: [],
              basis: "Mutable collection expectation; not adjudicated human truth."
            };
      const itemDigest = datasetRevisionItemDigest({
        inputIdentity,
        redactedPayload: payloadSnapshot,
        referenceLabel: item.expectedLabel,
        expectedFailStep: item.expectedFailStep,
        reviewProvenance: referenceProvenance,
        note: item.note
      });
      return {
        id: `dsri_${randomUUID()}`,
        revisionId,
        position,
        sourceCaseId: item.caseId,
        sourceTraceId: item.traceId,
        sourceDatasetItemId: item.id,
        sourceGoldenEntryId: null,
        inputDigest: inputIdentity.digest,
        itemDigest,
        payloadSnapshot,
        referenceLabel: item.expectedLabel,
        referenceFailStep: item.expectedFailStep,
        referenceProvenance,
        note: item.note,
        createdAt: now
      } satisfies DatasetRevisionItem;
    });
    const itemDigests = items.map((item) => item.itemDigest);
    const contentDigest = datasetRevisionContentDigest(itemDigests);
    if (input.reuseLatestContent && parent?.role === input.role && parent.contentDigest === contentDigest) {
      const detail = await this.dependencies.getDatasetRevisionDetail(input.projectId, parent.id);
      if (!detail) throw new DatasetRevisionConflictError("Reusable dataset revision vanished");
      return detail;
    }
    const sealedInputDigests = new Set(
      this.store.datasetRevisionItems
        .filter((item) => this.store.datasetRevisions.some((revision) =>
          revision.id === item.revisionId && revision.projectId === input.projectId && revision.role === "sealed_validation"
        ))
        .map((item) => item.inputDigest)
    );
    if (items.some((item) => sealedInputDigests.has(item.inputDigest))) {
      throw new DatasetRevisionConflictError(
        "Working collection overlaps sealed validation input; explicit governed declassification is required before nonsealed use"
      );
    }
    const revision: DatasetRevision = {
      id: revisionId,
      projectId: input.projectId,
      seriesId,
      revisionNumber: (parent?.revisionNumber ?? 0) + 1,
      sourceDatasetId: dataset.id,
      parentRevisionId: parent?.id ?? null,
      role: input.role,
      sourceKind: "collection_snapshot",
      identityBasis: "input-identity/v1",
      contentDigest,
      revisionDigest: datasetRevisionDigest({ role: input.role, itemDigests }),
      itemCount: items.length,
      provenanceLevel: "unverified",
      exposureState: "visible_by_design",
      semanticLeakageDetection: "unsupported",
      createdByUserId: input.createdByUserId ?? null,
      createdAt: now
    };
    const exposure = this.createDemoExposure(revision, {
      kind: "created",
      exposureClass: "lineage",
      activity: "revision_create",
      subjectKind: input.createdByUserId ? "person" : "system",
      subjectId: input.createdByUserId ?? null,
      actorUserId: input.createdByUserId ?? null,
      idempotencyKey: `revision-created:${revision.id}`
    });
    this.store.datasetRevisions.push(revision);
    this.store.datasetRevisionItems.push(...items);
    this.store.datasetExposureEvents.push(exposure);
    if (idempotencyLookup) this.store.datasetRevisionIdempotency.set(idempotencyLookup, revision.id);
    return { ...structuredClone(revision), items: structuredClone(items), exposures: [structuredClone(exposure)] };
  }

  async listDatasetRevisions(projectId: string, sourceDatasetId?: string): Promise<DatasetRevision[]> {
    return this.store.datasetRevisions
      .filter((revision) => revision.projectId === projectId && (!sourceDatasetId || revision.sourceDatasetId === sourceDatasetId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .map((revision) => structuredClone(revision));
  }

  async getDatasetRevisionDetail(projectId: string, revisionId: string): Promise<DatasetRevisionDetail | null> {
    const revision = this.store.datasetRevisions.find((candidate) => candidate.projectId === projectId && candidate.id === revisionId);
    if (!revision) return null;
    return {
      ...structuredClone(revision),
      items: this.store.datasetRevisionItems
        .filter((item) => item.revisionId === revision.id)
        .sort((left, right) => left.position - right.position)
        .map((item) => structuredClone(item)),
      exposures: this.store.datasetExposureEvents
        .filter((event) => event.revisionId === revision.id)
        .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id))
        .map((event) => structuredClone(event))
    };
  }

  async recordDatasetRevisionContentView(input: {
    projectId: string;
    revisionId: string;
    actorUserId?: string | undefined;
  }): Promise<void> {
    const revision = this.store.datasetRevisions.find((candidate) =>
      candidate.projectId === input.projectId && candidate.id === input.revisionId
    );
    if (!revision) throw new DatasetRevisionNotFoundError(input.revisionId);
    this.store.datasetExposureEvents.push({
      id: `dse_${randomUUID()}`,
      projectId: input.projectId,
      revisionId: input.revisionId,
      revisionItemId: null,
      kind: "human_access",
      exposureClass: "development",
      activity: "content_view",
      subjectKind: input.actorUserId ? "person" : "system",
      subjectId: input.actorUserId ?? null,
      actorUserId: input.actorUserId ?? null,
      evidenceRefKind: "dataset_revision",
      evidenceRefId: input.revisionId,
      reason: null,
      details: {},
      occurredAt: new Date().toISOString()
    });
  }

  async getOrCreateRegressionDatasetRevision(
    projectId: string,
    actorUserId?: string,
    criterionVersionId?: string
  ): Promise<DatasetRevisionDetail> {
    const projectCriteria = this.store.criteria.filter((criterion) => criterion.projectId === projectId);
    const resolvedCriterionVersionId = criterionVersionId ?? (() => {
      if (projectCriteria.length !== 1) {
        throw new DatasetRevisionConflictError(
          `Project ${projectId} requires an explicit criterionVersionId for regression evidence.`
        );
      }
      const latest = this.store.criterionVersions
        .filter((version) => version.criterionId === projectCriteria[0]!.id)
        .sort((left, right) => right.revision - left.revision)[0];
      if (!latest) throw new DatasetRevisionConflictError("Criterion has no immutable definition.");
      return latest.id;
    })();
    const golden = await this.dependencies.listGoldenSet(projectId, resolvedCriterionVersionId);
    const now = new Date().toISOString();
    const revisionId = `dsr_${randomUUID()}`;
    const items = golden.map((entry, position) => {
      const trace = this.store.traces.get(entry.caseId) ?? this.dependencies.traceForGoldenEntry(entry);
      const payloadSnapshot: DatasetRevisionPayloadSnapshot = {
        input: structuredClone(trace.input),
        output: structuredClone(trace.output),
        metadata: structuredClone(trace.metadata ?? {}),
        ...(trace.steps ? { steps: structuredClone(trace.steps) } : {})
      };
      const inputIdentity = this.store.caseInputIdentities.get(entry.caseId);
      if (!inputIdentity) {
        throw new DatasetRevisionConflictError(
          `Case ${entry.caseId} has no retained pre-redaction input identity and cannot be frozen as exact evidence`
        );
      }
      const matchingHuman = this.store.verdicts.filter((verdict) =>
        verdict.caseId === entry.caseId &&
        (verdict.source === "human" || verdict.source === "adjudicated") &&
        verdict.skillVersionId !== null &&
        this.store.skillVersionCriteria.get(verdict.skillVersionId) === resolvedCriterionVersionId &&
        verdictLabelFromPayload(verdict.payload) === entry.agreedLabel
      );
      const referenceProvenance: DatasetReferenceProvenance = {
        kind: "golden_promotion",
        sourceId: entry.id,
        verdictIds: matchingHuman.map((verdict) => verdict.id),
        actorUserIds: matchingHuman.flatMap((verdict) => verdict.actorUserId ? [verdict.actorUserId] : []),
        basis: "Visible golden promotion; known-failure governance, not sealed validation."
      };
      const itemDigest = datasetRevisionItemDigest({
        inputIdentity,
        redactedPayload: payloadSnapshot,
        referenceLabel: entry.agreedLabel,
        expectedFailStep: null,
        reviewProvenance: referenceProvenance,
        note: entry.reason
      });
      return {
        id: `dsri_${randomUUID()}`,
        revisionId,
        position,
        sourceCaseId: entry.caseId,
        sourceTraceId: entry.traceId,
        sourceDatasetItemId: null,
        sourceGoldenEntryId: entry.id,
        inputDigest: inputIdentity.digest,
        itemDigest,
        payloadSnapshot,
        referenceLabel: entry.agreedLabel,
        referenceFailStep: null,
        referenceProvenance,
        note: entry.reason,
        createdAt: now
      } satisfies DatasetRevisionItem;
    });
    const itemDigests = items.map((item) => item.itemDigest);
    const revisionDigest = datasetRevisionDigest({ role: "regression_golden", itemDigests });
    const currentRevisionId = this.store.regressionDatasetRevisionIdsByCriterion.get(resolvedCriterionVersionId)
      ?? (projectCriteria.length === 1 ? this.store.regressionDatasetRevisionId : null);
    const current = currentRevisionId
      ? this.store.datasetRevisions.find((revision) => revision.id === currentRevisionId)
      : undefined;
    if (current?.revisionDigest === revisionDigest) {
      const detail = await this.dependencies.getDatasetRevisionDetail(projectId, current.id);
      if (!detail) throw new DatasetRevisionConflictError("Current regression revision vanished");
      return detail;
    }
    const series = this.store.datasetRevisions.filter((revision) =>
      revision.projectId === projectId && revision.seriesId === `golden:${projectId}:${resolvedCriterionVersionId}`
    );
    const parent = [...series].sort((left, right) => right.revisionNumber - left.revisionNumber)[0] ?? null;
    const revision: DatasetRevision = {
      id: revisionId,
      projectId,
      seriesId: `golden:${projectId}:${resolvedCriterionVersionId}`,
      revisionNumber: (parent?.revisionNumber ?? 0) + 1,
      sourceDatasetId: null,
      parentRevisionId: parent?.id ?? null,
      role: "regression_golden",
      sourceKind: "golden_snapshot",
      identityBasis: "input-identity/v1",
      contentDigest: datasetRevisionContentDigest(itemDigests),
      revisionDigest,
      itemCount: items.length,
      provenanceLevel: items.length > 0 && items.every((item) => item.referenceProvenance.verdictIds.length > 0)
        ? "reviewed_unblinded"
        : "legacy",
      exposureState: "visible_by_design",
      semanticLeakageDetection: "unsupported",
      createdByUserId: actorUserId ?? null,
      createdAt: now
    };
    const created = this.createDemoExposure(revision, {
      kind: "created",
      exposureClass: "lineage",
      activity: "revision_create",
      subjectKind: actorUserId ? "person" : "system",
      subjectId: actorUserId ?? null,
      actorUserId: actorUserId ?? null,
      idempotencyKey: `revision-created:${revision.id}`
    });
    const visible = this.createDemoExposure(revision, {
      kind: "legacy_pretracking",
      exposureClass: "development",
      activity: "legacy_import",
      subjectKind: "system",
      subjectId: "golden-registry",
      actorUserId: actorUserId ?? null,
      idempotencyKey: `regression-visible:${revision.id}`
    });
    this.store.datasetRevisions.push(revision);
    this.store.datasetRevisionItems.push(...items);
    this.store.datasetExposureEvents.push(created, visible);
    this.store.regressionDatasetRevisionIdsByCriterion.set(resolvedCriterionVersionId, revision.id);
    if (projectCriteria.length === 1) this.store.regressionDatasetRevisionId = revision.id;
    return { ...structuredClone(revision), items: structuredClone(items), exposures: [structuredClone(created), structuredClone(visible)] };
  }

  private createDemoExposure(
    revision: DatasetRevision,
    input: Pick<DatasetExposureEvent, "kind" | "exposureClass" | "activity" | "subjectKind" | "subjectId" | "actorUserId"> & { idempotencyKey: string }
  ): DatasetExposureEvent {
    return {
      id: `dse_${randomUUID()}`,
      projectId: revision.projectId,
      revisionId: revision.id,
      revisionItemId: null,
      kind: input.kind,
      exposureClass: input.exposureClass,
      activity: input.activity,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      actorUserId: input.actorUserId,
      evidenceRefKind: null,
      evidenceRefId: null,
      reason: null,
      details: {},
      occurredAt: new Date().toISOString()
    };
  }

  async removeDatasetItem(projectId: string, datasetId: string, itemId: string): Promise<boolean> {
    const dataset = this.store.datasets.find((candidate) => candidate.id === datasetId && candidate.projectId === projectId);
    if (!dataset) return false;
    const index = this.store.datasetItems.findIndex((item) => item.datasetId === datasetId && item.id === itemId);
    if (index < 0) return false;
    this.store.datasetItems.splice(index, 1);
    return true;
  }

  private toDataset(record: {
    id: string;
    projectId: string;
    name: string;
    description: string | null;
    kind: DatasetKind;
    createdAt: string;
    archivedAt: string | null;
  }): Dataset {
    return {
      ...record,
      itemCount: this.store.datasetItems.filter((item) => item.datasetId === record.id).length
    };
  }

  private traceIdForCase(caseId: string): string {
    const imported = this.store.traces.get(caseId);
    if (imported) return imported.id;
    const exception = demoExceptions.find((candidate) => candidate.id === caseId);
    if (exception) return exception.traceId;
    const golden = demoGoldenSet.find((entry) => entry.caseId === caseId);
    if (golden) return golden.traceId;
    // caseExistsForProject guards every caller, so this is unreachable.
    throw new CaseNotFoundError(caseId);
  }
}
