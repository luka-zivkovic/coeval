import { createHash, randomBytes } from "node:crypto";

// API keys are high-entropy random tokens (not user-chosen passwords), so a
// fast unsalted SHA-256 is the right hash: it's a single deterministic lookup
// key, and there's nothing to brute-force in 192 bits of randomness.
const KEY_PREFIX = "coeval_sk_";

export interface GeneratedApiKey {
  key: string; // plaintext — shown to the user exactly once
  keyHash: string; // sha256(key), stored at rest
  keyPrefix: string; // non-secret head, for listing/identification
}

export function generateApiKey(): GeneratedApiKey {
  const secret = randomBytes(24).toString("base64url");
  const key = `${KEY_PREFIX}${secret}`;
  return {
    key,
    keyHash: hashApiKey(key),
    keyPrefix: `${key.slice(0, KEY_PREFIX.length + 6)}…`
  };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
