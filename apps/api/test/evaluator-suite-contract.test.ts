import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  EvaluatorSuiteManifestSchema,
  MinimumVerdictOutputSchema,
  type EvaluatorSuiteManifest,
  type SkillVersion
} from "@rubrist/shared";
import { skillDigest } from "../src/lib/assessment-receipt.js";
import {
  buildEvaluatorSuiteManifest,
  canonicalEvaluatorSuiteManifestBytes,
  evaluatorSuiteCriterionDigest,
  evaluatorSuiteManifestDigest,
  parseCanonicalEvaluatorSuiteManifestBytes,
  verifyEvaluatorSuiteManifest,
  type ExpectedEvaluatorSuiteManifest
} from "../src/lib/evaluator-suite.js";

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
  contract: "rubrist/evaluator-suite-manifest/v1";
  baseFixture: string;
  cases: ConformanceCase[];
}

const contractRoot = new URL("../../../contracts/", import.meta.url);
const pinnedFileDigests = {
  schema: "5d32cb547d354ffb74f0236bddb249c65fc8c32ae113fced46a62561fb9d9f3a",
  specification: "d20974868c3d3f126ccc3b0f926489c20089ff0f8aa1659834a9441920eb0564",
  fixture: "cc8a51571b4b16ff2c004fad8d3bd1eb747dae526a457f7c0806dcb21e523134",
  conformance: "0ae717946ba9124e0caf5adf68ea4c3808d0f7285c68f394c940782263534506"
} as const;

const pinnedReceiptV1FileDigests = {
  schema: "3e5ce757a7f86d02a6ab33057c9176ea052225d65f984ca91e48e5dbaead30a3",
  specification: "3316bd789574b8976e6449e4fd52725fb972b920eed004e9edf6c9a2456c2432",
  fixture: "803606d52c79b15c9869ced5920c166a180f4534a3eaf521423e6d0ed1b76752",
  conformance: "caa74e8632721cf48ceca1133078ade568bfad4fcea177b5e7588837080c0692"
} as const;

function fileBytes(relativePath: string): Buffer {
  return readFileSync(new URL(relativePath, contractRoot));
}

function fileDigest(relativePath: string): string {
  return createHash("sha256").update(fileBytes(relativePath)).digest("hex");
}

function loadJson(relativePath: string): unknown {
  return JSON.parse(fileBytes(relativePath).toString("utf8"));
}

function fixture(relativePath = "fixtures/evaluator-suite-manifest-v1.complete.json"): EvaluatorSuiteManifest {
  return loadJson(relativePath) as EvaluatorSuiteManifest;
}

function corpus(): ConformanceCorpus {
  return loadJson("fixtures/evaluator-suite-manifest-v1.conformance.json") as ConformanceCorpus;
}

function expectedFrom(manifest: EvaluatorSuiteManifest): ExpectedEvaluatorSuiteManifest {
  return {
    manifestId: manifest.manifestId,
    manifestDigest: manifest.manifestDigest,
    members: structuredClone(manifest.members)
  };
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

function applyMutation(manifest: Record<string, unknown>, mutation: Mutation): void {
  if (mutation.op === "reindex-members") {
    (manifest.members as Array<Record<string, unknown>>).forEach((member, index) => {
      member.position = index;
    });
    return;
  }
  if (mutation.op === "recompute-criterion-digests") {
    (manifest.members as Array<Record<string, unknown>>).forEach((member) => {
      member.criterionDigest = evaluatorSuiteCriterionDigest(member as unknown as EvaluatorSuiteManifest["members"][number]);
    });
    return;
  }
  if (mutation.op === "recompute-manifest-digest") {
    manifest.manifestDigest = evaluatorSuiteManifestDigest(manifest as unknown as EvaluatorSuiteManifest);
    return;
  }

  const { parent, key } = pointerTarget(manifest, mutation.path);
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

function materialize(base: EvaluatorSuiteManifest, testCase: ConformanceCase): unknown {
  const manifest = structuredClone(base) as unknown as Record<string, unknown>;
  for (const mutation of testCase.mutations) applyMutation(manifest, mutation);
  return manifest;
}

function skillVersion(overrides: Partial<SkillVersion> & Pick<SkillVersion, "id" | "skillId">): SkillVersion {
  return {
    id: overrides.id,
    skillId: overrides.skillId,
    criterionVersionId: overrides.criterionVersionId ?? `criterionv_${overrides.skillId}`,
    version: overrides.version ?? "1.0.0",
    status: overrides.status ?? "approved",
    rubricMarkdown: overrides.rubricMarkdown ?? "# Criterion\n\nPass when the criterion is satisfied.",
    prompt: overrides.prompt ?? "Judge against {{rubric_markdown}}.",
    modelBinding: overrides.modelBinding ?? {
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      modelVersion: "claude-sonnet-4-6",
      temperature: 0
    },
    outputSchema: overrides.outputSchema ?? MinimumVerdictOutputSchema,
    goldenSetAgreement: overrides.goldenSetAgreement ?? null,
    tooStrictCount: overrides.tooStrictCount ?? 0,
    tooLenientCount: overrides.tooLenientCount ?? 0,
    ambiguousCount: overrides.ambiguousCount ?? 0,
    knownLimitations: overrides.knownLimitations ?? [],
    verdictKind: overrides.verdictKind ?? "binary",
    scalarRange: overrides.scalarRange ?? null,
    categoricalChoiceScores: overrides.categoricalChoiceScores ?? null,
    rubricProvenance: overrides.rubricProvenance ?? "human-authored",
    regressionDatasetRevisionId: overrides.regressionDatasetRevisionId ?? null,
    createdAt: overrides.createdAt ?? "2026-08-22T00:00:00.000Z",
    approvedAt: overrides.approvedAt ?? "2026-08-22T00:00:00.000Z"
  };
}

describe("evaluator suite manifest v1 contract", () => {
  it("pins the canonical schema, specification, and portable corpus bytes", () => {
    expect(fileDigest("evaluator-suite-manifest-v1.schema.json")).toBe(pinnedFileDigests.schema);
    expect(fileDigest("evaluator-suite-manifest-v1.md")).toBe(pinnedFileDigests.specification);
    expect(fileDigest("fixtures/evaluator-suite-manifest-v1.complete.json")).toBe(pinnedFileDigests.fixture);
    expect(fileDigest("fixtures/evaluator-suite-manifest-v1.conformance.json")).toBe(pinnedFileDigests.conformance);
  });

  it("keeps receipt v1 contract bytes frozen", () => {
    expect(fileDigest("assessment-receipt-v1.schema.json")).toBe(pinnedReceiptV1FileDigests.schema);
    expect(fileDigest("assessment-receipt-v1.md")).toBe(pinnedReceiptV1FileDigests.specification);
    expect(fileDigest("fixtures/assessment-receipt-v1.complete.json")).toBe(pinnedReceiptV1FileDigests.fixture);
    expect(fileDigest("fixtures/assessment-receipt-v1.conformance.json")).toBe(pinnedReceiptV1FileDigests.conformance);
  });

  it("keeps the JSON Schema closed and aligned with the strict Zod schema", () => {
    const schema = loadJson("evaluator-suite-manifest-v1.schema.json") as {
      $id?: string;
      additionalProperties?: boolean;
      properties?: { contract?: { const?: string }; schemaVersion?: { const?: number } };
    };
    expect(schema.$id).toBe("https://rubrist.dev/contracts/evaluator-suite-manifest-v1.schema.json");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.contract?.const).toBe("rubrist/evaluator-suite-manifest/v1");
    expect(schema.properties?.schemaVersion?.const).toBe(1);

    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema as object);
    const conformance = corpus();
    const base = fixture(`fixtures/${conformance.baseFixture}`);
    for (const testCase of conformance.cases) {
      const raw = materialize(base, testCase);
      const expected = testCase.structural === "accept";
      expect(validate(raw), `JSON Schema: ${testCase.name}`).toBe(expected);
      expect(EvaluatorSuiteManifestSchema.safeParse(raw).success, `Zod: ${testCase.name}`).toBe(expected);
    }
  });

  it("accepts or rejects every semantic conformance case for the stated reason", () => {
    const conformance = corpus();
    const base = fixture(`fixtures/${conformance.baseFixture}`);
    const expected = expectedFrom(base);
    for (const testCase of conformance.cases.filter((entry) => entry.semantic !== "not-run")) {
      const raw = materialize(base, testCase);
      const verify = () => verifyEvaluatorSuiteManifest(raw, expected);
      if (testCase.semantic === "accept") expect(verify, testCase.name).not.toThrow();
      else expect(verify, testCase.name).toThrow(testCase.errorIncludes);
    }
  });

  it("rejects release-policy vocabulary instead of silently dropping it", () => {
    const schema = loadJson("evaluator-suite-manifest-v1.schema.json");
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema as object);
    const policyFields = [
      "weight",
      "threshold",
      "mandatory",
      "advisory",
      "blocking",
      "compensatory",
      "compositeScore",
      "releaseDecision",
      "rollout",
      "override"
    ];
    for (const field of policyFields) {
      const rootCandidate = { ...structuredClone(fixture()), [field]: true };
      expect(validate(rootCandidate), `JSON Schema root: ${field}`).toBe(false);
      expect(EvaluatorSuiteManifestSchema.safeParse(rootCandidate).success, `Zod root: ${field}`).toBe(false);

      const memberCandidate = structuredClone(fixture()) as EvaluatorSuiteManifest & { members: Array<Record<string, unknown>> };
      memberCandidate.members[0]![field] = true;
      expect(validate(memberCandidate), `JSON Schema member: ${field}`).toBe(false);
      expect(EvaluatorSuiteManifestSchema.safeParse(memberCandidate).success, `Zod member: ${field}`).toBe(false);
    }
  });

  it("builds deterministic manifests and treats a closed trial plan as identity", () => {
    const members = [
      {
        criterionId: "criterion_a",
        criterionVersionId: "criterionv_a_1",
        criterionName: "Criterion A",
        criterionDefinition: "Judge criterion A independently.",
        skillVersion: skillVersion({ id: "skillv_a_1", skillId: "skill_a" })
      },
      {
        criterionId: "criterion_b",
        criterionVersionId: "criterionv_b_1",
        criterionName: "Criterion B",
        criterionDefinition: "Judge criterion B independently.",
        skillVersion: skillVersion({ id: "skillv_b_1", skillId: "skill_b" })
      }
    ];
    const baseInput = {
      manifestId: "manifest_1",
      suiteId: "suite_1",
      projectId: "project_1",
      revision: 1,
      members
    };
    const single = buildEvaluatorSuiteManifest({ ...baseInput, trialPlan: null });
    const repeated = buildEvaluatorSuiteManifest({
      ...baseInput,
      manifestId: "manifest_2",
      revision: 2,
      trialPlan: { kind: "independent_repetitions", trialsPerItem: 3 }
    });
    expect(buildEvaluatorSuiteManifest({ ...baseInput, trialPlan: null })).toEqual(single);
    expect(single.members.map((member) => member.position)).toEqual([0, 1]);
    expect(single.members.every((member) => member.applicability.kind === "all_items")).toBe(true);
    expect(repeated.trialPlan).toEqual({ kind: "independent_repetitions", trialsPerItem: 3 });
    expect(repeated.manifestDigest).not.toBe(single.manifestDigest);
  });

  it("serves and parses only exact canonical UTF-8 bytes", () => {
    const manifest = verifyEvaluatorSuiteManifest(fixture());
    const bytes = canonicalEvaluatorSuiteManifestBytes(manifest);
    expect(parseCanonicalEvaluatorSuiteManifestBytes(bytes)).toEqual(manifest);
    expect(() => parseCanonicalEvaluatorSuiteManifestBytes(fileBytes("fixtures/evaluator-suite-manifest-v1.complete.json")))
      .toThrow("not exact canonical JSON");
    expect(() => parseCanonicalEvaluatorSuiteManifestBytes(Uint8Array.from([0xff])))
      .toThrow("not valid UTF-8");
  });

  it("does not add criterion metadata to the frozen receipt-v1 skillDigest basis", () => {
    const version = skillVersion({ id: "skillv_digest", skillId: "skill_digest" });
    const extended = {
      ...version,
      criterionId: "criterion_digest",
      criterionVersionId: "criterionv_digest_1"
    } as SkillVersion;
    expect(skillDigest(extended)).toBe(skillDigest(version));
  });
});
