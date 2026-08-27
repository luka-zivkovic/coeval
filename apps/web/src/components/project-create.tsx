import { useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Eyebrow } from "@/components/coeval";
import { CHOOSE_TASK_ERROR, NAME_REQUIRED_ERROR, PROJECT_TASK_COPY, ProjectTaskFields } from "@/components/project-task";
import { ApiError, createProject, selectProject } from "@/lib/api";
import { copyTextToClipboard } from "@/lib/clipboard";
import { firstRunEditorPath, rememberFirstProjectKey } from "@/lib/journey";
import { useDialogFocus } from "@/hooks/use-dialog-focus";
import type { CreatedApiKey, ProjectMode } from "@coeval/shared";

// P0-2 — project creation. One agent, one stream of traces, one judging
// skill. Used as a modal from the sidebar switcher and as the full-page
// landing when the account has no project (the post-deletion state).
//
// Skill Bench: creation forks on the evidence source. Trace-based projects
// listen to a tracer; bench projects run the skill over example datasets —
// no tracing infra required. Both paths are full-size choices (parity, not
// pity): the no-infra path must never read as the lesser product.

function useCreateProject(onCreated?: () => void) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<ProjectMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingProject, setPendingProject] = useState<{ projectId: string; apiKey: CreatedApiKey } | null>(null);

  async function submit() {
    // Enter in the name field bypasses the disabled button — without this
    // guard a second Enter mid-flight fires a duplicate POST /api/projects.
    if (busy) return;
    if (!mode) {
      setError(CHOOSE_TASK_ERROR);
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      setError(NAME_REQUIRED_ERROR);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { projectId, apiKey } = await createProject(trimmed, mode);
      // Storage unavailable (private mode): the key was minted server-side
      // and this is the only moment its plaintext exists client-side — show
      // it once, right here, instead of navigating into a UI that will never
      // be able to display it. Do not switch the API context until the user
      // acknowledges the key, or the old dashboard would issue requests for
      // the newly-created project while this notice is still on screen.
      if (apiKey && !rememberFirstProjectKey(projectId, apiKey)) {
        setPendingProject({ projectId, apiKey });
        setBusy(false);
        return;
      }
      selectProject(projectId);
      if (onCreated) onCreated();
      // Full reload: every cached surface must re-resolve against the new
      // project. Start in Act 1 with a concrete worked rubric, not a blank
      // schema dashboard.
      window.location.assign(firstRunEditorPath());
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 501
          ? "Project creation isn't available in demo mode."
          : err instanceof Error
            ? err.message
            : "Project creation failed."
      );
      setBusy(false);
    }
  }

  function continueAfterSavingKey() {
    if (!pendingProject) return;
    selectProject(pendingProject.projectId);
    window.location.assign(firstRunEditorPath());
  }

  return { name, setName, mode, setMode, busy, error, submit, pendingProject, continueAfterSavingKey };
}

function createCta(mode: ProjectMode | null, busy: boolean): string {
  if (!mode) return "Create";
  return busy ? PROJECT_TASK_COPY[mode].busyCta : PROJECT_TASK_COPY[mode].cta;
}

// Rendered only when sessionStorage is unavailable: the one moment this
// active credential's plaintext exists client-side. Copy, then continue
// (the button renders only where this notice is the whole screen).
export function OneTimeKeyNotice({ apiKey, onContinue }: { apiKey: CreatedApiKey; onContinue?: () => void }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2 rounded-sm border border-gold-tint bg-ambig-bg px-3 py-2.5">
      <div className="text-[12.5px] font-medium text-ink">Copy your project API key now</div>
      <div className="text-[11.5px] leading-[1.5] text-ink-3">
        The project was created and this key is live, but your browser blocks the storage that would show it
        again on the next screen. Only its hash is stored server-side — this is the one time it can be shown.
      </div>
      <div className="flex items-center gap-2 rounded-sm border border-rule bg-card px-2.5 py-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[11px] text-ink">{apiKey.key}</code>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setCopyError(null);
            copyTextToClipboard(apiKey.key).then(() => setCopied(true)).catch((err) => {
              setCopyError(err instanceof Error ? err.message : String(err));
            });
          }}
        >
          {copied ? "Copied" : "Copy key"}
        </Button>
      </div>
      {copyError ? <div role="alert" className="text-[11px] text-signal">{copyError}</div> : null}
      {onContinue ? (
        <Button variant="primary" className="self-start" onClick={onContinue}>
          I saved it — continue
        </Button>
      ) : null}
    </div>
  );
}

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const {
    name,
    setName,
    mode,
    setMode,
    busy,
    error,
    submit,
    pendingProject,
    continueAfterSavingKey
  } = useCreateProject();
  const dismissible = pendingProject === null;
  const dialogRef = useDialogFocus<HTMLDivElement>({
    onClose,
    closeOnEscape: dismissible && !busy
  });
  // Portaled to <body>: this modal is mounted inside the sidebar's
  // ProjectSwitcher, and the sidebar is position:sticky — a stacking context
  // that traps the fixed z-50 overlay UNDER the main column, so dashboard
  // cards painted over the modal. A portal escapes the sidebar's context.
  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-project-title"
      tabIndex={-1}
      className="fixed inset-0 z-50 grid place-items-start overflow-y-auto bg-ink/30 p-4 fadeUp sm:place-items-center"
      onClick={(event) => {
        if (dismissible && !busy && event.target === event.currentTarget) onClose();
      }}
    >
      <Card className="max-h-[calc(100dvh-2rem)] w-full max-w-full overflow-y-auto shadow-[var(--shadow-elev)] sm:w-[560px]" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <div>
            <CardTitle id="new-project-title">Start another evaluation</CardTitle>
            <CardDescription>Choose whether this project will evaluate live traces or supplied examples. Coeval configures the project for that workflow.</CardDescription>
          </div>
          <div className="flex-1" />
          {dismissible ? (
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close project creation">
              <X />
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-3.5">
          {pendingProject ? (
            <OneTimeKeyNotice apiKey={pendingProject.apiKey} onContinue={continueAfterSavingKey} />
          ) : (
            <>
              <ProjectTaskFields mode={mode} setMode={setMode} name={name} setName={setName} onEnter={() => void submit()} />
              {error ? <div role="alert" className="font-mono text-[11px] text-signal">{error}</div> : null}
              <div className="flex gap-2">
                <Button variant="ghost" onClick={onClose} disabled={busy}>
                  Cancel
                </Button>
                <div className="flex-1" />
                <Button variant="primary" disabled={busy || !mode || !name.trim()} onClick={() => void submit()}>
                  {createCta(mode, busy)}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>,
    document.body
  );
}

// Full-page landing for an account with zero project memberships — the only
// way forward is to create one, so say so instead of a dead "retry" shell.
export function NoProjectLanding() {
  const {
    name,
    setName,
    mode,
    setMode,
    busy,
    error,
    submit,
    pendingProject,
    continueAfterSavingKey
  } = useCreateProject();
  return (
    <div className="fadeUp mx-auto mt-[12vh] max-w-[520px]">
      <Eyebrow>First evaluation</Eyebrow>
      <div className="mt-2 font-serif text-[26px] font-medium leading-[1.12] tracking-[-0.02em]">
        What do you want Coeval to judge?
      </div>
      <div className="mt-2.5 text-[13px] leading-[1.55] text-ink-3">
        Pick the job. Coeval creates the matching workspace and starter judging skill for you.
      </div>
      <Card className="mt-5">
        <CardContent className="flex flex-col gap-3.5 py-4">
          {pendingProject ? (
            <OneTimeKeyNotice apiKey={pendingProject.apiKey} onContinue={continueAfterSavingKey} />
          ) : (
            <>
              <ProjectTaskFields mode={mode} setMode={setMode} name={name} setName={setName} onEnter={() => void submit()} />
              {error ? <div className="font-mono text-[11px] text-signal">{error}</div> : null}
              <Button variant="primary" disabled={busy || !mode || !name.trim()} onClick={() => void submit()}>
                {createCta(mode, busy)}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
