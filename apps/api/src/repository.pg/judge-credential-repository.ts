import { randomUUID } from "node:crypto";
import type {
  JudgeKeyProvider,
  JudgeProviderKey
} from "@coeval/shared";
import type { Pool } from "pg";
import { decryptJson } from "../lib/encryption.js";
import type { JudgeCredentialRepositoryPort } from "../repository/ports.js";
import { setJudgeProviderKeyOnClient } from "./credential-commands.js";
import { toIso } from "./mappers.js";

// Internal PostgreSQL judge-provider credential slice. Owner-facing reads stay
// masked; only the worker-facing credential lookup decrypts stored material.
export class PgJudgeCredentialRepository implements JudgeCredentialRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async setJudgeProviderKey(projectId: string, provider: JudgeKeyProvider, apiKey: string, actorUserId?: string): Promise<JudgeProviderKey> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const key = await setJudgeProviderKeyOnClient(client, projectId, provider, apiKey, actorUserId);
      await client.query("commit");
      return key;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listJudgeProviderKeys(projectId: string): Promise<JudgeProviderKey[]> {
    const result = await this.pool.query(
      `select provider, key_display, created_at from judge_provider_keys
       where project_id = $1 order by provider asc`,
      [projectId]
    );
    return result.rows.map((row) => ({
      provider: String(row.provider) as JudgeKeyProvider,
      keyDisplay: String(row.key_display),
      createdAt: toIso(row.created_at)
    }));
  }

  async deleteJudgeProviderKey(projectId: string, provider: JudgeKeyProvider, actorUserId?: string): Promise<boolean> {
    const result = await this.pool.query(
      `delete from judge_provider_keys where project_id = $1 and provider = $2`,
      [projectId, provider]
    );
    const removed = (result.rowCount ?? 0) > 0;
    if (removed) {
      await this.pool.query(
        `insert into audit_logs (id, project_id, actor_user_id, action, target_type, target_id, metadata)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [`audit_${randomUUID()}`, projectId, actorUserId ?? null, "project.judge_key.removed", "judge_provider_key", provider, JSON.stringify({ provider })]
      );
    }
    return removed;
  }

  async getJudgeProviderCredential(projectId: string, provider: string): Promise<string | null> {
    const result = await this.pool.query(
      `select encrypted_credentials from judge_provider_keys
       where project_id = $1 and provider = $2`,
      [projectId, provider]
    );
    const row = result.rows[0];
    if (!row) return null;
    return decryptJson<{ apiKey?: string }>(String(row.encrypted_credentials)).apiKey ?? null;
  }
}
