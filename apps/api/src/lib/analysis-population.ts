import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ANALYSIS_POPULATION_CANONICALIZATION_VERSION,
  ANALYSIS_POPULATION_DRAW_ALGORITHM_VERSION,
  ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES,
  ANALYSIS_POPULATION_ELIGIBLE_SOURCES,
  ANALYSIS_POPULATION_MAX_FIXED_BUDGET,
  ANALYSIS_POPULATION_MAX_MEMBERS,
  ANALYSIS_POPULATION_MIN_WINDOW_LAG_SECONDS,
  ANALYSIS_POPULATION_ORDERING_VERSION,
  ANALYSIS_POPULATION_RNG_VERSION,
  AnalysisPopulationCreateInputSchema,
  DatasetRevisionPayloadSnapshotSchema,
  type AnalysisPopulationClaim,
  type AnalysisPopulationCreateInput,
  type AnalysisPopulationInclusionProbability,
  type DatasetRevisionPayloadSnapshot
} from "@coeval/shared";
import {
  DATASET_REVISION_ITEM_DIGEST_BASIS,
  INPUT_IDENTITY_BASIS,
  datasetRevisionItemDigest,
  type DatasetInputIdentity
} from "./dataset-revision.js";
import { canonicalGovernedJsonV1 } from "./governed-content-digest.js";

export const ANALYSIS_POPULATION_REQUEST_DIGEST_BASIS = "analysis-population-request/v1" as const;
export const ANALYSIS_POPULATION_FRAME_MEMBER_DIGEST_BASIS = "analysis-population-frame-member/v1" as const;
export const ANALYSIS_POPULATION_MEMBER_LINEAGE_DIGEST_BASIS = "analysis-population-member/v1" as const;
export const ANALYSIS_POPULATION_EXCLUSION_DIGEST_BASIS = "analysis-population-exclusion/v1" as const;
export const ANALYSIS_POPULATION_CONTENT_DIGEST_BASIS = "analysis-population-content/v1" as const;
export const ANALYSIS_POPULATION_FRAME_DIGEST_BASIS = "analysis-population-frame/v1" as const;
export const ANALYSIS_POPULATION_RANK_DIGEST_BASIS = "coeval-analysis-rank/v1" as const;
export const ANALYSIS_POPULATION_DRAW_ITEM_DIGEST_BASIS = "analysis-population-draw-item/v1" as const;
export const ANALYSIS_POPULATION_DRAW_CONTENT_DIGEST_BASIS = "analysis-population-draw-content/v1" as const;
export const ANALYSIS_POPULATION_REFERENCE_BASIS = "Analysis population member; no reference label." as const;
export const ANALYSIS_POPULATION_ITEM_DIGEST_BASIS = DATASET_REVISION_ITEM_DIGEST_BASIS;
export const ANALYSIS_POPULATION_INPUT_IDENTITY_BASIS = INPUT_IDENTITY_BASIS;

const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SEED_PATTERN = /^[a-f0-9]{64}$/;
const TimestampSchema = z.string().datetime({ offset: true });
const RFC3339_INSTANT_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.([0-9]+))?(Z|[+-]\d{2}:\d{2})$/;

export interface AnalysisPopulationRequestDigestInput {
  projectId: string;
  windowStart: string;
  windowEnd: string;
  fixedBudget: number;
}

export interface AnalysisPopulationItemDigestInput {
  caseId: string;
  inputIdentity: DatasetInputIdentity;
  payloadSnapshot: DatasetRevisionPayloadSnapshot;
}

export interface AnalysisPopulationFrameMemberDigestInput {
  caseId: string;
  inputDigest: string;
  itemDigest: string;
  ingestionTime: string;
  position: number;
}

export interface AnalysisPopulationMemberLineageDigestInput extends AnalysisPopulationFrameMemberDigestInput {
  revisionItemId: string;
}

interface AnalysisPopulationExclusionDigestBaseInput {
  caseId: string;
  ingestionTime: string;
  position: string;
  reason: "ineligible_ingestion_purpose";
}

export type AnalysisPopulationExclusionDigestInput = AnalysisPopulationExclusionDigestBaseInput & (
  | {
      rawTraceId: string;
      sourceTraceId: string;
      caseType: "manual";
      ingestionPurpose: "judge_api" | "judge_batch_general" | "dataset_example" | "trace_test_synthetic";
    }
  | {
      rawTraceId: string | null;
      sourceTraceId: string | null;
      caseType: "release_evidence";
      ingestionPurpose: "release_evidence";
    }
);

export interface AnalysisPopulationFrameDigestInput {
  projectId: string;
  windowStart: string;
  windowEnd: string;
  frameMemberDigests: readonly string[];
}

export interface AnalysisPopulationRankDigestInput {
  seed: string;
  caseId: string;
  frameMemberDigest: string;
}

export interface AnalysisPopulationDrawItemDigestInput {
  memberId: string;
  revisionItemId: string;
  caseId: string;
  frameMemberDigest: string;
  rankDigest: string;
  position: number;
}

export interface AnalysisPopulationDrawDigestInput {
  populationId: string;
  datasetRevisionId: string;
  frameDigest: string;
  contentDigest: string;
  seed: string;
  fixedBudget: number;
  populationSize: number;
  drawItemContentDigests: readonly string[];
}

export interface AnalysisPopulationRankableMember {
  memberId: string;
  revisionItemId: string;
  caseId: string;
  frameMemberDigest: string;
}

export interface AnalysisPopulationSampleSelection extends AnalysisPopulationRankableMember {
  rankDigest: string;
  position: number;
  contentDigest: string;
}

export interface AnalysisPopulationRankedMember extends AnalysisPopulationRankableMember {
  rankDigest: string;
}

export interface AnalysisPopulationDrawEvidence {
  method: "simple_random";
  stoppingRule: "fixed";
  drawExecutor: "coeval_server";
  seed: string;
  rngVersion: typeof ANALYSIS_POPULATION_RNG_VERSION;
  algorithmVersion: typeof ANALYSIS_POPULATION_DRAW_ALGORITHM_VERSION;
  fixedBudget: number;
  populationSize: number;
  inclusionProbability: AnalysisPopulationInclusionProbability;
  selections: readonly AnalysisPopulationSampleSelection[];
  contentDigest: string;
  drawDigest: string;
}

export type AnalysisPopulationBoundErrorCode =
  | "analysis_population_frame_empty"
  | "analysis_population_frame_too_large"
  | "analysis_population_budget_invalid"
  | "analysis_population_window_too_recent";

export class AnalysisPopulationBoundError extends Error {
  constructor(
    readonly code: AnalysisPopulationBoundErrorCode,
    readonly limit: number,
    readonly observed: number,
    message: string
  ) {
    super(message);
    this.name = "AnalysisPopulationBoundError";
  }
}

export type AnalysisPopulationFrameReuseDecision =
  | { kind: "reuse" }
  | {
      kind: "conflict";
      code: "analysis_population_draw_conflict";
      existingFixedBudget: number;
      requestedFixedBudget: number;
    };

/** SHA-256 over strict governed canonical JSON, with no raw-value coercion. */
export function analysisPopulationDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalGovernedJsonV1(value)).digest("hex")}`;
}

export function analysisPopulationRequestDigest(input: Readonly<AnalysisPopulationRequestDigestInput>): string {
  const request = AnalysisPopulationCreateInputSchema.parse({
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    fixedBudget: input.fixedBudget,
    idempotencyKey: "digest-only"
  });
  return analysisPopulationDigest({
    basis: ANALYSIS_POPULATION_REQUEST_DIGEST_BASIS,
    projectId: assertNonBlank(input.projectId, "projectId"),
    windowStart: normalizeAnalysisPopulationTimestamp(request.windowStart),
    windowEnd: normalizeAnalysisPopulationTimestamp(request.windowEnd),
    fixedBudget: request.fixedBudget
  });
}

export function analysisPopulationReferenceProvenance(caseId: string) {
  return Object.freeze({
    kind: "unlabeled" as const,
    sourceId: assertNonBlank(caseId, "caseId"),
    verdictIds: [] as string[],
    actorUserIds: [] as string[],
    basis: ANALYSIS_POPULATION_REFERENCE_BASIS
  });
}

/**
 * Build the exact analysis-authoring dataset item digest. Input identity is
 * pre-redaction evidence; payloadSnapshot must already be the retained,
 * redacted normalized payload.
 */
export function analysisPopulationItemDigest(input: Readonly<AnalysisPopulationItemDigestInput>): string {
  const payloadSnapshot = DatasetRevisionPayloadSnapshotSchema.parse(input.payloadSnapshot);
  // Validate the value under the same strict canonicalization PostgreSQL uses
  // before passing it into the existing dataset-revision digest contract.
  canonicalGovernedJsonV1(payloadSnapshot);
  return datasetRevisionItemDigest({
    inputIdentity: input.inputIdentity,
    redactedPayload: payloadSnapshot,
    referenceLabel: null,
    expectedFailStep: null,
    reviewProvenance: analysisPopulationReferenceProvenance(input.caseId),
    note: null
  });
}

export function analysisPopulationFrameMemberDigest(
  input: Readonly<AnalysisPopulationFrameMemberDigestInput>
): string {
  return analysisPopulationDigest({
    basis: ANALYSIS_POPULATION_FRAME_MEMBER_DIGEST_BASIS,
    caseId: assertNonBlank(input.caseId, "caseId"),
    inputDigest: assertSha256Digest(input.inputDigest, "inputDigest"),
    itemDigest: assertSha256Digest(input.itemDigest, "itemDigest"),
    ingestionTime: normalizeAnalysisPopulationTimestamp(input.ingestionTime),
    position: assertPosition(input.position, ANALYSIS_POPULATION_MAX_MEMBERS, "position")
  });
}

export function analysisPopulationMemberLineageDigest(
  input: Readonly<AnalysisPopulationMemberLineageDigestInput>
): string {
  return analysisPopulationDigest({
    basis: ANALYSIS_POPULATION_MEMBER_LINEAGE_DIGEST_BASIS,
    caseId: assertNonBlank(input.caseId, "caseId"),
    revisionItemId: assertNonBlank(input.revisionItemId, "revisionItemId"),
    inputDigest: assertSha256Digest(input.inputDigest, "inputDigest"),
    itemDigest: assertSha256Digest(input.itemDigest, "itemDigest"),
    ingestionTime: normalizeAnalysisPopulationTimestamp(input.ingestionTime),
    position: assertPosition(input.position, ANALYSIS_POPULATION_MAX_MEMBERS, "position")
  });
}

export function analysisPopulationExclusionDigest(
  input: Readonly<AnalysisPopulationExclusionDigestInput>
): string {
  assertAnalysisPopulationExclusionPair(input);
  if (input.reason !== "ineligible_ingestion_purpose") throw new Error("Unknown analysis population exclusion reason");
  return analysisPopulationDigest({
    basis: ANALYSIS_POPULATION_EXCLUSION_DIGEST_BASIS,
    caseId: assertNonBlank(input.caseId, "caseId"),
    rawTraceId: input.rawTraceId === null ? null : assertNonBlank(input.rawTraceId, "rawTraceId"),
    sourceTraceId: input.sourceTraceId === null ? null : assertNonBlank(input.sourceTraceId, "sourceTraceId"),
    caseType: input.caseType,
    ingestionPurpose: input.ingestionPurpose,
    ingestionTime: normalizeAnalysisPopulationTimestamp(input.ingestionTime),
    position: assertExactCount(input.position, "position"),
    reason: input.reason
  });
}

export function analysisPopulationContentDigest(orderedItemDigests: readonly string[]): string {
  if (orderedItemDigests.length === 0 || orderedItemDigests.length > ANALYSIS_POPULATION_MAX_MEMBERS) {
    throw new Error("Analysis population content requires 1..100000 ordered item digests");
  }
  return analysisPopulationDigest({
    basis: ANALYSIS_POPULATION_CONTENT_DIGEST_BASIS,
    itemDigests: orderedItemDigests.map((digest) => assertSha256Digest(digest, "itemDigest"))
  });
}

/** fixedBudget is intentionally absent: one frame permits exactly one draw. */
export function analysisPopulationFrameDigest(input: Readonly<AnalysisPopulationFrameDigestInput>): string {
  if (input.frameMemberDigests.length === 0 || input.frameMemberDigests.length > ANALYSIS_POPULATION_MAX_MEMBERS) {
    throw new Error("Analysis population frame requires 1..100000 ordered member digests");
  }
  const window = normalizeWindow(input.windowStart, input.windowEnd);
  return analysisPopulationDigest({
    basis: ANALYSIS_POPULATION_FRAME_DIGEST_BASIS,
    projectId: assertNonBlank(input.projectId, "projectId"),
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    eligibleSources: [...ANALYSIS_POPULATION_ELIGIBLE_SOURCES],
    eligibleIngestionPurposes: [...ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES],
    canonicalizationVersion: ANALYSIS_POPULATION_CANONICALIZATION_VERSION,
    orderingVersion: ANALYSIS_POPULATION_ORDERING_VERSION,
    frameMemberDigests: input.frameMemberDigests.map((digest) => assertSha256Digest(digest, "frameMemberDigest"))
  });
}

export function analysisPopulationRankDigest(input: Readonly<AnalysisPopulationRankDigestInput>): string {
  return analysisPopulationDigest({
    basis: ANALYSIS_POPULATION_RANK_DIGEST_BASIS,
    seed: assertSeed(input.seed),
    caseId: assertNonBlank(input.caseId, "caseId"),
    frameMemberDigest: assertSha256Digest(input.frameMemberDigest, "frameMemberDigest")
  });
}

export function analysisPopulationDrawItemContentDigest(
  input: Readonly<AnalysisPopulationDrawItemDigestInput>
): string {
  return analysisPopulationDigest({
    basis: ANALYSIS_POPULATION_DRAW_ITEM_DIGEST_BASIS,
    memberId: assertNonBlank(input.memberId, "memberId"),
    revisionItemId: assertNonBlank(input.revisionItemId, "revisionItemId"),
    caseId: assertNonBlank(input.caseId, "caseId"),
    frameMemberDigest: assertSha256Digest(input.frameMemberDigest, "frameMemberDigest"),
    rankDigest: assertSha256Digest(input.rankDigest, "rankDigest"),
    position: assertPosition(input.position, ANALYSIS_POPULATION_MAX_FIXED_BUDGET, "position")
  });
}

export function analysisPopulationDrawContentDigest(orderedDrawItemDigests: readonly string[]): string {
  if (orderedDrawItemDigests.length === 0 || orderedDrawItemDigests.length > ANALYSIS_POPULATION_MAX_FIXED_BUDGET) {
    throw new Error("Analysis draw content requires 1..10000 ordered draw-item digests");
  }
  return analysisPopulationDigest({
    basis: ANALYSIS_POPULATION_DRAW_CONTENT_DIGEST_BASIS,
    drawItemContentDigests: orderedDrawItemDigests.map((digest) => assertSha256Digest(digest, "drawItemContentDigest"))
  });
}

export function analysisPopulationDrawDigest(input: Readonly<AnalysisPopulationDrawDigestInput>): string {
  const inclusionProbability = analysisPopulationInclusionProbability(input.fixedBudget, input.populationSize);
  if (input.drawItemContentDigests.length !== input.fixedBudget) {
    throw new Error("Analysis draw item count must equal fixedBudget");
  }
  const expectedContentDigest = analysisPopulationDrawContentDigest(input.drawItemContentDigests);
  if (input.contentDigest !== expectedContentDigest) {
    throw new Error("Analysis draw contentDigest must bind the ordered draw items");
  }
  return analysisPopulationDigest({
    basis: ANALYSIS_POPULATION_DRAW_ALGORITHM_VERSION,
    populationId: assertNonBlank(input.populationId, "populationId"),
    datasetRevisionId: assertNonBlank(input.datasetRevisionId, "datasetRevisionId"),
    frameDigest: assertSha256Digest(input.frameDigest, "frameDigest"),
    contentDigest: assertSha256Digest(input.contentDigest, "contentDigest"),
    method: "simple_random",
    stoppingRule: "fixed",
    drawExecutor: "coeval_server",
    seed: assertSeed(input.seed),
    rngVersion: ANALYSIS_POPULATION_RNG_VERSION,
    algorithmVersion: ANALYSIS_POPULATION_DRAW_ALGORITHM_VERSION,
    fixedBudget: input.fixedBudget,
    populationSize: input.populationSize,
    inclusionProbability,
    drawItemContentDigests: input.drawItemContentDigests.map((digest) => assertSha256Digest(digest, "drawItemContentDigest"))
  });
}

export function orderAnalysisPopulationCandidates<T extends Readonly<{ caseId: string; ingestionTime: string }>>(
  candidates: readonly T[]
): T[] {
  if (candidates.length > ANALYSIS_POPULATION_MAX_MEMBERS) {
    throw new AnalysisPopulationBoundError(
      "analysis_population_frame_too_large",
      ANALYSIS_POPULATION_MAX_MEMBERS,
      candidates.length,
      `Analysis population frame exceeds ${ANALYSIS_POPULATION_MAX_MEMBERS} members`
    );
  }
  const seen = new Set<string>();
  const normalized = candidates.map((candidate) => {
    const caseId = assertNonBlank(candidate.caseId, "caseId");
    if (seen.has(caseId)) throw new Error(`Duplicate analysis population caseId: ${caseId}`);
    seen.add(caseId);
    return { candidate, instant: analysisPopulationOrderingInstant(candidate.ingestionTime) };
  });
  normalized.sort((left, right) =>
    compareAnalysisPopulationInstants(left.instant, right.instant) ||
    compareCodeUnits(left.candidate.caseId, right.candidate.caseId)
  );
  return normalized.map(({ candidate }) => candidate);
}

export function analysisPopulationInclusionProbability(
  fixedBudget: number,
  populationSize: number
): AnalysisPopulationInclusionProbability {
  assertAnalysisPopulationDrawBounds(populationSize, fixedBudget);
  return Object.freeze({ numerator: fixedBudget, denominator: populationSize });
}

export function assertAnalysisPopulationDrawBounds(populationSize: number, fixedBudget: number): void {
  if (!Number.isSafeInteger(populationSize) || populationSize < 0) {
    throw new Error("populationSize must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(fixedBudget) || fixedBudget < 1) {
    throw new Error("fixedBudget must be a positive safe integer");
  }
  if (populationSize === 0) {
    throw new AnalysisPopulationBoundError(
      "analysis_population_frame_empty",
      1,
      0,
      "Analysis population frame is empty"
    );
  }
  if (populationSize > ANALYSIS_POPULATION_MAX_MEMBERS) {
    throw new AnalysisPopulationBoundError(
      "analysis_population_frame_too_large",
      ANALYSIS_POPULATION_MAX_MEMBERS,
      populationSize,
      `Analysis population frame exceeds ${ANALYSIS_POPULATION_MAX_MEMBERS} members`
    );
  }
  const limit = Math.min(populationSize, ANALYSIS_POPULATION_MAX_FIXED_BUDGET);
  if (fixedBudget > limit) {
    throw new AnalysisPopulationBoundError(
      "analysis_population_budget_invalid",
      limit,
      fixedBudget,
      `Analysis population fixedBudget exceeds ${limit}`
    );
  }
}

export function assertAnalysisPopulationWindow(
  input: Pick<AnalysisPopulationCreateInput, "windowStart" | "windowEnd">,
  databaseNow: string | Date
): void {
  const start = Date.parse(TimestampSchema.parse(input.windowStart));
  const end = Date.parse(TimestampSchema.parse(input.windowEnd));
  const now = databaseNow instanceof Date
    ? databaseNow.getTime()
    : Date.parse(TimestampSchema.parse(databaseNow));
  if (!Number.isFinite(now)) throw new Error("databaseNow must be a valid timestamp");
  if (start >= end) {
    throw new Error("Analysis population windowStart must be earlier than windowEnd");
  }
  const latestAllowedEnd = now - ANALYSIS_POPULATION_MIN_WINDOW_LAG_SECONDS * 1_000;
  if (end > latestAllowedEnd) {
    throw new AnalysisPopulationBoundError(
      "analysis_population_window_too_recent",
      latestAllowedEnd,
      end,
      `Analysis population windowEnd must be at least ${ANALYSIS_POPULATION_MIN_WINDOW_LAG_SECONDS} seconds behind the database clock`
    );
  }
}

export function decideAnalysisPopulationFrameReuse(
  existingFixedBudget: number,
  requestedFixedBudget: number
): AnalysisPopulationFrameReuseDecision {
  assertPositiveSafeInteger(existingFixedBudget, "existingFixedBudget");
  assertPositiveSafeInteger(requestedFixedBudget, "requestedFixedBudget");
  return existingFixedBudget === requestedFixedBudget
    ? { kind: "reuse" }
    : {
        kind: "conflict",
        code: "analysis_population_draw_conflict",
        existingFixedBudget,
        requestedFixedBudget
      };
}

export function drawAnalysisPopulationSample(input: Readonly<{
  populationId: string;
  datasetRevisionId: string;
  frameDigest: string;
  seed: string;
  fixedBudget: number;
  members: readonly AnalysisPopulationRankableMember[];
}>): AnalysisPopulationDrawEvidence {
  const populationSize = input.members.length;
  assertAnalysisPopulationDrawBounds(populationSize, input.fixedBudget);
  const populationId = assertNonBlank(input.populationId, "populationId");
  const datasetRevisionId = assertNonBlank(input.datasetRevisionId, "datasetRevisionId");
  const frameDigest = assertSha256Digest(input.frameDigest, "frameDigest");
  const seed = assertSeed(input.seed);
  const seenCaseIds = new Set<string>();
  const ranked = input.members.map((member) => {
    const caseId = assertNonBlank(member.caseId, "caseId");
    if (seenCaseIds.has(caseId)) throw new Error(`Duplicate analysis population caseId: ${caseId}`);
    seenCaseIds.add(caseId);
    const normalized = {
      memberId: assertNonBlank(member.memberId, "memberId"),
      revisionItemId: assertNonBlank(member.revisionItemId, "revisionItemId"),
      caseId,
      frameMemberDigest: assertSha256Digest(member.frameMemberDigest, "frameMemberDigest")
    };
    return {
      ...normalized,
      rankDigest: analysisPopulationRankDigest({
        seed,
        caseId,
        frameMemberDigest: normalized.frameMemberDigest
      })
    };
  });
  ranked.sort(compareAnalysisPopulationRanks);
  const selections = ranked.slice(0, input.fixedBudget).map((selection, position) => {
    const contentDigest = analysisPopulationDrawItemContentDigest({ ...selection, position });
    return Object.freeze({ ...selection, position, contentDigest });
  });
  const contentDigest = analysisPopulationDrawContentDigest(selections.map((selection) => selection.contentDigest));
  const drawDigest = analysisPopulationDrawDigest({
    populationId,
    datasetRevisionId,
    frameDigest,
    contentDigest,
    seed,
    fixedBudget: input.fixedBudget,
    populationSize,
    drawItemContentDigests: selections.map((selection) => selection.contentDigest)
  });
  return Object.freeze({
    method: "simple_random",
    stoppingRule: "fixed",
    drawExecutor: "coeval_server",
    seed,
    rngVersion: ANALYSIS_POPULATION_RNG_VERSION,
    algorithmVersion: ANALYSIS_POPULATION_DRAW_ALGORITHM_VERSION,
    fixedBudget: input.fixedBudget,
    populationSize,
    inclusionProbability: analysisPopulationInclusionProbability(input.fixedBudget, populationSize),
    selections: Object.freeze(selections),
    contentDigest,
    drawDigest
  });
}

export function analysisPopulationClaim(populationId: string): AnalysisPopulationClaim {
  return Object.freeze({
    drawnFromPopulationId: assertNonBlank(populationId, "populationId"),
    representativeOfPopulationId: null,
    representativeReason: "coding_not_complete"
  });
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareAnalysisPopulationRanks(
  left: Pick<AnalysisPopulationRankedMember, "rankDigest" | "frameMemberDigest" | "caseId">,
  right: Pick<AnalysisPopulationRankedMember, "rankDigest" | "frameMemberDigest" | "caseId">
): number {
  return compareCodeUnits(left.rankDigest, right.rankDigest) ||
    compareCodeUnits(left.frameMemberDigest, right.frameMemberDigest) ||
    compareCodeUnits(left.caseId, right.caseId);
}

export function normalizeAnalysisPopulationTimestamp(value: string): string {
  return new Date(TimestampSchema.parse(value)).toISOString();
}

interface AnalysisPopulationOrderingInstant {
  epochSecond: bigint;
  fractionalDigits: string;
}

/** Preserve PostgreSQL timestamptz ordering even inside one millisecond. */
function analysisPopulationOrderingInstant(value: string): AnalysisPopulationOrderingInstant {
  const timestamp = TimestampSchema.parse(value);
  const match = RFC3339_INSTANT_PATTERN.exec(timestamp);
  if (!match) throw new Error("Invalid analysis population timestamp");
  const epochMilliseconds = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(epochMilliseconds)) throw new Error("Invalid analysis population timestamp");
  return {
    epochSecond: BigInt(Math.floor(epochMilliseconds / 1_000)),
    fractionalDigits: (match[2] ?? "").replace(/0+$/, "")
  };
}

function compareAnalysisPopulationInstants(
  left: AnalysisPopulationOrderingInstant,
  right: AnalysisPopulationOrderingInstant
): number {
  if (left.epochSecond < right.epochSecond) return -1;
  if (left.epochSecond > right.epochSecond) return 1;
  const width = Math.max(left.fractionalDigits.length, right.fractionalDigits.length);
  for (let index = 0; index < width; index += 1) {
    const leftDigit = left.fractionalDigits[index] ?? "0";
    const rightDigit = right.fractionalDigits[index] ?? "0";
    if (leftDigit < rightDigit) return -1;
    if (leftDigit > rightDigit) return 1;
  }
  return 0;
}

function normalizeWindow(windowStart: string, windowEnd: string): { windowStart: string; windowEnd: string } {
  const normalized = {
    windowStart: normalizeAnalysisPopulationTimestamp(windowStart),
    windowEnd: normalizeAnalysisPopulationTimestamp(windowEnd)
  };
  if (normalized.windowStart >= normalized.windowEnd) {
    throw new Error("Analysis population windowStart must be earlier than windowEnd");
  }
  return normalized;
}

function assertSha256Digest(value: unknown, name: string): string {
  if (typeof value !== "string" || !SHA256_DIGEST_PATTERN.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function assertSeed(value: unknown): string {
  if (typeof value !== "string" || !SEED_PATTERN.test(value)) {
    throw new Error("Analysis population seed must be exactly 32 lowercase-hex bytes");
  }
  return value;
}

function assertNonBlank(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    throw new Error(`${name} must be a non-blank string`);
  }
  // Reuse canonical validation to reject PostgreSQL-incompatible NUL and
  // unpaired UTF-16 without changing the caller's code units.
  canonicalGovernedJsonV1(value);
  return value;
}

function assertPosition(value: number, exclusiveLimit: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= exclusiveLimit) {
    throw new Error(`${name} must be a non-negative safe integer below ${exclusiveLimit}`);
  }
  return value;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
}

function assertExactCount(value: string, name: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${name} must be a canonical non-negative decimal string`);
  }
  return value;
}

function assertAnalysisPopulationExclusionPair(input: AnalysisPopulationExclusionDigestInput): void {
  const valid =
    (input.caseType === "manual" &&
      input.rawTraceId !== null && input.sourceTraceId !== null &&
      ["judge_api", "judge_batch_general", "dataset_example", "trace_test_synthetic"].includes(input.ingestionPurpose)) ||
    (input.caseType === "release_evidence" && input.ingestionPurpose === "release_evidence" &&
      ((input.rawTraceId === null) === (input.sourceTraceId === null)));
  if (!valid) throw new Error("Invalid analysis population exclusion caseType-purpose-source shape");
}
