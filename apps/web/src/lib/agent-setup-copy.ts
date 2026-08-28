import type { CreatedAgentSetupPairing } from "@coeval/shared";

export const AGENT_SETUP_PREPARATION_PROMPT = `Use the $coeval-setup skill to help me set up Coeval for this repository. If it is unavailable, read https://github.com/luka-zivkovic/coeval/blob/main/skills/coeval-setup/SKILL.md before acting.

Inspect safe, relevant project text before asking me to repeat context. Tell me what AI system and recorded Run evidence you found, then ask one short decision-changing question. Show a proposed Check with what it decides, the exact evidence it reads, what it cannot know, and its Review guide. Keep it Starter · unvalidated.

Offer “Finish setup” or “Refine the Check.” Do not ask me to create a Coeval connection until I choose Finish setup. Never read .env or credential files, invent a Run, make a human judgment, promote a Golden example, or make a release decision.`;

export function buildAgentPairingPrompt(pairing: CreatedAgentSetupPairing) {
  return `Finish the approved Coeval setup for this project.

Coeval API: ${pairing.apiBaseUrl}
Project: ${pairing.projectName}
Owner email: ${pairing.ownerEmail}
One-time pairing token: ${pairing.token}

Use the $coeval-setup skill (or read https://github.com/luka-zivkovic/coeval/blob/main/skills/coeval-setup/SKILL.md if it is unavailable). Apply the exact Check proposal I reviewed; if no proposal has been reviewed yet, pause and complete its short context-first preparation flow before using this connection. Use the coeval-audit transport for ongoing capture and submission. Provide the token through COEVAL_PAIRING_TOKEN; never write it into setup files or repeat it in output. Submit a first batch only when a real Run is already available. Report the Check as Starter · unvalidated, and stop before human adjudication, Golden promotion, governed activation, or release decisions.

This connection expires at ${pairing.expiresAt} and can be used once.`;
}
