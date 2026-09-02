import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as appSupport from "./app-test-support.js";
import * as pgSupport from "./pg-smoke-support.js";

const TEST_DIRECTORY = fileURLToPath(new URL("./", import.meta.url));
const REPOSITORY_DIRECTORY = fileURLToPath(new URL("../../../", import.meta.url));
const VITEST_CLI = path.join(REPOSITORY_DIRECTORY, "node_modules/vitest/vitest.mjs");
const EXPECTED_SHARDS = {
  "app-suite-core.test.ts": {
    "suites": [
      "Coeval Hono API"
    ],
    "suiteSetup": [["const app = createApp();"]],
    "tests": [
      "returns health",
      "exposes retry guidance to cross-origin browser clients",
      "answers every pool-less bootstrap attempt with 501, never a misleading token error",
      "validates the public agent-bootstrap contract and provider-specific model fields",
      "reports a retryable rollback when headless setup removes its failed project",
      "isolates trusted-proxy bootstrap limits by client address",
      "returns golden-set health summary",
      "flags stale golden-set cases and caps the stale entry sample",
      "reports healthy and label-mix golden-set health states",
      "flags duplicate golden-set cases by trace ID",
      "enforces verdict-kind shape consistency on skill version + create input",
      "validates verdict payload shapes and rejects ill-formed inputs",
      "derives a comparable [0,1] score across every verdict kind",
      "projects verdict labels three-way: ambiguous survives, never folds into pass",
      "resolves the effective human label: adjudication outranks recency"
    ]
  },
  "app-suite-verdicts.test.ts": {
    "suites": [
      "Coeval Hono API"
    ],
    "tests": [
      "seeds demo verdicts when opted in, populating κ + both disagreement feeds",
      "records and filters v2 verdicts across sources via DemoRepository",
      "records human verdicts on a case via the /verdicts endpoint",
      "returns 404 when recording a verdict on a case not in this project",
      "adjudicates a disagreed case, annotating the feed and leaving κ untouched (A2.2b-2)",
      "rejects a scalar adjudication payload (can't resolve a discrete split)",
      "returns 404 when adjudicating a case not in this project",
      "runs the pinned evaluator on the server-selected uncovered adjudicated case",
      "deduplicates concurrent coverage-run requests before provider dispatch",
      "releases a failed coverage dispatch claim and durably records the successful retry",
      "skips coeval-internal traces on manual import (anti-recursion guard)",
      "skips coeval-internal traces in the LangSmith import worker"
    ]
  },
  "app-suite-review-queues.test.ts": {
    "suites": [
      "Coeval Hono API"
    ],
    "tests": [
      "creates and lists annotation queues with counters + per-item ordering",
      "rejects queue creation with cases that aren't in this project",
      "returns 404 for an unknown review-queue id",
      "auto-completes pending queue items when a human verdict is recorded",
      "closes + reopens queues; closed queues return null next-item even with pending rows",
      "close/reopen + next are 404 for unknown queue ids",
      "LLM-judge verdicts do NOT auto-complete pending queue items",
      "adds items with explicit reviewer assignment + dedups (queue_id, case_id, assignee)",
      "next-item filter: assignedTo=<user> returns assigned + unassigned, never other reviewers' items",
      "human verdicts complete only the verdicting reviewer's assigned items + unassigned items, leaving κ-partner rows pending",
      "adds-items returns 404 for unknown queue id + 400 for unknown case id",
      "validates queue input shape (empty caseIds, oversized name)",
      "exposes the κ summary over project human verdicts",
      "exposes the LLM-judge vs human calibration via /api/projects/judge-human-calibration",
      "returns 400 on a malformed verdict payload",
      "marks legacy verdict, adjudication, metric, export, and queue surfaces explicitly"
    ]
  },
  "app-suite-run-lifecycle.test.ts": {
    "suites": [
      "Coeval Hono API"
    ],
    "tests": [
      "PR #56/C5a: timeScope='new' (default) — async gate approves, no backfill",
      "records timeScope='both' backfill as one durable eval run after the gate passes",
      "records and completes the same backfill lifecycle in queue-less demo mode",
      "does not poison a Check with an empty backfill before its first Run arrives",
      "idempotently starts the first Result when a Check existed before its Runs",
      "puts a clean install's first imported Run in the same tracked Result lifecycle",
      "lets the owner keep polling a current starter draft that already queued its first Result",
      "converges concurrent first imports on durable runs without loose judge jobs",
      "uses one durable per-case run when concurrent import retries follow an existing Result",
      "does not claim an undispatched Result run is queued and recovers on retry",
      "rotates an exhausted deterministic queue id before marking a run dispatched",
      "PR #56/C5a: blocked gate leaves the version regressing and skips backfill even when timeScope=existing",
      "PR #59: GET /api/projects/verdicts returns project-scope verdicts with filter + limit",
      "PR #58: exports verdicts as JSONL with content-disposition + jsonl content-type",
      "PR #58: exports verdicts as CSV with RFC-4180-style quoting + filter query params",
      "PR #58: rejects invalid export query (bad format, source out of enum)",
      "imports a manual trace and enqueues one durable evaluation run",
      "does not call a terminal-failed import evaluation newly queued on retry",
      "keeps a Run saved but does not evaluate it if the current Check changes during import",
      "returns 400 before importing when no skill version exists",
      "returns 500 when skill lookup unexpectedly fails before importing"
    ]
  },
  "app-suite-golden-regression.test.ts": {
    "suites": [
      "Coeval Hono API",
      "golden-set regression"
    ],
    "suiteTestCounts": [4, 5],
    "tests": [
      "promotes a non-exception (judge-pass) case and surfaces the latest human label on detail",
      "promotes a runtime-judged case in demo mode (PG parity for pass anchors)",
      "drills into an exception and promotes it to the golden set",
      "returns 500 for unexpected golden-set retirement failures",
      "uses the injected judge provider instead of local keyword matching",
      "records a regress diff row when the new version disagrees with the golden label",
      "labels a still-agreeing case as agree (not improve) when the prior version also agreed, and reports 0 improved",
      "labels a case the new version fixed (prior disagreed → new agrees) as improve, and counts the flip",
      "caps the persisted per-case rationale length"
    ]
  },
  "app-suite-import-workers.test.ts": {
    "suites": [
      "judge worker",
      "LangSmith import worker",
      "LangSmith poller",
      "Langfuse import worker"
    ],
    "suiteTestCounts": [1, 7, 3, 2],
    "tests": [
      "processes queued judge jobs into judge runs",
      "imports LangSmith runs and enqueues judge jobs",
      "C7/B9: LangSmith end-to-end — import -> judge -> sync-back in one governed chain",
      "C7/B9: failure path — a sync-back error marks the job failed and stays retryable",
      "counts only net-new traces as imported on LangSmith retries",
      "keeps same import job net-new count across worker retries",
      "marks LangSmith import jobs completed or failed",
      "applies integration redaction rules during LangSmith import",
      "claims due integrations and enqueues import jobs once per interval",
      "skips disabled LangSmith polling integrations",
      "parses poll interval configuration defensively",
      "imports Langfuse traces and enqueues judge jobs",
      "claims due Langfuse integrations and enqueues import jobs once per interval"
    ]
  },
  "app-suite-feedback-integrations.test.ts": {
    "suites": [
      "feedback sync worker",
      "trust digest (M3 S4)",
      "judge model binding validation",
      "Ironside integration lifecycle"
    ],
    "suiteTestCounts": [2, 1, 1, 1],
    "tests": [
      "enqueues and posts LangSmith feedback for judged LangSmith cases",
      "enqueues and posts Langfuse feedback for judged Langfuse cases",
      "GET /api/trust-digest returns the four signals with honest empty states on the demo project",
      "validates model provider, custom endpoint, and temperature boundaries",
      "verifies an Ironside project before saving and rejects cross-project credential rotation"
    ]
  },
  "pg-smoke-core.test.ts": {
    "suites": [
      "PgRepository smoke"
    ],
    "tests": [
      "runs migrations and lists projects",
      "lists cases for the machine surface with stored payloads, since cursor, and scaffolding excluded",
      "release evidence migration round-trips caller identity, per-call provenance, and duplicate-case receipt coverage",
      "keeps imported-case evaluation unique and excludes scaffolding from customer Result probes",
      "M2 T1: steps[] round-trip — stored redacted in normalized_payload, served on the judge-bound trace",
      "M2 T2: SQL upsert invariant — pass clears expected_fail_step, fail-without-step keeps it (migration 0030)",
      "M2 T4: case-detail dataset expectations are project-scoped and exclude archived datasets",
      "M3 S1: judge keys encrypt at rest — raw key absent from the row, decrypts only via the worker loader (migration 0031)",
      "round-trips datasets and items (migration 0024)",
      "Skill Bench: mode roundtrip + integration graduation flip (migration 0029)",
      "Skill Bench: atomic examples ingestion — content-hash dedup + coalescing upsert (M0 C2/C3)"
    ]
  },
  "pg-smoke-evaluation.test.ts": {
    "suites": [
      "PgRepository smoke"
    ],
    "tests": [
      "async regression gate: pending insert -> gate.run worker -> recorded run + status flip (M0 C5a)",
      "round-trips eval-run counters with status-guard idempotency (migration 0025)",
      "creates one backfill eval run per Check under concurrent starts",
      "allows one evaluator lineage per criterion and multiple criteria per project",
      "never resolves a gate-blocked version as the current skill",
      "persists the per-case regression diff to the cases JSONB column (migration 0019)",
      "re-judges the golden set with the provider the version pins, not the mock fallback",
      "refuses to gate with the mock fallback and surfaces provider failures as typed errors",
      "imports a manual trace and records a judge run"
    ]
  },
  "pg-smoke-integrations.test.ts": {
    "suites": [
      "PgRepository smoke"
    ],
    "tests": [
      "processes judge.run jobs through the real pg-boss queue",
      "imports the same LangSmith run twice idempotently",
      "deduplicates Ironside snapshots by trace id and remote trace version",
      "stores PostgreSQL-unsafe Ironside payload strings without collisions or cursor poison",
      "does not replace a verified Ironside connection through create",
      "counts all net-new traces for the same import job across worker retries",
      "creates and completes a LangSmith feedback sync job",
      "parks and re-drives Ironside feedback after connection revalidation",
      "returns judged exceptions and promotes one to the golden set"
    ]
  },
  "pg-smoke-evidence.test.ts": {
    "suites": [
      "PgRepository smoke"
    ],
    "tests": [
      "prunes expired non-golden traces while preserving active golden cases",
      "deletes projects after confirmation and preserves anonymized audit history",
      "claims due LangSmith integrations for scheduled polling",
      "M4 C3: golden case maps to a SkillFormat example with NON-NULL redacted trace input+output",
      "product deploy gate: gate check rows persist, join the eval run, and derive passed/blocked/error"
    ]
  }
} as const;

interface DiscoveredSuite {
  title: string;
  tests: string[];
  setup: string[];
}

const SUITE_COLLECTORS = new Set(["describe", "runPgSmoke", "suite"]);
const TEST_COLLECTORS = new Set(["it", "test"]);

function literalTitle(node: ts.Expression | undefined, fileName: string): string {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  throw new Error(`${fileName}: test and suite titles must be static string literals`);
}

function collectorName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {
    if (SUITE_COLLECTORS.has(expression.text) || TEST_COLLECTORS.has(expression.text)) return expression.text;
    return undefined;
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const root = expression.expression;
    if (ts.isIdentifier(root) && (SUITE_COLLECTORS.has(root.text) || TEST_COLLECTORS.has(root.text))) {
      throw new Error(`${expression.getSourceFile().fileName}: collector modifiers and property access are not inventory-safe`);
    }
  }
  return undefined;
}

function assertDirectCollectorBindings(source: ts.SourceFile): void {
  const vitestImports = source.statements.filter((statement): statement is ts.ImportDeclaration =>
    ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === "vitest"
  );
  if (vitestImports.length !== 1) throw new Error(`${source.fileName}: exactly one Vitest import is required`);
  const vitestImport = vitestImports[0];
  const bindings = vitestImport?.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) throw new Error(`${source.fileName}: named Vitest imports are required`);
  for (const binding of bindings.elements) {
    if (binding.propertyName || !["describe", "expect", "it", "vi"].includes(binding.name.text)) {
      throw new Error(`${source.fileName}: Vitest imports must be direct describe, expect, it, or vi bindings`);
    }
  }
}

function discoverSuites(source: ts.SourceFile): DiscoveredSuite[] {
  assertDirectCollectorBindings(source);
  const suites: DiscoveredSuite[] = [];

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) continue;
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
      throw new Error(`${source.fileName}: top level may contain only imports and direct suites`);
    }
    const call = statement.expression;
    const name = collectorName(call.expression);
    if (!name || !SUITE_COLLECTORS.has(name)) {
      throw new Error(`${source.fileName}: top-level calls must be recognized suite collectors`);
    }
    const callback = [call.arguments[1], call.arguments[2]].find((argument): argument is ts.ArrowFunction | ts.FunctionExpression =>
      Boolean(argument) && (ts.isArrowFunction(argument!) || ts.isFunctionExpression(argument!))
    );
    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) || !ts.isBlock(callback.body)) {
      throw new Error(`${source.fileName}: suites must use a direct block callback`);
    }
    const suite: DiscoveredSuite = { title: literalTitle(call.arguments[0], source.fileName), tests: [], setup: [] };
    for (const child of callback.body.statements) {
      if (ts.isVariableStatement(child)) {
        suite.setup.push(child.getText(source).replace(/\s+/g, " ").trim());
        continue;
      }
      if (!ts.isExpressionStatement(child) || !ts.isCallExpression(child.expression)) {
        throw new Error(`${source.fileName}: suite bodies may contain only pinned setup declarations and direct tests`);
      }
      const childName = collectorName(child.expression.expression);
      if (childName && SUITE_COLLECTORS.has(childName)) {
        throw new Error(`${source.fileName}: nested suites are not inventory-safe`);
      }
      if (!childName || !TEST_COLLECTORS.has(childName)) {
        throw new Error(`${source.fileName}: suite-body calls must be recognized test collectors`);
      }
      suite.tests.push(literalTitle(child.expression.arguments[0], source.fileName));
    }
    suites.push(suite);
  }
  return suites;
}

describe("large API test shards", () => {
  it("pins every preserved suite and test title to one focused file", () => {
    const expectedNames = Object.keys(EXPECTED_SHARDS).sort();
    const actualNames = fs.readdirSync(TEST_DIRECTORY).filter((name) =>
      (name.startsWith("app-suite-") || name.startsWith("pg-smoke-")) && name.endsWith(".test.ts")
    ).sort();
    expect(actualNames).toEqual(expectedNames);
    expect(fs.existsSync(path.join(TEST_DIRECTORY, "app.test.ts"))).toBe(false);
    expect(fs.existsSync(path.join(TEST_DIRECTORY, "pg-smoke.test.ts"))).toBe(false);
    for (const [name, expected] of Object.entries(EXPECTED_SHARDS)) {
      const filePath = path.join(TEST_DIRECTORY, name);
      const source = ts.createSourceFile(
        filePath,
        fs.readFileSync(filePath, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );
      const suites = discoverSuites(source);
      expect(suites.map((suite) => suite.title), name).toEqual(expected.suites);
      expect(suites.flatMap((suite) => suite.tests), name).toEqual(expected.tests);
      const expectedCounts = "suiteTestCounts" in expected
        ? expected.suiteTestCounts
        : [expected.tests.length];
      expect(suites.map((suite) => suite.tests.length), name).toEqual(expectedCounts);
      const expectedSetup = "suiteSetup" in expected
        ? expected.suiteSetup
        : expected.suites.map(() => []);
      expect(suites.map((suite) => suite.setup), name).toEqual(expectedSetup);
    }
  });

  it("matches the exact tests Vitest collects after every imported module runs", () => {
    const shardNames = Object.keys(EXPECTED_SHARDS);
    const output = execFileSync(process.execPath, [
      VITEST_CLI,
      "list",
      ...shardNames.map((name) => path.join(TEST_DIRECTORY, name)),
      "--json"
    ], {
      cwd: REPOSITORY_DIRECTORY,
      encoding: "utf8",
      env: {
        ...process.env,
        // Collection never runs a test or opens a pool; a nonempty placeholder
        // makes the smoke suites visible when a developer has no local PG URL.
        PG_SMOKE_DATABASE_URL: process.env.PG_SMOKE_DATABASE_URL ?? "postgresql://collection.invalid/coeval"
      },
      maxBuffer: 4 * 1024 * 1024
    });
    const collected = JSON.parse(output) as Array<{ file: string; name: string }>;
    expect(collected).toHaveLength(125);
    for (const [name, expected] of Object.entries(EXPECTED_SHARDS)) {
      const counts = "suiteTestCounts" in expected
        ? expected.suiteTestCounts
        : [expected.tests.length];
      let testIndex = 0;
      const expectedNames: string[] = [];
      for (const [suiteIndex, suite] of expected.suites.entries()) {
        const count = counts[suiteIndex] ?? 0;
        expectedNames.push(...expected.tests.slice(testIndex, testIndex + count).map((test) => `${suite} > ${test}`));
        testIndex += count;
      }
      expect(testIndex, `${name} suite counts`).toBe(expected.tests.length);
      expect(
        collected.filter((entry) => path.basename(entry.file) === name).map((entry) => entry.name),
        name
      ).toEqual(expectedNames);
    }
    expect(new Set(collected.map((entry) => path.basename(entry.file))).size).toBe(shardNames.length);
  }, 30_000);

  it("rejects collector aliases, modifiers, nesting, and indirect test placement", () => {
    const fixture = (text: string): ts.SourceFile => ts.createSourceFile(
      "collector-fixture.test.ts",
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    expect(discoverSuites(fixture(`
      import { describe, it } from "vitest";
      describe("suite", { timeout: 1000 }, () => {
        it(\`template title\`, () => {
          const test = () => ({ it: true, describe: true });
          return test().it;
        });
      });
    `))).toEqual([{ title: "suite", tests: ["template title"], setup: [] }]);
    for (const source of [
      `import { describe, it as check } from "vitest"; describe("suite", () => { check("test", () => {}); });`,
      `import * as vitest from "vitest"; vitest.describe("suite", () => { vitest.it("test", () => {}); });`,
      `import { describe, it } from "vitest"; describe("suite", () => { const check = it; check("test", () => {}); });`,
      `import { describe, it } from "vitest"; describe("suite", () => { it.each([[1]])("test", () => {}); });`,
      `import { describe, it } from "vitest"; describe("outer", () => { describe("inner", () => { it("test", () => {}); }); });`,
      `import { describe, it } from "vitest"; describe("suite", () => { if (true) it("test", () => {}); });`,
      `import { describe, it } from "vitest"; import { register } from "./helper.js"; describe("suite", () => { it("test", () => {}); register("hidden"); });`,
      `import { describe, it } from "vitest"; import { register } from "./helper.js"; register("hidden"); describe("suite", () => { it("test", () => {}); });`
    ]) {
      expect(() => discoverSuites(fixture(source))).toThrow();
    }
  });

  it("keeps shared test support explicit and the PostgreSQL runner on every smoke shard", () => {
    expect(Object.keys(appSupport).sort()).toEqual([
      "BlockedIronsideFeedbackRepository",
      "CapturingQueue",
      "EmptySkillRepository",
      "FailingOnceQueue",
      "PurposeCapturingRepository"
    ]);
    expect(Object.keys(pgSupport).sort()).toEqual([
      "CapturingQueue",
      "FailingOnceQueue",
      "runPgSmoke",
      "seedCriterion",
      "seedSkill",
      "waitFor"
    ]);
    const pgConfig = fs.readFileSync(path.join(TEST_DIRECTORY, "../../../vitest.pg.config.ts"), "utf8");
    expect(pgConfig).toContain('"apps/api/test/pg-smoke-*.test.ts"');
    expect(pgConfig).not.toContain('"apps/api/test/pg-smoke.test.ts"');
  });
});
