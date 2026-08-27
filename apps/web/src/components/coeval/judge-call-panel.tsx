import * as React from "react";
import { Copy } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useMode } from "@/hooks/use-mode";
import { cn } from "@/lib/utils";

export interface JudgeCallMeta {
  requestedModelLabel?: string | undefined;
  skillVersion?: string | undefined;
  observedModel?: string | null | undefined;
  requestId?: string | null | undefined;
  responseId?: string | null | undefined;
  systemFingerprint?: string | null | undefined;
  temperature?: number | undefined;
  latencyMs?: number | undefined;
  tokensTotal?: number | undefined;
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
  costUsd?: number | undefined;
}

export interface JudgeCallPanelProps {
  meta: JudgeCallMeta;
  compiledPrompt?: string | undefined;
  rawRequest?: string | undefined;
  rawResponse?: string | undefined;
}

type OpenSection = "prompt" | "request" | "response" | null;

export function JudgeCallPanel({ meta, compiledPrompt, rawRequest, rawResponse }: JudgeCallPanelProps) {
  const [mode] = useMode();
  const isDev = mode === "dev";
  const [open, setOpen] = React.useState<OpenSection>(null);

  const summary: Array<string> = [];
  if (meta.requestedModelLabel) summary.push(`requested ${meta.requestedModelLabel}`);
  if (meta.observedModel !== undefined) summary.push(`observed ${meta.observedModel ?? "model unavailable"}`);
  if (meta.requestId !== undefined) summary.push(`request ${meta.requestId ?? "id unavailable"}`);
  if (meta.responseId !== undefined) summary.push(`response ${meta.responseId ?? "id unavailable"}`);
  if (meta.systemFingerprint !== undefined) summary.push(`fingerprint ${meta.systemFingerprint ?? "unavailable"}`);
  if (meta.skillVersion) summary.push(`skill v${meta.skillVersion}`);
  if (meta.temperature !== undefined) summary.push(`temp ${meta.temperature}`);
  if (meta.latencyMs !== undefined) summary.push(`${(meta.latencyMs / 1000).toFixed(1)}s`);
  if (meta.tokensTotal !== undefined) summary.push(`${meta.tokensTotal.toLocaleString()} tokens`);
  if (meta.costUsd !== undefined) summary.push(`$${meta.costUsd.toFixed(4)}`);

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Judge call</CardTitle>
          <CardDescription>Inspect the model settings, compiled prompt, and raw evaluator input and output for this result.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        {summary.length ? (
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11.5px] text-ink-2">
            {summary.map((piece, i) => (
              <React.Fragment key={`${piece}-${i}`}>
                {i > 0 ? <span className="text-ink-3">·</span> : null}
                <span className={i === summary.length - 1 ? "text-ink-3" : ""}>{piece}</span>
              </React.Fragment>
            ))}
          </div>
        ) : (
          <div className="font-mono text-[11.5px] text-ink-3">No call meta available.</div>
        )}

        <div className="mt-1 flex flex-col gap-1.5">
          {compiledPrompt ? (
            <JudgeDisclosure
              label="View compiled prompt"
              open={open === "prompt"}
              onToggle={() => setOpen(open === "prompt" ? null : "prompt")}
              meta={
                meta.tokensIn !== undefined
                  ? `${meta.tokensIn.toLocaleString()} input tokens · rubric + this conversation, interpolated`
                  : "Rubric + this conversation, interpolated"
              }
              content={compiledPrompt}
            />
          ) : null}

          {isDev && rawRequest ? (
            <JudgeDisclosure
              label="View raw request"
              dev
              open={open === "request"}
              onToggle={() => setOpen(open === "request" ? null : "request")}
              meta="HTTP POST · what we sent to the provider"
              content={rawRequest}
            />
          ) : null}

          {isDev && rawResponse ? (
            <JudgeDisclosure
              label="View raw response"
              dev
              open={open === "response"}
              onToggle={() => setOpen(open === "response" ? null : "response")}
              meta={
                meta.tokensOut !== undefined
                  ? `HTTP 200 · ${meta.tokensOut} output tokens · before parse`
                  : "HTTP 200 · before parse"
              }
              content={rawResponse}
            />
          ) : null}

          {!isDev && (rawRequest || rawResponse) ? (
            <div className="mt-1 font-mono text-[10.5px] tracking-[0.04em] text-ink-3">
              Raw request &amp; response available in Technical display.
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

interface JudgeDisclosureProps {
  label: string;
  meta: string;
  open: boolean;
  onToggle: () => void;
  dev?: boolean;
  content: string;
}

function JudgeDisclosure({ label, meta, open, onToggle, dev, content }: JudgeDisclosureProps) {
  return (
    <div className={cn("rounded-sm border border-rule-soft", open && "bg-card-2")}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left cursor-pointer hover:bg-card-2"
      >
        <span className="font-mono text-[10.5px] text-ink-3">{open ? "▾" : "▸"}</span>
        <span className="text-[12.5px] text-ink-2">
          {label}
          {dev ? (
            <span className="ml-2 inline-block rounded-sm border border-dev px-1 py-px font-mono text-[9.5px] uppercase tracking-[0.08em] text-dev">
              dev
            </span>
          ) : null}
        </span>
        <span className="flex-1" />
        <span className="font-mono text-[10.5px] text-ink-3">{meta}</span>
      </button>
      {open ? (
        <div className="fadeUp border-t border-rule-soft px-3 py-2.5">
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.55] text-ink-2">
            {content}
          </pre>
          <div className="mt-2 flex items-center gap-2">
            <Button variant="ghost" size="xs" onClick={onToggle}>
              Collapse
            </Button>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                void navigator.clipboard?.writeText(content);
              }}
            >
              <Copy /> Copy
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
