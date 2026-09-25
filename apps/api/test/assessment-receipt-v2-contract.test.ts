import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  AssessmentReceiptV2Schema,
  type AssessmentReceiptV2,
  type EvaluatorDefinition,
  type TypedQuestion
} from "@rubrist/shared";
import { canonicalJson, contentDigest, sha256Digest } from "../src/lib/assessment-receipt.js";
import {
  canonicalReceiptV2Bytes,
  datasetDigestForReceiptV2Items,
  evidenceDigestForReceiptV2,
  parseCanonicalReceiptV2Bytes,
  verifyAssessmentReceiptV2
} from "../src/lib/assessment-receipt-v2.js";
import { evaluatorDefinitionDigest, skillDigestV2FromInput, typedQuestionDigest } from "../src/lib/evaluator-identity.js";

interface ContractFixture {
  contract: "rubrist/assessment-receipt/v2";
  definition: EvaluatorDefinition;
  question?: TypedQuestion;
  candidates: Array<{ id: string; input: unknown; output: unknown }>;
  receipt: unknown;
}

type Mutation =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "reverse"; path: string }
  | { op: "recompute-dataset-digest" }
  | { op: "recompute-skill-digest" }
  | { op: "recompute-evidence-digest" };

interface ConformanceCase {
  name: string;
  baseFixture?: string;
  structural: "accept" | "reject";
  semantic: "accept" | "reject" | "not-run";
  expectedEvalRunId?: string;
  expectedSkillVersionId?: string;
  expectedSkillDigest?: string;
  errorIncludes?: string;
  mutations: Mutation[];
}

interface ConformanceCorpus {
  contract: "rubrist/assessment-receipt/v2";
  baseFixture: string;
  cases: ConformanceCase[];
}

const contractRoot = new URL("../../../contracts/", import.meta.url);
const pinnedFileDigests = {
  schema: "85f37e528fee65c505690ab40add6bc02312a30188472378fa80aed18e73d74b",
  specification: "8634be8a8ad67a0a20df4d891817cc98a33217f89fab74fc7bd91e2af96ca805",
  complete: "23b972a1ba9e78c5ea074ea9fb9abf7df74c108c8a58d14f473ee82d910e00eb",
  incomplete: "bdfb4378c78410274a78cf6f7545ed7440e10b67693161a0c211123e10f317b0",
  conformance: "69c7149c99bb2a2bb509b8347b88e56194e97e266ea640f9a62d4f7776d4f946"
} as const;

const fileBytes = (relativePath: string) => readFileSync(new URL(relativePath, contractRoot));
const loadJson = (relativePath: string): unknown => JSON.parse(fileBytes(relativePath).toString("utf8"));
const fileDigest = (relativePath: string) => createHash("sha256").update(fileBytes(relativePath)).digest("hex");
const fixture = (name: string) => loadJson(`fixtures/${name}`) as ContractFixture;
const corpus = () => loadJson("fixtures/assessment-receipt-v2.conformance.json") as ConformanceCorpus;
const byCodeUnit = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function pointerTarget(root: unknown, pointer: string): { parent: unknown; key: string } {
  const segments = pointer.split("/").slice(1).map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (segments.length === 0) throw new Error("fixture mutations cannot target the document root");
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = Array.isArray(parent) ? parent[Number(segment)] : (parent as Record<string, unknown>)[segment];
  }
  return { parent, key: segments.at(-1)! };
}

function applyMutation(receipt: Record<string, unknown>, mutation: Mutation): void {
  if (mutation.op === "recompute-dataset-digest") {
    receipt.datasetDigest = datasetDigestForReceiptV2Items(receipt.items as Array<{ clientItemId: string; contentDigest: string }>);
    return;
  }
  if (mutation.op === "recompute-skill-digest") {
    receipt.skillDigest = sha256Digest(receipt.evaluator);
    return;
  }
  if (mutation.op === "recompute-evidence-digest") {
    const { evidenceDigest: _excluded, ...unsigned } = receipt;
    receipt.evidenceDigest = sha256Digest(unsigned);
    return;
  }
  const { parent, key } = pointerTarget(receipt, mutation.path);
  if (mutation.op === "reverse") {
    const value = Array.isArray(parent) ? parent[Number(key)] : (parent as Record<string, unknown>)[key];
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

function materialize(testCase: ConformanceCase, conformance: ConformanceCorpus): { vector: ContractFixture; raw: unknown } {
  const vector = fixture(testCase.baseFixture ?? conformance.baseFixture);
  const receipt = structuredClone(vector.receipt) as Record<string, unknown>;
  for (const mutation of testCase.mutations) applyMutation(receipt, mutation);
  return { vector, raw: receipt };
}

/** What a consumer holding the submitted candidates checks on top of the receipt's own rules. */
function verifyCandidateLinkage(receipt: AssessmentReceiptV2, vector: ContractFixture): void {
  const ids = receipt.items.map((item) => item.clientItemId);
  const candidates = new Map(vector.candidates.map((candidate) => [candidate.id, candidate]));
  const expectedIds = [...candidates.keys()].sort(byCodeUnit);
  if (ids.length !== expectedIds.length || ids.some((id, index) => id !== expectedIds[index])) {
    throw new Error("receipt does not have exact clientItemId coverage");
  }
  for (const item of receipt.items) {
    const candidate = candidates.get(item.clientItemId)!;
    if (item.contentDigest !== contentDigest(candidate.input, candidate.output)) {
      throw new Error(`contentDigest mismatch for ${item.clientItemId}`);
    }
  }
}

describe("assessment receipt v2 contract (ADR-0014 section 7)", () => {
  it("pins the canonical schema, specification, and portable vectors", () => {
    expect(fileDigest("assessment-receipt-v2.schema.json")).toBe(pinnedFileDigests.schema);
    expect(fileDigest("assessment-receipt-v2.md")).toBe(pinnedFileDigests.specification);
    expect(fileDigest("fixtures/assessment-receipt-v2.complete.json")).toBe(pinnedFileDigests.complete);
    expect(fileDigest("fixtures/assessment-receipt-v2.incomplete.json")).toBe(pinnedFileDigests.incomplete);
    expect(fileDigest("fixtures/assessment-receipt-v2.conformance.json")).toBe(pinnedFileDigests.conformance);
  });

  it("keeps the canonical schema closed and versioned", () => {
    const schema = loadJson("assessment-receipt-v2.schema.json") as {
      $id?: string;
      additionalProperties?: boolean;
      properties?: { contract?: { const?: string }; schemaVersion?: { const?: number } };
    };
    expect(schema.$id).toBe("https://rubrist.dev/contracts/assessment-receipt-v2.schema.json");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.contract?.const).toBe("rubrist/assessment-receipt/v2");
    expect(schema.properties?.schemaVersion?.const).toBe(2);
  });

  it("accepts both positive vectors and recomputes every digest from the definition down", () => {
    for (const name of ["assessment-receipt-v2.complete.json", "assessment-receipt-v2.incomplete.json"]) {
      const vector = fixture(name);
      const receipt = AssessmentReceiptV2Schema.parse(vector.receipt);
      verifyAssessmentReceiptV2(receipt);
      verifyCandidateLinkage(receipt, vector);
      expect(evaluatorDefinitionDigest(vector.definition)).toBe(receipt.evaluator.definitionDigest);
      expect(skillDigestV2FromInput(receipt.evaluator)).toBe(receipt.skillDigest);
      expect(receipt.evidenceDigest).toBe(evidenceDigestForReceiptV2(receipt));
      if (vector.definition.kind === "typed-question") {
        expect(typedQuestionDigest(vector.question!)).toBe(vector.definition.question.digest);
      }
    }
  });

  it("carries no rubric, prompt, or question text", () => {
    const complete = fixture("assessment-receipt-v2.complete.json");
    const incomplete = fixture("assessment-receipt-v2.incomplete.json");
    const completeText = JSON.stringify(complete.receipt);
    const incompleteText = JSON.stringify(incomplete.receipt);
    if (complete.definition.kind !== "prompted") throw new Error("the complete vector is a prompted evaluator");
    expect(completeText).not.toContain(complete.definition.rubricMarkdown);
    expect(completeText).not.toContain(complete.definition.prompt);
    expect(incompleteText).not.toContain(incomplete.question!.instructions);
    expect(incompleteText).not.toContain(incomplete.question!.criteria.true);
  });

  it("treats an abstention as an outcome: complete, with lower coverage", () => {
    const receipt = AssessmentReceiptV2Schema.parse(fixture("assessment-receipt-v2.complete.json").receipt);
    expect(receipt.status).toBe("complete");
    expect(receipt.run.abstainedItems).toBe(1);
    expect((receipt.run.passItems + receipt.run.failItems) / receipt.run.totalItems).toBeLessThan(1);
  });

  it("round-trips exact canonical bytes and refuses any other copy", () => {
    const receipt = AssessmentReceiptV2Schema.parse(fixture("assessment-receipt-v2.incomplete.json").receipt);
    const bytes = canonicalReceiptV2Bytes(receipt);
    expect(bytes.toString("utf8")).toBe(canonicalJson(receipt));
    expect(parseCanonicalReceiptV2Bytes(bytes)).toEqual(receipt);
    expect(() => parseCanonicalReceiptV2Bytes(Buffer.from(JSON.stringify(receipt, null, 2)))).toThrow("not exact canonical JSON");
    expect(() => parseCanonicalReceiptV2Bytes(bytes, { skillDigest: `sha256:${"0".repeat(64)}` })).toThrow("expected evaluator");
  });

  it("keeps JSON Schema and producer Zod acceptance aligned over the portable corpus", () => {
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(loadJson("assessment-receipt-v2.schema.json") as object);
    const conformance = corpus();
    for (const testCase of conformance.cases) {
      const { raw } = materialize(testCase, conformance);
      const expected = testCase.structural === "accept";
      expect(validate(raw), `JSON Schema: ${testCase.name}`).toBe(expected);
      expect(AssessmentReceiptV2Schema.safeParse(raw).success, `Zod: ${testCase.name}`).toBe(expected);
    }
  });

  it("accepts or rejects every portable semantic case for the stated reason", () => {
    const conformance = corpus();
    for (const testCase of conformance.cases.filter((entry) => entry.semantic !== "not-run")) {
      const { vector, raw } = materialize(testCase, conformance);
      const receipt = AssessmentReceiptV2Schema.parse(raw);
      const verify = () => {
        verifyAssessmentReceiptV2(receipt, {
          evalRunId: testCase.expectedEvalRunId,
          skillVersionId: testCase.expectedSkillVersionId,
          skillDigest: testCase.expectedSkillDigest
        });
        verifyCandidateLinkage(receipt, vector);
      };
      if (testCase.semantic === "accept") expect(verify, testCase.name).not.toThrow();
      else expect(verify, testCase.name).toThrow(testCase.errorIncludes);
    }
  });
});
