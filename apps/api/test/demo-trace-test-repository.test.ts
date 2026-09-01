import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoProject } from "@coeval/db";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as repositoryModule from "../src/repository.js";
import { DemoRepository } from "../src/repository.js";
import type {
  CreateTraceTestInputDb,
  RecordTraceTestValidationInputDb,
  ReviseTraceTestInputDb
} from "../src/repository/contracts.js";
import {
  TraceTestNotFoundError,
  TraceTestRevisionConflictError,
  TraceTestSourceNotFoundError,
  TraceTestValidationNotReadyError
} from "../src/repository/errors.js";
import { DemoRepositoryStore } from "../src/repository/demo-store.js";
import * as demoTraceTestModule from "../src/repository/demo-trace-tests.js";
import { DemoTraceTestRepository } from "../src/repository/demo-trace-tests.js";

const EXPECTED_PUBLIC_METHODS = [
  "createTraceTest",
  "listTraceTests",
  "getTraceTest",
  "reviseTraceTest",
  "recordTraceTestValidation",
  "enableTraceTest",
  "recordTraceTestFunnelEvent"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const API_SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const REPOSITORY_PATH = path.join(API_SOURCE_DIRECTORY, "repository.ts");
const TRACE_TEST_REPOSITORY_PATH = path.join(
  API_SOURCE_DIRECTORY,
  "repository/demo-trace-tests.ts"
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

function traceTestSliceAnalysis(program: ts.Program) {
  const checker = program.getTypeChecker();
  const sliceSource = program.getSourceFile(TRACE_TEST_REPOSITORY_PATH);
  if (!sliceSource) throw new Error("Demo trace-test repository source was not loaded");
  const moduleSymbol = checker.getSymbolAtLocation(sliceSource);
  if (!moduleSymbol) throw new Error("Demo trace-test module symbol was not resolved");
  const compilerExports = checker.getExportsOfModule(moduleSymbol);
  const classExport = compilerExports.find((symbol) => symbol.name === "DemoTraceTestRepository");
  if (!classExport) throw new Error("DemoTraceTestRepository export was not resolved");
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
        if (resolution && path.resolve(resolution.resolvedFileName) === path.resolve(TRACE_TEST_REPOSITORY_PATH)) {
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
        node.text === "DemoTraceTestRepository" &&
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

function traceTestSlice(repository: DemoRepository): DemoTraceTestRepository {
  return Reflect.get(repository, "traceTestRepository") as DemoTraceTestRepository;
}

function traceTestStore(repository: DemoRepository): DemoRepositoryStore {
  return Reflect.get(repository, "store") as DemoRepositoryStore;
}

function draftInput(
  sourceCaseId: string,
  overrides: Partial<CreateTraceTestInputDb> = {}
): CreateTraceTestInputDb {
  return {
    projectId: demoProject.id,
    sourceCaseId,
    sourceScope: { responsePath: ["output"], turnIndexes: [0, 1], stepIndexes: [2] },
    desiredBehavior: "Check eligibility before promising a refund.",
    scenario: "A customer asks for a refund after renewal.",
    expectedBehavior: "Explain the policy-qualified refund path.",
    mustDo: ["Check eligibility"],
    mustAvoid: ["Promise a refund without evidence"],
    goodExample: { text: "I will check whether this renewal is eligible." },
    badExample: { text: "Your refund is guaranteed." },
    checker: { kind: "judge", label: "Refund policy behavior", metadata: { owner: "quality" } },
    draftProvenance: {
      origin: "generated",
      generatedFields: ["scenario", "expectedBehavior", "mustDo", "mustAvoid", "goodExample", "checker"],
      generator: { provider: "mock", model: "mock-drafter" }
    },
    ...overrides
  };
}

async function importedSource(repository: DemoRepository, sourceTraceId: string) {
  return repository.importTrace(demoProject.id, "manual", {
    sourceTraceId,
    input: { messages: [{ role: "user", content: "Can I get a refund?" }] },
    output: { messages: [{ role: "assistant", content: "Your refund is guaranteed." }] },
    metadata: { channel: "support" },
    steps: [{ name: "lookup", input: { account: "masked" }, output: { eligible: false } }]
  }, { ingestionPurpose: "analysis_eligible_manual" });
}

function validationInput(
  traceTestId: string,
  revision: number,
  overrides: Partial<RecordTraceTestValidationInputDb> = {}
): RecordTraceTestValidationInputDb {
  return {
    projectId: demoProject.id,
    traceTestId,
    revision,
    badEvidence: { output: { text: "bad" }, result: "fail", note: "bad output" },
    goodEvidence: { output: { text: "good" }, result: "pass", note: "good output" },
    ...overrides
  };
}

describe("Demo trace-test repository slice", () => {
  it("owns exactly TraceTestRepositoryPort behind stable facade delegates", () => {
    const sliceSource = sourceFile(TRACE_TEST_REPOSITORY_PATH);
    const repositorySource = sourceFile(REPOSITORY_PATH);
    const slice = classDeclaration(sliceSource, "DemoTraceTestRepository");
    const repository = classDeclaration(repositorySource, "DemoRepository");
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });

    expect(Object.keys(demoTraceTestModule)).toEqual(["DemoTraceTestRepository"]);
    expect("DemoTraceTestRepository" in repositoryModule).toBe(false);
    expect(sliceSource.statements
      .filter((statement) => !ts.isImportDeclaration(statement) && !ts.isInterfaceDeclaration(statement))
      .map((statement) => `${ts.SyntaxKind[statement.kind]}:${
        ts.isClassDeclaration(statement) && statement.name
          ? statement.name.getText(sliceSource)
          : "<anonymous>"
      }`))
      .toEqual(["ClassDeclaration:DemoTraceTestRepository"]);
    expect(slice.heritageClauses?.flatMap((clause) =>
      clause.types.map((type) => type.expression.getText(sliceSource))
    )).toEqual(["TraceTestRepositoryPort"]);
    expect(slice.members.map((member) =>
      ts.isMethodDeclaration(member)
        ? `MethodDeclaration:${member.name.getText(sliceSource)}`
        : ts.SyntaxKind[member.kind]
    )).toEqual([
      "Constructor",
      ...EXPECTED_PUBLIC_METHODS.map((name) => `MethodDeclaration:${name}`),
      "MethodDeclaration:toTraceTestSummary",
      "MethodDeclaration:toTraceTestDetail"
    ]);
    for (const name of ["toTraceTestSummary", "toTraceTestDetail"]) {
      const helper = slice.members.find((member): member is ts.MethodDeclaration =>
        ts.isMethodDeclaration(member) && member.name.getText(sliceSource) === name
      );
      expect(helper?.modifiers?.map((modifier) => ts.SyntaxKind[modifier.kind]))
        .toEqual(["PrivateKeyword"]);
    }

    const facadeMethods = new Map(repository.members
      .filter(ts.isMethodDeclaration)
      .map((method) => [method.name.getText(repositorySource), method]));
    const expectedDelegateBodies: Record<(typeof EXPECTED_PUBLIC_METHODS)[number], string> = {
      createTraceTest: "{ return this.traceTestRepository.createTraceTest(input); }",
      listTraceTests: "{ return this.traceTestRepository.listTraceTests(projectId, sourceCaseRef); }",
      getTraceTest: "{ return this.traceTestRepository.getTraceTest(projectId, traceTestId); }",
      reviseTraceTest: "{ return this.traceTestRepository.reviseTraceTest(input); }",
      recordTraceTestValidation: "{ return this.traceTestRepository.recordTraceTestValidation(input); }",
      enableTraceTest: "{ return this.traceTestRepository.enableTraceTest(input); }",
      recordTraceTestFunnelEvent: "{ return this.traceTestRepository.recordTraceTestFunnelEvent(input); }"
    };
    for (const name of EXPECTED_PUBLIC_METHODS) {
      const method = facadeMethods.get(name);
      if (!method) throw new Error(`DemoRepository.${name} not found`);
      expect(printer.printNode(ts.EmitHint.Unspecified, method.body!, repositorySource)
        .replace(/\s+/g, " ")
        .trim())
        .toBe(expectedDelegateBodies[name]);
    }

    const analysis = traceTestSliceAnalysis(createApiProgram());
    expect(analysis.compilerExports).toEqual(["DemoTraceTestRepository"]);
    expect(analysis.allocations).toEqual([
      "repository/demo-composition.ts:createDemoRepositoryComposition:new DemoTraceTestRepository(store, { getCaseDetail: (projectId, caseId) => facade.getCaseDetail(projectId, caseId) })"
    ]);
    expect(analysis.moduleEdges).toEqual([
      'repository/demo-composition.ts:ImportDeclaration:import { DemoTraceTestRepository } from "./demo-trace-tests.js";'
    ]);
    expect(analysis.moduleSpecifierMentions).toEqual([
      'repository/demo-composition.ts:ImportDeclaration:"./demo-trace-tests.js"'
    ]);
    expect(analysis.references).toEqual([
      "repository/demo-composition.ts:ImportSpecifier:DemoTraceTestRepository",
      "repository/demo-composition.ts:NewExpression:DemoTraceTestRepository",
      "repository/demo-composition.ts:TypeReference:DemoTraceTestRepository",
      "repository/demo-trace-tests.ts:ClassDeclaration:DemoTraceTestRepository"
    ]);

    const repositoryInstance = new DemoRepository();
    expect(Reflect.get(traceTestSlice(repositoryInstance), "store"))
      .toBe(traceTestStore(repositoryInstance));
    expect(Object.keys(Reflect.get(traceTestSlice(repositoryInstance), "dependencies") as object))
      .toEqual(["getCaseDetail"]);
  }, 30_000);

  it("preserves lazy source lookup, shared imported traces, snapshots, and defensive copies", async () => {
    class CapturingRepository extends DemoRepository {
      readonly caseDetailCalls: string[] = [];

      override async getCaseDetail(projectId: string, caseId: string, skillVersionId?: string) {
        this.caseDetailCalls.push(`${projectId}:${caseId}:${skillVersionId ?? "current"}`);
        return super.getCaseDetail(projectId, caseId, skillVersionId);
      }
    }

    const repository = new CapturingRepository();
    const sourceInput = draftInput("case_exc_001", { createdByUserId: "user_author" });
    const created = await repository.createTraceTest(sourceInput);
    expect(repository.caseDetailCalls).toEqual([`${demoProject.id}:case_exc_001:current`]);
    expect(created).toMatchObject({
      id: expect.stringMatching(/^tt_/),
      projectId: demoProject.id,
      sourceCaseId: "case_exc_001",
      sourceCaseRef: "case_exc_001",
      sourceTraceRef: "ls_run_8f31",
      lifecycle: "draft",
      currentRevision: 1,
      enabledRevision: null,
      hasUnpublishedChanges: false,
      createdByUserId: "user_author",
      sourceSnapshot: {
        input: { text: "Demo customer support question" },
        output: { text: "Demo AI answer for case drill-down" },
        metadata: { source: "demo" }
      },
      sourceScope: sourceInput.sourceScope,
      validations: []
    });
    expect(created.sourceSnapshot).toStrictEqual({
      input: { text: "Demo customer support question" },
      output: { text: "Demo AI answer for case drill-down" },
      metadata: { source: "demo", capabilityGap: "policy_grounding" }
    });
    expect(created.revisions).toEqual([expect.objectContaining({
      id: expect.stringMatching(/^ttr_/),
      traceTestId: created.id,
      revision: 1,
      lifecycle: "draft",
      desiredBehavior: sourceInput.desiredBehavior,
      scenario: sourceInput.scenario,
      expectedBehavior: sourceInput.expectedBehavior,
      mustDo: sourceInput.mustDo,
      mustAvoid: sourceInput.mustAvoid,
      goodExample: sourceInput.goodExample,
      badExample: sourceInput.badExample,
      checker: sourceInput.checker,
      draftProvenance: sourceInput.draftProvenance,
      validationId: null,
      validatedRevision: null,
      createdByUserId: "user_author",
      reviewedByUserId: null,
      reviewedAt: null
    })]);

    sourceInput.sourceScope.turnIndexes.push(99);
    sourceInput.mustDo.push("mutated caller input");
    (created.sourceSnapshot as { metadata: { source: string } }).metadata.source = "mutated result";
    created.revisions[0]!.mustDo.push("mutated result");
    const reread = await repository.getTraceTest(demoProject.id, created.id);
    expect(reread?.sourceScope.turnIndexes).toEqual([0, 1]);
    expect((reread?.sourceSnapshot as { metadata: object }).metadata).toEqual({
      source: "demo",
      capabilityGap: "policy_grounding"
    });
    expect(reread?.revisions[0]?.mustDo).toEqual(["Check eligibility"]);

    const imported = await importedSource(repository, "trace_test_shared_source");
    const callsBeforeStoredCreate = repository.caseDetailCalls.length;
    const importedInput = draftInput(imported.caseId);
    const importedTest = await repository.createTraceTest(importedInput);
    expect(repository.caseDetailCalls).toHaveLength(callsBeforeStoredCreate);
    expect(importedTest.sourceTraceRef).toBe("trace_test_shared_source");
    expect(importedTest.sourceSnapshot).toEqual({
      input: { messages: [{ role: "user", content: "Can I get a refund?" }] },
      output: { messages: [{ role: "assistant", content: "Your refund is guaranteed." }] },
      metadata: { channel: "support" },
      steps: [{ name: "lookup", input: { account: "masked" }, output: { eligible: false } }]
    });
    const importedStoredTrace = traceTestStore(repository).traces.get(imported.caseId)!;
    (importedStoredTrace.metadata as { channel: string }).channel = "mutated source";
    importedStoredTrace.steps![0]!.output = { eligible: true };
    expect((await repository.getTraceTest(demoProject.id, importedTest.id))?.sourceSnapshot).toEqual({
      input: { messages: [{ role: "user", content: "Can I get a refund?" }] },
      output: { messages: [{ role: "assistant", content: "Your refund is guaranteed." }] },
      metadata: { channel: "support" },
      steps: [{ name: "lookup", input: { account: "masked" }, output: { eligible: false } }]
    });

    await expect(repository.createTraceTest(draftInput("case_exc_001", { projectId: "project_other" })))
      .rejects.toEqual(new TraceTestSourceNotFoundError("case_exc_001"));
    await expect(repository.createTraceTest(draftInput("case_missing")))
      .rejects.toEqual(new TraceTestSourceNotFoundError("case_missing"));
  });

  it("preserves revision conflicts, project isolation, ordering, filtering, and unpublished state", async () => {
    const repository = new DemoRepository();
    const firstSource = await importedSource(repository, "trace_test_order_a");
    const secondSource = await importedSource(repository, "trace_test_order_b");
    const first = await repository.createTraceTest(draftInput(firstSource.caseId));
    const second = await repository.createTraceTest(draftInput(firstSource.caseId));
    const third = await repository.createTraceTest(draftInput(secondSource.caseId));
    const store = traceTestStore(repository);
    const firstRecord = store.traceTests.find((candidate) => candidate.id === first.id)!;
    const secondRecord = store.traceTests.find((candidate) => candidate.id === second.id)!;
    const thirdRecord = store.traceTests.find((candidate) => candidate.id === third.id)!;
    firstRecord.updatedAt = "2026-01-01T00:00:00.000Z";
    secondRecord.updatedAt = "2026-01-01T00:00:00.000Z";
    thirdRecord.updatedAt = "2026-01-02T00:00:00.000Z";

    const sameTimestampOrder = [first.id, second.id].sort((left, right) => right.localeCompare(left));
    expect((await repository.listTraceTests(demoProject.id)).map((test) => test.id))
      .toEqual([third.id, ...sameTimestampOrder]);
    expect((await repository.listTraceTests(demoProject.id, firstSource.caseId)).map((test) => test.id))
      .toEqual(sameTimestampOrder);
    expect(await repository.listTraceTests("project_other")).toEqual([]);
    expect(await repository.getTraceTest("project_other", first.id)).toBeNull();
    expect(await repository.getTraceTest(demoProject.id, "tt_missing")).toBeNull();

    await expect(repository.reviseTraceTest({
      ...draftInput(firstSource.caseId),
      traceTestId: "tt_missing",
      expectedRevision: 1
    })).rejects.toEqual(new TraceTestNotFoundError("tt_missing"));
    await expect(repository.reviseTraceTest({
      ...draftInput(firstSource.caseId),
      projectId: "project_other",
      traceTestId: first.id,
      expectedRevision: 1
    })).rejects.toEqual(new TraceTestNotFoundError(first.id));
    const stale = repository.reviseTraceTest({
      ...draftInput(firstSource.caseId),
      traceTestId: first.id,
      expectedRevision: 2
    });
    await expect(stale).rejects.toEqual(new TraceTestRevisionConflictError(2, 1));

    const revisionInput: ReviseTraceTestInputDb = {
      ...draftInput(firstSource.caseId),
      traceTestId: first.id,
      expectedRevision: 1,
      desiredBehavior: "Check eligibility and explain the next cancellation step.",
      scenario: "A customer asks to cancel and requests a refund.",
      createdByUserId: "user_editor"
    };
    const revised = await repository.reviseTraceTest(revisionInput);
    expect(revised).toMatchObject({
      id: first.id,
      lifecycle: "draft",
      currentRevision: 2,
      enabledRevision: null,
      hasUnpublishedChanges: false
    });
    expect(revised.revisions.map((revision) => revision.revision)).toEqual([1, 2]);
    expect(revised.revisions[1]).toMatchObject({
      lifecycle: "draft",
      desiredBehavior: revisionInput.desiredBehavior,
      scenario: revisionInput.scenario,
      validationId: null,
      validatedRevision: null,
      createdByUserId: "user_editor",
      reviewedByUserId: null,
      reviewedAt: null
    });
    revisionInput.mustAvoid.push("mutated caller input");
    revised.revisions[1]!.mustAvoid.push("mutated result");
    store.traceTestRevisions.reverse();
    const reread = await repository.getTraceTest(demoProject.id, first.id);
    expect(reread?.revisions.map((revision) => revision.revision)).toEqual([1, 2]);
    expect(reread?.revisions[1]?.mustAvoid).toEqual(["Promise a refund without evidence"]);
  });

  it("preserves validation defaults, eligibility, append-only enablement, and sorted defensive reads", async () => {
    const repository = new DemoRepository();
    const imported = await importedSource(repository, "trace_test_validation");
    const created = await repository.createTraceTest(draftInput(imported.caseId, {
      createdByUserId: "user_author"
    }));
    const store = traceTestStore(repository);

    const nondiscriminatingInput = validationInput(created.id, 1, {
      badEvidence: { output: { text: "same bad" }, result: "pass", note: null },
      goodEvidence: { output: { text: "same good" }, result: "pass", note: null }
    });
    const nondiscriminating = await repository.recordTraceTestValidation(nondiscriminatingInput);
    expect(nondiscriminating).toEqual({
      id: expect.stringMatching(/^ttv_/),
      traceTestId: created.id,
      revision: 1,
      status: "non_discriminating",
      badEvidence: {
        output: { text: "same bad" }, result: "pass", note: null,
        expectedResult: "fail", attempts: 0, usage: null
      },
      goodEvidence: {
        output: { text: "same good" }, result: "pass", note: null,
        expectedResult: "pass", attempts: 0, usage: null
      },
      method: "automated",
      diagnostic: "always_pass",
      evaluator: null,
      overrideReason: null,
      recordedByUserId: null,
      createdAt: expect.any(String)
    });
    (nondiscriminating.badEvidence.output as { text: string }).text = "mutated result";
    (nondiscriminatingInput.badEvidence.output as { text: string }).text = "mutated bad input";
    (nondiscriminatingInput.goodEvidence.output as { text: string }).text = "mutated input";
    await expect(repository.enableTraceTest({
      projectId: demoProject.id,
      traceTestId: created.id,
      expectedRevision: 1,
      validationId: nondiscriminating.id,
      reviewedByUserId: "user_reviewer"
    })).rejects.toEqual(new TraceTestValidationNotReadyError(
      "A successful validation for the current draft is required before enabling this test"
    ));

    await expect(repository.recordTraceTestValidation(validationInput("tt_missing", 1)))
      .rejects.toEqual(new TraceTestNotFoundError("tt_missing"));
    await expect(repository.recordTraceTestValidation({
      ...validationInput(created.id, 1),
      projectId: "project_other"
    })).rejects.toEqual(new TraceTestNotFoundError(created.id));
    await expect(repository.recordTraceTestValidation(validationInput(created.id, 2)))
      .rejects.toEqual(new TraceTestRevisionConflictError(2, 1));

    const passed = await repository.recordTraceTestValidation(validationInput(created.id, 1, {
      method: "manual_override",
      diagnostic: null,
      overrideReason: "A human reviewed both examples and confirmed the contrast.",
      badAttempts: 2,
      goodAttempts: 1,
      badUsage: { inputTokens: 12, outputTokens: 3 },
      goodUsage: { inputTokens: 9, outputTokens: 2 },
      recordedByUserId: "user_validator"
    }));
    expect(passed).toMatchObject({
      status: "passed",
      method: "manual_override",
      diagnostic: null,
      evaluator: null,
      overrideReason: "A human reviewed both examples and confirmed the contrast.",
      badEvidence: { expectedResult: "fail", attempts: 2, usage: { inputTokens: 12, outputTokens: 3 } },
      goodEvidence: { expectedResult: "pass", attempts: 1, usage: { inputTokens: 9, outputTokens: 2 } },
      recordedByUserId: "user_validator"
    });
    const storedNondiscriminating = store.traceTestValidations.find((item) => item.id === nondiscriminating.id)!;
    const storedPassed = store.traceTestValidations.find((item) => item.id === passed.id)!;
    storedNondiscriminating.createdAt = "2026-01-02T00:00:00.000Z";
    storedPassed.createdAt = "2026-01-01T00:00:00.000Z";
    const validationRead = await repository.getTraceTest(demoProject.id, created.id);
    expect(validationRead?.validations.map((validation) => validation.id))
      .toEqual([passed.id, nondiscriminating.id]);
    expect((validationRead?.validations[1]?.badEvidence.output as { text: string }).text)
      .toBe("same bad");
    expect((validationRead?.validations[1]?.goodEvidence.output as { text: string }).text)
      .toBe("same good");
    validationRead!.validations[1]!.diagnostic = "reversed";
    expect(store.traceTestValidations.find((item) => item.id === nondiscriminating.id)?.diagnostic)
      .toBe("always_pass");

    const enabled = await repository.enableTraceTest({
      projectId: demoProject.id,
      traceTestId: created.id,
      expectedRevision: 1,
      validationId: passed.id,
      reviewedByUserId: "user_reviewer"
    });
    expect(enabled).toMatchObject({
      lifecycle: "enabled",
      currentRevision: 2,
      enabledRevision: 2,
      hasUnpublishedChanges: false
    });
    expect(enabled.revisions[1]).toMatchObject({
      revision: 2,
      lifecycle: "enabled",
      validationId: passed.id,
      validatedRevision: 1,
      createdByUserId: "user_author",
      reviewedByUserId: "user_reviewer",
      reviewedAt: expect.any(String)
    });
    const draftRevision = store.traceTestRevisions.find(
      (revision) => revision.traceTestId === created.id && revision.revision === 1
    )!;
    const enabledStoreRevision = store.traceTestRevisions.find(
      (revision) => revision.traceTestId === created.id && revision.revision === 2
    )!;
    expect(enabledStoreRevision.mustDo).not.toBe(draftRevision.mustDo);
    enabledStoreRevision.mustDo.push("mutated enabled revision");
    expect(draftRevision.mustDo).toEqual(["Check eligibility"]);
    enabledStoreRevision.mustDo.pop();

    await expect(repository.enableTraceTest({
      projectId: "project_other",
      traceTestId: created.id,
      expectedRevision: 2,
      validationId: passed.id,
      reviewedByUserId: "user_reviewer"
    })).rejects.toEqual(new TraceTestNotFoundError(created.id));

    const secondPassed = await repository.recordTraceTestValidation(validationInput(created.id, 2, {
      evaluator: { provider: "mock", model: "mock-judge", version: "v1" }
    }));
    await expect(repository.enableTraceTest({
      projectId: demoProject.id,
      traceTestId: created.id,
      expectedRevision: 2,
      validationId: secondPassed.id,
      reviewedByUserId: "user_reviewer"
    })).rejects.toEqual(new TraceTestValidationNotReadyError(
      "Create a new draft revision before enabling this test again"
    ));

    const enabledRevision = store.traceTestRevisions.find(
      (revision) => revision.traceTestId === created.id && revision.revision === 2
    )!;
    store.traceTestRevisions.splice(store.traceTestRevisions.indexOf(enabledRevision), 1);
    await expect(repository.enableTraceTest({
      projectId: demoProject.id,
      traceTestId: created.id,
      expectedRevision: 2,
      validationId: secondPassed.id,
      reviewedByUserId: "user_reviewer"
    })).rejects.toEqual(new TraceTestRevisionConflictError(2, 2));
    store.traceTestRevisions.push(enabledRevision);

    const revised = await repository.reviseTraceTest({
      ...draftInput(imported.caseId),
      traceTestId: created.id,
      expectedRevision: 2,
      desiredBehavior: "Preserve eligibility checks and explain the cancellation sequence."
    });
    expect(revised).toMatchObject({
      lifecycle: "enabled",
      currentRevision: 3,
      enabledRevision: 2,
      hasUnpublishedChanges: true
    });
    expect(revised.revisions.map((revision) => revision.lifecycle)).toEqual(["draft", "enabled", "draft"]);
  });

  it("preserves content-free funnel idempotency on the exact shared set", async () => {
    const repository = new DemoRepository();
    const input = {
      projectId: demoProject.id,
      journeyId: "journey_trace_test",
      event: "validation_completed" as const,
      elapsedMs: 42_000,
      intent: "prevent" as const,
      actorUserId: "user_actor"
    };
    await repository.recordTraceTestFunnelEvent(input);
    await repository.recordTraceTestFunnelEvent({ ...input, elapsedMs: 84_000, actorUserId: "user_other" });
    const events = traceTestStore(repository).traceTestFunnelEvents;
    expect([...events]).toEqual([
      `${demoProject.id}:journey_trace_test:validation_completed`
    ]);
  });
});
