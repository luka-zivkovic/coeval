import { useEffect, useMemo, useState } from "react";
import { Bot, Check, Copy, Link2, RefreshCcw, X } from "lucide-react";
import type { AgentSetupPairing, CreatedAgentSetupPairing } from "@coeval/shared";
import { Eyebrow } from "@/components/coeval";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  createAgentSetupPairing,
  fetchAgentSetupPairing,
  revokeAgentSetupPairing
} from "@/lib/api";
import { copyTextToClipboard } from "@/lib/clipboard";

export function AgentSetupPairingCard({
  onContinue,
  onManualContinue,
  className
}: {
  onContinue?: () => void;
  onManualContinue?: () => void;
  className?: string;
}) {
  const [pairing, setPairing] = useState<CreatedAgentSetupPairing | AgentSetupPairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pairing || pairing.status === "completed" || pairing.status === "expired" || pairing.status === "revoked") return;
    const timer = window.setInterval(() => {
      void fetchAgentSetupPairing(pairing.id)
        .then((status) => {
          // A transient poll failure must not leave a permanent red error next
          // to a healthy (or completed) pairing — clear it on the next success.
          setError(null);
          setPairing((current) => {
            if (status.status === "completed" || status.status === "expired" || status.status === "revoked") return status;
            return current && "token" in current ? { ...status, token: current.token } : status;
          });
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [pairing?.id, pairing?.status]);

  const prompt = useMemo(() => {
    if (!pairing || !("token" in pairing)) return "";
    return `Help me finish onboarding this project in Coeval.

Coeval API: ${pairing.apiBaseUrl}
Project: ${pairing.projectName}
Owner email: ${pairing.ownerEmail}
One-time pairing token: ${pairing.token}

Use the coeval-audit skill if it is available. Otherwise read https://github.com/luka-zivkovic/coeval/blob/main/skills/coeval-audit/SKILL.md before acting. Inspect the target agent skill's SKILL.md, derive a concrete pass/fail rubric, configure the judge model, mint the project key, and submit a real first batch when one is available. Provide the token through COEVAL_PAIRING_TOKEN; never write it into the setup JSON or repeat it in output. Stop before human adjudication or golden-set promotion.

This connection expires at ${pairing.expiresAt} and can be used once.`;
  }, [pairing]);

  async function generate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setPairing(await createAgentSetupPairing());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!pairing || busy) return;
    setBusy(true);
    setError(null);
    try {
      await revokeAgentSetupPairing(pairing.id);
      setPairing(null);
      setCopied(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copyInstructions() {
    setError(null);
    try {
      await copyTextToClipboard(prompt);
      setCopied(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const completed = pairing?.status === "completed";
  const unavailable = pairing?.status === "expired" || pairing?.status === "revoked";
  const continueManually = onManualContinue ?? onContinue;

  return (
    <Card className={className}>
      <CardHeader className="flex-col items-start gap-1.5">
        <div className="flex w-full items-start justify-between gap-4">
          <div>
            <Eyebrow>Optional · assisted setup</Eyebrow>
            <CardTitle className="mt-1 text-[18px]">Bring in your AI agent</CardTitle>
          </div>
          <div className="grid size-9 shrink-0 place-items-center rounded-full border border-rule bg-paper-2 text-ink-2">
            <Bot className="size-4" />
          </div>
        </div>
        <CardDescription>
          Create a private 15-minute connection for Claude, Codex, or another agent. It can draft the rubric,
          configure the model, and submit the first run in this project.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!pairing ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => void generate()} disabled={busy}>
              <Link2 /> {busy ? "Creating…" : "Create agent connection"}
            </Button>
            {continueManually ? (
              <Button variant="ghost" onClick={continueManually}>I'll set it up myself</Button>
            ) : null}
          </div>
        ) : completed ? (
          <div className="rounded-sm border border-rule bg-paper-2 px-3.5 py-3">
            <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
              <Check className="size-4" /> Agent setup completed
            </div>
            <p className="mt-1 text-[12px] leading-[1.55] text-ink-3">
              The connection is closed. Your agent can now use the project key it minted; exceptions are waiting for human review.
            </p>
            {onContinue ? <Button variant="primary" className="mt-3" onClick={onContinue}>Open the project</Button> : null}
          </div>
        ) : unavailable ? (
          <div className="flex flex-wrap items-center gap-2">
            <div className="mr-auto text-[12px] text-ink-3">This connection {pairing.status}. Generate a fresh one.</div>
            <Button onClick={() => void generate()} disabled={busy}><RefreshCcw /> Generate again</Button>
            {continueManually ? <Button variant="ghost" onClick={continueManually}>Continue manually</Button> : null}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 text-[11px] text-ink-3">
              <span className="font-mono uppercase tracking-[0.08em]">
                {pairing.status === "claimed" ? "Agent connected · setup running" : "Waiting for agent"}
              </span>
              <span>
                {pairing.status === "claimed" && pairing.claimExpiresAt ? "protected until " : "expires "}
                {new Date(
                  pairing.status === "claimed" && pairing.claimExpiresAt ? pairing.claimExpiresAt : pairing.expiresAt
                ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            <pre className="mt-2 max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-rule-soft bg-paper-3 p-3 font-mono text-[10.5px] leading-[1.55] text-ink-2">
              {prompt}
            </pre>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                onClick={() => void copyInstructions()}
              >
                <Copy /> {copied ? "Copied" : "Copy instructions"}
              </Button>
              {pairing.status === "pending" ? (
                <Button variant="ghost" onClick={() => void cancel()} disabled={busy}><X /> Cancel connection</Button>
              ) : null}
              {onContinue ? (
                // Always reachable while the bounded claim-safety window keeps
                // replacement agents from racing the one already connected.
                <Button variant="ghost" onClick={onContinue}>Continue to the project</Button>
              ) : null}
            </div>
            {pairing.status === "claimed" ? (
              <p className="mt-2 text-[11px] leading-[1.5] text-ink-4">
                Your agent is configuring the project. If it stalls, you can create a replacement after the protected
                claim window shown above; you can continue and set things up manually at any time.
              </p>
            ) : null}
            <p className="mt-2 text-[11px] leading-[1.5] text-ink-4">
              Copy these instructions now; the connection secret is not shown again after leaving this screen. Anyone with them can configure this project until it expires. It cannot review exceptions or promote golden cases.
            </p>
          </>
        )}
        {error ? <p className="mt-2 text-[12px] text-signal">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
