import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  BinaryCalibrationV2ArtifactSchema,
  BinaryCalibrationV2ExactRateSchema,
  BinaryCalibrationV2PrivateLedgerSchema,
  type BinaryCalibrationV2Artifact,
  type BinaryCalibrationV2PrivateLedger
} from "@rubrist/shared";
import { canonicalJson, sha256Digest } from "../src/lib/assessment-receipt.js";
import { skillDigestV2FromInput } from "../src/lib/evaluator-identity.js";
import {
  BINARY_CALIBRATION_V2_MAX_CANONICAL_BYTES,
  binaryCalibrationV2EvidenceDigest,
  binaryCalibrationV2PrivateLedgerCommitmentDigest,
  canonicalBinaryCalibrationV2ArtifactBytes,
  canonicalBinaryCalibrationV2PrivateLedgerBytes,
  parseCanonicalBinaryCalibrationV2ArtifactBytes,
  verifyBinaryCalibrationV2Artifact,
  verifyBinaryCalibrationV2PrivateLedger,
  verifyBinaryCalibrationV2PrivateLedgerForArtifact,
  wilson95Binary64Bounds,
  type ExpectedBinaryCalibrationV2Artifact
} from "../src/lib/binary-calibration-v2.js";

type Mutation =
  | { op: "add" | "replace"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "copy"; from: string; path: string }
  | { op: "reverse"; path: string }
  | { op: "recompute-evidence-digest" };

interface ConformanceCase {
  name: string;
  baseFixture?: "binary-calibration-v2.complete.json" | "binary-calibration-v2.repeated.json" | "binary-calibration-v2.incomplete.json";
  structural: "accept" | "reject";
  semantic: "accept" | "reject" | "not-run";
  errorIncludes?: string;
  expectedOverrides?: Partial<ExpectedBinaryCalibrationV2Artifact>;
  mutations: Mutation[];
}

interface ConformanceCorpus {
  contract: "rubrist/binary-calibration/v2";
  baseFixture: string;
  expectedIdentityByFixture: Record<string, ExpectedBinaryCalibrationV2Artifact>;
  cases: ConformanceCase[];
}

const contractRoot = new URL("../../../contracts/", import.meta.url);
const pinnedFileDigests = {
  schema: "b6a5ec76bd0e52d18273831560e0a9628f39b2e9562a6c51a4a7c823d9433f50",
  specification: "fac6c9d07544cef9ecb4c70e5ec6bffada24baddaab66319d09a2cba7c2fa099",
  completeFixture: "32a29cd8debe0d20a67c23d23e4586ffad39a1f4df547d76843637c20cda3cd7",
  repeatedFixture: "4cd6b336201d99da935e6adcb1767a968c1edaf8d81aa4af17b9e3db3b9cc683",
  incompleteFixture: "3db20756cf211f34f19d7f2b97bc0d823d8b7676fd0fc818217da56e76bb7734",
  conformance: "d89cdbd66b0eaebc9a238e5841c2cc9f5ee5eaf792a94151dd2295657dbf33e2",
  wilsonReference: "948ac238d7b5780dd160dd29bbcad52259c3ae574287fc19fb63cdc41e02d8dd",
  privateLedgerSchema: "621b92ee557c705bbb073374a8b878a64475e124a40c69ecbba7713d8d4dcff4",
  privateLedgerFixture: "3d2758bd4f1d7ff2bf309d9fd301fa88b8bb0337c13c4d18d700bbf071f36b0a"
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

function fixture(name: "complete" | "repeated" | "incomplete" = "complete"): BinaryCalibrationV2Artifact {
  return loadJson(`fixtures/binary-calibration-v2.${name}.json`) as BinaryCalibrationV2Artifact;
}

function corpus(): ConformanceCorpus {
  return loadJson("fixtures/binary-calibration-v2.conformance.json") as ConformanceCorpus;
}

function expectedFrom(artifact: BinaryCalibrationV2Artifact): ExpectedBinaryCalibrationV2Artifact {
  return {
    artifactId: artifact.artifactId,
    calibrationRunId: artifact.calibrationRunId,
    projectId: artifact.projectId,
    criterionId: artifact.criterion.criterionId,
    criterionVersionId: artifact.criterion.criterionVersionId,
    criterionDigest: artifact.criterion.criterionDigest,
    skillId: artifact.evaluator.skillId,
    skillVersionId: artifact.evaluator.skillVersionId,
    skillDigest: artifact.evaluator.skillDigest,
    outputContractDigest: artifact.evaluator.outputContractDigest,
    requestedBindingDigest: artifact.evaluator.requestedBindingDigest,
    datasetRevisionId: artifact.truth.datasetRevisionId,
    revisionDigest: artifact.truth.revisionDigest,
    contentDigest: artifact.truth.contentDigest,
    itemCount: artifact.truth.itemCount,
    governedReviewBatchId: artifact.truth.origin.governedReviewBatchId,
    governedReviewBatchDigest: artifact.truth.origin.governedReviewBatchDigest,
    reviewInstructionVersionId: artifact.truth.origin.reviewInstructionVersionId,
    reviewInstructionDigest: artifact.truth.origin.reviewInstructionDigest,
    populationId: artifact.truth.origin.populationId,
    populationDigest: artifact.truth.origin.populationDigest,
    drawDigest: artifact.truth.origin.drawDigest,
    representativeOfPopulationId: artifact.truth.representativeOfPopulationId,
    selectionMethod: artifact.truth.selectionMethod,
    exposureAuthorizationSnapshotDigest: artifact.exposure.authorization.snapshotDigest,
    exposureAuthorizationEventId: artifact.exposure.authorization.eventId,
    exposureCompletionSnapshotDigest: artifact.exposure.completion.snapshotDigest,
    exposureCompletionEventId: artifact.exposure.completion.eventId,
    exposureCompletionState: artifact.exposure.completion.state,
    exposureCompletionEligibility: artifact.exposure.completion.eligibility.result,
    executionEnvironment: artifact.execution.providerDataHandling.executionEnvironment,
    providerDataHandlingPolicyId: artifact.execution.providerDataHandling.policyId,
    providerDataHandlingPolicyDigest: artifact.execution.providerDataHandling.policyDigest,
    positiveClass: artifact.positiveClass,
    trialPlanKind: artifact.trialPlan.kind,
    trialsPerItem: artifact.trialPlan.trialsPerItem,
    suiteManifestId: artifact.suiteBinding?.manifestId ?? null,
    suiteManifestDigest: artifact.suiteBinding?.manifestDigest ?? null,
    suiteMemberPosition: artifact.suiteBinding?.memberPosition ?? null
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

function applyMutation(artifact: Record<string, unknown>, mutation: Mutation): void {
  if (mutation.op === "recompute-evidence-digest") {
    artifact.evidenceDigest = binaryCalibrationV2EvidenceDigest(artifact as unknown as BinaryCalibrationV2Artifact);
    return;
  }
  if (mutation.op === "reverse") {
    const { parent, key } = pointerTarget(artifact, mutation.path);
    const value = Array.isArray(parent) ? parent[Number(key)] : (parent as Record<string, unknown>)[key];
    if (!Array.isArray(value)) throw new Error(`${mutation.path} is not an array`);
    value.reverse();
    return;
  }
  if (mutation.op === "copy") {
    const source = pointerTarget(artifact, mutation.from);
    const sourceValue = Array.isArray(source.parent)
      ? source.parent[Number(source.key)]
      : (source.parent as Record<string, unknown>)[source.key];
    const target = pointerTarget(artifact, mutation.path);
    const cloned = structuredClone(sourceValue);
    if (Array.isArray(target.parent)) target.parent.splice(Number(target.key), 0, cloned);
    else (target.parent as Record<string, unknown>)[target.key] = cloned;
    return;
  }
  const { parent, key } = pointerTarget(artifact, mutation.path);
  if (mutation.op === "remove") {
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete (parent as Record<string, unknown>)[key];
    return;
  }
  if (Array.isArray(parent)) {
    if (mutation.op === "add") parent.splice(Number(key), 0, mutation.value);
    else parent[Number(key)] = mutation.value;
  } else {
    (parent as Record<string, unknown>)[key] = mutation.value;
  }
}

function materialize(base: BinaryCalibrationV2Artifact, testCase: ConformanceCase): unknown {
  const artifact = structuredClone(base) as unknown as Record<string, unknown>;
  for (const mutation of testCase.mutations) applyMutation(artifact, mutation);
  return artifact;
}

function caseBase(testCase: ConformanceCase, conformance: ConformanceCorpus): BinaryCalibrationV2Artifact {
  return loadJson(`fixtures/${testCase.baseFixture ?? conformance.baseFixture}`) as BinaryCalibrationV2Artifact;
}

function expectedForCase(
  testCase: ConformanceCase,
  conformance: ConformanceCorpus
): ExpectedBinaryCalibrationV2Artifact {
  const name = testCase.baseFixture ?? conformance.baseFixture;
  const base = conformance.expectedIdentityByFixture[name];
  if (!base) throw new Error(`missing portable expected identity for ${name}`);
  return { ...base, ...testCase.expectedOverrides };
}

describe("binary calibration artifact v2 contract (ADR-0014 section 7)", () => {
  it("pins the schema, specification, immutable fixtures, and adversarial corpus", () => {
    expect(fileDigest("binary-calibration-v2.schema.json")).toBe(pinnedFileDigests.schema);
    expect(fileDigest("binary-calibration-v2.md")).toBe(pinnedFileDigests.specification);
    expect(fileDigest("fixtures/binary-calibration-v2.complete.json")).toBe(pinnedFileDigests.completeFixture);
    expect(fileDigest("fixtures/binary-calibration-v2.repeated.json")).toBe(pinnedFileDigests.repeatedFixture);
    expect(fileDigest("fixtures/binary-calibration-v2.incomplete.json")).toBe(pinnedFileDigests.incompleteFixture);
    expect(fileDigest("fixtures/binary-calibration-v2.conformance.json")).toBe(pinnedFileDigests.conformance);
    expect(fileDigest("reference/binary-calibration-wilson-v1.py")).toBe(pinnedFileDigests.wilsonReference);
  });

  it("pins and verifies the private-ledger commitment without adding a read surface", () => {
    expect(fileDigest("binary-calibration-private-ledger-v2.schema.json")).toBe(pinnedFileDigests.privateLedgerSchema);
    expect(fileDigest("fixtures/binary-calibration-private-ledger-v2.complete.json")).toBe(pinnedFileDigests.privateLedgerFixture);
    const schema = loadJson("binary-calibration-private-ledger-v2.schema.json") as object;
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
    const ledger = loadJson("fixtures/binary-calibration-private-ledger-v2.complete.json") as BinaryCalibrationV2PrivateLedger;
    expect(validate(ledger)).toBe(true);
    expect(BinaryCalibrationV2PrivateLedgerSchema.safeParse(ledger).success).toBe(true);
    expect(verifyBinaryCalibrationV2PrivateLedger(ledger)).toEqual(ledger);
    expect(canonicalBinaryCalibrationV2PrivateLedgerBytes(ledger)).toEqual(
      fileBytes("fixtures/binary-calibration-private-ledger-v2.complete.json")
    );
    expect(binaryCalibrationV2PrivateLedgerCommitmentDigest(ledger)).toBe(fixture().privateLedger.commitmentDigest);
    expect(verifyBinaryCalibrationV2PrivateLedgerForArtifact(ledger, fixture())).toEqual({
      ledger,
      artifact: fixture()
    });

    const providerSwap = structuredClone(ledger);
    providerSwap.records[0]!.providerObservation.provider = "other-provider";
    expect(() => verifyBinaryCalibrationV2PrivateLedger(providerSwap)).toThrow("does not match requestedProvider");
    const duplicateSalt = structuredClone(ledger);
    duplicateSalt.records[1]!.commitmentSalt = duplicateSalt.records[0]!.commitmentSalt;
    expect(() => verifyBinaryCalibrationV2PrivateLedger(duplicateSalt)).toThrow("salts must be unique");
    const badAttempt = structuredClone(ledger);
    badAttempt.records[0]!.attemptState = "started";
    expect(() => verifyBinaryCalibrationV2PrivateLedger(badAttempt)).toThrow("attemptState must be terminal");
    const classifiedWithoutCall = structuredClone(ledger);
    classifiedWithoutCall.records[0]!.physicalProviderCalls = 0;
    expect(() => verifyBinaryCalibrationV2PrivateLedger(classifiedWithoutCall)).toThrow("observed identity requires a physical provider call");
    const notAttemptedWithCall = structuredClone(ledger);
    notAttemptedWithCall.records[1]!.result = { state: "not_attempted" };
    notAttemptedWithCall.records[1]!.attemptState = "not_started";
    expect(() => verifyBinaryCalibrationV2PrivateLedger(notAttemptedWithCall)).toThrow("not_attempted record must have zero calls");
    const unknownWithoutCall = structuredClone(ledger);
    unknownWithoutCall.records[0]!.result = { state: "failure", failureKind: "outcome_unknown" };
    unknownWithoutCall.records[0]!.attemptState = "started";
    unknownWithoutCall.records[0]!.physicalProviderCalls = 0;
    unknownWithoutCall.records[0]!.providerObservation.observedModel = null;
    expect(() => verifyBinaryCalibrationV2PrivateLedger(unknownWithoutCall)).toThrow("outcome_unknown requires a physical provider call");
    const upstreamOnDirect = structuredClone(ledger);
    upstreamOnDirect.records[0]!.providerObservation.upstreamProvider = "Anthropic";
    expect(() => verifyBinaryCalibrationV2PrivateLedger(upstreamOnDirect)).toThrow("upstreamProvider is recorded only for OpenRouter");
    const legacyRecord = structuredClone(ledger) as unknown as { records: Array<Record<string, unknown>> };
    legacyRecord.records[0]!.terminalEvaluatorOutcome = "evaluator_pass";
    expect(BinaryCalibrationV2PrivateLedgerSchema.safeParse(legacyRecord).success).toBe(false);
    expect(validate(legacyRecord)).toBe(false);
  });

  it("keeps JSON Schema and strict Zod structural decisions aligned", () => {
    const schema = loadJson("binary-calibration-v2.schema.json") as object;
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
    const conformance = corpus();
    for (const testCase of conformance.cases) {
      const raw = materialize(caseBase(testCase, conformance), testCase);
      const expected = testCase.structural === "accept";
      expect(validate(raw), `JSON Schema: ${testCase.name}`).toBe(expected);
      expect(BinaryCalibrationV2ArtifactSchema.safeParse(raw).success, `Zod: ${testCase.name}`).toBe(expected);
    }
  });

  it("pins portable expected identity for every corpus base fixture", () => {
    const conformance = corpus();
    for (const [name, expected] of Object.entries(conformance.expectedIdentityByFixture)) {
      const artifact = loadJson(`fixtures/${name}`) as BinaryCalibrationV2Artifact;
      expect(expected, name).toEqual(expectedFrom(artifact));
    }
    const expectedFields = Object.keys(conformance.expectedIdentityByFixture[conformance.baseFixture]!).sort();
    const swappedFields = conformance.cases
      .filter((entry) => entry.name.startsWith("expected-identity-swap-"))
      .map((entry) => entry.name.slice("expected-identity-swap-".length))
      .sort();
    expect(swappedFields).toEqual(expectedFields);
  });

  it("accepts or rejects each semantic mutation for its stated reason", () => {
    const conformance = corpus();
    for (const testCase of conformance.cases.filter((entry) => entry.semantic !== "not-run")) {
      const base = caseBase(testCase, conformance);
      const expected = expectedForCase(testCase, conformance);
      const raw = materialize(base, testCase);
      const verify = () => verifyBinaryCalibrationV2Artifact(raw, expected);
      if (testCase.semantic === "accept") expect(verify, testCase.name).not.toThrow();
      else expect(verify, testCase.name).toThrow(testCase.errorIncludes);
    }
  });

  it("verifies complete, repeated, and outcome_unknown incomplete evidence", () => {
    const complete = verifyBinaryCalibrationV2Artifact(fixture("complete"));
    expect(complete.status).toBe("complete");
    expect(complete.trials[0]?.outcomes.abstained).toBe(1);
    expect(complete.trials[0]?.metrics.classifiedCoverage.overall).toMatchObject({ numerator: 1, denominator: 2 });

    const repeated = verifyBinaryCalibrationV2Artifact(fixture("repeated"));
    expect(repeated.status).toBe("complete");
    expect(repeated.trials).toHaveLength(2);
    expect(repeated.trials.map((trial) => trial.metrics.accuracy.numerator)).toEqual([2, 0]);
    expect(repeated.trials[1]?.outcomes.providerCalls).toBe(3);
    expect(repeated.trials[1]?.providerIdentityGroups.map((group) => group.observationCount)).toEqual([1, 1]);

    const incomplete = verifyBinaryCalibrationV2Artifact(fixture("incomplete"));
    expect(incomplete.status).toBe("incomplete");
    expect(incomplete.incompleteReasons).toEqual(["trial_incomplete"]);
    expect(incomplete.trials[0]?.outcomes.errors).toEqual([{ code: "outcome_unknown", count: 1 }]);
    expect(incomplete.trials[0]?.outcomes.notAttempted).toBe(1);
    expect(incomplete.trials[0]?.providerIdentityGroups.map((group) => [group.upstreamProvider, group.identityStrength, group.observationCount]))
      .toEqual([["Anthropic", "observed_model", 1], [null, "requested_only", 2]]);
  });

  it("binds the v2 evaluator identity: every evaluator kind, with digests recomputed from it", () => {
    const protocols = (["complete", "repeated", "incomplete"] as const).map((name) => {
      const artifact = verifyBinaryCalibrationV2Artifact(fixture(name));
      expect(artifact.evaluator.skillDigest, name).toBe(skillDigestV2FromInput(artifact.evaluator.identity));
      expect(artifact.evaluator.requestedBindingDigest, name).toBe(sha256Digest(artifact.evaluator.identity.executionBinding));
      return artifact.evaluator.identity.executionBinding.verdictProtocol;
    });
    expect(protocols).toEqual(["anthropic.structured-output/v1", "typed-question/v1", "openai.structured-output/v1"]);
    expect(JSON.stringify(fixture("complete"))).not.toContain("rubricMarkdown");
  });

  it("treats an exposed or ineligible completion recheck as incomplete evidence", () => {
    const artifact = structuredClone(fixture());
    artifact.exposure.completion.state = "exposed";
    artifact.exposure.completion.eligibility = {
      result: "ineligible",
      reasons: ["authorization_snapshot_changed"]
    };
    artifact.status = "incomplete";
    artifact.incompleteReasons = ["completion_exposure_exposed", "completion_exposure_ineligible"];
    artifact.evidenceDigest = binaryCalibrationV2EvidenceDigest(artifact);
    expect(verifyBinaryCalibrationV2Artifact(artifact).incompleteReasons).toEqual(artifact.incompleteReasons);
  });

  it("compares every consumer identity binding, including suite and completion snapshot", () => {
    const artifact = fixture();
    const expected = expectedFrom(artifact);
    for (const key of [
      "criterionId",
      "criterionVersionId",
      "criterionDigest",
      "skillId",
      "skillVersionId",
      "skillDigest",
      "outputContractDigest",
      "requestedBindingDigest",
      "contentDigest",
      "drawDigest",
      "selectionMethod",
      "exposureCompletionSnapshotDigest",
      "exposureCompletionState",
      "providerDataHandlingPolicyDigest",
      "positiveClass",
      "trialPlanKind",
      "suiteManifestId",
      "suiteManifestDigest",
      "suiteMemberPosition"
    ] as const) {
      const changed = { ...expected, [key]: typeof expected[key] === "number" ? 99 : "different" };
      expect(() => verifyBinaryCalibrationV2Artifact(artifact, changed), key).toThrow(`${key} mismatch`);
    }
  });

  it("pins Wilson v1 operation order and boundary special cases", () => {
    const vectors = [
      [0, 1, "0000000000000000", "3fe963f2b137a224"],
      [1, 1, "3fca70353b21776f", "3ff0000000000000"],
      [1, 10, "3f924e245a7a897b", "3fd9dd9812f0d630"],
      [5, 10, "3fce48aeb11b0309", "3fe86dd453b93f3e"],
      [9, 10, "3fe31133f68794e8", "3fef6d8edd2c2bb4"],
      [50, 100, "3fd9d8603400ff4c", "3fe313cfe5ff805a"],
      [95, 100, "3fec6c8a47aac295", "3fef4f83a153164e"],
      [4999, 5000, "3feff6b9d64d7e07", "3fefffb5f55a1295"],
      [5000, 5000, "3feff9b6032817ca", "3ff0000000000000"],
      [0, 5000, "0000000000000000", "3f4927f35fa0d6f6"],
      [2500, 5000, "3fdf1d054c31143a", "3fe0717d59e775e3"],
      [1, 2, "3fb83332751478d2", "3fecf999b15d70e6"],
      [1, 4, "3fa75736a4957224", "3fe661245bc994b7"],
      [3, 8, "3fc1841d1220dfb6", "3fe6375bb9c5caa9"],
      [1, 1024, "3f26990e01be86b6", "3f769283d80c32d2"],
      [1, 4096, "3f069887f6ba4b06", "3f56a34855e6bc81"]
    ] as const;
    for (const [x, n, lowerBinary64, upperBinary64] of vectors) {
      expect(wilson95Binary64Bounds(x, n), `${x}/${n}`).toEqual({ lowerBinary64, upperBinary64 });
    }
    expect(() => wilson95Binary64Bounds(0, 0)).toThrow("undefined");
  });

  it("cross-checks Wilson bits with the independent Python reference", () => {
    const script = new URL("reference/binary-calibration-wilson-v1.py", contractRoot);
    const reference = JSON.parse(execFileSync("python3", [script.pathname], { encoding: "utf8" })) as Array<{
      x: number;
      n: number;
      lowerBinary64: string;
      upperBinary64: string;
    }>;
    for (const { x, n, lowerBinary64, upperBinary64 } of reference) {
      expect(wilson95Binary64Bounds(x, n), `${x}/${n}`).toEqual({ lowerBinary64, upperBinary64 });
    }
  });

  it("allows exact F1 components through 10,000 and rejects larger components", () => {
    expect(BinaryCalibrationV2ExactRateSchema.safeParse({ state: "defined", numerator: 10_000, denominator: 10_000 }).success).toBe(true);
    expect(BinaryCalibrationV2ExactRateSchema.safeParse({ state: "defined", numerator: 10_001, denominator: 10_001 }).success).toBe(false);
  });

  it("accepts only exact canonical UTF-8 bytes and bounds untrusted input", () => {
    const artifact = fixture();
    const canonical = canonicalBinaryCalibrationV2ArtifactBytes(artifact);
    expect(parseCanonicalBinaryCalibrationV2ArtifactBytes(canonical)).toEqual(artifact);
    expect(parseCanonicalBinaryCalibrationV2ArtifactBytes(fileBytes("fixtures/binary-calibration-v2.complete.json"))).toEqual(artifact);
    expect(() => parseCanonicalBinaryCalibrationV2ArtifactBytes(Buffer.concat([canonical, Buffer.from("\n")])))
      .toThrow("not exact canonical JSON");
    expect(() => parseCanonicalBinaryCalibrationV2ArtifactBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical])))
      .toThrow("must not begin with a UTF-8 BOM");
    expect(() => parseCanonicalBinaryCalibrationV2ArtifactBytes(Uint8Array.from([0xff])))
      .toThrow("not valid UTF-8");
    expect(() => parseCanonicalBinaryCalibrationV2ArtifactBytes(Buffer.alloc(BINARY_CALIBRATION_V2_MAX_CANONICAL_BYTES + 1)))
      .toThrow("exceeds");
  });

  it("rejects lone surrogates, negative zero, and overlong public strings", () => {
    const loneValue = structuredClone(fixture());
    loneValue.artifactId = "\ud800";
    expect(() => verifyBinaryCalibrationV2Artifact(loneValue)).toThrow("Unicode scalar values");

    const loneKey = structuredClone(fixture()) as BinaryCalibrationV2Artifact & Record<string, unknown>;
    loneKey["\udfff"] = true;
    expect(() => verifyBinaryCalibrationV2Artifact(loneKey)).toThrow("Unicode scalar values");

    const negativeZero = structuredClone(fixture());
    negativeZero.trials[0]!.outcomes.providerCalls = -0;
    expect(() => verifyBinaryCalibrationV2Artifact(negativeZero)).toThrow("negative zero");

    const longString = structuredClone(fixture());
    longString.artifactId = "x".repeat(4097);
    expect(BinaryCalibrationV2ArtifactSchema.safeParse(longString).success).toBe(false);
    expect(() => verifyBinaryCalibrationV2Artifact(longString)).toThrow("exceeds 4096");
  });

  it("pins UTF-16 key order and preserves normalization distinctions", () => {
    expect(canonicalJson({ "\ue000": 3, "😀": 2, "\ud7ff": 1 })).toBe('{"퟿":1,"😀":2,"":3}');
    expect(canonicalJson({ "é": 1, "e\u0301": 2 })).toBe('{"é":2,"é":1}');
  });

  it("keeps the public artifact aggregate-only and policy-free", () => {
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
      loadJson("binary-calibration-v2.schema.json") as object
    );
    for (const field of [
      "itemId", "truthLabel", "payload", "rationale", "requestId", "responseId",
      "observationDigest", "threshold", "weight", "mandatory", "releaseDecision", "override"
    ]) {
      const candidate = { ...structuredClone(fixture()), [field]: "forbidden" };
      expect(validate(candidate), field).toBe(false);
      expect(BinaryCalibrationV2ArtifactSchema.safeParse(candidate).success, field).toBe(false);
    }
  });
});
