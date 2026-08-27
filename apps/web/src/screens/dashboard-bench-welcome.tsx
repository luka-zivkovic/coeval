import { Card, CardContent } from "@/components/ui/card";
import { Eyebrow, SectionHead } from "@/components/coeval";
import { AgentSetupPairingCard } from "@/components/agent-setup-pairing";
import { BenchSetupLedger } from "@/components/bench-setup-ledger";
import { FirstProjectKeyCard } from "@/components/first-project-key";
import type { DashboardSummary } from "@coeval/shared";

interface DashboardBenchWelcomeProps {
  dashboard: DashboardSummary;
  canPairAgent: boolean;
}

// Overview · day 0, Skill Bench — no examples yet. The bench chain is skill →
// examples → run → golden; each ledger step names the one action that unblocks
// the next. Same honesty rules as everywhere in bench: the skill under test
// must be a judge, and nothing here implies production coverage.
export function DashboardBenchWelcome({ dashboard, canPairAgent }: DashboardBenchWelcomeProps) {
  const { project } = dashboard;

  return (
    <div className="fadeUp max-w-[1760px]">
      <SectionHead
        eyebrow="Judge a dataset · no examples yet"
        title="Add examples to test your evaluator"
        sub="Add input and output examples with optional expected labels. Run the evaluator to find disagreements, then promote reviewed cases to the Golden set so future edits are checked against them."
      />

      <div className="mt-2 grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,1fr)]">
        <BenchSetupLedger dashboard={dashboard} />

        <div className="min-w-0 flex flex-col gap-4">
          <FirstProjectKeyCard project={project} />
          {canPairAgent ? <AgentSetupPairingCard /> : null}

          <Card className="bg-paper-2">
            <CardContent className="py-4">
              <Eyebrow>How to read bench results</Eyebrow>
              <div className="mt-2 font-serif text-[14.5px] leading-[1.6] tracking-[-0.005em] text-ink-2">
                Results show how the evaluator handled the examples you chose and whether a later
                edit changes those results. They do not estimate production quality. If you connect
                a tracer later, the evaluator, version history, and Golden set remain available.
              </div>
            </CardContent>
          </Card>

          <Card className="border-dashed">
            <CardContent className="py-4">
              <Eyebrow>Limits of bench results</Eyebrow>
              <div className="mt-2 font-serif text-[13.5px] leading-[1.55] tracking-[-0.005em] text-ink-2">
                The bench checks evaluators that return a structured judgment. It does not support
                skills that generate arbitrary output, and passing the selected examples does not
                show how the evaluator will perform on production traffic.
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
