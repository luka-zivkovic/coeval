import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoProject, demoSkill } from "@coeval/db";
import type { IronsideEvaluatorContext, Skill, SkillVersion } from "@coeval/shared";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as repositoryModule from "../src/repository.js";
import {
  DatasetRevisionConflictError,
  DemoRepository,
  IronsideIntegrationAlreadyExistsError,
  IronsideIntegrationNotFoundError,
  LangfuseIntegrationNotFoundError,
  LangSmithIntegrationNotFoundError,
  NoCurrentSkillError
} from "../src/repository.js";
import * as demoIntegrationModule from "../src/repository/demo-integrations.js";
import { DemoIntegrationRepository } from "../src/repository/demo-integrations.js";
import { DemoRepositoryStore } from "../src/repository/demo-store.js";

const EXPECTED_PUBLIC_METHODS = [
  "createLangSmithIntegration",
  "listLangSmithIntegrations",
  "updateLangSmithIntegration",
  "recordLangSmithConnectionTest",
  "deleteLangSmithIntegration",
  "claimDueLangSmithImportTargets",
  "loadLangSmithImportContext",
  "createLangfuseIntegration",
  "listLangfuseIntegrations",
  "updateLangfuseIntegration",
  "recordLangfuseConnectionTest",
  "deleteLangfuseIntegration",
  "claimDueLangfuseImportTargets",
  "loadLangfuseImportContext",
  "createIronsideIntegration",
  "listIronsideIntegrations",
  "updateIronsideIntegration",
  "recordIronsideConnectionTest",
  "quarantineIronsideIntegration",
  "deleteIronsideIntegration",
  "claimDueIronsideImportTargets",
  "loadIronsideImportContext",
  "saveIronsideSyncState"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.ts");
const INTEGRATION_REPOSITORY_PATH = path.join(
  API_SOURCE_DIRECTORY,
  "repository/demo-integrations.ts"
);

const remoteContext: IronsideEvaluatorContext = {
  protocolVersion: "ironside/evaluator/v1",
  project: { id: "remote_project", name: "Remote project" },
  capabilities: ["traces:read", "scores:write"],
  settlement: { kind: "quiet_period", quietPeriodSeconds: 300 }
};

function sourceFile(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function classDeclaration(source: ts.SourceFile, name: string): ts.ClassDeclaration {
  const declaration = source.statements.find((statement): statement is ts.ClassDeclaration =>
    ts.isClassDeclaration(statement) && statement.name?.text === name
  );
  if (!declaration) throw new Error(`${name} declaration not found`);
  return declaration;
}

function createApiProgram(): ts.Program {
  const configPath = ts.findConfigFile(API_DIRECTORY, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error("API tsconfig.json not found");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  return ts.createProgram(parsed.fileNames, parsed.options);
}

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function resolvedConstructorSymbol(checker: ts.TypeChecker, node: ts.Expression): ts.Symbol | undefined {
  const direct = resolvedSymbol(checker, node);
  const typeSymbol = checker.getTypeAtLocation(node).getSymbol();
  const symbol = typeSymbol ?? direct;
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function relativeSourceName(source: ts.SourceFile): string {
  return path.relative(API_SOURCE_DIRECTORY, source.fileName).split(path.sep).join("/");
}

function nearestFunctionOwner(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isConstructorDeclaration(current)) {
      const parent = current.parent;
      return ts.isClassDeclaration(parent) && parent.name
        ? `${parent.name.text}.constructor`
        : "<constructor>";
    }
    if (ts.isMethodDeclaration(current)) {
      const parent = current.parent;
      const className = ts.isClassDeclaration(parent) ? parent.name?.text : undefined;
      return `${className ?? "<class>"}.${current.name.getText()}`;
    }
  }
  return "<module>";
}

function integrationSliceAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const sliceSource = program.getSourceFile(INTEGRATION_REPOSITORY_PATH);
  if (!sliceSource) throw new Error("Demo integration repository source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(sliceSource);
  if (!moduleSymbol) throw new Error("Demo integration repository module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "DemoIntegrationRepository");
  if (!classExport) throw new Error("DemoIntegrationRepository export was not resolved");
  const classSymbol = classExport.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(classExport)
    : classExport;
  const allocations: string[] = [];
  const moduleEdges: string[] = [];
  const moduleSpecifierMentions: string[] = [];
  const references: string[] = [];

  for (const source of program.getSourceFiles()) {
    const sourcePath = path.resolve(source.fileName);
    if (
      source.isDeclarationFile ||
      (sourcePath !== API_SOURCE_DIRECTORY && !sourcePath.startsWith(`${API_SOURCE_DIRECTORY}${path.sep}`))
    ) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node)) {
        const resolution = ts.resolveModuleName(
          node.text,
          source.fileName,
          program.getCompilerOptions(),
          ts.sys
        ).resolvedModule;
        if (resolution && path.resolve(resolution.resolvedFileName) === path.resolve(INTEGRATION_REPOSITORY_PATH)) {
          moduleSpecifierMentions.push(
            `${relativeSourceName(source)}:${ts.SyntaxKind[node.parent.kind]}:${node.getText(source)}`
          );
          if (
            ts.isImportDeclaration(node.parent) ||
            ts.isExportDeclaration(node.parent) ||
            ts.isImportEqualsDeclaration(node.parent) ||
            ts.isCallExpression(node.parent)
          ) {
            moduleEdges.push(
              `${relativeSourceName(source)}:${ts.SyntaxKind[node.parent.kind]}:${node.parent.getText(source)
                .replace(/\s+/g, " ")
                .trim()}`
            );
          }
        }
      }
      if (
        ts.isIdentifier(node) &&
        node.text === "DemoIntegrationRepository" &&
        resolvedSymbol(checker, node) === classSymbol
      ) {
        references.push(`${relativeSourceName(source)}:${ts.SyntaxKind[node.parent.kind]}:${node.text}`);
      }
      if (ts.isNewExpression(node) && resolvedConstructorSymbol(checker, node.expression) === classSymbol) {
        allocations.push(
          `${relativeSourceName(source)}:${nearestFunctionOwner(node)}:${node.getText(source)
            .replace(/\s+/g, " ")
            .trim()}`
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return {
    allocations: allocations.sort(),
    compilerExports: compilerExports.map((symbol) => symbol.name).sort(),
    moduleEdges: moduleEdges.sort(),
    moduleSpecifierMentions: moduleSpecifierMentions.sort(),
    references: references.sort()
  };
}

function integrationSlice(repository: DemoRepository): DemoIntegrationRepository {
  return Reflect.get(repository, "integrationRepository") as DemoIntegrationRepository;
}

function integrationStore(repository: DemoRepository): DemoRepositoryStore {
  return Reflect.get(repository, "store") as DemoRepositoryStore;
}

class ResolverCapturingRepository extends DemoRepository {
  readonly currentRequests: string[] = [];
  readonly versionRequests: Array<{ projectId: string; skillVersionId: string }> = [];

  override async getCurrentSkill(projectId = demoProject.id): Promise<Skill> {
    this.currentRequests.push(projectId);
    return super.getCurrentSkill(projectId);
  }

  override async getSkillVersion(projectId: string, skillVersionId: string): Promise<SkillVersion | null> {
    this.versionRequests.push({ projectId, skillVersionId });
    return super.getSkillVersion(projectId, skillVersionId);
  }
}

describe("Demo integration repository slice", () => {
  it("owns exactly IntegrationRepositoryPort behind stable facade delegates", () => {
    const sliceSource = sourceFile(INTEGRATION_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const slice = classDeclaration(sliceSource, "DemoIntegrationRepository");
    const repository = classDeclaration(repositorySource, "DemoRepository");
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });

    expect(Object.keys(demoIntegrationModule)).toEqual(["DemoIntegrationRepository"]);
    expect("DemoIntegrationRepository" in repositoryModule).toBe(false);
    expect(sliceSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${
        (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name
          ? statement.name.getText(sliceSource)
          : "<anonymous>"
      }`))
      .toEqual([
        "InterfaceDeclaration:DemoIntegrationRepositoryDependencies",
        "ClassDeclaration:DemoIntegrationRepository",
        "FunctionDeclaration:toPublicLangSmithIntegration",
        "FunctionDeclaration:toPublicIronsideIntegration",
        "FunctionDeclaration:toPublicLangfuseIntegration"
      ]);
    expect(slice.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(sliceSource))
    )).toEqual(["IntegrationRepositoryPort"]);
    expect(slice.members.map((member) =>
      ts.isMethodDeclaration(member)
        ? `MethodDeclaration:${member.name.getText(sliceSource)}`
        : ts.SyntaxKind[member.kind]
    )).toEqual([
      "Constructor",
      "MethodDeclaration:resolveImportSkillVersionId",
      "MethodDeclaration:resolveIntegrationSkillVersionId",
      "MethodDeclaration:recordImportSelectionFailure",
      ...EXPECTED_PUBLIC_METHODS.map((name) => `MethodDeclaration:${name}`)
    ]);
    expect(slice.members.filter(ts.isConstructorDeclaration).map((constructor) =>
      constructor.parameters.map((parameter) =>
        printer.printNode(ts.EmitHint.Unspecified, parameter, sliceSource).replace(/\s+/g, " ").trim()
      )
    )).toEqual([[
      "private readonly store: DemoRepositoryStore",
      "private readonly dependencies: DemoIntegrationRepositoryDependencies"
    ]]);

    const facadeMethods = repository.members.filter(ts.isMethodDeclaration)
      .filter((method) => EXPECTED_PUBLIC_METHODS.includes(
        method.name.getText(repositorySource) as typeof EXPECTED_PUBLIC_METHODS[number]
      ));
    expect(facadeMethods.map((method) => method.name.getText(repositorySource))).toEqual(EXPECTED_PUBLIC_METHODS);
    for (const method of facadeMethods) {
      const methodName = method.name.getText(repositorySource);
      const body = printer.printNode(ts.EmitHint.Unspecified, method.body!, repositorySource)
        .replace(/\s+/g, " ")
        .trim();
      expect(body).toMatch(new RegExp(`^\\{ return this\\.integrationRepository\\.${methodName}\\(`));
      expect(body).toMatch(/; \}$/);
    }
  });

  it("constructs one integration slice over the facade store and resolver callback", async () => {
    const analysis = integrationSliceAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["DemoIntegrationRepository"]);
    expect(analysis.allocations).toEqual([
      "repository.ts:DemoRepository.constructor:new DemoIntegrationRepository(this.store, { resolveImportSkillVersionId: (projectId, requested) => this.resolveImportSkillVersionId(projectId, requested) })"
    ]);
    expect(analysis.moduleEdges).toEqual([
      'repository.ts:ImportDeclaration:import { DemoIntegrationRepository } from "./repository/demo-integrations.js";'
    ]);
    expect(analysis.moduleSpecifierMentions).toEqual([
      'repository.ts:ImportDeclaration:"./repository/demo-integrations.js"'
    ]);
    expect(analysis.references).toEqual([
      "repository.ts:ImportSpecifier:DemoIntegrationRepository",
      "repository.ts:NewExpression:DemoIntegrationRepository",
      "repository.ts:TypeReference:DemoIntegrationRepository",
      "repository/demo-integrations.ts:ClassDeclaration:DemoIntegrationRepository"
    ]);

    const repository = new ResolverCapturingRepository();
    const slice = integrationSlice(repository);
    expect(slice).toBeInstanceOf(DemoIntegrationRepository);
    expect(Object.keys(slice)).toEqual(["store", "dependencies"]);
    expect(Reflect.get(slice, "store")).toBe(integrationStore(repository));

    await slice.createLangSmithIntegration(demoProject.id, { apiKey: "ls_secret" });
    await slice.createLangfuseIntegration(demoProject.id, {
      publicKey: "lf_public",
      secretKey: "lf_secret",
      skillVersionId: demoSkill.currentVersion.id
    });
    expect(repository.currentRequests).toEqual([demoProject.id]);
    expect(repository.versionRequests).toEqual([{
      projectId: demoProject.id,
      skillVersionId: demoSkill.currentVersion.id
    }]);
  }, 30_000);

  it("keeps provider credentials private while worker contexts retain exact secrets", async () => {
    const repository = new DemoRepository();
    const slice = integrationSlice(repository);
    const langSmith = await slice.createLangSmithIntegration(demoProject.id, {
      apiKey: "ls_secret",
      projectName: "Support",
      endpointUrl: "https://langsmith.example",
      redaction: { sensitiveKeyPatterns: ["private"] },
      pollLimit: 7
    });
    const langfuse = await slice.createLangfuseIntegration(demoProject.id, {
      publicKey: "lf_public",
      secretKey: "lf_secret",
      endpointUrl: "https://langfuse.example",
      redaction: { sensitiveKeyPatterns: ["secret"] },
      pollLimit: 8
    });
    const ironside = await slice.createIronsideIntegration(demoProject.id, {
      url: "https://ironside.example",
      apiKey: "ir_secret",
      redaction: { sensitiveKeyPatterns: ["credential"] },
      pollLimit: 9
    }, remoteContext);

    const projectedIntegrations = [
      ...(await slice.listLangSmithIntegrations(demoProject.id)),
      ...(await slice.listLangfuseIntegrations(demoProject.id)),
      ...(await slice.listIronsideIntegrations(demoProject.id))
    ];
    expect(projectedIntegrations.map((integration) => integration.id)).toEqual([
      langSmith.id,
      langfuse.id,
      ironside.id
    ]);
    for (const publicIntegration of projectedIntegrations) {
      expect(publicIntegration).not.toHaveProperty("apiKey");
      expect(publicIntegration).not.toHaveProperty("secretKey");
      expect(publicIntegration).not.toHaveProperty("redactionConfig");
      expect(publicIntegration).not.toHaveProperty("limit");
      expect(publicIntegration).not.toHaveProperty("pollIntervalMs");
      expect(publicIntegration).not.toHaveProperty("syncState");
      expect(publicIntegration).not.toHaveProperty("connectionRevision");
    }
    await expect(slice.loadLangSmithImportContext({
      projectId: demoProject.id,
      integrationId: langSmith.id,
      skillVersionId: demoSkill.currentVersion.id,
      limit: 17
    })).resolves.toMatchObject({
      apiKey: "ls_secret",
      limit: 17,
      redactionConfig: { sensitiveKeyPatterns: ["private"] }
    });
    await expect(slice.loadLangfuseImportContext({
      projectId: demoProject.id,
      integrationId: langfuse.id,
      skillVersionId: demoSkill.currentVersion.id,
      limit: 18
    })).resolves.toMatchObject({
      publicKey: "lf_public",
      secretKey: "lf_secret",
      limit: 18,
      redactionConfig: { sensitiveKeyPatterns: ["secret"] }
    });
    const ironsideContext = await slice.loadIronsideImportContext({
      projectId: demoProject.id,
      integrationId: ironside.id,
      skillVersionId: demoSkill.currentVersion.id,
      limit: 19
    });
    expect(ironsideContext).toMatchObject({
      apiKey: "ir_secret",
      limit: 19,
      redactionConfig: { sensitiveKeyPatterns: ["credential"] },
      syncState: { cursor: null },
      connectionRevision: 1
    });
    expect(ironsideContext.syncState).not.toBe(
      integrationStore(repository).ironsideIntegrations.get(ironside.id)?.syncState
    );

    await expect(slice.listLangSmithIntegrations("other_project")).resolves.toEqual([]);
    await expect(slice.listLangfuseIntegrations("other_project")).resolves.toEqual([]);
    await expect(slice.listIronsideIntegrations("other_project")).resolves.toEqual([]);
    await expect(slice.loadLangSmithImportContext({
      projectId: "other_project", integrationId: langSmith.id, skillVersionId: "skillv", limit: 1
    })).rejects.toBeInstanceOf(LangSmithIntegrationNotFoundError);
    await expect(slice.loadLangfuseImportContext({
      projectId: "other_project", integrationId: langfuse.id, skillVersionId: "skillv", limit: 1
    })).rejects.toBeInstanceOf(LangfuseIntegrationNotFoundError);
    await expect(slice.loadIronsideImportContext({
      projectId: "other_project", integrationId: ironside.id, skillVersionId: "skillv", limit: 1
    })).rejects.toBeInstanceOf(IronsideIntegrationNotFoundError);
    await expect(slice.createIronsideIntegration(demoProject.id, {
      url: "https://other-ironside.example", apiKey: "second_secret"
    }, remoteContext)).rejects.toBeInstanceOf(IronsideIntegrationAlreadyExistsError);
  });

  it("pins polling cadence, exact evaluator selection, caps, and fail-closed selection jobs", async () => {
    const repository = new ResolverCapturingRepository();
    const slice = integrationSlice(repository);
    const now = new Date("2026-09-01T12:00:00.000Z");
    const enabled = await slice.createLangSmithIntegration(demoProject.id, {
      apiKey: "ls_enabled",
      pollIntervalSeconds: 60,
      pollLimit: 250
    });
    const competing = await slice.createLangSmithIntegration(demoProject.id, {
      apiKey: "ls_competing",
      pollIntervalSeconds: 60,
      pollLimit: 4
    });
    await slice.createLangSmithIntegration(demoProject.id, {
      apiKey: "ls_disabled",
      pollEnabled: false,
      pollLimit: 3
    });
    await expect(slice.claimDueLangSmithImportTargets({
      now,
      intervalMs: 1,
      batchSize: 1,
      defaultLimit: 25
    })).resolves.toEqual([{
      projectId: demoProject.id,
      integrationId: enabled.id,
      skillVersionId: demoSkill.currentVersion.id,
      limit: 100
    }]);
    await expect(slice.claimDueLangSmithImportTargets({
      now,
      intervalMs: 1,
      batchSize: 10,
      defaultLimit: 25
    })).resolves.toEqual([{
      projectId: demoProject.id,
      integrationId: competing.id,
      skillVersionId: demoSkill.currentVersion.id,
      limit: 4
    }]);
    await expect(slice.claimDueLangSmithImportTargets({
      now: new Date(now.getTime() + 59_999),
      intervalMs: 1,
      batchSize: 10,
      defaultLimit: 25
    })).resolves.toEqual([]);

    const firstLangfuse = await slice.createLangfuseIntegration(demoProject.id, {
      publicKey: "lf_first_public",
      secretKey: "lf_first_secret",
      pollLimit: 6
    });
    const secondLangfuse = await slice.createLangfuseIntegration(demoProject.id, {
      publicKey: "lf_second_public",
      secretKey: "lf_second_secret",
      pollLimit: 7
    });
    await expect(slice.claimDueLangfuseImportTargets({
      now,
      intervalMs: 1,
      batchSize: 1,
      defaultLimit: 25
    })).resolves.toEqual([{
      projectId: demoProject.id,
      integrationId: firstLangfuse.id,
      skillVersionId: demoSkill.currentVersion.id,
      limit: 6
    }]);
    await expect(slice.claimDueLangfuseImportTargets({
      now,
      intervalMs: 1,
      batchSize: 10,
      defaultLimit: 25
    })).resolves.toEqual([{
      projectId: demoProject.id,
      integrationId: secondLangfuse.id,
      skillVersionId: demoSkill.currentVersion.id,
      limit: 7
    }]);

    const ironsideStore = new DemoRepositoryStore();
    const ironsideSlice = new DemoIntegrationRepository(ironsideStore, {
      resolveImportSkillVersionId: async (projectId) => `skill_for_${projectId}`
    });
    const firstIronside = await ironsideSlice.createIronsideIntegration("project_one", {
      url: "https://ironside-one.example",
      apiKey: "ironside_one_secret",
      pollLimit: 8
    }, remoteContext);
    const secondIronside = await ironsideSlice.createIronsideIntegration("project_two", {
      url: "https://ironside-two.example",
      apiKey: "ironside_two_secret",
      pollLimit: 9
    }, remoteContext);
    await expect(ironsideSlice.claimDueIronsideImportTargets({
      now,
      intervalMs: 1,
      batchSize: 1,
      defaultLimit: 25
    })).resolves.toEqual([{
      projectId: "project_one",
      integrationId: firstIronside.id,
      skillVersionId: "skill_for_project_one",
      limit: 8
    }]);
    await expect(ironsideSlice.claimDueIronsideImportTargets({
      now,
      intervalMs: 1,
      batchSize: 10,
      defaultLimit: 25
    })).resolves.toEqual([{
      projectId: "project_two",
      integrationId: secondIronside.id,
      skillVersionId: "skill_for_project_two",
      limit: 9
    }]);

    await expect(slice.createLangfuseIntegration(demoProject.id, {
      publicKey: "lf_public",
      secretKey: "lf_secret",
      skillVersionId: "unknown_version"
    })).rejects.toThrow(new DatasetRevisionConflictError(
      "Unknown import skillVersionId for this project: unknown_version"
    ));

    const unresolved = await slice.createLangfuseIntegration("project_without_skill", {
      publicKey: "lf_unresolved",
      secretKey: "lf_unresolved_secret",
      pollLimit: 0
    });
    expect(unresolved.skillVersionId).toBeNull();
    await expect(slice.claimDueLangfuseImportTargets({
      now,
      intervalMs: 1,
      batchSize: 10,
      defaultLimit: 25
    })).resolves.toEqual([]);
    expect(integrationStore(repository).importJobs).toMatchObject([{
      projectId: "project_without_skill",
      source: "langfuse",
      sourceIntegrationId: unresolved.id,
      skillVersionId: null,
      status: "failed",
      requestedLimit: 1,
      createdAt: now.toISOString(),
      completedAt: now.toISOString(),
      error: "skill_version_required: configure an exact evaluator version before scheduled import"
    }]);
    expect(integrationStore(repository).langfuseLastPolledAt.get(unresolved.id)).toBe(now.getTime());
    expect(repository.currentRequests).toContain("project_without_skill");
  });

  it("pins Ironside quarantine and opaque-cursor CAS while delete detaches sources", async () => {
    const repository = new DemoRepository();
    const slice = integrationSlice(repository);
    const store = integrationStore(repository);
    const integration = await slice.createIronsideIntegration(demoProject.id, {
      url: "https://ironside.example",
      apiKey: "ir_secret",
      pollLimit: 5
    }, remoteContext);
    const initial = await slice.loadIronsideImportContext({
      projectId: demoProject.id,
      integrationId: integration.id,
      skillVersionId: demoSkill.currentVersion.id,
      limit: 5
    });

    await expect(slice.saveIronsideSyncState(
      demoProject.id,
      integration.id,
      { cursor: "cursor_1" },
      "wrong_cursor"
    )).resolves.toBe(false);
    await expect(slice.saveIronsideSyncState(
      demoProject.id,
      integration.id,
      { cursor: "cursor_1" },
      null
    )).resolves.toBe(true);
    const callerState = { cursor: "cursor_2" };
    await expect(slice.saveIronsideSyncState(
      demoProject.id,
      integration.id,
      callerState,
      "cursor_1"
    )).resolves.toBe(true);
    callerState.cursor = "caller_mutated";
    expect(store.ironsideIntegrations.get(integration.id)?.syncState).toEqual({ cursor: "cursor_2" });

    await expect(slice.quarantineIronsideIntegration(
      demoProject.id,
      integration.id,
      { remoteProjectId: "wrong_remote", connectionRevision: initial.connectionRevision },
      { ok: false, checkedAt: "2026-09-01T12:10:00.000Z", error: "identity drift" }
    )).resolves.toBe(false);
    await expect(slice.quarantineIronsideIntegration(
      demoProject.id,
      integration.id,
      { remoteProjectId: remoteContext.project.id, connectionRevision: initial.connectionRevision },
      { ok: false, checkedAt: "2026-09-01T12:10:00.000Z", error: "identity drift" }
    )).resolves.toBe(true);
    await expect(slice.updateIronsideIntegration(
      demoProject.id,
      integration.id,
      { pollEnabled: true }
    )).resolves.toMatchObject({ pollEnabled: true, revalidationRequired: true });
    await expect(slice.claimDueIronsideImportTargets({
      now: new Date("2026-09-01T12:11:00.000Z"),
      intervalMs: 1,
      batchSize: 10,
      defaultLimit: 25
    })).resolves.toEqual([]);

    const langSmith = await slice.createLangSmithIntegration(demoProject.id, { apiKey: "ls_secret" });
    const langfuse = await slice.createLangfuseIntegration(demoProject.id, {
      publicKey: "lf_public",
      secretKey: "lf_secret"
    });
    store.traceSources.set("case_ironside", {
      source: "ironside",
      sourceTraceId: "remote_trace",
      sourceTraceVersion: "v1",
      sourceRemoteProjectId: remoteContext.project.id,
      rawTraceId: "raw_trace",
      ingestionPurpose: "analysis_eligible_ironside",
      createdAt: "2026-09-01T12:00:00.000Z",
      sourceIntegrationId: integration.id
    });
    store.traceSources.set("case_langsmith", {
      source: "langsmith",
      sourceTraceId: "langsmith_trace",
      rawTraceId: "langsmith_raw",
      ingestionPurpose: "analysis_eligible_langsmith",
      createdAt: "2026-09-01T12:00:00.000Z",
      sourceIntegrationId: langSmith.id
    });
    store.traceSources.set("case_langfuse", {
      source: "langfuse",
      sourceTraceId: "langfuse_trace",
      rawTraceId: "langfuse_raw",
      ingestionPurpose: "analysis_eligible_langfuse",
      createdAt: "2026-09-01T12:00:00.000Z",
      sourceIntegrationId: langfuse.id
    });
    store.ironsideLastPolledAt.set(integration.id, 123);
    store.langSmithLastPolledAt.set(langSmith.id, 123);
    store.langfuseLastPolledAt.set(langfuse.id, 123);
    await slice.deleteIronsideIntegration(demoProject.id, integration.id);
    await slice.deleteLangSmithIntegration(demoProject.id, langSmith.id);
    await slice.deleteLangfuseIntegration(demoProject.id, langfuse.id);
    expect(store.ironsideIntegrations.has(integration.id)).toBe(false);
    expect(store.langSmithIntegrations.has(langSmith.id)).toBe(false);
    expect(store.langfuseIntegrations.has(langfuse.id)).toBe(false);
    expect(store.ironsideLastPolledAt.has(integration.id)).toBe(false);
    expect(store.langSmithLastPolledAt.has(langSmith.id)).toBe(false);
    expect(store.langfuseLastPolledAt.has(langfuse.id)).toBe(false);
    expect(store.traceSources.get("case_ironside")?.sourceIntegrationId).toBeUndefined();
    expect(store.traceSources.get("case_langsmith")?.sourceIntegrationId).toBeUndefined();
    expect(store.traceSources.get("case_langfuse")?.sourceIntegrationId).toBeUndefined();
  });

  it("keeps NoCurrentSkillError as the only nullable create-time selection result", async () => {
    class UnexpectedFailureRepository extends DemoRepository {
      override async getCurrentSkill(): Promise<Skill> {
        throw new Error("unexpected resolver failure");
      }
    }
    class NoCurrentRepository extends DemoRepository {
      override async getCurrentSkill(projectId = demoProject.id): Promise<Skill> {
        throw new NoCurrentSkillError(projectId);
      }
    }

    await expect(integrationSlice(new UnexpectedFailureRepository()).createLangSmithIntegration(
      demoProject.id,
      { apiKey: "secret" }
    )).rejects.toThrow("unexpected resolver failure");
    await expect(integrationSlice(new NoCurrentRepository()).createLangSmithIntegration(
      demoProject.id,
      { apiKey: "secret" }
    )).resolves.toMatchObject({ skillVersionId: null });
  });
});
