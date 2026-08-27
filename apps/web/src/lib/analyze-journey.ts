import { ANALYSIS_POPULATION_MIN_WINDOW_LAG_SECONDS } from "@coeval/shared";

export type AnalyzeJourneyStatus = "current" | "complete" | "incomplete" | "available" | "blocked";

export type AnalyzeJourneySnapshot = {
  reviewSampleCount: number;
  analysisState: string | null;
  selectedItemCount: number;
  completedItemCount: number;
  activeFailureTypeCount: number;
  activeFailureObservationCount: string | null;
  organizationCountsAvailable: boolean;
  categorizedObservationCount: string | null;
  retiredAssignmentCount: string | null;
  uncategorizedObservationCount: string | null;
  canCreateCriterion: boolean;
  criterionCreated: boolean | null;
};

export type AnalyzeJourneyStep = {
  status: AnalyzeJourneyStatus;
  detail: string;
};

export function buildAnalyzeJourneySteps(snapshot: AnalyzeJourneySnapshot): readonly AnalyzeJourneyStep[] {
  const hasSample = snapshot.reviewSampleCount > 0;
  const hasAnalysis = snapshot.analysisState !== null;
  const closed = snapshot.analysisState === "coding_closed" || snapshot.analysisState === "completed";
  const abandoned = snapshot.analysisState === "abandoned";
  const missingRuns = Math.max(0, snapshot.selectedItemCount - snapshot.completedItemCount);
  const activeObservations = exactCount(snapshot.activeFailureObservationCount);
  const categorized = exactCount(snapshot.categorizedObservationCount);
  const needsCurrentType = exactCount(snapshot.retiredAssignmentCount) + exactCount(snapshot.uncategorizedObservationCount);
  const hasExactFindingCount = snapshot.activeFailureObservationCount !== null;
  const criterionAvailable = closed && snapshot.organizationCountsAvailable &&
    snapshot.activeFailureTypeCount > 0 && categorized > 0n;

  const choose: AnalyzeJourneyStep = hasSample
    ? { status: "complete", detail: `${snapshot.reviewSampleCount} saved review sample${snapshot.reviewSampleCount === 1 ? "" : "s"}` }
    : { status: "current", detail: "Choose a recent window and sample size" };

  let review: AnalyzeJourneyStep;
  if (!hasSample) review = { status: "blocked", detail: "Available after a sample is saved" };
  else if (!hasAnalysis) review = { status: "current", detail: "Start an analysis from a saved sample" };
  else if (abandoned) review = {
    status: "incomplete",
    detail: `${snapshot.completedItemCount}/${snapshot.selectedItemCount} reviewed before the analysis stopped`
  };
  else if (!closed) review = { status: "current", detail: `${snapshot.completedItemCount}/${snapshot.selectedItemCount} runs reviewed` };
  else if (missingRuns > 0) review = {
    status: "incomplete",
    detail: `${snapshot.completedItemCount}/${snapshot.selectedItemCount} reviewed · ${missingRuns} unfinished at close`
  };
  else review = { status: "complete", detail: `${snapshot.completedItemCount}/${snapshot.selectedItemCount} runs reviewed` };

  let organize: AnalyzeJourneyStep;
  if (!hasAnalysis) organize = { status: "blocked", detail: "Available after an analysis starts" };
  else if (!hasExactFindingCount) organize = { status: "available", detail: "Loading exact finding counts" };
  else if (abandoned && activeObservations === 0n) organize = {
    status: "complete",
    detail: "No issue observations were preserved before the analysis stopped"
  };
  else if (abandoned && snapshot.activeFailureTypeCount === 0) organize = {
    status: "incomplete",
    detail: `${activeObservations} preserved issue observation${activeObservations === 1n ? "" : "s"} · no current failure type defined`
  };
  else if (abandoned && !snapshot.organizationCountsAvailable) organize = {
    status: "available",
    detail: "Loading organization counts for preserved findings"
  };
  else if (abandoned && needsCurrentType > 0n) organize = {
    status: "incomplete",
    detail: `${categorized}/${activeObservations} preserved observations organized · ${needsCurrentType} need a current type`
  };
  else if (abandoned) organize = {
    status: "complete",
    detail: `${categorized}/${activeObservations} observations organized before the analysis stopped`
  };
  else if (activeObservations === 0n && closed && missingRuns === 0) organize = {
    status: "complete",
    detail: "No issue observations to organize"
  };
  else if (activeObservations === 0n) organize = { status: "available", detail: "No issue observations recorded yet" };
  else if (snapshot.activeFailureTypeCount === 0) organize = { status: "current", detail: "Name the first human-authored failure type" };
  else if (!snapshot.organizationCountsAvailable) organize = { status: "available", detail: "Loading exact organization counts" };
  else if (needsCurrentType > 0n) organize = {
    status: "incomplete",
    detail: `${categorized}/${activeObservations} organized · ${needsCurrentType} need a current type`
  };
  else organize = { status: "complete", detail: `${categorized}/${activeObservations} observations organized` };

  let criterion: AnalyzeJourneyStep;
  if (snapshot.criterionCreated) criterion = {
    status: "complete",
    detail: "Criterion created · continue to governed review instructions"
  };
  else if (abandoned) criterion = { status: "blocked", detail: "Unavailable for a stopped analysis" };
  else if (criterionAvailable && !snapshot.canCreateCriterion) criterion = {
    status: "available",
    detail: "Criterion status and next actions are managed by a project owner"
  };
  else if (criterionAvailable && snapshot.criterionCreated === null) criterion = {
    status: "available",
    detail: "Checking for an existing criterion"
  };
  else if (criterionAvailable) criterion = { status: "current", detail: "Available from an organized failure type" };
  else criterion = {
    status: "blocked",
    detail: !closed
      ? "Available after the review closes"
      : !hasExactFindingCount
        ? "Checking exact findings before showing a next action"
        : activeObservations === 0n
        ? "No failure finding to turn into a criterion"
        : !snapshot.organizationCountsAvailable && snapshot.activeFailureTypeCount > 0
          ? "Checking how issue observations are organized"
        : snapshot.activeFailureTypeCount === 0
          ? "Name a failure type first"
          : "Organize at least one issue observation first"
  };

  return [choose, review, organize, criterion];
}

export function defaultAnalysisWindowEnd(nowMs = Date.now()): Date {
  return new Date(nowMs - (ANALYSIS_POPULATION_MIN_WINDOW_LAG_SECONDS + 1) * 1_000);
}

export function analysisCodingCardKey(item: { item: { studyId: string; id: string }; currentVersion: string }): string {
  return `${item.item.studyId}:${item.item.id}`;
}

type AnalyzeJourneyCoverage = {
  activeFailureObservationCount: string;
  categorized: string;
  assignedToRetiredCode: string;
  uncategorized: string;
};

export function analyzeJourneyFindingSnapshot(input: {
  coverage: AnalyzeJourneyCoverage | null;
  exactActiveFailureObservationCount: string | null;
}): Pick<AnalyzeJourneySnapshot,
  "activeFailureObservationCount" |
  "organizationCountsAvailable" |
  "categorizedObservationCount" |
  "retiredAssignmentCount" |
  "uncategorizedObservationCount"
> {
  return {
    activeFailureObservationCount: input.coverage?.activeFailureObservationCount ??
      input.exactActiveFailureObservationCount,
    organizationCountsAvailable: input.coverage !== null,
    categorizedObservationCount: input.coverage?.categorized ?? null,
    retiredAssignmentCount: input.coverage?.assignedToRetiredCode ?? null,
    uncategorizedObservationCount: input.coverage?.uncategorized ?? null
  };
}

function exactCount(value: string | null): bigint {
  return value === null ? 0n : BigInt(value);
}
