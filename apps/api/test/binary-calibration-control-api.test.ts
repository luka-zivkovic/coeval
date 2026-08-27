import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  createBinaryCalibrationArtifactRouter,
  createBinaryCalibrationControlRouter
} from "../src/binary-calibration/routes.js";
import {
  BinaryCalibrationRepositoryError,
  type BinaryCalibrationActor,
  type BinaryCalibrationArtifactCopy,
  type BinaryCalibrationArtifactStatusProjection,
  type BinaryCalibrationControlRepository,
  type BinaryCalibrationProjectAccess,
  type BinaryCalibrationRunProjection,
  type CreateBinaryCalibrationRunInput
} from "../src/binary-calibration/repository.js";

const PROJECT_ID = "project_calibration";
const JSON_HEADERS = { "content-type": "application/json" };
const OWNER_HEADERS = { "x-test-user": "owner", "x-test-project": PROJECT_ID };
const MEMBER_HEADERS = { "x-test-user": "member", "x-test-project": PROJECT_ID };
const API_KEY_HEADERS = {
  authorization: "Bearer project-key",
  "x-test-api-key": "key_1",
  "x-test-project": PROJECT_ID
};
const CREATED_AT = "2026-08-23T00:00:00.000Z";

const fixtureBytes = readFileSync(new URL(
  "../../../contracts/fixtures/binary-calibration-v1.complete.json",
  import.meta.url
));
const fixtureArtifact = JSON.parse(fixtureBytes.toString("utf8")) as {
  artifactId: string;
  calibrationRunId: string;
  evidenceDigest: string;
};

function runProjection(): BinaryCalibrationRunProjection {
  return {
    runId: fixtureArtifact.calibrationRunId,
    projectId: PROJECT_ID,
    datasetRevisionId: "revision_sealed_1",
    revisionDigest: `sha256:${"1".repeat(64)}`,
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
    artifactId: fixtureArtifact.artifactId,
    artifactDigest: "sha256:61a5a2b5abeb3303c209d1a9bd32352ec094b77190b3b139fcf8f6b76f010c4f",
    evidenceDigest: fixtureArtifact.evidenceDigest,
    createdAt: CREATED_AT,
    startedAt: CREATED_AT,
    completedAt: CREATED_AT
  };
}

class FakeCalibrationRepository implements BinaryCalibrationControlRepository {
  calls: Array<{ method: string; input: unknown }> = [];
  error: BinaryCalibrationRepositoryError | null = null;
  artifactOverride: Partial<BinaryCalibrationArtifactCopy> = {};
  statusOverride: Partial<BinaryCalibrationArtifactStatusProjection> = {};

  async createRun(actor: BinaryCalibrationActor, input: CreateBinaryCalibrationRunInput) {
    this.record("createRun", { actor, input });
    if (this.error) throw this.error;
    return runProjection();
  }

  async listRuns(access: BinaryCalibrationProjectAccess) {
    this.record("listRuns", access);
    if (this.error) throw this.error;
    return [runProjection()];
  }

  async getRun(access: BinaryCalibrationProjectAccess, runId: string) {
    this.record("getRun", { access, runId });
    if (this.error) throw this.error;
    return { ...runProjection(), runId };
  }

  async getArtifact(
    access: BinaryCalibrationProjectAccess,
    artifactId: string
  ): Promise<BinaryCalibrationArtifactCopy> {
    this.record("getArtifact", { access, artifactId });
    if (this.error) throw this.error;
    return {
      artifactId,
      calibrationRunId: fixtureArtifact.calibrationRunId,
      canonicalBytes: fixtureBytes,
      artifactDigest: "sha256:61a5a2b5abeb3303c209d1a9bd32352ec094b77190b3b139fcf8f6b76f010c4f",
      evidenceDigest: fixtureArtifact.evidenceDigest,
      createdAt: CREATED_AT,
      ...this.artifactOverride
    };
  }

  async getArtifactStatus(
    access: BinaryCalibrationProjectAccess,
    artifactId: string
  ): Promise<BinaryCalibrationArtifactStatusProjection> {
    this.record("getArtifactStatus", { access, artifactId });
    if (this.error) throw this.error;
    return {
      contract: "coeval/binary-calibration-artifact-status/v1",
      schemaVersion: 1,
      artifactId,
      calibrationRunId: fixtureArtifact.calibrationRunId,
      artifactStatus: "complete",
      currentAdmissibility: "admissible",
      reasons: [],
      evaluatedAt: CREATED_AT,
      ...this.statusOverride
    };
  }

  private record(method: string, input: unknown): void {
    this.calls.push({ method, input });
  }
}

function routers(input: {
  repository?: FakeCalibrationRepository | null;
  databaseMode?: boolean;
} = {}) {
  const repository = input.repository === undefined
    ? new FakeCalibrationRepository()
    : input.repository;
  const dependencies = {
    repository,
    databaseMode: input.databaseMode ?? true,
    requestIdentity: (c: { req: { header(name: string): string | undefined } }) => ({
      userId: c.req.header("x-test-user") ?? null,
      projectId: c.req.header("x-test-project") ?? "",
      ...(c.req.header("x-test-api-key") ? { apiKeyId: c.req.header("x-test-api-key") } : {})
    }),
    resolveProjectRole: async ({ userId }: { userId: string }) =>
      userId === "owner" ? "owner" as const : userId === "member" ? "member" as const : null
  };
  const app = new Hono();
  app.route("/api/binary-calibration-runs", createBinaryCalibrationControlRouter(dependencies));
  app.route(
    "/api/v1/binary-calibration-artifacts",
    createBinaryCalibrationArtifactRouter(dependencies)
  );
  return { app, repository };
}

const launchInput = {
  datasetRevisionId: "revision_sealed_1",
  skillVersionId: "skill_version_1",
  positiveClass: "pass",
  trialPlan: { kind: "single", trialsPerItem: 1 },
  suiteBinding: null,
  idempotencyKey: "calibration-launch-1" // gitleaks:allow — deterministic test fixture
};

describe("binary calibration control API", () => {
  it("fails with 501 in demo/no-database mode", async () => {
    const { app } = routers({ repository: null, databaseMode: false });
    const control = await app.request("/api/binary-calibration-runs", { headers: OWNER_HEADERS });
    const artifact = await app.request(
      `/api/v1/binary-calibration-artifacts/${fixtureArtifact.artifactId}`,
      { headers: API_KEY_HEADERS }
    );
    expect(control.status).toBe(501);
    expect(artifact.status).toBe(501);
    await expect(control.json()).resolves.toMatchObject({
      code: "binary_calibration_requires_database"
    });
  });

  it("allows only an owner session to launch the closed single-trial request", async () => {
    const { app, repository } = routers();
    const member = await app.request("/api/binary-calibration-runs", {
      method: "POST",
      headers: { ...JSON_HEADERS, ...MEMBER_HEADERS },
      body: JSON.stringify(launchInput)
    });
    expect(member.status).toBe(403);
    await expect(member.json()).resolves.toMatchObject({ code: "binary_calibration_owner_required" });

    const apiKey = await app.request("/api/binary-calibration-runs", {
      method: "POST",
      headers: { ...JSON_HEADERS, ...API_KEY_HEADERS },
      body: JSON.stringify(launchInput)
    });
    expect(apiKey.status).toBe(401);
    await expect(apiKey.json()).resolves.toMatchObject({ code: "binary_calibration_session_required" });

    const owner = await app.request("/api/binary-calibration-runs", {
      method: "POST",
      headers: { ...JSON_HEADERS, ...OWNER_HEADERS },
      body: JSON.stringify(launchInput)
    });
    expect(owner.status).toBe(202);
    await expect(owner.json()).resolves.toMatchObject({
      run: { datasetRevisionId: "revision_sealed_1", trialPlan: { kind: "single", trialsPerItem: 1 } }
    });
    expect(repository?.calls.at(-1)).toMatchObject({
      method: "createRun",
      input: {
        actor: { projectId: PROJECT_ID, userId: "owner", projectRole: "owner" },
        input: launchInput
      }
    });
  });

  it("rejects client-asserted provider policy, repeated trials, and unknown fields", async () => {
    const { app, repository } = routers();
    for (const body of [
      { ...launchInput, providerDataHandling: { executionEnvironment: "local_provider" } },
      { ...launchInput, trialPlan: { kind: "independent_repetitions", trialsPerItem: 2 } },
      { ...launchInput, releaseThreshold: 0.9 }
    ]) {
      const response = await app.request("/api/binary-calibration-runs", {
        method: "POST",
        headers: { ...JSON_HEADERS, ...OWNER_HEADERS },
        body: JSON.stringify(body)
      });
      expect(response.status).toBe(400);
    }
    expect(repository?.calls).toHaveLength(0);
  });

  it("keeps list and detail aggregate-only and project-scoped", async () => {
    const { app, repository } = routers();
    const list = await app.request("/api/binary-calibration-runs", { headers: MEMBER_HEADERS });
    const detail = await app.request(
      `/api/binary-calibration-runs/${fixtureArtifact.calibrationRunId}`,
      { headers: MEMBER_HEADERS }
    );
    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      runs: [{ plannedObservations: 3, accountedObservations: 3 }]
    });
    expect(repository?.calls).toEqual([
      { method: "listRuns", input: { projectId: PROJECT_ID } },
      {
        method: "getRun",
        input: { access: { projectId: PROJECT_ID }, runId: fixtureArtifact.calibrationRunId }
      }
    ]);
  });

  it("serves exact immutable artifact bytes only to an owner session with integrity headers", async () => {
    const { app } = routers();
    const response = await app.request(
      `/api/v1/binary-calibration-artifacts/${fixtureArtifact.artifactId}`,
      { headers: OWNER_HEADERS }
    );
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fixtureBytes);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-coeval-artifact-digest")).toBe(
      "sha256:61a5a2b5abeb3303c209d1a9bd32352ec094b77190b3b139fcf8f6b76f010c4f"
    );
    expect(response.headers.get("x-coeval-evidence-digest")).toBe(fixtureArtifact.evidenceDigest);
    expect(response.headers.get("x-coeval-canonicalization")).toBe("coeval-canonical-json/v1");
    expect(response.headers.get("etag")).toContain("sha256:");
    expect(response.headers.get("digest")).toMatch(/^sha-256=/);
  });

  it("denies API keys and member sessions before reading artifact bytes or status", async () => {
    for (const headers of [API_KEY_HEADERS, MEMBER_HEADERS]) {
      const { app, repository } = routers();
      for (const suffix of ["", "/status"]) {
        const response = await app.request(
          `/api/v1/binary-calibration-artifacts/${fixtureArtifact.artifactId}${suffix}`,
          { headers }
        );
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
          code: "binary_calibration_owner_session_required"
        });
      }
      expect(repository?.calls).toHaveLength(0);
    }
  });

  it("refuses stored bytes that fail producer verification or copy identity", async () => {
    const repository = new FakeCalibrationRepository();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      repository.artifactOverride = { evidenceDigest: `sha256:${"f".repeat(64)}` };
      const identityMismatch = await routers({ repository }).app.request(
        `/api/v1/binary-calibration-artifacts/${fixtureArtifact.artifactId}`,
        { headers: OWNER_HEADERS }
      );
      expect(identityMismatch.status).toBe(500);

      const tamperedBytes = Buffer.from(fixtureBytes.toString("utf8").replace(
        '"status":"complete"',
        '"status":"incomplete"'
      ));
      repository.artifactOverride = {
        canonicalBytes: tamperedBytes,
        artifactDigest: `sha256:${createHash("sha256").update(tamperedBytes).digest("hex")}`,
        evidenceDigest: fixtureArtifact.evidenceDigest
      };
      const producerMismatch = await routers({ repository }).app.request(
        `/api/v1/binary-calibration-artifacts/${fixtureArtifact.artifactId}`,
        { headers: OWNER_HEADERS }
      );
      expect(producerMismatch.status).toBe(500);
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it("serves versioned current status without presenting policy or a release decision", async () => {
    const { app } = routers();
    const response = await app.request(
      `/api/v1/binary-calibration-artifacts/${fixtureArtifact.artifactId}/status`,
      { headers: OWNER_HEADERS }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      contract: "coeval/binary-calibration-artifact-status/v1",
      schemaVersion: 1,
      currentAdmissibility: "admissible",
      reasons: []
    });
    expect(JSON.stringify(body)).not.toMatch(/threshold|promote|block|releaseDecision/i);
  });

  it("fails closed on unknown or inconsistent current-status reasons", async () => {
    const repository = new FakeCalibrationRepository();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      repository.statusOverride = {
        reasons: ["free_text_reason"] as never
      };
      const unknown = await routers({ repository }).app.request(
        `/api/v1/binary-calibration-artifacts/${fixtureArtifact.artifactId}/status`,
        { headers: OWNER_HEADERS }
      );
      expect(unknown.status).toBe(500);

      repository.statusOverride = {
        currentAdmissibility: "admissible",
        reasons: ["development_exposure"]
      };
      const inconsistent = await routers({ repository }).app.request(
        `/api/v1/binary-calibration-artifacts/${fixtureArtifact.artifactId}/status`,
        { headers: OWNER_HEADERS }
      );
      expect(inconsistent.status).toBe(500);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("has no private-ledger or per-item read route", async () => {
    const { app, repository } = routers();
    for (const path of [
      `/api/v1/binary-calibration-artifacts/${fixtureArtifact.artifactId}/private-ledger`,
      `/api/v1/binary-calibration-artifacts/${fixtureArtifact.artifactId}/items`,
      "/api/v1/binary-calibration-private-ledgers/private_1"
    ]) {
      const response = await app.request(path, { headers: OWNER_HEADERS });
      expect(response.status).toBe(404);
    }
    expect(repository?.calls).toHaveLength(0);
  });

  it("maps typed repository failures without leaking internals", async () => {
    const repository = new FakeCalibrationRepository();
    repository.error = new BinaryCalibrationRepositoryError("ineligible", "Sealed reuse is ineligible");
    const { app } = routers({ repository });
    const response = await app.request("/api/binary-calibration-runs", {
      method: "POST",
      headers: { ...JSON_HEADERS, ...OWNER_HEADERS },
      body: JSON.stringify(launchInput)
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "Sealed reuse is ineligible",
      code: "binary_calibration_ineligible"
    });
  });
});
