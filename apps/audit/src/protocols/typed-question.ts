import { VerdictProtocolError } from "./verdict-protocols.js";

// typed-question/v1 (Rubrist ADR-0014 section 5): one binary `noul` question,
// answered by a typed-question model with the probability that its answer is
// true. Like every verdict protocol, a released version never changes; it
// pins the exact request bytes and how the answer is read:
//
// - the body is `{"state":…,"questions":{"verdict":…},"model":…}`, in that
//   key order, with the binding's model;
// - the question is `{"type":"noul","instructions":…,"criteria":{"true":…,
//   "false":…}}`, in that key order;
// - the state is the trace's input and output, and its steps when it has any,
//   as a JSON object in the order `input`, `output`, `steps`, each step as
//   `name` (when it has one), `input`, `output`. This is what the #101 spike
//   measured (founder decision 2026-09-26). The trace id, trace metadata, and
//   step metadata are not sent;
// - every value taken from the trace is canonical JSON: object keys sorted by
//   UTF-16 code unit at every depth, array order kept, an undefined member
//   left out and an undefined array entry sent as null. A non-finite number, a
//   cycle, or a value JSON can't hold is refused before any call, so the same
//   trace always shows the model the same bytes;
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

/** A trace typed-question/v1 can't send exactly. Its message names no trace content. */
export class TypedQuestionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypedQuestionStateError";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const byCodeUnit = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

/** Canonical JSON of one value taken from the trace. */
function canonicalTraceValue(value: unknown, ancestors: ReadonlySet<object>): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypedQuestionStateError("the trace holds a number JSON can't represent");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypedQuestionStateError(`the trace holds a ${typeof value}, which JSON can't represent`);
  if (ancestors.has(value)) throw new TypedQuestionStateError("the trace contains a cycle");
  const next = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => entry === undefined ? "null" : canonicalTraceValue(entry, next)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).filter((key) => object[key] !== undefined).sort(byCodeUnit);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalTraceValue(object[key], next)}`).join(",")}}`;
}

const traceValue = (value: unknown) => canonicalTraceValue(value === undefined ? null : value, new Set());

/** The state the model is shown, as its pinned JSON text. */
export function typedQuestionStateText(trace: unknown): string {
  if (!isObject(trace)) throw new TypedQuestionStateError("a typed-question trace is a JSON object");
  const fields = [`"input":${traceValue(trace.input)}`, `"output":${traceValue(trace.output)}`];
  if (trace.steps !== undefined) {
    if (!Array.isArray(trace.steps) || !trace.steps.every(isObject)) {
      throw new TypedQuestionStateError("a trace's steps are a list of objects");
    }
    if (trace.steps.length > 0) {
      const steps = trace.steps.map((step) => {
        const name = typeof step.name === "string" ? `"name":${JSON.stringify(step.name)},` : "";
        return `{${name}"input":${traceValue(step.input)},"output":${traceValue(step.output)}}`;
      });
      fields.push(`"steps":[${steps.join(",")}]`);
    }
  }
  return `{${fields.join(",")}}`;
}

/** The question as typed-question/v1 sends it, as its pinned JSON text. */
export function typedQuestionText(question: TypedQuestion): string {
  return `{"type":"noul","instructions":${JSON.stringify(question.instructions)},` +
    `"criteria":{"true":${JSON.stringify(question.criteria.true)},"false":${JSON.stringify(question.criteria.false)}}}`;
}

/** The exact request body typed-question/v1 sends for one judgment. */
export function typedQuestionRequestText(modelId: string, evaluator: TypedQuestionEvaluator, trace: unknown): string {
  return `{"state":${typedQuestionStateText(trace)},"questions":{"${TYPED_QUESTION_KEY}":${typedQuestionText(evaluator.question)}},` +
    `"model":${JSON.stringify(modelId)}}`;
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
    // -0 and 0 are the same probability; record one of them.
    probability: probability === 0 ? 0 : probability,
    threshold: evaluator.threshold,
    rationaleStatus: "not_provided"
  };
}
