import { useCallback, useEffect, useState } from "react";
import { Plug, Plus, RefreshCcw, Trash2, Wifi, WifiOff } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Chip, Eyebrow, SectionHead } from "@/components/coeval";
import {
  createLangfuseIntegration,
  createLangSmithIntegration,
  deleteLangfuseIntegration,
  deleteLangSmithIntegration,
  fetchLangfuseIntegrations,
  fetchLangSmithIntegrations,
  testLangfuseIntegration,
  testLangSmithIntegration,
  triggerLangfuseImport,
  triggerLangSmithImport,
  updateLangfuseIntegration,
  updateLangSmithIntegration
} from "@/lib/api";
import { useDashboard } from "@/lib/dashboard-context";
import { dashboardSkillVersionId } from "@/lib/criterion-scope";
import { cn } from "@/lib/utils";
import { useDialogFocus } from "@/hooks/use-dialog-focus";
import type { LangfuseIntegration, LangSmithIntegration } from "@coeval/shared";

type TraceIntegration = LangSmithIntegration | LangfuseIntegration;
type Provider = TraceIntegration["provider"];

export function IntegrationsScreen() {
  const { dashboard } = useDashboard();
  const skillVersionId = dashboardSkillVersionId(dashboard);
  const [integrations, setIntegrations] = useState<TraceIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState<Provider | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [langSmith, langfuse] = await Promise.all([
        fetchLangSmithIntegrations(),
        fetchLangfuseIntegrations()
      ]);
      setIntegrations([...langSmith, ...langfuse].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="fadeUp max-w-[1760px]">
      <SectionHead
        eyebrow="Trace connections"
        title="Integrations"
        sub="Connect the tracing platform that already records your runs. Coeval imports those traces for evaluation and can send recorded verdicts back as feedback."
        right={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCcw /> Refresh
            </Button>
            <Button variant="default" size="sm" onClick={() => setShowAdd("langfuse")}>
              <Plus /> Connect Langfuse
            </Button>
            <Button variant="primary" size="sm" onClick={() => setShowAdd("langsmith")}>
              <Plus /> Connect LangSmith
            </Button>
          </div>
        }
      />

      {error ? (
        <Card className="mb-5 border-signal-tint bg-signal-wash">
          <CardContent className="py-3 text-[12px] text-signal">{error}</CardContent>
        </Card>
      ) : null}

      {loading && integrations.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-ink-3">Fetching integrations…</CardContent>
        </Card>
      ) : integrations.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Plug className="mx-auto size-6 text-ink-3" />
            <div className="mt-2 font-serif text-[16px] tracking-[-0.012em] text-ink-2">
              No integrations connected yet.
            </div>
            <div className="mt-1 max-w-[60ch] mx-auto text-[12px] text-ink-3">
              Connect LangSmith or Langfuse to import runs for evaluation. Coeval keeps its review
              records here and can send recorded verdicts back to the tracing platform as feedback.
            </div>
            <Button variant="primary" size="sm" className="mt-4" onClick={() => setShowAdd("langsmith")}>
              <Plus /> Connect LangSmith
            </Button>
            <Button variant="default" size="sm" className="ml-2 mt-4" onClick={() => setShowAdd("langfuse")}>
              <Plus /> Connect Langfuse
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {integrations.map((it) => (
            <IntegrationCard
              key={it.id}
              integration={it}
              skillVersionId={skillVersionId}
              onChanged={() => void load()}
            />
          ))}
        </div>
      )}

      {showAdd ? (
        <AddIntegrationModal
          provider={showAdd}
          skillVersionId={skillVersionId}
          onCancel={() => setShowAdd(null)}
          onCreated={() => {
            setShowAdd(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function IntegrationCard({
  integration,
  skillVersionId,
  onChanged
}: {
  integration: TraceIntegration;
  skillVersionId: string | null;
  onChanged: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [rebinding, setRebinding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const lastResult = integration.lastTestResult;
  const ok = lastResult?.ok ?? false;
  const statusVariant: "pass" | "fail" | "outline" = lastResult
    ? ok
      ? "pass"
      : "fail"
    : "outline";
  const statusLabel = lastResult ? (ok ? "connected" : "error") : "untested";

  const test = async () => {
    setTesting(true);
    setActionError(null);
    try {
      if (integration.provider === "langfuse") await testLangfuseIntegration(integration.id);
      else await testLangSmithIntegration(integration.id);
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  const triggerImport = async () => {
    setImporting(true);
    setActionError(null);
    try {
      if (!skillVersionId) throw new Error("Choose a criterion before importing traces.");
      if (integration.provider === "langfuse") {
        await triggerLangfuseImport(integration.id, integration.pollLimit, skillVersionId);
      } else {
        await triggerLangSmithImport(integration.id, integration.pollLimit, skillVersionId);
      }
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  const remove = async () => {
    const label = integration.provider === "langfuse" ? "Langfuse" : "LangSmith";
    if (!confirm(`Disconnect ${label} integration "${integration.projectName ?? integration.id}"? Past imports are kept.`)) {
      return;
    }
    setRemoving(true);
    setActionError(null);
    try {
      if (integration.provider === "langfuse") await deleteLangfuseIntegration(integration.id);
      else await deleteLangSmithIntegration(integration.id);
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoving(false);
    }
  };

  const rebind = async () => {
    setRebinding(true);
    setActionError(null);
    try {
      if (!skillVersionId) throw new Error("Choose a criterion before changing this integration.");
      if (integration.provider === "langfuse") {
        await updateLangfuseIntegration(integration.id, { skillVersionId });
      } else {
        await updateLangSmithIntegration(integration.id, { skillVersionId });
      }
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setRebinding(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-2">
            <CardTitle>{integration.projectName ?? (integration.provider === "langfuse" ? "Langfuse" : "LangSmith")}</CardTitle>
            <span className="font-mono text-[10.5px] tracking-[0.04em] text-ink-3">
              · {integration.provider}
            </span>
          </div>
          <CardDescription>
            {integration.endpointUrl ?? (integration.provider === "langfuse" ? "https://cloud.langfuse.com" : "https://api.smith.langchain.com")}
          </CardDescription>
        </div>
        <Chip variant={statusVariant}>{statusLabel}</Chip>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-6 py-4 sm:grid-cols-3">
        <div>
          <Eyebrow>Polling</Eyebrow>
          <div className="mt-1 flex items-center gap-1.5 text-[13px]">
            {integration.pollEnabled ? (
              <>
                <Wifi className="size-3 text-ink-2" />
                <span>every {integration.pollIntervalSeconds}s</span>
              </>
            ) : (
              <>
                <WifiOff className="size-3 text-ink-3" />
                <span className="text-ink-3">off</span>
              </>
            )}
          </div>
          <div className="font-mono text-[10.5px] text-ink-3">
            up to {integration.pollLimit} runs per pull
          </div>
        </div>
        <div>
          <Eyebrow>Last tested</Eyebrow>
          <div className="mt-1 font-mono text-[11px] text-ink-2">
            {integration.lastTestedAt
              ? new Date(integration.lastTestedAt).toLocaleString()
              : "never"}
          </div>
          {lastResult ? (
            <div className={cn("font-mono text-[10.5px]", ok ? "text-ink-3" : "text-signal")}>
              {ok
                ? `ok · sampled ${lastResult.sampleRunCount ?? "—"} runs`
                : lastResult.error ?? "error"}
            </div>
          ) : null}
        </div>
        <div>
          <Eyebrow>Connected</Eyebrow>
          <div className="mt-1 font-mono text-[11px] text-ink-2">
            {new Date(integration.createdAt).toLocaleDateString()}
          </div>
        </div>
      </CardContent>
      <div className="flex flex-wrap items-center gap-2 border-t border-rule-soft px-[18px] py-3">
        <Button variant="ghost" size="sm" onClick={() => void test()} disabled={testing}>
          {testing ? "Testing…" : "Test connection"}
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={() => void triggerImport()}
          disabled={importing || !skillVersionId}
          title={skillVersionId ? "Import with the selected criterion's evaluator" : "Choose a criterion first"}
        >
          {importing ? "Enqueuing…" : "Import now"}
        </Button>
        {skillVersionId && integration.skillVersionId !== skillVersionId ? (
          <Button variant="ghost" size="sm" onClick={() => void rebind()} disabled={rebinding}>
            {rebinding ? "Updating…" : "Use selected criterion for polling"}
          </Button>
        ) : integration.skillVersionId === skillVersionId && skillVersionId ? (
          <span className="font-mono text-[10.5px] text-ink-3">polling selected criterion</span>
        ) : null}
        <div className="flex-1" />
        {actionError ? <span className="text-[11.5px] text-signal">{actionError}</span> : null}
        <Button variant="ghost" size="sm" onClick={() => void remove()} disabled={removing}>
          <Trash2 /> {removing ? "Disconnecting…" : "Disconnect"}
        </Button>
      </div>
    </Card>
  );
}

function AddIntegrationModal({
  provider,
  skillVersionId,
  onCancel,
  onCreated
}: {
  provider: Provider;
  skillVersionId: string | null;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [projectName, setProjectName] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isLangfuse = provider === "langfuse";
  const label = isLangfuse ? "Langfuse" : "LangSmith";

  const canSubmit = !submitting && skillVersionId !== null && (
    isLangfuse
      ? publicKey.trim().length > 0 && secretKey.trim().length > 0
      : apiKey.trim().length > 0
  );
  const dialogRef = useDialogFocus<HTMLDivElement>({ onClose: onCancel, closeOnEscape: !submitting });

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      if (isLangfuse) {
        await createLangfuseIntegration({
          skillVersionId: skillVersionId ?? undefined,
          publicKey: publicKey.trim(),
          secretKey: secretKey.trim(),
          ...(endpointUrl.trim() ? { endpointUrl: endpointUrl.trim() } : {})
        });
      } else {
        await createLangSmithIntegration({
          skillVersionId: skillVersionId ?? undefined,
          apiKey: apiKey.trim(),
          ...(projectName.trim() ? { projectName: projectName.trim() } : {}),
          ...(endpointUrl.trim() ? { endpointUrl: endpointUrl.trim() } : {})
        });
      }
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-integration-title"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 sm:items-center"
      onClick={(e) => {
        if (!submitting && e.target === e.currentTarget) onCancel();
      }}
    >
      <Card className="max-h-[calc(100dvh-2rem)] w-full max-w-full overflow-y-auto shadow-elev sm:w-[560px]" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <div>
            <CardTitle id="add-integration-title">Connect {label}</CardTitle>
            <CardDescription>
              Add {isLangfuse ? "the Langfuse API keys" : "a LangSmith API key"} for the project you
              want to review. Coeval uses the connection to import traces and send feedback.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isLangfuse ? (
            <>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="integration-public-key" className="eyebrow">Public key</label>
                <input
                  id="integration-public-key"
                  autoFocus
                  data-dialog-initial-focus
                  value={publicKey}
                  onChange={(e) => setPublicKey(e.target.value)}
                  placeholder="pk-lf-..."
                  className="h-9 rounded-sm border border-rule-soft bg-card-2 px-2 font-mono text-[12.5px] text-ink focus-visible:border-ink"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="integration-secret-key" className="eyebrow">Secret key</label>
                <input
                  id="integration-secret-key"
                  type="password"
                  value={secretKey}
                  onChange={(e) => setSecretKey(e.target.value)}
                  placeholder="sk-lf-..."
                  className="h-9 rounded-sm border border-rule-soft bg-card-2 px-2 font-mono text-[12.5px] text-ink focus-visible:border-ink"
                />
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="integration-api-key" className="eyebrow">API key</label>
                <input
                  id="integration-api-key"
                  type="password"
                  autoFocus
                  data-dialog-initial-focus
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="ls__..."
                  className="h-9 rounded-sm border border-rule-soft bg-card-2 px-2 font-mono text-[12.5px] text-ink focus-visible:border-ink"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="integration-project-name" className="eyebrow">
                  Project name <span className="lowercase tracking-normal text-ink-3">(optional)</span>
                </label>
                <input
                  id="integration-project-name"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="atlas-support-prod"
                  className="h-9 rounded-sm border border-rule-soft bg-card-2 px-2 font-mono text-[12.5px] text-ink focus-visible:border-ink"
                />
              </div>
            </>
          )}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="integration-endpoint-url" className="eyebrow">
              Endpoint URL <span className="lowercase tracking-normal text-ink-3">(optional)</span>
            </label>
            <input
              id="integration-endpoint-url"
              value={endpointUrl}
              onChange={(e) => setEndpointUrl(e.target.value)}
              placeholder={isLangfuse ? "https://cloud.langfuse.com" : "https://api.smith.langchain.com"}
              className="h-9 rounded-sm border border-rule-soft bg-card-2 px-2 font-mono text-[12.5px] text-ink focus-visible:border-ink"
            />
          </div>
          {error ? <div role="alert" className="text-[12px] text-signal">{error}</div> : null}
          {!skillVersionId ? (
            <div role="alert" className="text-[12px] text-signal">Choose a criterion before connecting this integration.</div>
          ) : null}
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onCancel} disabled={submitting}>
              Cancel
            </Button>
            <div className="flex-1" />
            <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit}>
              Connect
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
