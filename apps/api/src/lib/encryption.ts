import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "aes-256-gcm:v1";

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function decryptJson<T>(value: string): T {
  if (!value.startsWith(`${PREFIX}:`)) {
    throw new Error("Encrypted credential payload has an unsupported format");
  }

  // The PREFIX itself contains a colon ("aes-256-gcm:v1"), so slice it off
  // before splitting; splitting the complete value would incorrectly read
  // "v1" as the IV.
  const [ivPart, tagPart, ciphertextPart] = value.slice(PREFIX.length + 1).split(":");
  if (!ivPart || !tagPart || !ciphertextPart) throw new Error("Encrypted credential payload is malformed");

  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, "base64url")),
    decipher.final()
  ]).toString("utf8");
  return JSON.parse(plaintext) as T;
}

function encryptionKey(): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required to encrypt integration credentials");
  return createHash("sha256").update(secret).digest();
}
