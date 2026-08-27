import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { DemoRepository } from "../src/repository.js";
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

const PROJECT_ID = "proj_langsmith_support";
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

function projection(): BinaryCalibrationRunProjection {
  return {
    runId: fixture.calibrationRunId,
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
    artifactId: fixture.artifactId,
    artifactDigest,
    evidenceDigest: fixture.evidenceDigest,
    createdAt: "2026-08-23T00:00:00.000Z",
    startedAt: "2026-08-23T00:00:00.000Z",
    completedAt: "2026-08-23T00:00:00.000Z"
  };
}

/** Project-scoped fake used to exercise the full application auth boundary. */
class AppCalibrationRepository implements BinaryCalibrationControlRepository {
  created: { actor: BinaryCalibrationActor; input: CreateBinaryCalibrationRunInput } | null = null;
  artifactReads = 0;
  statusReads = 0;

  async createRun(actor: BinaryCalibrationActor, input: CreateBinaryCalibrationRunInput) {
    this.created = { actor, input };
    return projection();
  }
  async listRuns(_access: BinaryCalibrationProjectAccess) { return [projection()]; }
  async getRun(_access: BinaryCalibrationProjectAccess, runId: string) {
    return { ...projection(), runId };
  }
  async getArtifact(
    access: BinaryCalibrationProjectAccess,
    artifactId: string
  ): Promise<BinaryCalibrationArtifactCopy> {
    this.artifactReads += 1;
    if (access.projectId !== PROJECT_ID || artifactId !== fixture.artifactId) {
      throw new BinaryCalibrationRepositoryError(
        "not_found",
        "Binary calibration artifact not found"
      );
    }
    return {
      artifactId,
      calibrationRunId: fixture.calibrationRunId,
      canonicalBytes: fixtureBytes,
      artifactDigest,
      evidenceDigest: fixture.evidenceDigest,
      createdAt: "2026-08-23T00:00:00.000Z"
    };
  }
  async getArtifactStatus(
    access: BinaryCalibrationProjectAccess,
    artifactId: string
  ): Promise<BinaryCalibrationArtifactStatusProjection> {
    this.statusReads += 1;
    if (access.projectId !== PROJECT_ID || artifactId !== fixture.artifactId) {
      throw new BinaryCalibrationRepositoryError(
        "not_found",
        "Binary calibration artifact not found"
      );
    }
    return {
      contract: "coeval/binary-calibration-artifact-status/v1",
      schemaVersion: 1,
      artifactId,
      calibrationRunId: fixture.calibrationRunId,
      artifactStatus: "complete",
      currentAdmissibility: "admissible",
      reasons: [],
      evaluatedAt: "2026-08-23T00:00:00.000Z"
    };
  }
}

function membershipPool(
  memberships: Array<{ userId: string; projectId: string; role: "owner" | "member" }> = [
    { userId: "user_owner", projectId: PROJECT_ID, role: "owner" }
  ]
): Pool {
  return {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("select role from project_members")) {
        const membership = memberships.find((entry) =>
          entry.userId === values[0] && entry.projectId === values[1]);
        return {
          rows: membership ? [{ role: membership.role }] : [],
          rowCount: membership ? 1 : 0
        };
      }
      if (sql.includes("select project_id from project_members")) {
        const membership = memberships.find((entry) => entry.userId === values[0]);
        return {
          rows: membership ? [{ project_id: membership.projectId }] : [],
          rowCount: membership ? 1 : 0
        };
      }
      return { rows: [], rowCount: 0 };
    }
  } as unknown as Pool;
}

describe("binary calibration app wiring", () => {
  it("mounts control routes but returns 501 in demo mode", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const response = await app.request("/api/binary-calibration-runs");
    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({
      code: "binary_calibration_requires_database"
    });

    const key = (await repository.createApiKey({ projectId: PROJECT_ID, name: "demo-artifact" })).key;
    const artifactResponse = await app.request(
      `/api/v1/binary-calibration-artifacts/${fixture.artifactId}`,
      { headers: { authorization: `Bearer ${key}` } }
    );
    expect(artifactResponse.status).toBe(501);
    await expect(artifactResponse.json()).resolves.toMatchObject({
      code: "binary_calibration_requires_database"
    });
  });

  it("launches through the authenticated owner-session app boundary", async () => {
    const calibration = new AppCalibrationRepository();
    const app = createApp(new DemoRepository(), {
      pool: membershipPool(),
      auth: {
        api: {
          getSession: async () => ({
            user: { id: "user_owner", email: "owner@example.com", name: "Owner" },
            session: { id: "session_1" }
          })
        }
      } as never,
      binaryCalibrationRepository: calibration
    });
    const body = {
      datasetRevisionId: "revision_sealed_1",
      skillVersionId: "skill_version_1",
      positiveClass: "pass",
      trialPlan: { kind: "single", trialsPerItem: 1 },
      suiteBinding: null,
      idempotencyKey: "app-launch-1"
    };
    const response = await app.request("/api/binary-calibration-runs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-coeval-project": PROJECT_ID },
      body: JSON.stringify(body)
    });
    expect(response.status).toBe(202);
    expect(calibration.created).toEqual({
      actor: { projectId: PROJECT_ID, userId: "user_owner", projectRole: "owner" },
      input: body
    });

    const artifactResponse = await app.request(
      `/api/v1/binary-calibration-artifacts/${fixture.artifactId}`,
      { headers: { "x-coeval-project": PROJECT_ID } }
    );
    expect(artifactResponse.status).toBe(200);
    expect(Buffer.from(await artifactResponse.arrayBuffer())).toEqual(fixtureBytes);

    const statusResponse = await app.request(
      `/api/v1/binary-calibration-artifacts/${fixture.artifactId}/status`,
      { headers: { "x-coeval-project": PROJECT_ID } }
    );
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      artifactId: fixture.artifactId,
      currentAdmissibility: "admissible"
    });

    const privateLedger = await app.request(
      `/api/v1/binary-calibration-artifacts/${fixture.artifactId}/private-ledger`,
      { headers: { "x-coeval-project": PROJECT_ID } }
    );
    expect(privateLedger.status).toBe(404);
  });

  it("denies same-project and foreign API keys before artifact lookup", async () => {
    const repository = new DemoRepository();
    const key = (await repository.createApiKey({ projectId: PROJECT_ID, name: "same-project" })).key;
    const foreignKey = (await repository.createApiKey({
      projectId: "project_foreign",
      name: "foreign-project"
    })).key;
    const calibration = new AppCalibrationRepository();
    const app = createApp(repository, {
      pool: membershipPool(),
      auth: { api: { getSession: async () => null } } as never,
      binaryCalibrationRepository: calibration
    });
    const launch = await app.request("/api/binary-calibration-runs", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        datasetRevisionId: "revision_sealed_1",
        skillVersionId: "skill_version_1",
        positiveClass: "pass",
        trialPlan: { kind: "single", trialsPerItem: 1 },
        suiteBinding: null,
        idempotencyKey: "api-key-cannot-launch"
      })
    });
    expect(launch.status).toBe(401);

    for (const token of [key, foreignKey]) {
      const denials: unknown[] = [];
      for (const artifactId of [fixture.artifactId, "artifact_does_not_exist"]) {
        for (const suffix of ["", "/status"]) {
          const response = await app.request(
            `/api/v1/binary-calibration-artifacts/${artifactId}${suffix}`,
            { headers: { authorization: `Bearer ${token}` } }
          );
          expect(response.status).toBe(403);
          denials.push(await response.json());
        }
      }
      expect(new Set(denials.map((body) => JSON.stringify(body))).size).toBe(1);
      expect(denials[0]).toMatchObject({ code: "binary_calibration_owner_session_required" });
    }
    expect(calibration.artifactReads).toBe(0);
    expect(calibration.statusReads).toBe(0);
  });

  it("denies member and foreign-project sessions without revealing artifact existence", async () => {
    const calibration = new AppCalibrationRepository();
    const memberApp = createApp(new DemoRepository(), {
      pool: membershipPool([
        { userId: "user_member", projectId: PROJECT_ID, role: "member" }
      ]),
      auth: {
        api: {
          getSession: async () => ({
            user: { id: "user_member", email: "member@example.com", name: "Member" },
            session: { id: "session_member" }
          })
        }
      } as never,
      binaryCalibrationRepository: calibration
    });
    const foreignSessionApp = createApp(new DemoRepository(), {
      pool: membershipPool([
        { userId: "user_foreign", projectId: "project_foreign", role: "owner" }
      ]),
      auth: {
        api: {
          getSession: async () => ({
            user: { id: "user_foreign", email: "foreign@example.com", name: "Foreign owner" },
            session: { id: "session_foreign" }
          })
        }
      } as never,
      binaryCalibrationRepository: calibration
    });

    for (const caller of [
      { app: memberApp, projectId: PROJECT_ID, expectedStatus: 403 },
      { app: foreignSessionApp, projectId: "project_foreign", expectedStatus: 404 }
    ]) {
      const denials: unknown[] = [];
      for (const artifactId of [fixture.artifactId, "artifact_does_not_exist"]) {
        for (const suffix of ["", "/status"]) {
          const response = await caller.app.request(
            `/api/v1/binary-calibration-artifacts/${artifactId}${suffix}`,
            { headers: { "x-coeval-project": caller.projectId } }
          );
          expect(response.status).toBe(caller.expectedStatus);
          denials.push(await response.json());
        }
      }
      expect(new Set(denials.map((body) => JSON.stringify(body))).size).toBe(1);
    }
    expect(calibration.artifactReads).toBe(2);
    expect(calibration.statusReads).toBe(2);
  });

  it("exposes artifact integrity headers to browser clients", async () => {
    const response = await createApp(new DemoRepository()).request("/api/binary-calibration-runs", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-coeval-project"
      }
    });
    expect(response.status).toBe(204);
    const exposed = response.headers.get("access-control-expose-headers")?.toLowerCase() ?? "";
    expect(exposed).toContain("x-coeval-artifact-digest");
    expect(exposed).toContain("x-coeval-evidence-digest");
    expect(exposed).toContain("x-coeval-canonicalization");
    expect(exposed).toContain("etag");
    expect(exposed).toContain("digest");
  });
});
