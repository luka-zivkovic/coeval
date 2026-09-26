import { VerdictProtocolError } from "./verdict-protocols.js";

// typed-question/v1 (Rubrist ADR-0014 section 5): one binary `noul` question,
// answered by a typed-question model with the probability that its answer is
// true. Like every verdict protocol, a released version never changes; it
// pins:
//
// - the question's key in the request, `verdict`;
// - the state the model is shown: the trace's input and output, and its steps
//   when it has any, as a JSON object, which is what the #101 spike measured
//   (founder decision 2026-09-26). Trace id, metadata, and step metadata are
//   not sent;
// - the request body, `{ state, questions, model }`, with the binding's model;
// - the parse rule: the answer is `{ type: "noul", noul: p }` with p a finite
//   number from 0 to 1;
// - the decision: polarity `true_is_pass`, so p is P(pass), and the item
//   passes when p is at or above the evaluator's threshold. A typed-question
//   verdict never abstains and states no rationale.

export const TYPED_QUESTION_PROTOCOL = "typed-question/v1" as const;
export const TYPED_QUESTION_KEY = "verdict";

/** A binary yes-or-no question, as the definition's digest names it. */
export interface TypedQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

/** What a typed-question definition decides with: its question and its threshold on P(pass). */
export interface TypedQuestionEvaluator {
  question: TypedQuestion;
  /** Strictly between 0 and 1; part of the evaluator's identity, never a default. */
  threshold: number;
}

/** A typed-question verdict: a label from the threshold, the probability behind it, and no rationale. */
export interface TypedQuestionVerdict {
  kind: "typed-question";
  label: "pass" | "fail";
  /** P(pass) as the model returned it; uncalibrated. */
  probability: number;
  threshold: number;
  rationaleStatus: "not_provided";
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The pinned state projection: input, output, and the steps' input and output (and name) when there are any. */
export function typedQuestionState(trace: unknown): Record<string, unknown> {
  const source = isObject(trace) ? trace : {};
  const steps = Array.isArray(source.steps) ? source.steps.filter(isObject) : [];
  return {
    input: source.input ?? null,
    output: source.output ?? null,
    ...(steps.length > 0
      ? {
          steps: steps.map((step) => ({
            ...(typeof step.name === "string" ? { name: step.name } : {}),
            input: step.input ?? null,
            output: step.output ?? null
          }))
        }
      : {})
  };
}

/** The request body typed-question/v1 sends for one judgment. */
export function typedQuestionRequestBody(modelId: string, evaluator: TypedQuestionEvaluator, trace: unknown): Record<string, unknown> {
  return {
    state: typedQuestionState(trace),
    questions: {
      [TYPED_QUESTION_KEY]: {
        type: "noul",
        instructions: evaluator.question.instructions,
        criteria: { true: evaluator.question.criteria.true, false: evaluator.question.criteria.false }
      }
    },
    model: modelId
  };
}

/**
 * The parse rule. A response without the question's answer is the provider
 * breaking the protocol; an answer that isn't a probability is the model's
 * output not being a verdict.
 */
export function parseTypedQuestionResponse(body: unknown, evaluator: TypedQuestionEvaluator): TypedQuestionVerdict {
  const answers = isObject(body) && isObject(body.answers) ? body.answers : null;
  if (answers === null) throw new VerdictProtocolError("provider_protocol", "the response has no answers");
  const answer = answers[TYPED_QUESTION_KEY];
  if (!isObject(answer) || answer.type !== "noul") {
    throw new VerdictProtocolError("provider_protocol", `the response has no noul answer to "${TYPED_QUESTION_KEY}"`);
  }
  const probability = answer.noul;
  if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new VerdictProtocolError("invalid_evaluator_output", "the answer is not a probability from 0 to 1");
  }
  return {
    kind: "typed-question",
    label: probability >= evaluator.threshold ? "pass" : "fail",
    probability,
    threshold: evaluator.threshold,
    rationaleStatus: "not_provided"
  };
}
