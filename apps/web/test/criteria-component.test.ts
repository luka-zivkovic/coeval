import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CriterionPickerList } from "../src/components/criterion-picker-list.js";
import type { CriterionChoice } from "../src/lib/criterion-context.js";

const choices: CriterionChoice[] = [
  {
    criterion: {
      id: "criterion_correctness",
      projectId: "project_1",
      stableKey: "correctness",
      sourceKind: "native",
      createdByUserId: null,
      createdAt: "2026-08-23T00:00:00.000Z"
    },
    detail: null,
    name: "Correctness",
    definition: "The response is factually correct.",
    revision: 1
  },
  {
    criterion: {
      id: "criterion_tone",
      projectId: "project_1",
      stableKey: "tone",
      sourceKind: "native",
      createdByUserId: null,
      createdAt: "2026-08-23T00:00:00.000Z"
    },
    detail: null,
    name: "Tone",
    definition: "The response uses the requested tone.",
    revision: 2
  }
];

describe("CriterionPickerList", () => {
  it("renders every criterion and clearly marks the active scope", () => {
    const html = renderToStaticMarkup(createElement(CriterionPickerList, {
      choices,
      selectedCriterionId: "criterion_tone",
      onSelect: vi.fn()
    }));

    expect(html).toContain("Correctness");
    expect(html).toContain("Tone");
    expect(html).toContain("The response uses the requested tone.");
    expect(html).toContain("selected");
    expect(html).toContain("definition r2");
  });
});
