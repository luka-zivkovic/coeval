import { createHash } from "node:crypto";
import {
  containsLoneUtf16Surrogate,
  EvaluatorSuiteManifestSchema,
  type CreateEvaluatorSuiteManifestInput,
  type EvaluatorSuiteManifest,
  type EvaluatorSuiteManifestMember,
  type EvaluatorSuiteTrialPlan,
  type SkillVersion
} from "@coeval/shared";
import {
  canonicalJson,
  sha256Digest,
  skillDigest
} from "./assessment-receipt.js";

export interface EvaluatorSuiteCriterionInput {
  criterionId: string;
  criterionVersionId: string;
  criterionName: string;
  criterionDefinition: string;
}

export interface EvaluatorSuiteManifestMemberInput extends EvaluatorSuiteCriterionInput {
  skillVersion: SkillVersion;
}

export interface BuildEvaluatorSuiteManifestInput {
  manifestId: string;
  suiteId: string;
  projectId: string;
  revision: number;
  members: EvaluatorSuiteManifestMemberInput[];
  trialPlan: EvaluatorSuiteTrialPlan | null;
}

export interface ExpectedEvaluatorSuiteManifest {
  manifestId: string;
  manifestDigest: string;
  members: EvaluatorSuiteManifestMember[];
}

export function evaluatorSuiteCriterionDigest(input: EvaluatorSuiteCriterionInput): string {
  return sha256Digest({
    criterionId: input.criterionId,
    criterionVersionId: input.criterionVersionId,
    criterionName: input.criterionName,
    criterionDefinition: input.criterionDefinition
  });
}

// This digest makes the output contract independently addressable in the
// suite manifest. The receipt-v1 skillDigest remains the frozen, broader
// evaluator digest and is deliberately computed by the existing helper.
export function evaluatorOutputContractDigest(version: Pick<
  SkillVersion,
  "outputSchema" | "verdictKind" | "scalarRange" | "categoricalChoiceScores"
>): string {
  return sha256Digest({
    outputSchema: version.outputSchema,
    verdictKind: version.verdictKind,
    scalarRange: version.scalarRange,
    categoricalChoiceScores: version.categoricalChoiceScores
  });
}

export function evaluatorSuiteManifestDigest(
  manifest: Omit<EvaluatorSuiteManifest, "manifestDigest"> | EvaluatorSuiteManifest
): string {
  const { manifestDigest: _excluded, ...unsigned } = manifest as EvaluatorSuiteManifest;
  return sha256Digest(unsigned);
}

/** SHA-256 over the exact canonical manifest bytes, including manifestDigest. */
export function evaluatorSuiteArtifactDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function evaluatorSuiteCreateRequestDigest(input: CreateEvaluatorSuiteManifestInput): string {
  return sha256Digest({
    suiteId: input.suiteId ?? null,
    members: input.members.map((member) => ({
      criterionVersionId: member.criterionVersionId,
      skillVersionId: member.skillVersionId
    })),
    trialPlan: input.trialPlan
  });
}

export function buildEvaluatorSuiteManifest(input: BuildEvaluatorSuiteManifestInput): EvaluatorSuiteManifest {
  const members: EvaluatorSuiteManifestMember[] = input.members.map((member, position) => ({
    position,
    criterionId: member.criterionId,
    criterionVersionId: member.criterionVersionId,
    criterionName: member.criterionName,
    criterionDefinition: member.criterionDefinition,
    criterionDigest: evaluatorSuiteCriterionDigest(member),
    skillId: member.skillVersion.skillId,
    skillVersionId: member.skillVersion.id,
    skillDigest: skillDigest(member.skillVersion),
    outputContractDigest: evaluatorOutputContractDigest(member.skillVersion),
    applicability: { kind: "all_items" }
  }));
  const unsigned = {
    contract: "coeval/evaluator-suite-manifest/v1" as const,
    schemaVersion: 1 as const,
    manifestId: input.manifestId,
    suiteId: input.suiteId,
    projectId: input.projectId,
    revision: input.revision,
    members,
    trialPlan: input.trialPlan
  };
  return verifyEvaluatorSuiteManifest({
    ...unsigned,
    manifestDigest: sha256Digest(unsigned)
  });
}

export function verifyEvaluatorSuiteManifest(
  raw: unknown,
  expected?: ExpectedEvaluatorSuiteManifest
): EvaluatorSuiteManifest {
  if (containsLoneUtf16Surrogate(raw)) {
    throw new Error("suite manifest strings must contain only valid Unicode scalar values");
  }
  const manifest = EvaluatorSuiteManifestSchema.parse(raw);

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
    const actual = evaluatorSuiteCriterionDigest(member);
    if (member.criterionDigest !== actual) {
      throw new Error(`suite manifest criterionDigest mismatch for ${member.criterionVersionId}`);
    }
  }

  if (manifest.manifestDigest !== evaluatorSuiteManifestDigest(manifest)) {
    throw new Error("suite manifest manifestDigest mismatch");
  }

  if (expected) verifyExpectedMembers(manifest, expected.members);
  if (expected && manifest.manifestId !== expected.manifestId) {
    throw new Error(`suite manifest manifestId mismatch: expected ${expected.manifestId}`);
  }
  if (expected && manifest.manifestDigest !== expected.manifestDigest) {
    throw new Error(`suite manifest identity digest mismatch: expected ${expected.manifestDigest}`);
  }

  return manifest;
}

export function canonicalEvaluatorSuiteManifestBytes(manifest: EvaluatorSuiteManifest): Buffer {
  return Buffer.from(canonicalJson(verifyEvaluatorSuiteManifest(manifest)), "utf8");
}

export function parseCanonicalEvaluatorSuiteManifestBytes(
  bytes: Uint8Array,
  expected?: ExpectedEvaluatorSuiteManifest
): EvaluatorSuiteManifest {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Evaluator suite manifest bytes are not valid UTF-8");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Evaluator suite manifest bytes are not valid JSON");
  }
  const manifest = EvaluatorSuiteManifestSchema.parse(raw);
  if (canonicalJson(manifest) !== text) {
    throw new Error("Evaluator suite manifest copy is not exact canonical JSON");
  }
  return verifyEvaluatorSuiteManifest(manifest, expected);
}

function assertUnique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`suite manifest ${field} values must be unique`);
  }
}

function verifyExpectedMembers(
  manifest: EvaluatorSuiteManifest,
  expectedMembers: EvaluatorSuiteManifestMember[]
): void {
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
