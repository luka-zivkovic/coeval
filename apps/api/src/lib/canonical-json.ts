import { createHash } from "node:crypto";

// Rubrist's canonical JSON (rubrist-canonical-json/v1) and the digests every
// evidence contract builds on. Object keys sort by UTF-16 code unit at every
// depth, arrays retain order, and JSON primitives use JSON.stringify's
// representation. Inputs are JSON values from API/schema boundaries;
// unsupported values fail instead of being silently coerced.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON cannot encode a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => entry === undefined ? "null" : canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`Canonical JSON cannot encode ${typeof value}`);
}

export function sha256Digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function contentDigest(input: unknown, output: unknown): string {
  return sha256Digest({ input, output });
}
