import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AgentSetupPairingCard } from "@/components/agent-setup-pairing";
import { Eyebrow } from "@/components/coeval";
import { CHOOSE_TASK_ERROR, NAME_REQUIRED_ERROR, ProjectTaskFields } from "@/components/project-task";
import { OneTimeKeyNotice } from "@/components/project-create";
import { setupOwner } from "@/lib/api";
import { firstRunEditorPath, rememberFirstProjectKey } from "@/lib/journey";
import type { CreatedApiKey, ProjectMode } from "@coeval/shared";

export function SetupScreen({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<ProjectMode | null>(null);
  const [projectName, setProjectName] = useState("");
  const [busy, setBusy] = useState(false);
  const [ownerCreated, setOwnerCreated] = useState(false);
  const [unsavedKey, setUnsavedKey] = useState<CreatedApiKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Native form submit (Enter in any field) bypasses the disabled button —
    // guard against a duplicate owner-creation call mid-flight.
    if (busy) return;
    setError(null);
    if (!mode) {
      setError(CHOOSE_TASK_ERROR);
      return;
    }
    if (!projectName.trim()) {
      setError(NAME_REQUIRED_ERROR);
      return;
    }
    setBusy(true);
    try {
      const created = await setupOwner({
        email,
        password,
        mode,
        projectName: projectName.trim(),
        ...(name ? { name } : {})
      });
      // Both fields are null-tolerant: by now the owner, workspace, and
      // session exist server-side, so this path must reach ownerCreated no
      // matter what shape the response body took. A key that couldn't be
      // stored (private mode) is shown once inline instead.
      if (created.projectId && created.apiKey && !rememberFirstProjectKey(created.projectId, created.apiKey)) {
        setUnsavedKey(created.apiKey);
      }
      setOwnerCreated(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  if (ownerCreated) {
    return (
      <div className="min-h-screen grid place-items-center px-6 py-8">
        <div className="flex w-full max-w-[680px] flex-col gap-4">
          {unsavedKey ? <OneTimeKeyNotice apiKey={unsavedKey} /> : null}
          <AgentSetupPairingCard
            onContinue={onDone}
            onManualContinue={() => window.location.assign(firstRunEditorPath())}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen grid place-items-center px-6">
      <Card className="w-full max-w-[680px]">
        <CardHeader className="flex-col items-start gap-1.5">
          <CardTitle className="text-[20px]">What do you want to judge first?</CardTitle>
          <CardDescription>Choose whether you want to evaluate live traces or supplied examples. Coeval creates the first project with your owner account.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
            <ProjectTaskFields mode={mode} setMode={setMode} name={projectName} setName={setProjectName} />
            <Eyebrow className="mt-2">Owner account</Eyebrow>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" />
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" type="email" required />
            <Input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" type="password" required />
            {error ? <p className="text-[12px] text-signal">{error}</p> : null}
            <Button type="submit" variant="primary" className="mt-1 self-start" disabled={busy || !mode || !projectName.trim()}>
              <ShieldCheck /> {busy ? "Creating…" : "Create workspace and owner"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
