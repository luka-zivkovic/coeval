import { ChevronRight, Layers3, RefreshCcw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Eyebrow, SectionHead } from "@/components/coeval";
import { CriterionPickerList } from "@/components/criterion-picker-list";
import { DatabaseModeRequired } from "@/components/database-mode-required";
import { useAppMode } from "@/lib/app-mode";
import { useCriterion, type CriterionChoice } from "@/lib/criterion-context";

export function CriterionPicker({
  choices,
  selectedCriterionId,
  onSelect,
  title = "Choose what you are judging",
}: {
  choices: CriterionChoice[];
  selectedCriterionId: string | null;
  onSelect: (criterionId: string) => void;
  title?: string;
}) {
  return (
    <div className="fadeUp">
      <SectionHead
        eyebrow="Evaluation scope"
        title={title}
        sub="A criterion is one quality question that an evaluator answers. Each criterion keeps its own evaluator versions, reviewed evidence, diagnostics, and history. Choose one to scope the rest of the workspace."
      />
      <CriterionPickerList choices={choices} selectedCriterionId={selectedCriterionId} onSelect={onSelect} />
    </div>
  );
}

export function CriteriaScreen() {
  const { demoMode } = useAppMode();

  if (demoMode) {
    return (
      <DatabaseModeRequired
        eyebrow="Evaluation scope · demo mode"
        title="Criterion management needs a persistent workspace."
        description="Criteria and their evaluator history must be saved to a signed-in project, so you cannot create or switch them in the in-memory demo."
        demoAlternative="The demo includes one example criterion. You can inspect it from Overview or Review guide."
      />
    );
  }

  return <PersistentCriteriaScreen />;
}

function PersistentCriteriaScreen() {
  const navigate = useNavigate();
  const { choices, selectedCriterionId, selectCriterion, loading, error, reload, href } = useCriterion();

  if (loading && choices.length === 0) {
    return <SectionHead eyebrow="Evaluation scope" title="Loading criteria" />;
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <Eyebrow>Criteria unavailable</Eyebrow>
          <div className="mt-2 text-[13px] text-signal">{error}</div>
          <Button variant="ghost" size="sm" className="mt-4" onClick={() => void reload()}>
            <RefreshCcw /> Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (choices.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Layers3 className="mx-auto size-5 text-ink-3" />
          <div className="mt-3 font-serif text-[18px]">No criteria yet</div>
          <div className="mt-2 text-[12.5px] text-ink-3">Create the project's first evaluator criterion through setup.</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <CriterionPicker
        choices={choices}
        selectedCriterionId={selectedCriterionId}
        onSelect={selectCriterion}
        title={choices.length === 1 ? "Your evaluation criterion" : "Project criteria"}
      />
      {selectedCriterionId ? (
        <div className="mt-5 flex justify-end">
          <Button variant="primary" onClick={() => navigate(href("/"))}>
            Open selected overview <ChevronRight />
          </Button>
        </div>
      ) : null}
    </>
  );
}
