import { describe, expect, it, vi } from "vitest";
import type { RubristRepository } from "../src/repository.js";
import { processGateRunJob } from "../src/workers/gate.js";

// Resolution after save (ADR-0014 section 4) runs in the gate worker, before
// the regression gate, and never blocks it.

const JOB = {
  projectId: "project",
  skillVersionId: "version",
  datasetRevisionId: "revision",
  timeScope: "new" as const
};

function repository(order: string[]): RubristRepository {
  return {
    runRegressionGateForVersion: vi.fn(async () => {
      order.push("gate");
      return { version: { id: "version" }, regressionRun: { id: "run", status: "passed" } };
    })
  } as unknown as RubristRepository;
}

describe("the gate worker's resolution after save", () => {
  it("resolves the saved binding before the regression gate", async () => {
    const order: string[] = [];
    await processGateRunJob(repository(order), JOB, undefined, async (job) => {
      order.push(`resolve:${job.projectId}:${job.skillVersionId}`);
    });
    expect(order).toEqual(["resolve:project:version", "gate"]);
  });

  it("runs the gate even when resolution fails", async () => {
    const order: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await processGateRunJob(repository(order), JOB, undefined, async () => {
        throw new Error("provider unreachable");
      });
    } finally {
      error.mockRestore();
    }
    expect(order).toEqual(["gate"]);
  });
});
