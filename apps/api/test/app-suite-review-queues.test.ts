import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { DemoRepository } from "../src/repository.js";

describe("Coeval Hono API", () => {
  it("creates and lists annotation queues with counters + per-item ordering", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);

    // Empty state: no queues yet.
    await expect((await localApp.request("/api/review-queues")).json()).resolves.toEqual({ queues: [] });

    const createResponse = await localApp.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "October calibration round",
        description: "Cross-check three reviewers on a representative cohort.",
        caseIds: ["case_exc_001", "case_exc_002", "case_exc_003", "case_exc_001"] // dup at the end — should be deduped
      })
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { queue: { id: string; name: string; pendingCount: number; completedCount: number } };
    expect(created.queue).toMatchObject({
      name: "October calibration round",
      pendingCount: 3,
      completedCount: 0
    });

    // List returns the new queue.
    const list = (await (await localApp.request("/api/review-queues")).json()) as { queues: Array<{ id: string; pendingCount: number }> };
    expect(list.queues).toHaveLength(1);
    expect(list.queues[0]?.id).toBe(created.queue.id);
    expect(list.queues[0]?.pendingCount).toBe(3);

    // Detail returns items in position order, deduped.
    const detail = (await (await localApp.request(`/api/review-queues/${created.queue.id}`)).json()) as {
      queue: { id: string };
      items: Array<{ caseId: string; position: number; status: string }>;
    };
    expect(detail.queue.id).toBe(created.queue.id);
    expect(detail.items.map((item) => item.caseId)).toEqual(["case_exc_001", "case_exc_002", "case_exc_003"]);
    expect(detail.items.map((item) => item.position)).toEqual([0, 1, 2]);
    expect(detail.items.every((item) => item.status === "pending")).toBe(true);
  });

  it("rejects queue creation with cases that aren't in this project", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const response = await localApp.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Bad queue",
        caseIds: ["case_does_not_exist", "case_exc_001"]
      })
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "One or more cases were not found in this project" });
  });

  it("returns 404 for an unknown review-queue id", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const response = await localApp.request("/api/review-queues/revq_does_not_exist");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "Review queue not found" });
  });

  it("auto-completes pending queue items when a human verdict is recorded", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const create = await localApp.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "calibration round",
        caseIds: ["case_exc_001", "case_exc_002"]
      })
    });
    const { queue } = (await create.json()) as { queue: { id: string } };

    // Next-pending starts as the first item.
    const initial = (await (await localApp.request(`/api/review-queues/${queue.id}/next`)).json()) as { item: { caseId: string } | null };
    expect(initial.item?.caseId).toBe("case_exc_001");

    // Record a human verdict — should auto-complete the corresponding queue item.
    const verdict = await localApp.request("/api/cases/case_exc_001/verdicts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { kind: "binary", pass: false, rationale: "outdated policy" } })
    });
    expect(verdict.status).toBe(201);

    // Next-pending now points at case_exc_002, completedCount jumped to 1.
    const afterVerdict = (await (await localApp.request(`/api/review-queues/${queue.id}/next`)).json()) as { item: { caseId: string } | null };
    expect(afterVerdict.item?.caseId).toBe("case_exc_002");
    const detailAfter = (await (await localApp.request(`/api/review-queues/${queue.id}`)).json()) as {
      queue: { pendingCount: number; completedCount: number };
    };
    expect(detailAfter.queue.pendingCount).toBe(1);
    expect(detailAfter.queue.completedCount).toBe(1);

    // Finish the queue.
    const verdict2 = await localApp.request("/api/cases/case_exc_002/verdicts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { kind: "binary", pass: true, rationale: "ok" } })
    });
    expect(verdict2.status).toBe(201);
    const final = (await (await localApp.request(`/api/review-queues/${queue.id}/next`)).json()) as { item: unknown };
    expect(final.item).toBeNull();
  });

  it("closes + reopens queues; closed queues return null next-item even with pending rows", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const create = await localApp.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "closeable", caseIds: ["case_exc_001"] })
    });
    const { queue } = (await create.json()) as { queue: { id: string } };

    // Close: queue.status flips to closed; next-item now returns null even
    // though the item is still pending.
    const close = await localApp.request(`/api/review-queues/${queue.id}/close`, { method: "POST" });
    expect(close.status).toBe(200);
    const closed = (await close.json()) as { queue: { status: string; closedAt: string | null } };
    expect(closed.queue.status).toBe("closed");
    expect(closed.queue.closedAt).not.toBeNull();

    const nextWhileClosed = (await (await localApp.request(`/api/review-queues/${queue.id}/next`)).json()) as { item: unknown; queueStatus: string };
    expect(nextWhileClosed.item).toBeNull();
    expect(nextWhileClosed.queueStatus).toBe("closed");

    // Reopen: status flips back to open; next-item resumes pointing at the
    // pending item.
    const reopen = await localApp.request(`/api/review-queues/${queue.id}/reopen`, { method: "POST" });
    expect(reopen.status).toBe(200);
    const reopened = (await reopen.json()) as { queue: { status: string; closedAt: string | null } };
    expect(reopened.queue.status).toBe("open");
    expect(reopened.queue.closedAt).toBeNull();

    const nextAfterReopen = (await (await localApp.request(`/api/review-queues/${queue.id}/next`)).json()) as { item: { caseId: string } | null };
    expect(nextAfterReopen.item?.caseId).toBe("case_exc_001");
  });

  it("close/reopen + next are 404 for unknown queue ids", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    expect((await localApp.request("/api/review-queues/revq_nope/next")).status).toBe(404);
    expect((await localApp.request("/api/review-queues/revq_nope/close", { method: "POST" })).status).toBe(404);
    expect((await localApp.request("/api/review-queues/revq_nope/reopen", { method: "POST" })).status).toBe(404);
  });

  it("LLM-judge verdicts do NOT auto-complete pending queue items", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const create = await localApp.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "human-only", caseIds: ["case_exc_001"] })
    });
    const { queue } = (await create.json()) as { queue: { id: string } };

    // Record an LLM judge verdict directly via the repo (the public verdicts
    // endpoint is human-source only). This must not flip the queue item.
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_001",
      source: "llm_judge",
      skillVersionId: "skillv_1_2_0",
      payload: { kind: "binary", pass: true, rationale: "auto" }
    });

    const next = (await (await localApp.request(`/api/review-queues/${queue.id}/next`)).json()) as { item: { caseId: string } | null };
    expect(next.item?.caseId).toBe("case_exc_001"); // still pending
  });

  it("adds items with explicit reviewer assignment + dedups (queue_id, case_id, assignee)", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const create = await localApp.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "overlap-sampling", caseIds: ["case_exc_001"] })
    });
    const { queue } = (await create.json()) as { queue: { id: string } };

    // Add three items: case 1 to reviewer_a, case 1 to reviewer_b (κ overlap
    // partner), case 2 unassigned. The first row duplicates the existing
    // unassigned item on case 1 — but since assignment differs (null vs
    // 'reviewer_a'), both are kept.
    const add = await localApp.request(`/api/review-queues/${queue.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          { caseId: "case_exc_001", assignedToUserId: "reviewer_a" },
          { caseId: "case_exc_001", assignedToUserId: "reviewer_b" },
          { caseId: "case_exc_002" }
        ]
      })
    });
    expect(add.status).toBe(201);
    const addBody = (await add.json()) as { items: Array<{ caseId: string; assignedToUserId: string | null }>; addedCount: number };
    expect(addBody.addedCount).toBe(3);

    // Re-adding the same (case, assignee) combos is a no-op — dedup against
    // the existing rows.
    const dedup = await localApp.request(`/api/review-queues/${queue.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          { caseId: "case_exc_001", assignedToUserId: "reviewer_a" },
          { caseId: "case_exc_002" }
        ]
      })
    });
    expect((await dedup.json()) as { addedCount: number }).toMatchObject({ addedCount: 0 });

    // Detail shows 4 items total: 1 unassigned case_1 + 2 assigned case_1 + 1
    // unassigned case_2.
    const detail = (await (await localApp.request(`/api/review-queues/${queue.id}`)).json()) as {
      items: Array<{ caseId: string; assignedToUserId: string | null }>;
    };
    expect(detail.items).toHaveLength(4);
  });

  it("next-item filter: assignedTo=<user> returns assigned + unassigned, never other reviewers' items", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const create = await localApp.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "assigned-pull", caseIds: [] }) // start empty; we'll add via /items
    });
    expect(create.status).toBe(400); // empty caseIds rejected by schema

    const createReal = await localApp.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "assigned-pull", caseIds: ["case_exc_003"] })
    });
    const { queue } = (await createReal.json()) as { queue: { id: string } };
    await localApp.request(`/api/review-queues/${queue.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          { caseId: "case_exc_001", assignedToUserId: "reviewer_a" },
          { caseId: "case_exc_002", assignedToUserId: "reviewer_b" }
        ]
      })
    });

    // Without filter: any pending item (case_exc_003 unassigned has position 0
    // from the original create).
    const anyPull = (await (await localApp.request(`/api/review-queues/${queue.id}/next`)).json()) as { item: { caseId: string; assignedToUserId: string | null } | null };
    expect(anyPull.item?.caseId).toBe("case_exc_003");

    // Filter assignedTo=reviewer_a: returns case_exc_003 (unassigned, lower
    // position) first, then case_exc_001 (assigned to reviewer_a).
    const aPull = (await (await localApp.request(`/api/review-queues/${queue.id}/next?assignedTo=reviewer_a`)).json()) as { item: { caseId: string } | null };
    expect(aPull.item?.caseId).toBe("case_exc_003");

    // Filter assignedTo=reviewer_b: also returns case_exc_003 first (still
    // unassigned, lowest position), then case_exc_002 once case_exc_003 is
    // verdicted.
    const bPull = (await (await localApp.request(`/api/review-queues/${queue.id}/next?assignedTo=reviewer_b`)).json()) as { item: { caseId: string } | null };
    expect(bPull.item?.caseId).toBe("case_exc_003");
  });

  it("human verdicts complete only the verdicting reviewer's assigned items + unassigned items, leaving κ-partner rows pending", async () => {
    const repository = new DemoRepository();
    // Set up: one queue, one case, assigned to two reviewers (overlap).
    const queue = await repository.createReviewQueue({
      projectId: "proj_langsmith_support",
      name: "overlap",
      caseIds: [] // unsupported by schema, but the repo allows it directly
    }).catch(async () => {
      // The schema rejects empty caseIds at the API layer; bypass by creating
      // with a placeholder then deleting via direct repo access. Simpler:
      // create with one case.
      return await repository.createReviewQueue({
        projectId: "proj_langsmith_support",
        name: "overlap-direct",
        caseIds: ["case_exc_001"]
      });
    });
    // Add case_exc_002 assigned to both reviewers (κ overlap).
    await repository.addReviewQueueItems({
      projectId: "proj_langsmith_support",
      queueId: queue.id,
      items: [
        { caseId: "case_exc_002", assignedToUserId: "reviewer_a" },
        { caseId: "case_exc_002", assignedToUserId: "reviewer_b" }
      ]
    });

    // reviewer_a verdicts case_exc_002.
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_002",
      source: "human",
      actorUserId: "reviewer_a",
      payload: { kind: "binary", pass: true, rationale: "ok by a" }
    });

    // reviewer_a's item should be completed; reviewer_b's still pending.
    const detail = await repository.getReviewQueueDetail("proj_langsmith_support", queue.id);
    const itemsForCase002 = detail?.items.filter((item) => item.caseId === "case_exc_002") ?? [];
    expect(itemsForCase002).toHaveLength(2);
    const aRow = itemsForCase002.find((item) => item.assignedToUserId === "reviewer_a");
    const bRow = itemsForCase002.find((item) => item.assignedToUserId === "reviewer_b");
    expect(aRow?.status).toBe("completed");
    expect(bRow?.status).toBe("pending");

    // reviewer_b now verdicts — partner row should complete.
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_002",
      source: "human",
      actorUserId: "reviewer_b",
      payload: { kind: "binary", pass: false, rationale: "disagree" }
    });
    const detail2 = await repository.getReviewQueueDetail("proj_langsmith_support", queue.id);
    const bAfter = detail2?.items.find((item) => item.caseId === "case_exc_002" && item.assignedToUserId === "reviewer_b");
    expect(bAfter?.status).toBe("completed");
  });

  it("adds-items returns 404 for unknown queue id + 400 for unknown case id", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const notFound = await localApp.request("/api/review-queues/revq_nope/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ caseId: "case_exc_001" }] })
    });
    expect(notFound.status).toBe(404);

    const create = await localApp.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bad-cases", caseIds: ["case_exc_001"] })
    });
    const { queue } = (await create.json()) as { queue: { id: string } };
    const badCase = await localApp.request(`/api/review-queues/${queue.id}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ caseId: "case_does_not_exist" }] })
    });
    expect(badCase.status).toBe(400);
  });

  it("validates queue input shape (empty caseIds, oversized name)", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const empty = await localApp.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", caseIds: [] })
    });
    expect(empty.status).toBe(400);
    const tooLong = await localApp.request("/api/review-queues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(201), caseIds: ["case_exc_001"] })
    });
    expect(tooLong.status).toBe(400);
  });

  it("exposes the κ summary over project human verdicts", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);

    // No human verdicts yet → empty summary, null mean.
    const empty = await localApp.request("/api/projects/kappa");
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toMatchObject({
      raterCount: 0,
      overlappingCases: 0,
      pairs: [],
      meanKappa: null,
      meanInterpretation: null,
      unsupportedPairs: 0
    });

    // Two reviewers, three cases, agree on 2/3 — κ should be positive, mean
    // interpretation in the "moderate" band or similar (math validated in
    // kappa.test.ts; here we just verify the API delegates correctly).
    const pairs: Array<[string, string, boolean]> = [
      ["case_exc_001", "reviewer_a", false], ["case_exc_001", "reviewer_b", false],
      ["case_exc_002", "reviewer_a", true], ["case_exc_002", "reviewer_b", true],
      ["case_exc_003", "reviewer_a", true], ["case_exc_003", "reviewer_b", false]
    ];
    for (const [caseId, actor, pass] of pairs) {
      await repository.recordVerdict({
        projectId: "proj_langsmith_support",
        caseId,
        source: "human",
        actorUserId: actor,
        payload: { kind: "binary", pass, rationale: `${actor} on ${caseId}` }
      });
    }

    const populated = await localApp.request("/api/projects/kappa");
    expect(populated.status).toBe(200);
    const body = (await populated.json()) as {
      raterCount: number;
      overlappingCases: number;
      pairs: Array<{ reviewerA: string; reviewerB: string; cases: number; observedAgreement: number; kappa: number; interpretation: string }>;
      meanKappa: number | null;
      meanInterpretation: string | null;
    };
    expect(body.raterCount).toBe(2);
    expect(body.overlappingCases).toBe(3);
    expect(body.pairs).toHaveLength(1);
    expect(body.pairs[0]).toMatchObject({
      reviewerA: "reviewer_a",
      reviewerB: "reviewer_b",
      cases: 3
    });
    expect(body.pairs[0]?.observedAgreement).toBeCloseTo(2 / 3);
    expect(body.meanKappa).not.toBeNull();
    expect(body.meanInterpretation).not.toBeNull();
  });

  it("exposes the LLM-judge vs human calibration via /api/projects/judge-human-calibration", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);

    // Empty state — no verdicts of either source yet.
    const empty = await localApp.request("/api/projects/judge-human-calibration");
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toMatchObject({ raterCount: 0, pairs: [] });

    // Seed two paired verdicts: judge says pass, reviewer agrees.
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_001",
      source: "llm_judge",
      skillVersionId: "skillv_1_2_0",
      payload: { kind: "binary", pass: true, rationale: "judge" }
    });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_001",
      source: "human",
      actorUserId: "reviewer_a",
      payload: { kind: "binary", pass: true, rationale: "human" }
    });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_002",
      source: "llm_judge",
      skillVersionId: "skillv_1_2_0",
      payload: { kind: "binary", pass: false, rationale: "judge" }
    });
    await repository.recordVerdict({
      projectId: "proj_langsmith_support",
      caseId: "case_exc_002",
      source: "human",
      actorUserId: "reviewer_a",
      payload: { kind: "binary", pass: false, rationale: "human" }
    });

    const populated = await localApp.request("/api/projects/judge-human-calibration");
    const body = (await populated.json()) as {
      raterCount: number;
      overlappingCases: number;
      pairs: Array<{ reviewerA: string; reviewerB: string; observedAgreement: number; kappa: number }>;
      meanKappa: number | null;
    };
    expect(body.raterCount).toBe(2); // judge:skillv_1_2_0 + reviewer_a
    expect(body.overlappingCases).toBe(2);
    expect(body.pairs).toHaveLength(1);
    const pair = body.pairs[0]!;
    // One of the two carries the judge prefix.
    const idsByPrefix = [pair.reviewerA, pair.reviewerB].sort();
    expect(idsByPrefix[0]).toMatch(/^judge:/);
    expect(idsByPrefix[1]).toBe("reviewer_a");
    expect(pair.observedAgreement).toBe(1);
    expect(pair.kappa).toBe(1);
  });

  it("returns 400 on a malformed verdict payload", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const response = await localApp.request("/api/cases/case_exc_001/verdicts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { kind: "scalar", score: 5, range: [0, 1], rationale: "out of range" } })
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid verdict input" });
  });

  it("marks legacy verdict, adjudication, metric, export, and queue surfaces explicitly", async () => {
    const repository = new DemoRepository();
    const localApp = createApp(repository);
    const expected = "ungoverned_legacy";

    const reads = [
      "/api/cases/case_exc_001",
      "/api/cases/case_exc_001/verdicts",
      "/api/projects/verdicts",
      "/api/projects/verdicts/export",
      "/api/projects/kappa",
      "/api/projects/judge-human-calibration",
      "/api/projects/disagreements",
      "/api/projects/judge-human-disagreements",
      "/api/review-queues",
      "/api/review-queues/revq_missing",
      "/api/review-queues/revq_missing/next"
    ];
    for (const path of reads) {
      const response = await localApp.request(path);
      expect(response.headers.get("x-coeval-governance-class"), path).toBe(expected);
    }

    const writes = [
      ["/api/cases/case_exc_001/verdicts", {}],
      ["/api/cases/case_exc_001/adjudicate", {}],
      ["/api/review-queues", {}],
      ["/api/review-queues/revq_missing/items", {}],
      ["/api/review-queues/revq_missing/close", {}],
      ["/api/review-queues/revq_missing/reopen", {}]
    ] as const;
    for (const [path, body] of writes) {
      const response = await localApp.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      expect(response.headers.get("x-coeval-governance-class"), path).toBe(expected);
    }
  });
});
