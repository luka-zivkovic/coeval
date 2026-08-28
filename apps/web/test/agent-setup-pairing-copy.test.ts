import { describe, expect, it } from "vitest";
import type { CreatedAgentSetupPairing } from "@coeval/shared";
import {
  AGENT_SETUP_PREPARATION_PROMPT,
  buildAgentPairingPrompt
} from "../src/lib/agent-setup-copy.js";

describe("external agent setup copy", () => {
  it("prepares a context-grounded Check before requesting a secret connection", () => {
    expect(AGENT_SETUP_PREPARATION_PROMPT).toContain("$coeval-setup");
    expect(AGENT_SETUP_PREPARATION_PROMPT).toContain("skills/coeval-setup/SKILL.md");
    expect(AGENT_SETUP_PREPARATION_PROMPT).toContain("Inspect safe, relevant project text");
    expect(AGENT_SETUP_PREPARATION_PROMPT).toContain("one short decision-changing question");
    expect(AGENT_SETUP_PREPARATION_PROMPT).toContain("Finish setup");
    expect(AGENT_SETUP_PREPARATION_PROMPT).toContain("Refine the Check");
    expect(AGENT_SETUP_PREPARATION_PROMPT).toContain("Starter · unvalidated");
    expect(AGENT_SETUP_PREPARATION_PROMPT).not.toContain("pairing token");
  });

  it("binds the approved setup to the one-time project connection", () => {
    const pairing = {
      id: "pair_1",
      projectId: "prj_1",
      status: "pending",
      apiBaseUrl: "https://coeval.example",
      projectName: "Support agent",
      ownerEmail: "owner@example.com",
      token: "coeval_pair_secret",
      expiresAt: "2026-08-28T12:00:00.000Z",
      claimExpiresAt: null
    } satisfies CreatedAgentSetupPairing;

    const prompt = buildAgentPairingPrompt(pairing);
    expect(prompt).toContain("$coeval-setup");
    expect(prompt).toContain("Support agent");
    expect(prompt).toContain("coeval_pair_secret");
    expect(prompt).toContain("exact Check proposal I reviewed");
    expect(prompt).toContain("COEVAL_PAIRING_TOKEN");
    expect(prompt).toContain("real Run");
    expect(prompt).toContain("Starter · unvalidated");
    expect(prompt).toContain("stop before human adjudication");
  });
});
