import type { TypedQuestion } from "@rubrist/shared";
import { Eyebrow } from "@/components/rubrist";

// A typed-question version's definition, read-only (ADR-0014 section 5): the
// question TypeSafe answers with a probability, what makes the answer true
// and false, and the threshold that turns the probability into a verdict.

export function TypedQuestionView({ question, threshold }: { question: TypedQuestion; threshold: number | null }) {
  return (
    <div>
      <Eyebrow>Typed question · answered by TypeSafe</Eyebrow>
      <p className="mt-2 max-w-[80ch] text-[12.5px] leading-5 text-ink-2">
        The model returns the probability that the answer is true. The verdict is pass when that
        probability reaches the threshold, and fail otherwise; it never abstains and states no rationale.
      </p>
      <dl className="mt-3 grid grid-cols-1 gap-y-2 text-[13px] sm:grid-cols-[160px_1fr]">
        <dt className="text-ink-3">Question</dt>
        <dd className="whitespace-pre-wrap break-words text-ink">{question.instructions}</dd>
        <dt className="text-ink-3">True when</dt>
        <dd className="whitespace-pre-wrap break-words text-ink-2">{question.criteria.true}</dd>
        <dt className="text-ink-3">False when</dt>
        <dd className="whitespace-pre-wrap break-words text-ink-2">{question.criteria.false}</dd>
        <dt className="text-ink-3">Decision threshold</dt>
        <dd className="font-mono">{threshold === null ? "not recorded" : `pass when p ≥ ${threshold}`}</dd>
      </dl>
    </div>
  );
}
