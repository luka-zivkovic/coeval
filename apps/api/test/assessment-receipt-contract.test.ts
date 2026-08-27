import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  AssessmentReceiptSchema,
  type AssessmentReceipt
} from "@coeval/shared";
import {
  contentDigest,
  evidenceDigestForReceipt,
  sha256Digest
} from "../src/lib/assessment-receipt.js";

interface ContractFixture {
  contract: "coeval/assessment-receipt/v1";
  candidates: Array<{ id: string; input: unknown; output: unknown }>;
  receipt: unknown;
}

type Mutation =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "reverse"; path: string }
  | { op: "recompute-dataset-digest" }
  | { op: "recompute-evidence-digest" };

interface ConformanceCase {
  name: string;
  structural: "accept" | "reject";
  semantic: "accept" | "reject" | "not-run";
  expectedEvalRunId?: string;
  expectedSkillVersionId?: string;
  errorIncludes?: string;
  mutations: Mutation[];
}

interface ConformanceCorpus {
  contract: "coeval/assessment-receipt/v1";
  baseFixture: string;
  cases: ConformanceCase[];
}

const contractRoot = new URL("../../../contracts/", import.meta.url);
const pinnedFileDigests = {
  schema: "ca18a7b3bfa4610ff56ab88d60044f4357df2d035ac5e072356becc20250e9e7",
  specification: "85c4a502709a4a6a8c27b96634262fa2b583bbafce98558c99de475528df8802",
  fixture: "530e7322feb5bc16d025daaef14bec8d73488a168a602d82b37fae2a06d12274",
  conformance: "9a9ba86d54e78a6cc8d63d592712791f21984e68f09bbbe011d8903296af3e07"
} as const;

function fileBytes(relativePath: string): Buffer {
  return readFileSync(new URL(relativePath, contractRoot));
}

function loadJson(relativePath: string): unknown {
  return JSON.parse(fileBytes(relativePath).toString("utf8"));
}

function fileDigest(relativePath: string): string {
  return createHash("sha256").update(fileBytes(relativePath)).digest("hex");
}

function fixture(relativePath = "fixtures/assessment-receipt-v1.complete.json"): ContractFixture {
  return loadJson(relativePath) as ContractFixture;
}

function corpus(): ConformanceCorpus {
  return loadJson("fixtures/assessment-receipt-v1.conformance.json") as ConformanceCorpus;
}

function pointerTarget(root: unknown, pointer: string): { parent: unknown; key: string } {
  const segments = pointer.split("/").slice(1).map((segment) =>
    segment.replace(/~1/g, "/").replace(/~0/g, "~")
  );
  if (segments.length === 0) throw new Error("fixture mutations cannot target the document root");
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(parent)) parent = parent[Number(segment)];
    else parent = (parent as Record<string, unknown>)[segment];
  }
  return { parent, key: segments.at(-1)! };
}

function applyMutation(receipt: Record<string, unknown>, mutation: Mutation): void {
  if (mutation.op === "recompute-dataset-digest") {
    const items = receipt.items as Array<{ clientItemId: string; contentDigest: string }>;
    receipt.datasetDigest = sha256Digest(
      items.map(({ clientItemId, contentDigest: digest }) => ({ clientItemId, contentDigest: digest }))
    );
    return;
  }
  if (mutation.op === "recompute-evidence-digest") {
    const { evidenceDigest: _excluded, ...unsigned } = receipt;
    receipt.evidenceDigest = sha256Digest(unsigned);
    return;
  }
  const { parent, key } = pointerTarget(receipt, mutation.path);
  if (mutation.op === "reverse") {
    const value = Array.isArray(parent)
      ? parent[Number(key)]
      : (parent as Record<string, unknown>)[key];
    if (!Array.isArray(value)) throw new Error(`${mutation.path} is not an array`);
    value.reverse();
    return;
  }
  if (mutation.op === "remove") {
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete (parent as Record<string, unknown>)[key];
    return;
  }
  if (Array.isArray(parent)) parent[Number(key)] = mutation.value;
  else (parent as Record<string, unknown>)[key] = mutation.value;
}

function materialize(vector: ContractFixture, testCase: ConformanceCase): unknown {
  const receipt = structuredClone(vector.receipt) as Record<string, unknown>;
  for (const mutation of testCase.mutations) applyMutation(receipt, mutation);
  return receipt;
}

function verifyProducerSemantics(
  raw: unknown,
  receipt: AssessmentReceipt,
  vector: ContractFixture,
  testCase: ConformanceCase
): void {
  const expectedEvalRunId = testCase.expectedEvalRunId ?? receipt.evalRunId;
  const expectedSkillVersionId = testCase.expectedSkillVersionId ?? receipt.skillVersionId;
  if (receipt.evalRunId !== expectedEvalRunId) {
    throw new Error(`receipt evalRunId mismatch: expected ${expectedEvalRunId}`);
  }
  if (receipt.skillVersionId !== expectedSkillVersionId) {
    throw new Error(`receipt skillVersionId mismatch: expected ${expectedSkillVersionId}`);
  }

  const receiptIds = receipt.items.map((item) => item.clientItemId);
  if (new Set(receiptIds).size !== receiptIds.length) {
    throw new Error("receipt clientItemId values must be unique");
  }
  const sortedReceiptIds = [...receiptIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (receiptIds.some((id, index) => id !== sortedReceiptIds[index])) {
    throw new Error("receipt items are not ordered by clientItemId");
  }
  const candidatesById = new Map(vector.candidates.map((candidate) => [candidate.id, candidate]));
  const expectedIds = [...candidatesById.keys()].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (
    receiptIds.length !== expectedIds.length ||
    receiptIds.some((id, index) => id !== expectedIds[index])
  ) {
    throw new Error("receipt does not have exact clientItemId coverage");
  }
  for (const item of receipt.items) {
    const candidate = candidatesById.get(item.clientItemId)!;
    if (item.contentDigest !== contentDigest(candidate.input, candidate.output)) {
      throw new Error(`contentDigest mismatch for ${item.clientItemId}`);
    }
  }
  const expectedDatasetDigest = sha256Digest(
    receipt.items.map(({ clientItemId, contentDigest: digest }) => ({ clientItemId, contentDigest: digest }))
  );
  if (receipt.datasetDigest !== expectedDatasetDigest) {
    throw new Error("datasetDigest mismatch");
  }
  if (receipt.evidenceDigest !== evidenceDigestForReceipt(raw as AssessmentReceipt)) {
    throw new Error("evidenceDigest mismatch");
  }

  const completedItems = receipt.items.filter((item) => item.status === "completed").length;
  const failedItems = receipt.items.filter((item) => item.status === "failed").length;
  if (
    receipt.run.totalItems !== vector.candidates.length ||
    receipt.run.completedItems !== completedItems ||
    receipt.run.failedItems !== failedItems ||
    receipt.run.agreedItems > receipt.run.completedItems
  ) {
    throw new Error("receipt run counters are inconsistent with its items");
  }
  const itemsComplete = receipt.items.every((item) =>
    item.status === "completed" &&
    (item.judgedLabel === "pass" || item.judgedLabel === "fail") &&
    item.verdictId !== null &&
    item.error === null
  );
  const computedComplete = receipt.run.status === "completed" &&
    receipt.run.completedItems === vector.candidates.length &&
    receipt.run.failedItems === 0 &&
    itemsComplete;
  if (receipt.status === "complete" && !computedComplete) {
    throw new Error("receipt claims complete with incomplete run or item evidence");
  }
  if (receipt.status === "incomplete" && computedComplete) {
    throw new Error("receipt claims incomplete despite complete run and item evidence");
  }
}

describe("assessment receipt v1 contract", () => {
  it("pins the canonical schema and portable corpus bytes", () => {
    expect(fileDigest("assessment-receipt-v1.schema.json")).toBe(pinnedFileDigests.schema);
    expect(fileDigest("assessment-receipt-v1.md")).toBe(pinnedFileDigests.specification);
    expect(fileDigest("fixtures/assessment-receipt-v1.complete.json")).toBe(pinnedFileDigests.fixture);
    expect(fileDigest("fixtures/assessment-receipt-v1.conformance.json")).toBe(pinnedFileDigests.conformance);
  });

  it("keeps the canonical schema closed and versioned", () => {
    const schema = loadJson("assessment-receipt-v1.schema.json") as {
      $id?: string;
      additionalProperties?: boolean;
      properties?: { schemaVersion?: { const?: number } };
    };
    expect(schema.$id).toBe("https://coeval.dev/contracts/assessment-receipt-v1.schema.json");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.schemaVersion?.const).toBe(1);
  });

  it("accepts the positive fixture and independently recomputes every digest linkage", () => {
    const vector = fixture();
    expect(vector.contract).toBe("coeval/assessment-receipt/v1");
    const receipt = AssessmentReceiptSchema.parse(vector.receipt);
    verifyProducerSemantics(vector.receipt, receipt, vector, {
      name: "positive-control",
      structural: "accept",
      semantic: "accept",
      mutations: []
    });
  });

  it("keeps JSON Schema and producer Zod acceptance aligned over the portable corpus", () => {
    const schema = loadJson("assessment-receipt-v1.schema.json");
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema as object);
    const conformance = corpus();
    const vector = fixture(`fixtures/${conformance.baseFixture}`);

    for (const testCase of conformance.cases) {
      const raw = materialize(vector, testCase);
      const expected = testCase.structural === "accept";
      expect(validate(raw), `JSON Schema: ${testCase.name}`).toBe(expected);
      expect(AssessmentReceiptSchema.safeParse(raw).success, `Zod: ${testCase.name}`).toBe(expected);
    }
  });

  it("accepts or rejects every portable semantic case for the stated reason", () => {
    const conformance = corpus();
    const vector = fixture(`fixtures/${conformance.baseFixture}`);
    for (const testCase of conformance.cases.filter((entry) => entry.semantic !== "not-run")) {
      const raw = materialize(vector, testCase);
      const receipt = AssessmentReceiptSchema.parse(raw);
      const verify = () => verifyProducerSemantics(raw, receipt, vector, testCase);
      if (testCase.semantic === "accept") expect(verify, testCase.name).not.toThrow();
      else expect(verify, testCase.name).toThrow(testCase.errorIncludes);
    }
  });
});
