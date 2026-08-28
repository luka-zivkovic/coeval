import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { verdictOutputSchema } from "@coeval/shared";

vi.mock("../src/components/markdown-preview.js", () => ({
  MarkdownPreview: ({ markdown }: { markdown: string }) => markdown
}));
vi.mock("../src/components/ui/button.js", () => ({
  Button: ({ children }: { children?: unknown }) => children
}));
vi.mock("../src/components/ui/card.js", () => ({
  Card: ({ children }: { children?: unknown }) => children,
  CardContent: ({ children }: { children?: unknown }) => children,
  CardDescription: ({ children }: { children?: unknown }) => children,
  CardHeader: ({ children }: { children?: unknown }) => children,
  CardTitle: ({ children }: { children?: unknown }) => children
}));
vi.mock("../src/components/coeval/index.js", () => ({
  Chip: ({ children }: { children?: unknown }) => children,
  Eyebrow: ({ children }: { children?: unknown }) => children,
  MarginNote: ({ children, who }: { children?: unknown; who?: string }) => [who, children],
  SectionHead: ({ eyebrow, title, sub }: { eyebrow?: string; title?: string; sub?: string }) => [eyebrow, title, sub]
}));

import { FirstRunCheckSetup } from "../src/components/first-run-check-setup.js";
import {
  clearOnboardingCheckDraft,
  draftFromStarter,
  loadOnboardingCheckDraft,
  recommendStarterSkill,
  saveOnboardingCheckDraft
} from "../src/lib/onboarding-check.js";
import { findStarterSkill, STARTER_SKILLS } from "../src/lib/starter-skills.js";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); }
  };
}

const taskStarter = findStarterSkill("task-outcome-quality")!;

describe("guided first Check", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("recommends a focused starting question without silently selecting it", () => {
    expect(recommendStarterSkill("Customer support copilot", "bench").id).toBe("support-chat-quality");
    expect(recommendStarterSkill("LangSmith Support Agent", "tracing").id).toBe("support-chat-quality");
    expect(recommendStarterSkill("Internal RAG search", "tracing").id).toBe("rag-faithfulness");
    expect(recommendStarterSkill("My first project", "bench").id).toBe("task-outcome-quality");

    const html = renderToStaticMarkup(createElement(FirstRunCheckSetup, {
      projectName: "Customer support copilot",
      projectMode: "bench",
      evidenceCount: 1,
      starters: STARTER_SKILLS,
      recommendedStarter: findStarterSkill("support-chat-quality")!,
      draft: null,
      refining: false,
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      modelVersion: "2026-04-15",
      baseUrl: "",
      providerReady: true,
      preparingProvider: false,
      canCreate: false,
      submitting: false,
      error: null,
      onChoose: vi.fn(),
      onDecide: vi.fn(),
      onChangeFocus: vi.fn(),
      onRefine: vi.fn(),
      onQuestionChange: vi.fn(),
      onRubricChange: vi.fn(),
      onModelIdChange: vi.fn(),
      onModelVersionChange: vi.fn(),
      onBaseUrlChange: vi.fn(),
      onCreate: vi.fn(),
      onBack: vi.fn(),
      onOpenSettings: vi.fn()
    }));

    expect(html).toContain("What should this Check focus on?");
    expect(html).toContain("Decide for me");
    expect(html).toContain("Support answer quality");
    expect(html).not.toContain("Create this Check");
  });

  it("shows the exact proposal, limits, status, and refinement before creation", () => {
    const draft = draftFromStarter({
      projectId: "proj_1",
      skillId: "skill_1",
      starter: taskStarter,
      decisionSource: "coeval",
      decisionReason: "A broad first Check fits this project."
    });
    const html = renderToStaticMarkup(createElement(FirstRunCheckSetup, {
      projectName: "My project",
      projectMode: "bench",
      evidenceCount: 2,
      starters: STARTER_SKILLS,
      recommendedStarter: taskStarter,
      draft,
      refining: false,
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      modelVersion: "2026-04-15",
      baseUrl: "",
      providerReady: true,
      preparingProvider: false,
      canCreate: true,
      submitting: false,
      error: null,
      onChoose: vi.fn(),
      onDecide: vi.fn(),
      onChangeFocus: vi.fn(),
      onRefine: vi.fn(),
      onQuestionChange: vi.fn(),
      onRubricChange: vi.fn(),
      onModelIdChange: vi.fn(),
      onModelVersionChange: vi.fn(),
      onBaseUrlChange: vi.fn(),
      onCreate: vi.fn(),
      onBack: vi.fn(),
      onOpenSettings: vi.fn()
    }));

    expect(html).toContain(draft.qualityQuestion.replaceAll("'", "&#x27;"));
    expect(html).toContain("2 saved Runs");
    expect(html).toContain("cannot see missing tool calls");
    expect(html).toContain("Evidence this focus needs");
    expect(html).toContain("Starter · unvalidated");
    expect(html).toContain("Refine it first");
    expect(html).toContain("Create this Check");
    expect(html).toContain("model opinions");
    expect(html).not.toContain("Release threshold");

    const refiningHtml = renderToStaticMarkup(createElement(FirstRunCheckSetup, {
      projectName: "My project",
      projectMode: "bench",
      evidenceCount: 2,
      starters: STARTER_SKILLS,
      recommendedStarter: taskStarter,
      draft,
      refining: true,
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      modelVersion: "2026-04-15",
      baseUrl: "",
      providerReady: true,
      preparingProvider: false,
      canCreate: true,
      submitting: false,
      error: null,
      onChoose: vi.fn(),
      onDecide: vi.fn(),
      onChangeFocus: vi.fn(),
      onRefine: vi.fn(),
      onQuestionChange: vi.fn(),
      onRubricChange: vi.fn(),
      onModelIdChange: vi.fn(),
      onModelVersionChange: vi.fn(),
      onBaseUrlChange: vi.fn(),
      onCreate: vi.fn(),
      onBack: vi.fn(),
      onOpenSettings: vi.fn()
    }));
    expect(refiningHtml).toContain("Create with current draft");
    expect(refiningHtml).toContain("Quality question");
  });

  it("lets a custom-only clean install enter the model identity and endpoint", () => {
    const draft = draftFromStarter({
      projectId: "proj_custom",
      skillId: "skill_custom",
      starter: taskStarter,
      decisionSource: "user"
    });
    const html = renderToStaticMarkup(createElement(FirstRunCheckSetup, {
      projectName: "Custom judge",
      projectMode: "bench",
      evidenceCount: 0,
      starters: STARTER_SKILLS,
      recommendedStarter: taskStarter,
      draft,
      refining: false,
      provider: "custom",
      modelId: "",
      modelVersion: "",
      baseUrl: "",
      providerReady: false,
      preparingProvider: false,
      canCreate: false,
      submitting: false,
      error: null,
      onChoose: vi.fn(),
      onDecide: vi.fn(),
      onChangeFocus: vi.fn(),
      onRefine: vi.fn(),
      onQuestionChange: vi.fn(),
      onRubricChange: vi.fn(),
      onModelIdChange: vi.fn(),
      onModelVersionChange: vi.fn(),
      onBaseUrlChange: vi.fn(),
      onCreate: vi.fn(),
      onBack: vi.fn(),
      onOpenSettings: vi.fn()
    }));
    expect(html).toContain("Custom judge model ID");
    expect(html).toContain("Custom judge model version");
    expect(html).toContain("Custom judge base URL");
    expect(html).toContain("Enter the custom model ID");
  });

  it("stores a verdict-kind-aware output contract for categorical starters", () => {
    const schema = verdictOutputSchema({
      verdictKind: "categorical",
      categoricalChoiceScores: { faithful: 1, unsupported: 0, partial: 0.5 }
    });
    expect(schema).toMatchObject({
      required: ["choice", "rationale"],
      properties: { choice: { enum: ["faithful", "unsupported", "partial"] } }
    });
    expect(JSON.stringify(schema)).not.toContain('"label"');
  });

  it("keeps a refined proposal scoped to the current project and Check", () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    const draft = {
      ...draftFromStarter({
        projectId: "proj_1",
        skillId: "skill_1",
        starter: taskStarter,
        decisionSource: "user"
      }),
      qualityQuestion: "Did the assistant provide a usable, cited answer?",
      rubricMarkdown: "# Cited answer\n\nPass when the answer is usable and cited."
    };

    saveOnboardingCheckDraft(draft);
    expect(loadOnboardingCheckDraft("proj_1", "skill_1")).toEqual(draft);
    expect(draft.requestId).toMatch(/^web-first-check-/);
    expect(loadOnboardingCheckDraft("proj_1", "skill_other")).toBeNull();
    clearOnboardingCheckDraft("proj_1", "skill_1");
    expect(loadOnboardingCheckDraft("proj_1", "skill_1")).toBeNull();
  });
});
