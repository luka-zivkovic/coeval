// Internal invariants shared by the governed-review artifact pipelines.
// This module is deliberately absent from the compatibility barrel.
import { createHash } from "node:crypto";
import type { GovernedReviewBatch } from "@coeval/shared";
import { canonicalJson } from "./assessment-receipt.js";

export const MAX_GOVERNED_REVIEW_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_COLLECTION_PROVENANCE_BYTES = 256 * 1024;

export function assertSubjectSeparated(subjectId: string, batch: GovernedReviewBatch, role: string): void {
  if (batch.developmentCapabilitySubjectIds.includes(subjectId) || batch.developmentExposureSubjectIds.includes(subjectId)) {
    throw new Error(`sealed governed review ${role} cannot have evaluator-development capability or exposure`);
  }
}

export function assertCanonicalJsonSize(value: unknown, label: string, maxBytes: number): void {
  if (Buffer.byteLength(canonicalJson(value), "utf8") > maxBytes) {
    throw new Error(`${label} exceeds its canonical JSON byte limit`);
  }
}

export function assertContiguousPositions(values: readonly number[], label: string): void {
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.some((value, index) => value !== index)) throw new Error(`${label} positions must be unique and contiguous from zero`);
}

export function assertSorted(values: readonly string[], label: string): void {
  const sorted = [...values].sort(compareStrings);
  if (values.some((value, index) => value !== sorted[index])) {
    throw new Error(`${label} values must use deterministic lexical ordering`);
  }
}

export function assertSortedUnique(values: readonly string[], label: string): void {
  assertSorted(values, label);
  assertUnique(values, label);
}

export function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} values must be unique`);
}

export function assertExactSet(actual: readonly string[], expected: readonly string[], label: string): void {
  assertUnique(actual, label);
  const sortedActual = [...actual].sort(compareStrings);
  const sortedExpected = [...expected].sort(compareStrings);
  if (sortedActual.length !== sortedExpected.length || sortedActual.some((value, index) => value !== sortedExpected[index])) {
    throw new Error(`${label} set does not match the frozen evidence`);
  }
}

export function assertSame(actual: string, expected: string, label: string): void {
  if (actual !== expected) throw new Error(`${label} mismatch: expected ${expected}, received ${actual}`);
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
