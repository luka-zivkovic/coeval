import { z } from "zod";

import {
  HttpUrlSchema,
  StoredModelBindingSchema,
  UnicodeScalarValueSchema
} from "./judge.js";
import { PROJECT_NAME_MAX_LENGTH, ProjectModeSchema } from "./projects.js";
import { ManualTraceImportInputSchema } from "./traces.js";

// API keys for the eval-as-a-service surface. The raw secret is never returned
// after creation — only this metadata + a non-secret prefix for identification.
// BYO judge provider keys. The raw key is never in any schema that a
// client can receive — keyDisplay is the only renderable form.
export const JudgeKeyProviderSchema = z.enum(["anthropic", "openai", "openrouter", "custom"]);
export type JudgeKeyProvider = z.infer<typeof JudgeKeyProviderSchema>;

export const JudgeProviderKeySchema = z.object({
  provider: JudgeKeyProviderSchema,
  keyDisplay: z.string(),
  createdAt: z.string()
});
export type JudgeProviderKey = z.infer<typeof JudgeProviderKeySchema>;

export const SetJudgeProviderKeyInputSchema = z.object({
  apiKey: z.string().trim().min(8).max(512)
});
export type SetJudgeProviderKeyInput = z.infer<typeof SetJudgeProviderKeyInputSchema>;

export const ApiKeySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable()
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

export const CreateApiKeyInputSchema = z.object({
  name: z.string().min(1).max(120)
});
export type CreateApiKeyInput = z.infer<typeof CreateApiKeyInputSchema>;

// Returned once, on mint — carries the plaintext `key` alongside the record.
export const CreatedApiKeySchema = ApiKeySchema.extend({ key: z.string() });
export type CreatedApiKey = z.infer<typeof CreatedApiKeySchema>;

export const SetupResponseSchema = z.object({
  ok: z.literal(true),
  projectId: z.string(),
  // Workspace reuse returns the committed project without minting another
  // one-time key. Keep that current response variant explicit.
  apiKey: CreatedApiKeySchema.optional()
}).strict();
export type SetupResponse = z.infer<typeof SetupResponseSchema>;

// An external agent may scaffold a judge and submit runs, while human labels
// and golden-set promotion remain outside the project-key surface. Pairing
// configures the human's existing onboarding project; the optional headless
// deployment-token fallback creates a bench project.
// Keyed providers plus the explicit 'mock' pin. The runtime's missing-
// credential hint tells agents to pin provider "mock" explicitly for
// keyless wiring tests, so the bootstrap input must accept it (issue #150).
// Mock stays explicit-only: strict judge paths still refuse to SILENTLY
// degrade a real-provider binding to mock verdicts.
export const AgentBootstrapProviderSchema = z.enum([...JudgeKeyProviderSchema.options, "mock"]);
export type AgentBootstrapProvider = z.infer<typeof AgentBootstrapProviderSchema>;

export const AgentBootstrapModelInputSchema = z
  .object({
    provider: AgentBootstrapProviderSchema,
    // Optional for catalog providers (server pins the first available model)
    // and for mock (the built-in heuristic has one model). Required for custom.
    modelId: z.string().trim().min(1).max(240).optional(),
    temperature: z.number().min(0).max(2).default(0),
    baseUrl: HttpUrlSchema.optional()
  })
  .superRefine((model, ctx) => {
    if (model.provider === "custom") {
      if (!model.baseUrl) {
        ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "custom providers require an OpenAI-compatible baseUrl" });
      }
      if (!model.modelId) {
        ctx.addIssue({ code: "custom", path: ["modelId"], message: "custom providers require an explicit modelId" });
      }
    } else if (model.baseUrl !== undefined) {
      ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "baseUrl is only valid for custom providers" });
    }
  });
export type AgentBootstrapModelInput = z.infer<typeof AgentBootstrapModelInputSchema>;

export const AgentBootstrapRequestSchema = z.object({
  owner: z.object({
    email: z.string().email(),
    // Required only while creating the instance's first owner. Existing
    // owners are selected by email and need no password in this request.
    password: z.string().min(8).optional(),
    name: z.string().trim().min(1).max(120).optional()
  }),
  project: z.object({
    name: z.string().trim().min(1).max(PROJECT_NAME_MAX_LENGTH),
    apiKeyName: z.string().trim().min(1).max(120).default("Agent bootstrap")
  }),
  // The beginner-visible quality question. Agent bootstrap must append this
  // exact immutable criterion definition and bind the evaluator version to it;
  // hiding it only inside rubricMarkdown would leave a generic seeded
  // criterion underneath a more specific visible Check.
  check: z.object({
    name: UnicodeScalarValueSchema.trim().min(1).max(200),
    question: UnicodeScalarValueSchema.trim().min(1).max(20_000)
  }).strict(),
  skill: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    rubricMarkdown: z.string().trim().min(1).max(100_000),
    // Omit for the safe built-in prompt that references the rubric. A supplied
    // prompt is accepted only after the endpoint's diagnostic validation.
    prompt: z.string().trim().min(1).max(100_000).optional(),
    model: AgentBootstrapModelInputSchema
  }),
  // Optional project-scoped provider credential. If omitted, the deployment's
  // provider environment key must exist. This secret is stored encrypted and
  // is never returned in the response.
  providerApiKey: z.string().trim().min(8).max(512).optional()
}).superRefine((request, ctx) => {
  // The mock judge takes no credential — a key sent alongside it is a caller
  // mistake (probably meant a real provider); reject instead of silently
  // storing or dropping the secret.
  if (request.skill.model.provider === "mock" && request.providerApiKey !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["providerApiKey"],
      message: "providerApiKey is not valid when pinning provider \"mock\" — the mock judge takes no credential"
    });
  }
});
export type AgentBootstrapRequest = z.infer<typeof AgentBootstrapRequestSchema>;

// "Connect your agent" wiring snippets (issue #15). One builder feeds three
// surfaces — Settings → API keys (fresh key pre-filled at the mint moment,
// placeholder afterwards), the bootstrap completion response, and the
// coeval-audit setup script's printed next-steps — so the copy-paste forms
// cannot drift from tools/mcp/README.md's contract. The paths keep the
// README's /path/to/coeval placeholder: no surface knows the user's checkout.
export const AGENT_CONNECT_KEY_PLACEHOLDER = "<your key>";

// The governance boundary, said where it is felt: the project-key surface is
// read + submit only. Adjudication and golden promotion stay human-only.
export const AGENT_CONNECT_BOUNDARY_LINE =
  "Your agent can read findings and submit runs; it can never adjudicate or promote — that stays here, with you.";

const AGENT_CONNECT_MCP_SERVER_PATH = "/path/to/coeval/tools/mcp/index.mjs";
const AGENT_CONNECT_CLI_PATH = "/path/to/coeval/skills/coeval-audit/scripts/coeval-submit.mjs";

export const AgentConnectSnippetsSchema = z.object({
  claudeCode: z.string(),
  mcpJson: z.string(),
  cli: z.string()
});
export type AgentConnectSnippets = z.infer<typeof AgentConnectSnippetsSchema>;

export function buildAgentConnectSnippets(input: { apiBaseUrl: string; apiKey?: string }): AgentConnectSnippets {
  const url = input.apiBaseUrl.replace(/\/+$/, "");
  const key = input.apiKey ?? AGENT_CONNECT_KEY_PLACEHOLDER;
  // The shell forms double-quote the key slot so the placeholder's angle
  // brackets can never reach the shell as redirection when pasted unedited.
  // A real key is coeval_sk_ + base64url, so the quotes are inert — and
  // coeval-submit's masked echo becomes "$VAR", which still expands.
  const shellKey = `"${key}"`;
  return {
    claudeCode: `claude mcp add coeval --env COEVAL_URL=${url} --env COEVAL_API_KEY=${shellKey} -- node ${AGENT_CONNECT_MCP_SERVER_PATH}`,
    // Built through JSON.stringify so the pasted block is always valid JSON,
    // whatever characters the key or URL contain.
    mcpJson: JSON.stringify(
      {
        mcpServers: {
          coeval: {
            command: "node",
            args: [AGENT_CONNECT_MCP_SERVER_PATH],
            env: { COEVAL_URL: url, COEVAL_API_KEY: key }
          }
        }
      },
      null,
      2
    ),
    cli: [
      `export COEVAL_URL=${url}`,
      `export COEVAL_API_KEY=${shellKey}`,
      `node ${AGENT_CONNECT_CLI_PATH} findings`,
      `node ${AGENT_CONNECT_CLI_PATH} submit results.jsonl`
    ].join("\n")
  };
}

export const AgentBootstrapResponseSchema = z.object({
  projectId: z.string(),
  skillId: z.string(),
  skillVersionId: z.string(),
  check: z.object({
    criterionId: z.string().min(1),
    criterionVersionId: z.string().min(1),
    name: z.string().min(1),
    question: z.string().min(1),
    digest: z.string().startsWith("sha256:")
  }).strict(),
  mode: ProjectModeSchema,
  rubricProvenance: z.literal("agent-drafted"),
  modelBinding: StoredModelBindingSchema,
  apiKey: CreatedApiKeySchema,
  // Ready-to-paste wiring with the one-time key pre-filled — the same plaintext
  // already travels in `apiKey.key`, so headless setups end wired, not just
  // keyed. Clients that PRINT these must mask the key first (coeval-submit
  // substitutes the saved env-var name).
  connect: AgentConnectSnippetsSchema,
  next: z.object({
    judgeBatchPath: z.literal("/api/v1/judge/batch"),
    humanReviewPath: z.literal("/exceptions"),
    gateBoundary: z.literal("human-only")
  })
});
export type AgentBootstrapResponse = z.infer<typeof AgentBootstrapResponseSchema>;

export const AgentSetupPairingStatusSchema = z.enum(["pending", "claimed", "completed", "expired", "revoked"]);
export type AgentSetupPairingStatus = z.infer<typeof AgentSetupPairingStatusSchema>;

export const AgentSetupPairingSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  ownerEmail: z.string().email(),
  apiBaseUrl: HttpUrlSchema,
  expiresAt: z.string(),
  claimExpiresAt: z.string().nullable().default(null),
  status: AgentSetupPairingStatusSchema
});
export type AgentSetupPairing = z.infer<typeof AgentSetupPairingSchema>;

// The plaintext pairing token is returned exactly once when the signed-in
// project owner creates it. Status reads expose metadata only.
export const CreatedAgentSetupPairingSchema = AgentSetupPairingSchema.extend({
  token: z.string().startsWith("coeval_pair_")
});
export type CreatedAgentSetupPairing = z.infer<typeof CreatedAgentSetupPairingSchema>;

// Body for POST /api/v1/judge — the eval-as-a-service request. `trace` reuses
// the manual-import shape; `skillVersionId` is optional (defaults to the
// project's current skill version).
export const JudgeServiceRequestSchema = z.object({
  trace: ManualTraceImportInputSchema,
  skillVersionId: z.string().min(1).optional(),
  // Re-POSTing a trace the project has already judged returns the recorded
  // verdict (200, cached: true) instead of burning provider tokens on a
  // client retry. `force: true` bypasses the cache — the path self-consistency
  // probes use to collect intentional repeat verdicts.
  force: z.boolean().optional()
});
export type JudgeServiceRequest = z.infer<typeof JudgeServiceRequestSchema>;
