import { createHash } from "node:crypto";
import { GovernedBlindTaskViewSchema, GovernedReviewPayloadSnapshotSchema } from "@coeval/shared";
import { canonicalJson } from "../lib/assessment-receipt.js";
import { GovernedReviewIntegrityError } from "./errors.js";
import type { GovernedBlindTaskViewArtifact } from "./repository.js";

const FORBIDDEN_NORMALIZED_KEYS = new Set([
  "caseid", "traceid", "sourcecaseid", "sourcetraceid", "datasetid", "datasetitemid",
  "datasetrevisionid", "datasetrevisionitemid", "sourcedatasetrevisionid",
  "sourcedatasetrevisionitemid", "sealedintakeid", "sealedintakeitemid", "skillversionid",
  "evaluatorversionid", "evaluatoroutput", "evaluatoroutputs", "evaluatorlabel",
  "evaluatorrationale", "judgelabel", "judgedlabel", "judgerationale", "judgerun",
  "rawjudgecall", "rawrequest", "rawresponse", "expectedlabel", "expectedfailstep",
  "goldenlabel", "latesthumanlabel", "peerlabel", "peerlabels", "adjudication",
  "verdict", "verdicts"
]);

const MAX_VIEW_BYTES = 2 * 1024 * 1024;
const MAX_VISITED_VALUES = 250_000;

/**
 * Converts a wider immutable trace snapshot to the sole reviewer-visible
 * payload shape. Metadata is intentionally not copied. Forbidden-key checks
 * then fail closed if evaluator/reference data was embedded in input/output.
 */
export function projectGovernedReviewPayload(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Governed review payload source must be an object");
  }
  const source = raw as Record<string, unknown>;
  const steps = Array.isArray(source.steps)
    ? source.steps.map((step, index) => {
        if (!step || typeof step !== "object" || Array.isArray(step)) {
          throw new Error(`Governed review step ${index + 1} must be an object`);
        }
        const record = step as Record<string, unknown>;
        return {
          name: typeof record.name === "string" && record.name.trim()
            ? record.name.trim()
            : `Step ${index + 1}`,
          input: record.input,
          output: record.output
        };
      })
    : undefined;
  const projected = GovernedReviewPayloadSnapshotSchema.parse({
    input: source.input,
    output: source.output,
    ...(steps ? { steps } : {})
  });
  assertBlindProjectionSafe(projected);
  return projected;
}

export function assertBlindProjectionSafe(value: unknown): void {
  const stack: unknown[] = [value];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    visited += 1;
    if (visited > MAX_VISITED_VALUES) throw new Error("Governed blind projection is too structurally complex");
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (FORBIDDEN_NORMALIZED_KEYS.has(normalizeKey(key))) {
        throw new Error(`Governed blind projection contains forbidden key: ${key}`);
      }
      stack.push(child);
    }
  }
}

export function verifyExactBlindTaskViewArtifact(
  artifact: GovernedBlindTaskViewArtifact
): { canonicalBytes: Uint8Array; viewDigest: string } {
  if (artifact.canonicalBytes.byteLength === 0 || artifact.canonicalBytes.byteLength > MAX_VIEW_BYTES) {
    throw new GovernedReviewIntegrityError("Stored blind task view has an invalid byte length");
  }
  const actualDigest = `sha256:${createHash("sha256").update(artifact.canonicalBytes).digest("hex")}`;
  if (artifact.viewDigest !== actualDigest) {
    throw new GovernedReviewIntegrityError("Stored blind task view digest does not match its exact bytes");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(artifact.canonicalBytes);
  } catch {
    throw new GovernedReviewIntegrityError("Stored blind task view is not valid UTF-8");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GovernedReviewIntegrityError("Stored blind task view is not valid JSON");
  }
  let view;
  try {
    view = GovernedBlindTaskViewSchema.parse(raw);
    assertBlindProjectionSafe(view.payloadSnapshot);
  } catch {
    throw new GovernedReviewIntegrityError(
      "Stored blind task view failed its safe projection contract"
    );
  }
  if (canonicalJson(view) !== text) {
    throw new GovernedReviewIntegrityError("Stored blind task view is not exact canonical JSON");
  }
  return { canonicalBytes: artifact.canonicalBytes, viewDigest: actualDigest };
}

function normalizeKey(key: string): string {
  return key.replace(/[-_\s]/g, "").toLowerCase();
}
