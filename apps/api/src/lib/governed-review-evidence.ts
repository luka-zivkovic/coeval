// Blind-view, imported-truth, provenance, and agreement evidence pipeline.
import {
  GovernedBlindTaskViewSchema,
  GovernedDatasetReferenceProvenanceSchema,
  ImportedHumanTruthSchema,
  type CriterionVersion,
  type GovernedBlindTaskView,
  type GovernedDatasetReferenceProvenance,
  type GovernedReviewInstructionVersion,
  type GovernedReviewItem,
  type GovernedReviewTask,
  type ImportedHumanTruth
} from "@coeval/shared";
import { canonicalJson, sha256Digest } from "./assessment-receipt.js";
import { evaluatorSuiteCriterionDigest } from "./evaluator-suite.js";
import { governedContentV1Digest } from "./governed-content-digest.js";
import {
  MAX_GOVERNED_REVIEW_PAYLOAD_BYTES,
  assertCanonicalJsonSize,
  assertSame,
  assertSortedUnique,
  sha256Bytes
} from "./governed-review-common.js";
import {
  verifyGovernedReviewInstructionVersion,
  verifyGovernedReviewItem,
  verifyGovernedReviewTask
} from "./governed-review-artifacts.js";

const FORBIDDEN_BLIND_KEYS = new Set([
  "caseId", "traceId", "sourceCaseId", "sourceTraceId", "datasetId", "datasetItemId",
  "datasetRevisionId", "datasetRevisionItemId", "sourceDatasetRevisionId",
  "sourceDatasetRevisionItemId", "sourceRevisionId", "sourceRevisionItemId", "sealedIntakeId",
  "sealedIntakeItemId", "sealedIntakePopulationId", "skillVersionId",
  "evaluatorVersionId", "evaluatorOutput", "evaluatorOutputs", "evaluatorLabel",
  "evaluatorRationale", "judgeLabel", "judgedLabel", "judgeRationale", "judgeRun",
  "rawJudgeCall", "rawRequest", "rawResponse", "expectedLabel", "expectedFailStep",
  "goldenLabel", "latestHumanLabel", "peerLabel", "peerLabels", "adjudication",
  "verdict", "verdicts"
]);
const NORMALIZED_FORBIDDEN_BLIND_KEYS = new Set(
  [...FORBIDDEN_BLIND_KEYS].map((key) => normalizeBlindKey(key))
);
const MAX_IMPORTED_SOURCE_ARTIFACT_BYTES = 10 * 1024 * 1024;

export function governedReviewRequestDigest(value: unknown): string {
  return governedContentV1Digest("coeval/governed-review-request/v1", value);
}

export function decideGovernedReviewIdempotency(
  existingRequestDigest: string,
  candidateSemanticRequest: unknown
): { status: "replay" | "conflict"; candidateRequestDigest: string } {
  const candidateRequestDigest = governedReviewRequestDigest(candidateSemanticRequest);
  return { status: existingRequestDigest === candidateRequestDigest ? "replay" : "conflict", candidateRequestDigest };
}

export function buildGovernedBlindTaskView(input: {
  task: GovernedReviewTask;
  item: GovernedReviewItem;
  instruction: GovernedReviewInstructionVersion;
  criterion: CriterionVersion;
}): GovernedBlindTaskView {
  const task = verifyGovernedReviewTask(input.task);
  const item = verifyGovernedReviewItem(input.item);
  const instruction = verifyGovernedReviewInstructionVersion(input.instruction);
  assertSame(task.projectId, item.projectId, "blind view task item project");
  assertSame(task.reviewItemId, item.reviewItemId, "blind view task item");
  assertSame(task.projectId, instruction.projectId, "blind view task instruction project");
  assertSame(task.criterionVersionId, instruction.criterionVersionId, "blind view criterion instruction version");
  assertSame(task.instructionVersionId, instruction.instructionVersionId, "blind view instruction version");
  assertSame(input.criterion.projectId, task.projectId, "blind view criterion project");
  assertSame(input.criterion.id, task.criterionVersionId, "blind view criterion version");
  assertSame(input.criterion.criterionId, instruction.criterionId, "blind view criterion identity");
  const expectedCriterionDigest = evaluatorSuiteCriterionDigest({
    criterionId: input.criterion.criterionId,
    criterionVersionId: input.criterion.id,
    criterionName: input.criterion.name,
    criterionDefinition: input.criterion.definition
  });
  if (input.criterion.criterionDigest !== expectedCriterionDigest) throw new Error("blind view criterion digest mismatch");
  assertNoForbiddenBlindKeys(item.payloadSnapshot);
  return GovernedBlindTaskViewSchema.parse({
    contract: "coeval/governed-blind-task-view/v1", schemaVersion: 1,
    canonicalizationVersion: "coeval-canonical-json/v1", taskId: task.taskId,
    batchId: task.batchId, servePosition: task.servePosition,
    criterion: {
      criterionId: input.criterion.criterionId, criterionVersionId: input.criterion.id,
      name: input.criterion.name, definition: input.criterion.definition,
      criterionDigest: input.criterion.criterionDigest
    },
    instruction: {
      instructionVersionId: instruction.instructionVersionId, title: instruction.title,
      instructions: instruction.instructions, failureCodeGuidance: instruction.failureCodeGuidance,
      allowedLabels: instruction.allowedLabels, instructionDigest: instruction.instructionDigest
    },
    payloadSnapshot: item.payloadSnapshot
  });
}

export function canonicalGovernedBlindTaskViewBytes(raw: unknown): Buffer {
  return Buffer.from(canonicalJson(verifyGovernedBlindTaskView(raw)), "utf8");
}

export function governedBlindTaskViewDigest(raw: unknown): string {
  return sha256Bytes(canonicalGovernedBlindTaskViewBytes(raw));
}

export function verifyGovernedBlindTaskView(raw: unknown): GovernedBlindTaskView {
  const view = GovernedBlindTaskViewSchema.parse(raw);
  assertCanonicalJsonSize(view.payloadSnapshot, "governed blind task payload snapshot", MAX_GOVERNED_REVIEW_PAYLOAD_BYTES);
  assertNoForbiddenBlindKeys(view.payloadSnapshot);
  return view;
}

export function importedHumanTruthDomainArtifactDigest(
  input: Omit<ImportedHumanTruth, "importDigest"> | ImportedHumanTruth
): string {
  const { importDigest: _excluded, ...unsigned } = input as ImportedHumanTruth;
  return governedContentV1Digest("coeval/imported-human-truth-domain-artifact/v1", unsigned);
}

export function classifyImportedHumanTruth(
  input: Omit<ImportedHumanTruth, "classification" | "importDigest">
): "imported_verified_attested" | "imported_self_attested" | "unverified" {
  const complete = input.issuer !== null && input.subject !== null && input.sourceSystem !== null &&
    input.sourceRecordId !== null && input.sourceDigest !== null && input.sourceArtifact !== null &&
    input.transportMethod !== null && input.verificationMethod !== null &&
    input.instructionText !== null && input.instructionDigest !== null && input.raters.length > 0 &&
    (input.label === "pass" || input.label === "fail") && input.rationale !== null &&
    input.adjudicatorSubjectId !== null && input.adjudicationDecision === input.label &&
    input.adjudicationRationale !== null &&
    input.blindAttestation !== null;
  if (!complete) return "unverified";
  // This pure verifier can prove completeness and byte/digest integrity, but
  // it has no trusted issuer-key registry or authenticated transport context.
  // Caller-provided proof-shaped JSON therefore remains self-attested. A
  // future server verifier may mint imported_verified_attested only after it
  // performs an independent cryptographic/transport verification.
  return "imported_self_attested";
}

export function verifyImportedHumanTruth(raw: unknown): ImportedHumanTruth {
  const imported = ImportedHumanTruthSchema.parse(raw);
  if (imported.sourceArtifact !== null) {
    assertCanonicalJsonSize(imported.sourceArtifact, "imported truth source artifact", MAX_IMPORTED_SOURCE_ARTIFACT_BYTES);
  }
  assertSortedUnique(imported.raters.map((rater) => rater.subjectId), "imported truth rater subject");
  assertSortedUnique(imported.failureCodes, "imported truth failure code");
  if (imported.sourceArtifact !== null && imported.sourceDigest !== sha256Digest(imported.sourceArtifact)) {
    throw new Error("imported truth source artifact digest mismatch");
  }
  if (imported.verificationEvidence !== null &&
    imported.verificationEvidenceDigest !== sha256Digest(imported.verificationEvidence)) {
    throw new Error("imported truth verification evidence digest mismatch");
  }
  if ((imported.verificationEvidence === null) !== (imported.verificationEvidenceDigest === null)) {
    throw new Error("imported truth verification evidence and digest must be supplied together");
  }
  if (imported.instructionText !== null && imported.instructionDigest !== sha256Digest(imported.instructionText)) {
    throw new Error("imported truth instruction digest mismatch");
  }
  if (imported.blindAttestation !== null) {
    const { attestationDigest, ...unsignedAttestation } = imported.blindAttestation;
    if (attestationDigest !== sha256Digest(unsignedAttestation)) throw new Error("imported truth blind attestation digest mismatch");
  }
  const { classification: _classification, importDigest: _importDigest, ...classifiable } = imported;
  if (imported.classification !== classifyImportedHumanTruth(classifiable)) {
    throw new Error("imported truth classification is inconsistent with its provenance");
  }
  if (imported.importDigest !== importedHumanTruthDomainArtifactDigest(imported)) {
    throw new Error("imported truth domain-artifact digest mismatch");
  }
  return imported;
}

export function governedDatasetReferenceProvenanceDomainArtifactDigest(
  input: Omit<GovernedDatasetReferenceProvenance, "provenanceDigest"> | GovernedDatasetReferenceProvenance
): string {
  const { provenanceDigest: _excluded, ...unsigned } = input as GovernedDatasetReferenceProvenance;
  return governedContentV1Digest("coeval/governed-dataset-reference-provenance-domain-artifact/v1", unsigned);
}

export function verifyGovernedDatasetReferenceProvenance(raw: unknown): GovernedDatasetReferenceProvenance {
  const provenance = GovernedDatasetReferenceProvenanceSchema.parse(raw);
  if (provenance.kind === "governed_labels") assertSortedUnique(provenance.labelIds, "governed reference label");
  if (provenance.provenanceDigest !== governedDatasetReferenceProvenanceDomainArtifactDigest(provenance)) {
    throw new Error("governed dataset reference provenance domain-artifact digest mismatch");
  }
  return provenance;
}

export interface GovernedBinaryAgreement {
  support: number;
  observedAgreement: number | null;
  kappa: number | null;
  undefinedReason: "no_overlap" | "one_class" | null;
}

export function computeGovernedBinaryAgreement(
  pairs: ReadonlyArray<{ reviewerA: "pass" | "fail"; reviewerB: "pass" | "fail" }>
): GovernedBinaryAgreement {
  if (pairs.length === 0) return { support: 0, observedAgreement: null, kappa: null, undefinedReason: "no_overlap" };
  const observedAgreement = pairs.filter((pair) => pair.reviewerA === pair.reviewerB).length / pairs.length;
  const categories = new Set(pairs.flatMap((pair) => [pair.reviewerA, pair.reviewerB]));
  if (categories.size === 1) return { support: pairs.length, observedAgreement, kappa: null, undefinedReason: "one_class" };
  const pAPass = pairs.filter((pair) => pair.reviewerA === "pass").length / pairs.length;
  const pBPass = pairs.filter((pair) => pair.reviewerB === "pass").length / pairs.length;
  const expectedAgreement = pAPass * pBPass + (1 - pAPass) * (1 - pBPass);
  const kappa = expectedAgreement === 1 ? null : (observedAgreement - expectedAgreement) / (1 - expectedAgreement);
  return { support: pairs.length, observedAgreement, kappa, undefinedReason: kappa === null ? "one_class" : null };
}

function assertNoForbiddenBlindKeys(value: unknown, path = "payloadSnapshot"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenBlindKeys(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (NORMALIZED_FORBIDDEN_BLIND_KEYS.has(normalizeBlindKey(key))) {
      throw new Error(`governed blind task payload contains forbidden field ${path}.${key}`);
    }
    assertNoForbiddenBlindKeys(nested, `${path}.${key}`);
  }
}

function normalizeBlindKey(key: string): string {
  return key.replace(/[_-]/g, "").toLowerCase();
}
