import type { GovernedBatchState } from "./governed-review-api.js";

export interface HumanTruthNextStepInput {
  criterionVersionId: string | null;
  instructionCount: number;
  batchStates: ReadonlyArray<GovernedBatchState | null>;
}

export interface HumanTruthNextStep {
  path: string;
  label: string;
  description: string;
}

export function humanTruthNextStep(input: HumanTruthNextStepInput): HumanTruthNextStep {
  if (!input.criterionVersionId) {
    return {
      path: "/criteria",
      label: "Choose a criterion",
      description: "Choose the single criterion whose reviewer instructions and evidence you want to govern."
    };
  }
  if (input.instructionCount === 0) {
    return {
      path: "/human-truth/new/instruction",
      label: "Create reviewer instructions",
      description: "First, freeze the exact instructions independent reviewers will apply to this criterion."
    };
  }
  if (input.batchStates.length === 0) {
    return {
      path: "/human-truth/new/batch",
      label: "Create a review batch",
      description: "Instructions are ready. Now choose an immutable source, independent reviewers, and a fixed labeling stop."
    };
  }
  const terminalStates: ReadonlySet<GovernedBatchState> = new Set(["abandoned", "incomplete", "frozen"]);
  if (input.batchStates.some((state) => state === null || !terminalStates.has(state))) {
    return {
      path: "#review-batches",
      label: "Manage current batch",
      description: "A governed batch is in progress. Review its exact state below and continue the available transition; assigned reviewers use their blind inbox."
    };
  }
  return {
    path: "/human-truth/new/batch",
    label: "Create another review batch",
    description: "The existing batches are terminal. Create another only when you have a new immutable source frame to review."
  };
}

export function humanTruthNextStepHref(
  path: string,
  criterionHref: (pathname: string) => string
): string {
  return path.startsWith("#")
    ? `${criterionHref("/human-truth")}${path}`
    : criterionHref(path);
}
