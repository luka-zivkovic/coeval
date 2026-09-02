import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as binaryCalibration from "../src/lib/binary-calibration.js";
import * as governedArtifacts from "../src/lib/governed-review-artifacts.js";
import * as governedCommon from "../src/lib/governed-review-common.js";
import * as governedEvidence from "../src/lib/governed-review-evidence.js";
import * as governedRoot from "../src/lib/governed-review.js";
import * as governedState from "../src/lib/governed-review-state.js";

const LIB_DIRECTORY = fileURLToPath(new URL("../src/lib/", import.meta.url));
const paths = {
  artifacts: path.join(LIB_DIRECTORY, "governed-review-artifacts.ts"),
  binary: path.join(LIB_DIRECTORY, "binary-calibration.ts"),
  common: path.join(LIB_DIRECTORY, "governed-review-common.ts"),
  evidence: path.join(LIB_DIRECTORY, "governed-review-evidence.ts"),
  root: path.join(LIB_DIRECTORY, "governed-review.ts"),
  state: path.join(LIB_DIRECTORY, "governed-review-state.ts")
} as const;

const ARTIFACT_EXPORTS = [
  "governedReviewBatchDomainArtifactDigest",
  "governedReviewInstructionDigest",
  "governedReviewItemDomainArtifactDigest",
  "governedReviewLabelDomainArtifactDigest",
  "governedReviewSelectionDrawDomainArtifactDigest",
  "governedReviewSelectionPlanDomainArtifactDigest",
  "governedReviewStratumDrawDomainArtifactDigest",
  "governedReviewTaskDomainArtifactDigest",
  "governedReviewTaskEventDomainArtifactDigest",
  "verifyGovernedReviewBatch",
  "verifyGovernedReviewInstructionVersion",
  "verifyGovernedReviewItem",
  "verifyGovernedReviewLabel",
  "verifyGovernedReviewSelectionPlan",
  "verifyGovernedReviewTask"
] as const;

const STATE_EXPORTS = [
  "assertGovernedReviewTaskEventAllowed",
  "decideGovernedReviewAdjudicationAppend",
  "deriveActiveGovernedReviewLabels",
  "deriveAuthoritativeGovernedReviewAdjudication",
  "deriveGovernedReviewBatchHistory",
  "deriveGovernedReviewTaskHistory",
  "deriveRepresentativeClaimEligibility",
  "governedReviewAdjudicationDomainArtifactDigest",
  "governedReviewAlignmentEventDomainArtifactDigest",
  "governedReviewBatchEventDomainArtifactDigest",
  "GovernedReviewBatchHistory",
  "GovernedReviewTaskHistory",
  "GovernedReviewTaskState",
  "resolveGovernedReviewTruth",
  "transitionGovernedReviewBatchState",
  "verifyGovernedReviewAdjudication",
  "verifyGovernedReviewAlignmentHistory"
] as const;

const STATE_TYPE_EXPORTS = [
  "GovernedReviewBatchHistory",
  "GovernedReviewTaskHistory",
  "GovernedReviewTaskState"
] as const;

const EVIDENCE_EXPORTS = [
  "buildGovernedBlindTaskView",
  "canonicalGovernedBlindTaskViewBytes",
  "classifyImportedHumanTruth",
  "computeGovernedBinaryAgreement",
  "decideGovernedReviewIdempotency",
  "GovernedBinaryAgreement",
  "governedBlindTaskViewDigest",
  "governedDatasetReferenceProvenanceDomainArtifactDigest",
  "governedReviewRequestDigest",
  "importedHumanTruthDomainArtifactDigest",
  "verifyGovernedBlindTaskView",
  "verifyGovernedDatasetReferenceProvenance",
  "verifyImportedHumanTruth"
] as const;

const EVIDENCE_TYPE_EXPORTS = ["GovernedBinaryAgreement"] as const;

const COMMON_EXPORTS = [
  "assertCanonicalJsonSize",
  "assertContiguousPositions",
  "assertExactSet",
  "assertSame",
  "assertSorted",
  "assertSortedUnique",
  "assertSubjectSeparated",
  "assertUnique",
  "compareStrings",
  "MAX_COLLECTION_PROVENANCE_BYTES",
  "MAX_GOVERNED_REVIEW_PAYLOAD_BYTES",
  "sha256Bytes"
] as const;

const GOVERNED_CONTENT_EXPORTS = [
  "GOVERNED_CONTENT_CANONICALIZATION_VERSION",
  "canonicalGovernedJsonV1",
  "governedContentV1CanonicalBytes",
  "governedContentV1Digest",
  "verifyGovernedContentV1Digest"
] as const;

const BINARY_EXPORTS = [
  "BINARY_CALIBRATION_CANONICALIZATION_VERSION",
  "BINARY_CALIBRATION_CONTRACT",
  "BINARY_CALIBRATION_INTERVAL_DEFINITION_VERSION",
  "BINARY_CALIBRATION_MAX_CANONICAL_BYTES",
  "BINARY_CALIBRATION_MAX_ITEMS",
  "BINARY_CALIBRATION_MAX_JSON_DEPTH",
  "BINARY_CALIBRATION_MAX_STRING_CODE_POINTS",
  "BINARY_CALIBRATION_METRIC_DEFINITION_VERSION",
  "BINARY_CALIBRATION_PRIVATE_LEDGER_CONTRACT",
  "binary64Bits",
  "binary64FromBits",
  "binaryCalibrationArtifactDigest",
  "binaryCalibrationEvidenceDigest",
  "binaryCalibrationPrivateLedgerCommitmentDigest",
  "BinaryCalibrationTrialBuildInput",
  "buildBinaryCalibrationArtifact",
  "BuildBinaryCalibrationArtifactInput",
  "canonicalBinaryCalibrationArtifactBytes",
  "canonicalBinaryCalibrationPrivateLedgerBytes",
  "compareProviderIdentityStrength",
  "ExpectedBinaryCalibrationArtifact",
  "isOutcomeUnknownError",
  "parseCanonicalBinaryCalibrationArtifactBytes",
  "verifyBinaryCalibrationArtifact",
  "verifyBinaryCalibrationPrivateLedger",
  "verifyBinaryCalibrationPrivateLedgerForArtifact",
  "WILSON_95_CONFIDENCE_BASIS_POINTS",
  "WILSON_95_Z_BINARY64",
  "wilson95Binary64Bounds"
] as const;

const BINARY_TYPE_EXPORTS = [
  "BinaryCalibrationTrialBuildInput",
  "BuildBinaryCalibrationArtifactInput",
  "ExpectedBinaryCalibrationArtifact"
] as const;

const BINARY_TYPE_EXPORT_SET = new Set<string>(BINARY_TYPE_EXPORTS);

const BINARY_STAGES = [
  {
    marker: "// Public v1 contract constants and artifact-construction inputs.",
    exports: [
      "BINARY_CALIBRATION_CANONICALIZATION_VERSION",
      "BINARY_CALIBRATION_CONTRACT",
      "BINARY_CALIBRATION_INTERVAL_DEFINITION_VERSION",
      "BINARY_CALIBRATION_MAX_CANONICAL_BYTES",
      "BINARY_CALIBRATION_MAX_ITEMS",
      "BINARY_CALIBRATION_MAX_JSON_DEPTH",
      "BINARY_CALIBRATION_MAX_STRING_CODE_POINTS",
      "BINARY_CALIBRATION_METRIC_DEFINITION_VERSION",
      "BINARY_CALIBRATION_PRIVATE_LEDGER_CONTRACT",
      "BinaryCalibrationTrialBuildInput",
      "BuildBinaryCalibrationArtifactInput",
      "ExpectedBinaryCalibrationArtifact",
      "WILSON_95_CONFIDENCE_BASIS_POINTS",
      "WILSON_95_Z_BINARY64"
    ]
  },
  {
    marker: "// Canonical digest, binary64, and Wilson primitives. Operation order is contract-sensitive.",
    exports: [
      "binary64Bits",
      "binary64FromBits",
      "binaryCalibrationArtifactDigest",
      "binaryCalibrationEvidenceDigest",
      "wilson95Binary64Bounds"
    ]
  },
  {
    marker: "// Private-ledger validation and its canonical public commitment.",
    exports: [
      "binaryCalibrationPrivateLedgerCommitmentDigest",
      "canonicalBinaryCalibrationPrivateLedgerBytes",
      "verifyBinaryCalibrationPrivateLedger",
      "verifyBinaryCalibrationPrivateLedgerForArtifact"
    ]
  },
  {
    marker: "// Public artifact construction, canonical bytes, parsing, and verification.",
    exports: [
      "buildBinaryCalibrationArtifact",
      "canonicalBinaryCalibrationArtifactBytes",
      "parseCanonicalBinaryCalibrationArtifactBytes",
      "verifyBinaryCalibrationArtifact"
    ]
  },
  {
    marker: "// Ordered internal metric, lineage, evidence, and bound checks. These helpers",
    exports: []
  },
  {
    marker: "// Final public identity ordering and terminal-error classification helpers.",
    exports: ["compareProviderIdentityStrength", "isOutcomeUnknownError"]
  }
] as const;

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function createApiProgram(): ts.Program {
  const configPath = ts.findConfigFile(path.dirname(LIB_DIRECTORY), ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error("API tsconfig.json not found");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  return ts.createProgram(parsed.fileNames, parsed.options);
}

function compilerExports(program: ts.Program, filePath: string): string[] {
  const source = program.getSourceFile(filePath);
  if (!source) throw new Error(`Source module was not loaded: ${filePath}`);
  const symbol = program.getTypeChecker().getSymbolAtLocation(source);
  if (!symbol) throw new Error(`Source module symbol was not resolved: ${filePath}`);
  return program.getTypeChecker().getExportsOfModule(symbol).map((entry) => entry.name).sort();
}

function relativeModuleEdges(filePath: string): string[] {
  const text = fs.readFileSync(filePath, "utf8");
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edges: string[] = [];
  for (const statement of source.statements) {
    if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text.startsWith(".")) {
      edges.push(statement.moduleSpecifier.text);
    }
  }
  return edges;
}

function exportedDeclarationOffsets(filePath: string): Map<string, number> {
  const text = fs.readFileSync(filePath, "utf8");
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const offsets = new Map<string, number>();
  for (const statement of source.statements) {
    const isExported = ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExported) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) offsets.set(declaration.name.text, statement.getStart(source));
      }
      continue;
    }
    if ((ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement) ||
         ts.isTypeAliasDeclaration(statement) || ts.isClassDeclaration(statement) ||
         ts.isEnumDeclaration(statement)) && statement.name) {
      offsets.set(statement.name.text, statement.getStart(source));
    }
  }
  return offsets;
}

function expectRuntimeIdentity(
  child: Record<string, unknown>,
  root: Record<string, unknown>
): void {
  for (const [name, value] of Object.entries(child)) {
    expect(root, `missing root runtime export ${name}`).toHaveProperty(name);
    expect(root[name], `root runtime export ${name} must preserve identity`).toBe(value);
  }
}

describe("evidence library boundaries", () => {
  it("preserves the governed-review facade and exact acyclic child surfaces", () => {
    const program = createApiProgram();
    const governedExports = sorted([
      ...ARTIFACT_EXPORTS,
      ...STATE_EXPORTS,
      ...EVIDENCE_EXPORTS,
      ...GOVERNED_CONTENT_EXPORTS
    ]);
    const governedTypeExports = new Set<string>([...STATE_TYPE_EXPORTS, ...EVIDENCE_TYPE_EXPORTS]);

    expect(compilerExports(program, paths.artifacts)).toEqual(sorted(ARTIFACT_EXPORTS));
    expect(compilerExports(program, paths.state)).toEqual(sorted(STATE_EXPORTS));
    expect(compilerExports(program, paths.evidence)).toEqual(sorted(EVIDENCE_EXPORTS));
    expect(compilerExports(program, paths.common)).toEqual(sorted(COMMON_EXPORTS));
    expect(compilerExports(program, paths.root)).toEqual(governedExports);
    expect(Object.keys(governedRoot).sort()).toEqual(
      governedExports.filter((name) => !governedTypeExports.has(name))
    );

    expectRuntimeIdentity(governedArtifacts, governedRoot);
    expectRuntimeIdentity(governedState, governedRoot);
    expectRuntimeIdentity(governedEvidence, governedRoot);
    for (const name of Object.keys(governedCommon)) expect(governedRoot).not.toHaveProperty(name);

    expect(relativeModuleEdges(paths.common)).toEqual(["./assessment-receipt.js"]);
    expect(relativeModuleEdges(paths.artifacts)).toEqual([
      "./assessment-receipt.js",
      "./governed-content-digest.js",
      "./governed-review-common.js"
    ]);
    expect(relativeModuleEdges(paths.evidence)).toEqual([
      "./assessment-receipt.js",
      "./evaluator-suite.js",
      "./governed-content-digest.js",
      "./governed-review-common.js",
      "./governed-review-artifacts.js"
    ]);
    expect(relativeModuleEdges(paths.state)).toEqual([
      "./assessment-receipt.js",
      "./governed-content-digest.js",
      "./governed-review-common.js",
      "./governed-review-artifacts.js",
      "./governed-review-evidence.js"
    ]);
    expect(relativeModuleEdges(paths.root)).toEqual([
      "./governed-content-digest.js",
      "./governed-review-artifacts.js",
      "./governed-review-state.js",
      "./governed-review-evidence.js"
    ]);
  }, 30_000);

  it("pins binary calibration as one ordered canonical v1 pipeline", () => {
    const program = createApiProgram();
    expect(compilerExports(program, paths.binary)).toEqual(sorted(BINARY_EXPORTS));
    expect(Object.keys(binaryCalibration).sort()).toEqual(
      sorted(BINARY_EXPORTS.filter((name) => !BINARY_TYPE_EXPORT_SET.has(name)))
    );
    expect(relativeModuleEdges(paths.binary)).toEqual(["./assessment-receipt.js"]);

    const text = fs.readFileSync(paths.binary, "utf8");
    expect(text.split("\n").length - 1).toBeGreaterThan(1_000);
    expect(sorted(BINARY_STAGES.flatMap((stage) => stage.exports))).toEqual(sorted(BINARY_EXPORTS));
    const positions = BINARY_STAGES.map((stage) => {
      expect(text.split(stage.marker)).toHaveLength(2);
      return text.indexOf(stage.marker);
    });
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    const declarationOffsets = exportedDeclarationOffsets(paths.binary);
    BINARY_STAGES.forEach((stage, index) => {
      const upperBound = positions[index + 1] ?? text.length;
      for (const name of stage.exports) {
        const offset = declarationOffsets.get(name);
        expect(offset, `${name} must remain in its documented binary-calibration stage`).toBeDefined();
        expect(offset!).toBeGreaterThan(positions[index]!);
        expect(offset!).toBeLessThan(upperBound);
      }
    });
  }, 30_000);
});
