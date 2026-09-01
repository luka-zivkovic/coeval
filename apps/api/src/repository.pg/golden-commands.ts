import type { GoldenSetRetirementContext } from "@coeval/shared";
import { GoldenSetRetirementContextSchema } from "@coeval/shared";
import type { PoolClient } from "pg";
import { parseJson, toIso } from "./mappers.js";

export async function loadGoldenSetRetirementContext(client: PoolClient, projectId: string, entryId: string): Promise<GoldenSetRetirementContext | null> {
  const result = await client.query(
    `select gse.retired_at,
            audit.actor_user_id,
            audit.metadata,
            u.name as actor_name,
            u.email as actor_email
     from golden_set_entries gse
     left join lateral (
       select actor_user_id, metadata
       from audit_logs
       where project_id = $2
         and action = 'golden_set.retire'
         and target_type = 'golden_set_entry'
         and target_id = $1
       order by created_at desc
       limit 1
     ) audit on true
     left join "user" u on u.id = audit.actor_user_id
     where gse.id = $1 and gse.project_id = $2`,
    [entryId, projectId]
  );
  const row = result.rows[0];
  if (!row?.retired_at) return null;
  const metadata = parseJson(row.metadata) as { reason?: unknown } | null;
  const actorName = row.actor_name === null || row.actor_name === undefined ? null : String(row.actor_name);
  const actorEmail = row.actor_email === null || row.actor_email === undefined ? null : String(row.actor_email);
  const actorUserId = row.actor_user_id === null || row.actor_user_id === undefined ? null : String(row.actor_user_id);
  return GoldenSetRetirementContextSchema.parse({
    retiredAt: toIso(row.retired_at),
    retiredByUserId: actorUserId,
    retiredBy: actorName && actorEmail ? `${actorName} <${actorEmail}>` : actorEmail ?? actorName ?? actorUserId,
    reason: typeof metadata?.reason === "string" ? metadata.reason : null
  });
}
