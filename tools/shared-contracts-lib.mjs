import path from "node:path";
import ts from "typescript";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function moduleSpecifierText(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function importHasRuntimeBinding(clause) {
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  if (!clause.namedBindings) return false;
  if (ts.isNamespaceImport(clause.namedBindings)) return true;
  return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function exportHasRuntimeBinding(statement) {
  if (statement.isTypeOnly) return false;
  if (!statement.exportClause) return true;
  if (ts.isNamespaceExport(statement.exportClause)) return true;
  return statement.exportClause.elements.some((element) => !element.isTypeOnly);
}

export function eagerRelativeSpecifiers(source, fileName = "module.ts") {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers = new Set();

  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement) && importHasRuntimeBinding(statement.importClause)) {
      const specifier = moduleSpecifierText(statement.moduleSpecifier);
      if (specifier?.startsWith(".")) specifiers.add(specifier);
    }
    if (ts.isExportDeclaration(statement) && exportHasRuntimeBinding(statement)) {
      const specifier = moduleSpecifierText(statement.moduleSpecifier);
      if (specifier?.startsWith(".")) specifiers.add(specifier);
    }
  }

  return [...specifiers].sort();
}

export function resolveSourceSpecifier(importer, specifier, sourceFiles) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  const candidates = [
    base.replace(/\.(?:m?js|cjs)$/u, ".ts"),
    base,
    `${base}.ts`,
    path.posix.join(base, "index.ts")
  ];
  return candidates.find((candidate) => sourceFiles.has(candidate)) ?? null;
}

export function buildEagerImportGraph(sources, knownFiles = new Set(sources.keys())) {
  const sourceFiles = new Set(sources.keys());
  const graph = new Map();
  for (const [importer, source] of sources) {
    const dependencies = new Set();
    for (const specifier of eagerRelativeSpecifiers(source, importer)) {
      const resolved = resolveSourceSpecifier(importer, specifier, knownFiles);
      if (!resolved) throw new Error(`Cannot resolve runtime import ${specifier} from ${importer}`);
      if (sourceFiles.has(resolved)) dependencies.add(resolved);
    }
    graph.set(importer, dependencies);
  }
  return graph;
}

function canonicalCycle(nodes) {
  const body = nodes.slice(0, -1);
  const rotations = body.map((_, index) => [...body.slice(index), ...body.slice(0, index)]);
  rotations.sort((left, right) => compareText(left.join("\u0000"), right.join("\u0000")));
  return [...rotations[0], rotations[0][0]];
}

export function findImportCycles(graph) {
  const state = new Map();
  const stack = [];
  const cycles = new Map();

  function visit(node) {
    state.set(node, "visiting");
    stack.push(node);
    for (const dependency of [...(graph.get(node) ?? [])].sort()) {
      if (state.get(dependency) === "visiting") {
        const start = stack.lastIndexOf(dependency);
        const cycle = canonicalCycle([...stack.slice(start), dependency]);
        cycles.set(cycle.join(" -> "), cycle);
      } else if (!state.has(dependency)) {
        visit(dependency);
      }
    }
    stack.pop();
    state.set(node, "visited");
  }

  for (const node of [...graph.keys()].sort()) {
    if (!state.has(node)) visit(node);
  }
  return [...cycles.values()].sort((left, right) => compareText(left.join("\u0000"), right.join("\u0000")));
}

export function exportSurfaceDiff(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    added: actual.filter((name) => !expectedSet.has(name)),
    removed: expected.filter((name) => !actualSet.has(name))
  };
}
