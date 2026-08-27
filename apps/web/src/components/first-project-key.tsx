import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Copy, Database, KeyRound, Plug, Terminal, X } from "lucide-react";
import type { Project } from "@coeval/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Eyebrow } from "@/components/coeval";
import { copyTextToClipboard } from "@/lib/clipboard";
import { firstProjectKey, forgetFirstProjectKey, isBench } from "@/lib/journey";
import { cn } from "@/lib/utils";
import { publicApiBaseUrl } from "@/lib/api";

export function FirstProjectKeyCard({ project, className }: { project: Project; className?: string }) {
  const navigate = useNavigate();
  const [key] = useState(() => firstProjectKey(project.id));
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState<"key" | "curl" | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const bench = isBench(project);
  const curl = useMemo(() => {
    if (!key) return "";
    return `curl -X POST ${publicApiBaseUrl()}/api/v1/judge/batch \\
  -H "Authorization: Bearer ${key.key}" \\
  -H "Content-Type: application/json" \\
  -d '{"items":[{"sourceTraceId":"first-case","input":{"question":"What should the agent do?"},"output":{"answer":"The result to judge"},"expectedLabel":"pass"}]}'`;
  }, [key]);

  if (!key || dismissed) return null;

  async function copy(value: string, kind: "key" | "curl") {
    setCopyError(null);
    try {
      await copyTextToClipboard(value);
      setCopied(kind);
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : String(error));
    }
  }

  function dismiss() {
    forgetFirstProjectKey();
    setDismissed(true);
  }

  return (
    <Card className={cn("border-gold-tint bg-ambig-bg", className)}>
      <CardHeader className="flex-col items-start gap-1.5">
        <div className="flex w-full items-start justify-between gap-4">
          <div>
            <Eyebrow>Act 2 · judge something real</Eyebrow>
            <CardTitle className="mt-1 text-[18px]">Your first project key</CardTitle>
          </div>
          <Button variant="ghost" size="sm" onClick={dismiss} aria-label="Dismiss first project key">
            <X />
          </Button>
        </div>
        <CardDescription>
          Coeval minted this with the project. Copy it now: the database stores only its hash and prefix, so the full key cannot be shown again.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2 rounded-sm border border-rule bg-card px-2.5 py-2">
          <KeyRound className="size-3.5 shrink-0 text-gold" />
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[11px] text-ink">{key.key}</code>
          <Button size="sm" variant="outline" onClick={() => void copy(key.key, "key")}>
            {copied === "key" ? <Check /> : <Copy />} {copied === "key" ? "Copied" : "Copy key"}
          </Button>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <FirstRunPath
            icon={<Database className="size-3.5" />}
            title={bench ? "Paste JSONL" : "Paste one trace"}
            detail={bench ? "Add labeled examples in the browser." : "Try one real input/output in the browser."}
            action={bench ? "Open Examples" : "Open Traces"}
            onClick={() => navigate(bench ? "/datasets?add=1" : "/traces")}
          />
          <FirstRunPath
            icon={<Terminal className="size-3.5" />}
            title="Call the API"
            detail="Submit a real batch with the pre-filled command."
            action={copied === "curl" ? "Command copied" : "Copy curl"}
            onClick={() => void copy(curl, "curl")}
          />
          <FirstRunPath
            icon={<Plug className="size-3.5" />}
            title="Connect a tracer"
            detail={bench ? "Add production traces later without losing this bench." : "Stream runs from LangSmith or Langfuse."}
            action="Open integrations"
            onClick={() => navigate("/integrations")}
          />
        </div>

        {copyError ? <p className="mt-2 text-[11.5px] text-signal">{copyError}</p> : null}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[10.5px] leading-[1.5] text-ink-4">
          <span>Use the key only with this Coeval instance. It can submit judge runs, but cannot adjudicate or promote golden cases.</span>
          <button type="button" className="inline-flex min-h-6 shrink-0 cursor-pointer items-center underline" onClick={dismiss}>I saved it</button>
        </div>
      </CardContent>
    </Card>
  );
}

// SPA navigation only — a raw <a href> here forces a full page reload in a
// createBrowserRouter app, dropping the dashboard context mid-onboarding.
function FirstRunPath({
  icon,
  title,
  detail,
  action,
  onClick
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="cursor-pointer rounded-sm border border-rule-soft bg-card px-2.5 py-2 text-left hover:border-rule-strong"
      onClick={onClick}
    >
      <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ink">{icon} {title}</span>
      <span className="mt-1 block text-[10.5px] leading-[1.45] text-ink-3">{detail}</span>
      <span className="mt-2 block font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-2">{action} →</span>
    </button>
  );
}
