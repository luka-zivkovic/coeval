import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  defaultJudgePromptTemplate,
  MinimumVerdictOutputSchema,
  STARTER_RUBRIC_MARKER,
  type CreatedApiKey,
  type ProjectMode
} from "@coeval/shared";
import { betterAuth } from "better-auth";
import { generateApiKey } from "./api-keys.js";
import { evaluatorSuiteCriterionDigest } from "./evaluator-suite.js";

// Origins allowed to talk to the API: CORS (app.ts) and better-auth's own
// origin check both read this. They MUST stay one list — when they disagree,
// login fails with "Invalid origin" even though CORS lets the request through.
export function parseTrustedOrigins(value: string | undefined = process.env.TRUSTED_ORIGINS): string[] {
  return (value ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function createAuth(pool: Pool) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET is required when running with auth enabled (DATABASE_URL set). Generate one with: openssl rand -base64 32"
    );
  }
  return betterAuth({
    database: pool,
    secret,
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:8787",
    // Without this, better-auth only trusts its own baseURL origin and the
    // web dev server (a different origin) gets "Invalid origin" on every
    // sign-in. The same env var drives CORS in app.ts.
    trustedOrigins: parseTrustedOrigins(),
    emailAndPassword: {
      enabled: true,
      autoSignIn: true
    },
    user: {
      fields: {
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at"
      }
    },
    session: {
      fields: {
        userId: "user_id",
        expiresAt: "expires_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        createdAt: "created_at",
        updatedAt: "updated_at"
      }
    },
    account: {
      fields: {
        userId: "user_id",
        accountId: "account_id",
        providerId: "provider_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at"
      }
    },
    verification: {
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at"
      }
    },
    advanced: {
      database: {
        generateId: () => randomUUID()
      }
    }
  });
}

export type CoevalAuth = ReturnType<typeof createAuth>;

export async function countUsers(pool: Pool): Promise<number> {
  const result = await pool.query(`select count(*)::int as count from "user"`);
  return Number(result.rows[0]?.count ?? 0);
}

export async function setupRequired(pool: Pool): Promise<boolean> {
  return (await countUsers(pool)) === 0;
}

export async function bootstrapOwnerUserByEmail(
  pool: Pool,
  email: string
): Promise<{ id: string; email: string; name: string } | null> {
  const result = await pool.query(
    `select u.id, u.email, u.name
     from "user" u
     where lower(u.email) = lower($1)
       and (
         exists (
           select 1 from organization_members om
           where om.user_id = u.id and om.role = 'owner'
         )
         -- Recover an initial owner whose prior bootstrap created the auth
         -- account but failed before organization/project creation committed.
         or not exists (
           select 1 from organization_members om where om.user_id = u.id
         )
       )
     limit 1`,
    [email]
  );
  const row = result.rows[0];
  return row ? { id: String(row.id), email: String(row.email), name: String(row.name) } : null;
}

const AGENT_SETUP_PAIRING_TTL_MS = 15 * 60_000;
export const AGENT_SETUP_PAIRING_CLAIM_GRACE_MS = 10 * 60_000;

// Lifecycle predicates, single-sourced: hand-repeating these across queries is
// exactly how the expired-but-running drift shipped (an in-progress check that
// required expires_at > now() while a claimed bootstrap kept running past it).
// A pairing is OPEN until consumed or revoked. A claim counts as RUNNING for a
// bounded grace window from claimed_at, independent of the token's expiry — a
// bootstrap that claimed at minute 14 is still alive at minute 16, and
// regenerating/revoking under it would let two agents configure one project.
// After the grace window an unfinished claim is treated as abandoned.
const PAIRING_OPEN_SQL = `consumed_at is null and revoked_at is null`;
const PAIRING_CLAIM_RUNNING_SQL = `claimed_at is not null and claimed_at > now() - interval '${AGENT_SETUP_PAIRING_CLAIM_GRACE_MS / 1000} seconds'`;

export interface AgentSetupPairingRecord {
  id: string;
  projectId: string;
  projectName: string;
  createdByUserId: string;
  ownerEmail: string;
  ownerName: string;
  expiresAt: string;
  claimedAt: string | null;
  consumedAt: string | null;
  revokedAt: string | null;
}

export class AgentSetupPairingInProgressError extends Error {
  constructor() {
    super("An agent setup is already running for this project.");
    this.name = "AgentSetupPairingInProgressError";
  }
}

export async function createAgentSetupPairing(
  pool: Pool,
  input: { projectId: string; createdByUserId: string }
): Promise<AgentSetupPairingRecord & { token: string }> {
  const token = `coeval_pair_${randomBytes(32).toString("base64url")}`;
  const id = `pair_${randomUUID()}`;
  const expiresAt = new Date(Date.now() + AGENT_SETUP_PAIRING_TTL_MS);
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Serialize regeneration per project. Without locking the stable project
    // row, two simultaneous clicks could each miss the other's uncommitted
    // token and leave two live capabilities.
    const project = await client.query(`select id from projects where id = $1 for update`, [input.projectId]);
    if (!project.rowCount) throw new Error(`Project not found: ${input.projectId}`);
    const inProgress = await client.query(
      `select id from agent_setup_pairings
       where project_id = $1 and ${PAIRING_OPEN_SQL} and ${PAIRING_CLAIM_RUNNING_SQL}
       limit 1`,
      [input.projectId]
    );
    if (inProgress.rowCount) throw new AgentSetupPairingInProgressError();
    // A newly generated connection replaces older outstanding connections
    // for this project so the UI always has exactly one live secret.
    await client.query(
      `update agent_setup_pairings
       set revoked_at = now(), claimed_at = null
       where project_id = $1 and ${PAIRING_OPEN_SQL}`,
      [input.projectId]
    );
    await client.query(
      `insert into agent_setup_pairings
       (id, project_id, created_by_user_id, token_hash, expires_at)
       values ($1,$2,$3,$4,$5)`,
      [id, input.projectId, input.createdByUserId, hashAgentSetupToken(token), expiresAt]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  const pairing = await getAgentSetupPairing(pool, { id, projectId: input.projectId });
  if (!pairing) throw new Error(`Agent setup pairing was not persisted: ${id}`);
  return { ...pairing, token };
}

export async function resolveAgentSetupPairing(pool: Pool, token: string): Promise<AgentSetupPairingRecord | null> {
  const result = await pool.query(
    `select asp.*, p.name as project_name, u.email as owner_email, u.name as owner_name
     from agent_setup_pairings asp
     join projects p on p.id = asp.project_id
     join "user" u on u.id = asp.created_by_user_id
     where asp.token_hash = $1
       and asp.expires_at > now()
       and asp.consumed_at is null
       and asp.revoked_at is null
       and exists (
         select 1 from project_members pm
         where pm.project_id = asp.project_id
           and pm.user_id = asp.created_by_user_id
           and pm.role = 'owner'
       )
     limit 1`,
    [hashAgentSetupToken(token)]
  );
  return result.rows[0] ? rowToAgentSetupPairing(result.rows[0]) : null;
}

export async function claimAgentSetupPairing(pool: Pool, id: string): Promise<boolean> {
  const result = await pool.query(
    `update agent_setup_pairings
     set claimed_at = now()
     where id = $1
       and expires_at > now()
       and consumed_at is null
       and revoked_at is null
       and claimed_at is null`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function releaseAgentSetupPairing(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `update agent_setup_pairings set claimed_at = null
     where id = $1 and ${PAIRING_OPEN_SQL}`,
    [id]
  );
}

// Returns false when the pairing was revoked or already consumed out from
// under the running bootstrap — the caller decides whether that matters.
export async function completeAgentSetupPairing(pool: Pool, id: string): Promise<boolean> {
  const result = await pool.query(
    `update agent_setup_pairings
     set consumed_at = now(), claimed_at = null
     where id = $1 and ${PAIRING_OPEN_SQL}`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

// Internal invalidation after the atomic bootstrap eligibility check proves
// the project changed. Unlike the owner-facing revoke action, this may close
// the claim currently owned by this request.
export async function invalidateAgentSetupPairing(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `update agent_setup_pairings
     set revoked_at = now(), claimed_at = null
     where id = $1 and ${PAIRING_OPEN_SQL}`,
    [id]
  );
}

export async function revokeAgentSetupPairing(pool: Pool, input: { id: string; projectId: string }): Promise<boolean> {
  // Unclaimed pairings and ABANDONED claims (grace window passed) are
  // revocable; only an actively running claim resists, so an owner is never
  // stuck behind an agent that died mid-setup.
  const result = await pool.query(
    `update agent_setup_pairings set revoked_at = now(), claimed_at = null
     where id = $1 and project_id = $2
       and ${PAIRING_OPEN_SQL}
       and not (${PAIRING_CLAIM_RUNNING_SQL})`,
    [input.id, input.projectId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getAgentSetupPairing(
  pool: Pool,
  input: { id: string; projectId: string }
): Promise<AgentSetupPairingRecord | null> {
  const result = await pool.query(
    `select asp.*, p.name as project_name, u.email as owner_email, u.name as owner_name
     from agent_setup_pairings asp
     join projects p on p.id = asp.project_id
     join "user" u on u.id = asp.created_by_user_id
     where asp.id = $1 and asp.project_id = $2
     limit 1`,
    [input.id, input.projectId]
  );
  return result.rows[0] ? rowToAgentSetupPairing(result.rows[0]) : null;
}

function rowToAgentSetupPairing(row: Record<string, unknown>): AgentSetupPairingRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    projectName: String(row.project_name),
    createdByUserId: String(row.created_by_user_id),
    ownerEmail: String(row.owner_email),
    ownerName: String(row.owner_name),
    expiresAt: new Date(row.expires_at as string | number | Date).toISOString(),
    claimedAt: row.claimed_at ? new Date(row.claimed_at as string | number | Date).toISOString() : null,
    consumedAt: row.consumed_at ? new Date(row.consumed_at as string | number | Date).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at as string | number | Date).toISOString() : null
  };
}

function hashAgentSetupToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function ensureWorkspaceForUser(pool: Pool, input: {
  userId: string;
  email: string;
  owner: boolean;
  projectName?: string;
  mode?: ProjectMode;
  apiKeyName?: string;
}): Promise<{ organizationId: string; projectId: string; apiKey?: CreatedApiKey }> {
  const existing = await pool.query(
    `select p.id as project_id, p.organization_id
     from projects p
     join project_members pm on pm.project_id = p.id
     where pm.user_id = $1
     order by p.created_at asc
     limit 1`,
    [input.userId]
  );
  if (existing.rows[0]) {
    return { organizationId: existing.rows[0].organization_id, projectId: existing.rows[0].project_id };
  }

  const organizationId = `org_${randomUUID()}`;
  const projectId = `proj_${randomUUID()}`;
  const skillId = `skill_${randomUUID()}`;
  const skillVersionId = `skillv_${randomUUID()}`;
  const role = input.owner ? "owner" : "member";
  let apiKey: CreatedApiKey | undefined;

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`insert into organizations (id, name) values ($1, $2)`, [organizationId, `${input.email.split("@")[0]}'s organization`]);
    await client.query(`insert into organization_members (id, organization_id, user_id, role) values ($1, $2, $3, $4)`, [
      `orgmem_${randomUUID()}`,
      organizationId,
      input.userId,
      role
    ]);
    await insertProjectWithStarterSkill(client, {
      organizationId,
      projectId,
      skillId,
      skillVersionId,
      name: input.projectName?.trim() || "Default Project",
      userId: input.userId,
      role,
      ...(input.mode ? { mode: input.mode } : {})
    });
    if (input.apiKeyName) {
      apiKey = await insertProjectApiKey(client, {
        projectId,
        name: input.apiKeyName,
        createdByUserId: input.userId
      });
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  return { organizationId, projectId, ...(apiKey ? { apiKey } : {}) };
}

// One project = one agent, one stream of traces, one judging skill. Every
// project starts with the starter draft rubric so judging begins on arrival
// (verdicts marked provisional until sign-off).
async function insertProjectWithStarterSkill(
  client: PoolClient,
  input: {
    organizationId: string;
    projectId: string;
    skillId: string;
    skillVersionId: string;
    name: string;
    userId: string;
    role: string;
    mode?: ProjectMode;
  }
): Promise<void> {
  // The seed text is mode-aware: a user who just chose "judge a dataset or
  // agent skill" must not land in an editor pre-filled with a skill about
  // judging imported traces. Vocabulary only — the richer starter templates
  // stay a web-bundle concern (apps/web/src/lib/starter-skills.ts) so there
  // is no second catalog to drift.
  const bench = (input.mode ?? "tracing") === "bench";
  const criterionId = `criterion_${randomUUID()}`;
  const criterionVersionId = `criterionv_${randomUUID()}`;
  const criterionName = "Default Review Skill";
  const criterionDefinition = bench
    ? "Starter criterion for judging supplied examples."
    : "Starter criterion for judging imported traces.";
  const skillDescription = bench
    ? "Starter skill for judging supplied examples."
    : "Starter skill for judging imported traces.";
  await client.query(
    `insert into projects (id, organization_id, name, trace_provider, mode) values ($1, $2, $3, $4, $5)`,
    [input.projectId, input.organizationId, input.name, "manual", input.mode ?? "tracing"]
  );
  await client.query(`insert into project_members (id, project_id, user_id, role) values ($1, $2, $3, $4)`, [
    `projmem_${randomUUID()}`,
    input.projectId,
    input.userId,
    input.role
  ]);
  await client.query(
    `insert into criteria
       (id, project_id, stable_key, source_kind, created_by_user_id)
     values ($1, $2, $3, 'native', $4)`,
    [criterionId, input.projectId, "default-review", input.userId]
  );
  await client.query(
    `insert into criterion_versions
       (id, project_id, criterion_id, revision, name, definition,
        criterion_digest, source_kind, created_by_user_id)
     values ($1, $2, $3, 1, $4, $5, $6, 'native', $7)`,
    [
      criterionVersionId,
      input.projectId,
      criterionId,
      criterionName,
      criterionDefinition,
      evaluatorSuiteCriterionDigest({
        criterionId,
        criterionVersionId,
        criterionName,
        criterionDefinition
      }),
      input.userId
    ]
  );
  await client.query(
    `insert into skills
       (id, project_id, name, description, owner_user_id, status, is_starter, criterion_id)
     values ($1, $2, $3, $4, $5, $6, true, $7)`,
    [
      input.skillId,
      input.projectId,
      criterionName,
      skillDescription,
      input.userId,
      "draft",
      criterionId
    ]
  );
  await client.query(
    `insert into skill_versions
     (id, skill_id, project_id, version, status, rubric_markdown, prompt, output_schema,
      model_binding, criterion_version_id, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
    [
      input.skillVersionId,
      input.skillId,
      input.projectId,
      "0.1.0",
      "draft",
      `# Default Review Skill\n\n${STARTER_RUBRIC_MARKER}.`,
      defaultJudgePromptTemplate(bench ? "case" : "trace"),
      JSON.stringify(MinimumVerdictOutputSchema),
      // NOT the mock: this path only runs with a real database, where the mock
      // is forbidden (app.ts refuses to save it and availability reports it
      // unavailable) — seeding it would silently judge production traces with
      // the heuristic. Seed the first-class default instead; if no key is
      // configured the strict worker fails the run loudly and the editor
      // steers the user to a provider they have actually configured.
      JSON.stringify({ provider: "anthropic", modelId: "claude-sonnet-4-6", modelVersion: "claude-sonnet-4-6", temperature: 0 }),
      criterionVersionId
    ]
  );
}

// P0-2: project creation is the way out of the post-deletion dead-end — a
// signed-in user with zero memberships must still be able to call this. The
// caller's organization is reused when they have one; a user whose last
// project was deleted keeps their org row, so this is the common case.
export async function createProjectForUser(
  pool: Pool,
  input: { userId: string; email: string; name: string; mode?: ProjectMode; apiKeyName?: string }
): Promise<{ organizationId: string; projectId: string; apiKey?: CreatedApiKey }> {
  const org = await pool.query(
    `select organization_id from organization_members where user_id = $1 order by created_at asc limit 1`,
    [input.userId]
  );

  const projectId = `proj_${randomUUID()}`;
  const skillId = `skill_${randomUUID()}`;
  const skillVersionId = `skillv_${randomUUID()}`;
  let organizationId: string | undefined = org.rows[0]?.organization_id;
  let apiKey: CreatedApiKey | undefined;

  const client = await pool.connect();
  try {
    await client.query("begin");
    if (!organizationId) {
      organizationId = `org_${randomUUID()}`;
      await client.query(`insert into organizations (id, name) values ($1, $2)`, [
        organizationId,
        `${input.email.split("@")[0]}'s organization`
      ]);
      await client.query(
        `insert into organization_members (id, organization_id, user_id, role) values ($1, $2, $3, $4)`,
        [`orgmem_${randomUUID()}`, organizationId, input.userId, "owner"]
      );
    }
    await insertProjectWithStarterSkill(client, {
      organizationId,
      projectId,
      skillId,
      skillVersionId,
      name: input.name,
      userId: input.userId,
      role: "owner",
      ...(input.mode ? { mode: input.mode } : {})
    });
    if (input.apiKeyName) {
      apiKey = await insertProjectApiKey(client, {
        projectId,
        name: input.apiKeyName,
        createdByUserId: input.userId
      });
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  return { organizationId, projectId, ...(apiKey ? { apiKey } : {}) };
}

// Project creation and its first project key are one transaction. A failed
// key insert must not leave a new project whose onboarding receipt promises a
// credential that was never minted. The raw key is returned once; only its
// hash is persisted.
async function insertProjectApiKey(
  client: PoolClient,
  input: { projectId: string; name: string; createdByUserId: string }
): Promise<CreatedApiKey> {
  const generated = generateApiKey();
  const id = `apikey_${randomUUID()}`;
  const result = await client.query(
    `insert into api_keys (id, project_id, name, key_hash, key_prefix, created_by_user_id)
     values ($1,$2,$3,$4,$5,$6)
     returning created_at`,
    [id, input.projectId, input.name, generated.keyHash, generated.keyPrefix, input.createdByUserId]
  );
  return {
    id,
    projectId: input.projectId,
    name: input.name,
    keyPrefix: generated.keyPrefix,
    createdAt: new Date(result.rows[0]?.created_at ?? Date.now()).toISOString(),
    lastUsedAt: null,
    revokedAt: null,
    key: generated.key
  };
}

export async function createInvitation(pool: Pool, input: { email: string; role: string; invitedByUserId: string; projectId: string }): Promise<{ token: string }> {
  const project = await pool.query(`select organization_id from projects where id = $1`, [input.projectId]);
  if (!project.rows[0]) throw new Error("Project not found");

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashInviteToken(token);
  await pool.query(
    `insert into invitations (id, organization_id, project_id, email, token_hash, role, invited_by_user_id, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,now() + interval '7 days')`,
    [`inv_${randomUUID()}`, project.rows[0].organization_id, input.projectId, input.email, tokenHash, input.role, input.invitedByUserId]
  );
  return { token };
}

export async function redeemInvitation(pool: Pool, input: { token: string; userId: string }): Promise<{ projectId: string; role: string }> {
  const tokenHash = hashInviteToken(input.token);
  const result = await pool.query(
    `select * from invitations where token_hash = $1 and redeemed_at is null and expires_at > now()`,
    [tokenHash]
  );
  const invitation = result.rows[0];
  if (!invitation) throw new Error("Invalid or expired invite token");

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into organization_members (id, organization_id, user_id, role) values ($1,$2,$3,$4)
       on conflict do nothing`,
      [`orgmem_${randomUUID()}`, invitation.organization_id, input.userId, invitation.role]
    );
    await client.query(
      `insert into project_members (id, project_id, user_id, role) values ($1,$2,$3,$4)
       on conflict do nothing`,
      [`projmem_${randomUUID()}`, invitation.project_id, input.userId, invitation.role]
    );
    await client.query(`update invitations set redeemed_at = now(), redeemed_by_user_id = $1 where id = $2`, [input.userId, invitation.id]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  return { projectId: invitation.project_id, role: invitation.role };
}

export async function userProjectRole(pool: Pool, input: { userId: string; projectId: string }): Promise<string | null> {
  const result = await pool.query(`select role from project_members where user_id = $1 and project_id = $2`, [input.userId, input.projectId]);
  return result.rows[0]?.role ?? null;
}

export async function firstProjectForUser(pool: Pool, userId: string): Promise<string | null> {
  const result = await pool.query(`select project_id from project_members where user_id = $1 order by created_at asc limit 1`, [userId]);
  return result.rows[0]?.project_id ?? null;
}

function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
