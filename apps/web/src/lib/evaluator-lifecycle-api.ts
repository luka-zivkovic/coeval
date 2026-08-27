import {
  EvaluatorCandidateCreateInputSchema,
  EvaluatorCandidateCreateResultSchema,
  EvaluatorLifecycleActivateInputSchema,
  EvaluatorLifecycleListPageSchema,
  EvaluatorLifecycleRetireInputSchema,
  EvaluatorLifecycleTransitionResultSchema,
  type EvaluatorCandidateCreateInput,
  type EvaluatorCandidateCreateResult,
  type EvaluatorLifecycleActivateInput,
  type EvaluatorLifecycleListPage,
  type EvaluatorLifecycleProjection,
  type EvaluatorLifecycleRetireInput,
  type EvaluatorLifecycleTransitionResult
} from "@coeval/shared";

const API_BASE = import.meta.env.VITE_API_URL ?? "";
const PROJECT_KEY = "coeval.project";

export class EvaluatorLifecycleApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = "EvaluatorLifecycleApiError";
  }
}

export async function fetchEvaluatorLifecycles(cursor:string|null=null): Promise<{
  page: EvaluatorLifecycleListPage;
  projectRole: "owner" | "member";
}> {
  const query=new URLSearchParams({limit:"100"});
  if (cursor) query.set("cursor",cursor);
  const response = await projectFetch(`${API_BASE}/api/evaluator-lifecycles?${query.toString()}`);
  const body = await response.json().catch(() => null) as { page?: unknown; projectRole?: unknown; error?: unknown; code?: unknown } | null;
  if (!response.ok) throw responseError(response,body,"Evaluator lifecycle request failed");
  if (body?.projectRole !== "owner" && body?.projectRole !== "member") {
    throw new Error("Evaluator lifecycle response omitted the exact project role");
  }
  return { page: EvaluatorLifecycleListPageSchema.parse(body.page), projectRole: body.projectRole };
}

export async function fetchAllEvaluatorLifecycles():Promise<{
  items:EvaluatorLifecycleProjection[];
  totalCount:string;
  projectRole:"owner"|"member";
}> {
  const items:EvaluatorLifecycleProjection[]=[];
  const identities=new Set<string>();
  const cursors=new Set<string>();
  let cursor:string|null=null;
  let projectRole:"owner"|"member"|null=null;
  let totalCount="0";
  do {
    const response=await fetchEvaluatorLifecycles(cursor);
    if (projectRole!==null && response.projectRole!==projectRole) {
      throw new Error("Evaluator lifecycle project role changed during pagination");
    }
    projectRole=response.projectRole;
    totalCount=response.page.totalCount;
    for (const item of response.page.items) {
      if (identities.has(item.lifecycle.skillVersionId)) {
        throw new Error("Evaluator lifecycle pagination returned a duplicate evaluator");
      }
      identities.add(item.lifecycle.skillVersionId);
      items.push(item);
    }
    cursor=response.page.nextCursor;
    if (cursor && (cursors.has(cursor) || items.length>10_000)) {
      throw new Error("Evaluator lifecycle pagination did not advance within its bounded history");
    }
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (projectRole===null) throw new Error("Evaluator lifecycle pagination returned no authority");
  return {items,totalCount,projectRole};
}

export async function createEvaluatorCandidate(
  input: EvaluatorCandidateCreateInput
): Promise<EvaluatorCandidateCreateResult> {
  const parsed = EvaluatorCandidateCreateInputSchema.parse(input);
  const response = await projectFetch(`${API_BASE}/api/evaluator-lifecycles/candidates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(parsed)
  });
  return result(response,EvaluatorCandidateCreateResultSchema,"Evaluator candidate creation failed");
}

export async function activateEvaluator(
  skillVersionId: string,
  input: EvaluatorLifecycleActivateInput
): Promise<EvaluatorLifecycleTransitionResult> {
  return transition(skillVersionId,"activate",EvaluatorLifecycleActivateInputSchema.parse(input));
}

export async function retireEvaluator(
  skillVersionId: string,
  input: EvaluatorLifecycleRetireInput
): Promise<EvaluatorLifecycleTransitionResult> {
  return transition(skillVersionId,"retire",EvaluatorLifecycleRetireInputSchema.parse(input));
}

async function transition(
  skillVersionId: string,
  action: "activate" | "retire",
  input: EvaluatorLifecycleActivateInput | EvaluatorLifecycleRetireInput
): Promise<EvaluatorLifecycleTransitionResult> {
  const response = await projectFetch(
    `${API_BASE}/api/evaluator-lifecycles/${encodeURIComponent(skillVersionId)}/${action}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }
  );
  return result(response,EvaluatorLifecycleTransitionResultSchema,`Evaluator ${action} failed`);
}

async function result<T>(response:Response,schema:{parse(value:unknown):T},fallback:string):Promise<T> {
  const body = await response.json().catch(() => null) as { result?: unknown; error?: unknown; code?: unknown } | null;
  if (!response.ok) throw responseError(response,body,fallback);
  return schema.parse(body?.result);
}

function projectFetch(input:string,init?:RequestInit):Promise<Response> {
  const headers = new Headers(init?.headers);
  try {
    const projectId = localStorage.getItem(PROJECT_KEY);
    if (projectId) headers.set("x-coeval-project",projectId);
  } catch {
    // Authenticated server default remains available when storage is blocked.
  }
  return fetch(input,{...init,headers,credentials:"include"});
}

function responseError(
  response:Response,
  body:{error?:unknown;code?:unknown}|null,
  fallback:string
):EvaluatorLifecycleApiError {
  return new EvaluatorLifecycleApiError(
    typeof body?.error==="string" ? body.error : fallback,
    response.status,
    typeof body?.code==="string" ? body.code : null
  );
}

export function lifecycleIdempotencyKey(kind:string):string {
  return `web-evaluator-${kind}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}
