// Question builders mirroring the @typesafe-ai/sdk 0.6.0 question shapes
// (noul = yes/no probability, choice = label distribution, score = ordered
// rubric). Kept dependency-free so the harness runs without installing the SDK;
// the wire shape is what `POST /v1/systemone` accepts.

/** @param {unknown} instructions @param {{true?: unknown, false?: unknown} | null} [criteria] */
export function noul(instructions = null, criteria = null) {
  return criteria === null
    ? { type: "noul", instructions }
    : { type: "noul", instructions, criteria };
}

/** @param {unknown} instructions @param {Record<string, unknown>} criteria */
export function choice(instructions, criteria) {
  if (!criteria || typeof criteria !== "object" || Object.keys(criteria).length < 2) {
    throw new Error("choice() needs at least two labelled criteria");
  }
  return { type: "choice", instructions, criteria };
}

/** @param {unknown} instructions @param {unknown[]} criteria */
export function score(instructions, criteria) {
  if (!Array.isArray(criteria) || criteria.length < 2) {
    throw new Error("score() needs an ordered rubric with at least two levels");
  }
  return { type: "score", instructions, criteria };
}

/**
 * Build the single yes/no question for a binary Coeval-style criterion.
 * "Yes" is oriented to mean the criterion is satisfied (a pass), which is the
 * orientation ADR-0004 calls the declared positive class.
 * @param {{ key: string, question: string, passDescription: string, failDescription: string }} criterion
 */
export function criterionQuestion(criterion) {
  if (criterion.abstention) {
    return {
      [criterion.key]: choice(criterion.question, {
        pass: criterion.passDescription,
        fail: criterion.failDescription,
        cannot_determine: criterion.cannotDetermineDescription ?? "The state does not contain enough evidence to decide either way."
      })
    };
  }
  return {
    [criterion.key]: noul(criterion.question, {
      true: criterion.passDescription,
      false: criterion.failDescription
    })
  };
}

/**
 * Probability that the criterion is satisfied, from either question shape,
 * plus the cannot-determine mass when the shape has one. A plain yes/no
 * scores missing evidence as "no", which is why the three-way shape exists.
 */
export function passProbability(answer) {
  if (!answer) throw new Error("missing answer");
  if (answer.type === "noul" && typeof answer.noul === "number") return { p: answer.noul, cannotDetermine: null };
  if (answer.type === "choice" && answer.probabilities && typeof answer.probabilities.pass === "number") {
    return { p: answer.probabilities.pass, cannotDetermine: answer.probabilities.cannot_determine ?? 0 };
  }
  throw new Error(`answer of type "${answer.type}" is not a criterion answer`);
}

/** Stable digest of a question set so a replay log can say what was asked. */
export async function questionDigest(questions) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(canonicalJson(questions)).digest("hex");
}

/** Deterministic JSON: sorted object keys, arrays in order. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}
