export const DEFAULT_OUTPUT_SCHEMA = {
  type: "object",
  required: ["label", "score", "reason", "confidence"],
  additionalProperties: false,
  properties: {
    label: {
      type: "string",
      enum: ["pass", "fail", "ambiguous"],
      description: "Overall judgment for the trace."
    },
    score: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Quality score where 1 is clearly good and 0 is clearly bad."
    },
    reason: {
      type: "string",
      description: "Short, concrete explanation grounded in the trace."
    },
    failureCategory: {
      type: "string",
      description: "Failure category when label is fail."
    },
    expectedBehavior: {
      type: "string",
      description: "What should have happened when label is fail or ambiguous."
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Judge confidence in the verdict."
    },
    criteria: {
      type: "object",
      description: "Optional criterion-level notes."
    }
  }
} as const;
