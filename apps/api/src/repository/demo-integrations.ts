import { randomUUID } from "node:crypto";
import type {
  IronsideConnectionTestResult,
  IronsideEvaluatorContext,
  IronsideImportJob,
  IronsideImportTarget,
  IronsideIntegration,
  IronsideIntegrationInput,
  IronsideSyncState,
  LangfuseConnectionTestResult,
  LangfuseImportJob,
  LangfuseImportTarget,
  LangfuseIntegration,
  LangfuseIntegrationInput,
  LangSmithConnectionTestResult,
  LangSmithImportJob,
  LangSmithImportTarget,
  LangSmithIntegration,
  LangSmithIntegrationInput,
  UpdateIronsideIntegrationInput,
  UpdateLangfuseIntegrationInput,
  UpdateLangSmithIntegrationInput
} from "@coeval/shared";
import type {
  ClaimIronsideImportTargetsInput,
  ClaimLangfuseImportTargetsInput,
  ClaimLangSmithImportTargetsInput,
  IronsideImportContext,
  LangfuseImportContext,
  LangSmithImportContext
} from "./contracts.js";
import type { DemoRepositoryStore } from "./demo-store.js";
import {
  AmbiguousProjectSkillError,
  IronsideIntegrationAlreadyExistsError,
  IronsideIntegrationChangedError,
  IronsideIntegrationNotFoundError,
  LangfuseIntegrationNotFoundError,
  LangSmithIntegrationNotFoundError,
  NoCurrentSkillError
} from "./errors.js";
import type { IntegrationRepositoryPort } from "./ports.js";

interface DemoIntegrationRepositoryDependencies {
  resolveImportSkillVersionId(projectId: string, requested?: string | undefined): Promise<string>;
}

// Internal DemoRepository integration slice. Provider credentials and polling
// state remain in the exact shared store; only public integration projections
// leave this module, while import workers receive the private contexts.
export class DemoIntegrationRepository implements IntegrationRepositoryPort {
  constructor(
    private readonly store: DemoRepositoryStore,
    private readonly dependencies: DemoIntegrationRepositoryDependencies
  ) {}

  private resolveImportSkillVersionId(projectId: string, requested?: string | undefined): Promise<string> {
    return this.dependencies.resolveImportSkillVersionId(projectId, requested);
  }

  private async resolveIntegrationSkillVersionId(
    projectId: string,
    requested?: string | undefined
  ): Promise<string | null> {
    if (requested) return this.resolveImportSkillVersionId(projectId, requested);
    try {
      return await this.resolveImportSkillVersionId(projectId);
    } catch (error) {
      if (error instanceof NoCurrentSkillError) return null;
      throw error;
    }
  }

  private recordImportSelectionFailure(
    projectId: string,
    source: "langsmith" | "langfuse" | "ironside",
    integrationId: string,
    requestedLimit: number,
    now: Date
  ): void {
    const timestamp = now.toISOString();
    this.store.importJobs.unshift({
      id: `import_${randomUUID()}`,
      projectId,
      source,
      sourceIntegrationId: integrationId,
      skillVersionId: null,
      actorUserId: null,
      actorEmail: null,
      actorName: null,
      queueJobId: null,
      status: "failed",
      requestedLimit,
      importedCount: 0,
      queuedJudgeCount: 0,
      createdAt: timestamp,
      startedAt: null,
      completedAt: timestamp,
      error: "skill_version_required: configure an exact evaluator version before scheduled import"
    });
  }

  async createLangSmithIntegration(projectId: string, input: LangSmithIntegrationInput): Promise<LangSmithIntegration> {
    const id = `int_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const pollEnabled = input.pollEnabled ?? true;
    const pollIntervalSeconds = input.pollIntervalSeconds ?? 300;
    const pollLimit = input.pollLimit ?? 25;
    const skillVersionId = await this.resolveIntegrationSkillVersionId(projectId, input.skillVersionId);
    const integration: LangSmithIntegration = {
      id,
      projectId,
      provider: "langsmith",
      skillVersionId,
      projectName: input.projectName ?? null,
      endpointUrl: input.endpointUrl ?? null,
      pollEnabled,
      pollIntervalSeconds,
      pollLimit,
      lastTestedAt: null,
      lastTestResult: null,
      createdAt
    };
    this.store.langSmithIntegrations.set(id, {
      ...integration,
      apiKey: input.apiKey,
      limit: pollLimit,
      pollEnabled,
      pollIntervalMs: pollIntervalSeconds * 1000,
      redactionConfig: input.redaction ?? {}
    });
    return integration;
  }

  async listLangSmithIntegrations(projectId: string): Promise<LangSmithIntegration[]> {
    return [...this.store.langSmithIntegrations.values()]
      .filter((integration) => integration.projectId === projectId)
      .map(toPublicLangSmithIntegration);
  }

  async updateLangSmithIntegration(projectId: string, integrationId: string, input: UpdateLangSmithIntegrationInput): Promise<LangSmithIntegration> {
    const integration = this.store.langSmithIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new LangSmithIntegrationNotFoundError(integrationId);
    if (input.pollEnabled !== undefined) integration.pollEnabled = input.pollEnabled;
    if (input.pollIntervalSeconds !== undefined) {
      integration.pollIntervalSeconds = input.pollIntervalSeconds;
      integration.pollIntervalMs = input.pollIntervalSeconds * 1000;
    }
    if (input.pollLimit !== undefined) {
      integration.pollLimit = input.pollLimit;
      integration.limit = input.pollLimit;
    }
    if (input.skillVersionId !== undefined) {
      integration.skillVersionId = await this.resolveImportSkillVersionId(projectId, input.skillVersionId);
    }
    return toPublicLangSmithIntegration(integration);
  }

  async recordLangSmithConnectionTest(projectId: string, integrationId: string, result: LangSmithConnectionTestResult): Promise<void> {
    const integration = this.store.langSmithIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new LangSmithIntegrationNotFoundError(integrationId);
    integration.lastTestedAt = result.checkedAt;
    integration.lastTestResult = result;
  }

  async deleteLangSmithIntegration(projectId: string, integrationId: string): Promise<void> {
    const integration = this.store.langSmithIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new LangSmithIntegrationNotFoundError(integrationId);
    this.store.langSmithIntegrations.delete(integrationId);
    this.store.langSmithLastPolledAt.delete(integrationId);
    for (const [caseId, source] of this.store.traceSources.entries()) {
      if (source.sourceIntegrationId === integrationId) {
        this.store.traceSources.set(caseId, { ...source, sourceIntegrationId: undefined });
      }
    }
  }

  async claimDueLangSmithImportTargets(input: ClaimLangSmithImportTargetsInput): Promise<LangSmithImportTarget[]> {
    const targets: LangSmithImportTarget[] = [];
    for (const integration of this.store.langSmithIntegrations.values()) {
      if (targets.length >= input.batchSize) break;
      const lastPolledAt = this.store.langSmithLastPolledAt.get(integration.id);
      if (!integration.pollEnabled) continue;
      if (lastPolledAt !== undefined && input.now.getTime() - lastPolledAt < integration.pollIntervalMs) continue;
      try {
        targets.push({
          projectId: integration.projectId,
          integrationId: integration.id,
          skillVersionId: integration.skillVersionId ?? await this.resolveImportSkillVersionId(integration.projectId),
          limit: Math.max(1, Math.min(integration.limit, 100))
        });
      } catch (error) {
        if (!(error instanceof NoCurrentSkillError) && !(error instanceof AmbiguousProjectSkillError)) throw error;
        this.recordImportSelectionFailure(
          integration.projectId,
          "langsmith",
          integration.id,
          Math.max(1, Math.min(integration.limit, 100)),
          input.now
        );
        this.store.langSmithLastPolledAt.set(integration.id, input.now.getTime());
        continue;
      }
      this.store.langSmithLastPolledAt.set(integration.id, input.now.getTime());
    }
    return targets;
  }

  async loadLangSmithImportContext(job: LangSmithImportJob): Promise<LangSmithImportContext> {
    const integration = this.store.langSmithIntegrations.get(job.integrationId);
    if (!integration || integration.projectId !== job.projectId) throw new LangSmithIntegrationNotFoundError(job.integrationId);
    return { ...integration, limit: job.limit };
  }

  async createLangfuseIntegration(projectId: string, input: LangfuseIntegrationInput): Promise<LangfuseIntegration> {
    const id = `int_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const pollEnabled = input.pollEnabled ?? true;
    const pollIntervalSeconds = input.pollIntervalSeconds ?? 300;
    const pollLimit = input.pollLimit ?? 25;
    const skillVersionId = await this.resolveIntegrationSkillVersionId(projectId, input.skillVersionId);
    const integration: LangfuseIntegration = {
      id,
      projectId,
      provider: "langfuse",
      skillVersionId,
      projectName: null,
      endpointUrl: input.endpointUrl ?? null,
      pollEnabled,
      pollIntervalSeconds,
      pollLimit,
      lastTestedAt: null,
      lastTestResult: null,
      createdAt
    };
    this.store.langfuseIntegrations.set(id, {
      ...integration,
      publicKey: input.publicKey,
      secretKey: input.secretKey,
      limit: pollLimit,
      pollEnabled,
      pollIntervalMs: pollIntervalSeconds * 1000,
      redactionConfig: input.redaction ?? {}
    });
    return integration;
  }

  async listLangfuseIntegrations(projectId: string): Promise<LangfuseIntegration[]> {
    return [...this.store.langfuseIntegrations.values()]
      .filter((integration) => integration.projectId === projectId)
      .map(toPublicLangfuseIntegration);
  }

  async updateLangfuseIntegration(projectId: string, integrationId: string, input: UpdateLangfuseIntegrationInput): Promise<LangfuseIntegration> {
    const integration = this.store.langfuseIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new LangfuseIntegrationNotFoundError(integrationId);
    if (input.pollEnabled !== undefined) integration.pollEnabled = input.pollEnabled;
    if (input.pollIntervalSeconds !== undefined) {
      integration.pollIntervalSeconds = input.pollIntervalSeconds;
      integration.pollIntervalMs = input.pollIntervalSeconds * 1000;
    }
    if (input.pollLimit !== undefined) {
      integration.pollLimit = input.pollLimit;
      integration.limit = input.pollLimit;
    }
    if (input.skillVersionId !== undefined) {
      integration.skillVersionId = await this.resolveImportSkillVersionId(projectId, input.skillVersionId);
    }
    return toPublicLangfuseIntegration(integration);
  }

  async recordLangfuseConnectionTest(projectId: string, integrationId: string, result: LangfuseConnectionTestResult): Promise<void> {
    const integration = this.store.langfuseIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new LangfuseIntegrationNotFoundError(integrationId);
    integration.lastTestedAt = result.checkedAt;
    integration.lastTestResult = result;
  }

  async deleteLangfuseIntegration(projectId: string, integrationId: string): Promise<void> {
    const integration = this.store.langfuseIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new LangfuseIntegrationNotFoundError(integrationId);
    this.store.langfuseIntegrations.delete(integrationId);
    this.store.langfuseLastPolledAt.delete(integrationId);
    for (const [caseId, source] of this.store.traceSources.entries()) {
      if (source.sourceIntegrationId === integrationId) {
        this.store.traceSources.set(caseId, { ...source, sourceIntegrationId: undefined });
      }
    }
  }

  async claimDueLangfuseImportTargets(input: ClaimLangfuseImportTargetsInput): Promise<LangfuseImportTarget[]> {
    const targets: LangfuseImportTarget[] = [];
    for (const integration of this.store.langfuseIntegrations.values()) {
      if (targets.length >= input.batchSize) break;
      const lastPolledAt = this.store.langfuseLastPolledAt.get(integration.id);
      if (!integration.pollEnabled) continue;
      if (lastPolledAt !== undefined && input.now.getTime() - lastPolledAt < integration.pollIntervalMs) continue;
      try {
        targets.push({
          projectId: integration.projectId,
          integrationId: integration.id,
          skillVersionId: integration.skillVersionId ?? await this.resolveImportSkillVersionId(integration.projectId),
          limit: Math.max(1, Math.min(integration.limit, 100))
        });
      } catch (error) {
        if (!(error instanceof NoCurrentSkillError) && !(error instanceof AmbiguousProjectSkillError)) throw error;
        this.recordImportSelectionFailure(
          integration.projectId,
          "langfuse",
          integration.id,
          Math.max(1, Math.min(integration.limit, 100)),
          input.now
        );
        this.store.langfuseLastPolledAt.set(integration.id, input.now.getTime());
        continue;
      }
      this.store.langfuseLastPolledAt.set(integration.id, input.now.getTime());
    }
    return targets;
  }

  async loadLangfuseImportContext(job: LangfuseImportJob): Promise<LangfuseImportContext> {
    const integration = this.store.langfuseIntegrations.get(job.integrationId);
    if (!integration || integration.projectId !== job.projectId) throw new LangfuseIntegrationNotFoundError(job.integrationId);
    return { ...integration, limit: job.limit };
  }

  async createIronsideIntegration(projectId: string, input: IronsideIntegrationInput, remote: IronsideEvaluatorContext): Promise<IronsideIntegration> {
    const existing = [...this.store.ironsideIntegrations.values()]
      .find((integration) => integration.projectId === projectId);
    if (existing) throw new IronsideIntegrationAlreadyExistsError(projectId);
    const id = `int_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const pollEnabled = input.pollEnabled ?? true;
    const pollIntervalSeconds = input.pollIntervalSeconds ?? 300;
    const pollLimit = input.pollLimit ?? 25;
    const skillVersionId = input.skillVersionId === undefined
      ? null
      : await this.resolveImportSkillVersionId(projectId, input.skillVersionId);
    const integration: IronsideIntegration = {
      id,
      projectId,
      provider: "ironside",
      skillVersionId,
      url: input.url,
      remoteProjectId: remote.project.id,
      remoteProjectName: remote.project.name,
      protocolVersion: remote.protocolVersion,
      settlementQuietPeriodSeconds: remote.settlement.quietPeriodSeconds,
      revalidationRequired: false,
      pollEnabled,
      pollIntervalSeconds,
      pollLimit,
      lastTestedAt: null,
      lastTestResult: null,
      createdAt
    };
    this.store.ironsideIntegrations.set(id, {
      ...integration,
      apiKey: input.apiKey,
      limit: pollLimit,
      pollEnabled,
      pollIntervalMs: pollIntervalSeconds * 1000,
      redactionConfig: input.redaction ?? {},
      syncState: { cursor: null },
      revalidationRequired: false,
      connectionRevision: 1
    });
    return integration;
  }

  async listIronsideIntegrations(projectId: string): Promise<IronsideIntegration[]> {
    return [...this.store.ironsideIntegrations.values()]
      .filter((integration) => integration.projectId === projectId)
      .map(toPublicIronsideIntegration);
  }

  async updateIronsideIntegration(
    projectId: string,
    integrationId: string,
    input: UpdateIronsideIntegrationInput,
    remote?: IronsideEvaluatorContext,
    expected?: { remoteProjectId: string; revalidationRequired: boolean; connectionRevision: number }
  ): Promise<IronsideIntegration> {
    const integration = this.store.ironsideIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new IronsideIntegrationNotFoundError(integrationId);
    if (
      expected &&
      (
        integration.remoteProjectId !== expected.remoteProjectId ||
        integration.revalidationRequired !== expected.revalidationRequired ||
        integration.connectionRevision !== expected.connectionRevision
      )
    ) {
      throw new IronsideIntegrationChangedError(integrationId);
    }
    if (input.url !== undefined) integration.url = input.url;
    if (input.apiKey !== undefined) integration.apiKey = input.apiKey;
    if (remote) {
      integration.remoteProjectId = remote.project.id;
      integration.remoteProjectName = remote.project.name;
      integration.protocolVersion = remote.protocolVersion;
      integration.settlementQuietPeriodSeconds = remote.settlement.quietPeriodSeconds;
      integration.revalidationRequired = false;
      integration.connectionRevision += 1;
    }
    if (input.pollEnabled !== undefined) integration.pollEnabled = input.pollEnabled;
    if (input.pollIntervalSeconds !== undefined) {
      integration.pollIntervalSeconds = input.pollIntervalSeconds;
      integration.pollIntervalMs = input.pollIntervalSeconds * 1000;
    }
    if (input.pollLimit !== undefined) {
      integration.pollLimit = input.pollLimit;
      integration.limit = input.pollLimit;
    }
    if (input.skillVersionId !== undefined) {
      integration.skillVersionId = await this.resolveImportSkillVersionId(projectId, input.skillVersionId);
    }
    return toPublicIronsideIntegration(integration);
  }

  async recordIronsideConnectionTest(projectId: string, integrationId: string, result: IronsideConnectionTestResult): Promise<void> {
    const integration = this.store.ironsideIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new IronsideIntegrationNotFoundError(integrationId);
    integration.lastTestedAt = result.checkedAt;
    integration.lastTestResult = result;
  }

  async quarantineIronsideIntegration(
    projectId: string,
    integrationId: string,
    expected: { remoteProjectId: string; connectionRevision: number },
    result: IronsideConnectionTestResult
  ): Promise<boolean> {
    const integration = this.store.ironsideIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) {
      throw new IronsideIntegrationNotFoundError(integrationId);
    }
    if (
      integration.remoteProjectId !== expected.remoteProjectId ||
      integration.connectionRevision !== expected.connectionRevision
    ) return false;
    integration.pollEnabled = false;
    integration.revalidationRequired = true;
    integration.connectionRevision += 1;
    integration.lastTestedAt = result.checkedAt;
    integration.lastTestResult = result;
    return true;
  }

  async deleteIronsideIntegration(projectId: string, integrationId: string): Promise<void> {
    const integration = this.store.ironsideIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new IronsideIntegrationNotFoundError(integrationId);
    this.store.ironsideIntegrations.delete(integrationId);
    this.store.ironsideLastPolledAt.delete(integrationId);
    for (const [caseId, source] of this.store.traceSources.entries()) {
      if (source.sourceIntegrationId === integrationId) {
        this.store.traceSources.set(caseId, { ...source, sourceIntegrationId: undefined });
      }
    }
  }

  async claimDueIronsideImportTargets(input: ClaimIronsideImportTargetsInput): Promise<IronsideImportTarget[]> {
    const targets: IronsideImportTarget[] = [];
    for (const integration of this.store.ironsideIntegrations.values()) {
      if (targets.length >= input.batchSize) break;
      const lastPolledAt = this.store.ironsideLastPolledAt.get(integration.id);
      if (!integration.pollEnabled || integration.revalidationRequired) continue;
      if (lastPolledAt !== undefined && input.now.getTime() - lastPolledAt < integration.pollIntervalMs) continue;
      try {
        targets.push({
          projectId: integration.projectId,
          integrationId: integration.id,
          skillVersionId: integration.skillVersionId ?? await this.resolveImportSkillVersionId(integration.projectId),
          limit: Math.max(1, Math.min(integration.limit, 100))
        });
      } catch (error) {
        if (!(error instanceof NoCurrentSkillError) && !(error instanceof AmbiguousProjectSkillError)) throw error;
        this.recordImportSelectionFailure(
          integration.projectId,
          "ironside",
          integration.id,
          Math.max(1, Math.min(integration.limit, 100)),
          input.now
        );
        this.store.ironsideLastPolledAt.set(integration.id, input.now.getTime());
        continue;
      }
      this.store.ironsideLastPolledAt.set(integration.id, input.now.getTime());
    }
    return targets;
  }

  async loadIronsideImportContext(job: IronsideImportJob): Promise<IronsideImportContext> {
    const integration = this.store.ironsideIntegrations.get(job.integrationId);
    if (!integration || integration.projectId !== job.projectId) throw new IronsideIntegrationNotFoundError(job.integrationId);
    return { ...integration, syncState: { ...integration.syncState }, limit: job.limit };
  }

  async saveIronsideSyncState(
    projectId: string,
    integrationId: string,
    state: IronsideSyncState,
    expectedCursor?: string | null
  ): Promise<boolean> {
    const integration = this.store.ironsideIntegrations.get(integrationId);
    if (!integration || integration.projectId !== projectId) throw new IronsideIntegrationNotFoundError(integrationId);
    if (expectedCursor !== undefined && integration.syncState.cursor !== expectedCursor) return false;
    integration.syncState = { ...state };
    return true;
  }
}

function toPublicLangSmithIntegration(integration: LangSmithImportContext): LangSmithIntegration {
  return {
    id: integration.id,
    projectId: integration.projectId,
    provider: "langsmith",
    skillVersionId: integration.skillVersionId,
    projectName: integration.projectName,
    endpointUrl: integration.endpointUrl,
    pollEnabled: integration.pollEnabled,
    pollIntervalSeconds: integration.pollIntervalSeconds,
    pollLimit: integration.pollLimit,
    lastTestedAt: integration.lastTestedAt,
    lastTestResult: integration.lastTestResult,
    createdAt: integration.createdAt
  };
}

function toPublicIronsideIntegration(integration: IronsideImportContext): IronsideIntegration {
  return {
    id: integration.id,
    projectId: integration.projectId,
    provider: "ironside",
    skillVersionId: integration.skillVersionId,
    url: integration.url,
    remoteProjectId: integration.remoteProjectId,
    remoteProjectName: integration.remoteProjectName,
    protocolVersion: integration.protocolVersion,
    settlementQuietPeriodSeconds: integration.settlementQuietPeriodSeconds,
    revalidationRequired: integration.revalidationRequired,
    pollEnabled: integration.pollEnabled,
    pollIntervalSeconds: integration.pollIntervalSeconds,
    pollLimit: integration.pollLimit,
    lastTestedAt: integration.lastTestedAt,
    lastTestResult: integration.lastTestResult,
    createdAt: integration.createdAt
  };
}

function toPublicLangfuseIntegration(integration: LangfuseImportContext): LangfuseIntegration {
  return {
    id: integration.id,
    projectId: integration.projectId,
    provider: "langfuse",
    skillVersionId: integration.skillVersionId,
    projectName: integration.projectName,
    endpointUrl: integration.endpointUrl,
    pollEnabled: integration.pollEnabled,
    pollIntervalSeconds: integration.pollIntervalSeconds,
    pollLimit: integration.pollLimit,
    lastTestedAt: integration.lastTestedAt,
    lastTestResult: integration.lastTestResult,
    createdAt: integration.createdAt
  };
}
