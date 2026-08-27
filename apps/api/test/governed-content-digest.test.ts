import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@coeval/db";
import {
  canonicalGovernedJsonV1,
  governedContentV1CanonicalBytes,
  governedContentV1Digest,
  verifyGovernedContentV1Digest
} from "../src/lib/governed-content-digest.js";
import { governedReviewInstructionDigest } from "../src/lib/governed-review.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

describe("governed content digest v1", () => {
  it("uses UTF-16 object-key order and exponent-free JSON numbers", () => {
    expect(canonicalGovernedJsonV1({
      "\ue000": "bmp",
      "\u{10000}": "astral",
      "2": "two",
      "10": "ten",
      nested: [1e21, 1e-7, -0]
    })).toBe(
      `{"10":"ten","2":"two","nested":[1000000000000000000000,0.0000001,0],"\u{10000}":"astral","\ue000":"bmp"}`
    );
  });

  it("exposes exact digest bytes and an independent verifier", () => {
    const content = { answer: true, input: { text: "line\nquote\"slash\\emoji😀" } };
    const bytes = governedContentV1CanonicalBytes("governed-example/v1", content);
    expect(bytes.toString("utf8")).toBe(
      `{"content":{"answer":true,"input":{"text":"line\\nquote\\\"slash\\\\emoji😀"}},"kind":"governed-example/v1"}`
    );
    const digest = governedContentV1Digest("governed-example/v1", content);
    expect(digest).toBe("sha256:748b0d3ab55287da8126fb40519a82ff3714f3186e44799c9934c05c0475188b");
    expect(() => verifyGovernedContentV1Digest("governed-example/v1", content, digest)).not.toThrow();
    expect(() => verifyGovernedContentV1Digest("governed-example/v1", content, `sha256:${"0".repeat(64)}`))
      .toThrow("governed content digest mismatch");
  });

  it("rejects values PostgreSQL JSONB cannot represent", () => {
    expect(() => canonicalGovernedJsonV1("nul\u0000value")).toThrow("cannot encode NUL");
    expect(() => canonicalGovernedJsonV1("unpaired\ud800")).toThrow("unpaired UTF-16 surrogate");
    expect(() => canonicalGovernedJsonV1(Number.POSITIVE_INFINITY)).toThrow("non-finite number");
    expect(() => canonicalGovernedJsonV1({ absent: undefined })).toThrow("cannot encode undefined");
    expect(() => canonicalGovernedJsonV1(new Array(1))).toThrow("cannot encode a sparse array");
    expect(() => canonicalGovernedJsonV1(new Date(0))).toThrow("only plain JSON objects");
  });
});

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; governed digest PostgreSQL tests may not be skipped.");
}
const runPg = databaseUrl ? describe : describe.skip;

runPg("governed content digest JavaScript/PostgreSQL interoperability", () => {
  let pool: Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await openPostgresTestDatabase("governed_digest"));
    await runMigrations(pool);
  }, 60_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("matches independent golden vectors across runtimes", async () => {
    const vectors: unknown[] = [
      null,
      true,
      false,
      "plain / \"quoted\" \\ line\n tab\t unicode é 中 😀 \u2028",
      [],
      {},
      [null, { retained: "yes" }],
      {
        "": "empty key",
        "\ue000": "BMP private-use sorts after an astral surrogate pair",
        "\u{10000}": "astral",
        "10": "ten",
        "2": "two",
        nested: { z: [3, { b: 2, a: 1 }], a: "first" }
      },
      {
        numbers: [
          -0,
          0,
          0.1,
          1e21,
          1e-7,
          -1.25e30,
          Number.MAX_SAFE_INTEGER,
          Number.MAX_VALUE,
          Number.MIN_VALUE,
          1.2345678901234567
        ]
      }
    ];

    for (const [index, content] of vectors.entries()) {
      const kind = `governed-golden-${index}/v1`;
      const row = (await pool.query(
        `select governed_canonical_json_v1(jsonb_build_object('content',$1::jsonb,'kind',$2::text)) as canonical,
                governed_content_v1_digest($2::text,$1::jsonb) as digest`,
        [JSON.stringify(content), kind]
      )).rows[0];
      expect(String(row.canonical)).toBe(governedContentV1CanonicalBytes(kind, content).toString("utf8"));
      expect(String(row.digest)).toBe(governedContentV1Digest(kind, content));
    }
  });

  it("aligns the exported instruction helper to the persisted row projection", async () => {
    const instruction = {
      contract: "coeval/governed-review-instruction/v1" as const,
      schemaVersion: 1 as const,
      instructionVersionId: "instruction_interop",
      projectId: "project_context_is_relational",
      criterionId: "criterion_context_is_relational",
      criterionVersionId: "criterion_version_interop",
      revision: 2,
      predecessorInstructionVersionId: "instruction_interop_v1",
      title: "Unicode 😀 instruction",
      instructions: "Apply nested evidence exactly.",
      failureCodeGuidance: "Use codes in reviewer-authored order.",
      allowedLabels: ["pass", "fail", "cannot_determine"] as ["pass", "fail", "cannot_determine"],
      createdBySubjectId: "subject_context_is_relational",
      createdAt: "2026-08-23T00:00:00.000Z",
      instructionDigest: `sha256:${"0".repeat(64)}`
    };
    const rowContent = {
      allowedLabels: instruction.allowedLabels,
      criterionVersionId: instruction.criterionVersionId,
      failureCodeGuidance: instruction.failureCodeGuidance,
      id: instruction.instructionVersionId,
      instructions: instruction.instructions,
      predecessorInstructionVersionId: instruction.predecessorInstructionVersionId,
      revision: instruction.revision,
      title: instruction.title
    };
    const databaseDigest = String((await pool.query(
      `select governed_content_v1_digest('review-instruction/v1',$1::jsonb) as digest`,
      [JSON.stringify(rowContent)]
    )).rows[0]?.digest);

    expect(governedReviewInstructionDigest(instruction)).toBe(databaseDigest);
    expect(() => verifyGovernedContentV1Digest("review-instruction/v1", rowContent, databaseDigest)).not.toThrow();
  });
});
