import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Eyebrow, SectionHead, SetupLedger, ProvChip, VerdictChip } from "@/components/coeval";
import { AgentSetupPairingCard } from "@/components/agent-setup-pairing";
import { FirstProjectKeyCard } from "@/components/first-project-key";
import { GOLDEN_GATE_RECOMMENDED, type Project } from "@coeval/shared";

interface DashboardWelcomeProps {
  project: Project;
  canPairAgent: boolean;
}

// Overview · day 0 — nothing imported yet. The setup ledger walks the user to
// the moment the product proves itself: first verdict, first exception, first
// golden case. Derived entirely from project state; no checklist persistence.
export function DashboardWelcome({ project, canPairAgent }: DashboardWelcomeProps) {
  const navigate = useNavigate();

  return (
    <div className="fadeUp max-w-[1760px]">
      <SectionHead
        eyebrow="New project · nothing imported yet"
        title="Get your first evaluator result"
        sub="Connect a trace source or import one trace. Coeval applies the starter evaluator as traces arrive and marks its verdicts provisional until an owner reviews and approves the guide."
      />

      <div className="mt-2 grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,1fr)]">
        <SetupLedger
          steps={[
            {
              state: "now",
              title: "Connect a trace source",
              detail: "Connect LangSmith or Langfuse, or paste one trace to try the workflow.",
              cta: "Connect",
              onCta: () => navigate("/integrations")
            },
            {
              state: "locked",
              title: "Import your first traces",
              detail: "Coeval checks for new traces every few minutes and evaluates them with the starter guide."
            },
            {
              state: "locked",
              title: "Review the starter rubric",
              detail: "Use the imported traces to revise the guide, then sign off when it reflects your criteria."
            },
            {
              state: "locked",
              title: "Enable regression checks with a golden case",
              detail: `The first reviewed case enables regression checks; ${GOLDEN_GATE_RECOMMENDED} is the recommended starting set.`
            }
          ]}
        />

        <div className="min-w-0 flex flex-col gap-4">
          <FirstProjectKeyCard project={project} />
          {canPairAgent ? <AgentSetupPairingCard /> : null}

          <Card className="bg-paper-2">
            <CardContent className="py-4">
              <Eyebrow>What "provisional" means</Eyebrow>
              <div className="mt-2 font-serif text-[14.5px] leading-[1.6] tracking-[-0.005em] text-ink-2">
                Until an owner reviews and approves the guide, every verdict is marked provisional.
                You can inspect the result, but it does not represent an approved evaluator version.
              </div>
              <div className="mt-3.5 flex items-center gap-2">
                <ProvChip />
                <span className="font-mono text-[11px] text-ink-4">→</span>
                <VerdictChip verdict="pass" />
                <span className="ml-1 text-[11px] text-ink-4">after sign-off</span>
              </div>
            </CardContent>
          </Card>

          <Card className="border-dashed">
            <CardContent className="py-4">
              <Eyebrow>How Coeval uses your tracing platform</Eyebrow>
              <div className="mt-2 font-serif text-[13.5px] leading-[1.55] tracking-[-0.005em] text-ink-2">
                Coeval does not replace your tracing platform. It imports traces for evaluation and
                can send recorded verdicts back to LangSmith or Langfuse.
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
