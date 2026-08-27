#!/usr/bin/env node
// coeval MCP server (stdio) — issue #10.
//
// Exactly six tools, each a thin wrapper over the existing HTTP API via
// lib.mjs: get_findings, get_cases, get_golden, get_project, submit_runs,
// run_gate_check. Configuration is COEVAL_URL + COEVAL_API_KEY in the
// environment; the same protocol works against localhost or a hosted
// instance (the MCP layer is deliberately hosting-agnostic).
//
// Explicit non-goal, permanent: NO adjudicate / promote_golden tools. The MCP
// surface is read + submit. Human truth is created in the dashboard by
// humans; an agent-writable truth channel would quietly convert the whole
// governance model into self-grading.
//
// The API key is read from the environment and only ever sent as the bearer
// header — it is never echoed into tool results or error text.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createCoevalClient } from "./lib.mjs";

const server = new McpServer({ name: "coeval", version: "0.1.0" });

const exampleShape = {
  name: z.string().optional().describe("Display name for the case"),
  input: z.unknown().describe("The input the audited skill received"),
  output: z.unknown().describe("The output the audited skill produced"),
  expected: z.enum(["pass", "fail"]).optional().describe("Your ground-truth label for this input/output pair"),
  steps: z.array(z.object({
    name: z.string().optional(),
    input: z.unknown(),
    output: z.unknown(),
    metadata: z.record(z.string(), z.unknown()).optional()
  })).optional().describe("Optional agent-trajectory steps"),
  expectedFailStep: z.number().int().nonnegative().optional()
    .describe("0-based index of the step expected to fail (only with expected=fail)"),
  metadata: z.record(z.string(), z.unknown()).optional()
};

function tool(name, description, inputShape, invoke) {
  server.registerTool(name, { description, inputSchema: inputShape }, async (args) => {
    try {
      const coeval = createCoevalClient({
        baseUrl: process.env.COEVAL_URL ?? "",
        apiKey: process.env.COEVAL_API_KEY ?? ""
      });
      const result = await invoke(coeval, args ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `coeval: ${error instanceof Error ? error.message : String(error)}` }]
      };
    }
  });
}

tool(
  "get_findings",
  "Aggregated judgment intelligence for the project: human overrides of the judge, judge-vs-human disagreements, verdict distribution per stratum, deterministic failure clusters (grouped by normalized first sentence of rationales), and golden-set size/delta. Read-only.",
  { since: z.string().optional().describe("ISO-8601 cursor: count golden entries and overrides after this instant") },
  (coeval, args) => coeval.getFindings(args)
);

tool(
  "get_cases",
  "Project cases with FULL stored inputs/outputs (as ingested and redacted at write time) plus the latest judge and human verdicts — the exact material to re-run a skill patch on. Filterable by effective verdict, metadata.stratum, and creation time.",
  {
    verdict: z.string().optional().describe("Keep cases whose effective label (human overrides judge) equals this, e.g. pass/fail"),
    stratum: z.string().optional().describe("Keep cases whose metadata.stratum equals this"),
    since: z.string().optional().describe("ISO-8601: keep cases created strictly after this instant"),
    limit: z.number().int().positive().max(200) /* mirrors V1_CASES_MAX_LIMIT in @coeval/shared — keep in lockstep */.optional().describe("Max cases to return (default 50, max 200)")
  },
  (coeval, args) => coeval.getCases(args)
);

tool(
  "get_golden",
  "The project's golden set (locked human truth) with each entry's stored trace input/output — the inputs to build gate-check candidates from. Read-only; promotion happens in the dashboard, by humans.",
  {
    since: z.string().optional().describe("ISO-8601: only entries promoted strictly after this instant"),
    criterionVersionId: z.string().optional().describe("Pin to one criterion version (required when the project has several)")
  },
  (coeval, args) => coeval.getGolden(args)
);

tool(
  "get_project",
  "Connection check: project id, name, mode, and the active judging skill version. Costs one rate-limit token and no provider spend.",
  {},
  (coeval) => coeval.getProject()
);

tool(
  "submit_runs",
  "Submit input/output examples to the judge via the existing batch contract and wait for the run. Labels are optional; agreement is reported informationally. Re-submitting unchanged content reuses recorded verdicts (no provider spend).",
  {
    items: z.array(z.object(exampleShape)).min(1).describe("Examples to judge"),
    timeoutSeconds: z.number().positive().optional().describe("How long to wait for the run (default 300)")
  },
  (coeval, args) => coeval.submitRuns(args)
);

tool(
  "run_gate_check",
  "Validate a skill patch against locked truth: judge candidate outputs on labeled (typically golden) inputs, count disagreements, and report passed/blocked. An infrastructure failure never passes. This gates a proposal — it does not write truth.",
  {
    examples: z.array(z.object(exampleShape)).min(1).describe("Labeled examples; at least one must carry expected=pass|fail"),
    minAgreement: z.number().min(0).max(1).optional().describe("Required agreement fraction (default 1.0)"),
    timeoutSeconds: z.number().positive().optional().describe("How long to wait for the run (default 300)")
  },
  (coeval, args) => coeval.runGateCheck(args)
);

await server.connect(new StdioServerTransport());
