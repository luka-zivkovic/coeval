import {
  EVALUATOR_SUITE_MANIFEST_V2_CONTRACT,
  EvaluatorSuiteManifestV2Schema,
  type EvaluatorIdentity,
  type EvaluatorSuiteManifestV2,
  type EvaluatorSuiteManifestV2Member,
  type EvaluatorSuiteTrialPlan
} from "@rubrist/shared";
import { canonicalJson, sha256Digest } from "./assessment-receipt.js";
import { evaluatorOutputContractDigestV2, skillDigestV2 } from "./evaluator-identity.js";

// Evaluator suite manifest v2 (Rubrist ADR-0014 section 7;
// contracts/evaluator-suite-manifest-v2.md). Verification is v1's; members
// carry the v2 skillDigest and output-contract digest. Runtime emission moves
// here in 8D, when the v1 module is removed.

export interface EvaluatorSuiteCriterionV2Input {
  criterionId: string;
  criterionVersionId: string;
  criterionName: string;
  criterionDefinition: string;
}

export interface EvaluatorSuiteManifestV2MemberInput extends EvaluatorSuiteCriterionV2Input {
  skillId: string;
  skillVersionId: string;
  identity: EvaluatorIdentity;
}

export interface BuildEvaluatorSuiteManifestV2Input {
  manifestId: string;
  suiteId: string;
  projectId: string;
  revision: number;
  members: EvaluatorSuiteManifestV2MemberInput[];
  trialPlan: EvaluatorSuiteTrialPlan | null;
}

export interface ExpectedEvaluatorSuiteManifestV2 {
  manifestId: string;
  manifestDigest: string;
  members: EvaluatorSuiteManifestV2Member[];
}

export function evaluatorSuiteCriterionDigestV2(input: EvaluatorSuiteCriterionV2Input): string {
  return sha256Digest({
    criterionId: input.criterionId,
    criterionVersionId: input.criterionVersionId,
    criterionName: input.criterionName,
    criterionDefinition: input.criterionDefinition
  });
}

export function evaluatorSuiteManifestV2Digest(
  manifest: Omit<EvaluatorSuiteManifestV2, "manifestDigest"> | EvaluatorSuiteManifestV2
): string {
  const { manifestDigest: _excluded, ...unsigned } = manifest as EvaluatorSuiteManifestV2;
  return sha256Digest(unsigned);
}

export function buildEvaluatorSuiteManifestV2(input: BuildEvaluatorSuiteManifestV2Input): EvaluatorSuiteManifestV2 {
  const members: EvaluatorSuiteManifestV2Member[] = input.members.map((member, position) => ({
    position,
    criterionId: member.criterionId,
    criterionVersionId: member.criterionVersionId,
    criterionName: member.criterionName,
    criterionDefinition: member.criterionDefinition,
    criterionDigest: evaluatorSuiteCriterionDigestV2(member),
    skillId: member.skillId,
    skillVersionId: member.skillVersionId,
    skillDigest: skillDigestV2(member.identity),
    outputContractDigest: evaluatorOutputContractDigestV2(member.identity.definition),
    applicability: { kind: "all_items" }
  }));
  const unsigned = {
    contract: EVALUATOR_SUITE_MANIFEST_V2_CONTRACT,
    schemaVersion: 2 as const,
    manifestId: input.manifestId,
    suiteId: input.suiteId,
    projectId: input.projectId,
    revision: input.revision,
    members,
    trialPlan: input.trialPlan
  };
  return verifyEvaluatorSuiteManifestV2({ ...unsigned, manifestDigest: sha256Digest(unsigned) });
}

export function verifyEvaluatorSuiteManifestV2(
  raw: unknown,
  expected?: ExpectedEvaluatorSuiteManifestV2
): EvaluatorSuiteManifestV2 {
  const manifest = EvaluatorSuiteManifestV2Schema.parse(raw);
  for (const [index, member] of manifest.members.entries()) {
    if (member.position !== index) {
      throw new Error(`suite manifest members are not ordered by contiguous position at index ${index}`);
    }
    if (!member.criterionName.trim() || !member.criterionDefinition.trim()) {
      throw new Error(`suite manifest criterion text must not be blank at position ${index}`);
    }
  }
  assertUnique(manifest.members.map((member) => member.criterionId), "criterionId");
  assertUnique(manifest.members.map((member) => member.criterionVersionId), "criterionVersionId");
  assertUnique(manifest.members.map((member) => member.skillVersionId), "skillVersionId");
  for (const member of manifest.members) {
    if (member.criterionDigest !== evaluatorSuiteCriterionDigestV2(member)) {
      throw new Error(`suite manifest criterionDigest mismatch for ${member.criterionVersionId}`);
    }
  }
  if (manifest.manifestDigest !== evaluatorSuiteManifestV2Digest(manifest)) {
    throw new Error("suite manifest manifestDigest mismatch");
  }
  if (expected) {
    verifyExpectedMembers(manifest, expected.members);
    if (manifest.manifestId !== expected.manifestId) {
      throw new Error(`suite manifest manifestId mismatch: expected ${expected.manifestId}`);
    }
    if (manifest.manifestDigest !== expected.manifestDigest) {
      throw new Error(`suite manifest identity digest mismatch: expected ${expected.manifestDigest}`);
    }
  }
  return manifest;
}

export function canonicalEvaluatorSuiteManifestV2Bytes(manifest: EvaluatorSuiteManifestV2): Buffer {
  return Buffer.from(canonicalJson(verifyEvaluatorSuiteManifestV2(manifest)), "utf8");
}

export function parseCanonicalEvaluatorSuiteManifestV2Bytes(
  bytes: Uint8Array,
  expected?: ExpectedEvaluatorSuiteManifestV2
): EvaluatorSuiteManifestV2 {
  let text: string;
  try {
    // ignoreBOM keeps a leading byte-order mark, so such a copy fails the parse.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("Evaluator suite manifest bytes are not valid UTF-8");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Evaluator suite manifest bytes are not valid JSON");
  }
  const manifest = EvaluatorSuiteManifestV2Schema.parse(raw);
  if (canonicalJson(manifest) !== text) {
    throw new Error("Evaluator suite manifest copy is not exact canonical JSON");
  }
  return verifyEvaluatorSuiteManifestV2(manifest, expected);
}

function assertUnique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`suite manifest ${field} values must be unique`);
  }
}

function verifyExpectedMembers(manifest: EvaluatorSuiteManifestV2, expectedMembers: EvaluatorSuiteManifestV2Member[]): void {
  const expectedByCriterionId = new Map(expectedMembers.map((member) => [member.criterionId, member]));
  for (const member of manifest.members) {
    if (!expectedByCriterionId.has(member.criterionId)) {
      throw new Error(`suite manifest contains unknown criterion ${member.criterionId}`);
    }
  }
  if (manifest.members.length !== expectedMembers.length) {
    throw new Error("suite manifest does not have exact criterion coverage");
  }
  const candidateCriterionIds = manifest.members.map((member) => member.criterionId);
  const expectedCriterionIds = expectedMembers.map((member) => member.criterionId);
  if (candidateCriterionIds.some((id, index) => id !== expectedCriterionIds[index])) {
    throw new Error("suite manifest criterion order mismatch");
  }
  for (const [index, member] of manifest.members.entries()) {
    const expected = expectedMembers[index]!;
    if (member.criterionVersionId !== expected.criterionVersionId) {
      throw new Error(`suite manifest substituted criterion version at position ${index}`);
    }
    if (
      member.criterionName !== expected.criterionName ||
      member.criterionDefinition !== expected.criterionDefinition ||
      member.criterionDigest !== expected.criterionDigest
    ) {
      throw new Error(`suite manifest substituted criterion definition at position ${index}`);
    }
    if (
      member.skillId !== expected.skillId ||
      member.skillVersionId !== expected.skillVersionId ||
      member.skillDigest !== expected.skillDigest ||
      member.outputContractDigest !== expected.outputContractDigest
    ) {
      throw new Error(`suite manifest substituted evaluator at position ${index}`);
    }
    if (member.applicability.kind !== expected.applicability.kind) {
      throw new Error(`suite manifest substituted applicability at position ${index}`);
    }
  }
}
