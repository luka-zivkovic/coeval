import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { BlindReviewLayout } from "../src/layouts/blind-review-layout.js";
import type { GovernedBlindTaskArtifact, GovernedPostBarrierItem } from "../src/lib/governed-review-api.js";

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children?: unknown }) => createElement("button", props, children as never)
}));
vi.mock("@/components/ui/card", () => ({
  Card: ({ children, ...props }: { children?: unknown }) => createElement("div", props, children as never),
  CardContent: ({ children, ...props }: { children?: unknown }) => createElement("div", props, children as never),
  CardHeader: ({ children, ...props }: { children?: unknown }) => createElement("div", props, children as never),
  CardTitle: ({ children, ...props }: { children?: unknown }) => createElement("div", props, children as never)
}));
vi.mock("@/components/ui/input", () => ({ Input: (props: object) => createElement("input", props) }));
vi.mock("@/components/ui/textarea", () => ({ Textarea: (props: object) => createElement("textarea", props) }));
vi.mock("@/lib/governed-review-api", () => ({
  appendGovernedAdjudication: vi.fn(),
  appendGovernedAlignmentEvent: vi.fn(),
  deferGovernedTask: vi.fn(),
  fetchGovernedBatch: vi.fn(),
  fetchGovernedBlindTaskView: vi.fn(),
  fetchGovernedPostBarrierItem: vi.fn(),
  fetchGovernedTasks: vi.fn(),
  resumeGovernedTask: vi.fn(),
  submitGovernedLabel: vi.fn(),
  withdrawGovernedLabel: vi.fn()
}));

const sha = (digit: string) => `sha256:${digit.repeat(64)}`;

const artifact: GovernedBlindTaskArtifact = {
  viewDigest: sha("a"),
  canonicalBytes: new TextEncoder().encode("exact-canonical-view"),
  canonicalText: "exact-canonical-view",
  view: {
    contract: "coeval/governed-blind-task-view/v1",
    schemaVersion: 1,
    canonicalizationVersion: "coeval-canonical-json/v1",
    taskId: "task_1",
    batchId: "batch_1",
    servePosition: 0,
    criterion: {
      criterionId: "criterion_1",
      criterionVersionId: "criterion_version_1",
      name: "Groundedness",
      definition: "The answer is supported by the supplied evidence.",
      criterionDigest: sha("1")
    },
    instruction: {
      instructionVersionId: "instruction_1",
      title: "Review groundedness",
      instructions: "Use only the frozen evidence.",
      failureCodeGuidance: "Write open failure codes.",
      allowedLabels: ["pass", "fail", "cannot_determine"],
      instructionDigest: sha("2")
    },
    payloadSnapshot: {
      input: { question: "What is the refund window?" },
      output: { answer: "Thirty days." }
    }
  }
};

describe("governed review components", () => {
  it("renders the blind shell without dashboard navigation, selectors, or trace links", () => {
    const html = renderToStaticMarkup(createElement(
      MemoryRouter,
      { initialEntries: ["/governed-review/tasks/task_1"] },
      createElement(BlindReviewLayout)
    ));

    expect(html).toContain("Blind review workspace");
    expect(html).toContain('href="/governed-review/tasks"');
    expect(html).not.toContain('href="/traces"');
    expect(html).not.toContain("Selected criterion");
    expect(html).not.toContain("Reviewer view");
  });

  it("renders only the exact frozen task artifact and preserves its canonical text", async () => {
    const { BlindTaskEvidence } = await import("../src/screens/governed-review-task.js");
    const html = renderToStaticMarkup(createElement(BlindTaskEvidence, { artifact }));

    expect(html).toContain("Groundedness");
    expect(html).toContain("Use only the frozen evidence.");
    expect(html).toContain("Thirty days.");
    expect(html).toContain("exact-canonical-view");
    expect(html).toContain(artifact.viewDigest);
    expect(html).not.toContain("golden label");
    expect(html).not.toContain("peer label");
  });

  it("never renders evaluator evidence for a sealed post-barrier item", async () => {
    const { PostBarrierEvidence } = await import("../src/screens/human-truth-resolution.js");
    const item: GovernedPostBarrierItem = {
      batchId: "batch_1",
      reviewItemId: "batch_item_1",
      criterion: { criterionVersionId: "criterion_version_1", name: "Groundedness", definition: "Use evidence." },
      instruction: { instructionVersionId: "instruction_1", title: "Review", instructions: "Review it.", failureCodeGuidance: "" },
      payloadSnapshot: { input: { q: "Refund?" }, output: { a: "Thirty days" } },
      roleIntent: null,
      labels: [{
        labelId: "label_1",
        reviewerSubjectId: "subject_alpha",
        value: "fail",
        rationale: "The response lacks support.",
        failureCodes: ["missing_support"],
        active: true
      }],
      resolution: { status: null, referenceLabel: null, basis: "conflict" },
      adjudicationHeadId: null,
      evaluatorEvidence: { label: "SECRET_EVALUATOR_LABEL", rationale: "SECRET_EVALUATOR_REASON", digest: sha("e") },
      alignmentVersion: 0,
      raw: {}
    };

    const html = renderToStaticMarkup(createElement(PostBarrierEvidence, { item, sealed: true }));
    expect(html).toContain("The response lacks support.");
    expect(html).toContain("Evaluator evidence is never shown for sealed review");
    expect(html).not.toContain("SECRET_EVALUATOR_LABEL");
    expect(html).not.toContain("SECRET_EVALUATOR_REASON");
  });
});
