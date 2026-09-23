import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The panel itself uses relative imports, but its Button dependency reaches
// for the @/ alias, which the root vitest config does not resolve.
vi.mock("@/lib/utils", () => ({
  cn: (...inputs: unknown[]) => inputs.filter(Boolean).join(" ")
}));
import {
  AGENT_CONNECT_BOUNDARY_LINE,
  AGENT_CONNECT_KEY_PLACEHOLDER,
  buildAgentConnectSnippets
} from "@rubrist/shared";
import { ConnectAgentPanel } from "../src/components/connect-agent-panel.js";

// Issue #15 — the same snippet builder feeds Settings → API keys, the
// bootstrap completion response, and the rubrist-audit setup next-steps, so
// the three surfaces cannot drift apart.
describe("buildAgentConnectSnippets", () => {
  it("pre-fills the URL and the fresh key into all three snippet forms", () => {
    const snippets = buildAgentConnectSnippets({
      apiBaseUrl: "https://rubrist.example",
      apiKey: "rubrist_sk_test-fresh-key"
    });

    expect(snippets.claudeCode).toContain("claude mcp add rubrist");
    expect(snippets.claudeCode).toContain("RUBRIST_URL=https://rubrist.example");
    expect(snippets.claudeCode).toContain('RUBRIST_API_KEY="rubrist_sk_test-fresh-key"');
    expect(snippets.claudeCode).toContain("tools/mcp/index.mjs");

    // The mcp.json block must stay valid JSON — it is pasted verbatim.
    const parsed = JSON.parse(snippets.mcpJson) as {
      mcpServers: { rubrist: { command: string; args: string[]; env: Record<string, string> } };
    };
    expect(parsed.mcpServers.rubrist.command).toBe("node");
    expect(parsed.mcpServers.rubrist.args.join(" ")).toContain("tools/mcp/index.mjs");
    expect(parsed.mcpServers.rubrist.env).toEqual({
      RUBRIST_URL: "https://rubrist.example",
      RUBRIST_API_KEY: "rubrist_sk_test-fresh-key"
    });

    expect(snippets.cli).toContain("export RUBRIST_URL=https://rubrist.example");
    expect(snippets.cli).toContain('export RUBRIST_API_KEY="rubrist_sk_test-fresh-key"');
    expect(snippets.cli).toContain("rubrist-submit.mjs findings");
    expect(snippets.cli).toContain("rubrist-submit.mjs submit");
  });

  it("falls back to the <your key> placeholder when no plaintext key exists", () => {
    const snippets = buildAgentConnectSnippets({ apiBaseUrl: "https://rubrist.example/" });
    for (const snippet of [snippets.claudeCode, snippets.mcpJson, snippets.cli]) {
      expect(snippet).toContain(AGENT_CONNECT_KEY_PLACEHOLDER);
      expect(snippet).not.toContain("rubrist_sk_");
      // Trailing slash on the base URL must not produce https://host//api forms.
      expect(snippet).toContain("https://rubrist.example");
      expect(snippet).not.toContain("https://rubrist.example/\"");
    }
    // The shell forms quote the key slot, so pasting the placeholder form
    // unedited can never reach the shell as `<your key>` redirection.
    expect(snippets.claudeCode).toContain(`RUBRIST_API_KEY="${AGENT_CONNECT_KEY_PLACEHOLDER}"`);
    expect(snippets.cli).toContain(`export RUBRIST_API_KEY="${AGENT_CONNECT_KEY_PLACEHOLDER}"`);
  });
});

describe("ConnectAgentPanel", () => {
  it("shows the governance boundary line and key-pre-filled snippets at the mint moment", () => {
    const html = renderToStaticMarkup(
      createElement(ConnectAgentPanel, { apiKey: "rubrist_sk_just-minted" })
    );
    expect(html).toContain(AGENT_CONNECT_BOUNDARY_LINE);
    // All three snippet forms carry the fresh key.
    expect(html.split("rubrist_sk_just-minted").length - 1).toBeGreaterThanOrEqual(3);
    expect(html).toContain("claude mcp add rubrist");
    expect(html).toContain("mcpServers");
    expect(html).toContain("rubrist-submit.mjs findings");
  });

  it("renders the placeholder form after the one-time window, never a real key", () => {
    const html = renderToStaticMarkup(createElement(ConnectAgentPanel, { apiKey: null }));
    expect(html).toContain(AGENT_CONNECT_BOUNDARY_LINE);
    // JSX escapes angle brackets, so the placeholder arrives entity-encoded.
    expect(html).toContain("&lt;your key&gt;");
    expect(html).not.toContain("rubrist_sk_");
  });
});
