import { fetchProjectVerdicts } from "./api.js";

type LegacyVerdictFetcher = (input: {
  source: "human" | "adjudicated";
  criterionId: string;
}) => Promise<Array<{ caseId: string }>>;

export async function countLegacyHumanCheckedCases(
  criterionId: string,
  fetchVerdicts: LegacyVerdictFetcher = fetchProjectVerdicts
): Promise<number> {
  const [human, adjudicated] = await Promise.all([
    fetchVerdicts({ source: "human", criterionId }),
    fetchVerdicts({ source: "adjudicated", criterionId })
  ]);
  return new Set([...human, ...adjudicated].map((verdict) => verdict.caseId)).size;
}
