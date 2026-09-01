import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoProject } from "@coeval/db";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as repositoryModule from "../src/repository.js";
import { DemoRepository, FeedbackSyncJobNotFoundError } from "../src/repository.js";
import * as demoFeedbackModule from "../src/repository/demo-feedback.js";
import { DemoJudgeFeedbackRepository } from "../src/repository/demo-feedback.js";
import { DemoRepositoryStore } from "../src/repository/demo-store.js";

const EXPECTED_PUBLIC_METHODS = [
  "loadJudgeRunContext",
  "recordJudgeRun",
  "createFeedbackSyncJob",
  "loadFeedbackSyncContext",
  "listFeedbackSyncJobs",
  "markFeedbackSyncSucceeded",
  "markFeedbackSyncFailed",
  "markFeedbackSyncBlocked",
  "markFeedbackSyncPending",
  "listBlockedIronsideFeedbackSyncJobs"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.ts");
const FEEDBACK_REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository/demo-feedback.ts");

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

function feedbackSliceAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const sliceSource = program.getSourceFile(FEEDBACK_REPOSITORY_PATH);
  if (!sliceSource) throw new Error("Demo judge-feedback repository source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(sliceSource);
  if (!moduleSymbol) throw new Error("Demo judge-feedback repository module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "DemoJudgeFeedbackRepository");
  if (!classExport) throw new Error("DemoJudgeFeedbackRepository export was not resolved");
  const classSymbol = classExport.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(classExport)
    : classExport;
  const allocations: string[] = [];
  const moduleEdges: string[] = [];
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
        if (
          resolution &&
          path.resolve(resolution.resolvedFileName) === path.resolve(FEEDBACK_REPOSITORY_PATH) &&
          (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent) || ts.isCallExpression(node.parent))
        ) {
          moduleEdges.push(
            `${relativeSourceName(source)}:${ts.SyntaxKind[node.parent.kind]}:${node.parent.getText(source)
              .replace(/\s+/g, " ")
              .trim()}`
          );
        }
      }
      if (
        ts.isIdentifier(node) &&
        node.text === "DemoJudgeFeedbackRepository" &&
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
    references: references.sort()
  };
}

function feedbackSlice(repository: DemoRepository): DemoJudgeFeedbackRepository {
  return Reflect.get(repository, "judgeFeedbackRepository") as DemoJudgeFeedbackRepository;
}

function feedbackStore(repository: DemoRepository): DemoRepositoryStore {
  return Reflect.get(repository, "store") as DemoRepositoryStore;
}

describe("Demo judge-feedback repository slice", () => {
  it("owns exactly JudgeFeedbackRepositoryPort behind stable facade delegates", () => {
    const sliceSource = sourceFile(FEEDBACK_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const slice = classDeclaration(sliceSource, "DemoJudgeFeedbackRepository");
    const repository = classDeclaration(repositorySource, "DemoRepository");
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });

    expect(Object.keys(demoFeedbackModule)).toEqual(["DemoJudgeFeedbackRepository"]);
    expect("DemoJudgeFeedbackRepository" in repositoryModule).toBe(false);
    expect(sliceSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${
        (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) && statement.name
          ? statement.name.getText(sliceSource)
          : "<anonymous>"
      }`))
      .toEqual([
        "InterfaceDeclaration:DemoJudgeFeedbackRepositoryDependencies",
        "ClassDeclaration:DemoJudgeFeedbackRepository"
      ]);
    expect(slice.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(sliceSource))
    )).toEqual(["JudgeFeedbackRepositoryPort"]);
    expect(slice.members.map((member) =>
      ts.isMethodDeclaration(member)
        ? `MethodDeclaration:${member.name.getText(sliceSource)}`
        : ts.SyntaxKind[member.kind]
    )).toEqual([
      "Constructor",
      ...EXPECTED_PUBLIC_METHODS.map((name) => `MethodDeclaration:${name}`)
    ]);

    const facadeMethods = new Map(repository.members
      .filter(ts.isMethodDeclaration)
      .map((method) => [method.name.getText(repositorySource), method]));
    const expectedDelegateBodies: Record<(typeof EXPECTED_PUBLIC_METHODS)[number], string> = {
      loadJudgeRunContext: "{ return this.judgeFeedbackRepository.loadJudgeRunContext(job); }",
      recordJudgeRun: "{ return this.judgeFeedbackRepository.recordJudgeRun(input); }",
      createFeedbackSyncJob: "{ return this.judgeFeedbackRepository.createFeedbackSyncJob(input); }",
      loadFeedbackSyncContext: "{ return this.judgeFeedbackRepository.loadFeedbackSyncContext(job); }",
      listFeedbackSyncJobs: "{ return this.judgeFeedbackRepository.listFeedbackSyncJobs(input); }",
      markFeedbackSyncSucceeded: "{ return this.judgeFeedbackRepository.markFeedbackSyncSucceeded(job); }",
      markFeedbackSyncFailed: "{ return this.judgeFeedbackRepository.markFeedbackSyncFailed(job, error); }",
      markFeedbackSyncBlocked: "{ return this.judgeFeedbackRepository.markFeedbackSyncBlocked(job, error); }",
      markFeedbackSyncPending: "{ return this.judgeFeedbackRepository.markFeedbackSyncPending(job); }",
      listBlockedIronsideFeedbackSyncJobs: "{ return this.judgeFeedbackRepository.listBlockedIronsideFeedbackSyncJobs(projectId, integrationId); }"
    };
    for (const name of EXPECTED_PUBLIC_METHODS) {
      const method = facadeMethods.get(name);
      if (!method) throw new Error(`DemoRepository.${name} not found`);
      const body = printer.printNode(ts.EmitHint.Unspecified, method.body!, repositorySource)
        .replace(/\s+/g, " ")
        .trim();
      expect(body).toBe(expectedDelegateBodies[name]);
    }

    const analysis = feedbackSliceAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["DemoJudgeFeedbackRepository"]);
    expect(analysis.allocations).toEqual([
      "repository.ts:DemoRepository.constructor:new DemoJudgeFeedbackRepository(this.store, { loadFeedbackSyncContext: (job) => this.loadFeedbackSyncContext(job), syntheticTraceForBuiltinCase: (caseId) => this.syntheticTraceForBuiltinCase(caseId) })"
    ]);
    expect(analysis.moduleEdges).toEqual([
      'repository.ts:ImportDeclaration:import { DemoJudgeFeedbackRepository } from "./repository/demo-feedback.js";'
    ]);
    expect(analysis.references).toEqual([
      "repository.ts:ImportSpecifier:DemoJudgeFeedbackRepository",
      "repository.ts:NewExpression:DemoJudgeFeedbackRepository",
      "repository.ts:TypeReference:DemoJudgeFeedbackRepository",
      "repository/demo-feedback.ts:ClassDeclaration:DemoJudgeFeedbackRepository"
    ]);

    const repositoryInstance = new DemoRepository();
    expect(Reflect.get(feedbackSlice(repositoryInstance), "store")).toBe(feedbackStore(repositoryInstance));
  }, 30_000);

  it("preserves pinned judge context, idempotent recording, and exact missing-case errors", async () => {
    const repository = new DemoRepository(undefined, { seedVerdicts: true });
    const imported = await repository.importTrace(demoProject.id, "manual", {
      sourceTraceId: "feedback_context",
      input: { question: "Refund?" },
      output: { answer: "Thirty days." },
      metadata: { source: "manual" }
    }, { ingestionPurpose: "analysis_eligible_manual" });

    const context = await repository.loadJudgeRunContext({
      projectId: demoProject.id,
      caseId: imported.caseId,
      skillVersionId: "skillv_1_1_0"
    });
    expect(context).toMatchObject({
      projectId: demoProject.id,
      caseId: imported.caseId,
      skillVersion: { id: "skillv_1_1_0" },
      trace: { id: "feedback_context", metadata: { source: "manual" } }
    });
    await expect(repository.loadJudgeRunContext({
      projectId: demoProject.id,
      caseId: "case_missing",
      skillVersionId: "skillv_1_2_0"
    })).rejects.toThrow("Case not found for judge job: case_missing");
    await expect(repository.loadJudgeRunContext({
      projectId: demoProject.id,
      caseId: imported.caseId,
      skillVersionId: "skillv_missing"
    })).rejects.toThrow("Skill version not found for judge job: skillv_missing");
    await expect(repository.loadJudgeRunContext({
      projectId: demoProject.id,
      caseId: "case_exc_001",
      skillVersionId: "skillv_1_2_0"
    })).resolves.toMatchObject({
      caseId: "case_exc_001",
      trace: { id: "ls_run_8f31", metadata: { source: "demo" } }
    });

    const input = {
      projectId: demoProject.id,
      caseId: imported.caseId,
      skillVersionId: "skillv_1_1_0",
      verdict: { label: "pass" as const, score: 0.94, reason: "Grounded.", confidence: 0.9 },
      latencyMs: 42,
      providerMetadata: {
        model: "judge-model",
        requestId: "req_1",
        responseId: "resp_1",
        systemFingerprint: "fp_1"
      }
    };
    const first = await repository.recordJudgeRun(input);
    const second = await repository.recordJudgeRun({ ...input, verdict: { ...input.verdict, score: 0.1 } });
    expect(second).toBe(first);
    expect(first).toMatchObject({
      id: expect.stringMatching(/^judge_/),
      score: 0.94,
      reasoning: "Grounded.",
      latencyMs: 42,
      providerMetadata: input.providerMetadata
    });
    expect(feedbackStore(repository).judgeRuns).toEqual([first]);

    const defaultMetadata = await repository.recordJudgeRun({
      projectId: demoProject.id,
      caseId: "case_exc_001",
      skillVersionId: "skillv_1_2_0",
      verdict: { label: "fail", score: 0.1, reason: "Failed.", confidence: 0.9 }
    });
    expect(defaultMetadata).not.toHaveProperty("latencyMs");
    expect(defaultMetadata.providerMetadata).toEqual({
      model: null,
      requestId: null,
      responseId: null,
      systemFingerprint: null
    });
  });

  it("keeps credentials worker-private and preserves sync dedupe, filtering, and state transitions", async () => {
    class ContextCapturingRepository extends DemoRepository {
      loadFeedbackContextCalls = 0;

      override async loadFeedbackSyncContext(
        job: Parameters<DemoRepository["loadFeedbackSyncContext"]>[0]
      ): ReturnType<DemoRepository["loadFeedbackSyncContext"]> {
        this.loadFeedbackContextCalls += 1;
        return super.loadFeedbackSyncContext(job);
      }
    }

    const repository = new ContextCapturingRepository();
    const integration = await repository.createLangSmithIntegration(demoProject.id, {
      apiKey: "ls_private_feedback_key",
      projectName: "Feedback project"
    });
    const imported = await repository.importTrace(demoProject.id, "langsmith", {
      sourceTraceId: "ls_feedback_boundary",
      input: { question: "Refund?" },
      output: { answer: "Thirty days." },
      metadata: {}
    }, {
      ingestionPurpose: "analysis_eligible_langsmith",
      sourceIntegrationId: integration.id
    });
    const run = await repository.recordJudgeRun({
      projectId: demoProject.id,
      caseId: imported.caseId,
      skillVersionId: "skillv_1_2_0",
      verdict: { label: "fail", score: 0.2, reason: "Too vague.", confidence: 0.8 }
    });

    await expect(repository.createFeedbackSyncJob({
      projectId: "project_other",
      judgeRunId: run.id,
      provider: "langsmith"
    })).resolves.toBeNull();
    await expect(repository.createFeedbackSyncJob({
      projectId: demoProject.id,
      judgeRunId: run.id,
      provider: "langfuse"
    })).resolves.toBeNull();
    const langfuse = await repository.createLangfuseIntegration(demoProject.id, {
      publicKey: "pk_collision",
      secretKey: "sk_collision"
    });
    const store = feedbackStore(repository);
    store.langfuseIntegrations.set(
      integration.id,
      { ...store.langfuseIntegrations.get(langfuse.id)!, id: integration.id }
    );
    await expect(repository.createFeedbackSyncJob({
      projectId: demoProject.id,
      judgeRunId: run.id,
      provider: "langfuse"
    })).resolves.toBeNull();

    const created = await repository.createFeedbackSyncJob({
      projectId: demoProject.id,
      judgeRunId: run.id,
      provider: "langsmith"
    });
    expect(created).toMatchObject({ status: "pending", judgeRunId: run.id, provider: "langsmith" });
    const job = { projectId: demoProject.id, feedbackSyncJobId: created!.id };
    const workerContext = await repository.loadFeedbackSyncContext(job);
    expect(workerContext).toMatchObject({
      sourceTraceId: "ls_feedback_boundary",
      sourceTraceVersion: null,
      criterionStableKey: "response-quality",
      integration: { id: integration.id, apiKey: "ls_private_feedback_key" },
      judgeRun: { id: run.id, modelBinding: expect.any(Object) }
    });
    expect(await repository.createFeedbackSyncJob({
      projectId: demoProject.id,
      judgeRunId: run.id,
      provider: "langsmith"
    })).toEqual(created);
    await expect(repository.loadFeedbackSyncContext({
      projectId: "project_other",
      feedbackSyncJobId: created!.id
    })).rejects.toBeInstanceOf(FeedbackSyncJobNotFoundError);

    store.feedbackJobs.delete(created!.id);
    store.feedbackJobs.set("feedback_foreign", {
      ...workerContext,
      id: "feedback_foreign",
      projectId: "project_other",
      status: "pending"
    });
    store.feedbackJobs.set(created!.id, { ...workerContext, status: "pending" });
    store.feedbackJobs.set("feedback_second", {
      ...workerContext,
      id: "feedback_second",
      judgeRun: { ...workerContext.judgeRun, id: "judge_second" },
      status: "pending"
    });
    await expect(repository.listFeedbackSyncJobs({
      projectId: demoProject.id,
      status: "pending",
      limit: 1
    })).resolves.toEqual([
      expect.objectContaining({ id: created!.id, projectId: demoProject.id })
    ]);
    store.feedbackJobs.delete("feedback_foreign");
    store.feedbackJobs.delete("feedback_second");

    const contextCallsBeforeMarks = repository.loadFeedbackContextCalls;
    await repository.markFeedbackSyncFailed(job, new Error("upstream unavailable"));
    await repository.markFeedbackSyncFailed(job, "still unavailable");
    const failed = await repository.listFeedbackSyncJobs({
      projectId: demoProject.id,
      status: "failed",
      limit: 5
    });
    expect(failed).toEqual([
      expect.objectContaining({
        id: created!.id,
        judgeRunId: run.id,
        provider: "langsmith",
        status: "failed",
        attempts: 2,
        lastError: "still unavailable"
      })
    ]);
    expect(Object.keys(failed[0]!)).toEqual([
      "id",
      "projectId",
      "judgeRunId",
      "provider",
      "status",
      "attempts",
      "lastError",
      "createdAt"
    ]);
    expect(JSON.stringify(failed)).not.toContain("ls_private_feedback_key");

    await repository.markFeedbackSyncPending(job);
    await expect(repository.listFeedbackSyncJobs({
      projectId: demoProject.id,
      status: "failed",
      limit: 5
    })).resolves.toHaveLength(1);

    await repository.markFeedbackSyncBlocked(job, new Error("identity drift"));
    await repository.markFeedbackSyncPending(job);
    await expect(repository.listFeedbackSyncJobs({
      projectId: demoProject.id,
      status: "pending",
      limit: 5
    })).resolves.toEqual([
      expect.objectContaining({ attempts: 2, lastError: null })
    ]);
    await repository.markFeedbackSyncSucceeded(job);
    await expect(repository.createFeedbackSyncJob({
      projectId: demoProject.id,
      judgeRunId: run.id,
      provider: "langsmith"
    })).resolves.toBeNull();
    expect(repository.loadFeedbackContextCalls - contextCallsBeforeMarks).toBe(4);
  });

  it("discovers only exact blocked Ironside jobs for requeue", async () => {
    const repository = new DemoRepository();
    const integration = await repository.createIronsideIntegration(demoProject.id, {
      url: "http://ironside.test:18788",
      apiKey: "ironside_private_feedback_key"
    }, {
      protocolVersion: "ironside/evaluator/v1",
      project: { id: "remote_feedback", name: "Feedback" },
      capabilities: ["traces:read", "scores:write"],
      settlement: { kind: "quiet_period", quietPeriodSeconds: 300 }
    });
    const imported = await repository.importTrace(demoProject.id, "ironside", {
      sourceTraceId: "ironside_feedback_boundary",
      input: { question: "Refund?" },
      output: { answer: "Thirty days." },
      metadata: {}
    }, {
      ingestionPurpose: "analysis_eligible_ironside",
      sourceIntegrationId: integration.id,
      sourceTraceVersion: "trace-version-1",
      sourceRemoteProjectId: "remote_feedback"
    });
    const run = await repository.recordJudgeRun({
      projectId: demoProject.id,
      caseId: imported.caseId,
      skillVersionId: "skillv_1_2_0",
      verdict: { label: "pass", score: 0.9, reason: "Grounded.", confidence: 0.9 }
    });
    const created = await repository.createFeedbackSyncJob({
      projectId: demoProject.id,
      judgeRunId: run.id,
      provider: "ironside"
    });
    const job = { projectId: demoProject.id, feedbackSyncJobId: created!.id };
    await expect(repository.loadFeedbackSyncContext(job)).resolves.toMatchObject({
      sourceTraceId: "ironside_feedback_boundary",
      sourceTraceVersion: "trace-version-1"
    });
    await repository.markFeedbackSyncBlocked(job, new Error("remote identity changed"));

    await expect(repository.listBlockedIronsideFeedbackSyncJobs(
      demoProject.id,
      integration.id
    )).resolves.toEqual([job]);
    await expect(repository.listBlockedIronsideFeedbackSyncJobs(
      demoProject.id,
      "integration_other"
    )).resolves.toEqual([]);
    await expect(repository.listBlockedIronsideFeedbackSyncJobs(
      "project_other",
      integration.id
    )).resolves.toEqual([]);
    await repository.markFeedbackSyncPending(job);
    await expect(repository.listBlockedIronsideFeedbackSyncJobs(
      demoProject.id,
      integration.id
    )).resolves.toEqual([]);
  });
});
