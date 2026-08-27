import { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import {
  AGENT_CONNECT_BOUNDARY_LINE,
  AGENT_CONNECT_KEY_PLACEHOLDER,
  buildAgentConnectSnippets,
  type AgentConnectSnippets
} from "@coeval/shared";
// Relative .js imports (not the @/ alias) so the root vitest run can resolve
// this component the same way markdown-preview.tsx is tested.
import { Button } from "./ui/button.js";
import { publicApiBaseUrl } from "../lib/api.js";
import { copyTextToClipboard } from "../lib/clipboard.js";

// Issue #15 — "Connect your agent" at the key-mint moment. `apiKey` is the
// just-minted plaintext still in client state (the only moment it exists);
// null renders the same panel with the <your key> placeholder for every
// later visit, after the one-time window has closed.
export function ConnectAgentPanel({ apiKey }: { apiKey: string | null }) {
  const snippets = useMemo(
    () => buildAgentConnectSnippets({ apiBaseUrl: publicApiBaseUrl(), ...(apiKey ? { apiKey } : {}) }),
    [apiKey]
  );
  const [copied, setCopied] = useState<keyof AgentConnectSnippets | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  async function copy(kind: keyof AgentConnectSnippets) {
    setCopyError(null);
    try {
      await copyTextToClipboard(snippets[kind]);
      setCopied(kind);
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="rounded-sm border border-rule-soft bg-card-2 p-3">
      <div className="text-[13px] font-medium text-ink">Connect your agent</div>
      <p className="mt-1 text-[12px] leading-[1.55] text-ink-2">{AGENT_CONNECT_BOUNDARY_LINE}</p>
      {apiKey ? null : (
        <p className="mt-1 text-[11.5px] leading-[1.5] text-ink-3">
          Replace {AGENT_CONNECT_KEY_PLACEHOLDER} with a project key — the full key is only shown
          once, when it is created above.
        </p>
      )}
      <div className="mt-3 flex flex-col gap-3">
        <Snippet
          label="Claude Code"
          detail="One line; point node at your Coeval checkout."
          value={snippets.claudeCode}
          copied={copied === "claudeCode"}
          onCopy={() => void copy("claudeCode")}
        />
        <Snippet
          label="Any MCP client (mcp.json)"
          detail="Paste into your client's MCP server config."
          value={snippets.mcpJson}
          copied={copied === "mcpJson"}
          onCopy={() => void copy("mcpJson")}
        />
        <Snippet
          label="Plain CLI"
          detail="No MCP harness — the bundled coeval-submit script reads findings and submits runs."
          value={snippets.cli}
          copied={copied === "cli"}
          onCopy={() => void copy("cli")}
        />
      </div>
      {copyError ? <p className="mt-2 text-[11.5px] text-signal">{copyError}</p> : null}
    </div>
  );
}

function Snippet({
  label,
  detail,
  value,
  copied,
  onCopy
}: {
  label: string;
  detail: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-2">{label}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-3">{detail}</span>
        <Button size="sm" variant="ghost" onClick={onCopy}>
          {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="mt-1 overflow-x-auto rounded-sm border border-rule-soft bg-card px-2.5 py-2">
        <code className="font-mono text-[11px] leading-[1.6] text-ink">{value}</code>
      </pre>
    </div>
  );
}
