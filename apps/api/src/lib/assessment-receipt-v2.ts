import {
  AssessmentReceiptV2Schema,
  type AssessmentReceiptV2,
  type AssessmentReceiptV2Item
} from "@rubrist/shared";
import { canonicalJson, sha256Digest } from "./assessment-receipt.js";
import { skillDigestV2FromInput } from "./evaluator-identity.js";

// Assessment receipt v2 (Rubrist ADR-0014 section 7;
// contracts/assessment-receipt-v2.md). The schema is structural; everything
// below is a semantic rule a structurally valid receipt must also satisfy
// before anyone trusts it.

const byCodeUnit = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

/** SHA-256 over the receipt with only `evidenceDigest` omitted. */
export function evidenceDigestForReceiptV2(receipt: Omit<AssessmentReceiptV2, "evidenceDigest"> | AssessmentReceiptV2): string {
  const { evidenceDigest: _excluded, ...unsigned } = receipt as AssessmentReceiptV2;
  return sha256Digest(unsigned);
}

/** SHA-256 over the ordered `{clientItemId, contentDigest}` pairs. */
export function datasetDigestForReceiptV2Items(items: ReadonlyArray<Pick<AssessmentReceiptV2Item, "clientItemId" | "contentDigest">>): string {
  return sha256Digest(items.map(({ clientItemId, contentDigest }) => ({ clientItemId, contentDigest })));
}

/** Identities a consumer already holds, such as the suite manifest member's skillDigest. */
export interface ReceiptV2Expectations {
  evalRunId?: string | undefined;
  skillVersionId?: string | undefined;
  skillDigest?: string | undefined;
}

function verifyItem(item: AssessmentReceiptV2Item, receipt: AssessmentReceiptV2): void {
  const where = `item ${item.clientItemId}`;
  const hasOutcome = item.result.state === "outcome";
  if (hasOutcome !== (item.verdictId !== null)) {
    throw new Error(`Assessment receipt ${where}: verdictId must be present exactly for items with an outcome`);
  }
  if (!hasOutcome && item.evaluatorScore !== null) {
    throw new Error(`Assessment receipt ${where}: evaluatorScore is only recorded with an outcome`);
  }
  const protocol = receipt.evaluator.executionBinding.verdictProtocol;
  const expectedKind = protocol === "typed-question/v1" ? "native_probability" : "self_reported_score";
  if (item.evaluatorScore !== null && item.evaluatorScore.kind !== expectedKind) {
    throw new Error(`Assessment receipt ${where}: evaluatorScore kind does not match the verdict protocol`);
  }
  if (protocol === "typed-question/v1" && item.result.state === "outcome" &&
      (item.result.outcome === "abstain" || item.evaluatorScore === null)) {
    throw new Error(`Assessment receipt ${where}: typed-question outcomes are pass or fail with a native probability`);
  }
  if ((item.result.state === "not_attempted") !== (item.observed === null)) {
    throw new Error(`Assessment receipt ${where}: observed provenance must be present exactly for attempted items`);
  }
  if (item.observed?.upstreamProvider != null && receipt.evaluator.executionBinding.provider !== "openrouter") {
    throw new Error(`Assessment receipt ${where}: upstreamProvider is recorded only for OpenRouter bindings`);
  }
}

/**
 * Check every semantic rule of receipt v2 that the receipt alone can prove.
 * Candidate linkage (each contentDigest against the submitted input and
 * output, and exact coverage of the submitted ids) needs the candidates, so
 * consumers that hold them check it too.
 */
export function verifyAssessmentReceiptV2(receipt: AssessmentReceiptV2, expected: ReceiptV2Expectations = {}): void {
  if (receipt.evidenceDigest !== evidenceDigestForReceiptV2(receipt)) {
    throw new Error("Assessment receipt evidenceDigest mismatch");
  }
  if (receipt.skillDigest !== skillDigestV2FromInput(receipt.evaluator)) {
    throw new Error("Assessment receipt skillDigest mismatch");
  }
  const ids = receipt.items.map((item) => item.clientItemId);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Assessment receipt clientItemId values must be unique");
  }
  const sorted = [...ids].sort(byCodeUnit);
  if (ids.some((id, index) => id !== sorted[index])) {
    throw new Error("Assessment receipt items are not ordered by clientItemId");
  }
  if (receipt.datasetDigest !== datasetDigestForReceiptV2Items(receipt.items)) {
    throw new Error("Assessment receipt datasetDigest mismatch");
  }
  for (const item of receipt.items) verifyItem(item, receipt);

  const outcomes = (outcome: "pass" | "fail" | "abstain") =>
    receipt.items.filter((item) => item.result.state === "outcome" && item.result.outcome === outcome).length;
  const run = receipt.run;
  if (
    run.totalItems !== receipt.items.length ||
    run.passItems !== outcomes("pass") ||
    run.failItems !== outcomes("fail") ||
    run.abstainedItems !== outcomes("abstain") ||
    run.failedItems !== receipt.items.filter((item) => item.result.state === "failure").length ||
    run.notAttemptedItems !== receipt.items.filter((item) => item.result.state === "not_attempted").length ||
    run.agreedItems > run.passItems + run.failItems
  ) {
    throw new Error("Assessment receipt run counters are inconsistent with its items");
  }

  // ADR-0014 section 6: complete means every item was attempted and has an
  // outcome. An abstention is an outcome; it lowers coverage, not completeness.
  const computedComplete = run.status === "completed" && receipt.items.every((item) => item.result.state === "outcome");
  if (receipt.status === "complete" && !computedComplete) {
    throw new Error("Assessment receipt claims complete with incomplete run or item evidence");
  }
  if (receipt.status === "incomplete" && computedComplete) {
    throw new Error("Assessment receipt claims incomplete despite complete run and item evidence");
  }

  if (expected.evalRunId !== undefined && receipt.evalRunId !== expected.evalRunId) {
    throw new Error(`Assessment receipt evalRunId mismatch: expected ${expected.evalRunId}`);
  }
  if (expected.skillVersionId !== undefined && receipt.skillVersionId !== expected.skillVersionId) {
    throw new Error(`Assessment receipt skillVersionId mismatch: expected ${expected.skillVersionId}`);
  }
  if (expected.skillDigest !== undefined && receipt.skillDigest !== expected.skillDigest) {
    throw new Error(`Assessment receipt skillDigest does not match the expected evaluator: expected ${expected.skillDigest}`);
  }
}

export function canonicalReceiptV2Bytes(receipt: AssessmentReceiptV2): Buffer {
  return Buffer.from(canonicalJson(AssessmentReceiptV2Schema.parse(receipt)), "utf8");
}

/** Parse an exact canonical receipt v2 copy and check every semantic rule. */
export function parseCanonicalReceiptV2Bytes(bytes: Uint8Array, expected: ReceiptV2Expectations = {}): AssessmentReceiptV2 {
  let text: string;
  try {
    // ignoreBOM keeps a leading byte-order mark, so such a copy fails the parse
    // instead of passing as the canonical bytes.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("Assessment receipt bytes are not valid UTF-8");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Assessment receipt bytes are not valid JSON");
  }
  const receipt = AssessmentReceiptV2Schema.parse(raw);
  if (canonicalJson(receipt) !== text) {
    throw new Error("Assessment receipt copy is not exact canonical JSON");
  }
  verifyAssessmentReceiptV2(receipt, expected);
  return receipt;
}
