import { describe, expect, it } from "vitest";
import {
  DATASET_REVISION_ROLES,
  PUBLIC_DATASET_REVISION_ROLES,
  INPUT_IDENTITY_BASIS,
  PUBLIC_SEALED_REVISION_CREATION_AVAILABLE,
  SEMANTIC_NEAR_DUPLICATE_DETECTION,
  datasetInputIdentity,
  datasetRevisionDigest,
  datasetRevisionContentDigest,
  datasetRevisionItemDigest,
  decideDatasetRoleCompatibility,
  decidePublicDatasetRevisionCreation,
  type DatasetRevisionRole
} from "../src/lib/dataset-revision.js";

const NONSEALED_ROLES: DatasetRevisionRole[] = [
  "analysis_authoring",
  "iterative_development",
  "regression_golden"
];

function item(overrides: Partial<Parameters<typeof datasetRevisionItemDigest>[0]> = {}) {
  return {
    inputIdentity: datasetInputIdentity({ input: { prompt: "refund", tenant: 7 } }),
    redactedPayload: {
      input: { prompt: "refund", tenant: "[REDACTED]" },
      output: { answer: "Within 30 days" },
      metadata: { provider: "fixture" },
      steps: [{ name: "lookup", input: { id: "[REDACTED]" }, output: { found: true } }]
    },
    referenceLabel: "pass",
    expectedFailStep: null,
    reviewProvenance: { source: "native_review", reviewerIds: ["reviewer_1"], adjudicationId: null },
    note: "reviewed fixture",
    ...overrides
  };
}

describe("dataset revision exact input identity", () => {
  it("hashes only canonical pre-redaction top-level input", () => {
    const base = {
      input: { question: "Refund?", context: { account: 42 } },
      output: { answer: "yes" },
      steps: [{ output: "yes" }],
      metadata: { source: "one" },
      referenceLabel: "pass",
      note: "first"
    };
    const changedOutsideInput = {
      ...base,
      output: { answer: "no" },
      steps: [{ output: "no" }],
      metadata: { source: "two" },
      referenceLabel: "fail",
      note: "second"
    };

    expect(datasetInputIdentity(base)).toEqual(datasetInputIdentity(changedOutsideInput));
    expect(datasetInputIdentity(base)).toEqual({
      basis: INPUT_IDENTITY_BASIS,
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    });
  });

  it("is input-sensitive, object-key-order invariant, and array-order sensitive", () => {
    const ordered = datasetInputIdentity({
      input: { z: 3, nested: { y: 2, a: 1 }, array: ["a", "b"] }
    });
    const reorderedKeys = datasetInputIdentity({
      input: { array: ["a", "b"], nested: { a: 1, y: 2 }, z: 3 }
    });
    const changedInput = datasetInputIdentity({
      input: { array: ["a", "b"], nested: { a: 1, y: 9 }, z: 3 }
    });
    const reorderedArray = datasetInputIdentity({
      input: { array: ["b", "a"], nested: { a: 1, y: 2 }, z: 3 }
    });

    expect(ordered).toEqual(reorderedKeys);
    expect(ordered.digest).not.toBe(changedInput.digest);
    expect(ordered.digest).not.toBe(reorderedArray.digest);
  });

  it("states and preserves the Unicode non-normalization limitation", () => {
    const composed = datasetInputIdentity({ input: { text: "\u00e9" } });
    const decomposed = datasetInputIdentity({ input: { text: "e\u0301" } });

    expect(SEMANTIC_NEAR_DUPLICATE_DETECTION).toBe("unsupported");
    expect(composed.digest).not.toBe(decomposed.digest);
  });
});

describe("dataset revision content identity", () => {
  it("is deterministic and changes for every frozen item evidence class", () => {
    const original = datasetRevisionItemDigest(item());
    const equivalent = datasetRevisionItemDigest(item({
      redactedPayload: {
        steps: [{ output: { found: true }, input: { id: "[REDACTED]" }, name: "lookup" }],
        metadata: { provider: "fixture" },
        output: { answer: "Within 30 days" },
        input: { tenant: "[REDACTED]", prompt: "refund" }
      },
      reviewProvenance: { adjudicationId: null, reviewerIds: ["reviewer_1"], source: "native_review" }
    }));

    expect(equivalent).toBe(original);
    expect(datasetRevisionItemDigest(item({
      inputIdentity: datasetInputIdentity({ input: { prompt: "different", tenant: 7 } })
    }))).not.toBe(original);
    expect(datasetRevisionItemDigest(item({
      redactedPayload: { ...item().redactedPayload as object, output: { answer: "tampered" } }
    }))).not.toBe(original);
    expect(datasetRevisionItemDigest(item({ referenceLabel: "fail" }))).not.toBe(original);
    expect(datasetRevisionItemDigest(item({ expectedFailStep: 0 }))).not.toBe(original);
    expect(datasetRevisionItemDigest(item({ note: "changed note" }))).not.toBe(original);
    expect(datasetRevisionItemDigest(item({
      reviewProvenance: { source: "native_review", reviewerIds: ["reviewer_2"], adjudicationId: null }
    }))).not.toBe(original);
  });

  it("orders item digests deterministically, retains duplicates, and excludes row identity, timestamps, and lineage", () => {
    const first = datasetRevisionItemDigest(item());
    const second = datasetRevisionItemDigest(item({ referenceLabel: "fail" }));
    const root = datasetRevisionDigest({
      role: "regression_golden",
      itemDigests: [first, second],
      revisionId: "revision_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      parentRevisionId: null
    });
    const operationallyDifferent = datasetRevisionDigest({
      role: "regression_golden",
      itemDigests: [second, first],
      revisionId: "revision_2",
      createdAt: "2027-01-01T00:00:00.000Z",
      parentRevisionId: "revision_1"
    });

    expect(root).toBe(operationallyDifferent);
    expect(root).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(datasetRevisionDigest({ role: "analysis_authoring", itemDigests: [first, second] })).not.toBe(root);
    expect(datasetRevisionDigest({ role: "regression_golden", itemDigests: [first, first, second] })).not.toBe(root);
    expect(datasetRevisionDigest({ role: "regression_golden", itemDigests: [first] })).not.toBe(root);
    expect(datasetRevisionContentDigest([first, second])).toBe(datasetRevisionContentDigest([second, first]));
    expect(datasetRevisionContentDigest([first])).not.toBe(datasetRevisionContentDigest([first, second]));
  });

  it("fails closed for malformed digest inputs", () => {
    expect(() => datasetRevisionItemDigest(item({
      inputIdentity: { basis: "input-identity/v1", digest: "sha256:ABC" }
    }))).toThrow(/Invalid dataset input identity digest/);
    expect(() => datasetRevisionItemDigest(item({ expectedFailStep: -1 }))).toThrow(/expectedFailStep/);
    expect(() => datasetRevisionItemDigest(item({ referenceLabel: undefined }))).toThrow(/referenceLabel/);
    expect(() => datasetRevisionItemDigest(item({ note: undefined }))).toThrow(/note/);
    expect(() => datasetRevisionItemDigest(item({ note: 7 }))).toThrow(/note/);
    expect(() => datasetRevisionDigest({
      role: "regression_golden",
      itemDigests: ["not-a-digest"]
    })).toThrow(/Invalid dataset revision item digest/);
    expect(() => datasetRevisionDigest({
      role: "future_role" as DatasetRevisionRole,
      itemDigests: []
    })).toThrow(/Unknown dataset revision role/);
  });
});

describe("directional dataset-role compatibility", () => {
  it("covers the exhaustive 4 x 4 role matrix", () => {
    const results = DATASET_REVISION_ROLES.flatMap((fromRole) =>
      DATASET_REVISION_ROLES.map((toRole) => {
        const decision = decideDatasetRoleCompatibility({
          fromRole,
          toRole,
          sourceSealedExposureState: "protected_unexposed",
          explicitDeclassification: false,
          sourceIsDirectParent: true,
          sourceAlreadyHasSealedSuccessor: false
        });
        return [`${fromRole}->${toRole}`, decision.allowed, decision.code] as const;
      })
    );

    expect(results).toEqual([
      ["analysis_authoring->analysis_authoring", true, "allowed_nonsealed_overlap"],
      ["analysis_authoring->iterative_development", true, "allowed_nonsealed_overlap"],
      ["analysis_authoring->sealed_validation", false, "rejected_nonsealed_to_sealed"],
      ["analysis_authoring->regression_golden", true, "allowed_nonsealed_overlap"],
      ["iterative_development->analysis_authoring", true, "allowed_nonsealed_overlap"],
      ["iterative_development->iterative_development", true, "allowed_nonsealed_overlap"],
      ["iterative_development->sealed_validation", false, "rejected_nonsealed_to_sealed"],
      ["iterative_development->regression_golden", true, "allowed_nonsealed_overlap"],
      ["sealed_validation->analysis_authoring", false, "rejected_explicit_declassification_required"],
      ["sealed_validation->iterative_development", false, "rejected_explicit_declassification_required"],
      ["sealed_validation->sealed_validation", true, "allowed_direct_sealed_successor"],
      ["sealed_validation->regression_golden", false, "rejected_explicit_declassification_required"],
      ["regression_golden->analysis_authoring", true, "allowed_nonsealed_overlap"],
      ["regression_golden->iterative_development", true, "allowed_nonsealed_overlap"],
      ["regression_golden->sealed_validation", false, "rejected_nonsealed_to_sealed"],
      ["regression_golden->regression_golden", true, "allowed_nonsealed_overlap"]
    ]);
  });

  it.each(["protected_unexposed", "exposed"] as const)(
    "allows explicit sealed-to-nonsealed declassification from %s state",
    (sourceSealedExposureState) => {
      for (const toRole of NONSEALED_ROLES) {
        expect(decideDatasetRoleCompatibility({
          fromRole: "sealed_validation",
          toRole,
          sourceSealedExposureState,
          explicitDeclassification: true
        })).toEqual({ allowed: true, code: "allowed_explicit_declassification" });
      }
    }
  );

  it("allows only a direct, protected, unexposed, nonbranching sealed successor", () => {
    const base = {
      fromRole: "sealed_validation",
      toRole: "sealed_validation",
      sourceSealedExposureState: "protected_unexposed",
      sourceIsDirectParent: true,
      sourceAlreadyHasSealedSuccessor: false
    } as const;

    expect(decideDatasetRoleCompatibility({ ...base, sourceSealedExposureState: "exposed" }))
      .toEqual({ allowed: false, code: "rejected_sealed_successor_source_exposed" });
    expect(decideDatasetRoleCompatibility({ ...base, sourceIsDirectParent: false }))
      .toEqual({ allowed: false, code: "rejected_sealed_successor_not_direct" });
    expect(decideDatasetRoleCompatibility({ ...base, sourceAlreadyHasSealedSuccessor: true }))
      .toEqual({ allowed: false, code: "rejected_sealed_successor_branch" });
  });

  it("fails closed for unknown roles, state, and transition facts", () => {
    expect(decideDatasetRoleCompatibility({ fromRole: "future_role", toRole: "analysis_authoring" }))
      .toEqual({ allowed: false, code: "rejected_unknown_role" });
    expect(decideDatasetRoleCompatibility({ fromRole: "sealed_validation", toRole: "analysis_authoring" }))
      .toEqual({ allowed: false, code: "rejected_unknown_sealed_exposure_state" });
    expect(decideDatasetRoleCompatibility({
      fromRole: "sealed_validation",
      toRole: "analysis_authoring",
      sourceSealedExposureState: "protected_unexposed",
      explicitDeclassification: "yes"
    })).toEqual({ allowed: false, code: "rejected_invalid_transition_context" });
    expect(decideDatasetRoleCompatibility({
      fromRole: "sealed_validation",
      toRole: "sealed_validation",
      sourceSealedExposureState: "protected_unexposed",
      sourceIsDirectParent: "yes",
      sourceAlreadyHasSealedSuccessor: false
    })).toEqual({ allowed: false, code: "rejected_invalid_transition_context" });
  });
});

describe("public revision creation", () => {
  it("allows only authoring/development freezes on the public collection path", () => {
    expect(PUBLIC_SEALED_REVISION_CREATION_AVAILABLE).toBe(false);
    expect(PUBLIC_DATASET_REVISION_ROLES).toEqual(["analysis_authoring", "iterative_development"]);
    expect(decidePublicDatasetRevisionCreation("sealed_validation"))
      .toEqual({ allowed: false, code: "rejected_public_sealed_creation_unavailable" });
    expect(decidePublicDatasetRevisionCreation("regression_golden"))
      .toEqual({ allowed: false, code: "rejected_public_regression_creation_unavailable" });
    for (const role of PUBLIC_DATASET_REVISION_ROLES) {
      expect(decidePublicDatasetRevisionCreation(role))
        .toEqual({ allowed: true, code: "allowed_public_nonsealed_creation" });
    }
    expect(decidePublicDatasetRevisionCreation("future_role"))
      .toEqual({ allowed: false, code: "rejected_unknown_role" });
  });
});
