import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LogOut, RefreshCcw, Trash2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Chip, Eyebrow, MarginNote, SectionHead } from "@/components/coeval";
import { ConnectAgentPanel } from "@/components/connect-agent-panel";
import {
  createApiKey,
  deleteJudgeKey,
  deleteProject,
  fetchApiKeys,
  fetchJudgeKeys,
  fetchJudgeProviders,
  fetchProjectSettings,
  pruneExpiredTraces,
  revokeApiKey,
  selectProject,
  setJudgeKey,
  updateProjectSettings
} from "@/lib/api";
import { authClient, useSession } from "@/lib/auth-client";
import { forgetFirstProjectKey } from "@/lib/journey";
import { useAppMode } from "@/lib/app-mode";
import { useDialogFocus } from "@/hooks/use-dialog-focus";
import type { ApiKey, CreatedApiKey, JudgeKeyProvider, JudgeProviderKey, ProjectSettings, RetentionPruneResult } from "@coeval/shared";

export function SettingsScreen() {
  const navigate = useNavigate();
  const session = useSession();
  const { demoMode } = useAppMode();
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retentionDraft, setRetentionDraft] = useState<string>("");
  const [savingRetention, setSavingRetention] = useState(false);
  const [retentionMessage, setRetentionMessage] = useState<string | null>(null);
  const [pruning, setPruning] = useState(false);
  const [pruneResult, setPruneResult] = useState<RetentionPruneResult | null>(null);
  const [pruneError, setPruneError] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await fetchProjectSettings();
      setSettings(s);
      setRetentionDraft(s.traceRetentionDays == null ? "" : String(s.traceRetentionDays));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveRetention = async () => {
    if (!settings) return;
    const trimmed = retentionDraft.trim();
    const next = trimmed === "" ? null : Number(trimmed);
    if (next !== null && (!Number.isInteger(next) || next < 1 || next > 3650)) {
      setRetentionMessage("Retention must be between 1 and 3650 days (or blank for indefinite).");
      return;
    }
    setSavingRetention(true);
    setRetentionMessage(null);
    try {
      const updated = await updateProjectSettings({ traceRetentionDays: next });
      setSettings(updated);
      setRetentionMessage("Retention saved.");
    } catch (err) {
      setRetentionMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingRetention(false);
    }
  };

  const runPrune = async () => {
    setPruning(true);
    setPruneResult(null);
    setPruneError(null);
    try {
      const result = await pruneExpiredTraces();
      setPruneResult(result);
    } catch (err) {
      // Scoped to the prune control — the screen's top-level `error` is only
      // for fetchProjectSettings failures. Writing a prune error there would
      // short-circuit the entire screen to the "Could not load settings"
      // fallback even though settings is populated.
      setPruneError(err instanceof Error ? err.message : String(err));
    } finally {
      setPruning(false);
    }
  };

  const signOut = async () => {
    // The one-time project key lives in sessionStorage, which SURVIVES
    // sign-out in the same tab — without this, the next user to sign in here
    // could be shown the previous owner's plaintext bearer key.
    forgetFirstProjectKey();
    await authClient.signOut();
    navigate("/");
  };

  if (loading && !settings) {
    return (
      <div className="fadeUp">
        <SectionHead eyebrow="Workspace admin" title="Loading settings" />
      </div>
    );
  }

  if (error || !settings) {
    return (
      <div className="fadeUp">
        <SectionHead eyebrow="Workspace admin" title="Could not load settings" />
        <Card>
          <CardContent className="text-[13px] text-ink-2">
            {error ?? "Start the API with `pnpm dev:api` and refresh."}
          </CardContent>
        </Card>
      </div>
    );
  }

  const user = session.data?.user;

  return (
    <div className="fadeUp max-w-[1600px]">
      <SectionHead
        eyebrow="Workspace admin"
        title="Settings"
        sub="Review project details, control how long raw trace content is stored, and manage credentials. Everyone can view these settings, but only project owners can change them."
        right={
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCcw /> Refresh
          </Button>
        }
      />

      <Card className="mb-6">
        <CardHeader>
          <div>
            <CardTitle>Project</CardTitle>
            <CardDescription>The project identity used to scope incoming traces and recorded evidence.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-x-6 gap-y-4 py-4 sm:grid-cols-2">
          <Field label="Project name">
            <div className="text-[13px]">{settings.name}</div>
          </Field>
          <Field label="Project id">
            <div className="break-all font-mono text-[11.5px] text-ink-2">{settings.projectId}</div>
          </Field>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <div>
            <CardTitle>Trace retention</CardTitle>
            <CardDescription>
              Choose how long Coeval stores raw trace inputs and outputs. Verdicts and metadata are
              retained after the raw content expires.
            </CardDescription>
          </div>
          <div className="flex-1" />
          <Button variant="primary" size="sm" onClick={() => void runPrune()} disabled={pruning}>
            {pruning ? "Pruning…" : "Apply now"}
          </Button>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-x-6 gap-y-4 py-4 sm:grid-cols-2">
          <Field label="Keep raw I/O for">
            <div className="flex items-baseline gap-2">
              <input
                type="number"
                min={1}
                max={3650}
                value={retentionDraft}
                onChange={(e) => {
                  setRetentionDraft(e.target.value);
                  // Clear the post-save "Retention saved." message as soon as
                  // the user starts editing — otherwise it sits next to an
                  // unsaved draft and reads as if the new value is saved.
                  if (retentionMessage) setRetentionMessage(null);
                }}
                placeholder="indefinite"
                className="h-8 w-24 rounded-sm border border-rule-soft bg-card-2 px-2 font-mono text-[12.5px] text-ink focus-visible:border-ink"
              />
              <span className="text-[12px] text-ink-3">days</span>
              <Button
                variant="default"
                size="sm"
                onClick={() => void saveRetention()}
                disabled={savingRetention}
              >
                {savingRetention ? "Saving…" : "Save"}
              </Button>
            </div>
            <div className="mt-1 text-[11.5px] text-ink-3">
              Blank = keep indefinitely. Older traces are pruned on the nightly sweep.
            </div>
            {retentionMessage ? (
              <div className="mt-1 text-[11.5px] text-ink-2">{retentionMessage}</div>
            ) : null}
          </Field>
          <Field label="Last prune">
            {pruneError ? (
              <div className="text-[12px] text-signal">{pruneError}</div>
            ) : pruneResult ? (
              <>
                <div className="font-mono text-[12px] text-ink-2">just now</div>
                <div className="mt-1 text-[11.5px] text-ink-3">
                  Removed{" "}
                  <span className="font-mono text-ink-2">
                    {pruneResult.deletedCases.toLocaleString()}
                  </span>{" "}
                  cases ·{" "}
                  <span className="font-mono text-ink-2">
                    {pruneResult.deletedRawTraces.toLocaleString()}
                  </span>{" "}
                  raw traces
                  {pruneResult.skippedActiveGoldenCases > 0
                    ? `, skipped ${pruneResult.skippedActiveGoldenCases} active golden`
                    : ""}
                  {pruneResult.skippedImmutableRevisionCases > 0
                    ? `, skipped ${pruneResult.skippedImmutableRevisionCases} immutable evidence`
                    : ""}
                </div>
              </>
            ) : (
              <div className="text-[12px] text-ink-3">Click "Apply now" to prune expired traces.</div>
            )}
          </Field>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <div>
            <CardTitle>Account</CardTitle>
            <CardDescription>The account currently signed in to this workspace.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 py-4">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-full bg-ink text-[14px] font-medium text-paper">
              {(user?.name?.[0] ?? "C").toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="font-serif text-[15px] font-medium tracking-[-0.012em] text-ink">
                {user?.name ?? "Operator"}
              </div>
              <div className="font-mono text-[11px] text-ink-3">{user?.email ?? "—"}</div>
            </div>
            <div className="flex-1" />
            <Chip variant={demoMode ? "outline" : "default"}>{demoMode ? "demo session" : "signed in"}</Chip>
          </div>
          {demoMode ? (
            <div className="text-[12px] text-ink-3">
              Demo mode — no authenticated account. Run Coeval with a Postgres
              <span className="font-mono"> DATABASE_URL</span> for real sign-in and persistence.
            </div>
          ) : (
            <div className="flex gap-2">
              <Button variant="default" size="sm" onClick={() => void signOut()}>
                <LogOut /> Sign out
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <JudgeKeysCard />

      <ApiKeysCard />

      <Card className="border-signal-tint">
        <CardHeader className="border-signal-tint">
          <div>
            <CardTitle className="text-signal">Danger zone</CardTitle>
            <CardDescription>Deleting a project permanently removes its Coeval data.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap items-start justify-between gap-4 py-4">
          <div className="max-w-[62ch]">
            <div className="font-serif text-[15px] font-medium tracking-[-0.008em]">
              Delete this project
            </div>
            <div className="mt-1 text-[12.5px] leading-[1.55] text-ink-3">
              This removes the project's traces, verdicts, queues, and Golden set from Coeval. It
              does not delete raw runs from your tracing platform. You cannot undo this action.
            </div>
          </div>
          <Button variant="signal" size="sm" onClick={() => setShowDelete(true)}>
            <Trash2 /> Delete project
          </Button>
        </CardContent>
      </Card>

      {showDelete ? (
        <DeleteConfirm
          projectName={settings.name}
          onCancel={() => setShowDelete(false)}
          onDeleted={() => {
            // Hard reload, not a soft navigate: every cached surface still
            // holds the dead project's data. The pin is dropped so the
            // server re-resolves — next project, or the create-project
            // landing when this was the last one.
            selectProject(null);
            window.location.assign("/");
          }}
        />
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Eyebrow>{label}</Eyebrow>
      <div className="mt-1">{children}</div>
    </div>
  );
}

// BYO judge provider keys. The paste field CLEARS on save and the raw
// key never renders again — only the masked keyDisplay comes back from the API.
// Provider labels come from the availability endpoint (the same source the
// skill editor renders) so the two surfaces can't drift; this list is only
// the fallback while that request is in flight or failing.
const JUDGE_KEY_PROVIDERS: ReadonlyArray<{ provider: JudgeKeyProvider; label: string }> = [
  { provider: "anthropic", label: "Anthropic" },
  { provider: "openai", label: "OpenAI" },
  { provider: "openrouter", label: "OpenRouter" },
  { provider: "custom", label: "Custom OpenAI-compatible" }
];

function JudgeKeysCard() {
  const [keys, setKeys] = useState<JudgeProviderKey[]>([]);
  const [providerRows, setProviderRows] = useState(JUDGE_KEY_PROVIDERS);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setKeys(await fetchJudgeKeys());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    try {
      // Key slots are the providers that accept a stored credential — i.e.
      // everything the availability endpoint lists except the built-in mock.
      const availability = await fetchJudgeProviders();
      const rows = availability.providers
        .filter((option) => option.credentialSource !== "built_in" && option.provider !== "mock")
        .map((option) => ({ provider: option.provider as JudgeKeyProvider, label: option.label }));
      if (rows.length > 0) setProviderRows(rows);
    } catch {
      // Fallback list already rendered; label freshness is not worth an error.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (provider: JudgeKeyProvider) => {
    const draft = (drafts[provider] ?? "").trim();
    if (!draft) return;
    setBusy(provider);
    setError(null);
    try {
      await setJudgeKey(provider, draft);
      // The raw key leaves the page the moment it is saved.
      setDrafts((current) => ({ ...current, [provider]: "" }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (provider: JudgeKeyProvider) => {
    setBusy(provider);
    setError(null);
    try {
      await deleteJudgeKey(provider);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="mb-5">
      <CardHeader>
        <div>
          <CardTitle>Judge provider keys</CardTitle>
          <CardDescription>
            Coeval uses these keys for evaluator calls in this project. If a saved key is invalid,
            the call fails instead of silently using another provider. Remove the key to use a
            configured platform key when one is available. Saved keys are encrypted and cannot be viewed again.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error ? <div className="text-[12px] text-signal">{error}</div> : null}
        {providerRows.map(({ provider, label }) => {
          const stored = keys.find((key) => key.provider === provider);
          return (
            <div key={provider} className="flex min-w-0 flex-wrap items-center gap-3 rounded-sm border border-rule-soft px-3 py-2.5" data-judge-key-row={provider}>
              <div className="w-32 text-[12px] text-ink">{label}</div>
              {stored ? (
                <>
                  <span className="font-mono text-[12px] text-ink-2">{stored.keyDisplay}</span>
                  <span className="font-mono text-[10.5px] text-ink-3">
                    saved {new Date(stored.createdAt).toLocaleDateString()}
                  </span>
                  <div className="flex-1" />
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder="Paste new key to replace"
                    value={drafts[provider] ?? ""}
                    onChange={(e) => setDrafts((current) => ({ ...current, [provider]: e.target.value }))}
                    className="h-8 w-56 max-w-full min-w-0 rounded-sm border border-rule-soft bg-card-2 px-2 font-mono text-[11.5px] text-ink focus-visible:border-ink"
                  />
                  <Button variant="ghost" size="sm" disabled={busy === provider || !(drafts[provider] ?? "").trim()} onClick={() => void save(provider)}>
                    Replace
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy === provider} onClick={() => void remove(provider)}>
                    <Trash2 /> Remove
                  </Button>
                </>
              ) : (
                <>
                  <span className="text-[12px] text-ink-3">no project key saved</span>
                  <div className="flex-1" />
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder={`Paste your ${provider} API key`}
                    value={drafts[provider] ?? ""}
                    onChange={(e) => setDrafts((current) => ({ ...current, [provider]: e.target.value }))}
                    className="h-8 w-64 max-w-full min-w-0 rounded-sm border border-rule-soft bg-card-2 px-2 font-mono text-[11.5px] text-ink focus-visible:border-ink"
                  />
                  <Button variant="default" size="sm" disabled={busy === provider || !(drafts[provider] ?? "").trim()} onClick={() => void save(provider)}>
                    Save
                  </Button>
                </>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function ApiKeysCard() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [showConnect, setShowConnect] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setKeys(await fetchApiKeys());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const result = await createApiKey(name.trim());
      setCreated(result);
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (apiKeyId: string) => {
    setError(null);
    try {
      await revokeApiKey(apiKeyId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Card className="mb-6">
      <CardHeader>
        <div>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            Call this project's evaluator programmatically:{" "}
            <code className="text-[12px]">POST /api/v1/judge</code> with{" "}
            <code className="text-[12px]">Authorization: Bearer &lt;key&gt;</code>. Coeval records each
            result in the ungoverned verdict ledger used by legacy Reliability diagnostics.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 py-4">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Eyebrow>New key name</Eyebrow>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. ci-pipeline"
              className="mt-1 w-full rounded-md border border-line bg-transparent px-3 py-2 text-[13px]"
            />
          </div>
          <Button size="sm" onClick={create} disabled={creating || !name.trim()}>
            {creating ? "Creating…" : "Create key"}
          </Button>
        </div>

        {created ? (
          <div className="rounded-md border border-signal-tint bg-signal-tint/30 p-3">
            <div className="text-[12.5px] font-medium">Copy this key now — it won't be shown again.</div>
            <code className="mt-1 block break-all text-[12px] text-ink">{created.key}</code>
          </div>
        ) : null}

        {/* Connect your agent (issue #15): while the just-minted plaintext is
            still in client state the snippets arrive pre-filled — the only
            moment that costs nothing. Afterwards the same panel stays
            reachable behind a disclosure, with the <your key> placeholder. */}
        {created ? (
          <ConnectAgentPanel apiKey={created.key} />
        ) : (
          <div>
            <button
              type="button"
              className="inline-flex min-h-6 cursor-pointer items-center text-[12.5px] text-ink-2 underline"
              onClick={() => setShowConnect((current) => !current)}
            >
              {showConnect ? "Hide agent setup" : "Connect your agent"}
            </button>
            {showConnect ? (
              <div className="mt-2">
                <ConnectAgentPanel apiKey={null} />
              </div>
            ) : null}
          </div>
        )}

        {error ? <div className="text-[12.5px] text-signal">{error}</div> : null}

        {loading ? (
          <div className="text-[12.5px] text-ink-3">Loading keys…</div>
        ) : keys.length === 0 ? (
          <div className="text-[12.5px] text-ink-3">No API keys yet.</div>
        ) : (
          <div className="flex flex-col divide-y divide-line">
            {keys.map((key) => (
              <div key={key.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">
                    {key.name}{" "}
                    {key.revokedAt ? <Chip variant="outline">revoked</Chip> : null}
                  </div>
                  <div className="text-[12px] text-ink-3">
                    <code>{key.keyPrefix}</code> · created {new Date(key.createdAt).toLocaleDateString()}
                    {key.lastUsedAt ? ` · last used ${new Date(key.lastUsedAt).toLocaleDateString()}` : ""}
                  </div>
                </div>
                {key.revokedAt ? null : (
                  <Button variant="ghost" size="sm" onClick={() => revoke(key.id)}>
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DeleteConfirm({
  projectName,
  onCancel,
  onDeleted
}: {
  projectName: string;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim() === projectName;
  const dialogRef = useDialogFocus<HTMLDivElement>({ onClose: onCancel, closeOnEscape: !submitting });

  const submit = async () => {
    if (!matches) return;
    setSubmitting(true);
    setError(null);
    try {
      await deleteProject(projectName);
      onDeleted();
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
      aria-labelledby="delete-project-title"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 sm:items-center"
      onClick={(e) => {
        if (!submitting && e.target === e.currentTarget) onCancel();
      }}
    >
      <Card
        className="max-h-[calc(100dvh-2rem)] w-full max-w-full overflow-y-auto border-signal-tint shadow-elev sm:w-[480px]"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader className="border-signal-tint">
          <div>
            <CardTitle id="delete-project-title" className="text-signal">
              Delete {projectName}?
            </CardTitle>
            <CardDescription>
              All traces, verdicts, queues and golden cases will be removed.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label htmlFor="delete-project-confirmation" className="text-[12.5px] leading-[1.55] text-ink-2">
            Type the project name to confirm.
          </label>
          <input
            id="delete-project-confirmation"
            autoFocus
            data-dialog-initial-focus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={projectName}
            className="h-9 rounded-sm border border-rule-soft bg-card-2 px-2 font-mono text-[12.5px] text-ink focus-visible:border-signal"
          />
          <MarginNote tone="signal" who="Irreversible">
            Deleting removes this project's Coeval review data permanently. It does not delete
            the original runs from your tracing platform.
          </MarginNote>
          {error ? <div role="alert" className="text-[12px] text-signal">{error}</div> : null}
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onCancel} disabled={submitting}>
              Cancel
            </Button>
            <div className="flex-1" />
            <Button
              variant="signal"
              onClick={() => void submit()}
              disabled={!matches || submitting}
            >
              {submitting ? "Deleting…" : "Delete forever"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
