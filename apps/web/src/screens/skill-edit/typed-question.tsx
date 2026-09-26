import type { Dispatch, SetStateAction } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Eyebrow } from "@/components/rubrist";
import { typedQuestionDraftProblems, type TypedQuestionDraft } from "../../lib/typed-question-draft.js";

// The typed-question definition (ADR-0014 section 5, Batch 8F): what the
// editor shows in place of the review guide and judge instructions when the
// evaluator runs on TypeSafe.

const textareaClass = "w-full resize-y rounded-sm border border-rule-soft bg-card-2 px-3 py-2.5 text-[12.5px] leading-[1.6] text-ink focus-visible:border-ink";

export function TypedQuestionCard({
  draft,
  setDraft
}: {
  draft: TypedQuestionDraft;
  setDraft: Dispatch<SetStateAction<TypedQuestionDraft>>;
}) {
  const problems = typedQuestionDraftProblems(draft);
  const change = (field: keyof TypedQuestionDraft) => (value: string) => setDraft((current) => ({ ...current, [field]: value }));
  return (
    <Card className="mb-5">
      <CardHeader>
        <div>
          <CardTitle>Typed question</CardTitle>
          <CardDescription>
            TypeSafe answers one yes-or-no question with the probability that the answer is true.
            The verdict is pass when that probability reaches the threshold, and fail otherwise; it
            never abstains and states no rationale. Ask about one property of the reply, with a
            clear line between true and false.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <Eyebrow>Question</Eyebrow>
          <textarea
            value={draft.instructions}
            onChange={(event) => change("instructions")(event.target.value)}
            placeholder="Does the reply answer in the language the user wrote in?"
            className={`${textareaClass} min-h-[90px]`}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <Eyebrow>True when</Eyebrow>
          <textarea
            value={draft.trueCriterion}
            onChange={(event) => change("trueCriterion")(event.target.value)}
            placeholder="The reply is in the user's language."
            className={`${textareaClass} min-h-[70px]`}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <Eyebrow>False when</Eyebrow>
          <textarea
            value={draft.falseCriterion}
            onChange={(event) => change("falseCriterion")(event.target.value)}
            placeholder="The reply is in another language."
            className={`${textareaClass} min-h-[70px]`}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <Eyebrow>Decision threshold</Eyebrow>
          <input
            type="number"
            min="0"
            max="1"
            step="0.01"
            value={draft.threshold}
            placeholder="choose one"
            onChange={(event) => change("threshold")(event.target.value)}
            className="h-9 rounded-sm border border-rule-soft bg-card-2 px-2 font-mono text-[12.5px] text-ink focus-visible:border-ink"
          />
          <span className="text-[11px] leading-5 text-ink-3">
            Pass when p ≥ this value. Choose it on nonsealed data, such as the golden set; it has no
            default, and changing it makes a new version.
          </span>
        </label>
        {problems.length > 0 ? (
          <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] text-ink-3 sm:col-span-2">
            {problems.map((problem) => <li key={problem}>{problem}</li>)}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
