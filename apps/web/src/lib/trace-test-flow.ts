import type {
  CreateTraceTestInput,
  TracePayload,
  TraceTestDraftProvenance,
  TraceTestSourceScope,
  VerdictLabel,
  VerdictPayload
} from "@coeval/shared";

export type TraceTestIntent = "prevent" | "protect" | "make";
export type TraceTestJob = "response" | "verdict" | "preserve";
export type CorrectionResult = "pass" | "fail" | "needs_review";

export interface ConversationTurn {
  index: number;
  role: string;
  body: string;
  path: Array<string | number>;
  responseCandidate: boolean;
}

export interface ManualTraceTestFields {
  scenario: string;
  expectedBehavior: string;
  mustDo: string;
  mustAvoid: string;
  goodExample: string;
  badExample: string;
  checkerKind: "judge" | "manual";
  checkerLabel: string;
  checkerRationale: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function plainText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((part) => {
      if (typeof part === "string") return part;
      if (isRecord(part)) {
        if (typeof part.text === "string") return part.text;
        if (typeof part.content === "string") return part.content;
      }
      return plainText(part);
    }).filter(Boolean);
    return parts.join("\n");
  }
  if (isRecord(value)) {
    if (typeof value.content === "string") return value.content;
    if (typeof value.text === "string") return value.text;
    if (Array.isArray(value.content)) return plainText(value.content);
  }
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

function messageTurns(value: unknown, root: "input" | "output"): Omit<ConversationTurn, "index">[] {
  if (!isRecord(value) || !Array.isArray(value.messages)) return [];
  return value.messages.map((message, messageIndex) => {
    const record = isRecord(message) ? message : {};
    const role = typeof record.role === "string" ? record.role.toLowerCase() : root === "output" ? "assistant" : "user";
    return {
      role,
      body: plainText(isRecord(message) && "content" in message ? message.content : message),
      path: [root, "messages", messageIndex],
      responseCandidate: role === "assistant"
    };
  });
}

export function conversationTurns(trace: TracePayload): ConversationTurn[] {
  const inputTurns = messageTurns(trace.input, "input");
  const outputTurns = messageTurns(trace.output, "output");
  const turns: Omit<ConversationTurn, "index">[] = [
    ...(inputTurns.length > 0
      ? inputTurns
      : [{ role: "user", body: plainText(trace.input), path: ["input"], responseCandidate: false }]),
    ...(outputTurns.length > 0
      ? outputTurns
      : [{ role: "assistant", body: plainText(trace.output), path: ["output"], responseCandidate: true }])
  ];
  return turns.map((turn, index) => ({ ...turn, index }));
}

export function defaultSourceSelection(turns: ConversationTurn[]): {
  responsePath: Array<string | number>;
  turnIndexes: number[];
} {
  const selectedResponse = [...turns].reverse().find((turn) => turn.responseCandidate);
  if (!selectedResponse) return { responsePath: [], turnIndexes: turns.map((turn) => turn.index) };
  return {
    responsePath: selectedResponse.path,
    turnIndexes: turns.filter((turn) => turn.index <= selectedResponse.index).map((turn) => turn.index)
  };
}

export function intentForVerdict(verdict: VerdictLabel): TraceTestIntent {
  if (verdict === "pass") return "protect";
  if (verdict === "fail") return "prevent";
  return "make";
}

export function initialJobForIntent(intent: TraceTestIntent): TraceTestJob {
  return intent === "protect" ? "preserve" : "response";
}

export function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function manualFields(input: {
  turns: ConversationTurn[];
  selectedTurnIndexes: number[];
  responsePath: Array<string | number>;
  desiredBehavior: string;
  job: Exclude<TraceTestJob, "verdict">;
}): ManualTraceTestFields {
  const selected = input.turns.filter((turn) => input.selectedTurnIndexes.includes(turn.index));
  const response = input.turns.find((turn) => samePath(turn.path, input.responsePath));
  const scenario = selected
    .filter((turn) => !samePath(turn.path, input.responsePath))
    .map((turn) => turn.body)
    .filter(Boolean)
    .join("\n\n") || "Conversation from the selected source";
  const observed = response?.body ?? "";
  return {
    scenario,
    expectedBehavior: input.desiredBehavior.trim(),
    mustDo: "",
    mustAvoid: "",
    goodExample: input.job === "preserve" ? observed : "",
    badExample: input.job === "response" ? observed : "",
    checkerKind: "manual",
    checkerLabel: "Manual behavior check",
    checkerRationale: ""
  };
}

export function createManualTraceTestInput(input: {
  sourceCaseId: string;
  sourceScope: TraceTestSourceScope;
  desiredBehavior: string;
  job: Exclude<TraceTestJob, "verdict">;
  fields: ManualTraceTestFields;
  draftProvenance?: TraceTestDraftProvenance | undefined;
  inferredContext?: string[] | undefined;
}): CreateTraceTestInput {
  return {
    sourceCaseId: input.sourceCaseId,
    sourceScope: input.sourceScope,
    desiredBehavior: input.desiredBehavior.trim(),
    scenario: input.fields.scenario.trim(),
    expectedBehavior: input.fields.expectedBehavior.trim(),
    mustDo: lines(input.fields.mustDo),
    mustAvoid: lines(input.fields.mustAvoid),
    goodExample: { text: input.fields.goodExample.trim() },
    badExample: { text: input.fields.badExample.trim() },
    checker: {
      kind: input.fields.checkerKind,
      label: input.fields.checkerLabel.trim() || (input.fields.checkerKind === "judge" ? "AI behavior check" : "Manual behavior check"),
      metadata: {
        journeyJob: input.job,
        ...(input.fields.checkerRationale.trim() ? { recommendationRationale: input.fields.checkerRationale.trim() } : {}),
        ...(input.inferredContext?.length ? { inferredContext: input.inferredContext } : {})
      }
    },
    draftProvenance: input.draftProvenance ?? {
      origin: "human",
      generatedFields: [],
      generator: null
    }
  };
}

export function correctionVerdictPayload(result: CorrectionResult, reason: string): VerdictPayload {
  const choice: VerdictLabel = result === "needs_review" ? "ambiguous" : result;
  return {
    kind: "categorical",
    choice,
    choiceScores: { pass: choice === "pass" ? 1 : 0, fail: choice === "fail" ? 1 : 0, ambiguous: choice === "ambiguous" ? 1 : 0 },
    rationale: reason.trim()
  };
}

export function samePath(left: Array<string | number>, right: Array<string | number>): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}
