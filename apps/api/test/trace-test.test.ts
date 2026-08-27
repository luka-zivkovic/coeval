import { describe, expect, it } from "vitest";
import type { CreateTraceTestInput, TraceTestDetail, TraceTestValidation } from "@coeval/shared";
import { createApp } from "../src/app.js";
import { DemoRepository } from "../src/repository.js";

const draft = (sourceCaseId: string): CreateTraceTestInput => ({
  sourceCaseId,
  sourceScope: {
    responsePath: ["output"],
    turnIndexes: [1],
    stepIndexes: []
  },
  desiredBehavior: "Check eligibility before promising a refund.",
  scenario: "A customer asks for a refund after renewal.",
  expectedBehavior: "Explain the policy-qualified refund path.",
  mustDo: ["Check eligibility"],
  mustAvoid: ["Promise a refund without evidence"],
  goodExample: { text: "I will check whether this renewal is eligible." },
  badExample: { text: "Your refund is guaranteed." },
  checker: { kind: "judge", label: "Refund policy behavior", metadata: {} },
  draftProvenance: {
    origin: "generated",
    generatedFields: ["scenario", "expectedBehavior", "mustDo", "mustAvoid", "goodExample", "checker"],
    generator: { provider: "mock", model: "mock-drafter" }
  }
});

describe("trace-derived test API", () => {
  it("keeps source provenance and append-only history while requiring reviewed validation to enable", async () => {
    const repository = new DemoRepository();
    const app = createApp(repository);
    const imported = await repository.importTrace("proj_langsmith_support", "manual", {
      sourceTraceId: "conversation_refund_1",
      input: { messages: [{ role: "user", content: "Can I get a refund?" }] },
      output: { messages: [{ role: "assistant", content: "Your refund is guaranteed." }] },
      metadata: { channel: "support" }
    }, { ingestionPurpose: "analysis_eligible_manual" });

    const create = await app.request("/api/trace-tests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...draft(imported.caseId), lifecycle: "enabled" })
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { test: TraceTestDetail };
    expect(created.test).toMatchObject({
      sourceCaseId: imported.caseId,
      sourceCaseRef: imported.caseId,
      sourceTraceRef: "conversation_refund_1",
      lifecycle: "draft",
      currentRevision: 1,
      enabledRevision: null
    });
    expect(created.test.sourceSnapshot).toMatchObject({
      input: { messages: [{ role: "user", content: "Can I get a refund?" }] },
      output: { messages: [{ role: "assistant", content: "Your refund is guaranteed." }] }
    });
    expect(created.test.revisions[0]).toMatchObject({
      lifecycle: "draft",
      reviewedByUserId: null,
      validationId: null,
      draftProvenance: { origin: "generated" }
    });

    const prematureEnable = await app.request(`/api/trace-tests/${created.test.id}/enable`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, validationId: "missing" })
    });
    expect(prematureEnable.status).toBe(409);

    const unavailable = await app.request(`/api/trace-tests/${created.test.id}/checks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1 })
    });
    expect(unavailable.status).toBe(201);
    const unavailableBody = (await unavailable.json()) as { validation: TraceTestValidation };
    expect(unavailableBody.validation).toMatchObject({ status: "unavailable", diagnostic: "unavailable", method: "automated" });

    const passed = await app.request(`/api/trace-tests/${created.test.id}/validations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: 1,
        badResult: "fail",
        goodResult: "pass",
        overrideReason: "I reviewed both examples and they clearly demonstrate opposite outcomes."
      })
    });
    expect(passed.status).toBe(201);
    const passedBody = (await passed.json()) as { validation: TraceTestValidation };
    expect(passedBody.validation).toMatchObject({ status: "passed", method: "manual_override" });

    const enable = await app.request(`/api/trace-tests/${created.test.id}/enable`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, validationId: passedBody.validation.id })
    });
    expect(enable.status).toBe(200);
    const enabled = (await enable.json()) as { test: TraceTestDetail };
    expect(enabled.test).toMatchObject({
      lifecycle: "enabled",
      currentRevision: 2,
      enabledRevision: 2,
      hasUnpublishedChanges: false
    });
    expect(enabled.test.revisions[1]).toMatchObject({
      lifecycle: "enabled",
      validatedRevision: 1,
      validationId: passedBody.validation.id,
      createdByUserId: null,
      reviewedByUserId: "demo-reviewer"
    });

    const revisionBody = {
      ...draft(imported.caseId),
      expectedRevision: 2,
      desiredBehavior: "Check eligibility and state the next cancellation step.",
      scenario: "A customer asks to cancel and requests a refund."
    };
    delete (revisionBody as Partial<CreateTraceTestInput>).sourceCaseId;
    delete (revisionBody as Partial<CreateTraceTestInput>).sourceScope;
    const revise = await app.request(`/api/trace-tests/${created.test.id}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(revisionBody)
    });
    expect(revise.status).toBe(201);
    const revised = (await revise.json()) as { test: TraceTestDetail };
    expect(revised.test).toMatchObject({
      lifecycle: "enabled",
      currentRevision: 3,
      enabledRevision: 2,
      hasUnpublishedChanges: true
    });
    expect(revised.test.revisions.map((revision) => revision.lifecycle)).toEqual(["draft", "enabled", "draft"]);
    expect(revised.test.revisions[0]?.scenario).toBe("A customer asks for a refund after renewal.");

    const stale = await app.request(`/api/trace-tests/${created.test.id}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...revisionBody, expectedRevision: 2 })
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ expectedRevision: 2, currentRevision: 3 });

    const list = await app.request(`/api/trace-tests?sourceCaseId=${encodeURIComponent(imported.caseId)}`);
    await expect(list.json()).resolves.toMatchObject({
      tests: [{ id: created.test.id, currentRevision: 3, enabledRevision: 2 }]
    });
  });

  it("rejects a source case that is outside the active project", async () => {
    const app = createApp(new DemoRepository());
    const response = await app.request("/api/trace-tests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft("case_from_another_project"))
    });
    expect(response.status).toBe(404);
  });
});
