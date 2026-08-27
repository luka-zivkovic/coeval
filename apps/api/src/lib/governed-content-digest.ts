import { createHash } from "node:crypto";

export const GOVERNED_CONTENT_CANONICALIZATION_VERSION = "governed-content-json/v1" as const;

/**
 * Canonical JSON used by PostgreSQL-backed governed evidence.
 *
 * This is deliberately distinct from the receipt canonicalization contract:
 * object keys use ECMAScript UTF-16 code-unit order, numbers are rendered as
 * their finite JSON value in exponent-free decimal form, arrays retain order,
 * and inputs must already be JSON values. PostgreSQL JSONB cannot represent
 * NUL or unpaired UTF-16 surrogates, so this contract rejects them before
 * evidence is written.
 */
export function canonicalGovernedJsonV1(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    assertPostgresJsonString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") return canonicalGovernedNumber(value);
  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new Error("Governed canonical JSON cannot encode a sparse array");
      }
      entries.push(canonicalGovernedJsonV1(value[index]));
    }
    return `[${entries.join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Governed canonical JSON can encode only plain JSON objects");
    }
    const keys = Object.keys(record)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    return `{${keys.map((key) => {
      assertPostgresJsonString(key);
      return `${JSON.stringify(key)}:${canonicalGovernedJsonV1(record[key])}`;
    }).join(",")}}`;
  }
  throw new Error(`Governed canonical JSON cannot encode ${typeof value}`);
}

/** Exact bytes hashed by governed_content_v1_digest(kind, content). */
export function governedContentV1CanonicalBytes(kind: string, content: unknown): Buffer {
  assertPostgresJsonString(kind);
  return Buffer.from(canonicalGovernedJsonV1({ content, kind }), "utf8");
}

/** Independently compute a PostgreSQL governed_content_v1_digest value. */
export function governedContentV1Digest(kind: string, content: unknown): string {
  return `sha256:${createHash("sha256")
    .update(governedContentV1CanonicalBytes(kind, content))
    .digest("hex")}`;
}

/** Verify a persisted governed digest without trusting a database projection. */
export function verifyGovernedContentV1Digest(
  kind: string,
  content: unknown,
  expectedDigest: string
): void {
  if (governedContentV1Digest(kind, content) !== expectedDigest) {
    throw new Error(`governed content digest mismatch for ${kind}`);
  }
}

function canonicalGovernedNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Governed canonical JSON cannot encode a non-finite number");
  const serialized = JSON.stringify(value);
  if (!/[eE]/.test(serialized)) return serialized;

  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(serialized);
  if (!match) throw new Error("Governed canonical JSON could not normalize a number");
  const sign = match[1] ?? "";
  const integer = match[2];
  const fraction = match[3] ?? "";
  const exponentText = match[4];
  if (integer === undefined || exponentText === undefined) {
    throw new Error("Governed canonical JSON could not normalize a number");
  }
  const digits = `${integer}${fraction}`;
  const decimalPosition = integer.length + Number(exponentText);
  if (decimalPosition <= 0) return `${sign}0.${"0".repeat(-decimalPosition)}${digits}`;
  if (decimalPosition >= digits.length) {
    return `${sign}${digits}${"0".repeat(decimalPosition - digits.length)}`;
  }
  return `${sign}${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}

function assertPostgresJsonString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) throw new Error("Governed canonical JSON cannot encode NUL");
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("Governed canonical JSON cannot encode an unpaired UTF-16 surrogate");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error("Governed canonical JSON cannot encode an unpaired UTF-16 surrogate");
    }
  }
}
