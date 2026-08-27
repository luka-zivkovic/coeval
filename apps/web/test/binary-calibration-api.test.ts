import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBinaryCalibrationRun,
  fetchBinaryCalibrationArtifact,
  fetchBinaryCalibrationArtifactStatus,
  fetchBinaryCalibrationRuns
} from "../src/lib/binary-calibration-api.js";

const fixtureBytes = readFileSync(new URL(
  "../../../contracts/fixtures/binary-calibration-v1.complete.json",
  import.meta.url
));
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as {
  artifactId: string;
  calibrationRunId: string;
  evidenceDigest: string;
};
const artifactDigest = `sha256:${createHash("sha256").update(fixtureBytes).digest("hex")}`;
const sha = (digit: string) => `sha256:${digit.repeat(64)}`;

function run() {
  return {
    runId: fixture.calibrationRunId,
    projectId: "project_1",
    datasetRevisionId: "revision_sealed_1",
    revisionDigest: sha("1"),
    criterionId: "criterion_1",
    criterionVersionId: "criterion_version_1",
    skillId: "skill_1",
    skillVersionId: "skill_version_1",
    positiveClass: "pass",
    trialPlan: { kind: "single", trialsPerItem: 1 },
    suiteBinding: null,
    state: "complete",
    plannedObservations: 3,
    accountedObservations: 3,
    artifactId: fixture.artifactId,
    artifactDigest,
    evidenceDigest: fixture.evidenceDigest,
    createdAt: "2026-08-23T00:00:00.000Z",
    startedAt: "2026-08-23T00:00:00.000Z",
    completedAt: "2026-08-23T00:00:00.000Z"
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function artifactResponse(digest = artifactDigest): Response {
  return new Response(fixtureBytes, {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-coeval-artifact-digest": digest,
      "x-coeval-evidence-digest": fixture.evidenceDigest,
      "x-coeval-canonicalization": "coeval-canonical-json/v1"
    }
  });
}

describe("binary calibration web API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists aggregate runs with the selected project and preserves single-trial identity", async () => {
    const storage = { getItem: vi.fn(() => "project_1") };
    const fetchMock = vi.fn(async () => json({ runs: [run()] }));
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("fetch", fetchMock);

    const [result] = await fetchBinaryCalibrationRuns();
    expect(result).toMatchObject({
      datasetRevisionId: "revision_sealed_1",
      trialPlan: { kind: "single", trialsPerItem: 1 },
      plannedObservations: 3,
      accountedObservations: 3
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("x-coeval-project")).toBe("project_1");
    expect(request.credentials).toBe("include");
  });

  it("launches only the explicit closed input and never sends provider policy", async () => {
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        datasetRevisionId: "revision_sealed_1",
        skillVersionId: "skill_version_1",
        positiveClass: "fail",
        trialPlan: { kind: "single", trialsPerItem: 1 },
        suiteBinding: null,
        idempotencyKey: "web-test-1"
      });
      expect(body).not.toHaveProperty("providerDataHandling");
      return json({ run: { ...run(), positiveClass: "fail" } }, 202);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createBinaryCalibrationRun({
      datasetRevisionId: "revision_sealed_1",
      skillVersionId: "skill_version_1",
      positiveClass: "fail",
      trialPlan: { kind: "single", trialsPerItem: 1 },
      idempotencyKey: "web-test-1"
    })).resolves.toMatchObject({ positiveClass: "fail" });
  });

  it("retains exact artifact bytes and verifies transport identity before rendering", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => artifactResponse()));
    const artifact = await fetchBinaryCalibrationArtifact(fixture.artifactId);

    expect(Buffer.from(artifact.canonicalBytes)).toEqual(fixtureBytes);
    expect(artifact.artifact.artifactId).toBe(fixture.artifactId);
    expect(artifact.artifactDigest).toBe(artifactDigest);
    expect(artifact.evidenceDigest).toBe(fixture.evidenceDigest);
  });

  it("rejects byte-swapped or identity-swapped artifacts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => artifactResponse(sha("f"))));
    await expect(fetchBinaryCalibrationArtifact(fixture.artifactId)).rejects.toThrow(
      "bytes do not match"
    );

    vi.stubGlobal("fetch", vi.fn(async () => artifactResponse()));
    await expect(fetchBinaryCalibrationArtifact("artifact_swapped")).rejects.toThrow(
      "identity does not match"
    );
  });

  it("requires the versioned no-policy current status contract", async () => {
    const status = {
      contract: "coeval/binary-calibration-artifact-status/v1",
      schemaVersion: 1,
      artifactId: fixture.artifactId,
      calibrationRunId: fixture.calibrationRunId,
      artifactStatus: "complete",
      currentAdmissibility: "revoked",
      reasons: ["development_exposure"],
      evaluatedAt: "2026-08-23T01:00:00.000Z"
    };
    vi.stubGlobal("fetch", vi.fn(async () => json(status)));
    await expect(fetchBinaryCalibrationArtifactStatus(fixture.artifactId)).resolves.toEqual(status);

    vi.stubGlobal("fetch", vi.fn(async () => json({ ...status, schemaVersion: 2 })));
    await expect(fetchBinaryCalibrationArtifactStatus(fixture.artifactId)).rejects.toThrow(
      "Unsupported"
    );

    vi.stubGlobal("fetch", vi.fn(async () => json({
      ...status,
      reasons: ["free_text_reason"]
    })));
    await expect(fetchBinaryCalibrationArtifactStatus(fixture.artifactId)).rejects.toThrow(
      "Invalid status reasons"
    );
  });
});
