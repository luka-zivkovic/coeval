import { randomUUID } from "node:crypto";
import type {
  ApiKey,
  CreatedApiKey,
  JudgeKeyProvider,
  JudgeProviderKey
} from "@coeval/shared";
import { generateApiKey, hashApiKey } from "../lib/api-keys.js";
import type { CreateApiKeyInputDb } from "./contracts.js";
import type { DemoRepositoryStore } from "./demo-store.js";
import { judgeKeyDisplay } from "./helpers.js";
import type { ApiKeyRepositoryPort, JudgeCredentialRepositoryPort } from "./ports.js";

// Internal DemoRepository credential slice. The facade constructs it once
// with the exact shared store. Project API keys expose plaintext only from
// createApiKey; judge credentials expose raw values only to the worker loader.
export class DemoCredentialRepository implements
  ApiKeyRepositoryPort,
  JudgeCredentialRepositoryPort {
  constructor(private readonly store: DemoRepositoryStore) {}

  async setJudgeProviderKey(projectId: string, provider: JudgeKeyProvider, apiKey: string): Promise<JudgeProviderKey> {
    const createdAt = new Date().toISOString();
    const keyDisplay = judgeKeyDisplay(apiKey);
    this.store.judgeProviderKeys.set(`${projectId}:${provider}`, { apiKey, keyDisplay, createdAt });
    return { provider, keyDisplay, createdAt };
  }

  async listJudgeProviderKeys(projectId: string): Promise<JudgeProviderKey[]> {
    return [...this.store.judgeProviderKeys.entries()]
      .filter(([mapKey]) => mapKey.startsWith(`${projectId}:`))
      .map(([mapKey, value]) => ({
        provider: mapKey.split(":")[1] as JudgeKeyProvider,
        keyDisplay: value.keyDisplay,
        createdAt: value.createdAt
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }

  async deleteJudgeProviderKey(projectId: string, provider: JudgeKeyProvider): Promise<boolean> {
    return this.store.judgeProviderKeys.delete(`${projectId}:${provider}`);
  }

  async getJudgeProviderCredential(projectId: string, provider: string): Promise<string | null> {
    return this.store.judgeProviderKeys.get(`${projectId}:${provider}`)?.apiKey ?? null;
  }

  async createApiKey(input: CreateApiKeyInputDb): Promise<CreatedApiKey> {
    const generated = generateApiKey();
    const record: ApiKey = {
      id: `apikey_${randomUUID()}`,
      projectId: input.projectId,
      name: input.name,
      keyPrefix: generated.keyPrefix,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null
    };
    this.store.apiKeys.push({ record, keyHash: generated.keyHash });
    return { ...record, key: generated.key };
  }

  async listApiKeys(projectId: string): Promise<ApiKey[]> {
    return this.store.apiKeys
      .filter((entry) => entry.record.projectId === projectId)
      .map((entry) => entry.record)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async revokeApiKey(projectId: string, apiKeyId: string): Promise<boolean> {
    const entry = this.store.apiKeys.find((candidate) => candidate.record.id === apiKeyId && candidate.record.projectId === projectId);
    if (!entry || entry.record.revokedAt) return false;
    entry.record.revokedAt = new Date().toISOString();
    return true;
  }

  async resolveApiKey(rawKey: string): Promise<{ projectId: string; apiKeyId: string } | null> {
    const keyHash = hashApiKey(rawKey);
    const entry = this.store.apiKeys.find((candidate) => candidate.keyHash === keyHash && !candidate.record.revokedAt);
    if (!entry) return null;
    entry.record.lastUsedAt = new Date().toISOString();
    return { projectId: entry.record.projectId, apiKeyId: entry.record.id };
  }
}
