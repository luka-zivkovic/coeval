import { describe, expect, it, vi } from "vitest";
import {
  registerAnalysisStudyDeadlineCloser,
  type AnalysisStudyDeadlineRepository
} from "../src/analysis-study/deadline.js";

describe("analysis study deadline closer", () => {
  it("runs a bounded startup pass and coalesces overlapping requests", async () => {
    let release!: (value: number) => void;
    const pending = new Promise<number>((resolve) => {
      release = resolve;
    });
    const closeDueStudies = vi.fn<AnalysisStudyDeadlineRepository["closeDueStudies"]>()
      .mockReturnValueOnce(Promise.resolve(2))
      .mockReturnValueOnce(pending);
    const closer = await registerAnalysisStudyDeadlineCloser(
      { closeDueStudies },
      { intervalMs: 60_000, batchSize: 7 }
    );
    expect(closeDueStudies).toHaveBeenCalledWith(7);

    const first = closer.closeDue();
    const second = closer.closeDue();
    expect(closeDueStudies).toHaveBeenCalledTimes(2);
    release(3);
    await expect(first).resolves.toBe(3);
    await expect(second).resolves.toBe(3);
    await closer.stop();
    await expect(closer.closeDue()).resolves.toBe(0);
  });

  it("rejects unsafe scheduling bounds", async () => {
    const repository: AnalysisStudyDeadlineRepository = {
      closeDueStudies: async () => 0
    };
    await expect(registerAnalysisStudyDeadlineCloser(repository, { intervalMs: 0 }))
      .rejects.toThrow("intervalMs must be an integer between 1 and 2147483647");
    await expect(registerAnalysisStudyDeadlineCloser(repository, { intervalMs: 2_147_483_648 }))
      .rejects.toThrow("intervalMs must be an integer between 1 and 2147483647");
    await expect(registerAnalysisStudyDeadlineCloser(repository, { batchSize: 0 }))
      .rejects.toThrow("batchSize must be an integer between 1 and 1000");
    await expect(registerAnalysisStudyDeadlineCloser(repository, { batchSize: 1_001 }))
      .rejects.toThrow("batchSize must be an integer between 1 and 1000");
  });

  it("drains an in-flight closure pass before stop resolves", async () => {
    let release!: () => void;
    const pending = new Promise<number>((resolve) => {
      release = () => resolve(1);
    });
    const repository: AnalysisStudyDeadlineRepository = {
      closeDueStudies: vi.fn()
        .mockResolvedValueOnce(0)
        .mockReturnValueOnce(pending)
    };
    const closer = await registerAnalysisStudyDeadlineCloser(repository, { intervalMs: 60_000 });
    void closer.closeDue();
    let stopped = false;
    const stopping = closer.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  });
});
