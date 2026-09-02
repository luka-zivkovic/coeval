import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const TEST_DIRECTORY = fileURLToPath(new URL("./", import.meta.url));

const EXPECTED_SHARDS = {
  "eval-service-api-keys.test.ts": {
    describe: "API keys",
    tests: ["mints a key once, lists it masked, and revokes it"]
  },
  "eval-service-v1-batch.test.ts": {
    describe: "POST /api/v1/judge/batch — fire-and-poll",
    tests: [
      "judges a batch (queue-less → inline), collapses in-batch repeats, and is pollable",
      "E1: expectedLabel flows to eval-run agreement — with and without datasetId, incl. cached items",
      "E2: the poll endpoint carries the full CI contract shape",
      "re-POSTing the same batch reuses recorded verdicts (cached, no provider spend)",
      "appends batch cases to an existing dataset when datasetId is given",
      "caps batch size and requires a key",
      "debits one rate-limit token per judged item — a second over-budget batch 429s",
      "rejects a skillVersionId that does not belong to the project",
      "T1: batch items with steps store, redact per step, and round-trip via case detail",
      "T1: a batch with an over-limit steps array is rejected whole with the cap named",
      "T2: expectedFailStep validates fail-only + in-range-of-submitted-steps",
      "T2: snapshot + tri-state — expectedFailStep lands on run items (fresh AND cached); failingStep/stepAgreement stay null until T3",
      "T3: failingStep flows from the judge to run detail; stepAgreement resolves; cached items reuse it",
      "T3: stepAgreement is false when the judge names a different step than expected",
      "S1: judge-key CRUD returns only the masked display, never the raw key",
      "S1: resolution order — the project key is handed to the factory; no project key falls back to env behavior",
      "S1: an invalid project key fails the eval item LOUDLY (permanent, error recorded, no verdict)",
      "S3: a mock batch records deterministic usage; the cached re-run spends nothing (tokens null, not zero)",
      "S3: a provider that reports no usage yields null sums + usageMissingCount, never fabricated zeros"
    ]
  },
  "eval-service-v1-judge.test.ts": {
    describe: "POST /api/v1/judge — eval-as-a-service",
    tests: [
      "judges a trace synchronously and feeds the trust layer",
      "rejects a request with no API key",
      "rejects a request with an invalid API key",
      "returns the recorded verdict on a re-POSTed trace instead of re-judging",
      "force: true bypasses the cache and appends a repeat verdict (self-consistency)",
      "rejects an oversized body with 413",
      "rate-limits a key once its bucket is exhausted",
      "records provider latency on the judge run"
    ]
  },
  "eval-service-v1-project.test.ts": {
    describe: "GET /api/v1/project — connection check",
    tests: [
      "returns project identity and the current skill version for a valid key",
      "rejects a request with no API key",
      "rejects an invalid Bearer key",
      "returns currentSkillVersionId: null when no skill version is active"
    ]
  },
  "eval-service-worker.test.ts": {
    describe: "judge worker → v2 verdicts (trust layer)",
    tests: [
      "records a source=llm_judge verdict pinned to the skill version",
      "dual-writes a scalar verdict (v2 payload + legacy judge_run) for a scalar skill",
      "persists explicit binary ambiguity and projects it to the legacy needs-review label",
      "records unavailable provider response identity as explicit nulls",
      "renders the rubric template before calling the structured judge provider",
      "dual-writes a categorical verdict for a categorical skill",
      "appends a second llm_judge verdict when the same case is re-judged (self-consistency)"
    ]
  }
} as const;

function namedCalls(source: ts.SourceFile, name: string): string[] {
  const titles: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === name && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      titles.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return titles;
}

describe("eval-service test shards", () => {
  it("pins every preserved suite and test title to one focused shard", () => {
    const shardNames = fs.readdirSync(TEST_DIRECTORY)
      .filter((name) => name.startsWith("eval-service-") && name.endsWith(".test.ts"))
      .sort();
    expect(shardNames).toEqual(Object.keys(EXPECTED_SHARDS).sort());
    expect(fs.existsSync(path.join(TEST_DIRECTORY, "eval-service.test.ts"))).toBe(false);

    for (const [name, expected] of Object.entries(EXPECTED_SHARDS)) {
      const filePath = path.join(TEST_DIRECTORY, name);
      const source = ts.createSourceFile(
        filePath,
        fs.readFileSync(filePath, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );
      expect(namedCalls(source, "describe"), name).toEqual([expected.describe]);
      expect(namedCalls(source, "it"), name).toEqual(expected.tests);
    }
  });
});
