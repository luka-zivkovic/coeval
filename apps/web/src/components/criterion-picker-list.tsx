import type { CriterionChoice } from "../lib/criterion-context.js";

export function CriterionPickerList({
  choices,
  selectedCriterionId,
  onSelect
}: {
  choices: CriterionChoice[];
  selectedCriterionId: string | null;
  onSelect: (criterionId: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {choices.map((choice) => {
        const selected = choice.criterion.id === selectedCriterionId;
        return (
          <article
            key={choice.criterion.id}
            className={`rounded-sm border bg-card text-card-foreground ${selected ? "border-ink" : "border-rule-soft"}`}
          >
            <div className="flex items-baseline gap-3 border-b border-rule-soft px-[18px] py-3.5">
              <div className="min-w-0 flex-1">
                <div className="font-serif text-[14.5px] font-medium tracking-[-0.01em]">{choice.name}</div>
                <div className="text-[12px] text-ink-3">
                  {choice.definition ?? "Immutable criterion definition loading…"}
                </div>
              </div>
              {selected ? (
                <span className="rounded-sm border border-rule-soft bg-paper-3 px-2 py-0.5 font-mono text-[10.5px] uppercase text-ink">
                  ✓ selected
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-3 px-[18px] py-4">
              <div className="min-w-0 flex-1 font-mono text-[10.5px] text-ink-3">
                <div className="truncate">{choice.criterion.stableKey}</div>
                <div>{choice.revision ? `definition r${choice.revision}` : choice.criterion.sourceKind}</div>
              </div>
              <button
                type="button"
                className={`h-7 rounded-sm border px-2 text-[11.5px] ${
                  selected
                    ? "border-transparent bg-transparent text-ink-2 hover:bg-paper-3"
                    : "border-ink bg-ink text-paper hover:bg-ink-2"
                }`}
                onClick={() => onSelect(choice.criterion.id)}
              >
                {selected ? "Keep selected" : "Work on this"} →
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
