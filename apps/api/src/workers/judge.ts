import { z } from "zod";
import { DEFAULT_OUTPUT_SCHEMA, EvaluatorCallError, type EvaluatorVerdict, type JudgePrompt, type JudgeProvider } from "@rubrist/audit/runtime";
import {
  JudgeRunJobSchema,
  type EvaluatorScore,
  type JudgeRun,
  type JudgeRunJob,
  type ObservedCall,
  type VerdictPayload,
  type VerdictRecord
} from "@rubrist/shared";
import type { Queue } from "@rubrist/queue";
import type { RubristRepository } from "../repository.js";
import { observedCallFrom } from "../lib/observed-call.js";
import {
  createJudgeProvider,
  JudgeProviderUnavailableError,
  specFromSkillVersion,
  structuredVerdictToLegacy,
  structuredVerdictToPayload,
  type JudgeProviderFactory, isJudgeAuthError } from "../lib/judge-provider.js";
import { judgePromptContent } from "../lib/evaluator-definition.js";

// The worker builds the provider per skill version (so its requested model ID
// and temperature are honored), but callers/tests may inject one provider —
// accept either and normalize to a factory.
export type ProviderArg = JudgeProvider | JudgeProviderFactory;
export interface ProviderCallLifecycle {
  beforeProviderCall(): Promise<void>;
  providerCallReturned(): Promise<void>;
}
function toFactory(arg: ProviderArg): JudgeProviderFactory {
  return typeof arg === "function" ? arg : () => arg;
}

export async function registerJudgeRunWorker(
  queue: Queue,
  repository: RubristRepository,
  provider: ProviderArg = createJudgeProvider
): Promise<void> {
  await queue.work<JudgeRunJob>("judge.run", async ({ id, data }) => {
    try {
      await processJudgeRunJob(repository, data, provider, queue);
    } catch (error) {
      if (isPermanentError(error)) {
        console.error(`judge.run job ${id} permanently failed; dropping:`, error);
        return;
      }
      throw error;
    }
  });
}

export async function processJudgeRunJob(
  repository: RubristRepository,
  job: JudgeRunJob,
  provider: ProviderArg = createJudgeProvider,
  queue?: Queue | undefined
): Promise<JudgeRun> {
  const parsed = JudgeRunJobSchema.parse(job);
  const { run } = await judgeAndRecord(repository, parsed, toFactory(provider));

  if (queue) {
    for (const provider of ["langsmith", "langfuse", "ironside"] as const) {
      const feedbackJob = await repository.createFeedbackSyncJob({
        projectId: run.projectId,
        judgeRunId: run.id,
        provider
      });
      if (feedbackJob) {
        await queue.send("feedback.sync", {
          projectId: feedbackJob.projectId,
          feedbackSyncJobId: feedbackJob.id
        }, { retryLimit: 5, retryBackoff: true });
      }
    }
  }

  return run;
}

// Core judging path shared by the worker and the eval-as-a-service endpoint.
// Builds the provider the skill version pins, runs the kind-aware judge, then
// writes BOTH sinks:
//   - the v2 `verdicts` table (source=llm_judge) → the trust layer reads this
//     (κ / convergence / self-consistency), pinned to the skill version id;
//   - the legacy `judge_runs` row → dashboard verdict distribution + LangSmith
//     feedback sync still read this.
export async function judgeAndRecord(
  repository: RubristRepository,
  job: JudgeRunJob,
  providerArg: ProviderArg = createJudgeProvider,
  providerCallLifecycle?: ProviderCallLifecycle | undefined
): Promise<{
  run: JudgeRun;
  payload: VerdictPayload;
  verdict: VerdictRecord;
  latencyMs: number;
  usage?: { inputTokens: number; outputTokens: number };
  providerMetadata: { model: string | null; requestId: string | null; responseId: string | null; systemFingerprint: string | null };
  /** What the call observed; null for a provider that executes no binding (the demo mock fallback). */
  observed: ObservedCall | null;
  evaluatorScore: EvaluatorScore | null;
}> {
  const providerFactory = toFactory(providerArg);
  const context = await repository.loadJudgeRunContext(job);
  const skillVersion = context.skillVersion;
  // a stored project key is AUTHORITATIVE — resolved here and handed
  // to the factory; env keys apply only when no project key exists. An
  // invalid project key therefore fails at call time (classified permanent
  // below), never silently falling back to platform credentials.
  const bindingProvider = skillVersion.executionBinding.provider;
  const projectKey = bindingProvider !== "mock"
    ? await repository.getJudgeProviderCredential(context.projectId, bindingProvider)
    : null;
  const provider = providerFactory(skillVersion, projectKey ? { apiKey: projectKey } : undefined);
  const spec = specFromSkillVersion(skillVersion);

  const prompt: JudgePrompt = {
    id: skillVersion.id,
    name: skillVersion.version,
    kind: "unified",
    content: judgePromptContent(skillVersion)
  };

  const startedAt = Date.now();
  await providerCallLifecycle?.beforeProviderCall();
  // judgeStructured returns {verdict, usage?} — the envelope's token
  // usage rides beside the verdict, never inside the payload.
  let judged: Awaited<ReturnType<JudgeProvider["judgeStructured"]>>;
  try {
    judged = await provider.judgeStructured({ prompt, trace: context.trace, spec });
  } catch (error) {
    // A rejected provider promise is not proof that no physical request was
    // accepted. Network loss can reject locally after the remote service has
    // already started work, so the durable call-start marker must remain.
    // The eval-item worker will terminalize this as outcome-unknown instead
    // of issuing a potentially duplicate call.
    throw error;
  }
  await providerCallLifecycle?.providerCallReturned();
  const { verdict: structured, usage, providerMetadata: observedMetadata } = judged;
  // A provider that executes no binding (the demo mock fallback) observes
  // nothing, and its heuristic score is no evaluator's: neither is recorded.
  const observed = judged.observed ? observedCallFrom(judged.observed) : null;
  const evaluatorScore = observed === null ? null : evaluatorScoreFor(structured);
  const latencyMs = Date.now() - startedAt;
  const payload = structuredVerdictToPayload(structured);
  const legacy = structuredVerdictToLegacy(structured);
  const providerMetadata = {
    model: observedMetadata?.model ?? null,
    requestId: observedMetadata?.requestId ?? null,
    responseId: observedMetadata?.responseId ?? null,
    systemFingerprint: observedMetadata?.systemFingerprint ?? null
  };

  const rawRequest = {
    provider: provider.name,
    modelName: provider.modelName,
    prompt,
    traceId: context.trace.id,
    verdictKind: spec.verdictKind,
    outputSchema: skillVersion.outputSchema ?? DEFAULT_OUTPUT_SCHEMA
  };

  // Order still matters even though the eval-item lifecycle above prevents a
  // second physical provider call after a returned response. recordJudgeRun
  // dedups on (project, case, skillVersion), while recordVerdict is
  // append-only, so writing the idempotent row first avoids orphaning a
  // verdict if the legacy projection fails. These remain two repository
  // statements rather than one transaction; an interruption between them is
  // surfaced as outcome-unknown by the eval-item worker.
  const run = await repository.recordJudgeRun({
    projectId: context.projectId,
    caseId: context.caseId,
    skillVersionId: skillVersion.id,
    verdict: legacy,
    rawRequest,
    rawResponse: structured,
    latencyMs,
    providerMetadata,
    ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {})
  });

  // v2 verdict — the source of truth for the trust layer. Append-only, pinned
  // to the exact skill version that produced it.
  const verdict = await repository.recordVerdict({
    projectId: context.projectId,
    caseId: context.caseId,
    source: "llm_judge",
    skillVersionId: skillVersion.id,
    payload,
    observed,
    evaluatorScore
  });

  return { run, payload, verdict, latencyMs, ...(usage ? { usage } : {}), providerMetadata, observed, evaluatorScore };
}

/**
 * The evaluator's own score for its verdict (ADR-0014 section 6), in [0,1]:
 * a typed-question verdict's probability of passing is native to its model; a
 * prompted binary verdict's score is its self-reported P(pass), and a scalar
 * score is normalized over its range. A categorical choice carries only the
 * author's configured score for that choice, which isn't the evaluator's, so
 * it records none. None of these is calibrated.
 */
export function evaluatorScoreFor(verdict: EvaluatorVerdict): EvaluatorScore | null {
  if (verdict.kind === "typed-question") return { value: verdict.probability, kind: "native_probability" };
  if (verdict.kind === "binary") return { value: verdict.score, kind: "self_reported_score" };
  if (verdict.kind === "scalar") {
    const [low, high] = verdict.range;
    if (!(high > low)) return null;
    return { value: Math.min(1, Math.max(0, (verdict.score - low) / (high - low))), kind: "self_reported_score" };
  }
  return null;
}

// Failures a same-request retry can't heal. The call is never retried with
// changed parameters (ADR-0014 section 2); only transient transport-level
// failures of a call that reached the provider are retried as sent.
const RETRYABLE_CALL_FAILURES = new Set(["provider_rate_limit", "provider_timeout", "provider_unavailable", "provider_transport"]);

export function isPermanentError(error: unknown): boolean {
  if (error instanceof z.ZodError) return true;
  if (error instanceof EvaluatorCallError) return !error.physicalCall || !RETRYABLE_CALL_FAILURES.has(error.failureKind);
  // Missing provider credentials won't heal on retry within a job's backoff
  // budget — fail the item with the message instead of spinning.
  if (error instanceof JudgeProviderUnavailableError) return true;
  // the provider REJECTED the credential (401/403). Retrying can't
  // heal a bad key; the item must fail loudly with the provider's error.
  if (isJudgeAuthError(error)) return true;
  if (error instanceof Error) return /not found for judge job/i.test(error.message);
  return false;
}
