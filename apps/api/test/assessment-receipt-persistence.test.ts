import { describe, expect, it } from "vitest";
import { AssessmentReceiptSchema, type AssessmentReceipt } from "@coeval/shared";
import { createApp } from "../src/app.js";
import {
  canonicalJson,
  contentDigest,
  evidenceDigestForReceipt,
  parseCanonicalReceiptBytes,
  receiptArtifactDigest
} from "../src/lib/assessment-receipt.js";
import {
  AssessmentReceiptIntegrityError,
  AssessmentReceiptUnavailableError,
  DemoRepository
} from "../src/repository.js";

const PROJECT = "proj_langsmith_support";
const VERSION = "skillv_1_2_0";

async function terminalRun(repo: DemoRepository) {
  return repo.createEvalRun({
    projectId: PROJECT,
    skillVersionId: VERSION,
    trigger: "release_evidence",
    items: [{
      caseId: "case_persisted",
      clientItemId: "release-item",
      contentDigest: contentDigest({ question: "Persist?" }, { answer: "Yes." }),
      status: "completed",
      verdictId: "verdict_persisted",
      resultLabel: "pass",
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

function correctedReceipt(root: AssessmentReceipt): AssessmentReceipt {
  const unsigned = {
    ...structuredClone(root),
    receiptId: `${root.receiptId}_correction_2`,
    items: root.items.map((item) => ({ ...item, judgedLabel: "fail" as const }))
  };
  const { evidenceDigest: _old, ...withoutDigest } = unsigned;
  return AssessmentReceiptSchema.parse({
    ...withoutDigest,
    evidenceDigest: evidenceDigestForReceipt(withoutDigest as AssessmentReceipt)
  });
}

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
      projectId: PROJECT,
      evalRunId: created.id,
      evalRunItemId: created.items[0]!.id,
      error: "provider failed"
    });
    const [artifact] = await repo.listAssessmentReceiptArtifacts(PROJECT, created.id);
    const receipt = AssessmentReceiptSchema.parse(JSON.parse(artifact!.canonicalBytes.toString("utf8")));
    expect(receipt.status).toBe("incomplete");
    expect(receipt.items[0]).toMatchObject({ status: "failed", error: "provider failed" });
  });

  it("keeps ambiguous judgments incomplete and rejects a forged complete claim", async () => {
    const repo = new DemoRepository();
    const run = await repo.createEvalRun({
      projectId: PROJECT,
      skillVersionId: VERSION,
      trigger: "release_evidence",
      items: [{
        caseId: "case_ambiguous_receipt",
        clientItemId: "ambiguous-item",
        contentDigest: contentDigest("ambiguous", "answer"),
        status: "completed",
        verdictId: "verdict_ambiguous",
        resultLabel: "ambiguous",
        cached: true
      }]
    });
    const artifact = await repo.getOrFreezeAssessmentReceipt(PROJECT, run.id);
    const receipt = AssessmentReceiptSchema.parse(JSON.parse(artifact!.canonicalBytes.toString("utf8")));
    expect(receipt.status).toBe("incomplete");

    const forgedUnsigned = { ...structuredClone(receipt), status: "complete" as const };
    const { evidenceDigest: _old, ...forgedWithoutDigest } = forgedUnsigned;
    const forged = AssessmentReceiptSchema.parse({
      ...forgedWithoutDigest,
      evidenceDigest: evidenceDigestForReceipt(forgedWithoutDigest as AssessmentReceipt)
    });
    expect(() => parseCanonicalReceiptBytes(Buffer.from(canonicalJson(forged), "utf8")))
      .toThrow(/claims complete/);
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
    const rootReceipt = AssessmentReceiptSchema.parse(JSON.parse(root!.canonicalBytes.toString("utf8")));
    const correctionReceipt = correctedReceipt(rootReceipt);

    const correction = await repo.createAssessmentReceiptCorrection({
      projectId: PROJECT,
      evalRunId: run.id,
      receipt: correctionReceipt,
      reason: "The original provider label was mapped incorrectly.",
      createdByUserId: "user_reviewer"
    });
    expect(correction).toMatchObject({
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

    const rootReceipt = AssessmentReceiptSchema.parse(JSON.parse(root!.canonicalBytes.toString("utf8")));
    const divergentUnsigned = {
      ...structuredClone(rootReceipt),
      items: rootReceipt.items.map((item) => ({ ...item, judgedLabel: "fail" as const }))
    };
    const { evidenceDigest: _old, ...divergentWithoutDigest } = divergentUnsigned;
    const divergentReceipt = AssessmentReceiptSchema.parse({
      ...divergentWithoutDigest,
      evidenceDigest: evidenceDigestForReceipt(divergentWithoutDigest as AssessmentReceipt)
    });
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
    const rootReceipt = AssessmentReceiptSchema.parse(JSON.parse(root!.canonicalBytes.toString("utf8")));
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
