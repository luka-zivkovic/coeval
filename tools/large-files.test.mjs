import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyInventoryDrift,
  countLines,
  isBinary,
  validateConfig
} from "./large-files-lib.mjs";

describe("large-file report helpers", () => {
  it("counts empty, terminated, unterminated, and CRLF text", () => {
    assert.equal(countLines(Buffer.from("")), 0);
    assert.equal(countLines(Buffer.from("one\n")), 1);
    assert.equal(countLines(Buffer.from("one\ntwo")), 2);
    assert.equal(countLines(Buffer.from("one\r\ntwo\r\n")), 2);
  });

  it("distinguishes UTF-8 text from binary content", () => {
    assert.equal(isBinary(Buffer.from("ordinary π text\n", "utf8")), false);
    assert.equal(isBinary(Buffer.concat([Buffer.alloc(8_191, 0x61), Buffer.from("π", "utf8")])), false);
    assert.equal(isBinary(Buffer.from([0x61, 0x00, 0x62])), true);
    assert.equal(isBinary(Buffer.from([0xc3, 0x28])), true);
  });

  it("validates classifications and their explanations", () => {
    assert.doesNotThrow(() => validateConfig({
      threshold: 1000,
      files: {
        "large.ts": {
          classification: "refactor_candidate",
          reason: "Several responsibilities.",
          revisit: "After characterization."
        }
      }
    }));
    assert.throws(() => validateConfig({ threshold: 0, files: {} }), /Invalid large-file inventory/);
    assert.throws(() => validateConfig({
      threshold: 1000,
      files: { "large.ts": { classification: "ignored", reason: "No.", revisit: "Never." } }
    }), /Invalid classification/);
    assert.throws(() => validateConfig({
      threshold: 1000,
      files: { "large.ts": { classification: "cohesion_review", reason: "", revisit: "Later." } }
    }), /Invalid classification/);
  });

  it("separates untracked records from files that dropped below the threshold", () => {
    assert.deepEqual(classifyInventoryDrift({
      configured: ["missing.ts", "small.ts", "large.ts", "binary.png", "unavailable.ts"],
      tracked: ["small.ts", "large.ts", "binary.png", "unavailable.ts"],
      overThreshold: ["large.ts"],
      binary: ["binary.png"],
      unavailable: ["unavailable.ts"]
    }), {
      untracked: ["missing.ts"],
      belowThreshold: ["small.ts"]
    });
  });
});
