import { Card, CardContent } from "@/components/ui/card";
import { Eyebrow, SectionHead, ProvChip, VerdictChip } from "@/components/coeval";
import { AgentSetupPairingCard } from "@/components/agent-setup-pairing";
import { FirstRunSetupLedger } from "@/components/first-run-setup-ledger";
import { FirstProjectKeyCard } from "@/components/first-project-key";
import type { DashboardSummary } from "@coeval/shared";

interface DashboardWelcomeProps {
  dashboard: DashboardSummary;
  canPairAgent: boolean;
}

// Overview · day 0 — nothing imported yet. The setup ledger ends at the first
// understandable result; protection and governed comparison come later.
export function DashboardWelcome({ dashboard, canPairAgent }: DashboardWelcomeProps) {
  const { project } = dashboard;

  return (
    <div className="fadeUp max-w-[1760px]">
      <SectionHead
        eyebrow="New project · no runs yet"
        title="Get your first Check result"
        sub="Connect a trace source or paste one recorded run. Choose one thing that matters, then Coeval will show what the Check concludes from that evidence."
      />

      <div className="mt-2 grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,1fr)]">
        <FirstRunSetupLedger dashboard={dashboard} />

        <div className="min-w-0 flex flex-col gap-4">
          <FirstProjectKeyCard project={project} />
          {canPairAgent ? <AgentSetupPairingCard /> : null}

          <Card className="bg-paper-2">
            <CardContent className="py-4">
              <Eyebrow>What "starter" means</Eyebrow>
              <div className="mt-2 font-serif text-[14.5px] leading-[1.6] tracking-[-0.005em] text-ink-2">
                Coeval includes a starter Check so you can see the workflow. Until an owner reviews
                its guide, every Result is provisional—and even sign-off does not show that it agrees
                with people.
              </div>
              <div className="mt-3.5 flex items-center gap-2">
                <ProvChip />
                <span className="font-mono text-[11px] text-ink-4">→</span>
                <VerdictChip verdict="pass" />
                <span className="ml-1 text-[11px] text-ink-4">usable after sign-off · still unvalidated</span>
              </div>
            </CardContent>
          </Card>

          <Card className="border-dashed">
            <CardContent className="py-4">
              <Eyebrow>How Coeval uses your tracing platform</Eyebrow>
              <div className="mt-2 font-serif text-[13.5px] leading-[1.55] tracking-[-0.005em] text-ink-2">
                Coeval imports recorded runs for evaluation and can send Results back to LangSmith
                or Langfuse. It does not run your AI or replace the tracing platform.
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
