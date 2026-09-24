import { describe, expect, it, vi } from "vitest";
import {
  parseProductionRetentionIntervalMs,
  registerProductionRetentionSweeper
} from "../src/production-calibration/retention.js";

describe("production retention sweeper", () => {
  it("never lets the deployment's interval switch retention off", () => {
    const hour = 60 * 60 * 1000;
    expect(parseProductionRetentionIntervalMs(undefined)).toBe(hour);
    expect(parseProductionRetentionIntervalMs("")).toBe(hour);
    expect(parseProductionRetentionIntervalMs("0")).toBe(hour);
    expect(parseProductionRetentionIntervalMs("-5")).toBe(hour);
    expect(parseProductionRetentionIntervalMs("soon")).toBe(hour);
    expect(parseProductionRetentionIntervalMs("10")).toBe(60 * 1000);
    expect(parseProductionRetentionIntervalMs("900000")).toBe(900_000);
  });

  it("runs one sweep at a time and stops cleanly", async () => {
    let finish: () => void = () => undefined;
    const applyRetention = vi.fn(() => new Promise<{ skipped: boolean; projects: [] }>((resolve) => {
      finish = () => resolve({ skipped: false, projects: [] });
    }));
    const sweeper = registerProductionRetentionSweeper({ applyRetention }, { intervalMs: 0 });
    const first = sweeper.sweep();
    const second = sweeper.sweep();
    expect(applyRetention).toHaveBeenCalledTimes(1);
    finish();
    await expect(first).resolves.toEqual({ skipped: false, projects: [] });
    await expect(second).resolves.toEqual({ skipped: false, projects: [] });
    await sweeper.stop();
    await expect(sweeper.sweep()).resolves.toEqual({ skipped: true, projects: [] });
  });
});
