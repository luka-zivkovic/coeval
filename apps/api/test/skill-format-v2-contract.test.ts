import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { SkillFormatV2Schema, type SkillFormatV2 } from "@rubrist/shared";
import { evaluatorDefinitionDigest, evaluatorOutputContractDigestV2, skillDigestV2, typedQuestionDigest } from "../src/lib/evaluator-identity.js";
import { verifySkillFormatV2 } from "../src/lib/skill-format-v2.js";
import { BINDINGS, DEFINITIONS, QUESTION } from "./fixtures/evaluator-v2-vectors.js";

type Mutation =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "recompute-digests" };

interface ConformanceCase {
  name: string;
  baseFixture?: string;
  structural: "accept" | "reject";
  semantic: "accept" | "reject" | "not-run";
  errorIncludes?: string;
  expectedSkillDigest?: string;
  mutations: Mutation[];
}

interface ConformanceCorpus {
  contract: "skill-format/v2";
  baseFixture: string;
  cases: ConformanceCase[];
}

const contractRoot = new URL("../../../contracts/", import.meta.url);
const pinnedFileDigests = {
  schema: "b2e0e8dfc26319b0504a4288b3db9a20e36661593229cd291c405a52a08f4f8f",
  specification: "67e33cfb6c63744dc835f5809b0cd6dc937713c7bfdf6f7c640a002fce382b54",
  prompted: "d61bb237767fee31a6fecbecfafcb6dfd85df774ce84c2effed59594814c61c0",
  typedQuestion: "d07a435e85217f413c1bcf3aff19bd04e0d5119a19deef90dbe151a0054ec293",
  conformance: "a8b2c6e112bf8c5de9bcd770b8a6fa3c7650700c8d13cf3e3a5a1f7d6486271e"
} as const;

const fileBytes = (relativePath: string) => readFileSync(new URL(relativePath, contractRoot));
const loadJson = (relativePath: string): unknown => JSON.parse(fileBytes(relativePath).toString("utf8"));
const fileDigest = (relativePath: string) => createHash("sha256").update(fileBytes(relativePath)).digest("hex");
const fixture = (name: string) => loadJson(`fixtures/${name}`) as SkillFormatV2;
const corpus = () => loadJson("fixtures/skill-format-v2.conformance.json") as ConformanceCorpus;

function pointerTarget(root: unknown, pointer: string): { parent: unknown; key: string } {
  const segments = pointer.split("/").slice(1).map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (segments.length === 0) throw new Error("fixture mutations cannot target the document root");
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = Array.isArray(parent) ? parent[Number(segment)] : (parent as Record<string, unknown>)[segment];
  }
  return { parent, key: segments.at(-1)! };
}

function applyMutation(doc: Record<string, any>, mutation: Mutation): void {
  if (mutation.op === "recompute-digests") {
    const identity = doc.evaluator.identity;
    doc.digests = {
      definitionDigest: evaluatorDefinitionDigest(identity.definition),
      skillDigest: skillDigestV2(identity),
      outputContractDigest: evaluatorOutputContractDigestV2(identity.definition)
    };
    return;
  }
  const { parent, key } = pointerTarget(doc, mutation.path);
  if (mutation.op === "remove") {
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete (parent as Record<string, unknown>)[key];
    return;
  }
  if (Array.isArray(parent)) parent[Number(key)] = mutation.value;
  // defineProperty makes even a `__proto__` key an own key, as JSON.parse does.
  else Object.defineProperty(parent, key, { value: structuredClone(mutation.value), enumerable: true, writable: true, configurable: true });
}

function materialize(testCase: ConformanceCase, conformance: ConformanceCorpus): unknown {
  const doc = structuredClone(fixture(testCase.baseFixture ?? conformance.baseFixture)) as Record<string, any>;
  for (const mutation of testCase.mutations) applyMutation(doc, mutation);
  return doc;
}

describe("skill-format v2 contract (ADR-0014 section 7)", () => {
  it("pins the schema, specification, and portable vectors", () => {
    expect(fileDigest("skill-format-v2.schema.json")).toBe(pinnedFileDigests.schema);
    expect(fileDigest("skill-format-v2.md")).toBe(pinnedFileDigests.specification);
    expect(fileDigest("fixtures/skill-format-v2.prompted.json")).toBe(pinnedFileDigests.prompted);
    expect(fileDigest("fixtures/skill-format-v2.typed-question.json")).toBe(pinnedFileDigests.typedQuestion);
    expect(fileDigest("fixtures/skill-format-v2.conformance.json")).toBe(pinnedFileDigests.conformance);
  });

  it("carries the full definition, binding, and question text, with digests an importer recomputes", () => {
    const prompted = verifySkillFormatV2(fixture("skill-format-v2.prompted.json"));
    expect(prompted.evaluator.identity.definition).toEqual(DEFINITIONS.prompted);
    expect(prompted.evaluator.identity.executionBinding).toEqual(BINDINGS.sonnet);
    expect(prompted.evaluator.question).toBeNull();
    const typed = verifySkillFormatV2(fixture("skill-format-v2.typed-question.json"));
    expect(typed.evaluator.question).toEqual(QUESTION);
    expect(typedQuestionDigest(typed.evaluator.question!)).toBe(DEFINITIONS.typedQuestion.question.digest);
    // The same evaluator has the same identity in every v2 contract.
    const manifest = loadJson("fixtures/evaluator-suite-manifest-v2.complete.json") as { members: Array<{ skillDigest: string }> };
    expect(manifest.members.map((member) => member.skillDigest)).toEqual([prompted.digests.skillDigest, typed.digests.skillDigest]);
  });

  it("keeps JSON Schema and Zod acceptance aligned over the portable corpus", () => {
    const schema = loadJson("skill-format-v2.schema.json") as { $id?: string; additionalProperties?: boolean };
    expect(schema.$id).toBe("https://rubrist.dev/contracts/skill-format-v2.schema.json");
    expect(schema.additionalProperties).toBe(false);
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema as object);
    const conformance = corpus();
    for (const testCase of conformance.cases) {
      const raw = materialize(testCase, conformance);
      const expected = testCase.structural === "accept";
      expect(validate(raw), `JSON Schema: ${testCase.name}`).toBe(expected);
      expect(SkillFormatV2Schema.safeParse(raw).success, `Zod: ${testCase.name}`).toBe(expected);
    }
  });

  it("accepts or rejects every semantic case for the stated reason", () => {
    const conformance = corpus();
    for (const testCase of conformance.cases.filter((entry) => entry.semantic !== "not-run")) {
      const raw = materialize(testCase, conformance);
      const verify = () => verifySkillFormatV2(raw, { skillDigest: testCase.expectedSkillDigest });
      if (testCase.semantic === "accept") {
        expect(verify, testCase.name).not.toThrow();
      } else {
        expect(testCase.errorIncludes, `${testCase.name} states its reason`).toBeTruthy();
        expect(verify, testCase.name).toThrow(testCase.errorIncludes);
      }
    }
  });

  it("checks what JSON Schema can't express: ascending ranges, lone surrogates, and nested __proto__ keys", () => {
    const base = structuredClone(fixture("skill-format-v2.prompted.json")) as Record<string, any>;
    const descending = structuredClone(base);
    descending.evaluator.identity.definition.verdictKind = "scalar";
    descending.evaluator.identity.definition.scalarRange = [5, 1];
    expect(SkillFormatV2Schema.safeParse(descending).success).toBe(false);
    const surrogate = structuredClone(base);
    surrogate.examples[0].reason = "safe\ud800";
    expect(SkillFormatV2Schema.safeParse(surrogate).success).toBe(false);
    const nestedProto = structuredClone(base);
    nestedProto.examples[0].input = JSON.parse('{"question":"hi","__proto__":{"x":1}}');
    expect(SkillFormatV2Schema.safeParse(nestedProto).success).toBe(false);
  });
});
