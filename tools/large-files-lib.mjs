const CLASSIFICATIONS = new Set([
  "generated",
  "structural_exception",
  "refactor_candidate",
  "cohesion_review"
]);

export function countLines(contents) {
  if (contents.length === 0) return 0;
  let lines = 0;
  for (const byte of contents) {
    if (byte === 0x0a) lines += 1;
  }
  return contents.at(-1) === 0x0a ? lines : lines + 1;
}

export function isBinary(contents) {
  const sample = contents.subarray(0, 8 * 1024);
  if (sample.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return false;
  } catch {
    return true;
  }
}

export function validateConfig(value, source = "large-file inventory") {
  if (!value || !Number.isInteger(value.threshold) || value.threshold < 1 ||
      !value.files || typeof value.files !== "object" || Array.isArray(value.files)) {
    throw new Error(`Invalid large-file inventory at ${source}`);
  }
  for (const [path, record] of Object.entries(value.files)) {
    if (!record || !CLASSIFICATIONS.has(record.classification) ||
        typeof record.reason !== "string" || record.reason.trim().length === 0 ||
        typeof record.revisit !== "string" || record.revisit.trim().length === 0) {
      throw new Error(`Invalid classification for ${path} in ${source}`);
    }
  }
}

export function classifyInventoryDrift(input) {
  const tracked = new Set(input.tracked);
  const reported = new Set(input.overThreshold);
  const unavailable = new Set(input.unavailable);
  const binary = new Set(input.binary);
  return {
    untracked: input.configured.filter((path) => !tracked.has(path)).sort(),
    belowThreshold: input.configured.filter((path) =>
      tracked.has(path) && !reported.has(path) && !unavailable.has(path) && !binary.has(path)
    ).sort()
  };
}
