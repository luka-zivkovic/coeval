import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoProject, demoSkill } from "@coeval/db";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as repositoryModule from "../src/repository.js";
import {
  DatasetRevisionConflictError,
  DemoRepository,
  RecursiveTraceSkippedError
} from "../src/repository.js";
import { datasetInputIdentity } from "../src/lib/dataset-revision.js";
import { EXCLUDED_VALUE, REDACTED_VALUE } from "../src/lib/redaction.js";
import * as demoTraceImportModule from "../src/repository/demo-trace-import.js";
import { DemoTraceImportRepository } from "../src/repository/demo-trace-import.js";
import type { DemoRepositoryStore } from "../src/repository/demo-store.js";

const EXPECTED_PUBLIC_METHODS = [
  "importTrace",
  "createImportJob",
  "markImportJobQueued",
  "markImportJobRunning",
  "markImportJobCompleted",
  "markImportJobFailed",
  "listImportJobs"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.ts");
const TRACE_IMPORT_REPOSITORY_PATH = path.join(
  API_SOURCE_DIRECTORY,
  "repository/demo-trace-import.ts"
);

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
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      return ts.isFunctionDeclaration(current) && current.name ? current.name.text : "<anonymous>";
    }
  }
  return "<module>";
}

function traceImportSliceAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const sliceSource = program.getSourceFile(TRACE_IMPORT_REPOSITORY_PATH);
  if (!sliceSource) throw new Error("Demo trace-import repository source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(sliceSource);
  if (!moduleSymbol) throw new Error("Demo trace-import repository module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "DemoTraceImportRepository");
  if (!classExport) throw new Error("DemoTraceImportRepository export was not resolved");
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
        if (resolution && path.resolve(resolution.resolvedFileName) === path.resolve(TRACE_IMPORT_REPOSITORY_PATH)) {
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
        node.text === "DemoTraceImportRepository" &&
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

describe("Demo trace-import repository slice", () => {
  it("owns exactly the TraceImportRepositoryPort methods behind the stable facade", () => {
    const sliceSource = sourceFile(TRACE_IMPORT_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const slice = classDeclaration(sliceSource, "DemoTraceImportRepository");
    const repository = classDeclaration(repositorySource, "DemoRepository");
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });

    expect(Object.keys(demoTraceImportModule)).toEqual(["DemoTraceImportRepository"]);
    expect("DemoTraceImportRepository" in repositoryModule).toBe(false);
    expect(sliceSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${
        (ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name
          ? statement.name.getText(sliceSource)
          : "<anonymous>"
      }`))
      .toEqual([
        "InterfaceDeclaration:DemoTraceImportRepositoryDependencies",
        "ClassDeclaration:DemoTraceImportRepository"
      ]);
    expect(slice.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(sliceSource))
    )).toEqual(["TraceImportRepositoryPort"]);
    expect(slice.members.map((member) =>
      ts.isMethodDeclaration(member)
        ? `MethodDeclaration:${member.name.getText(sliceSource)}`
        : ts.SyntaxKind[member.kind]
    )).toEqual([
      "Constructor",
      "MethodDeclaration:importTrace",
      "MethodDeclaration:createImportJob",
      "MethodDeclaration:markImportJobQueued",
      "MethodDeclaration:markImportJobRunning",
      "MethodDeclaration:markImportJobCompleted",
      "MethodDeclaration:markImportJobFailed",
      "MethodDeclaration:listImportJobs",
      "MethodDeclaration:getImportJob"
    ]);
    expect(slice.members.filter(ts.isConstructorDeclaration).map((constructor) =>
      constructor.parameters.map((parameter) =>
        printer.printNode(ts.EmitHint.Unspecified, parameter, sliceSource).replace(/\s+/g, " ").trim()
      )
    )).toEqual([[
      "private readonly store: DemoRepositoryStore",
      "private readonly dependencies: DemoTraceImportRepositoryDependencies"
    ]]);

    const expectedDelegates = new Map<string, string>([
      ["importTrace", "{ return this.traceImportRepository.importTrace(projectId, source, input, context); }"],
      ["createImportJob", "{ return this.traceImportRepository.createImportJob(input); }"],
      ["markImportJobQueued", "{ return this.traceImportRepository.markImportJobQueued(projectId, importJobId, queueJobId); }"],
      ["markImportJobRunning", "{ return this.traceImportRepository.markImportJobRunning(projectId, importJobId); }"],
      ["markImportJobCompleted", "{ return this.traceImportRepository.markImportJobCompleted(projectId, importJobId, result); }"],
      ["markImportJobFailed", "{ return this.traceImportRepository.markImportJobFailed(projectId, importJobId, error); }"],
      ["listImportJobs", "{ return this.traceImportRepository.listImportJobs(input); }"]
    ]);
    const facadeMethods = repository.members.filter(ts.isMethodDeclaration)
      .filter((method) => EXPECTED_PUBLIC_METHODS.includes(
        method.name.getText(repositorySource) as typeof EXPECTED_PUBLIC_METHODS[number]
      ));
    expect(facadeMethods.map((method) => method.name.getText(repositorySource))).toEqual(EXPECTED_PUBLIC_METHODS);
    for (const method of facadeMethods) {
      expect(printer.printNode(ts.EmitHint.Unspecified, method.body!, repositorySource).replace(/\s+/g, " ").trim())
        .toBe(expectedDelegates.get(method.name.getText(repositorySource)));
    }
    const datasetImport = repository.members.find((member): member is ts.MethodDeclaration =>
      ts.isMethodDeclaration(member) && member.name.getText(repositorySource) === "importDatasetExamples"
    );
    expect(datasetImport?.body?.getText(repositorySource)).toContain("await this.importTrace(");
  });

  it("constructs one slice with the exact shared store and version callback", () => {
    const analysis = traceImportSliceAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["DemoTraceImportRepository"]);
    expect(analysis.allocations).toEqual([
      "repository.ts:DemoRepository.constructor:new DemoTraceImportRepository(this.store, { resolveImportSkillVersionId: (projectId, requested) => this.resolveImportSkillVersionId(projectId, requested) })"
    ]);
    expect(analysis.moduleEdges).toEqual([
      'repository.ts:ImportDeclaration:import { DemoTraceImportRepository } from "./repository/demo-trace-import.js";'
    ]);
    expect(analysis.moduleSpecifierMentions).toEqual([
      'repository.ts:ImportDeclaration:"./repository/demo-trace-import.js"'
    ]);
    expect(analysis.references).toEqual([
      "repository.ts:ImportSpecifier:DemoTraceImportRepository",
      "repository.ts:NewExpression:DemoTraceImportRepository",
      "repository.ts:TypeReference:DemoTraceImportRepository",
      "repository/demo-trace-import.ts:ClassDeclaration:DemoTraceImportRepository"
    ]);

    const repository = new DemoRepository();
    const slice = Reflect.get(repository, "traceImportRepository") as DemoTraceImportRepository;
    expect(slice).toBeInstanceOf(DemoTraceImportRepository);
    expect(Object.keys(slice)).toEqual(["store", "dependencies"]);
    expect(Reflect.get(slice, "store")).toBe(Reflect.get(repository, "store"));
    expect(Object.keys(Reflect.get(slice, "dependencies") as object)).toEqual([
      "resolveImportSkillVersionId"
    ]);
  }, 30_000);

  it("preserves trace identity, origin metadata, raw identity, redaction, and recursion rejection", async () => {
    const repository = new DemoRepository();
    const store = Reflect.get(repository, "store") as DemoRepositoryStore;
    const rawInput = {
      question: "Can I get a refund?",
      api_key: "sk-sensitive",
      context: { internal: "do not retain" }
    };
    const first = await repository.importTrace(demoProject.id, "manual", {
      sourceTraceId: "trace-import-slice-identity",
      input: rawInput,
      output: { answer: "yes", token: "customer-token" },
      metadata: { headers: { authorization: "Bearer customer-token" } },
      steps: [{ name: "lookup", input: { api_key: "step-secret" }, output: { found: true } }]
    }, {
      ingestionPurpose: "analysis_eligible_manual",
      sourceTraceVersion: "v1",
      sourceRemoteProjectId: "remote-a",
      sourceIntegrationId: "integration-a",
      importJobId: "job-a",
      redactionConfig: { excludedPaths: ["input.context.internal"] }
    });
    const replay = await repository.importTrace(demoProject.id, "manual", {
      sourceTraceId: "trace-import-slice-identity",
      input: { different: true },
      output: { different: true },
      metadata: {}
    }, {
      ingestionPurpose: "judge_api",
      sourceTraceVersion: "v1",
      sourceRemoteProjectId: "remote-a",
      sourceIntegrationId: "integration-b",
      importJobId: "job-b"
    });
    expect(replay).toEqual({ ...first, created: false });
    expect(store.traceSources.get(first.caseId)).toMatchObject({
      ingestionPurpose: "analysis_eligible_manual",
      sourceIntegrationId: "integration-a",
      importJobId: "job-a"
    });
    expect(store.caseInputIdentities.get(first.caseId)).toEqual(datasetInputIdentity({ input: rawInput }));
    expect(store.traces.get(first.caseId)).toMatchObject({
      input: {
        question: "Can I get a refund?",
        api_key: REDACTED_VALUE,
        context: { internal: EXCLUDED_VALUE }
      },
      output: { answer: "yes", token: REDACTED_VALUE },
      metadata: { headers: { authorization: REDACTED_VALUE } },
      steps: [{ name: "lookup", input: { api_key: REDACTED_VALUE }, output: { found: true } }]
    });
    const otherRemote = await repository.importTrace(demoProject.id, "manual", {
      sourceTraceId: "trace-import-slice-identity",
      input: rawInput,
      output: {},
      metadata: {}
    }, {
      ingestionPurpose: "analysis_eligible_manual",
      sourceTraceVersion: "v1",
      sourceRemoteProjectId: "remote-b"
    });
    expect(otherRemote.created).toBe(true);
    expect(otherRemote.caseId).not.toBe(first.caseId);

    const countsBeforeRejection = {
      traces: store.traces.size,
      traceSources: store.traceSources.size,
      identities: store.caseInputIdentities.size
    };
    await expect(repository.importTrace(demoProject.id, "manual", {
      sourceTraceId: "trace-import-slice-recursive",
      input: {},
      output: {},
      metadata: { coeval: { internal: true } }
    }, { ingestionPurpose: "analysis_eligible_manual" }))
      .rejects.toBeInstanceOf(RecursiveTraceSkippedError);
    expect({
      traces: store.traces.size,
      traceSources: store.traceSources.size,
      identities: store.caseInputIdentities.size
    }).toEqual(countsBeforeRejection);
  });

  it("preserves import-job resolution, lifecycle, exact counts, filtering, clones, and errors", async () => {
    class VersionProbeRepository extends DemoRepository {
      currentSkillCalls = 0;
      skillVersionCalls = 0;
      override async getCurrentSkill(projectId: string) {
        this.currentSkillCalls += 1;
        return super.getCurrentSkill(projectId);
      }
      override async getSkillVersion(...args: Parameters<DemoRepository["getSkillVersion"]>) {
        this.skillVersionCalls += 1;
        return super.getSkillVersion(...args);
      }
    }

    const repository = new VersionProbeRepository();
    const job = await repository.createImportJob({
      projectId: demoProject.id,
      source: "langsmith",
      sourceIntegrationId: "integration-job",
      actorUserId: "user-job",
      requestedLimit: 12
    });
    expect(repository.currentSkillCalls).toBe(1);
    expect(repository.skillVersionCalls).toBe(0);
    expect(job).toMatchObject({
      projectId: demoProject.id,
      source: "langsmith",
      sourceIntegrationId: "integration-job",
      skillVersionId: demoSkill.currentVersion.id,
      actorUserId: "user-job",
      status: "queued",
      requestedLimit: 12,
      importedCount: 0,
      queuedJudgeCount: 0
    });
    job.status = "failed";
    await expect(repository.listImportJobs({ projectId: demoProject.id, limit: 10 }))
      .resolves.toMatchObject([{ id: job.id, status: "queued" }]);

    const queued = await repository.markImportJobQueued(demoProject.id, job.id, "queue-job-1");
    expect(queued).toMatchObject({ queueJobId: "queue-job-1", status: "queued" });
    queued.queueJobId = "tampered-copy";
    await expect(repository.listImportJobs({ projectId: demoProject.id, limit: 10 }))
      .resolves.toMatchObject([{ id: job.id, queueJobId: "queue-job-1" }]);
    await repository.markImportJobRunning(demoProject.id, job.id);
    await expect(repository.listImportJobs({ projectId: demoProject.id, limit: 10 }))
      .resolves.toMatchObject([{ id: job.id, status: "running", startedAt: expect.any(String), error: null }]);
    await repository.importTrace(demoProject.id, "langsmith", {
      sourceTraceId: "trace-import-job-count",
      input: {},
      output: {},
      metadata: {}
    }, {
      ingestionPurpose: "analysis_eligible_langsmith",
      importJobId: job.id
    });
    await repository.markImportJobCompleted(demoProject.id, job.id, {
      importedCount: 99,
      queuedJudgeCount: 3
    });
    await expect(repository.listImportJobs({ projectId: demoProject.id, limit: 10 }))
      .resolves.toMatchObject([{
        id: job.id,
        status: "completed",
        importedCount: 1,
        queuedJudgeCount: 3,
        completedAt: expect.any(String),
        error: null
      }]);

    const failed = await repository.createImportJob({
      projectId: demoProject.id,
      source: "langfuse",
      skillVersionId: demoSkill.currentVersion.id
    });
    expect(repository.currentSkillCalls).toBe(1);
    expect(repository.skillVersionCalls).toBe(1);
    await expect(repository.createImportJob({
      projectId: demoProject.id,
      source: "langfuse",
      skillVersionId: "missing-version"
    })).rejects.toBeInstanceOf(DatasetRevisionConflictError);
    await expect(repository.createImportJob({
      projectId: demoProject.id,
      source: "langfuse",
      skillVersionId: "missing-version"
    })).rejects.toThrow("Unknown import skillVersionId for this project: missing-version");
    expect(repository.currentSkillCalls).toBe(1);
    expect(repository.skillVersionCalls).toBe(3);

    const failedResult = await repository.markImportJobFailed(demoProject.id, failed.id, "plain failure");
    expect(failedResult).toMatchObject({
      status: "failed",
      error: "plain failure",
      completedAt: expect.any(String)
    });
    failedResult.error = "tampered-return-copy";
    const allJobs = await repository.listImportJobs({ projectId: demoProject.id, limit: 10 });
    expect(allJobs.map((candidate) => candidate.id)).toEqual([failed.id, job.id]);
    expect(allJobs).toMatchObject([
      { id: failed.id, error: "plain failure" },
      { id: job.id, status: "completed" }
    ]);
    allJobs[0]!.error = "tampered-list-copy";
    await expect(repository.listImportJobs({ projectId: demoProject.id, limit: 1 }))
      .resolves.toMatchObject([{ id: failed.id, error: "plain failure" }]);
    await expect(repository.listImportJobs({ projectId: demoProject.id, status: "failed", limit: 1 }))
      .resolves.toMatchObject([{ id: failed.id, error: "plain failure" }]);
    await expect(repository.listImportJobs({ projectId: "other-project", limit: 10 })).resolves.toEqual([]);
    await expect(repository.markImportJobRunning("other-project", job.id))
      .rejects.toThrow(`Import job not found: ${job.id}`);
    await expect(repository.markImportJobFailed(demoProject.id, "missing-job", new Error("boom")))
      .rejects.toThrow("Import job not found: missing-job");
  });
});
