import { randomBytes } from "node:crypto";
import { sha256Digest } from "../lib/assessment-receipt.js";

export interface GovernedSelectionFrameItem {
  id: string;
  digest: string;
}

export type GovernedSelectionRequest =
  | { method: "simple_random" | "systematic"; fixedBudget: number }
  | {
      method: "stratified_random";
      strata: Array<{
        key: string;
        definition: string;
        sourceItemIds: string[];
        fixedBudget: number;
      }>;
    }
  | {
      method: "convenience" | "uncertainty" | "failure_hunting" | "manual";
      selectedSourceItemIds: string[];
    };

export interface GovernedSelectionResult {
  method: GovernedSelectionRequest["method"];
  selected: GovernedSelectionFrameItem[];
  seed: string | null;
  rngVersion: "sha256-rank/v1" | "sha256-systematic/v1" | null;
  algorithmVersion: "coeval-governed-draw/v1";
  drawDigest: string;
  strata: Array<{
    key: string;
    definition: string;
    populationSize: number;
    fixedBudget: number;
    selectedItemIds: string[];
    membershipDigest: string;
    drawDigest: string;
  }>;
}

export function generateGovernedSelectionSeed(): string {
  return randomBytes(32).toString("hex");
}

export function executeGovernedReviewSelection(input: {
  frame: readonly GovernedSelectionFrameItem[];
  selection: GovernedSelectionRequest;
  seed?: string;
}): GovernedSelectionResult {
  const frame = validateFrame(input.frame);
  const byId = new Map(frame.map((item) => [item.id, item]));
  const method = input.selection.method;
  let seed: string | null = null;
  let rngVersion: GovernedSelectionResult["rngVersion"] = null;
  let selected: GovernedSelectionFrameItem[];
  let strata: GovernedSelectionResult["strata"] = [];

  if (method === "simple_random") {
    assertBudget(input.selection.fixedBudget, frame.length);
    seed = input.seed ?? generateGovernedSelectionSeed();
    rngVersion = "sha256-rank/v1";
    selected = ranked(frame, seed).slice(0, input.selection.fixedBudget);
  } else if (method === "systematic") {
    assertBudget(input.selection.fixedBudget, frame.length);
    seed = input.seed ?? generateGovernedSelectionSeed();
    rngVersion = "sha256-systematic/v1";
    selected = systematic(frame, input.selection.fixedBudget, seed);
  } else if (method === "stratified_random") {
    seed = input.seed ?? generateGovernedSelectionSeed();
    rngVersion = "sha256-rank/v1";
    const declaredIds = input.selection.strata.flatMap((stratum) => stratum.sourceItemIds);
    assertUnique(declaredIds, "declared stratum source item");
    if (declaredIds.length !== frame.length || declaredIds.some((id) => !byId.has(id))) {
      throw new Error("Declared strata must partition the complete frozen frame");
    }
    selected = [];
    strata = [...input.selection.strata]
      .sort((left, right) => compare(left.key, right.key))
      .map((stratum) => {
        const members = stratum.sourceItemIds.map((id) => byId.get(id)!);
        assertBudget(stratum.fixedBudget, members.length);
        const drawn = ranked(members, `${seed}:${stratum.key}`).slice(0, stratum.fixedBudget);
        selected.push(...drawn);
        return {
          key: stratum.key,
          definition: stratum.definition,
          populationSize: members.length,
          fixedBudget: stratum.fixedBudget,
          selectedItemIds: drawn.map((item) => item.id),
          membershipDigest: sha256Digest(
            members.map((item) => ({ id: item.id, digest: item.digest })).sort(compareIdentity)
          ),
          drawDigest: sha256Digest({
            key: stratum.key,
            drawItemDigests: drawn.map((item) => item.digest)
          })
        };
      });
  } else if (
    method === "convenience" || method === "uncertainty" ||
    method === "failure_hunting" || method === "manual"
  ) {
    const directed = input.selection as Extract<GovernedSelectionRequest, { selectedSourceItemIds: string[] }>;
    const ids = directed.selectedSourceItemIds;
    assertUnique(ids, "selected source item");
    selected = ids.map((id) => {
      const item = byId.get(id);
      if (!item) throw new Error(`Selected item is not in the frozen frame: ${id}`);
      return item;
    });
  } else {
    throw new Error(`Unsupported governed review selection method: ${String(method)}`);
  }

  return {
    method,
    selected,
    seed,
    rngVersion,
    algorithmVersion: "coeval-governed-draw/v1",
    drawDigest: sha256Digest({
      method,
      seed,
      rngVersion,
      drawItemDigests: selected.map((item) => item.digest)
    }),
    strata
  };
}

function validateFrame(input: readonly GovernedSelectionFrameItem[]): GovernedSelectionFrameItem[] {
  if (input.length === 0) throw new Error("Governed review selection requires a non-empty frozen frame");
  const frame = input.map((item) => ({ ...item }));
  for (const item of frame) {
    if (!item.id || !/^sha256:[0-9a-f]{64}$/.test(item.digest)) {
      throw new Error("Governed review frame items require an id and sha256 digest");
    }
  }
  assertUnique(frame.map((item) => item.id), "governed review frame item id");
  assertUnique(frame.map((item) => item.digest), "governed review frame item digest");
  return frame.sort(compareIdentity);
}

function ranked(frame: readonly GovernedSelectionFrameItem[], seed: string): GovernedSelectionFrameItem[] {
  return [...frame]
    .map((item) => ({ item, rank: sha256Digest({ basis: "governed-selection-rank/v1", seed, item }) }))
    .sort((left, right) => compare(left.rank, right.rank) || compareIdentity(left.item, right.item))
    .map(({ item }) => item);
}

function systematic(
  frame: readonly GovernedSelectionFrameItem[],
  budget: number,
  seed: string
): GovernedSelectionFrameItem[] {
  const ordered = [...frame].sort(compareIdentity);
  const offsetHex = sha256Digest({ basis: "governed-selection-systematic/v1", seed }).slice("sha256:".length);
  const offset = Number(BigInt(`0x${offsetHex}`) % BigInt(ordered.length));
  const selected: GovernedSelectionFrameItem[] = [];
  for (let index = 0; index < budget; index += 1) {
    const position = Math.floor(offset + (index * ordered.length) / budget) % ordered.length;
    selected.push(ordered[position]!);
  }
  assertUnique(selected.map((item) => item.id), "systematic selected item");
  return selected;
}

function assertBudget(budget: number, populationSize: number): void {
  if (!Number.isSafeInteger(budget) || budget <= 0 || budget > populationSize) {
    throw new Error("Governed review fixed budget must be positive and no larger than its population");
  }
}

function assertUnique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${name} values must be unique`);
}

function compareIdentity(
  left: Pick<GovernedSelectionFrameItem, "id" | "digest">,
  right: Pick<GovernedSelectionFrameItem, "id" | "digest">
): number {
  return compare(left.digest, right.digest) || compare(left.id, right.id);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
