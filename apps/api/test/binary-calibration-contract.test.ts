import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  BinaryCalibrationArtifactSchema,
  BinaryCalibrationExactRateSchema,
  BinaryCalibrationPrivateLedgerSchema,
  type BinaryCalibrationArtifact,
  type BinaryCalibrationPrivateLedger
} from "@coeval/shared";
import { canonicalJson } from "../src/lib/assessment-receipt.js";
import {
  BINARY_CALIBRATION_MAX_CANONICAL_BYTES,
  binaryCalibrationEvidenceDigest,
  binaryCalibrationPrivateLedgerCommitmentDigest,
  canonicalBinaryCalibrationArtifactBytes,
  canonicalBinaryCalibrationPrivateLedgerBytes,
  parseCanonicalBinaryCalibrationArtifactBytes,
  verifyBinaryCalibrationArtifact,
  verifyBinaryCalibrationPrivateLedger,
  verifyBinaryCalibrationPrivateLedgerForArtifact,
  wilson95Binary64Bounds,
  type ExpectedBinaryCalibrationArtifact
} from "../src/lib/binary-calibration.js";

type Mutation =
  | { op: "add" | "replace"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "copy"; from: string; path: string }
  | { op: "reverse"; path: string }
  | { op: "recompute-evidence-digest" };

interface ConformanceCase {
  name: string;
  baseFixture?: "binary-calibration-v1.complete.json" | "binary-calibration-v1.repeated.json" | "binary-calibration-v1.incomplete.json";
  structural: "accept" | "reject";
  semantic: "accept" | "reject" | "not-run";
  errorIncludes?: string;
  expectedOverrides?: Partial<ExpectedBinaryCalibrationArtifact>;
  mutations: Mutation[];
}

interface ConformanceCorpus {
  contract: "coeval/binary-calibration/v1";
  baseFixture: string;
  expectedIdentityByFixture: Record<string, ExpectedBinaryCalibrationArtifact>;
  cases: ConformanceCase[];
}

const contractRoot = new URL("../../../contracts/", import.meta.url);
const pinnedFileDigests = {
  schema: "fc671a8dbac5f4d7599667f85931283304071135058021a5df4b9f0a5ddd9686",
  specification: "340816ebfe0b7b591776ba2f0b8a1bea80380980a2ce90261f4772d16c93b370",
  completeFixture: "61a5a2b5abeb3303c209d1a9bd32352ec094b77190b3b139fcf8f6b76f010c4f",
  repeatedFixture: "a4ebaa3036c3bc9e1e868b3a2a8eee3ca828db3ed67006dc6daab98e25a3f53c",
  incompleteFixture: "b4bf55752831c5a9a7a237654a0b92a32137790b5ea270ccda02c56f9a9c633f",
  conformance: "07636d660500f693f2c160d2d09e2a43a4699e243bfe44918e0c9ec357fb97e4",
  wilsonReference: "bdf28e4ecd43a64fb51890dcf2414820fd820aaad422caa51190f9ff1a080c71",
  privateLedgerSchema: "26f4ac08590752c14af8dbc02fb906a4447e2b4ee63d12bf1c60ab6b9043d544",
  privateLedgerFixture: "725f1f3257d56a9ea77af97e399f3dda14de9ef1f6faedf5298951b4cfcd637e"
} as const;

const frozenReceiptV1FileDigests = {
  schema: "ca18a7b3bfa4610ff56ab88d60044f4357df2d035ac5e072356becc20250e9e7",
  specification: "85c4a502709a4a6a8c27b96634262fa2b583bbafce98558c99de475528df8802",
  fixture: "530e7322feb5bc16d025daaef14bec8d73488a168a602d82b37fae2a06d12274",
  conformance: "9a9ba86d54e78a6cc8d63d592712791f21984e68f09bbbe011d8903296af3e07"
} as const;

const frozenSuiteV1FileDigests = {
  schema: "d9510a027313659f0fe11f8dc300874a9b106c57ca08f7cf168d90839bd60b26",
  specification: "6f0982d3e2b8da38b54fb4d91dab2a92340799b4cd406f29e0698264dd1a43e8",
  fixture: "64fcd11e94f209015914294bb9f6ef33ee3e1fb4766c3081e0a58f69eed785ae",
  conformance: "d09392d37c255fcf05361fbe8b7e78ec4306af876352d9b8a05dd621ae0d2458"
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

function fixture(name: "complete" | "repeated" | "incomplete" = "complete"): BinaryCalibrationArtifact {
  return loadJson(`fixtures/binary-calibration-v1.${name}.json`) as BinaryCalibrationArtifact;
}

function corpus(): ConformanceCorpus {
  return loadJson("fixtures/binary-calibration-v1.conformance.json") as ConformanceCorpus;
}

function expectedFrom(artifact: BinaryCalibrationArtifact): ExpectedBinaryCalibrationArtifact {
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
    requestedBindingDigest: artifact.evaluator.requestedModelBinding.requestedBindingDigest,
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
    artifact.evidenceDigest = binaryCalibrationEvidenceDigest(artifact as unknown as BinaryCalibrationArtifact);
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

function materialize(base: BinaryCalibrationArtifact, testCase: ConformanceCase): unknown {
  const artifact = structuredClone(base) as unknown as Record<string, unknown>;
  for (const mutation of testCase.mutations) applyMutation(artifact, mutation);
  return artifact;
}

function caseBase(testCase: ConformanceCase, conformance: ConformanceCorpus): BinaryCalibrationArtifact {
  return loadJson(`fixtures/${testCase.baseFixture ?? conformance.baseFixture}`) as BinaryCalibrationArtifact;
}

function expectedForCase(
  testCase: ConformanceCase,
  conformance: ConformanceCorpus
): ExpectedBinaryCalibrationArtifact {
  const name = testCase.baseFixture ?? conformance.baseFixture;
  const base = conformance.expectedIdentityByFixture[name];
  if (!base) throw new Error(`missing portable expected identity for ${name}`);
  return { ...base, ...testCase.expectedOverrides };
}

describe("binary calibration artifact v1 contract", () => {
  it("pins the schema, specification, immutable fixtures, and adversarial corpus", () => {
    expect(fileDigest("binary-calibration-v1.schema.json")).toBe(pinnedFileDigests.schema);
    expect(fileDigest("binary-calibration-v1.md")).toBe(pinnedFileDigests.specification);
    expect(fileDigest("fixtures/binary-calibration-v1.complete.json")).toBe(pinnedFileDigests.completeFixture);
    expect(fileDigest("fixtures/binary-calibration-v1.repeated.json")).toBe(pinnedFileDigests.repeatedFixture);
    expect(fileDigest("fixtures/binary-calibration-v1.incomplete.json")).toBe(pinnedFileDigests.incompleteFixture);
    expect(fileDigest("fixtures/binary-calibration-v1.conformance.json")).toBe(pinnedFileDigests.conformance);
    expect(fileDigest("reference/binary-calibration-wilson-v1.py")).toBe(pinnedFileDigests.wilsonReference);
  });

  it("keeps receipt v1 and suite manifest v1 bytes unchanged", () => {
    expect(fileDigest("assessment-receipt-v1.schema.json")).toBe(frozenReceiptV1FileDigests.schema);
    expect(fileDigest("assessment-receipt-v1.md")).toBe(frozenReceiptV1FileDigests.specification);
    expect(fileDigest("fixtures/assessment-receipt-v1.complete.json")).toBe(frozenReceiptV1FileDigests.fixture);
    expect(fileDigest("fixtures/assessment-receipt-v1.conformance.json")).toBe(frozenReceiptV1FileDigests.conformance);
    expect(fileDigest("evaluator-suite-manifest-v1.schema.json")).toBe(frozenSuiteV1FileDigests.schema);
    expect(fileDigest("evaluator-suite-manifest-v1.md")).toBe(frozenSuiteV1FileDigests.specification);
    expect(fileDigest("fixtures/evaluator-suite-manifest-v1.complete.json")).toBe(frozenSuiteV1FileDigests.fixture);
    expect(fileDigest("fixtures/evaluator-suite-manifest-v1.conformance.json")).toBe(frozenSuiteV1FileDigests.conformance);
  });

  it("pins and verifies the private-ledger commitment without adding a read surface", () => {
    expect(fileDigest("binary-calibration-private-ledger-v1.schema.json")).toBe(pinnedFileDigests.privateLedgerSchema);
    expect(fileDigest("fixtures/binary-calibration-private-ledger-v1.complete.json")).toBe(pinnedFileDigests.privateLedgerFixture);
    const schema = loadJson("binary-calibration-private-ledger-v1.schema.json") as object;
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
    const ledger = loadJson("fixtures/binary-calibration-private-ledger-v1.complete.json") as BinaryCalibrationPrivateLedger;
    expect(validate(ledger)).toBe(true);
    expect(BinaryCalibrationPrivateLedgerSchema.safeParse(ledger).success).toBe(true);
    expect(verifyBinaryCalibrationPrivateLedger(ledger)).toEqual(ledger);
    expect(canonicalBinaryCalibrationPrivateLedgerBytes(ledger)).toEqual(
      fileBytes("fixtures/binary-calibration-private-ledger-v1.complete.json")
    );
    expect(binaryCalibrationPrivateLedgerCommitmentDigest(ledger)).toBe(fixture().privateLedger.commitmentDigest);
    expect(verifyBinaryCalibrationPrivateLedgerForArtifact(ledger, fixture())).toEqual({
      ledger,
      artifact: fixture()
    });

    const providerSwap = structuredClone(ledger);
    providerSwap.records[0]!.providerObservation.provider = "other-provider";
    expect(() => verifyBinaryCalibrationPrivateLedger(providerSwap)).toThrow("does not match requestedProvider");
    const duplicateSalt = structuredClone(ledger);
    duplicateSalt.records[1]!.commitmentSalt = duplicateSalt.records[0]!.commitmentSalt;
    expect(() => verifyBinaryCalibrationPrivateLedger(duplicateSalt)).toThrow("salts must be unique");
    const badAttempt = structuredClone(ledger);
    badAttempt.records[0]!.attemptState = "started";
    expect(() => verifyBinaryCalibrationPrivateLedger(badAttempt)).toThrow("attemptState must be terminal");
    const classifiedWithoutCall = structuredClone(ledger);
    classifiedWithoutCall.records[0]!.physicalProviderCalls = 0;
    expect(() => verifyBinaryCalibrationPrivateLedger(classifiedWithoutCall)).toThrow("observed identity requires a physical provider call");
    const unevaluatedWithCall = structuredClone(ledger);
    unevaluatedWithCall.records[1]!.terminalEvaluatorOutcome = "unevaluated";
    unevaluatedWithCall.records[1]!.attemptState = "not_started";
    expect(() => verifyBinaryCalibrationPrivateLedger(unevaluatedWithCall)).toThrow("unevaluated attempt must have zero calls");
    const unknownWithoutCall = structuredClone(ledger);
    unknownWithoutCall.records[0]!.terminalEvaluatorOutcome = "errored";
    unknownWithoutCall.records[0]!.attemptState = "started";
    unknownWithoutCall.records[0]!.errorCode = "outcome_unknown";
    unknownWithoutCall.records[0]!.physicalProviderCalls = 0;
    unknownWithoutCall.records[0]!.providerObservation.observedModel = null;
    expect(() => verifyBinaryCalibrationPrivateLedger(unknownWithoutCall)).toThrow("outcome_unknown requires a physical provider call");
  });

  it("keeps JSON Schema and strict Zod structural decisions aligned", () => {
    const schema = loadJson("binary-calibration-v1.schema.json") as object;
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
    const conformance = corpus();
    for (const testCase of conformance.cases) {
      const raw = materialize(caseBase(testCase, conformance), testCase);
      const expected = testCase.structural === "accept";
      expect(validate(raw), `JSON Schema: ${testCase.name}`).toBe(expected);
      expect(BinaryCalibrationArtifactSchema.safeParse(raw).success, `Zod: ${testCase.name}`).toBe(expected);
    }
  });

  it("pins portable expected identity for every corpus base fixture", () => {
    const conformance = corpus();
    for (const [name, expected] of Object.entries(conformance.expectedIdentityByFixture)) {
      const artifact = loadJson(`fixtures/${name}`) as BinaryCalibrationArtifact;
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
      const verify = () => verifyBinaryCalibrationArtifact(raw, expected);
      if (testCase.semantic === "accept") expect(verify, testCase.name).not.toThrow();
      else expect(verify, testCase.name).toThrow(testCase.errorIncludes);
    }
  });

  it("verifies complete, repeated, and outcome_unknown incomplete evidence", () => {
    const complete = verifyBinaryCalibrationArtifact(fixture("complete"));
    expect(complete.status).toBe("complete");
    expect(complete.trials[0]?.outcomes.abstained).toBe(1);
    expect(complete.trials[0]?.metrics.classifiedCoverage.overall).toMatchObject({ numerator: 1, denominator: 2 });

    const repeated = verifyBinaryCalibrationArtifact(fixture("repeated"));
    expect(repeated.status).toBe("complete");
    expect(repeated.trials).toHaveLength(2);
    expect(repeated.trials.map((trial) => trial.metrics.accuracy.numerator)).toEqual([2, 0]);
    expect(repeated.trials[1]?.outcomes.providerCalls).toBe(3);
    expect(repeated.trials[1]?.providerIdentityGroups.map((group) => group.observationCount)).toEqual([1, 1]);

    const incomplete = verifyBinaryCalibrationArtifact(fixture("incomplete"));
    expect(incomplete.status).toBe("incomplete");
    expect(incomplete.incompleteReasons).toEqual(["trial_incomplete"]);
    expect(incomplete.trials[0]?.outcomes.errors).toEqual([{ code: "outcome_unknown", count: 1 }]);
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
    artifact.evidenceDigest = binaryCalibrationEvidenceDigest(artifact);
    expect(verifyBinaryCalibrationArtifact(artifact).incompleteReasons).toEqual(artifact.incompleteReasons);
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
      expect(() => verifyBinaryCalibrationArtifact(artifact, changed), key).toThrow(`${key} mismatch`);
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
    expect(BinaryCalibrationExactRateSchema.safeParse({ state: "defined", numerator: 10_000, denominator: 10_000 }).success).toBe(true);
    expect(BinaryCalibrationExactRateSchema.safeParse({ state: "defined", numerator: 10_001, denominator: 10_001 }).success).toBe(false);
  });

  it("accepts only exact canonical UTF-8 bytes and bounds untrusted input", () => {
    const artifact = fixture();
    const canonical = canonicalBinaryCalibrationArtifactBytes(artifact);
    expect(parseCanonicalBinaryCalibrationArtifactBytes(canonical)).toEqual(artifact);
    expect(parseCanonicalBinaryCalibrationArtifactBytes(fileBytes("fixtures/binary-calibration-v1.complete.json"))).toEqual(artifact);
    expect(() => parseCanonicalBinaryCalibrationArtifactBytes(Buffer.concat([canonical, Buffer.from("\n")])))
      .toThrow("not exact canonical JSON");
    expect(() => parseCanonicalBinaryCalibrationArtifactBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical])))
      .toThrow("must not begin with a UTF-8 BOM");
    expect(() => parseCanonicalBinaryCalibrationArtifactBytes(Uint8Array.from([0xff])))
      .toThrow("not valid UTF-8");
    expect(() => parseCanonicalBinaryCalibrationArtifactBytes(Buffer.alloc(BINARY_CALIBRATION_MAX_CANONICAL_BYTES + 1)))
      .toThrow("exceeds");
  });

  it("rejects lone surrogates, negative zero, and overlong public strings", () => {
    const loneValue = structuredClone(fixture());
    loneValue.artifactId = "\ud800";
    expect(() => verifyBinaryCalibrationArtifact(loneValue)).toThrow("Unicode scalar values");

    const loneKey = structuredClone(fixture()) as BinaryCalibrationArtifact & Record<string, unknown>;
    loneKey["\udfff"] = true;
    expect(() => verifyBinaryCalibrationArtifact(loneKey)).toThrow("Unicode scalar values");

    const negativeZero = structuredClone(fixture());
    negativeZero.trials[0]!.outcomes.providerCalls = -0;
    expect(() => verifyBinaryCalibrationArtifact(negativeZero)).toThrow("negative zero");

    const longString = structuredClone(fixture());
    longString.artifactId = "x".repeat(4097);
    expect(BinaryCalibrationArtifactSchema.safeParse(longString).success).toBe(false);
    expect(() => verifyBinaryCalibrationArtifact(longString)).toThrow("exceeds 4096");
  });

  it("pins UTF-16 key order and preserves normalization distinctions", () => {
    expect(canonicalJson({ "\ue000": 3, "😀": 2, "\ud7ff": 1 })).toBe('{"퟿":1,"😀":2,"":3}');
    expect(canonicalJson({ "é": 1, "e\u0301": 2 })).toBe('{"é":2,"é":1}');
  });

  it("keeps the public artifact aggregate-only and policy-free", () => {
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
      loadJson("binary-calibration-v1.schema.json") as object
    );
    for (const field of [
      "itemId", "truthLabel", "payload", "rationale", "requestId", "responseId",
      "observationDigest", "threshold", "weight", "mandatory", "releaseDecision", "override"
    ]) {
      const candidate = { ...structuredClone(fixture()), [field]: "forbidden" };
      expect(validate(candidate), field).toBe(false);
      expect(BinaryCalibrationArtifactSchema.safeParse(candidate).success, field).toBe(false);
    }
  });
});
