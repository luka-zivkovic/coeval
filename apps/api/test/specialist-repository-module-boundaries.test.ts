import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { PgBinaryCalibrationRepository } from "../src/binary-calibration/repository.pg.js";
import * as binaryAuthorizationModule from "../src/binary-calibration/repository.pg-authorization.js";
import * as binarySupportModule from "../src/binary-calibration/repository.pg-support.js";
import { PgGovernedReviewRepository } from "../src/governed-review/repository.pg.js";
import * as governedAdministrationModule from "../src/governed-review/repository.pg-administration.js";
import * as governedCommonModule from "../src/governed-review/repository.pg-common.js";
import * as governedEvidenceModule from "../src/governed-review/repository.pg-evidence.js";
import * as governedFrameModule from "../src/governed-review/repository.pg-frame-support.js";
import * as governedStreamModule from "../src/governed-review/repository.pg-stream-support.js";

const GOVERNED_ADMINISTRATION_METHODS = [
  "listInstructions",
  "createInstruction",
  "listAssignableSubjects",
  "createSealedIntake",
  "createBatchDraft",
  "listBatches",
  "getBatchSummary",
  "transitionBatch"
] as const;

const GOVERNED_EVIDENCE_METHODS = [
  "listReviewerTasks",
  "getOrCreateBlindTaskView",
  "appendTaskAction",
  "getPostBarrierItemView",
  "appendAlignmentEvent",
  "appendAdjudication",
  "createImportedTruth",
  "listImportedTruth"
] as const;

const BINARY_METHODS = [
  "createRun",
  "listRuns",
  "getRun",
  "getArtifact",
  "getArtifactStatus",
  "listRunnableRunIds",
  "claimRun",
  "heartbeatClaim",
  "authorizeRun",
  "recoverStartedAttempts",
  "getNextAttempt",
  "recordProviderCallStarted",
  "completeAttempt",
  "finalizeRun",
  "markRecoveryRequired"
] as const;

const GOVERNED_COMMON_EXPORTS = [
  "ALLOWED_LABELS",
  "BatchRow",
  "COVERED_CAPABILITIES",
  "Db",
  "INTERNAL_VIEW_IDEMPOTENCY_KEY",
  "MAX_BLIND_VIEW_BYTES",
  "asStringArray",
  "assertReplay",
  "dbDigest",
  "ensureSubject",
  "isEmptyObject",
  "isPgError",
  "iso",
  "jsonParam",
  "loadAdjudication",
  "mapPgError",
  "normalizedTimestamp",
  "parseJson",
  "requireOwnerActor",
  "resolveSubjectId",
  "rowToAlignment",
  "rowToImportedTruth",
  "rowToInstruction",
  "rowToIntake",
  "sealedItemId",
  "sha256Bytes",
  "stableId",
  "taskEventContent"
] as const;

const GOVERNED_FRAME_EXPORTS = [
  "assertBatchBlindViewsWithinLimit",
  "buildBlindTaskViewArtifact",
  "preparePromotionFrame",
  "prepareRevisionFrame",
  "prepareSealedFrame",
  "translateSelection"
] as const;

const GOVERNED_STREAM_EXPORTS = [
  "appendCapabilityChecks",
  "batchEventDetails",
  "contentExposedSubjects",
  "currentBatchState",
  "currentTaskState",
  "deriveBatchEventKind",
  "loadBatchProjection",
  "loadTaskMutation",
  "lockBatch",
  "materializeFrozenTruth",
  "observeBatchEventClock",
  "readTaskStateWithoutScope",
  "rowToTaskProjection"
] as const;

const BINARY_AUTHORIZATION_EXPORTS = [
  "deriveRunIdentity",
  "evaluateEligibility",
  "insertExposureCheck",
  "loadAuthorizedRun",
  "loadExposureCheck",
  "requireActiveRevisionLease",
  "requireClaim",
  "snapshotRecord"
] as const;

const BINARY_SUPPORT_EXPORTS = [
  "COVERED_CAPABILITIES",
  "Db",
  "EligibilityResult",
  "FrozenOriginRow",
  "RunRow",
  "aggregateTrial",
  "artifactCopyFromRow",
  "asStringArray",
  "claimFromRow",
  "databaseClock",
  "insertEvaluatorExecutionAuthorization",
  "isEmptyObject",
  "isString",
  "mapPgError",
  "nullableString",
  "parseJson",
  "providerPolicyFor",
  "repoError",
  "requestedBindingFor",
  "requestedBindingFromRun",
  "requireOwner",
  "requireProjectOwner",
  "rowToRun",
  "skillVersionFromRow",
  "stableId",
  "toIso",
  "validateAttemptCompletion",
  "validateClaimInput",
  "validateCreateInput"
] as const;

const API_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_DIRECTORY = path.join(API_DIRECTORY, "src");
const sourcePath = (relative: string) => path.join(SOURCE_DIRECTORY, relative);

const PATHS = {
  binary: sourcePath("binary-calibration/repository.pg.ts"),
  binaryAuthorization: sourcePath("binary-calibration/repository.pg-authorization.ts"),
  binaryPort: sourcePath("binary-calibration/repository.ts"),
  binarySupport: sourcePath("binary-calibration/repository.pg-support.ts"),
  governed: sourcePath("governed-review/repository.pg.ts"),
  governedAdministration: sourcePath("governed-review/repository.pg-administration.ts"),
  governedCommon: sourcePath("governed-review/repository.pg-common.ts"),
  governedEvidence: sourcePath("governed-review/repository.pg-evidence.ts"),
  governedFrame: sourcePath("governed-review/repository.pg-frame-support.ts"),
  governedPort: sourcePath("governed-review/repository.ts"),
  governedStream: sourcePath("governed-review/repository.pg-stream-support.ts"),
} as const;

function parseSource(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function createApiProgram(): ts.Program {
  const configPath = ts.findConfigFile(API_DIRECTORY, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error("API tsconfig.json not found");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  return ts.createProgram(parsed.fileNames, parsed.options);
}

function classDeclaration(source: ts.SourceFile, name: string): ts.ClassDeclaration {
  const matches = source.statements.filter((statement): statement is ts.ClassDeclaration =>
    ts.isClassDeclaration(statement) && statement.name?.text === name
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function compilerExports(program: ts.Program, filePath: string): string[] {
  const source = program.getSourceFile(filePath);
  if (!source) throw new Error(`Source module was not loaded: ${filePath}`);
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(source);
  if (!symbol) throw new Error(`Source module symbol was not resolved: ${filePath}`);
  return checker.getExportsOfModule(symbol).map((entry) => entry.name).sort();
}

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function callableType(checker: ts.TypeChecker, symbol: ts.Symbol): string[] {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) throw new Error(`No declaration for ${symbol.name}`);
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
  return checker.getSignaturesOfType(type, ts.SignatureKind.Call).map((signature) => {
    const typeParameters = (signature.typeParameters ?? []).map((parameter) => {
      const constraint = checker.getBaseConstraintOfType(parameter);
      return constraint
        ? checker.typeToString(constraint, declaration, ts.TypeFormatFlags.NoTruncation)
        : "unknown";
    });
    const parameters = signature.getParameters().map((parameter) => {
      const parameterDeclaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
      if (!parameterDeclaration) throw new Error(`No declaration for ${symbol.name} parameter`);
      const parameterType = checker.typeToString(
        checker.getTypeOfSymbolAtLocation(parameter, parameterDeclaration),
        parameterDeclaration,
        ts.TypeFormatFlags.NoTruncation
      );
      const rest = ts.isParameter(parameterDeclaration) && parameterDeclaration.dotDotDotToken ? "..." : "";
      const optional = parameter.flags & ts.SymbolFlags.Optional ? "?" : "";
      return `${rest}${parameterType}${optional}`;
    });
    const result = checker.typeToString(
      signature.getReturnType(),
      declaration,
      ts.TypeFormatFlags.NoTruncation
    );
    return `<${typeParameters.join(",")}>(${parameters.join(",")})=>${result}`;
  });
}

function assertMethodTypes(
  program: ts.Program,
  implementationPath: string,
  implementationName: string,
  referencePath: string,
  referenceNames: readonly string[],
  methodNames: readonly string[]
): void {
  const checker = program.getTypeChecker();
  const implementationSource = program.getSourceFile(implementationPath)!;
  const implementationClass = classDeclaration(implementationSource, implementationName);
  const implementationType = checker.getTypeAtLocation(implementationClass);
  const referenceSource = program.getSourceFile(referencePath)!;
  const referenceModule = checker.getSymbolAtLocation(referenceSource)!;
  const referenceTypes = referenceNames.map((name) => {
    const symbol = checker.getExportsOfModule(referenceModule).find((entry) => entry.name === name);
    if (!symbol) throw new Error(`Reference type ${name} was not exported`);
    return checker.getDeclaredTypeOfSymbol(symbol);
  });
  for (const name of methodNames) {
    const actual = implementationType.getProperty(name);
    const expected = referenceTypes.map((type) => type.getProperty(name)).find(Boolean);
    expect(actual, `${implementationName}.${name}`).toBeDefined();
    expect(expected, `reference ${name}`).toBeDefined();
    expect(callableType(checker, actual!)).toEqual(callableType(checker, expected!));
  }
}

function assertPortSymbols(
  program: ts.Program,
  repositoryPath: string,
  repositoryName: string,
  portPath: string,
  portNames: readonly string[]
): void {
  const checker = program.getTypeChecker();
  const repositorySource = program.getSourceFile(repositoryPath)!;
  const repository = classDeclaration(repositorySource, repositoryName);
  const heritage = repository.heritageClauses?.flatMap((clause) => clause.types) ?? [];
  expect(heritage.map((entry) => entry.expression.getText(repositorySource))).toEqual(portNames);
  const portSource = program.getSourceFile(portPath)!;
  const portModule = checker.getSymbolAtLocation(portSource)!;
  const exports = checker.getExportsOfModule(portModule);
  expect(heritage.map((entry) => resolvedSymbol(checker, entry.expression))).toEqual(
    portNames.map((name) => exports.find((entry) => entry.name === name))
  );
}

function memberInventory(source: ts.SourceFile, className: string): string[] {
  return classDeclaration(source, className).members.map((member) => {
    if (ts.isConstructorDeclaration(member)) return "Constructor";
    if (ts.isMethodDeclaration(member)) return `Method:${member.name.getText(source)}`;
    if (ts.isPropertyDeclaration(member)) return `Property:${member.name.getText(source)}`;
    return ts.SyntaxKind[member.kind];
  });
}

function assertExactDelegates(
  source: ts.SourceFile,
  className: string,
  expectedOwners: Readonly<Record<string, string>>
): void {
  const declaration = classDeclaration(source, className);
  for (const method of declaration.members.filter(ts.isMethodDeclaration)) {
    const name = method.name.getText(source);
    const owner = expectedOwners[name];
    expect(owner, `unexpected facade method ${name}`).toBeDefined();
    expect(method.body?.statements).toHaveLength(1);
    const statement = method.body?.statements[0];
    expect(statement && ts.isReturnStatement(statement)).toBe(true);
    const call = statement && ts.isReturnStatement(statement) ? statement.expression : undefined;
    expect(call && ts.isCallExpression(call)).toBe(true);
    const target = call && ts.isCallExpression(call) ? call.expression : undefined;
    expect(target && ts.isPropertyAccessExpression(target)).toBe(true);
    if (!target || !ts.isPropertyAccessExpression(target) || !call || !ts.isCallExpression(call)) continue;
    expect(target.expression.getText(source)).toBe(`this.${owner}`);
    expect(target.name.text).toBe(name);
    expect(call.arguments.map((argument) => argument.getText(source))).toEqual(
      method.parameters.map((parameter) => parameter.name.getText(source))
    );
  }
}

function accessedPropertyName(expression: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  return undefined;
}

function callNames(source: ts.SourceFile, propertyName: string): string[] {
  const calls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && accessedPropertyName(node.expression) === propertyName) {
      calls.push(node.expression.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

function connectionReferences(source: ts.SourceFile): string[] {
  const references: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      accessedPropertyName(node) === "connect"
    ) references.push(node.getText(source));
    if (ts.isBindingElement(node)) {
      const name = node.propertyName ?? node.name;
      if (ts.isIdentifier(name) && name.text === "connect") references.push(node.getText(source));
      if (ts.isStringLiteralLike(name) && name.text === "connect") references.push(node.getText(source));
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === "Reflect" &&
      node.expression.name.text === "get" &&
      node.arguments[1] &&
      ts.isStringLiteralLike(node.arguments[1]) &&
      node.arguments[1].text === "connect"
    ) references.push(node.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

function containingMethodName(node: ts.Node, source: ts.SourceFile): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isMethodDeclaration(current)) return current.name.getText(source);
  }
  return "<module>";
}

function isInsideOwnedTransaction(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (!ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) continue;
    if (!current.parameters.some((parameter) => parameter.name.getText() === "client")) continue;
    const parent: ts.Node = current.parent;
    if (
      ts.isCallExpression(parent) &&
      parent.arguments.includes(current) &&
      accessedPropertyName(parent.expression) === "transaction"
    ) return true;
  }
  return false;
}

function databaseSupportCalls(
  program: ts.Program,
  callerPath: string,
  targetPaths: readonly string[]
): string[] {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(callerPath);
  if (!source) throw new Error(`Caller module was not loaded: ${callerPath}`);
  const targets = new Set(targetPaths.map((target) => path.resolve(target)));
  const calls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const symbol = resolvedSymbol(checker, node.expression);
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (declaration && targets.has(path.resolve(declaration.getSourceFile().fileName))) {
        const parameter = ts.isFunctionDeclaration(declaration) ? declaration.parameters[0] : undefined;
        const parameterType = parameter?.type?.getText(declaration.getSourceFile());
        if (parameterType && ["Db", "Pool", "PoolClient"].includes(parameterType)) {
          const firstArgument = node.arguments[0]?.getText(source) ?? "<missing>";
          const expectedArgument = isInsideOwnedTransaction(node) ? "client" : "this.pool";
          expect(firstArgument, `${containingMethodName(node, source)} -> ${symbol!.name}`).toBe(expectedArgument);
          calls.push(
            `${relativeSourceName(source)}:${containingMethodName(node, source)}:${symbol!.name}:${firstArgument}`
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls.sort();
}

function methodModifierKinds(source: ts.SourceFile, className: string, methodName: string): string[] {
  const method = classDeclaration(source, className).members.find((member): member is ts.MethodDeclaration =>
    ts.isMethodDeclaration(member) && member.name.getText(source) === methodName
  );
  if (!method) throw new Error(`${className}.${methodName} was not found`);
  return (ts.getModifiers(method) ?? []).map((modifier) => ts.SyntaxKind[modifier.kind]);
}

function relativeSourceName(source: ts.SourceFile): string {
  return path.relative(SOURCE_DIRECTORY, source.fileName).split(path.sep).join("/");
}

function moduleEdges(program: ts.Program, targetPath: string): string[] {
  const edges: string[] = [];
  for (const source of program.getSourceFiles()) {
    const absolute = path.resolve(source.fileName);
    if (
      source.isDeclarationFile ||
      (absolute !== SOURCE_DIRECTORY && !absolute.startsWith(`${SOURCE_DIRECTORY}${path.sep}`))
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
          path.resolve(resolution.resolvedFileName) === path.resolve(targetPath) &&
          (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent) || ts.isCallExpression(node.parent))
        ) edges.push(`${relativeSourceName(source)}:${ts.SyntaxKind[node.parent.kind]}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return edges.sort();
}

describe("specialist PostgreSQL repository module boundaries", () => {
  it("keeps the governed review facade, slices, and internal support surfaces exact", () => {
    expect(Object.keys(governedAdministrationModule)).toEqual(["PgGovernedReviewAdministrationRepository"]);
    expect(Object.keys(governedEvidenceModule)).toEqual(["PgGovernedReviewEvidenceRepository"]);
    expect(Object.keys(governedCommonModule).sort()).toEqual(
      GOVERNED_COMMON_EXPORTS.filter((name) => !["BatchRow", "Db"].includes(name)).sort()
    );
    expect(Object.keys(governedFrameModule).sort()).toEqual(GOVERNED_FRAME_EXPORTS);
    expect(Object.keys(governedStreamModule).sort()).toEqual(GOVERNED_STREAM_EXPORTS);
    expect(memberInventory(parseSource(PATHS.governed), "PgGovernedReviewRepository")).toEqual([
      "Property:administration",
      "Property:evidence",
      "Constructor",
      ...[...GOVERNED_ADMINISTRATION_METHODS, ...GOVERNED_EVIDENCE_METHODS].map((name) => `Method:${name}`)
    ]);
    expect(memberInventory(
      parseSource(PATHS.governedAdministration),
      "PgGovernedReviewAdministrationRepository"
    )).toEqual(["Constructor", ...GOVERNED_ADMINISTRATION_METHODS.map((name) => `Method:${name}`), "Method:transaction"]);
    expect(memberInventory(
      parseSource(PATHS.governedEvidence),
      "PgGovernedReviewEvidenceRepository"
    )).toEqual(["Constructor", ...GOVERNED_EVIDENCE_METHODS.map((name) => `Method:${name}`), "Method:transaction"]);

    const governedSource = parseSource(PATHS.governed);
    assertExactDelegates(governedSource, "PgGovernedReviewRepository", Object.fromEntries([
      ...GOVERNED_ADMINISTRATION_METHODS.map((name) => [name, "administration"]),
      ...GOVERNED_EVIDENCE_METHODS.map((name) => [name, "evidence"])
    ]));
    const governedConstructor = classDeclaration(
      governedSource,
      "PgGovernedReviewRepository"
    ).members.find(ts.isConstructorDeclaration)!;
    expect(governedConstructor.body?.statements.map((statement) => statement.getText(governedSource))).toEqual([
      "this.administration = new PgGovernedReviewAdministrationRepository(this.pool);",
      "this.evidence = new PgGovernedReviewEvidenceRepository(this.pool);"
    ]);

    const pool = {} as Pool;
    const repository = new PgGovernedReviewRepository(pool) as unknown as {
      pool: Pool;
      administration: { pool: Pool };
      evidence: { pool: Pool };
    };
    expect(repository.pool).toBe(pool);
    expect(repository.administration.pool).toBe(pool);
    expect(repository.evidence.pool).toBe(pool);
  });

  it("keeps binary calibration ownership and support surfaces exact", () => {
    expect(Object.keys(binaryAuthorizationModule).sort()).toEqual(BINARY_AUTHORIZATION_EXPORTS);
    expect(Object.keys(binarySupportModule).sort()).toEqual(
      BINARY_SUPPORT_EXPORTS.filter((name) => ![
        "Db", "EligibilityResult", "FrozenOriginRow", "RunRow"
      ].includes(name))
    );
    expect(memberInventory(parseSource(PATHS.binary), "PgBinaryCalibrationRepository")).toEqual([
      "Constructor",
      ...BINARY_METHODS.map((name) => `Method:${name}`),
      "Method:transaction"
    ]);
    const pool = {} as Pool;
    const repository = new PgBinaryCalibrationRepository(pool) as unknown as { pool: Pool };
    expect(repository.pool).toBe(pool);
  });

  it("pins port symbols, complete compiler exports, and exact module ownership", () => {
    const program = createApiProgram();
    expect(compilerExports(program, PATHS.governed)).toEqual(["PgGovernedReviewRepository"]);
    expect(compilerExports(program, PATHS.governedAdministration))
      .toEqual(["PgGovernedReviewAdministrationRepository"]);
    expect(compilerExports(program, PATHS.governedEvidence)).toEqual(["PgGovernedReviewEvidenceRepository"]);
    expect(compilerExports(program, PATHS.governedCommon)).toEqual(GOVERNED_COMMON_EXPORTS);
    expect(compilerExports(program, PATHS.governedFrame)).toEqual(GOVERNED_FRAME_EXPORTS);
    expect(compilerExports(program, PATHS.governedStream)).toEqual(GOVERNED_STREAM_EXPORTS);
    expect(compilerExports(program, PATHS.binary)).toEqual(["PgBinaryCalibrationRepository"]);
    expect(compilerExports(program, PATHS.binaryAuthorization)).toEqual(BINARY_AUTHORIZATION_EXPORTS);
    expect(compilerExports(program, PATHS.binarySupport)).toEqual(BINARY_SUPPORT_EXPORTS);

    assertPortSymbols(
      program,
      PATHS.governed,
      "PgGovernedReviewRepository",
      PATHS.governedPort,
      ["GovernedReviewRepository"]
    );
    assertPortSymbols(
      program,
      PATHS.binary,
      "PgBinaryCalibrationRepository",
      PATHS.binaryPort,
      ["BinaryCalibrationControlRepository", "BinaryCalibrationExecutionRepository"]
    );
    assertMethodTypes(
      program,
      PATHS.governed,
      "PgGovernedReviewRepository",
      PATHS.governedPort,
      ["GovernedReviewRepository"],
      [...GOVERNED_ADMINISTRATION_METHODS, ...GOVERNED_EVIDENCE_METHODS]
    );
    assertMethodTypes(
      program,
      PATHS.governedAdministration,
      "PgGovernedReviewAdministrationRepository",
      PATHS.governedPort,
      ["GovernedReviewRepository"],
      GOVERNED_ADMINISTRATION_METHODS
    );
    assertMethodTypes(
      program,
      PATHS.governedEvidence,
      "PgGovernedReviewEvidenceRepository",
      PATHS.governedPort,
      ["GovernedReviewRepository"],
      GOVERNED_EVIDENCE_METHODS
    );
    assertMethodTypes(
      program,
      PATHS.binary,
      "PgBinaryCalibrationRepository",
      PATHS.binaryPort,
      ["BinaryCalibrationControlRepository", "BinaryCalibrationExecutionRepository"],
      BINARY_METHODS
    );

    expect([
      ...databaseSupportCalls(program, PATHS.governedAdministration, [
        PATHS.governedCommon,
        PATHS.governedFrame,
        PATHS.governedStream
      ]),
      ...databaseSupportCalls(program, PATHS.governedEvidence, [
        PATHS.governedCommon,
        PATHS.governedFrame,
        PATHS.governedStream
      ]),
      ...databaseSupportCalls(program, PATHS.binary, [
        PATHS.binaryAuthorization,
        PATHS.binarySupport
      ])
    ]).toMatchInlineSnapshot(`
      [
        "governed-review/repository.pg-administration.ts:createBatchDraft:assertBatchBlindViewsWithinLimit:client",
        "governed-review/repository.pg-administration.ts:createBatchDraft:dbDigest:client",
        "governed-review/repository.pg-administration.ts:createBatchDraft:dbDigest:client",
        "governed-review/repository.pg-administration.ts:createBatchDraft:dbDigest:client",
        "governed-review/repository.pg-administration.ts:createBatchDraft:dbDigest:client",
        "governed-review/repository.pg-administration.ts:createBatchDraft:ensureSubject:client",
        "governed-review/repository.pg-administration.ts:createBatchDraft:ensureSubject:client",
        "governed-review/repository.pg-administration.ts:createBatchDraft:loadBatchProjection:client",
        "governed-review/repository.pg-administration.ts:createBatchDraft:loadBatchProjection:client",
        "governed-review/repository.pg-administration.ts:createBatchDraft:normalizedTimestamp:client",
        "governed-review/repository.pg-administration.ts:createBatchDraft:preparePromotionFrame:client",
        "governed-review/repository.pg-administration.ts:createBatchDraft:prepareRevisionFrame:client",
        "governed-review/repository.pg-administration.ts:createBatchDraft:prepareSealedFrame:client",
        "governed-review/repository.pg-administration.ts:createInstruction:dbDigest:client",
        "governed-review/repository.pg-administration.ts:createInstruction:ensureSubject:client",
        "governed-review/repository.pg-administration.ts:createSealedIntake:dbDigest:client",
        "governed-review/repository.pg-administration.ts:createSealedIntake:dbDigest:client",
        "governed-review/repository.pg-administration.ts:createSealedIntake:dbDigest:client",
        "governed-review/repository.pg-administration.ts:createSealedIntake:ensureSubject:client",
        "governed-review/repository.pg-administration.ts:createSealedIntake:normalizedTimestamp:client",
        "governed-review/repository.pg-administration.ts:createSealedIntake:normalizedTimestamp:client",
        "governed-review/repository.pg-administration.ts:getBatchSummary:loadBatchProjection:this.pool",
        "governed-review/repository.pg-administration.ts:listAssignableSubjects:ensureSubject:client",
        "governed-review/repository.pg-administration.ts:listBatches:loadBatchProjection:this.pool",
        "governed-review/repository.pg-administration.ts:transitionBatch:appendCapabilityChecks:client",
        "governed-review/repository.pg-administration.ts:transitionBatch:appendCapabilityChecks:client",
        "governed-review/repository.pg-administration.ts:transitionBatch:batchEventDetails:client",
        "governed-review/repository.pg-administration.ts:transitionBatch:contentExposedSubjects:client",
        "governed-review/repository.pg-administration.ts:transitionBatch:contentExposedSubjects:client",
        "governed-review/repository.pg-administration.ts:transitionBatch:currentBatchState:client",
        "governed-review/repository.pg-administration.ts:transitionBatch:dbDigest:client",
        "governed-review/repository.pg-administration.ts:transitionBatch:deriveBatchEventKind:client",
        "governed-review/repository.pg-administration.ts:transitionBatch:ensureSubject:client",
        "governed-review/repository.pg-administration.ts:transitionBatch:loadBatchProjection:client",
        "governed-review/repository.pg-administration.ts:transitionBatch:loadBatchProjection:client",
        "governed-review/repository.pg-administration.ts:transitionBatch:lockBatch:client",
        "governed-review/repository.pg-administration.ts:transitionBatch:materializeFrozenTruth:client",
        "governed-review/repository.pg-administration.ts:transitionBatch:observeBatchEventClock:client",
        "governed-review/repository.pg-evidence.ts:appendAdjudication:appendCapabilityChecks:client",
        "governed-review/repository.pg-evidence.ts:appendAdjudication:currentBatchState:client",
        "governed-review/repository.pg-evidence.ts:appendAdjudication:dbDigest:client",
        "governed-review/repository.pg-evidence.ts:appendAdjudication:ensureSubject:client",
        "governed-review/repository.pg-evidence.ts:appendAdjudication:loadAdjudication:client",
        "governed-review/repository.pg-evidence.ts:appendAdjudication:loadAdjudication:client",
        "governed-review/repository.pg-evidence.ts:appendAdjudication:lockBatch:client",
        "governed-review/repository.pg-evidence.ts:appendAlignmentEvent:appendCapabilityChecks:client",
        "governed-review/repository.pg-evidence.ts:appendAlignmentEvent:currentBatchState:client",
        "governed-review/repository.pg-evidence.ts:appendAlignmentEvent:dbDigest:client",
        "governed-review/repository.pg-evidence.ts:appendAlignmentEvent:ensureSubject:client",
        "governed-review/repository.pg-evidence.ts:appendAlignmentEvent:lockBatch:client",
        "governed-review/repository.pg-evidence.ts:appendTaskAction:currentTaskState:client",
        "governed-review/repository.pg-evidence.ts:appendTaskAction:dbDigest:client",
        "governed-review/repository.pg-evidence.ts:appendTaskAction:dbDigest:client",
        "governed-review/repository.pg-evidence.ts:appendTaskAction:loadTaskMutation:client",
        "governed-review/repository.pg-evidence.ts:appendTaskAction:loadTaskMutation:client",
        "governed-review/repository.pg-evidence.ts:appendTaskAction:lockBatch:client",
        "governed-review/repository.pg-evidence.ts:appendTaskAction:readTaskStateWithoutScope:this.pool",
        "governed-review/repository.pg-evidence.ts:appendTaskAction:resolveSubjectId:client",
        "governed-review/repository.pg-evidence.ts:createImportedTruth:dbDigest:client",
        "governed-review/repository.pg-evidence.ts:createImportedTruth:dbDigest:client",
        "governed-review/repository.pg-evidence.ts:getOrCreateBlindTaskView:currentTaskState:client",
        "governed-review/repository.pg-evidence.ts:getOrCreateBlindTaskView:dbDigest:client",
        "governed-review/repository.pg-evidence.ts:getOrCreateBlindTaskView:lockBatch:client",
        "governed-review/repository.pg-evidence.ts:getOrCreateBlindTaskView:resolveSubjectId:client",
        "governed-review/repository.pg-evidence.ts:getPostBarrierItemView:appendCapabilityChecks:client",
        "governed-review/repository.pg-evidence.ts:getPostBarrierItemView:currentBatchState:client",
        "governed-review/repository.pg-evidence.ts:getPostBarrierItemView:ensureSubject:client",
        "governed-review/repository.pg-evidence.ts:getPostBarrierItemView:lockBatch:client",
        "governed-review/repository.pg-evidence.ts:listReviewerTasks:resolveSubjectId:this.pool",
        "binary-calibration/repository.pg.ts:authorizeRun:databaseClock:client",
        "binary-calibration/repository.pg.ts:authorizeRun:databaseClock:client",
        "binary-calibration/repository.pg.ts:authorizeRun:evaluateEligibility:client",
        "binary-calibration/repository.pg.ts:authorizeRun:insertEvaluatorExecutionAuthorization:client",
        "binary-calibration/repository.pg.ts:authorizeRun:insertExposureCheck:client",
        "binary-calibration/repository.pg.ts:authorizeRun:loadAuthorizedRun:this.pool",
        "binary-calibration/repository.pg.ts:authorizeRun:requireActiveRevisionLease:client",
        "binary-calibration/repository.pg.ts:authorizeRun:requireClaim:client",
        "binary-calibration/repository.pg.ts:completeAttempt:requireActiveRevisionLease:client",
        "binary-calibration/repository.pg.ts:completeAttempt:requireClaim:client",
        "binary-calibration/repository.pg.ts:createRun:deriveRunIdentity:client",
        "binary-calibration/repository.pg.ts:createRun:requireProjectOwner:client",
        "binary-calibration/repository.pg.ts:finalizeRun:databaseClock:client",
        "binary-calibration/repository.pg.ts:finalizeRun:databaseClock:client",
        "binary-calibration/repository.pg.ts:finalizeRun:evaluateEligibility:client",
        "binary-calibration/repository.pg.ts:finalizeRun:insertExposureCheck:client",
        "binary-calibration/repository.pg.ts:finalizeRun:loadExposureCheck:client",
        "binary-calibration/repository.pg.ts:finalizeRun:requireActiveRevisionLease:client",
        "binary-calibration/repository.pg.ts:finalizeRun:requireClaim:client",
        "binary-calibration/repository.pg.ts:getNextAttempt:requireClaim:this.pool",
        "binary-calibration/repository.pg.ts:recordProviderCallStarted:requireActiveRevisionLease:client",
        "binary-calibration/repository.pg.ts:recordProviderCallStarted:requireClaim:client",
        "binary-calibration/repository.pg.ts:recoverStartedAttempts:requireActiveRevisionLease:client",
        "binary-calibration/repository.pg.ts:recoverStartedAttempts:requireClaim:client",
      ]
    `);

    expect(moduleEdges(program, PATHS.governedAdministration))
      .toEqual(["governed-review/repository.pg.ts:ImportDeclaration"]);
    expect(moduleEdges(program, PATHS.governedEvidence))
      .toEqual(["governed-review/repository.pg.ts:ImportDeclaration"]);
    expect(moduleEdges(program, PATHS.governedCommon)).toEqual([
      "governed-review/repository.pg-administration.ts:ImportDeclaration",
      "governed-review/repository.pg-evidence.ts:ImportDeclaration",
      "governed-review/repository.pg-frame-support.ts:ImportDeclaration",
      "governed-review/repository.pg-stream-support.ts:ImportDeclaration"
    ]);
    expect(moduleEdges(program, PATHS.governedFrame)).toEqual([
      "governed-review/repository.pg-administration.ts:ImportDeclaration",
      "governed-review/repository.pg-evidence.ts:ImportDeclaration"
    ]);
    expect(moduleEdges(program, PATHS.governedStream)).toEqual([
      "governed-review/repository.pg-administration.ts:ImportDeclaration",
      "governed-review/repository.pg-evidence.ts:ImportDeclaration"
    ]);
    expect(moduleEdges(program, PATHS.binaryAuthorization)).toEqual([
      "binary-calibration/repository.pg.ts:ImportDeclaration"
    ]);
    expect(moduleEdges(program, PATHS.binarySupport)).toEqual([
      "binary-calibration/repository.pg-authorization.ts:ImportDeclaration",
      "binary-calibration/repository.pg.ts:ImportDeclaration"
    ]);
  }, 30_000);

  it("keeps connection and transaction ownership in the public repositories", () => {
    const governedAdministration = parseSource(PATHS.governedAdministration);
    const governedEvidence = parseSource(PATHS.governedEvidence);
    const binary = parseSource(PATHS.binary);
    for (const source of [
      parseSource(PATHS.governedCommon),
      parseSource(PATHS.governedFrame),
      parseSource(PATHS.governedStream),
      parseSource(PATHS.binaryAuthorization),
      parseSource(PATHS.binarySupport)
    ]) {
      expect(connectionReferences(source)).toEqual([]);
      expect(callNames(source, "connect")).toEqual([]);
    }
    expect(callNames(governedAdministration, "connect")).toEqual(["this.pool.connect"]);
    expect(callNames(governedEvidence, "connect")).toEqual(["this.pool.connect"]);
    expect(callNames(binary, "connect")).toEqual(["this.pool.connect"]);
    for (const source of [governedAdministration, governedEvidence, binary]) {
      expect(callNames(source, "release")).toEqual(["client.release"]);
      const text = source.text;
      expect(text.match(/client\.query\("commit"\)/g) ?? []).toHaveLength(1);
      expect(text.match(/client\.query\("rollback"\)/g) ?? []).toHaveLength(1);
    }
    for (const source of [governedAdministration, governedEvidence]) {
      expect(source.text).toContain(
        'client.query(isolation === "serializable" ? "begin isolation level serializable" : "begin")'
      );
    }
    expect(binary.text.match(/client\.query\("begin"\)/g) ?? []).toHaveLength(1);
    expect(methodModifierKinds(
      governedAdministration,
      "PgGovernedReviewAdministrationRepository",
      "transaction"
    )).toEqual(["PrivateKeyword", "AsyncKeyword"]);
    expect(methodModifierKinds(
      governedEvidence,
      "PgGovernedReviewEvidenceRepository",
      "transaction"
    )).toEqual(["PrivateKeyword", "AsyncKeyword"]);
    expect(methodModifierKinds(binary, "PgBinaryCalibrationRepository", "transaction"))
      .toEqual(["PrivateKeyword", "AsyncKeyword"]);
  });
});
