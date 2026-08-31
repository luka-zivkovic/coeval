import { createHash } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import {
  AddDatasetItemsInputSchema,
  CreateDatasetInputSchema,
  CreateDatasetRevisionInputSchema,
  ImportDatasetExamplesInputSchema,
  type TraceStep
} from "@coeval/shared";
import {
  CaseNotFoundError,
  DatasetNameTakenError,
  DatasetNotFoundError,
  DatasetRevisionConflictError,
  SealedValidationUnavailableError,
  type CoevalRepository
} from "../repository.js";
import type { AppVariables, RequestServices } from "../request-services/index.js";

type DatasetAdministrationApp = Hono<{ Variables: AppVariables }>;

export interface DatasetAdministrationRouteOptions {
  repository: CoevalRepository;
  requestServices: RequestServices;
}

// Registration remains on the parent app after session/project middleware and
// at the original point between trace-test administration and run orchestration.
export function registerDatasetAdministrationRoutes(
  app: DatasetAdministrationApp,
  options: DatasetAdministrationRouteOptions
): void {
  const { repository, requestServices } = options;
  const requireOwner = requestServices.requireOwner;

  // Datasets: named case collections for repeatable eval runs. Mutations are
  // owner-only (curation acts, matching review queues); reads are open to
  // project members.
  app.get("/api/datasets", async (c) => {
    return c.json({ datasets: await repository.listDatasets(c.get("projectId")) });
  });

  app.post("/api/datasets", async (c) => {
    const denied = await requireOwner(c, "create datasets");
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    const parsed = CreateDatasetInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid dataset input", details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      const dataset = await repository.createDataset({
        projectId: c.get("projectId"),
        name: parsed.data.name,
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(c.get("user")?.id ? { createdByUserId: c.get("user")!.id } : {})
      });
      return c.json({ dataset }, 201);
    } catch (error) {
      if (error instanceof DatasetNameTakenError) return c.json({ error: error.message }, 409);
      throw error;
    }
  });

  app.get("/api/datasets/:datasetId", async (c) => {
    const detail = await repository.getDatasetDetail(c.get("projectId"), c.req.param("datasetId"));
    if (!detail) return c.json({ error: "Dataset not found" }, 404);
    return c.json(detail);
  });

  app.get("/api/datasets/:datasetId/revisions", async (c) => {
    const projectId = c.get("projectId");
    const datasetId = c.req.param("datasetId");
    const dataset = await repository.getDatasetDetail(projectId, datasetId);
    if (!dataset) return c.json({ error: "Dataset not found" }, 404);
    return c.json({
      collection: { ...dataset, mutability: "working_collection" as const },
      revisions: await repository.listDatasetRevisions(projectId, datasetId)
    });
  });

  app.post("/api/datasets/:datasetId/revisions", async (c) => {
    const denied = await requireOwner(c, "freeze dataset revisions");
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    const parsed = CreateDatasetRevisionInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid dataset revision input", details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      const revision = await repository.createDatasetRevision({
        projectId: c.get("projectId"),
        datasetId: c.req.param("datasetId"),
        ...parsed.data,
        ...(c.get("user")?.id ? { createdByUserId: c.get("user")!.id } : {})
      });
      return c.json({ revision }, 201);
    } catch (error) {
      if (error instanceof DatasetNotFoundError) return c.json({ error: error.message }, 404);
      if (error instanceof SealedValidationUnavailableError) {
        return c.json({ error: error.message, code: "sealed_validation_unavailable" }, 409);
      }
      if (error instanceof DatasetRevisionConflictError) return c.json({ error: error.message }, 409);
      throw error;
    }
  });

  app.get("/api/dataset-revisions/:revisionId/metadata", async (c) => {
    const revision = (await repository.listDatasetRevisions(c.get("projectId")))
      .find((candidate) => candidate.id === c.req.param("revisionId"));
    if (!revision) return c.json({ error: "Dataset revision not found" }, 404);
    // Metadata-only by contract: no payload bytes and no content-view exposure
    // event. This is safe for progress denominators and sealed identities.
    return c.json({ revision });
  });

  app.get("/api/dataset-revisions/:revisionId", async (c) => {
    const projectId = c.get("projectId");
    const revisionId = c.req.param("revisionId");
    const metadata = (await repository.listDatasetRevisions(projectId)).find((revision) => revision.id === revisionId);
    if (!metadata) return c.json({ error: "Dataset revision not found" }, 404);
    if (metadata.role === "sealed_validation") {
      return c.json({ error: "Sealed validation contents are unavailable on the ordinary session API." }, 403);
    }
    if (metadata.sourceKind === "analysis_population") {
      return c.json({
        error: "Analysis population contents are available only through the governed Analyze API.",
        code: "analysis_population_content_route_required"
      }, 403);
    }
    await repository.recordDatasetRevisionContentView({
      projectId,
      revisionId,
      ...(c.get("user")?.id ? { actorUserId: c.get("user")!.id } : {})
    });
    const revision = await repository.getDatasetRevisionDetail(projectId, revisionId);
    if (!revision) return c.json({ error: "Dataset revision not found" }, 404);
    return c.json({ revision });
  });

  app.post("/api/datasets/:datasetId/items", async (c) => {
    const denied = await requireOwner(c, "edit datasets");
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    const parsed = AddDatasetItemsInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid dataset items input", details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      const items = await repository.addDatasetItems({
        projectId: c.get("projectId"),
        datasetId: c.req.param("datasetId"),
        items: parsed.data.items
      });
      return c.json({ items }, 201);
    } catch (error) {
      if (error instanceof DatasetNotFoundError) return c.json({ error: error.message }, 404);
      if (error instanceof CaseNotFoundError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  // Skill Bench ingestion: paste examples as content. Each item mints a manual
  // case (or content-dedups into an existing one) and lands in the dataset
  // with its expected label. Two deliberate differences from trace import:
  //  - sourceTraceId is a hash of (input, output), so re-pasting an unchanged
  //    example dedups cleanly while an EDITED example becomes a fresh case —
  //    the id-based dedup would silently reuse the stale payload;
  //  - nothing is auto-judged here (no judge.run enqueue). Bench judging
  //    happens only through explicit eval runs, so pasting 200 examples never
  //    burns 200 provider calls against a placeholder rubric.
  app.post("/api/datasets/:datasetId/examples", async (c) => {
    const denied = await requireOwner(c, "edit datasets");
    if (denied) return denied;
    const body = await c.req.json().catch(() => null);
    const parsed = ImportDatasetExamplesInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid dataset examples input", details: z.treeifyError(parsed.error) }, 400);
    }

    const projectId = c.get("projectId");
    const datasetId = c.req.param("datasetId");

    // Coalesce within-batch duplicates by content hash BEFORE the repository
    // call: identical content = identical sourceTraceId = the same case, and
    // the last LABELED occurrence wins (a label-less duplicate must not erase
    // an earlier duplicate's label — mirrors the storage upsert). Collapsed
    // occurrences count as "reused" so the response semantics are unchanged.
    type CoalescedExample = {
      sourceTraceId: string;
      input: unknown;
      output: unknown;
      metadata: Record<string, unknown>;
      steps?: TraceStep[];
      expectedLabel?: "pass" | "fail";
      expectedFailStep?: number;
      note?: string;
    };
    const bySource = new Map<string, CoalescedExample>();
    const order: string[] = [];
    for (const item of parsed.data.items) {
      // Steps join the hash only when present: an edited step must mint a new
      // case, while every pre-M2 (step-less) example keeps its exact hash and
      // therefore its existing case.
      const contentHash = createHash("sha256")
        .update(JSON.stringify({
          input: item.input ?? null,
          output: item.output ?? null,
          ...(item.steps ? { steps: item.steps } : {})
        }))
        .digest("hex")
        .slice(0, 32);
      const sourceTraceId = `ex_${contentHash}`;
      const prior = bySource.get(sourceTraceId);
      if (!prior) order.push(sourceTraceId);
      const expectedLabel = item.expectedLabel ?? prior?.expectedLabel;
      // Same invariant as the storage upsert: this item's explicit pass
      // clears any prior step; a fail without a step keeps the prior one.
      const expectedFailStep = item.expectedLabel === "pass"
        ? undefined
        : item.expectedFailStep ?? prior?.expectedFailStep;
      const note = item.note ?? prior?.note;
      bySource.set(sourceTraceId, {
        sourceTraceId,
        input: item.input,
        output: item.output,
        metadata: item.name ? { name: item.name } : prior?.metadata ?? {},
        ...(item.steps ? { steps: item.steps } : {}),
        ...(expectedLabel ? { expectedLabel } : {}),
        ...(expectedFailStep !== undefined ? { expectedFailStep } : {}),
        ...(note ? { note } : {})
      });
    }
    const collapsedDuplicates = parsed.data.items.length - order.length;

    // Cases + dataset membership land atomically (M0 C2) — a mid-flow failure
    // rolls everything back instead of stranding membership-less cases.
    let imported;
    try {
      imported = await repository.importDatasetExamples({
        projectId,
        datasetId,
        ingestionPurpose: "dataset_example",
        items: order.map((sourceTraceId) => bySource.get(sourceTraceId)!)
      });
    } catch (error) {
      if (error instanceof DatasetNotFoundError) return c.json({ error: "Dataset not found" }, 404);
      if (error instanceof CaseNotFoundError) return c.json({ error: error.message }, 400);
      throw error;
    }

    return c.json({
      items: imported.items.map((item) => ({
        caseId: item.caseId,
        datasetItemId: item.datasetItemId,
        created: item.created
      })),
      reusedCount: collapsedDuplicates + imported.items.filter((item) => !item.created).length,
      // Route-built metadata is never coeval-internal, so the anti-recursion
      // skip can't fire on this path; the field stays for schema stability.
      skippedCount: 0
    }, 201);
  });

  app.delete("/api/datasets/:datasetId/items/:itemId", async (c) => {
    const denied = await requireOwner(c, "edit datasets");
    if (denied) return denied;
    const removed = await repository.removeDatasetItem(c.get("projectId"), c.req.param("datasetId"), c.req.param("itemId"));
    if (!removed) return c.json({ error: "Dataset item not found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/api/datasets/:datasetId/archive", async (c) => {
    const denied = await requireOwner(c, "archive datasets");
    if (denied) return denied;
    const archived = await repository.archiveDataset(c.get("projectId"), c.req.param("datasetId"));
    if (!archived) return c.json({ error: "Dataset not found" }, 404);
    return c.json({ ok: true });
  });
}
