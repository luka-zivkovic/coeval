import { describe, expect, it } from "vitest";
import { AssessmentReceiptV2Schema, type AssessmentReceiptV2, type VerdictLabel } from "@rubrist/shared";
import { createApp } from "../src/app.js";
import { canonicalJson, contentDigest } from "../src/lib/canonical-json.js";
import { evidenceDigestForReceiptV2, parseCanonicalReceiptV2Bytes, receiptArtifactDigest } from "../src/lib/assessment-receipt-v2.js";
import {
  AssessmentReceiptIntegrityError,
  AssessmentReceiptUnavailableError,
  DemoRepository
} from "../src/repository.js";

const PROJECT = "proj_langsmith_support";
const VERSION = "skillv_1_2_0";

/** A fully cached release run, terminal at creation, over one recorded verdict. */
async function terminalRun(repo: DemoRepository, resultLabel: VerdictLabel = "pass") {
  const input = { question: "Persist?" };
  const output = { answer: "Yes." };
  const { caseId } = await repo.importTrace(PROJECT, "release_evidence", {
    sourceTraceId: `release_${resultLabel}`, input, output, metadata: {}
  }, { ingestionPurpose: "release_evidence" });
  const verdict = await repo.recordVerdict({
    projectId: PROJECT,
    caseId,
    source: "llm_judge",
    skillVersionId: VERSION,
    payload: { kind: "binary", pass: resultLabel === "pass", rationale: "recorded" },
    observed: { model: "claude-sonnet-4-6", requestId: "req_persisted", responseId: null, systemFingerprint: null, upstreamProvider: null, thinkingReturned: false, reasoningTokens: null },
    evaluatorScore: { value: 0.8, kind: "self_reported_score" }
  });
  return repo.createEvalRun({
    projectId: PROJECT,
    skillVersionId: VERSION,
    trigger: "release_evidence",
    items: [{
      caseId,
      clientItemId: "release-item",
      contentDigest: contentDigest(input, output),
      status: "completed",
      verdictId: verdict.id,
      resultLabel,
      cached: true
    }]
  });
}

async function mintKey(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request("/api/api-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "receipt-persistence-test" })
  });
  return (await response.json() as { key: string }).key;
}

/** The receipt changed and signed again, as a consumer or a correction would. */
function resigned(receipt: AssessmentReceiptV2, change: (draft: AssessmentReceiptV2) => void): AssessmentReceiptV2 {
  const draft = structuredClone(receipt);
  change(draft);
  const { evidenceDigest: _old, ...unsigned } = draft;
  return AssessmentReceiptV2Schema.parse({ ...unsigned, evidenceDigest: evidenceDigestForReceiptV2(unsigned) });
}

/** Its single pass outcome restated as a fail, with consistent counters. */
function failedInstead(draft: AssessmentReceiptV2): void {
  draft.items[0]!.result = { state: "outcome", outcome: "fail" };
  draft.run.passItems = 0;
  draft.run.failItems = 1;
}

function correctedReceipt(root: AssessmentReceiptV2): AssessmentReceiptV2 {
  return resigned(root, (draft) => {
    draft.receiptId = `${root.receiptId}_correction_2`;
    failedInstead(draft);
  });
}

const parsedArtifact = (bytes: Buffer) => AssessmentReceiptV2Schema.parse(JSON.parse(bytes.toString("utf8")));

describe("immutable assessment receipt artifacts", () => {
  it("mints a cached terminal run once and returns defensive exact-byte copies", async () => {
    const repo = new DemoRepository();
    const run = await terminalRun(repo);

    const first = await repo.getOrFreezeAssessmentReceipt(PROJECT, run.id);
    const second = await repo.getOrFreezeAssessmentReceipt(PROJECT, run.id);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).toMatchObject({
      sourceKind: "terminal_mint",
      artifactRevision: 1,
      predecessorArtifactId: null,
      correctionReason: null
    });
    expect(second?.id).toBe(first?.id);
    expect(second?.canonicalBytes.equals(first!.canonicalBytes)).toBe(true);
    expect(first?.artifactDigest).toBe(receiptArtifactDigest(first!.canonicalBytes));
    expect(await repo.listAssessmentReceiptArtifacts(PROJECT, run.id)).toHaveLength(1);

    first!.canonicalBytes.fill(0);
    const reread = await repo.getOrFreezeAssessmentReceipt(PROJECT, run.id);
    expect(reread?.canonicalBytes.equals(second!.canonicalBytes)).toBe(true);
  });

  it("mints incomplete evidence atomically when the final item fails", async () => {
    const repo = new DemoRepository();
    const created = await repo.createEvalRun({
      projectId: PROJECT,
      skillVersionId: VERSION,
      trigger: "release_evidence",
      items: [{
        caseId: "case_failed_receipt",
        clientItemId: "failed-item",
        contentDigest: contentDigest(null, null)
      }]
    });
    expect(await repo.listAssessmentReceiptArtifacts(PROJECT, created.id)).toEqual([]);

    await repo.failEvalRunItem({
      failure: { state: "failure", failureKind: "provider_timeout", observed: { model: null, requestId: null, responseId: null, systemFingerprint: null, upstreamProvider: null, thinkingReturned: null, reasoningTokens: null } },
      projectId: PROJECT,
      evalRunId: created.id,
      evalRunItemId: created.items[0]!.id,
      error: "provider failed"
    });
    const [artifact] = await repo.listAssessmentReceiptArtifacts(PROJECT, created.id);
    const receipt = parsedArtifact(artifact!.canonicalBytes);
    expect(receipt.status).toBe("incomplete");
    expect(receipt.items[0]).toMatchObject({ result: { state: "failure", failureKind: "provider_timeout" }, verdictId: null });
    expect(artifact).toMatchObject({ id: `rart_${created.id}_v2_r1`, contractVersion: 2 });
  });

  it("keeps an abstention complete, as an outcome, and rejects a forged incomplete claim", async () => {
    const repo = new DemoRepository();
    const run = await terminalRun(repo, "ambiguous");
    const artifact = await repo.getOrFreezeAssessmentReceipt(PROJECT, run.id);
    const receipt = parsedArtifact(artifact!.canonicalBytes);
    expect(receipt.status).toBe("complete");
    expect(receipt.run).toMatchObject({ passItems: 0, failItems: 0, abstainedItems: 1 });
    expect(receipt.items[0]!.result).toEqual({ state: "outcome", outcome: "abstain" });

    const forged = resigned(receipt, (draft) => { draft.status = "incomplete"; });
    expect(() => parseCanonicalReceiptV2Bytes(Buffer.from(canonicalJson(forged), "utf8")))
      .toThrow(/claims incomplete/);
  });

  it("rejects nonterminal and non-release runs without minting", async () => {
    const repo = new DemoRepository();
    const pending = await repo.createEvalRun({
      projectId: PROJECT,
      skillVersionId: VERSION,
      trigger: "release_evidence",
      items: [{
        caseId: "case_pending_receipt",
        clientItemId: "pending-item",
        contentDigest: contentDigest("pending", "pending")
      }]
    });
    await expect(repo.getOrFreezeAssessmentReceipt(PROJECT, pending.id)).rejects.toMatchObject({
      reason: "not_terminal"
    });
    expect(await repo.listAssessmentReceiptArtifacts(PROJECT, pending.id)).toEqual([]);

    const general = await repo.createEvalRun({
      projectId: PROJECT,
      skillVersionId: VERSION,
      trigger: "api_batch",
      items: [{ caseId: "case_general", status: "completed", verdictId: "v", resultLabel: "pass" }]
    });
    await expect(repo.getOrFreezeAssessmentReceipt(PROJECT, general.id)).rejects.toBeInstanceOf(
      AssessmentReceiptUnavailableError
    );
  });

  it("appends corrections with lineage while preserving the root bytes", async () => {
    const repo = new DemoRepository();
    const run = await terminalRun(repo);
    const root = await repo.getOrFreezeAssessmentReceipt(PROJECT, run.id);
    const rootReceipt = parsedArtifact(root!.canonicalBytes);
    const correctionReceipt = correctedReceipt(rootReceipt);

    const correction = await repo.createAssessmentReceiptCorrection({
      projectId: PROJECT,
      evalRunId: run.id,
      receipt: correctionReceipt,
      reason: "The original provider label was mapped incorrectly.",
      createdByUserId: "user_reviewer"
    });
    expect(correction).toMatchObject({
      id: `rart_${run.id}_v2_r2`,
      contractVersion: 2,
      artifactRevision: 2,
      predecessorArtifactId: root!.id,
      sourceKind: "correction",
      correctionReason: "The original provider label was mapped incorrectly."
    });
    expect((await repo.createAssessmentReceiptCorrection({
      projectId: PROJECT,
      evalRunId: run.id,
      receipt: correctionReceipt,
      reason: "Retry uses the stored correction.",
      createdByUserId: "user_reviewer"
    })).id).toBe(correction.id);

    const rootAgain = await repo.getOrFreezeAssessmentReceipt(PROJECT, run.id);
    expect(rootAgain?.canonicalBytes.equals(root!.canonicalBytes)).toBe(true);
    expect((await repo.getAssessmentReceiptArtifactByReceiptId(PROJECT, correctionReceipt.receiptId))?.id)
      .toBe(correction.id);
    expect((await repo.listAssessmentReceiptArtifacts(PROJECT, run.id)).map((item) => item.artifactRevision))
      .toEqual([1, 2]);

    await expect(repo.createAssessmentReceiptCorrection({
      projectId: PROJECT,
      evalRunId: run.id,
      receipt: rootReceipt,
      reason: "Cannot reuse the root receipt id."
    })).rejects.toBeInstanceOf(AssessmentReceiptIntegrityError);
  });

  it("records exact matching and divergent consumer copies without replacing the root", async () => {
    const repo = new DemoRepository();
    const run = await terminalRun(repo);
    const root = await repo.getOrFreezeAssessmentReceipt(PROJECT, run.id);

    const match = await repo.compareAssessmentReceiptCopy({
      projectId: PROJECT,
      evalRunId: run.id,
      consumerCanonicalBytes: root!.canonicalBytes
    });
    expect(match).toMatchObject({ artifactId: root!.id, comparisonStatus: "match" });

    const rootReceipt = parsedArtifact(root!.canonicalBytes);
    const divergentReceipt = resigned(rootReceipt, failedInstead);
    const divergentBytes = Buffer.from(canonicalJson(divergentReceipt), "utf8");
    const divergence = await repo.compareAssessmentReceiptCopy({
      projectId: PROJECT,
      evalRunId: run.id,
      consumerCanonicalBytes: divergentBytes
    });
    expect(divergence.comparisonStatus).toBe("diverged");
    expect(divergence.consumerArtifactDigest).toBe(receiptArtifactDigest(divergentBytes));
    expect((await repo.compareAssessmentReceiptCopy({
      projectId: PROJECT,
      evalRunId: run.id,
      consumerCanonicalBytes: divergentBytes
    })).id).toBe(divergence.id);
    expect((await repo.getOrFreezeAssessmentReceipt(PROJECT, run.id))?.canonicalBytes.equals(root!.canonicalBytes)).toBe(true);

    const invalid = Buffer.from(canonicalJson({ ...rootReceipt, evidenceDigest: `sha256:${"0".repeat(64)}` }), "utf8");
    await expect(repo.compareAssessmentReceiptCopy({
      projectId: PROJECT,
      evalRunId: run.id,
      consumerCanonicalBytes: invalid
    })).rejects.toBeInstanceOf(AssessmentReceiptIntegrityError);
  });
});
describe("persisted receipt routes", () => {
  it("serves exact root/successor bytes and records base64 consumer comparisons", async () => {
    const repo = new DemoRepository();
    const run = await terminalRun(repo);
    const root = await repo.getOrFreezeAssessmentReceipt(PROJECT, run.id);
    const rootReceipt = parsedArtifact(root!.canonicalBytes);
    const correctionReceipt = correctedReceipt(rootReceipt);
    await repo.createAssessmentReceiptCorrection({
      projectId: PROJECT,
      evalRunId: run.id,
      receipt: correctionReceipt,
      reason: "Route lookup coverage."
    });

    const app = createApp(repo);
    const key = await mintKey(app);
    const auth = { authorization: `Bearer ${key}` };
    const rootResponse = await app.request(`/api/v1/eval-runs/${run.id}/assessment-receipt`, { headers: auth });
    expect(rootResponse.status).toBe(200);
    expect(Buffer.from(await rootResponse.arrayBuffer()).equals(root!.canonicalBytes)).toBe(true);

    const successorResponse = await app.request(
      `/api/v1/assessment-receipts/${encodeURIComponent(correctionReceipt.receiptId)}`,
      { headers: auth }
    );
    expect(successorResponse.status).toBe(200);
    expect(await successorResponse.text()).toBe(canonicalJson(correctionReceipt));

    const compared = await app.request(`/api/v1/eval-runs/${run.id}/assessment-receipt/comparisons`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ consumerReceiptBase64: root!.canonicalBytes.toString("base64") })
    });
    expect(compared.status).toBe(201);
    expect(await compared.json()).toMatchObject({ comparisonStatus: "match", artifactId: root!.id });
  });
});
