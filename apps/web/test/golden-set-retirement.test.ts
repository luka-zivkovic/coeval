import { describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/api.js";
import { formatStaleRetirementNotice, retirementContextFromBody } from "../src/lib/golden-set-retirement.js";

describe("golden-set retirement notices", () => {
  it("parses shared retirement context from ApiError bodies", () => {
    const body = {
      retirement: {
        retiredAt: "2026-05-05T00:00:00.000Z",
        retiredByUserId: "user_owner",
        retiredBy: "Owner <owner@example.com>",
        reason: "No longer representative."
      }
    };

    expect(retirementContextFromBody(body)).toEqual(body.retirement);
  });

  it("returns null for null and non-object ApiError bodies", () => {
    expect(retirementContextFromBody(null)).toBeNull();
    expect(retirementContextFromBody("upstream unavailable")).toBeNull();
    expect(retirementContextFromBody([])).toBeNull();
  });

  it("formats already-retired notices with actor, time, and reason", () => {
    const error = new ApiError("Golden-set entry already retired", 409, {
      retirement: {
        retiredAt: "retired-at-raw-string",
        retiredByUserId: "user_owner",
        retiredBy: "Owner <owner@example.com>",
        reason: "No longer representative."
      }
    });

    expect(formatStaleRetirementNotice(error)).toBe(
      "Golden-set entry was already retired by Owner <owner@example.com> on retired-at-raw-string. Refreshed the golden set. Reason: No longer representative."
    );
  });

  it("falls back gracefully when retirement context is missing or all-null", () => {
    expect(formatStaleRetirementNotice(new ApiError("Golden-set entry already retired", 409, {}))).toBe(
      "Golden-set entry was already retired. Refreshed the golden set."
    );
    expect(formatStaleRetirementNotice(new ApiError("Golden-set entry already retired", 409, {
      retirement: {
        retiredAt: null,
        retiredByUserId: null,
        retiredBy: null,
        reason: null
      }
    }))).toBe("Golden-set entry was already retired. Refreshed the golden set.");
  });

  it("keeps missing entries as the not-found stale-state notice", () => {
    expect(formatStaleRetirementNotice(new ApiError("Golden-set entry not found", 404, null))).toBe(
      "Golden-set entry was not found. Refreshed the golden set."
    );
  });
});
