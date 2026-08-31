import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildEagerImportGraph,
  exportSurfaceDiff,
  eagerRelativeSpecifiers,
  findImportCycles,
  resolveSourceSpecifier
} from "./shared-contracts-lib.mjs";

describe("shared contract guards", () => {
  it("finds eager runtime imports while ignoring type-only and lazy edges", () => {
    const source = `
      import type { A } from "./types.js";
      import { type B, runtime } from "./mixed.js";
      import {} from "./empty-import.js";
      import "./side-effect.js";
      export type { C } from "./exported-type.js";
      export { type D, value } from "./exported-value.js";
      export {} from "./empty-export.js";
      const lazy = import("./lazy.js");
    `;
    assert.deepEqual(eagerRelativeSpecifiers(source), [
      "./exported-value.js",
      "./mixed.js",
      "./side-effect.js"
    ]);
  });

  it("resolves emitted .js specifiers to TypeScript source files", () => {
    const files = new Set([
      "packages/shared/src/data.json",
      "packages/shared/src/domain.js",
      "packages/shared/src/domain.ts",
      "packages/shared/src/nested/index.ts"
    ]);
    assert.equal(
      resolveSourceSpecifier("packages/shared/src/index.ts", "./domain.js", files),
      "packages/shared/src/domain.ts"
    );
    assert.equal(
      resolveSourceSpecifier("packages/shared/src/index.ts", "./nested", files),
      "packages/shared/src/nested/index.ts"
    );
    assert.equal(
      resolveSourceSpecifier("packages/shared/src/index.ts", "./data.json", files),
      "packages/shared/src/data.json"
    );
    assert.equal(resolveSourceSpecifier("packages/shared/src/index.ts", "./missing.js", files), null);
  });

  it("composes parser and resolver edges without turning lazy imports into cycles", () => {
    const lazyBackEdge = new Map([
      ["src/a.ts", `import { b } from "./b.js"; export const a = b;`],
      ["src/b.ts", `export const b = 1; export async function loadA() { return import("./a.js"); }`]
    ]);
    assert.deepEqual(findImportCycles(buildEagerImportGraph(lazyBackEdge)), []);

    const staticBackEdge = new Map([
      ...lazyBackEdge,
      ["src/b.ts", `import { a } from "./a.js"; export const b = a;`]
    ]);
    assert.deepEqual(findImportCycles(buildEagerImportGraph(staticBackEdge)), [
      ["src/a.ts", "src/b.ts", "src/a.ts"]
    ]);
  });

  it("reports canonical runtime import cycles", () => {
    const graph = new Map([
      ["a.ts", new Set(["b.ts"])],
      ["b.ts", new Set(["c.ts"])],
      ["c.ts", new Set(["a.ts"])],
      ["leaf.ts", new Set()]
    ]);
    assert.deepEqual(findImportCycles(graph), [["a.ts", "b.ts", "c.ts", "a.ts"]]);
  });

  it("explains public export drift", () => {
    assert.deepEqual(exportSurfaceDiff(["A", "B"], ["B", "C"]), {
      added: ["C"],
      removed: ["A"]
    });
  });
});
