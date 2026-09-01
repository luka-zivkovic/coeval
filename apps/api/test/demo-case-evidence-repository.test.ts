import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoProject, demoSkill } from "@coeval/db";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as repositoryModule from "../src/repository.js";
import { DemoRepository } from "../src/repository.js";
import * as demoCaseEvidenceModule from "../src/repository/demo-case-evidence.js";
import { DemoCaseEvidenceRepository } from "../src/repository/demo-case-evidence.js";
import { DemoRepositoryStore } from "../src/repository/demo-store.js";
import {
  AmbiguousProjectSkillError,
  CaseNotFoundError,
  DatasetRevisionConflictError
} from "../src/repository/errors.js";

const EXPECTED_PUBLIC_METHODS = [
  "recordVerdict",
  "listVerdicts",
  "getProjectKappaSummary",
  "getProjectJudgeHumanCalibration",
  "getDisagreementSummary",
  "getJudgeHumanDisagreementSummary",
  "getConvergenceAudit",
  "getSelfConsistencyReport",
  "listAuditEntries",
  "listCases",
  "listCaseIdsForProject",
  "caseExistsForProject"
] as const;

const EXPECTED_DEPENDENCIES = [
  "caseExistsForProject",
  "getCaseDetail",
  "getCurrentSkill",
  "getDemoActorName",
  "getSkillVersion",
  "isEvidenceScaffoldingCase",
  "listSkillVersions",
  "resolveGoldenCriterionVersion"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.ts");
const CASE_EVIDENCE_REPOSITORY_PATH = path.join(
  API_SOURCE_DIRECTORY,
  "repository/demo-case-evidence.ts"
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

function caseEvidenceSliceAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const sliceSource = program.getSourceFile(CASE_EVIDENCE_REPOSITORY_PATH);
  if (!sliceSource) throw new Error("Demo case evidence repository source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(sliceSource);
  if (!moduleSymbol) throw new Error("Demo case evidence module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "DemoCaseEvidenceRepository");
  if (!classExport) throw new Error("DemoCaseEvidenceRepository export was not resolved");
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
          path.resolve(resolution.resolvedFileName) === path.resolve(CASE_EVIDENCE_REPOSITORY_PATH) &&
          (
            ts.isImportDeclaration(node.parent) ||
            ts.isExportDeclaration(node.parent) ||
            ts.isImportEqualsDeclaration(node.parent) ||
            ts.isCallExpression(node.parent)
          )
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
        node.text === "DemoCaseEvidenceRepository" &&
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

function caseEvidenceSlice(repository: DemoRepository): DemoCaseEvidenceRepository {
  return Reflect.get(repository, "caseEvidenceRepository") as DemoCaseEvidenceRepository;
}

function repositoryStore(repository: DemoRepository): DemoRepositoryStore {
  return Reflect.get(repository, "store") as DemoRepositoryStore;
}

describe("Demo case evidence repository slice", () => {
  it("owns exactly CaseEvidenceRepositoryPort behind stable facade delegates", () => {
    const sliceSource = sourceFile(CASE_EVIDENCE_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const slice = classDeclaration(sliceSource, "DemoCaseEvidenceRepository");
    const repository = classDeclaration(repositorySource, "DemoRepository");
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });

    expect(Object.keys(demoCaseEvidenceModule)).toEqual(["DemoCaseEvidenceRepository"]);
    expect("DemoCaseEvidenceRepository" in repositoryModule).toBe(false);
    expect(sliceSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement) && !ts.isInterfaceDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${
        ts.isClassDeclaration(statement) && statement.name
          ? statement.name.getText(sliceSource)
          : "<anonymous>"
      }`))
      .toEqual(["ClassDeclaration:DemoCaseEvidenceRepository"]);
    expect(slice.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(sliceSource))
    )).toEqual(["CaseEvidenceRepositoryPort"]);
    expect(slice.members.filter(ts.isMethodDeclaration)
      .filter((method) => !method.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword))
      .map((method) => method.name.getText(sliceSource)))
      .toEqual(EXPECTED_PUBLIC_METHODS);
    expect(slice.members.filter(ts.isMethodDeclaration)
      .filter((method) => method.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword))
      .map((method) => method.name.getText(sliceSource)))
      .toEqual(["verdictsForCriterion", "attachDemoActorNames"]);

    const facadeMethods = new Map(repository.members
      .filter(ts.isMethodDeclaration)
      .map((method) => [method.name.getText(repositorySource), method]));
    const expectedDelegateBodies: Record<(typeof EXPECTED_PUBLIC_METHODS)[number], string> = {
      recordVerdict: "{ return this.caseEvidenceRepository.recordVerdict(input); }",
      listVerdicts: "{ return this.caseEvidenceRepository.listVerdicts(input); }",
      getProjectKappaSummary: "{ return this.caseEvidenceRepository.getProjectKappaSummary(projectId, criterionVersionId); }",
      getProjectJudgeHumanCalibration: "{ return this.caseEvidenceRepository.getProjectJudgeHumanCalibration(projectId, criterionVersionId, skillVersionId); }",
      getDisagreementSummary: "{ return this.caseEvidenceRepository.getDisagreementSummary(projectId, criterionVersionId); }",
      getJudgeHumanDisagreementSummary: "{ return this.caseEvidenceRepository.getJudgeHumanDisagreementSummary(projectId, criterionVersionId); }",
      getConvergenceAudit: "{ return this.caseEvidenceRepository.getConvergenceAudit(projectId, skillId, versionId, input); }",
      getSelfConsistencyReport: "{ return this.caseEvidenceRepository.getSelfConsistencyReport(projectId, versionId); }",
      listAuditEntries: "{ return this.caseEvidenceRepository.listAuditEntries(); }",
      listCases: "{ return this.caseEvidenceRepository.listCases(projectId, opts); }",
      listCaseIdsForProject: "{ return this.caseEvidenceRepository.listCaseIdsForProject(projectId, limit); }",
      caseExistsForProject: "{ return this.caseEvidenceRepository.caseExistsForProject(projectId, caseId); }"
    };
    for (const name of EXPECTED_PUBLIC_METHODS) {
      const method = facadeMethods.get(name);
      if (!method) throw new Error(`DemoRepository.${name} not found`);
      expect(printer.printNode(ts.EmitHint.Unspecified, method.body!, repositorySource)
        .replace(/\s+/g, " ")
        .trim())
        .toBe(expectedDelegateBodies[name]);
    }

    const analysis = caseEvidenceSliceAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["DemoCaseEvidenceRepository"]);
    expect(analysis.allocations).toHaveLength(1);
    expect(analysis.allocations[0]).toMatch(/^repository\/demo-composition\.ts:createDemoRepositoryComposition:new DemoCaseEvidenceRepository\(store, \{/);
    expect(analysis.moduleEdges).toEqual([
      'repository/demo-composition.ts:ImportDeclaration:import { DemoCaseEvidenceRepository } from "./demo-case-evidence.js";'
    ]);
    expect(analysis.references).toEqual([
      "repository/demo-case-evidence.ts:ClassDeclaration:DemoCaseEvidenceRepository",
      "repository/demo-composition.ts:ImportSpecifier:DemoCaseEvidenceRepository",
      "repository/demo-composition.ts:NewExpression:DemoCaseEvidenceRepository",
      "repository/demo-composition.ts:TypeReference:DemoCaseEvidenceRepository"
    ]);

    const repositoryInstance = new DemoRepository();
    expect(Reflect.get(caseEvidenceSlice(repositoryInstance), "store"))
      .toBe(repositoryStore(repositoryInstance));
    expect(Object.keys(Reflect.get(caseEvidenceSlice(repositoryInstance), "dependencies") as object))
      .toEqual(EXPECTED_DEPENDENCIES);
  }, 30_000);

  it("preserves lazy facade dispatch across case, skill, and golden seams", async () => {
    class CapturingRepository extends DemoRepository {
      readonly calls: string[] = [];

      override async caseExistsForProject(projectId: string, caseId: string) {
        this.calls.push(`caseExistsForProject:${caseId}`);
        return caseId === "case_probe_missing" || super.caseExistsForProject(projectId, caseId);
      }

      override async getCaseDetail(...args: Parameters<DemoRepository["getCaseDetail"]>) {
        this.calls.push("getCaseDetail");
        return super.getCaseDetail(...args);
      }

      override async getCurrentSkill(...args: Parameters<DemoRepository["getCurrentSkill"]>) {
        this.calls.push("getCurrentSkill");
        return super.getCurrentSkill(...args);
      }

      override async getSkillVersion(...args: Parameters<DemoRepository["getSkillVersion"]>) {
        this.calls.push("getSkillVersion");
        return super.getSkillVersion(...args);
      }

      override async listSkillVersions(...args: Parameters<DemoRepository["listSkillVersions"]>) {
        this.calls.push("listSkillVersions");
        return super.listSkillVersions(...args);
      }
    }

    const repository = new CapturingRepository(undefined, { seedVerdicts: true });
    const imported = await repository.importTrace(demoProject.id, "manual", {
      sourceTraceId: "case_evidence_dispatch",
      input: { question: "Dispatch?" },
      output: { answer: "Preserved." },
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });
    repository.calls.length = 0;
    await repository.recordVerdict({
      projectId: demoProject.id,
      caseId: imported.caseId,
      source: "human",
      actorUserId: "user_maya",
      payload: { kind: "binary", pass: true, rationale: "Reviewed." }
    });
    await repository.recordVerdict({
      projectId: demoProject.id,
      caseId: "case_probe_missing",
      skillVersionId: "skillv_1_2_0",
      source: "human",
      actorUserId: "user_maya",
      payload: { kind: "binary", pass: true, rationale: "Missing." }
    });
    const missingCase = await repository.recordVerdict({
      projectId: demoProject.id,
      caseId: "case_probe_absent",
      skillVersionId: "skillv_1_2_0",
      source: "human",
      actorUserId: "user_maya",
      payload: { kind: "binary", pass: true, rationale: "Absent." }
    }).catch((error: unknown) => error);
    expect(missingCase).toBeInstanceOf(CaseNotFoundError);
    expect(missingCase).toHaveProperty(
      "message",
      "Case not found in this project: case_probe_absent"
    );
    await repository.getConvergenceAudit(
      demoProject.id,
      demoSkill.id,
      "skillv_1_2_0"
    );
    await repository.getProjectKappaSummary(demoProject.id);

    expect(repository.calls).toEqual([
      "getCaseDetail",
      "getCurrentSkill",
      "getCurrentSkill",
      "getCaseDetail",
      "getSkillVersion",
      "caseExistsForProject:case_probe_missing",
      "getCaseDetail",
      "getSkillVersion",
      "caseExistsForProject:case_probe_absent",
      "listSkillVersions",
      "getCurrentSkill"
    ]);
  });

  it("keeps case evidence isolated while verdicts complete shared queue-item identities", async () => {
    const repository = new DemoRepository();
    const imported = await repository.importTrace(demoProject.id, "manual", {
      sourceTraceId: "case_evidence_isolation",
      input: { question: "Isolated?" },
      output: { answer: "Yes." },
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });
    expect((await repository.listCases(demoProject.id)).map((entry) => entry.caseId))
      .toContain(imported.caseId);
    expect(await repository.listCases("project_other")).toEqual([]);
    expect(await repository.listCaseIdsForProject("project_other")).toEqual([]);
    expect(await repository.caseExistsForProject("project_other", "case_exc_001")).toBe(false);

    const queue = await repository.createReviewQueue({
      projectId: demoProject.id,
      name: "Case evidence identity",
      caseIds: ["case_exc_001"]
    });
    await repository.addReviewQueueItems({
      projectId: demoProject.id,
      queueId: queue.id,
      items: [
        { caseId: "case_exc_001", assignedToUserId: "user_maya" },
        { caseId: "case_exc_001", assignedToUserId: "user_jules" }
      ]
    });
    const store = repositoryStore(repository);
    const itemIdentities = store.reviewQueueItems.filter((item) => item.queueId === queue.id);

    const recorded = await repository.recordVerdict({
      projectId: demoProject.id,
      caseId: "case_exc_001",
      source: "human",
      actorUserId: "user_maya",
      payload: { kind: "binary", pass: true, rationale: "Reviewed by Maya." }
    });

    expect(store.verdicts.at(-1)).toBe(recorded);
    const itemsAfterVerdict = store.reviewQueueItems.filter((item) => item.queueId === queue.id);
    expect(itemsAfterVerdict).toHaveLength(itemIdentities.length);
    for (const [index, item] of itemsAfterVerdict.entries()) {
      expect(item).toBe(itemIdentities[index]);
    }
    expect(itemIdentities.map((item) => [item.assignedToUserId, item.status])).toEqual([
      [null, "completed"],
      ["user_maya", "completed"],
      ["user_jules", "pending"]
    ]);
    expect((await repository.listVerdicts({
      projectId: demoProject.id,
      caseId: "case_exc_001",
      source: "human",
      limit: 10
    }))[0]).toMatchObject({ id: recorded.id, actorName: "Maya" });
  });

  it("pins evidence filters, deterministic reads, criterion errors, and actor projection", async () => {
    const repository = new DemoRepository();
    const store = repositoryStore(repository);
    const first = await repository.importTrace(demoProject.id, "manual", {
      sourceTraceId: "case_evidence_order_a",
      input: { order: "a" },
      output: { answer: "a" },
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });
    const second = await repository.importTrace(demoProject.id, "manual", {
      sourceTraceId: "case_evidence_order_b",
      input: { order: "b" },
      output: { answer: "b" },
      metadata: {}
    }, { ingestionPurpose: "analysis_eligible_manual" });
    const tiedCreatedAt = "2026-08-31T12:00:00.000Z";
    store.traceSources.get(first.caseId)!.createdAt = tiedCreatedAt;
    store.traceSources.get(second.caseId)!.createdAt = tiedCreatedAt;
    expect((await repository.listCases(demoProject.id, { limit: 2 })).map((entry) => entry.caseId))
      .toEqual([first.caseId, second.caseId].sort());
    expect(await repository.listCases(demoProject.id, { since: tiedCreatedAt })).toEqual([]);

    const scaffolding = await repository.importTrace(demoProject.id, "release_evidence", {
      sourceTraceId: "case_evidence_scaffolding",
      input: { hidden: true },
      output: { answer: "evidence" },
      metadata: {}
    }, { ingestionPurpose: "release_evidence" });
    const firstVerdict = await repository.recordVerdict({
      projectId: demoProject.id,
      caseId: first.caseId,
      source: "imported_external",
      externalRunId: "case_evidence_sort_a",
      payload: { kind: "binary", pass: true, rationale: "First." }
    });
    const secondVerdict = await repository.recordVerdict({
      projectId: demoProject.id,
      caseId: second.caseId,
      source: "imported_external",
      externalRunId: "case_evidence_sort_b",
      payload: { kind: "binary", pass: false, rationale: "Second." }
    });
    firstVerdict.createdAt = "2026-08-31T12:00:00.000Z";
    secondVerdict.createdAt = "2026-08-31T12:00:01.000Z";
    const scaffoldingVerdict = await repository.recordVerdict({
      projectId: demoProject.id,
      caseId: scaffolding.caseId,
      source: "llm_judge",
      skillVersionId: demoSkill.currentVersion.id,
      payload: { kind: "binary", pass: true, rationale: "Scaffolding." }
    });
    expect((await repository.listVerdicts({ projectId: demoProject.id, limit: 10 })).map((entry) => entry.id))
      .toEqual([scaffoldingVerdict.id, secondVerdict.id, firstVerdict.id]);
    expect(await repository.listVerdicts({
      projectId: demoProject.id,
      evidenceScope: "customer",
      caseId: scaffolding.caseId,
      limit: 10
    })).toEqual([]);
    expect(await repository.listCaseIdsForProject(demoProject.id, 1)).toHaveLength(1);
    expect(await repository.listCaseIdsForProject(demoProject.id, 10_000))
      .not.toContain(scaffolding.caseId);
    const selfConsistencyBeforeForeign = await repository.getSelfConsistencyReport(
      demoProject.id,
      demoSkill.currentVersion.id
    );
    store.verdicts.push({
      ...scaffoldingVerdict,
      id: "verdict_foreign_self_consistency",
      projectId: "project_other",
      payload: { kind: "binary", pass: false, rationale: "Foreign repeat." }
    });
    expect(await repository.getSelfConsistencyReport(demoProject.id, demoSkill.currentVersion.id))
      .toEqual(selfConsistencyBeforeForeign);

    const unknownActor = await repository.recordVerdict({
      projectId: demoProject.id,
      caseId: "case_exc_001",
      source: "human",
      actorUserId: "user_unknown",
      payload: { kind: "binary", pass: true, rationale: "Unknown reviewer." }
    });
    await repository.recordVerdict({
      projectId: demoProject.id,
      caseId: "case_exc_001",
      source: "human",
      actorUserId: "user_maya",
      payload: { kind: "binary", pass: false, rationale: "Known reviewer." }
    });
    const disagreement = await repository.getDisagreementSummary(demoProject.id);
    expect(disagreement.cases.find((entry) => entry.caseId === "case_exc_001")?.labels)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ actorUserId: "user_unknown", actorName: null }),
        expect.objectContaining({ actorUserId: "user_maya", actorName: "Maya" })
      ]));
    const kappaBeforeForeign = await repository.getProjectKappaSummary(demoProject.id);
    store.verdicts.push({
      ...unknownActor,
      id: "verdict_foreign_project",
      projectId: "project_other",
      actorUserId: "user_foreign",
      payload: { kind: "binary", pass: false, rationale: "Foreign." }
    });
    expect(await repository.getProjectKappaSummary(demoProject.id)).toEqual(kappaBeforeForeign);

    const criterionVersion = store.criterionVersions[0]!;
    store.criterionVersions.push({
      ...criterionVersion,
      id: "criterionv_case_evidence_extra"
    });
    const ambiguity = await repository.recordVerdict({
      projectId: demoProject.id,
      caseId: "case_exc_001",
      source: "human",
      actorUserId: "user_maya",
      payload: { kind: "binary", pass: true, rationale: "Ambiguous." }
    }).catch((error: unknown) => error);
    expect(ambiguity).toBeInstanceOf(AmbiguousProjectSkillError);
    expect(ambiguity).toHaveProperty(
      "message",
      `Project ${demoProject.id} has 2 evaluator scopes; choose a criterion or skillVersionId explicitly.`
    );

    const invalidCriterion = await repository.getProjectKappaSummary(
      demoProject.id,
      "criterionv_missing"
    ).catch((error: unknown) => error);
    expect(invalidCriterion).toBeInstanceOf(DatasetRevisionConflictError);
    expect(invalidCriterion).toHaveProperty(
      "message",
      "Criterion version does not belong to this project: criterionv_missing"
    );
  });
});
