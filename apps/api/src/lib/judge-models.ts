import { createHash } from "node:crypto";
import type { JudgeModel, JudgeModelCatalog, JudgeProviderId } from "@coeval/shared";

interface ModelsResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type JudgeModelFetch = (
  url: string,
  init: { headers: Record<string, string> }
) => Promise<ModelsResponse>;

// `kind` is what the HTTP layer keys its status code on: "unconfigured" is the
// caller's state (no key, manual-only provider) and maps to a 4xx, while
// "upstream" covers everything that went wrong talking to the provider —
// non-2xx, bad JSON, and thrown fetches (DNS failure, timeout) alike — and
// maps to 502. Collapsing those into one bucket previously made a transient
// provider outage read as user misconfiguration.
export class JudgeModelCatalogError extends Error {
  constructor(
    readonly provider: JudgeProviderId,
    readonly kind: "unconfigured" | "upstream",
    readonly upstreamStatus: number | null,
    message: string
  ) {
    super(message);
    this.name = "JudgeModelCatalogError";
  }
}

function isoFromUnix(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value * 1000).toISOString();
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function modelRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function isOpenAIJudgeModel(id: string): boolean {
  if (!/^(gpt-|o\d|chatgpt-|ft:)/i.test(id)) return false;
  return !/(audio|realtime|transcribe|tts|image|embedding|moderation|search|computer-use)/i.test(id);
}

function sortModels(models: JudgeModel[]): JudgeModel[] {
  return models.sort((a, b) => {
    if (a.createdAt && b.createdAt) return b.createdAt.localeCompare(a.createdAt);
    if (a.createdAt) return -1;
    if (b.createdAt) return 1;
    return a.label.localeCompare(b.label);
  });
}

async function requestData(
  provider: JudgeProviderId,
  url: string,
  headers: Record<string, string>,
  fetchImpl: JudgeModelFetch
): Promise<unknown[]> {
  let response: ModelsResponse;
  try {
    response = await fetchImpl(url, { headers });
  } catch (error) {
    throw new JudgeModelCatalogError(
      provider,
      "upstream",
      null,
      `Could not load ${provider} models: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!response.ok) {
    throw new JudgeModelCatalogError(provider, "upstream", response.status, `${provider} model catalog returned HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new JudgeModelCatalogError(provider, "upstream", response.status, `${provider} model catalog returned invalid JSON`);
  }
  const payload = modelRecord(body);
  return Array.isArray(payload?.data) ? payload.data : [];
}

const defaultFetch: JudgeModelFetch = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });

// Catalogs change at most daily, but the editor refetches on every mount and
// provider toggle — without a cache each of those is a full upstream round
// trip (OpenRouter's is hundreds of models) spending the project's rate
// limits. Keyed by provider + key HASH so switching the project key can never
// serve a catalog the new key isn't entitled to; only successful catalogs are
// cached (errors always re-probe). Bypassed when a fetchImpl is injected so
// tests stay hermetic.
const CATALOG_TTL_MS = 5 * 60_000;
const catalogCache = new Map<string, { expiresAt: number; catalog: JudgeModelCatalog }>();

function openAIModelsUrl(baseUrl?: string): string {
  return `${(baseUrl?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "")}/models`;
}

function catalogCacheKey(provider: JudgeProviderId, apiKey: string, baseUrl?: string): string {
  // The base URL participates in the hash: the same credential can be reused
  // across two compatible gateways whose model entitlements differ.
  const endpoint = provider === "openai" ? openAIModelsUrl(baseUrl) : "";
  return `${provider}:${createHash("sha256").update(apiKey).update("\0").update(endpoint).digest("hex")}`;
}

export async function fetchJudgeModelCatalog(input: {
  provider: JudgeProviderId;
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: JudgeModelFetch;
}): Promise<JudgeModelCatalog> {
  const { provider } = input;
  if (provider === "mock") {
    return { provider, models: [{ id: "mock", label: "Mock heuristic", version: "mock", createdAt: null }] };
  }
  if (provider === "custom") {
    throw new JudgeModelCatalogError(provider, "unconfigured", null, "Custom OpenAI-compatible models are entered manually.");
  }
  if (!input.apiKey) {
    throw new JudgeModelCatalogError(provider, "unconfigured", null, `Configure a ${provider} API key before loading models.`);
  }

  const cacheKey = input.fetchImpl ? null : catalogCacheKey(provider, input.apiKey, input.baseUrl);
  if (cacheKey) {
    const cached = catalogCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.catalog;
  }
  const catalog = await fetchJudgeModelCatalogUncached(input);
  if (cacheKey) {
    catalogCache.set(cacheKey, { expiresAt: Date.now() + CATALOG_TTL_MS, catalog });
  }
  return catalog;
}

async function fetchJudgeModelCatalogUncached(input: {
  provider: JudgeProviderId;
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: JudgeModelFetch;
}): Promise<JudgeModelCatalog> {
  const { provider } = input;
  if (provider === "mock" || provider === "custom" || !input.apiKey) {
    throw new Error("fetchJudgeModelCatalogUncached requires a keyed catalog provider");
  }
  const fetchImpl = input.fetchImpl ?? defaultFetch;
  if (provider === "anthropic") {
    const rows = await requestData(
      provider,
      "https://api.anthropic.com/v1/models?limit=1000",
      { "anthropic-version": "2023-06-01", "x-api-key": input.apiKey },
      fetchImpl
    );
    const models = rows.flatMap((value): JudgeModel[] => {
      const row = modelRecord(value);
      const id = stringValue(row?.id);
      if (!id) return [];
      return [{
        id,
        label: stringValue(row?.display_name) ?? id,
        // Anthropic's catalog exposes no snapshot id separate from the model
        // id, so version = id: the resulting modelVersion pin records what
        // was requested, not a dated snapshot (documented on
        // ModelBindingSchema and in spec/skill-format-v1.md).
        version: id,
        createdAt: stringValue(row?.created_at)
      }];
    });
    return { provider, models: sortModels(models) };
  }

  const openRouter = provider === "openrouter";
  const rows = await requestData(
    provider,
    openRouter
      ? "https://openrouter.ai/api/v1/models?output_modalities=text&supported_parameters=tools&sort=most-popular"
      : openAIModelsUrl(input.baseUrl),
    { authorization: `Bearer ${input.apiKey}` },
    fetchImpl
  );
  const models = rows.flatMap((value): JudgeModel[] => {
    const row = modelRecord(value);
    const id = stringValue(row?.id);
    if (!id || (!openRouter && !isOpenAIJudgeModel(id))) return [];
    if (openRouter) {
      const supported = Array.isArray(row?.supported_parameters) ? row.supported_parameters : [];
      if (!supported.includes("tools")) return [];
    }
    return [{
      id,
      label: openRouter ? stringValue(row?.name) ?? id : id,
      // Same honesty note as the Anthropic branch: no separate snapshot id in
      // these catalogs, so version = id.
      version: id,
      createdAt: isoFromUnix(row?.created)
    }];
  });
  // OpenRouter already sorted this response by weekly popularity; preserve
  // that useful picker order. OpenAI's endpoint is unsorted, so newest first
  // is a more useful default there.
  return { provider, models: openRouter ? models : sortModels(models) };
}
