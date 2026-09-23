import type { Pool } from "pg";
import type { Context } from "hono";
import type { Queue } from "@rubrist/queue";
import { judgeProviderAvailability } from "../lib/judge-provider.js";
import { userProjectRole, type AgentSetupPairingRecord } from "../lib/auth.js";
import type { RubristRepository } from "../repository.js";
import { createEvalRunRequestService, type EvalRunRequestService } from "./eval-runs.js";
import { PRODUCTION_RECORD_APPEND_MAX_RECORDS } from "../production-calibration/repository.js";
import { createTokenBucket } from "./rate-limit.js";
import { createSkillVersionResolver, type ResolveSkillVersionId } from "./skill-versions.js";

export type AppVariables = {
  user: { id: string; email?: string; name?: string } | null;
  session: unknown | null;
  projectId: string;
  apiKeyId?: string;
  agentBootstrapAuth?:
    | { kind: "deployment-token" }
    | { kind: "pairing"; pairing: AgentSetupPairingRecord };
};

export interface RequestServices extends EvalRunRequestService {
  takeRateTokens(apiKeyId: string, count: number): boolean;
  /** Production ingest keys spend records from their own bucket, never the judge request bucket. */
  takeIngestRecords(apiKeyId: string, count: number): boolean;
  resolveSkillVersionId: ResolveSkillVersionId;
  listJudgeProviders(projectId: string): Promise<ReturnType<typeof judgeProviderAvailability>>;
  requireOwner(c: Context<{ Variables: AppVariables }>, action: string): Promise<Response | null>;
}

export interface CreateRequestServicesOptions {
  repository: RubristRepository;
  pool?: Pool | undefined;
  queue?: Queue | undefined;
  ownerAuthorizationEnabled: boolean;
  rateLimitPerMinute: number;
  batchMaxItems: number;
  /** Production ingest record budget per key; defaults to PRODUCTION_INGEST_DEFAULT_RECORDS_PER_MINUTE. */
  ingestRecordsPerMinute?: number | undefined;
}

export const PRODUCTION_INGEST_DEFAULT_RECORDS_PER_MINUTE = 60_000;

// createApp owns exactly one of these containers. Every extracted router gets
// the same limiter, authorization resolver, provider view, owner guard, and
// eval-run fan-out path rather than constructing a route-local variant.
export function createRequestServices(options: CreateRequestServicesOptions): RequestServices {
  const bucket = createTokenBucket({
    // One maximum-size batch must be a legal burst even when the sustained
    // per-minute refill is lower; otherwise some valid batches can never run.
    capacity: Math.max(options.rateLimitPerMinute, options.batchMaxItems),
    refillPerMinute: options.rateLimitPerMinute
  });
  const ingestRecordsPerMinute = options.ingestRecordsPerMinute ?? PRODUCTION_INGEST_DEFAULT_RECORDS_PER_MINUTE;
  const ingestBucket = createTokenBucket({
    // One full ingest batch must always be a legal burst (ADR-0013).
    capacity: Math.max(ingestRecordsPerMinute, PRODUCTION_RECORD_APPEND_MAX_RECORDS),
    refillPerMinute: ingestRecordsPerMinute
  });
  const evalRuns = createEvalRunRequestService(options.repository, options.queue);

  return {
    ...evalRuns,
    takeRateTokens: bucket.take,
    takeIngestRecords: ingestBucket.take,
    resolveSkillVersionId: createSkillVersionResolver(options.repository),
    async listJudgeProviders(projectId) {
      const configured = new Set(
        (await options.repository.listJudgeProviderKeys(projectId)).map((key) => key.provider)
      );
      return judgeProviderAvailability(configured, !options.pool);
    },
    async requireOwner(c, action) {
      if (!options.ownerAuthorizationEnabled || !options.pool) return null;
      const user = c.get("user");
      if (!user) return c.json({ error: "Unauthorized" }, 401);
      const role = await userProjectRole(options.pool, {
        userId: user.id,
        projectId: c.get("projectId")
      });
      if (role !== "owner") return c.json({ error: `Only owners can ${action}` }, 403);
      return null;
    }
  };
}

export type {
  DatasetEvalRunInput,
  DatasetRevisionEvalRunInput,
  EvalRunRequestService
} from "./eval-runs.js";
export type { ResolveSkillVersionId, SkillVersionAuthorization } from "./skill-versions.js";
