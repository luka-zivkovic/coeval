import { createHash } from "node:crypto";
import {
  AssessmentReceiptSchema,
  type AssessmentReceipt,
  type EvalRunDetail,
  type ProviderResponseMetadata,
  type SkillVersion
} from "@coeval/shared";

const UNAVAILABLE_PROVIDER_METADATA: ProviderResponseMetadata = {
  model: null,
  requestId: null,
  responseId: null,
  systemFingerprint: null
};

// RFC-8785-like surface needed by the receipt contract: object keys sort
// lexicographically at every depth, arrays retain order, and JSON primitives
// use JSON.stringify's representation. Inputs are JSON values from API/schema
// boundaries; unsupported values fail instead of being silently coerced.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON cannot encode a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => entry === undefined ? "null" : canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`Canonical JSON cannot encode ${typeof value}`);
}

export function sha256Digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function contentDigest(input: unknown, output: unknown): string {
  return sha256Digest({ input, output });
}

export function skillDigest(version: SkillVersion): string {
  return sha256Digest({
    rubricMarkdown: version.rubricMarkdown,
    prompt: version.prompt,
    modelBinding: version.modelBinding,
    outputSchema: version.outputSchema,
    verdictKind: version.verdictKind,
    scalarRange: version.scalarRange,
    categoricalChoiceScores: version.categoricalChoiceScores
  });
}

export function evidenceDigestForReceipt(receipt: Omit<AssessmentReceipt, "evidenceDigest"> | AssessmentReceipt): string {
  const { evidenceDigest: _excluded, ...unsigned } = receipt as AssessmentReceipt;
  return sha256Digest(unsigned);
}

/** SHA-256 over the exact stored/served receipt bytes, including evidenceDigest. */
export function receiptArtifactDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function canonicalReceiptBytes(receipt: AssessmentReceipt): Buffer {
  return Buffer.from(canonicalJson(AssessmentReceiptSchema.parse(receipt)), "utf8");
}

/**
 * Parse an exact canonical receipt copy and re-check the semantic invariants
 * which JSON Schema cannot express. Candidate input/output linkage is checked
 * by consumers that possess those inputs; this verifier covers the closed
 * receipt itself.
 */
export function parseCanonicalReceiptBytes(bytes: Uint8Array): AssessmentReceipt {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Assessment receipt bytes are not valid UTF-8");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Assessment receipt bytes are not valid JSON");
  }
  const receipt = AssessmentReceiptSchema.parse(raw);
  if (canonicalJson(receipt) !== text) {
    throw new Error("Assessment receipt copy is not exact canonical JSON");
  }
  if (receipt.evidenceDigest !== evidenceDigestForReceipt(receipt)) {
    throw new Error("Assessment receipt evidenceDigest mismatch");
  }
  const ids = receipt.items.map((item) => item.clientItemId);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Assessment receipt clientItemId values must be unique");
  }
  const sorted = [...ids].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (ids.some((id, index) => id !== sorted[index])) {
    throw new Error("Assessment receipt items are not ordered by clientItemId");
  }
  const datasetDigest = sha256Digest(
    receipt.items.map(({ clientItemId, contentDigest }) => ({ clientItemId, contentDigest }))
  );
  if (receipt.datasetDigest !== datasetDigest) {
    throw new Error("Assessment receipt datasetDigest mismatch");
  }
  const completedItems = receipt.items.filter((item) => item.status === "completed").length;
  const failedItems = receipt.items.filter((item) => item.status === "failed").length;
  if (
    receipt.run.totalItems !== receipt.items.length ||
    receipt.run.completedItems !== completedItems ||
    receipt.run.failedItems !== failedItems ||
    receipt.run.agreedItems > receipt.run.completedItems
  ) {
    throw new Error("Assessment receipt run counters are inconsistent with its items");
  }
  const itemsComplete = receipt.items.every((item) =>
    item.status === "completed" &&
    (item.judgedLabel === "pass" || item.judgedLabel === "fail") &&
    item.verdictId !== null &&
    item.error === null
  );
  const computedComplete = receipt.run.status === "completed" &&
    receipt.run.completedItems === receipt.items.length &&
    receipt.run.failedItems === 0 &&
    itemsComplete;
  if (receipt.status === "complete" && !computedComplete) {
    throw new Error("Assessment receipt claims complete with incomplete run or item evidence");
  }
  if (receipt.status === "incomplete" && computedComplete) {
    throw new Error("Assessment receipt claims incomplete despite complete run and item evidence");
  }
  return receipt;
}

/** Digest the complete repository inputs observed while minting/freezing. */
export function receiptSourceSnapshotDigest(input: {
  run: EvalRunDetail;
  skillVersion: SkillVersion;
}): string {
  return sha256Digest({
    run: input.run,
    skillVersion: input.skillVersion
  });
}

export function buildAssessmentReceipt(input: {
  run: EvalRunDetail;
  skillVersion: SkillVersion;
}): AssessmentReceipt {
  if (input.run.trigger !== "release_evidence") {
    throw new Error("Assessment receipts are available only for release_evidence runs");
  }
  if (input.run.skillVersionId !== input.skillVersion.id) {
    throw new Error("Assessment receipt skill version does not match its eval run");
  }

  const items = input.run.items.map((item) => {
    if (!item.clientItemId || !item.contentDigest) {
      throw new Error(`Release evidence item ${item.id} is missing its receipt identity`);
    }
    return {
      clientItemId: item.clientItemId,
      caseId: item.caseId,
      status: item.status,
      judgedLabel: item.resultLabel,
      verdictId: item.verdictId,
      error: item.error,
      contentDigest: item.contentDigest,
      providerMetadata: item.providerMetadata ?? UNAVAILABLE_PROVIDER_METADATA
    };
  }).sort((left, right) => left.clientItemId < right.clientItemId ? -1 : left.clientItemId > right.clientItemId ? 1 : 0);

  const datasetDigest = sha256Digest(items.map(({ clientItemId, contentDigest }) => ({ clientItemId, contentDigest })));
  const complete = input.run.status === "completed" &&
    input.run.failedItems === 0 &&
    input.run.completedItems === input.run.totalItems &&
    items.length === input.run.totalItems &&
    items.every((item) =>
      item.status === "completed" &&
      (item.judgedLabel === "pass" || item.judgedLabel === "fail") &&
      item.verdictId !== null &&
      item.error === null
    );

  const unsigned = {
    schemaVersion: 1 as const,
    receiptId: `receipt_${input.run.id}`,
    evalRunId: input.run.id,
    projectId: input.run.projectId,
    skillId: input.skillVersion.skillId,
    skillVersionId: input.skillVersion.id,
    status: complete ? "complete" as const : "incomplete" as const,
    run: {
      status: input.run.status,
      totalItems: input.run.totalItems,
      completedItems: input.run.completedItems,
      failedItems: input.run.failedItems,
      agreedItems: input.run.agreedItems
    },
    requestedModelBinding: input.skillVersion.modelBinding,
    skillDigest: skillDigest(input.skillVersion),
    datasetDigest,
    items
  };
  return AssessmentReceiptSchema.parse({
    ...unsigned,
    evidenceDigest: sha256Digest(unsigned)
  });
}
