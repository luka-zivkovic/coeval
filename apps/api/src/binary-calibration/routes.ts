import { createHash } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import { z, type ZodType } from "zod";
import { parseCanonicalBinaryCalibrationArtifactBytes } from "../lib/binary-calibration.js";
import {
  BINARY_CALIBRATION_CONTROL_BODY_BYTES,
  CreateBinaryCalibrationRunRequestSchema
} from "./control-contracts.js";
import {
  BinaryCalibrationRepositoryError,
  type BinaryCalibrationActor,
  type BinaryCalibrationArtifactStatusProjection,
  type BinaryCalibrationControlRepository,
  type BinaryCalibrationProjectAccess,
  type BinaryCalibrationProjectRole
} from "./repository.js";

export interface BinaryCalibrationRequestIdentity {
  userId: string | null;
  projectId: string;
  apiKeyId?: string | undefined;
}

export interface BinaryCalibrationRouteDependencies {
  repository: BinaryCalibrationControlRepository | null;
  databaseMode: boolean;
  requestIdentity(c: Context): BinaryCalibrationRequestIdentity;
  resolveProjectRole(input: {
    projectId: string;
    userId: string;
  }): Promise<BinaryCalibrationProjectRole | null>;
}

type SessionVariables = { binaryCalibrationActor: BinaryCalibrationActor };
type OwnerArtifactVariables = { binaryCalibrationAccess: BinaryCalibrationProjectAccess };

/** Owner launch plus aggregate-only session reads. */
export function createBinaryCalibrationControlRouter(
  dependencies: BinaryCalibrationRouteDependencies
) {
  const router = new Hono<{ Variables: SessionVariables }>();

  router.use("*", async (c, next) => {
    setNoStoreHeaders(c);
    if (!dependencies.databaseMode || !dependencies.repository) {
      return c.json({
        error: "Binary calibration requires database-backed session authentication.",
        code: "binary_calibration_requires_database"
      }, 501);
    }
    const identity = dependencies.requestIdentity(c);
    if (!identity.userId) {
      return c.json({
        error: "A signed-in session is required to control binary calibration; API keys cannot launch runs.",
        code: "binary_calibration_session_required"
      }, 401);
    }
    if (!identity.projectId) {
      return c.json({
        error: "No project membership",
        code: "binary_calibration_project_required"
      }, 403);
    }
    const projectRole = await dependencies.resolveProjectRole({
      projectId: identity.projectId,
      userId: identity.userId
    });
    if (!projectRole) {
      return c.json({
        error: "Not a member of this project",
        code: "binary_calibration_project_forbidden"
      }, 403);
    }
    c.set("binaryCalibrationActor", {
      projectId: identity.projectId,
      userId: identity.userId,
      projectRole
    });
    await next();
  });

  router.onError((error, c) => calibrationErrorResponse(c, error));

  router.get("/", async (c) => {
    const actor = c.get("binaryCalibrationActor");
    const runs = await repository(dependencies).listRuns({ projectId: actor.projectId });
    return c.json({ runs });
  });

  router.post("/", async (c) => {
    const actor = c.get("binaryCalibrationActor");
    if (actor.projectRole !== "owner") {
      return c.json({
        error: "Only project owners can launch sealed binary calibration.",
        code: "binary_calibration_owner_required"
      }, 403);
    }
    const input = await parseBody(c, CreateBinaryCalibrationRunRequestSchema);
    const run = await repository(dependencies).createRun(actor, input);
    return c.json({ run }, 202);
  });

  router.get("/:runId", async (c) => {
    const actor = c.get("binaryCalibrationActor");
    const run = await repository(dependencies).getRun(
      { projectId: actor.projectId },
      routeId(c, "runId")
    );
    return c.json({ run });
  });

  return router;
}

/**
 * Immutable aggregate-artifact reads for project-owner sessions. Project API
 * keys and member sessions cannot use this surface. No method exposes sealed
 * items or the private ledger.
 */
export function createBinaryCalibrationArtifactRouter(
  dependencies: BinaryCalibrationRouteDependencies
) {
  const router = new Hono<{ Variables: OwnerArtifactVariables }>();

  router.use("*", async (c, next) => {
    setNoStoreHeaders(c);
    if (!dependencies.databaseMode || !dependencies.repository) {
      return c.json({
        error: "Binary calibration artifacts require database-backed storage.",
        code: "binary_calibration_requires_database"
      }, 501);
    }
    const identity = dependencies.requestIdentity(c);
    if (!identity.userId) {
      return c.json({
        error: "A project-owner session is required for binary calibration artifacts.",
        code: "binary_calibration_owner_session_required"
      }, 403);
    }
    if (!identity.projectId) {
      return c.json({
        error: "No project membership",
        code: "binary_calibration_project_required"
      }, 403);
    }
    const role = await dependencies.resolveProjectRole({
      projectId: identity.projectId,
      userId: identity.userId
    });
    if (role !== "owner") {
      return c.json({
        error: "A project-owner session is required for binary calibration artifacts.",
        code: "binary_calibration_owner_session_required"
      }, 403);
    }
    c.set("binaryCalibrationAccess", { projectId: identity.projectId });
    await next();
  });

  router.onError((error, c) => calibrationErrorResponse(c, error));

  router.get("/:artifactId", async (c) => {
    const requestedArtifactId = routeId(c, "artifactId");
    const artifact = await repository(dependencies).getArtifact(
      c.get("binaryCalibrationAccess"),
      requestedArtifactId
    );
    const storedDigest = `sha256:${createHash("sha256").update(artifact.canonicalBytes).digest("hex")}`;
    if (storedDigest !== artifact.artifactDigest) {
      throw new Error("Persisted binary calibration artifact digest mismatch");
    }
    const verified = parseCanonicalBinaryCalibrationArtifactBytes(artifact.canonicalBytes);
    if (artifact.artifactId !== requestedArtifactId ||
      verified.artifactId !== artifact.artifactId ||
      verified.calibrationRunId !== artifact.calibrationRunId ||
      verified.evidenceDigest !== artifact.evidenceDigest) {
      throw new Error("Persisted binary calibration artifact identity mismatch");
    }
    c.header("content-type", "application/json; charset=utf-8");
    c.header("x-coeval-artifact-digest", artifact.artifactDigest);
    c.header("x-coeval-evidence-digest", artifact.evidenceDigest);
    c.header("x-coeval-canonicalization", "coeval-canonical-json/v1");
    c.header("etag", `"${artifact.artifactDigest}"`);
    c.header("digest", digestHeader(artifact.artifactDigest));
    return c.body(Uint8Array.from(artifact.canonicalBytes).buffer);
  });

  router.get("/:artifactId/status", async (c) => {
    const requestedArtifactId = routeId(c, "artifactId");
    const status = await repository(dependencies).getArtifactStatus(
      c.get("binaryCalibrationAccess"),
      requestedArtifactId
    );
    verifyArtifactStatus(status);
    if (status.artifactId !== requestedArtifactId) {
      throw new Error("Persisted binary calibration artifact status identity mismatch");
    }
    return c.json(status);
  });

  return router;
}

function repository(
  dependencies: BinaryCalibrationRouteDependencies
): BinaryCalibrationControlRepository {
  if (!dependencies.repository) {
    throw new Error("Binary calibration repository unavailable after route guard");
  }
  return dependencies.repository;
}

function routeId(c: Context, name: string): string {
  const value = c.req.param(name)?.trim();
  if (!value || value.length > 240) {
    throw new BinaryCalibrationHttpError(
      `Invalid ${name}`,
      "invalid_binary_calibration_request",
      400
    );
  }
  return value;
}

async function parseBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > BINARY_CALIBRATION_CONTROL_BODY_BYTES) {
    throw new BinaryCalibrationHttpError(
      `Request body exceeds ${BINARY_CALIBRATION_CONTROL_BODY_BYTES} bytes`,
      "binary_calibration_body_too_large",
      413
    );
  }
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > BINARY_CALIBRATION_CONTROL_BODY_BYTES) {
    throw new BinaryCalibrationHttpError(
      `Request body exceeds ${BINARY_CALIBRATION_CONTROL_BODY_BYTES} bytes`,
      "binary_calibration_body_too_large",
      413
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BinaryCalibrationHttpError(
      "Invalid JSON request body",
      "invalid_binary_calibration_request",
      400
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BinaryCalibrationHttpError(
      "Invalid binary calibration request",
      "invalid_binary_calibration_request",
      400,
      { validation: z.treeifyError(parsed.error) }
    );
  }
  return parsed.data;
}

function setNoStoreHeaders(c: Context): void {
  c.header("cache-control", "no-store");
  c.header("vary", "Origin, Cookie, x-coeval-project");
  c.header("x-content-type-options", "nosniff");
}

function digestHeader(artifactDigest: string): string {
  const hex = artifactDigest.replace(/^sha256:/, "");
  return `sha-256=${Buffer.from(hex, "hex").toString("base64")}`;
}

const ARTIFACT_STATUS_REASONS = new Set([
  "development_exposure",
  "provider_policy_invalidated",
  "provenance_invalidated",
  "artifact_superseded",
  "current_status_unavailable"
]);

function verifyArtifactStatus(status: BinaryCalibrationArtifactStatusProjection): void {
  if (status.contract !== "coeval/binary-calibration-artifact-status/v1" ||
    status.schemaVersion !== 1 ||
    status.reasons.some((reason) => !ARTIFACT_STATUS_REASONS.has(reason)) ||
    new Set(status.reasons).size !== status.reasons.length ||
    status.reasons.some((reason, index) => reason !== [...status.reasons].sort()[index])) {
    throw new Error("Persisted binary calibration artifact status is invalid");
  }
  const unavailable = status.reasons.includes("current_status_unavailable");
  const validMeaning =
    (status.currentAdmissibility === "admissible" && status.reasons.length === 0) ||
    (status.currentAdmissibility === "unknown" && status.reasons.length === 1 && unavailable) ||
    (status.currentAdmissibility === "revoked" && status.reasons.length > 0 && !unavailable);
  if (!validMeaning) throw new Error("Persisted binary calibration artifact status is inconsistent");
}

class BinaryCalibrationHttpError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 413,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "BinaryCalibrationHttpError";
  }
}

function calibrationErrorResponse(c: Context, error: Error) {
  if (error instanceof BinaryCalibrationHttpError) {
    return c.json({
      error: error.message,
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details })
    }, error.status);
  }
  if (error instanceof BinaryCalibrationRepositoryError) {
    const status = repositoryErrorStatus(error.code);
    return c.json({ error: error.message, code: `binary_calibration_${error.code}` }, status);
  }
  console.error("Binary calibration route failed", error);
  return c.json({
    error: "Binary calibration request failed",
    code: "binary_calibration_internal_error"
  }, 500);
}

function repositoryErrorStatus(
  code: BinaryCalibrationRepositoryError["code"]
): 403 | 404 | 409 | 422 | 501 {
  switch (code) {
    case "forbidden": return 403;
    case "not_found": return 404;
    case "conflict":
    case "idempotency_conflict":
    case "state_conflict": return 409;
    case "ineligible": return 422;
    case "unsupported": return 501;
  }
}
