import { randomUUID } from "node:crypto";
import type { JudgeKeyProvider, JudgeProviderKey } from "@coeval/shared";
import type { PoolClient } from "pg";
import { encryptJson } from "../lib/encryption.js";
import { judgeKeyDisplay } from "../repository/helpers.js";
import { toIso } from "./mappers.js";

export async function setJudgeProviderKeyOnClient(
  client: PoolClient,
  projectId: string,
  provider: JudgeKeyProvider,
  apiKey: string,
  actorUserId?: string
): Promise<JudgeProviderKey> {
  const result = await client.query(
    `insert into judge_provider_keys (id, project_id, provider, encrypted_credentials, key_display)
       values ($1, $2, $3, $4, $5)
       on conflict (project_id, provider) do update set
         encrypted_credentials = excluded.encrypted_credentials,
         key_display = excluded.key_display,
         created_at = now()
       returning provider, key_display, created_at`,
    [`jpk_${randomUUID()}`, projectId, provider, encryptJson({ apiKey }), judgeKeyDisplay(apiKey)]
  );
  await client.query(
    `insert into audit_logs (id, project_id, actor_user_id, action, target_type, target_id, metadata)
       values ($1,$2,$3,$4,$5,$6,$7)`,
    [`audit_${randomUUID()}`, projectId, actorUserId ?? null, "project.judge_key.set", "judge_provider_key", provider, JSON.stringify({ provider })]
  );
  const row = result.rows[0];
  return {
    provider: String(row.provider) as JudgeKeyProvider,
    keyDisplay: String(row.key_display),
    createdAt: toIso(row.created_at)
  };
}
