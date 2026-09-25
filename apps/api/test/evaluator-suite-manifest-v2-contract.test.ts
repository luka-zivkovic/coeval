import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { EvaluatorSuiteManifestV2Schema, type EvaluatorSuiteManifestV2 } from "@rubrist/shared";
import { canonicalJson } from "../src/lib/assessment-receipt.js";
import { evaluatorOutputContractDigestV2, skillDigestV2 } from "../src/lib/evaluator-identity.js";
import {
  buildEvaluatorSuiteManifestV2,
  canonicalEvaluatorSuiteManifestV2Bytes,
  evaluatorSuiteCriterionDigestV2,
  evaluatorSuiteManifestV2Digest,
  parseCanonicalEvaluatorSuiteManifestV2Bytes,
  verifyEvaluatorSuiteManifestV2,
  type ExpectedEvaluatorSuiteManifestV2
} from "../src/lib/evaluator-suite-manifest-v2.js";
import { BINDINGS, DEFINITIONS } from "./fixtures/evaluator-v2-vectors.js";

type Mutation =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "reverse"; path: string }
  | { op: "reindex-members" }
  | { op: "recompute-criterion-digests" }
  | { op: "recompute-manifest-digest" };

interface ConformanceCase {
  name: string;
  structural: "accept" | "reject";
  semantic: "accept" | "reject" | "not-run";
  errorIncludes?: string;
  mutations: Mutation[];
}

interface ConformanceCorpus {
  contract: "rubrist/evaluator-suite-manifest/v2";
  baseFixture: string;
  cases: ConformanceCase[];
}

const contractRoot = new URL("../../../contracts/", import.meta.url);
const pinnedFileDigests = {
  schema: "16a4f00c58bdb235b9a2baba00a1b381da6fa6675255c1ef3e02a30982fb8ad2",
  specification: "b5398763150ed15a11d5dcf1331e20a4a0c1407874b3253d9fe9955b480184e2",
  fixture: "0ad44a443c1430cd613c96c91b8a780e882ce5f0e36f2750c53a5adf6afe494e",
  conformance: "148703d19c979a759486e076c5d455dde810d7d59149b9bc7be9aa23901027e3"
} as const;

const fileBytes = (relativePath: string) => readFileSync(new URL(relativePath, contractRoot));
const loadJson = (relativePath: string): unknown => JSON.parse(fileBytes(relativePath).toString("utf8"));
const fileDigest = (relativePath: string) => createHash("sha256").update(fileBytes(relativePath)).digest("hex");
const fixture = () => loadJson("fixtures/evaluator-suite-manifest-v2.complete.json") as EvaluatorSuiteManifestV2;
const corpus = () => loadJson("fixtures/evaluator-suite-manifest-v2.conformance.json") as ConformanceCorpus;
const BASIS = "rubrist/evaluator-identity/v2" as const;
const PROMPTED = { basis: BASIS, definition: DEFINITIONS.prompted, executionBinding: BINDINGS.sonnet };
const TYPED = { basis: BASIS, definition: DEFINITIONS.typedQuestion, executionBinding: BINDINGS.jev };

function expectedFrom(manifest: EvaluatorSuiteManifestV2): ExpectedEvaluatorSuiteManifestV2 {
  return { manifestId: manifest.manifestId, manifestDigest: manifest.manifestDigest, members: structuredClone(manifest.members) };
}

function pointerTarget(root: unknown, pointer: string): { parent: unknown; key: string } {
  const segments = pointer.split("/").slice(1).map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (segments.length === 0) throw new Error("fixture mutations cannot target the document root");
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = Array.isArray(parent) ? parent[Number(segment)] : (parent as Record<string, unknown>)[segment];
  }
  return { parent, key: segments.at(-1)! };
}

function applyMutation(manifest: Record<string, unknown>, mutation: Mutation): void {
  if (mutation.op === "reindex-members") {
    (manifest.members as Array<Record<string, unknown>>).forEach((member, index) => { member.position = index; });
    return;
  }
  if (mutation.op === "recompute-criterion-digests") {
    (manifest.members as Array<Record<string, unknown>>).forEach((member) => {
      member.criterionDigest = evaluatorSuiteCriterionDigestV2(member as unknown as EvaluatorSuiteManifestV2["members"][number]);
    });
    return;
  }
  if (mutation.op === "recompute-manifest-digest") {
    manifest.manifestDigest = evaluatorSuiteManifestV2Digest(manifest as unknown as EvaluatorSuiteManifestV2);
    return;
  }
  const { parent, key } = pointerTarget(manifest, mutation.path);
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
  // defineProperty makes even a `__proto__` key an own key, as JSON.parse does.
  else Object.defineProperty(parent, key, { value: mutation.value, enumerable: true, writable: true, configurable: true });
}

function materialize(base: EvaluatorSuiteManifestV2, testCase: ConformanceCase): unknown {
  const manifest = structuredClone(base) as unknown as Record<string, unknown>;
  for (const mutation of testCase.mutations) applyMutation(manifest, mutation);
  return manifest;
}

describe("evaluator suite manifest v2 contract (ADR-0014 section 7)", () => {
  it("pins the canonical schema, specification, and portable corpus bytes", () => {
    expect(fileDigest("evaluator-suite-manifest-v2.schema.json")).toBe(pinnedFileDigests.schema);
    expect(fileDigest("evaluator-suite-manifest-v2.md")).toBe(pinnedFileDigests.specification);
    expect(fileDigest("fixtures/evaluator-suite-manifest-v2.complete.json")).toBe(pinnedFileDigests.fixture);
    expect(fileDigest("fixtures/evaluator-suite-manifest-v2.conformance.json")).toBe(pinnedFileDigests.conformance);
  });

  it("binds each member to the v2 skillDigest and output-contract digest of its evaluator", () => {
    const manifest = verifyEvaluatorSuiteManifestV2(fixture());
    const identities = [PROMPTED, TYPED];
    manifest.members.forEach((member, index) => {
      expect(member.skillDigest).toBe(skillDigestV2(identities[index]!));
      expect(member.outputContractDigest).toBe(evaluatorOutputContractDigestV2(identities[index]!.definition));
    });
  });

  it("keeps the JSON Schema closed and aligned with the strict Zod schema", () => {
    const schema = loadJson("evaluator-suite-manifest-v2.schema.json") as {
      $id?: string; additionalProperties?: boolean; properties?: { contract?: { const?: string }; schemaVersion?: { const?: number } };
    };
    expect(schema.$id).toBe("https://rubrist.dev/contracts/evaluator-suite-manifest-v2.schema.json");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.contract?.const).toBe("rubrist/evaluator-suite-manifest/v2");
    expect(schema.properties?.schemaVersion?.const).toBe(2);
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema as object);
    const conformance = corpus();
    const base = loadJson(`fixtures/${conformance.baseFixture}`) as EvaluatorSuiteManifestV2;
    for (const testCase of conformance.cases) {
      const raw = materialize(base, testCase);
      const expected = testCase.structural === "accept";
      expect(validate(raw), `JSON Schema: ${testCase.name}`).toBe(expected);
      expect(EvaluatorSuiteManifestV2Schema.safeParse(raw).success, `Zod: ${testCase.name}`).toBe(expected);
    }
  });

  it("accepts or rejects every semantic conformance case for the stated reason", () => {
    const conformance = corpus();
    const base = loadJson(`fixtures/${conformance.baseFixture}`) as EvaluatorSuiteManifestV2;
    const expected = expectedFrom(base);
    for (const testCase of conformance.cases.filter((entry) => entry.semantic !== "not-run")) {
      const raw = materialize(base, testCase);
      const verify = () => verifyEvaluatorSuiteManifestV2(raw, expected);
      if (testCase.semantic === "accept") {
        expect(verify, testCase.name).not.toThrow();
      } else {
        expect(testCase.errorIncludes, `${testCase.name} states its reason`).toBeTruthy();
        expect(verify, testCase.name).toThrow(testCase.errorIncludes);
      }
    }
  });

  it("rejects release-policy vocabulary instead of silently dropping it", () => {
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(loadJson("evaluator-suite-manifest-v2.schema.json") as object);
    for (const field of ["weight", "threshold", "mandatory", "advisory", "blocking", "compensatory", "compositeScore", "releaseDecision", "rollout", "override"]) {
      const rootCandidate = { ...structuredClone(fixture()), [field]: true };
      expect(validate(rootCandidate), `JSON Schema root: ${field}`).toBe(false);
      expect(EvaluatorSuiteManifestV2Schema.safeParse(rootCandidate).success, `Zod root: ${field}`).toBe(false);
      const memberCandidate = structuredClone(fixture()) as EvaluatorSuiteManifestV2 & { members: Array<Record<string, unknown>> };
      memberCandidate.members[0]![field] = true;
      expect(validate(memberCandidate), `JSON Schema member: ${field}`).toBe(false);
      expect(EvaluatorSuiteManifestV2Schema.safeParse(memberCandidate).success, `Zod member: ${field}`).toBe(false);
    }
  });

  it("builds deterministic manifests and treats a closed trial plan as identity", () => {
    const members = [
      { criterionId: "criterion_a", criterionVersionId: "criterionv_a_1", criterionName: "Criterion A",
        criterionDefinition: "Judge criterion A independently.", skillId: "skill_a", skillVersionId: "skillv_a_1", identity: PROMPTED },
      { criterionId: "criterion_b", criterionVersionId: "criterionv_b_1", criterionName: "Criterion B",
        criterionDefinition: "Judge criterion B independently.", skillId: "skill_b", skillVersionId: "skillv_b_1", identity: TYPED }
    ];
    const baseInput = { manifestId: "manifest_1", suiteId: "suite_1", projectId: "project_1", revision: 1, members };
    const single = buildEvaluatorSuiteManifestV2({ ...baseInput, trialPlan: null });
    const repeated = buildEvaluatorSuiteManifestV2({ ...baseInput, manifestId: "manifest_2", revision: 2,
      trialPlan: { kind: "independent_repetitions", trialsPerItem: 3 } });
    expect(buildEvaluatorSuiteManifestV2({ ...baseInput, trialPlan: null })).toEqual(single);
    expect(single.members.map((member) => member.position)).toEqual([0, 1]);
    expect(repeated.manifestDigest).not.toBe(single.manifestDigest);
  });

  it("serves and parses only exact canonical UTF-8 bytes", () => {
    const manifest = verifyEvaluatorSuiteManifestV2(fixture());
    const bytes = canonicalEvaluatorSuiteManifestV2Bytes(manifest);
    expect(bytes.toString("utf8")).toBe(canonicalJson(manifest));
    expect(parseCanonicalEvaluatorSuiteManifestV2Bytes(bytes)).toEqual(manifest);
    expect(() => parseCanonicalEvaluatorSuiteManifestV2Bytes(fileBytes("fixtures/evaluator-suite-manifest-v2.complete.json")))
      .toThrow("not exact canonical JSON");
    expect(() => parseCanonicalEvaluatorSuiteManifestV2Bytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])))
      .toThrow("not valid JSON");
    expect(() => parseCanonicalEvaluatorSuiteManifestV2Bytes(Uint8Array.from([0xff]))).toThrow("not valid UTF-8");
  });

  it("fails validation, rather than throwing, on hostile nesting", () => {
    let payload: unknown = "leaf";
    for (let depth = 0; depth < 5_000; depth += 1) payload = [payload];
    const deep = { ...structuredClone(fixture()), unexpected: payload };
    expect(() => EvaluatorSuiteManifestV2Schema.safeParse(deep)).not.toThrow();
    expect(EvaluatorSuiteManifestV2Schema.safeParse(deep).success).toBe(false);
  });

  it("refuses lone surrogates anywhere, which JSON Schema can't express", () => {
    const candidate = structuredClone(fixture());
    candidate.members[0]!.criterionName = "Factual\ud800";
    expect(EvaluatorSuiteManifestV2Schema.safeParse(candidate).success).toBe(false);
  });
});
