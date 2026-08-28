import { Card, CardContent } from "@/components/ui/card";
import { Eyebrow, SectionHead } from "@/components/coeval";
import { AgentSetupPairingCard } from "@/components/agent-setup-pairing";
import { FirstRunSetupLedger } from "@/components/first-run-setup-ledger";
import { FirstProjectKeyCard } from "@/components/first-project-key";
import type { DashboardSummary } from "@coeval/shared";

interface DashboardBenchWelcomeProps {
  dashboard: DashboardSummary;
  canPairAgent: boolean;
}

// Overview · day 0, supplied examples — no runs yet. The beginner chain ends
// at an understandable first result; review, protection, and governed evidence
// remain progressive next steps.
export function DashboardBenchWelcome({ dashboard, canPairAgent }: DashboardBenchWelcomeProps) {
  const { project } = dashboard;

  return (
    <div className="fadeUp max-w-[1760px]">
      <SectionHead
        eyebrow="New project · no runs yet"
        title="Get your first Check result"
        sub="Start with one example of what your AI received and produced. Choose one thing that matters, then Coeval will apply that Check to the recorded run."
      />

      <div className="mt-2 grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,1fr)]">
        <FirstRunSetupLedger dashboard={dashboard} />

        <div className="min-w-0 flex flex-col gap-4">
          <FirstProjectKeyCard project={project} />
          {canPairAgent ? <AgentSetupPairingCard emphasizeAction={false} /> : null}

          <Card className="bg-paper-2">
            <CardContent className="py-4">
              <Eyebrow>What a Result means</Eyebrow>
              <div className="mt-2 font-serif text-[14.5px] leading-[1.6] tracking-[-0.005em] text-ink-2">
                A Result is the Check's opinion about one recorded run. It is not a human decision,
                proof of accuracy, or permission to ship. You can review it and improve the Check later.
              </div>
            </CardContent>
          </Card>

          <Card className="border-dashed">
            <CardContent className="py-4">
              <Eyebrow>What Coeval can see</Eyebrow>
              <div className="mt-2 font-serif text-[13.5px] leading-[1.55] tracking-[-0.005em] text-ink-2">
                Coeval can read the input, output, and recorded steps or tool calls you include. It
                does not execute the AI, replay tools, or verify side effects outside that record.
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
