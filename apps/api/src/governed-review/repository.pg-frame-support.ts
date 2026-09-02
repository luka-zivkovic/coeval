import type { PoolClient } from "pg";
import { canonicalJson } from "../lib/assessment-receipt.js";

import { governedReviewRequestDigest } from "../lib/governed-review.js";
import type { CreateGovernedReviewBatchInput } from "./contracts.js";
import {
  GovernedReviewConflictError,
  GovernedReviewIdempotencyConflictError,
  GovernedReviewNotFoundError
} from "./errors.js";
import { assertBlindProjectionSafe, projectGovernedReviewPayload } from "./projection.js";
import type { GovernedBlindTaskViewArtifact, GovernedReviewActor } from "./repository.js";
import { type GovernedSelectionFrameItem } from "./selection.js";

import {
  ALLOWED_LABELS,
  MAX_BLIND_VIEW_BYTES,
  dbDigest,
  iso,
  parseJson,
  sealedItemId,
  sha256Bytes,
  stableId
} from "./repository.pg-common.js";

interface PreparedFrameItem extends GovernedSelectionFrameItem {
  sourceId: string;
}
export function buildBlindTaskViewArtifact(row: Record<string, unknown>): GovernedBlindTaskViewArtifact {
  const payloadSnapshot = parseJson(row.review_payload_snapshot);
  assertBlindProjectionSafe(payloadSnapshot);
  const view = {
    contract: "coeval/governed-blind-task-view/v1",
    schemaVersion: 1,
    canonicalizationVersion: "coeval-canonical-json/v1",
    taskId: String(row.task_id ?? row.id),
    batchId: String(row.batch_id),
    servePosition: Number(row.serve_order),
    criterion: {
      criterionId: String(row.criterion_id),
      criterionVersionId: String(row.criterion_version_id),
      name: String(row.criterion_name),
      definition: String(row.criterion_definition),
      criterionDigest: String(row.criterion_digest)
    },
    instruction: {
      instructionVersionId: String(row.instruction_version_id),
      title: String(row.title),
      instructions: String(row.instructions),
      failureCodeGuidance: String(row.failure_code_guidance),
      allowedLabels: ALLOWED_LABELS,
      instructionDigest: String(row.instruction_digest)
    },
    payloadSnapshot
  };
  const canonicalBytes = Buffer.from(canonicalJson(view), "utf8");
  if (canonicalBytes.byteLength > MAX_BLIND_VIEW_BYTES) {
    throw new GovernedReviewConflictError(
      "governed_review_transition_conflict",
      "The immutable blind view exceeds the governed 2 MiB boundary"
    );
  }
  return { canonicalBytes, viewDigest: sha256Bytes(canonicalBytes) };
}

export async function assertBatchBlindViewsWithinLimit(
  client: PoolClient,
  projectId: string,
  batchId: string
): Promise<void> {
  const views = await client.query(
    `select task.id as task_id,task.batch_id,task.serve_order,
            batch.criterion_version_id,batch.instruction_version_id,
            item.review_payload_snapshot,
            instruction.title,instruction.instructions,instruction.failure_code_guidance,
            instruction.content_digest as instruction_digest,
            criterion.criterion_id,criterion.name as criterion_name,
            criterion.definition as criterion_definition,criterion.criterion_digest
     from governed_review_tasks task
     join governed_review_batches batch on batch.id=task.batch_id
     join governed_review_batch_items batch_item on batch_item.id=task.batch_item_id
     join governed_review_items item on item.id=batch_item.review_item_id
     join review_instruction_versions instruction on instruction.id=batch.instruction_version_id
     join criterion_versions criterion on criterion.id=batch.criterion_version_id
     where task.batch_id=$1 and task.project_id=$2
     order by task.serve_order,task.id`,
    [batchId, projectId]
  );
  for (const row of views.rows) buildBlindTaskViewArtifact(row);
}

interface PreparedFrame {
  sourcePopulationKind: "dataset_revision" | "sealed_intake" | "analysis_promotion_handoff";
  sourcePopulationId: string;
  populationId: string;
  populationDefinition: unknown;
  collectionProvenance: unknown;
  populationDigest: string;
  windowStart: string | null;
  windowEnd: string | null;
  custodianSubjectId: string | null;
  custodianRole: string | null;
  items: PreparedFrameItem[];
  sourceToReviewItemId: Map<string, string>;
}

export async function prepareRevisionFrame(
  client: PoolClient,
  actor: GovernedReviewActor,
  creatorSubjectId: string,
  revisionId: string,
  roleIntent: CreateGovernedReviewBatchInput["roleIntent"]
): Promise<PreparedFrame> {
  const revision = (await client.query(
    `select * from dataset_revisions
     where id=$1 and project_id=$2 and role=$3 and role<>'sealed_validation'
       and source_kind<>'analysis_population'
     for key share`,
    [revisionId, actor.projectId, roleIntent]
  )).rows[0];
  if (!revision) throw new GovernedReviewNotFoundError();
  const sourceItems = await client.query(
    `select * from dataset_revision_items
     where revision_id=$1 and project_id=$2 order by position,id for key share`,
    [revisionId, actor.projectId]
  );
  if (sourceItems.rows.length !== Number(revision.item_count)) {
    throw new GovernedReviewConflictError(
      "governed_review_transition_conflict",
      "The immutable source revision item count does not match its frozen evidence"
    );
  }
  const redactionProvenance = {
    contract: "coeval/governed-review-projection/v1",
    source: "immutable_dataset_revision",
    copiedFields: ["input", "output", "steps"],
    metadataAccepted: false
  };
  const items: PreparedFrameItem[] = [];
  const sourceToReviewItemId = new Map<string, string>();
  for (const source of sourceItems.rows) {
    const reviewItemId = stableId("gri", actor.projectId, "dataset-revision-item", String(source.id));
    const payload = projectGovernedReviewPayload(parseJson(source.payload_snapshot));
    const content = {
      identityBasis: "input-identity/v1",
      inputDigest: String(source.input_digest),
      redactionProvenance,
      reviewPayloadProjectionVersion: "governed-review-payload/v1",
      reviewPayloadSnapshot: payload,
      sealedFramePosition: null,
      sealedIntakePopulationId: null,
      sealedPredecessorRevisionId: null,
      sealedPredecessorRevisionItemId: null,
      sourceKind: "dataset_revision_item",
      sourceItemDigest: String(source.item_digest),
      sourceRevisionId: revisionId,
      sourceRevisionItemId: String(source.id)
    };
    const contentDigest = await dbDigest(client, "governed-review-item/v1", content);
    await client.query(
      `insert into governed_review_items
         (id,project_id,source_kind,source_revision_id,source_revision_item_id,identity_basis,
          input_digest,source_item_digest,review_payload_projection_version,review_payload_snapshot,
          redaction_provenance,content_digest,idempotency_key,request_digest,created_by_subject_id)
       values ($1,$2,'dataset_revision_item',$3,$4,'input-identity/v1',$5,$6,
               'governed-review-payload/v1',$7::jsonb,$8::jsonb,$9,$10,$11,$12)
       on conflict (id) do nothing`,
      [reviewItemId, actor.projectId, revisionId, source.id, source.input_digest, source.item_digest,
        JSON.stringify(payload), JSON.stringify(redactionProvenance), contentDigest,
        `source-revision-item:${source.id}`,
        governedReviewRequestDigest({ sourceRevisionId: revisionId, sourceRevisionItemId: source.id, payload }),
        creatorSubjectId]
    );
    const persisted = (await client.query(
      `select content_digest from governed_review_items where id=$1 and project_id=$2`,
      [reviewItemId, actor.projectId]
    )).rows[0];
    if (!persisted || String(persisted.content_digest) !== contentDigest) {
      throw new GovernedReviewIdempotencyConflictError();
    }
    items.push({ id: reviewItemId, digest: contentDigest, sourceId: String(source.id) });
    sourceToReviewItemId.set(String(source.id), reviewItemId);
    sourceToReviewItemId.set(reviewItemId, reviewItemId);
  }
  return {
    sourcePopulationKind: "dataset_revision",
    sourcePopulationId: revisionId,
    populationId: `dataset-revision:${revisionId}`,
    populationDefinition: {
      kind: "immutable_dataset_revision",
      revisionId,
      role: roleIntent
    },
    collectionProvenance: {
      kind: "dataset_revision",
      revisionDigest: String(revision.revision_digest),
      provenanceLevel: String(revision.provenance_level),
      sourceKind: String(revision.source_kind)
    },
    populationDigest: String(revision.content_digest),
    windowStart: null,
    windowEnd: null,
    custodianSubjectId: null,
    custodianRole: null,
    items,
    sourceToReviewItemId
  };
}

export async function preparePromotionFrame(
  client: PoolClient,
  actor: GovernedReviewActor,
  creatorSubjectId: string,
  promotionId: string,
  criterionVersionId: string
): Promise<PreparedFrame> {
  const promotion = (await client.query(
    `select promotion.*,revision.role,revision.source_kind,revision.content_digest as revision_content_digest,
            revision.revision_digest,revision.provenance_level
     from analysis_criterion_promotions promotion
     join dataset_revisions revision
       on revision.id=promotion.source_dataset_revision_id
      and revision.project_id=promotion.project_id
     where promotion.id=$1 and promotion.project_id=$2
       and promotion.criterion_version_id=$3
       and revision.role='analysis_authoring'
       and revision.source_kind='analysis_population'
     for key share of promotion,revision`,
    [promotionId, actor.projectId, criterionVersionId]
  )).rows[0];
  if (!promotion) throw new GovernedReviewNotFoundError();
  const revisionId = String(promotion.source_dataset_revision_id);
  const sourceItems = await client.query(
    `select * from dataset_revision_items
     where revision_id=$1 and project_id=$2 order by position,id for key share`,
    [revisionId, actor.projectId]
  );
  const revision = (await client.query(
    `select * from dataset_revisions where id=$1 and project_id=$2 for key share`,
    [revisionId, actor.projectId]
  )).rows[0];
  if (!revision || sourceItems.rows.length !== Number(revision.item_count)) {
    throw new GovernedReviewConflictError(
      "governed_review_transition_conflict",
      "The promotion handoff source revision no longer matches its immutable frame"
    );
  }
  const prepared = await materializeRevisionReviewItems(
    client,
    actor,
    creatorSubjectId,
    revisionId,
    sourceItems.rows
  );
  return {
    sourcePopulationKind: "analysis_promotion_handoff",
    sourcePopulationId: promotionId,
    populationId: revisionId,
    populationDefinition: {
      criterionVersionId,
      handoffDigest: String(promotion.handoff_digest),
      kind: "analysis_promotion_handoff",
      promotionId,
      sourceDatasetRevisionId: revisionId
    },
    collectionProvenance: {
      createsEvaluator: false,
      createsTruth: false,
      evidenceClass: "development_authoring_not_truth",
      handoffDigest: String(promotion.handoff_digest),
      kind: "analysis_promotion_handoff",
      promotionId,
      provenanceLevel: String(promotion.provenance_level),
      revisionDigest: String(promotion.source_dataset_revision_digest),
      sourceKind: "analysis_population"
    },
    populationDigest: String(promotion.source_dataset_revision_content_digest),
    windowStart: null,
    windowEnd: null,
    custodianSubjectId: null,
    custodianRole: null,
    ...prepared
  };
}

async function materializeRevisionReviewItems(
  client: PoolClient,
  actor: GovernedReviewActor,
  creatorSubjectId: string,
  revisionId: string,
  sourceRows: Array<Record<string, unknown>>
): Promise<Pick<PreparedFrame, "items" | "sourceToReviewItemId">> {
  const redactionProvenance = {
    contract: "coeval/governed-review-projection/v1",
    source: "immutable_dataset_revision",
    copiedFields: ["input", "output", "steps"],
    metadataAccepted: false
  };
  const items: PreparedFrameItem[] = [];
  const sourceToReviewItemId = new Map<string, string>();
  for (const source of sourceRows) {
    const reviewItemId = stableId("gri", actor.projectId, "dataset-revision-item", String(source.id));
    const payload = projectGovernedReviewPayload(parseJson(source.payload_snapshot));
    const content = {
      identityBasis: "input-identity/v1",
      inputDigest: String(source.input_digest),
      redactionProvenance,
      reviewPayloadProjectionVersion: "governed-review-payload/v1",
      reviewPayloadSnapshot: payload,
      sealedFramePosition: null,
      sealedIntakePopulationId: null,
      sealedPredecessorRevisionId: null,
      sealedPredecessorRevisionItemId: null,
      sourceKind: "dataset_revision_item",
      sourceItemDigest: String(source.item_digest),
      sourceRevisionId: revisionId,
      sourceRevisionItemId: String(source.id)
    };
    const contentDigest = await dbDigest(client, "governed-review-item/v1", content);
    await client.query(
      `insert into governed_review_items
         (id,project_id,source_kind,source_revision_id,source_revision_item_id,identity_basis,
          input_digest,source_item_digest,review_payload_projection_version,review_payload_snapshot,
          redaction_provenance,content_digest,idempotency_key,request_digest,created_by_subject_id)
       values ($1,$2,'dataset_revision_item',$3,$4,'input-identity/v1',$5,$6,
               'governed-review-payload/v1',$7::jsonb,$8::jsonb,$9,$10,$11,$12)
       on conflict (id) do nothing`,
      [reviewItemId, actor.projectId, revisionId, source.id, source.input_digest, source.item_digest,
        JSON.stringify(payload), JSON.stringify(redactionProvenance), contentDigest,
        `source-revision-item:${source.id}`,
        governedReviewRequestDigest({ sourceRevisionId: revisionId, sourceRevisionItemId: source.id, payload }),
        creatorSubjectId]
    );
    const persisted = (await client.query(
      `select content_digest from governed_review_items where id=$1 and project_id=$2`,
      [reviewItemId, actor.projectId]
    )).rows[0];
    if (!persisted || String(persisted.content_digest) !== contentDigest) {
      throw new GovernedReviewIdempotencyConflictError();
    }
    items.push({ id: reviewItemId, digest: contentDigest, sourceId: String(source.id) });
    sourceToReviewItemId.set(String(source.id), reviewItemId);
    sourceToReviewItemId.set(reviewItemId, reviewItemId);
  }
  return { items, sourceToReviewItemId };
}

export async function prepareSealedFrame(
  client: PoolClient,
  projectId: string,
  intakeId: string
): Promise<PreparedFrame> {
  const population = (await client.query(
    `select * from governed_sealed_intake_populations
     where id=$1 and project_id=$2 for key share`, [intakeId, projectId]
  )).rows[0];
  if (!population) throw new GovernedReviewNotFoundError();
  const rows = await client.query(
    `select id,content_digest,sealed_frame_position from governed_review_items
     where sealed_intake_population_id=$1 and project_id=$2
     order by sealed_frame_position,id for key share`,
    [intakeId, projectId]
  );
  if (rows.rows.length !== Number(population.frame_count)) {
    throw new GovernedReviewConflictError(
      "governed_review_transition_conflict",
      "The protected sealed frame does not match its immutable population receipt"
    );
  }
  const items = rows.rows.map((row) => ({
    id: String(row.id),
    digest: String(row.content_digest),
    sourceId: String(row.id)
  }));
  return {
    sourcePopulationKind: "sealed_intake",
    sourcePopulationId: intakeId,
    populationId: intakeId,
    populationDefinition: parseJson(population.population_definition),
    collectionProvenance: parseJson(population.collection_provenance),
    populationDigest: String(population.frame_digest),
    windowStart: population.window_start ? iso(population.window_start) : null,
    windowEnd: population.window_end ? iso(population.window_end) : null,
    custodianSubjectId: String(population.custodian_subject_id),
    custodianRole: String(population.custodian_role_at_review),
    items,
    sourceToReviewItemId: new Map(items.map((item) => [item.id, item.id]))
  };
}

export function translateSelection(
  selection: CreateGovernedReviewBatchInput["selection"],
  aliases: Map<string, string>,
  sealedIntakeId?: string
) {
  const translate = (id: string) => aliases.get(id) ?? (
    sealedIntakeId && aliases.has(sealedItemId(sealedIntakeId, id))
      ? sealedItemId(sealedIntakeId, id)
      : id
  );
  if (selection.method === "stratified_random") {
    return {
      ...selection,
      strata: selection.strata.map((stratum) => ({
        ...stratum,
        sourceItemIds: stratum.sourceItemIds.map(translate)
      }))
    };
  }
  if (
    selection.method === "convenience" || selection.method === "uncertainty" ||
    selection.method === "failure_hunting" || selection.method === "manual"
  ) {
    return { ...selection, selectedSourceItemIds: selection.selectedSourceItemIds.map(translate) };
  }
  return selection;
}
