import {
  type AgentSetupPairing,
  AgentSetupPairingSchema,
  type ApiKey,
  ApiKeySchema,
  type CreatedAgentSetupPairing,
  CreatedAgentSetupPairingSchema,
  type CreatedApiKey,
  CreatedApiKeySchema,
  DeleteProjectInputSchema,
  type FeedbackSyncJobListItem,
  FeedbackSyncJobListItemSchema,
  type ImportJobRecord,
  ImportJobRecordSchema,
  type IronsideConnectionTestResult,
  IronsideConnectionTestResultSchema,
  type IronsideImportEnqueueResult,
  IronsideImportEnqueueResultSchema,
  IronsideImportRequestSchema,
  type IronsideIntegration,
  type IronsideIntegrationInput,
  IronsideIntegrationInputSchema,
  IronsideIntegrationSchema,
  type JudgeKeyProvider,
  type JudgeModelCatalog,
  JudgeModelCatalogSchema,
  type JudgeProviderAvailability,
  JudgeProviderAvailabilitySchema,
  type JudgeProviderId,
  type JudgeProviderKey,
  JudgeProviderKeySchema,
  type LangfuseConnectionTestResult,
  LangfuseConnectionTestResultSchema,
  type LangfuseImportEnqueueResult,
  LangfuseImportEnqueueResultSchema,
  LangfuseImportRequestSchema,
  type LangfuseIntegration,
  type LangfuseIntegrationInput,
  LangfuseIntegrationInputSchema,
  LangfuseIntegrationSchema,
  type LangSmithConnectionTestResult,
  LangSmithConnectionTestResultSchema,
  type LangSmithImportEnqueueResult,
  LangSmithImportEnqueueResultSchema,
  LangSmithImportRequestSchema,
  type LangSmithIntegration,
  type LangSmithIntegrationInput,
  LangSmithIntegrationInputSchema,
  LangSmithIntegrationSchema,
  type ProjectMode,
  type ProjectSettings,
  ProjectSettingsSchema,
  type RetentionPruneResult,
  RetentionPruneResultSchema,
  SetupResponseSchema,
  type UpdateIronsideIntegrationInput,
  UpdateIronsideIntegrationInputSchema,
  type UpdateLangfuseIntegrationInput,
  UpdateLangfuseIntegrationInputSchema,
  type UpdateLangSmithIntegrationInput,
  UpdateLangSmithIntegrationInputSchema,
  type UpdateProjectSettingsInput,
  UpdateProjectSettingsInputSchema
} from "@coeval/shared";
import {
  API_BASE,
  apiError,
  apiErrorFromResponse,
  apiFetch,
  selectProject
} from "./transport.js";

export async function fetchSetupState(): Promise<{ setupRequired: boolean; authEnabled: boolean }> {
  const response = await apiFetch(`${API_BASE}/api/auth/setup-required`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Setup state request failed");
  return response.json();
}

export async function fetchProjectSettings(): Promise<ProjectSettings> {
  const response = await apiFetch(`${API_BASE}/api/project/settings`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Project settings request failed");
  return ProjectSettingsSchema.parse(await response.json());
}

export async function fetchLangSmithIntegrations(): Promise<LangSmithIntegration[]> {
  const response = await apiFetch(`${API_BASE}/api/integrations/langsmith`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "LangSmith integrations request failed");
  const body = (await response.json()) as { integrations?: unknown };
  return LangSmithIntegrationSchema.array().parse(body.integrations ?? []);
}

export async function fetchLangfuseIntegrations(): Promise<LangfuseIntegration[]> {
  const response = await apiFetch(`${API_BASE}/api/integrations/langfuse`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Langfuse integrations request failed");
  const body = (await response.json()) as { integrations?: unknown };
  return LangfuseIntegrationSchema.array().parse(body.integrations ?? []);
}

export async function fetchIronsideIntegrations(): Promise<IronsideIntegration[]> {
  const response = await apiFetch(`${API_BASE}/api/integrations/ironside`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Ironside integrations request failed");
  const body = (await response.json()) as { integrations?: unknown };
  return IronsideIntegrationSchema.array().parse(body.integrations ?? []);
}

export async function fetchImportJobs(limit = 10): Promise<ImportJobRecord[]> {
  const response = await apiFetch(`${API_BASE}/api/import-jobs?limit=${limit}`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Import jobs request failed");
  const body = (await response.json()) as { importJobs?: unknown };
  return ImportJobRecordSchema.array().parse(body.importJobs ?? []);
}

export async function fetchFeedbackSyncs(limit = 10): Promise<FeedbackSyncJobListItem[]> {
  const response = await apiFetch(`${API_BASE}/api/feedback-syncs?limit=${limit}`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Feedback sync request failed");
  const body = (await response.json()) as { feedbackSyncs?: unknown };
  return FeedbackSyncJobListItemSchema.array().parse(body.feedbackSyncs ?? []);
}

export async function createLangSmithIntegration(input: LangSmithIntegrationInput): Promise<LangSmithIntegration> {
  const body = LangSmithIntegrationInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/integrations/langsmith`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { integration?: LangSmithIntegration; error?: string } | null;
  if (response.ok && payload?.integration) return LangSmithIntegrationSchema.parse(payload.integration);
  throw apiError(response, payload, "LangSmith integration create failed");
}

export async function updateLangSmithIntegration(integrationId: string, input: UpdateLangSmithIntegrationInput): Promise<LangSmithIntegration> {
  const body = UpdateLangSmithIntegrationInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/integrations/langsmith/${integrationId}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { integration?: LangSmithIntegration; error?: string } | null;
  if (response.ok && payload?.integration) return LangSmithIntegrationSchema.parse(payload.integration);
  throw apiError(response, payload, "LangSmith integration update failed");
}

export async function createLangfuseIntegration(input: LangfuseIntegrationInput): Promise<LangfuseIntegration> {
  const body = LangfuseIntegrationInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/integrations/langfuse`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { integration?: LangfuseIntegration; error?: string } | null;
  if (response.ok && payload?.integration) return LangfuseIntegrationSchema.parse(payload.integration);
  throw apiError(response, payload, "Langfuse integration create failed");
}

export async function updateLangfuseIntegration(integrationId: string, input: UpdateLangfuseIntegrationInput): Promise<LangfuseIntegration> {
  const body = UpdateLangfuseIntegrationInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/integrations/langfuse/${integrationId}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { integration?: LangfuseIntegration; error?: string } | null;
  if (response.ok && payload?.integration) return LangfuseIntegrationSchema.parse(payload.integration);
  throw apiError(response, payload, "Langfuse integration update failed");
}

export async function createIronsideIntegration(input: IronsideIntegrationInput): Promise<IronsideIntegration> {
  const body = IronsideIntegrationInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/integrations/ironside`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { integration?: unknown; error?: string } | null;
  if (response.ok && payload?.integration) return IronsideIntegrationSchema.parse(payload.integration);
  throw apiError(response, payload, "Ironside integration create failed");
}

export async function updateIronsideIntegration(integrationId: string, input: UpdateIronsideIntegrationInput): Promise<IronsideIntegration> {
  const body = UpdateIronsideIntegrationInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/integrations/ironside/${integrationId}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { integration?: unknown; error?: string } | null;
  if (response.ok && payload?.integration) return IronsideIntegrationSchema.parse(payload.integration);
  throw apiError(response, payload, "Ironside integration update failed");
}

// BYO judge provider keys. The raw key goes up once and never comes
// back — responses carry only the masked keyDisplay.
export async function fetchJudgeKeys(): Promise<JudgeProviderKey[]> {
  const response = await apiFetch(`${API_BASE}/api/judge-keys`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Judge keys request failed");
  const body = (await response.json()) as { keys: unknown };
  return JudgeProviderKeySchema.array().parse(body.keys ?? []);
}

export async function fetchJudgeProviders(): Promise<JudgeProviderAvailability> {
  const response = await apiFetch(`${API_BASE}/api/judge/providers`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Judge providers request failed");
  return JudgeProviderAvailabilitySchema.parse(await response.json());
}

export async function fetchJudgeModels(provider: JudgeProviderId): Promise<JudgeModelCatalog> {
  const response = await apiFetch(`${API_BASE}/api/judge/providers/${provider}/models`, { credentials: "include" });
  if (!response.ok) throw await apiErrorFromResponse(response, "Judge models request failed");
  return JudgeModelCatalogSchema.parse(await response.json());
}

export async function setJudgeKey(provider: JudgeKeyProvider, apiKey: string): Promise<JudgeProviderKey> {
  const response = await apiFetch(`${API_BASE}/api/judge-keys/${provider}`, {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey })
  });
  if (!response.ok) throw await apiErrorFromResponse(response, "Saving the judge key failed");
  const body = (await response.json()) as { key: unknown };
  return JudgeProviderKeySchema.parse(body.key);
}

export async function deleteJudgeKey(provider: JudgeKeyProvider): Promise<void> {
  const response = await apiFetch(`${API_BASE}/api/judge-keys/${provider}`, {
    method: "DELETE",
    credentials: "include"
  });
  if (!response.ok) throw await apiErrorFromResponse(response, "Removing the judge key failed");
}

export async function fetchApiKeys(): Promise<ApiKey[]> {
  const response = await apiFetch(`${API_BASE}/api/api-keys`, { credentials: "include" });
  const payload = await response.json().catch(() => null) as { apiKeys?: unknown; error?: string } | null;
  if (response.ok && Array.isArray(payload?.apiKeys)) return payload.apiKeys.map((key) => ApiKeySchema.parse(key));
  throw apiError(response, payload, "Failed to load API keys");
}

export async function createApiKey(name: string): Promise<CreatedApiKey> {
  const response = await apiFetch(`${API_BASE}/api/api-keys`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name })
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (response.ok) return CreatedApiKeySchema.parse(payload);
  throw apiError(response, payload, "Failed to create API key");
}

export async function revokeApiKey(apiKeyId: string): Promise<void> {
  const response = await apiFetch(`${API_BASE}/api/api-keys/${apiKeyId}`, {
    method: "DELETE",
    credentials: "include"
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw apiError(response, payload, "Failed to revoke API key");
  }
}

export async function deleteLangSmithIntegration(integrationId: string): Promise<void> {
  const response = await apiFetch(`${API_BASE}/api/integrations/langsmith/${integrationId}`, {
    method: "DELETE",
    credentials: "include"
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw apiError(response, payload, "LangSmith integration disconnect failed");
  }
}

export async function deleteLangfuseIntegration(integrationId: string): Promise<void> {
  const response = await apiFetch(`${API_BASE}/api/integrations/langfuse/${integrationId}`, {
    method: "DELETE",
    credentials: "include"
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw apiError(response, payload, "Langfuse integration disconnect failed");
  }
}

export async function deleteIronsideIntegration(integrationId: string): Promise<void> {
  const response = await apiFetch(`${API_BASE}/api/integrations/ironside/${integrationId}`, {
    method: "DELETE",
    credentials: "include"
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw apiError(response, payload, "Ironside integration disconnect failed");
  }
}

export async function testLangSmithIntegration(integrationId: string): Promise<LangSmithConnectionTestResult> {
  const response = await apiFetch(`${API_BASE}/api/integrations/langsmith/${integrationId}/test`, {
    method: "POST",
    credentials: "include"
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (payload && typeof payload === "object" && "ok" in payload) {
    return LangSmithConnectionTestResultSchema.parse(payload);
  }
  if (!response.ok) {
    const errorPayload = payload as { error?: string } | null;
    throw apiError(response, errorPayload, "LangSmith connection test failed");
  }
  return LangSmithConnectionTestResultSchema.parse(payload);
}

export async function triggerLangSmithImport(
  integrationId: string,
  limit: number,
  skillVersionId?: string,
): Promise<LangSmithImportEnqueueResult> {
  const body = LangSmithImportRequestSchema.parse({ limit, skillVersionId });
  const response = await apiFetch(`${API_BASE}/api/integrations/langsmith/${integrationId}/import`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { error?: string } | unknown;
  if (response.ok) return LangSmithImportEnqueueResultSchema.parse(payload);
  throw apiError(response, payload, "LangSmith import request failed");
}

export async function testLangfuseIntegration(integrationId: string): Promise<LangfuseConnectionTestResult> {
  const response = await apiFetch(`${API_BASE}/api/integrations/langfuse/${integrationId}/test`, {
    method: "POST",
    credentials: "include"
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (payload && typeof payload === "object" && "ok" in payload) {
    return LangfuseConnectionTestResultSchema.parse(payload);
  }
  if (!response.ok) {
    const errorPayload = payload as { error?: string } | null;
    throw apiError(response, errorPayload, "Langfuse connection test failed");
  }
  return LangfuseConnectionTestResultSchema.parse(payload);
}

export async function triggerLangfuseImport(
  integrationId: string,
  limit: number,
  skillVersionId?: string,
): Promise<LangfuseImportEnqueueResult> {
  const body = LangfuseImportRequestSchema.parse({ limit, skillVersionId });
  const response = await apiFetch(`${API_BASE}/api/integrations/langfuse/${integrationId}/import`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { error?: string } | unknown;
  if (response.ok) return LangfuseImportEnqueueResultSchema.parse(payload);
  throw apiError(response, payload, "Langfuse import request failed");
}

export async function testIronsideIntegration(integrationId: string): Promise<IronsideConnectionTestResult> {
  const response = await apiFetch(`${API_BASE}/api/integrations/ironside/${integrationId}/test`, {
    method: "POST",
    credentials: "include"
  });
  const payload = await response.json().catch(() => null) as unknown;
  if (payload && typeof payload === "object" && "ok" in payload) {
    return IronsideConnectionTestResultSchema.parse(payload);
  }
  if (!response.ok) throw apiError(response, payload, "Ironside connection test failed");
  return IronsideConnectionTestResultSchema.parse(payload);
}

export async function triggerIronsideImport(
  integrationId: string,
  limit: number,
  skillVersionId?: string
): Promise<IronsideImportEnqueueResult> {
  const body = IronsideImportRequestSchema.parse({ limit, skillVersionId });
  const response = await apiFetch(`${API_BASE}/api/integrations/ironside/${integrationId}/import`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { error?: string } | unknown;
  if (response.ok) return IronsideImportEnqueueResultSchema.parse(payload);
  throw apiError(response, payload, "Ironside import request failed");
}

export async function updateProjectSettings(input: UpdateProjectSettingsInput): Promise<ProjectSettings> {
  const body = UpdateProjectSettingsInputSchema.parse(input);
  const response = await apiFetch(`${API_BASE}/api/project/settings`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null) as { error?: string } | ProjectSettings | null;
  if (response.ok) return ProjectSettingsSchema.parse(payload);
  throw apiError(response, payload, "Project settings update failed");
}

export async function pruneExpiredTraces(): Promise<RetentionPruneResult> {
  const response = await apiFetch(`${API_BASE}/api/project/retention/prune`, {
    method: "POST",
    credentials: "include"
  });
  const payload = await response.json().catch(() => null) as { error?: string } | RetentionPruneResult | null;
  if (response.ok) return RetentionPruneResultSchema.parse(payload);
  throw apiError(response, payload, "Retention prune failed");
}

export async function deleteProject(confirmProjectName: string): Promise<void> {
  const body = DeleteProjectInputSchema.parse({ confirmProjectName });
  const response = await apiFetch(`${API_BASE}/api/project`, {
    method: "DELETE",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw apiError(response, payload, "Project deletion failed");
  }
}

export async function setupOwner(input: {
  email: string;
  password: string;
  name?: string;
  mode?: ProjectMode;
  projectName?: string;
}): Promise<{ projectId: string | null; apiKey: CreatedApiKey | null }> {
  const response = await apiFetch(`${API_BASE}/api/auth/setup`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw await apiErrorFromResponse(response, "Setup failed");
  const body = await response.json().catch(() => null);
  // A browser reused against a fresh local database can retain an old project
  // pin. Clear it before the next onboarding request (agent pairing) so the
  // server resolves the newly-created first project. This must run — and the
  // function must NOT throw if the successful response body is malformed: by
  // this point the owner account, workspace, and session cookie are committed
  // server-side, and every resubmit would correctly return 409.
  selectProject(null);
  const parsed = SetupResponseSchema.safeParse(body);
  if (!parsed.success) return { projectId: null, apiKey: null };
  return {
    projectId: parsed.data.projectId,
    apiKey: parsed.data.apiKey ?? null
  };
}

export async function createAgentSetupPairing(): Promise<CreatedAgentSetupPairing> {
  const response = await apiFetch(`${API_BASE}/api/agent-setup/pairings`, {
    method: "POST",
    credentials: "include"
  });
  if (!response.ok) throw await apiErrorFromResponse(response, "Agent connection creation failed");
  return CreatedAgentSetupPairingSchema.parse(await response.json());
}

export async function fetchAgentSetupPairing(pairingId: string): Promise<AgentSetupPairing> {
  const response = await apiFetch(`${API_BASE}/api/agent-setup/pairings/${encodeURIComponent(pairingId)}`, {
    credentials: "include"
  });
  if (!response.ok) throw await apiErrorFromResponse(response, "Agent connection status failed");
  return AgentSetupPairingSchema.parse(await response.json());
}

export async function revokeAgentSetupPairing(pairingId: string): Promise<void> {
  const response = await apiFetch(`${API_BASE}/api/agent-setup/pairings/${encodeURIComponent(pairingId)}`, {
    method: "DELETE",
    credentials: "include"
  });
  if (!response.ok && response.status !== 404) {
    throw await apiErrorFromResponse(response, "Agent connection revoke failed");
  }
}
