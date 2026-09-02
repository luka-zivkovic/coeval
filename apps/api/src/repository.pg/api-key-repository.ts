import { randomUUID } from "node:crypto";
import type {
  ApiKey,
  CreatedApiKey
} from "@coeval/shared";
import type { Pool } from "pg";
import { generateApiKey, hashApiKey } from "../lib/api-keys.js";
import type { CreateApiKeyInputDb } from "../repository.js";
import type { ApiKeyRepositoryPort } from "../repository/ports.js";
import { rowToApiKey } from "./mappers.js";

// Internal PostgreSQL project API-key slice. Plaintext key material is returned
// once while only the digest and display prefix are persisted.
export class PgApiKeyRepository implements ApiKeyRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async createApiKey(input: CreateApiKeyInputDb): Promise<CreatedApiKey> {
    const generated = generateApiKey();
    const result = await this.pool.query(
      `insert into api_keys (id, project_id, name, key_hash, key_prefix, created_by_user_id)
       values ($1,$2,$3,$4,$5,$6)
       returning *`,
      [`apikey_${randomUUID()}`, input.projectId, input.name, generated.keyHash, generated.keyPrefix, input.createdByUserId ?? null]
    );
    return { ...rowToApiKey(result.rows[0]), key: generated.key };
  }

  async listApiKeys(projectId: string): Promise<ApiKey[]> {
    const result = await this.pool.query(
      `select * from api_keys where project_id = $1 order by created_at desc`,
      [projectId]
    );
    return result.rows.map(rowToApiKey);
  }

  async revokeApiKey(projectId: string, apiKeyId: string): Promise<boolean> {
    const result = await this.pool.query(
      `update api_keys set revoked_at = now()
       where id = $1 and project_id = $2 and revoked_at is null`,
      [apiKeyId, projectId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async resolveApiKey(rawKey: string): Promise<{ projectId: string; apiKeyId: string } | null> {
    const keyHash = hashApiKey(rawKey);
    const result = await this.pool.query(
      `update api_keys set last_used_at = now()
       where key_hash = $1 and revoked_at is null
       returning id, project_id`,
      [keyHash]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { projectId: String(row.project_id), apiKeyId: String(row.id) };
  }
}
