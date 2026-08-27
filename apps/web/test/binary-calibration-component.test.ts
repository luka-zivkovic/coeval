import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BinaryCalibrationArtifactSchema } from "@coeval/shared";
import { describe, expect, it, vi } from "vitest";
import {
  ArtifactEvidence,
  BinaryCalibrationPanel,
  RunEvidence
} from "../src/components/binary-calibration-panel.js";
import type {
  BinaryCalibrationArtifactDownload,
  BinaryCalibrationArtifactStatus,
  BinaryCalibrationRun
} from "../src/lib/binary-calibration-api.js";

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children?: unknown }) =>
    createElement("button", props, children as never)
}));
vi.mock("@/lib/binary-calibration-api", () => ({
  calibrationIdempotencyKey: vi.fn(() => "test-key"),
  createBinaryCalibrationRun: vi.fn(),
  downloadBinaryCalibrationArtifact: vi.fn(),
  fetchBinaryCalibrationArtifact: vi.fn(),
  fetchBinaryCalibrationArtifactStatus: vi.fn(),
  fetchBinaryCalibrationRuns: vi.fn()
}));
vi.mock("@/lib/evaluator-lifecycle-api", () => ({
  fetchAllEvaluatorLifecycles: vi.fn(async () => ({
    items: [], totalCount: "0",
    projectRole: "owner"
  }))
}));

const bytes = readFileSync(new URL(
  "../../../contracts/fixtures/binary-calibration-v1.complete.json",
  import.meta.url
));
const artifact = BinaryCalibrationArtifactSchema.parse(JSON.parse(bytes.toString("utf8")));

const run: BinaryCalibrationRun = {
  runId: artifact.calibrationRunId,
  projectId: artifact.projectId,
  datasetRevisionId: artifact.truth.datasetRevisionId,
  revisionDigest: artifact.truth.revisionDigest,
  criterionId: artifact.criterion.criterionId,
  criterionVersionId: artifact.criterion.criterionVersionId,
  skillId: artifact.evaluator.skillId,
  skillVersionId: artifact.evaluator.skillVersionId,
  positiveClass: artifact.positiveClass,
  trialPlan: { kind: "single", trialsPerItem: 1 },
  suiteBinding: null,
  state: "complete",
  plannedObservations: artifact.truth.itemCount,
  accountedObservations: artifact.truth.itemCount,
  artifactId: artifact.artifactId,
  artifactDigest: `sha256:${"a".repeat(64)}`,
  evidenceDigest: artifact.evidenceDigest,
  createdAt: artifact.createdAt,
  startedAt: artifact.startedAt,
  completedAt: artifact.completedAt
};
const download: BinaryCalibrationArtifactDownload = {
  artifact,
  canonicalBytes: bytes,
  artifactDigest: run.artifactDigest!,
  evidenceDigest: artifact.evidenceDigest
};
const status: BinaryCalibrationArtifactStatus = {
  contract: "coeval/binary-calibration-artifact-status/v1",
  schemaVersion: 1,
  artifactId: artifact.artifactId,
  calibrationRunId: artifact.calibrationRunId,
  artifactStatus: "complete",
  currentAdmissibility: "admissible",
  reasons: [],
  evaluatedAt: artifact.createdAt
};

describe("binary calibration aggregate UI", () => {
  it("states that artifact and status reads require an owner session", () => {
    const html = renderToStaticMarkup(createElement(BinaryCalibrationPanel, {
      datasetRevisionId: run.datasetRevisionId,
      criterionVersionId: run.criterionVersionId,
      skillVersionId: run.skillVersionId
    }));

    expect(html).toContain("only to project-owner sessions");
    expect(html).toContain("API keys cannot fetch them");
  });

  it("shows separate aggregate metrics, Wilson bits, provider groups, and exposure", () => {
    const html = renderToStaticMarkup(createElement(ArtifactEvidence, { artifact }));

    expect(html).toContain("Exposure snapshots");
    expect(html).toContain("Observed provider groups");
    expect(html).toContain("Wilson 95% bits");
    expect(html).toContain("truth-pass recall");
    expect(html).toContain("truth-fail recall");
    expect(html).toContain("classified coverage");
    expect(html).toContain(artifact.privateLedger.commitmentDigest);
    expect(html).not.toMatch(/per-item|item drill|release decision|promote|block|threshold/i);
    expect(html).not.toMatch(/passed calibration|failed calibration/i);
    expect(html).not.toMatch(/pooled|average|mean score/i);
  });

  it("labels artifact completeness and current admissibility separately", () => {
    const html = renderToStaticMarkup(createElement(RunEvidence, {
      run,
      artifact: download,
      status,
      onDownload: vi.fn()
    }));

    expect(html).toContain("complete evidence · admissible");
    expect(html).toContain("Download exact artifact");
    expect(html).toContain(run.artifactDigest!);
    expect(html).not.toMatch(/release passed|release failed|ship|rollout/i);
  });
});
