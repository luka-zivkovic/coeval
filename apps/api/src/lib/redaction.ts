import type { TraceRedactionConfig } from "@coeval/shared";
import type { Trace } from "@coeval/audit/runtime";

export const REDACTED_VALUE = "[REDACTED]";
export const EXCLUDED_VALUE = "[EXCLUDED]";
export const TRUNCATED_SUFFIX = "…[TRUNCATED]";
export const CYCLE_VALUE = "[CYCLE]";
export const MAX_DEPTH_VALUE = "[MAX_DEPTH]";

export const DEFAULT_SENSITIVE_KEY_PATTERNS = [
  "api_key",
  "apikey",
  "api-key",
  "authorization",
  "auth_token",
  "access_token",
  "refresh_token",
  "id_token",
  "password",
  "passwd",
  "secret",
  "token",
  "cookie",
  "set-cookie",
  "credential",
  "credentials",
  "private_key",
  "client_secret"
] as const;

const DEFAULT_MAX_STRING_CHARS = 4000;
const MAX_REDACTION_DEPTH = 200;

// trajectory steps ride inside the normalized payload. The field is
// carried only when present so pre-M2 payloads (and their content hashes /
// stored JSON) are byte-identical to before.
// Shape matches shared TraceStep / audit Trace.steps exactly (input/output
// present-but-unknown) so steps flow between the three without casts.
export interface NormalizedTraceStep {
  name?: string | undefined;
  input: unknown;
  output: unknown;
  metadata?: Record<string, unknown> | undefined;
}

export interface NormalizedTracePayload {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  steps?: NormalizedTraceStep[];
}

export function normalizeTracePayload(input: {
  input: unknown;
  output: unknown;
  metadata?: Record<string, unknown> | undefined;
  steps?: NormalizedTraceStep[] | undefined;
}): NormalizedTracePayload {
  return {
    input: input.input,
    output: input.output,
    metadata: input.metadata ?? {},
    ...(input.steps ? { steps: input.steps } : {})
  };
}

export function redactNormalizedTracePayload(payload: NormalizedTracePayload, config: TraceRedactionConfig = {}): NormalizedTracePayload {
  const redacted = redactJson(payload, config) as NormalizedTracePayload;
  return {
    input: redacted.input,
    output: redacted.output,
    // Trace metadata is expected to be an object. If a future caller passes a
    // scalar and redaction returns a marker, keep the API shape stable.
    metadata: isPlainRecord(redacted.metadata) ? redacted.metadata : redacted.metadata === undefined ? {} : { value: redacted.metadata },
    // Steps went through redactJson with the rest of the payload: key-pattern
    // redaction applies at every depth, and excludedPaths address them
    // absolutely from the payload root (`steps.0.input.card` / `steps[0]…`) —
    // top-level paths do NOT re-root per step.
    ...(Array.isArray(redacted.steps) ? { steps: redacted.steps } : {})
  };
}

export function redactTrace(trace: Trace, config: TraceRedactionConfig = {}): Trace {
  const redacted = redactNormalizedTracePayload({
    input: trace.input,
    output: trace.output,
    ...(trace.metadata ? { metadata: trace.metadata } : {}),
    ...(trace.steps ? { steps: trace.steps } : {})
  }, config);
  return {
    id: trace.id,
    input: redacted.input,
    output: redacted.output,
    metadata: redacted.metadata ?? {},
    ...(redacted.steps ? { steps: redacted.steps } : {})
  };
}

export function redactJson(value: unknown, config: TraceRedactionConfig = {}): unknown {
  const excludedPaths = new Set((config.excludedPaths ?? []).map(normalizePath).filter(Boolean));
  const sensitivePatterns = normalizeSensitivePatterns(config.sensitiveKeyPatterns);
  const maxStringChars = config.maxStringChars ?? DEFAULT_MAX_STRING_CHARS;
  const visited = new WeakSet<object>();

  function visit(current: unknown, path: string[], depth: number): unknown {
    if (matchesExcludedPath(path, excludedPaths)) return EXCLUDED_VALUE;
    if (depth > MAX_REDACTION_DEPTH) return MAX_DEPTH_VALUE;

    if (Array.isArray(current)) {
      if (visited.has(current)) return CYCLE_VALUE;
      visited.add(current);
      return current.map((item, index) => visit(item, [...path, String(index)], depth + 1));
    }

    if (isPlainRecord(current)) {
      if (visited.has(current)) return CYCLE_VALUE;
      visited.add(current);
      const output: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(current)) {
        const nestedPath = [...path, key];
        if (matchesExcludedPath(nestedPath, excludedPaths)) {
          output[key] = EXCLUDED_VALUE;
        } else if (isSensitiveKey(key, sensitivePatterns)) {
          output[key] = REDACTED_VALUE;
        } else {
          output[key] = visit(nested, nestedPath, depth + 1);
        }
      }
      return output;
    }

    if (typeof current === "string" && current.length > maxStringChars) {
      return `${current.slice(0, maxStringChars)}${TRUNCATED_SUFFIX}`;
    }

    return current;
  }

  return visit(value, [], 0);
}

export function normalizeRedactionConfig(config: TraceRedactionConfig | undefined): TraceRedactionConfig {
  if (!config) return {};
  return {
    ...(config.excludedPaths ? { excludedPaths: config.excludedPaths } : {}),
    ...(config.sensitiveKeyPatterns ? { sensitiveKeyPatterns: config.sensitiveKeyPatterns } : {}),
    ...(config.maxStringChars ? { maxStringChars: config.maxStringChars } : {})
  };
}

function normalizeSensitivePatterns(patterns: readonly string[] | undefined): string[] {
  const merged = [...DEFAULT_SENSITIVE_KEY_PATTERNS, ...(patterns ?? [])];
  return [...new Set(merged.map((pattern) => pattern.toLowerCase().trim()).filter(Boolean))];
}

function isSensitiveKey(key: string, patterns: readonly string[]): boolean {
  const keySegments = keyToSegments(key);
  const normalizedKey = keySegments.join("_");
  const compactKey = keySegments.join("");
  return patterns.some((pattern) => {
    const patternSegments = keyToSegments(pattern);
    const normalizedPattern = patternSegments.join("_");
    const compactPattern = patternSegments.join("");
    if (normalizedKey === normalizedPattern || compactKey === compactPattern) return true;
    if (patternSegments.length <= 1) return false;
    return containsSegmentSequence(keySegments, patternSegments);
  });
}

function matchesExcludedPath(path: string[], excludedPaths: Set<string>): boolean {
  if (excludedPaths.size === 0 || path.length === 0) return false;
  const normalized = path.map(escapePathSegment).join(".");
  if (excludedPaths.has(normalized)) return true;

  for (const candidate of excludedPaths) {
    const parts = candidate.split(".");
    if (parts.length !== path.length) continue;
    if (parts.every((part, index) => part === "*" || part === escapePathSegment(path[index] ?? ""))) return true;
  }
  return false;
}

function normalizePath(path: string): string {
  const invalidBracket = path.match(/\[(?!\d+\]|\*\])([^\]]*)\]/);
  if (invalidBracket) {
    throw new Error(`Invalid redaction path "${path}". Bracket notation supports only numeric indexes like [0] or wildcard [*].`);
  }
  return path
    .trim()
    .replace(/\[(\d+|\*)\]/g, ".$1")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(escapePathSegment)
    .join(".");
}

function escapePathSegment(segment: string): string {
  return segment.trim();
}

function keyToSegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_\-\s]+/)
    .filter(Boolean);
}

function containsSegmentSequence(segments: string[], candidate: string[]): boolean {
  if (candidate.length > segments.length) return false;
  for (let index = 0; index <= segments.length - candidate.length; index += 1) {
    if (candidate.every((segment, offset) => segments[index + offset] === segment)) return true;
  }
  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
