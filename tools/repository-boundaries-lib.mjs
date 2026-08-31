import assert from "node:assert/strict";
import path from "node:path";
import ts from "typescript";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) current = current.expression;
  return current;
}

function accessName(node) {
  const expression = unwrapExpression(node);
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression)
    && expression.argumentExpression
    && ts.isStringLiteralLike(unwrapExpression(expression.argumentExpression))
  ) return unwrapExpression(expression.argumentExpression).text;
  return null;
}

function accessReceiver(node) {
  const expression = unwrapExpression(node);
  return ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
    ? unwrapExpression(expression.expression)
    : null;
}

function isThisPropertyAccess(node, propertyName) {
  const expression = unwrapExpression(node);
  const receiver = accessReceiver(expression);
  return Boolean(
    receiver
    && receiver.kind === ts.SyntaxKind.ThisKeyword
    && accessName(expression) === propertyName
  );
}

function directCallForReference(node) {
  let current = node;
  while (
    current.parent
    && (
      ts.isParenthesizedExpression(current.parent)
      || ts.isAsExpression(current.parent)
      || ts.isTypeAssertionExpression(current.parent)
      || ts.isNonNullExpression(current.parent)
      || ts.isSatisfiesExpression(current.parent)
    )
  ) current = current.parent;
  return current.parent && ts.isCallExpression(current.parent) && current.parent.expression === current
    ? current.parent
    : null;
}

function poolDelegateConstructor(node) {
  let current = node;
  while (
    current.parent
    && (
      ts.isParenthesizedExpression(current.parent)
      || ts.isAsExpression(current.parent)
      || ts.isTypeAssertionExpression(current.parent)
      || ts.isNonNullExpression(current.parent)
      || ts.isSatisfiesExpression(current.parent)
    )
  ) current = current.parent;
  if (!current.parent || !ts.isNewExpression(current.parent) || !current.parent.arguments?.includes(current)) return null;
  const constructor = unwrapExpression(current.parent.expression);
  return ts.isIdentifier(constructor) ? constructor.text : null;
}

function canonicalizeSymbol(checker, symbol) {
  if (!symbol) return null;
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function canonicalSymbol(checker, node) {
  if (!node) return null;
  const expression = unwrapExpression(node);
  if (
    ts.isElementAccessExpression(expression)
    && expression.argumentExpression
    && ts.isStringLiteralLike(unwrapExpression(expression.argumentExpression))
  ) {
    const propertyName = unwrapExpression(expression.argumentExpression).text;
    const receiverType = checker.getTypeAtLocation(unwrapExpression(expression.expression));
    const property = checker.getPropertyOfType(receiverType, propertyName);
    if (property) return canonicalizeSymbol(checker, property);
  }
  return canonicalizeSymbol(checker, checker.getSymbolAtLocation(expression));
}

function callSymbol(checker, call) {
  return canonicalSymbol(checker, unwrapExpression(call.expression));
}

function expressionSymbol(checker, expression) {
  return canonicalSymbol(checker, unwrapExpression(expression));
}

function callableName(node, sourceFile) {
  if (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) {
    assert.ok(node.name && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)),
      "Repository boundary guard requires statically named class callables");
    return node.name.getText(sourceFile).replace(/^['"]|['"]$/gu, "");
  }
  if (ts.isFunctionDeclaration(node)) {
    assert.ok(node.name, "Repository boundary guard requires named functions");
    return node.name.text;
  }
  assert.ok(ts.isVariableDeclaration(node) && ts.isIdentifier(node.name),
    "Repository boundary guard requires named function variables");
  return node.name.text;
}

function callableFunction(node) {
  if (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) return node;
  if (
    (ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node))
    && node.initializer
    && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) return node.initializer;
  return null;
}

function callableSymbolNode(node) {
  if (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) return node.name;
  if (ts.isFunctionDeclaration(node)) return node.name;
  return ts.isVariableDeclaration(node) ? node.name : null;
}

function collectCallableDeclarations(sourceFile) {
  const declarations = [];
  for (const statement of sourceFile.statements) {
    if (ts.isClassDeclaration(statement) && statement.name) {
      for (const member of statement.members) {
        if (ts.isMethodDeclaration(member) && member.body) {
          declarations.push({ declaration: member, fn: member, className: statement.name.text });
        } else if (ts.isPropertyDeclaration(member) && callableFunction(member)) {
          declarations.push({ declaration: member, fn: callableFunction(member), className: statement.name.text });
        }
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      declarations.push({ declaration: statement, fn: statement, className: null });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const fn = callableFunction(declaration);
        if (fn) declarations.push({ declaration, fn, className: null });
      }
    }
  }
  return declarations;
}

function createProgram(sources) {
  const options = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    strict: true
  };
  const defaultHost = ts.createCompilerHost(options, true);
  const sourceByAbsolutePath = new Map();
  const labelByAbsolutePath = new Map();
  const virtualDirectories = new Set();
  for (const [label, source] of sources) {
    const absolute = path.resolve(label);
    sourceByAbsolutePath.set(absolute, source);
    labelByAbsolutePath.set(absolute, label.split(path.sep).join("/"));
    let directory = path.dirname(absolute);
    while (directory !== path.dirname(directory)) {
      virtualDirectories.add(directory);
      directory = path.dirname(directory);
    }
  }
  const host = {
    ...defaultHost,
    directoryExists(directoryName) {
      return virtualDirectories.has(path.resolve(directoryName)) || defaultHost.directoryExists?.(directoryName) === true;
    },
    fileExists(fileName) {
      return sourceByAbsolutePath.has(path.resolve(fileName)) || defaultHost.fileExists(fileName);
    },
    readFile(fileName) {
      return sourceByAbsolutePath.get(path.resolve(fileName)) ?? defaultHost.readFile(fileName);
    },
    getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile) {
      const absolute = path.resolve(fileName);
      const source = sourceByAbsolutePath.get(absolute);
      return source === undefined
        ? defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
        : ts.createSourceFile(absolute, source, languageVersion, true, ts.ScriptKind.TS);
    }
  };
  const program = ts.createProgram([...sourceByAbsolutePath.keys()], options, host);
  return { program, labelByAbsolutePath };
}

function poolClientParameterIndexes(checker, fn) {
  const indexes = [];
  for (const [index, parameter] of fn.parameters.entries()) {
    const type = checker.getTypeAtLocation(parameter);
    const names = [
      type.symbol?.getName(),
      type.aliasSymbol?.getName(),
      checker.typeToString(type, parameter, ts.TypeFormatFlags.NoTruncation)
    ].filter(Boolean);
    if (names.some((name) => /(?:^|\W)PoolClient(?:$|\W)/u.test(name))) indexes.push(index);
  }
  return indexes;
}

function controlPath(node, root) {
  const controls = [];
  let current = node;
  while (current.parent && current !== root) {
    const parent = current.parent;
    if (ts.isTryStatement(parent)) {
      if (current === parent.tryBlock) controls.push("try");
      else if (current === parent.catchClause) controls.push("catch");
      else if (current === parent.finallyBlock) controls.push("finally");
    } else if (ts.isIfStatement(parent)) {
      controls.push(current === parent.thenStatement ? "if.then" : current === parent.elseStatement ? "if.else" : "if.condition");
    } else if (
      ts.isForStatement(parent)
      || ts.isForInStatement(parent)
      || ts.isForOfStatement(parent)
      || ts.isWhileStatement(parent)
      || ts.isDoStatement(parent)
    ) {
      controls.push("loop");
    } else if (ts.isSwitchStatement(parent) || ts.isCaseBlock(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
      controls.push("switch");
    } else if (ts.isConditionalExpression(parent)) {
      controls.push(current === parent.whenTrue ? "conditional.true" : current === parent.whenFalse ? "conditional.false" : "conditional.condition");
    } else if (ts.isFunctionLike(parent) && parent !== root) {
      controls.push("nested_function");
    }
    current = parent;
  }
  return controls.reverse().join(">") || "root";
}

function event(pathName, boundaryEvent) {
  return `${pathName} :: ${boundaryEvent}`;
}

function eventName(boundaryEvent) {
  return boundaryEvent.slice(boundaryEvent.indexOf(" :: ") + 4);
}

function eventControl(boundaryEvent) {
  return boundaryEvent.slice(0, boundaryEvent.indexOf(" :: "));
}

function insideControl(boundaryEvent, control) {
  return eventControl(boundaryEvent).split(">").includes(control);
}

function isDirectReferenceNode(node) {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return true;
  return ts.isIdentifier(node)
    && !(
      (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      || (ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node)
      || (ts.isPropertyDeclaration(node.parent) && node.parent.name === node)
      || (ts.isMethodDeclaration(node.parent) && node.parent.name === node)
      || (ts.isFunctionDeclaration(node.parent) && node.parent.name === node)
      || (ts.isVariableDeclaration(node.parent) && node.parent.name === node)
      || (ts.isParameter(node.parent) && node.parent.name === node)
    );
}

function descendants(node) {
  const nodes = [];
  function visit(child) {
    nodes.push(child);
    ts.forEachChild(child, visit);
  }
  ts.forEachChild(node, visit);
  return nodes;
}

function displayName(callable, rootSource) {
  if (callable.source === rootSource && callable.className === "PgRepository") return callable.name;
  if (callable.source === rootSource && callable.className === null) return callable.name;
  return `${callable.source}#${callable.className ? `${callable.className}.` : ""}${callable.name}`;
}

export function analyzeRepositorySources(sources, options = {}) {
  assert.ok(sources instanceof Map && sources.size > 0, "Repository boundary guard requires a non-empty checked source inventory");
  const sourceLabels = [...sources.keys()].map((source) => source.split(path.sep).join("/")).sort(compareText);
  const rootSource = options.rootSource ?? "apps/api/src/repository.pg.ts";
  assert.ok(sourceLabels.includes(rootSource), `Checked sources must include ${rootSource}`);
  const { program, labelByAbsolutePath } = createProgram(sources);
  const checker = program.getTypeChecker();
  const callables = [];
  const callableBySymbol = new Map();

  for (const [absolute, label] of labelByAbsolutePath) {
    const sourceFile = program.getSourceFile(absolute);
    assert.ok(sourceFile, `Cannot parse checked repository source ${label}`);
    for (const entry of collectCallableDeclarations(sourceFile)) {
      const symbol = canonicalSymbol(checker, callableSymbolNode(entry.declaration));
      assert.ok(symbol, `Cannot resolve callable symbol in ${label}`);
      const callable = {
        ...entry,
        sourceFile,
        source: label,
        name: callableName(entry.declaration, sourceFile),
        symbol,
        poolClientParameterIndexes: poolClientParameterIndexes(checker, entry.fn)
      };
      callables.push(callable);
      callableBySymbol.set(symbol, callable);
    }
  }
  for (const callable of callables) callable.displayName = displayName(callable, rootSource);

  const callEdges = new Map(callables.map((callable) => [callable, new Set()]));
  for (const callable of callables) {
    for (const node of descendants(callable.fn.body ?? callable.fn)) {
      if (!ts.isCallExpression(node)) continue;
      const target = callableBySymbol.get(callSymbol(checker, node));
      if (target) callEdges.get(callable).add(target);
    }
  }

  const clientCommands = callables.filter((callable) => callable.poolClientParameterIndexes.length > 0);
  const clientCommandSymbols = new Set(clientCommands.map((callable) => callable.symbol));
  const allowedExternalPoolDelegates = new Set(options.allowedExternalPoolDelegates ?? []);
  const usedExternalPoolDelegates = new Set();
  const preliminaryOwners = [];

  for (const callable of callables) {
    const bodyNodes = descendants(callable.fn.body ?? callable.fn);
    const connectReferences = bodyNodes.filter((node) =>
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && accessName(node) === "connect");
    const connectCalls = [];
    for (const reference of connectReferences) {
      const call = directCallForReference(reference);
      assert.ok(call, `${callable.displayName} must invoke connect directly; aliases, bind, and detached references are forbidden`);
      assert.equal(Boolean(call.questionDotToken || reference.questionDotToken), false,
        `${callable.displayName} must not use optional connection acquisition`);
      connectCalls.push(call);
    }
    for (const node of bodyNodes) {
      if (!ts.isBindingElement(node)) continue;
      const name = node.propertyName?.getText(callable.sourceFile) ?? node.name.getText(callable.sourceFile);
      assert.notEqual(name.replace(/^['"]|['"]$/gu, ""), "connect",
        `${callable.displayName} must not destructure connect; acquire the connection directly`);
    }
    const uniqueConnectCalls = [...new Set(connectCalls)];
    if (uniqueConnectCalls.length === 0) continue;
    assert.equal(uniqueConnectCalls.length, 1, `${callable.displayName} must acquire exactly one PostgreSQL connection`);
    const connectCall = uniqueConnectCalls[0];
    let parent = connectCall.parent;
    if (ts.isAwaitExpression(parent)) parent = parent.parent;
    assert.ok(ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name),
      `${callable.displayName} must assign connect() to a local connection owner`);
    const clientSymbol = canonicalSymbol(checker, parent.name);
    assert.ok(clientSymbol, `${callable.displayName} connection owner must have a resolvable symbol`);
    preliminaryOwners.push({ callable, connectCall, clientSymbol });
  }

  const ownerSymbols = new Set(preliminaryOwners.map(({ callable }) => callable.symbol));
  const protectedSymbols = new Set([...ownerSymbols, ...clientCommandSymbols]);
  const allowedClientSymbolsByCallable = new Map(callables.map((callable) => [
    callable,
    new Set(callable.poolClientParameterIndexes
      .map((parameterIndex) => callable.fn.parameters[parameterIndex])
      .filter((parameter) => ts.isIdentifier(parameter.name))
      .map((parameter) => canonicalSymbol(checker, parameter.name))
      .filter(Boolean))
  ]));
  for (const { callable, clientSymbol } of preliminaryOwners) {
    allowedClientSymbolsByCallable.get(callable).add(clientSymbol);
  }

  for (const callable of callables) {
    const bodyNodes = descendants(callable.fn.body ?? callable.fn);
    for (const node of bodyNodes) {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const initializer = unwrapExpression(node.initializer);
        if (initializer.kind === ts.SyntaxKind.ThisKeyword || isThisPropertyAccess(initializer, "pool")) {
          throw new Error(`${callable.displayName} must not alias this or this.pool across repository boundaries`);
        }
      }
      if (
        ts.isElementAccessExpression(node)
        && unwrapExpression(node.expression).kind === ts.SyntaxKind.ThisKeyword
        && (!node.argumentExpression || !ts.isStringLiteralLike(unwrapExpression(node.argumentExpression)))
      ) {
        throw new Error(`${callable.displayName} must not dynamically index this across repository boundaries`);
      }
      if (isThisPropertyAccess(node, "pool")) {
        const delegateConstructor = poolDelegateConstructor(node);
        if (delegateConstructor) {
          assert.ok(allowedExternalPoolDelegates.has(delegateConstructor),
            `${callable.displayName} passes this.pool to unapproved constructor ${delegateConstructor}`);
          usedExternalPoolDelegates.add(delegateConstructor);
          continue;
        }
        let current = node;
        while (current.parent && (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent))) {
          current = current.parent;
        }
        const access = current.parent
          && (ts.isPropertyAccessExpression(current.parent) || ts.isElementAccessExpression(current.parent))
          && accessReceiver(current.parent) === unwrapExpression(current)
          ? current.parent
          : null;
        assert.ok(access && ["connect", "query"].includes(accessName(access)) && directCallForReference(access),
          `${callable.displayName} must not alias or pass this.pool across repository boundaries`);
      }
      if (!isDirectReferenceNode(node)) continue;
      const symbol = canonicalSymbol(checker, node);
      if (!symbol || !protectedSymbols.has(symbol)) continue;
      assert.ok(directCallForReference(node),
        `${callable.displayName} must invoke ${callableBySymbol.get(symbol).displayName} directly; aliases and bind are forbidden`);
    }
    for (const node of bodyNodes) {
      if (!ts.isCallExpression(node)) continue;
      const target = callableBySymbol.get(callSymbol(checker, node));
      if (!target || !clientCommandSymbols.has(target.symbol)) continue;
      for (const parameterIndex of target.poolClientParameterIndexes) {
        const argument = node.arguments[parameterIndex];
        const argumentSymbol = argument ? expressionSymbol(checker, argument) : null;
        assert.ok(argumentSymbol && allowedClientSymbolsByCallable.get(callable).has(argumentSymbol),
          `${callable.displayName} must pass its owned or caller-supplied PoolClient to ${target.displayName} parameter ${parameterIndex}`);
      }
    }
  }

  const owners = [];
  for (const { callable, connectCall, clientSymbol } of preliminaryOwners) {
    const ownedClientSymbols = new Set([clientSymbol]);
    for (const parameterIndex of callable.poolClientParameterIndexes) {
      const parameter = callable.fn.parameters[parameterIndex];
      if (ts.isIdentifier(parameter.name)) ownedClientSymbols.add(canonicalSymbol(checker, parameter.name));
    }
    const boundaryEvents = [];
    const commandCounts = { begin: 0, commit: 0, rollback: 0 };
    const sessionLockCounts = { lock: 0, unlock: 0 };
    let releaseCount = 0;
    const bodyNodes = descendants(callable.fn.body ?? callable.fn);

    for (const node of bodyNodes) {
      if (!ts.isCallExpression(node)) continue;
      const pathName = controlPath(node, callable.fn);
      if (node === connectCall) {
        boundaryEvents.push(event(pathName, "connect"));
        continue;
      }
      const expression = unwrapExpression(node.expression);
      const name = accessName(expression);
      const receiver = accessReceiver(expression);
      const receiverSymbol = receiver ? expressionSymbol(checker, receiver) : null;
      if (receiverSymbol && ownedClientSymbols.has(receiverSymbol) && name === "query") {
        const argument = node.arguments[0];
        const query = argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
          ? argument.text.trim()
          : null;
        assert.ok(query, `${callable.displayName} boundary queries must use static string literals`);
        const normalized = query.toLowerCase();
        if (normalized === "begin" || normalized === "commit" || normalized === "rollback") {
          commandCounts[normalized] += 1;
          boundaryEvents.push(event(pathName, normalized));
        } else if (/\bpg_advisory_lock\s*\(/iu.test(query)) {
          sessionLockCounts.lock += 1;
          boundaryEvents.push(event(pathName, "session_lock"));
        } else if (/\bpg_advisory_unlock\s*\(/iu.test(query)) {
          sessionLockCounts.unlock += 1;
          boundaryEvents.push(event(pathName, "session_unlock"));
        }
        continue;
      }
      if (receiverSymbol && ownedClientSymbols.has(receiverSymbol) && name === "release") {
        releaseCount += 1;
        boundaryEvents.push(event(pathName, "release"));
        continue;
      }
      if (name === "query" && receiver && isThisPropertyAccess(receiver, "pool")) {
        boundaryEvents.push(event(pathName, "pool_query"));
        continue;
      }
      const target = callableBySymbol.get(callSymbol(checker, node));
      if (target && clientCommandSymbols.has(target.symbol)) {
        boundaryEvents.push(event(pathName, `client_command:${target.displayName}`));
      } else if (target) {
        boundaryEvents.push(event(pathName, `repository_call:${target.displayName}`));
      }
    }

    for (const node of bodyNodes) {
      if (!ts.isIdentifier(node)) continue;
      const symbol = canonicalSymbol(checker, node);
      if (!symbol || !ownedClientSymbols.has(symbol)) continue;
      if (
        (ts.isVariableDeclaration(node.parent) && node.parent.name === node)
        || (ts.isParameter(node.parent) && node.parent.name === node)
      ) continue;
      let current = node;
      while (current.parent && (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent))) current = current.parent;
      const access = current.parent && (ts.isPropertyAccessExpression(current.parent) || ts.isElementAccessExpression(current.parent))
        && current.parent.expression === current
        ? current.parent
        : null;
      if (access && ["query", "release"].includes(accessName(access)) && directCallForReference(access)) continue;
      const call = current.parent && ts.isCallExpression(current.parent) ? current.parent : null;
      if (call) {
        const target = callableBySymbol.get(callSymbol(checker, call));
        const argumentIndex = call.arguments.indexOf(current);
        if (target && target.poolClientParameterIndexes.includes(argumentIndex)) continue;
      }
      throw new Error(`${callable.displayName} uses its PoolClient outside a direct query, release, or exact client-command parameter`);
    }

    const kind = commandCounts.begin > 0
      ? "transaction"
      : sessionLockCounts.lock > 0 || sessionLockCounts.unlock > 0
        ? "session_advisory_lock"
        : "unclassified_connection";
    owners.push({
      callable,
      record: {
        method: callable.displayName,
        kind,
        commandCounts,
        ...(sessionLockCounts.lock > 0 || sessionLockCounts.unlock > 0 ? { sessionLockCounts } : {}),
        releaseCount,
        boundaryEvents
      }
    });
  }

  const ownerBySymbol = new Map(owners.map((owner) => [owner.callable.symbol, owner]));
  function reachableOwners(start) {
    const seen = new Set();
    const reached = new Set();
    const queue = [...(callEdges.get(start) ?? [])];
    while (queue.length > 0) {
      const callable = queue.shift();
      if (seen.has(callable)) continue;
      seen.add(callable);
      if (ownerBySymbol.has(callable.symbol)) reached.add(ownerBySymbol.get(callable.symbol));
      else queue.push(...(callEdges.get(callable) ?? []));
    }
    return [...reached].sort((left, right) => compareText(left.record.method, right.record.method));
  }

  const connectionOwners = owners.map(({ callable, record }) => ({
    ...record,
    reachableConnectionOwners: reachableOwners(callable).map((owner) => owner.record.method)
  })).sort((left, right) => compareText(left.method, right.method));

  const clientScopedCommands = clientCommands.map((command) => ({
    method: command.displayName,
    scope: command.source !== rootSource
      ? command.className === null ? "internal_module_function" : "internal_module_method"
      : command.className === null ? "module_function" : "private_method",
    isPrivate: command.source !== rootSource
      || (command.className === null
        ? !command.declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        : Boolean(command.declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword))),
    clientParameterIndexes: command.poolClientParameterIndexes,
    callers: callables
      .filter((caller) => callEdges.get(caller).has(command))
      .map((caller) => caller.displayName)
      .sort(compareText)
  })).sort((left, right) => compareText(left.method, right.method));

  return {
    version: 2,
    sources: sourceLabels,
    externalPoolDelegates: [...usedExternalPoolDelegates].sort(compareText),
    minimums: {
      connectionOwners: options.minimumConnectionOwners ?? 36,
      clientScopedCommands: options.minimumClientScopedCommands ?? 16
    },
    connectionOwners,
    clientScopedCommands
  };
}

export function validateRepositoryBoundaries(boundaries) {
  assert.ok(boundaries.sources.length > 0, "Repository boundary source inventory must not be empty");
  assert.ok(boundaries.connectionOwners.length >= boundaries.minimums.connectionOwners,
    `Repository boundary coverage fell below ${boundaries.minimums.connectionOwners} connection owners`);
  assert.ok(boundaries.clientScopedCommands.length >= boundaries.minimums.clientScopedCommands,
    `Repository boundary coverage fell below ${boundaries.minimums.clientScopedCommands} client-scoped commands`);
  for (const owner of boundaries.connectionOwners) {
    assert.notEqual(owner.kind, "unclassified_connection",
      `${owner.method} opens a connection without an explicit transaction or balanced session advisory lock`);
    assert.equal(owner.releaseCount, 1, `${owner.method} must release its owned connection exactly once`);
    const events = owner.boundaryEvents.map(eventName);
    const connectIndex = events.indexOf("connect");
    assert.ok(connectIndex >= 0, `${owner.method} must record connection acquisition`);
    assert.ok(events.slice(0, connectIndex).every((item) => item === "pool_query" || item.startsWith("repository_call:")),
      `${owner.method} may only perform mapped repository work before connection acquisition`);
    const releaseIndex = events.indexOf("release");
    assert.ok(releaseIndex > connectIndex, `${owner.method} must release after connection acquisition`);
    assert.ok(events.slice(releaseIndex + 1).every((item) => item === "pool_query" || item.startsWith("repository_call:")),
      `${owner.method} may only perform mapped repository work after releasing its connection`);
    assert.ok(insideControl(owner.boundaryEvents[releaseIndex], "finally"), `${owner.method} must release in finally`);
    if (owner.kind === "transaction") {
      assert.equal(owner.commandCounts.begin, 1, `${owner.method} must begin exactly one transaction`);
      assert.ok(owner.commandCounts.commit >= 1, `${owner.method} must have a commit path`);
      assert.ok(owner.commandCounts.rollback >= 1, `${owner.method} must have a rollback path`);
      for (const boundaryEvent of owner.boundaryEvents.filter((item) => ["begin", "commit"].includes(eventName(item)))) {
        assert.ok(insideControl(boundaryEvent, "try"), `${owner.method} must keep BEGIN and COMMIT in try`);
      }
      assert.ok(owner.boundaryEvents.some((item) => eventName(item) === "rollback" && insideControl(item, "catch")),
        `${owner.method} must retain a catch rollback path`);
      assert.deepEqual(owner.reachableConnectionOwners, [],
        `${owner.method} must not directly or transitively call another connection owner`);
      assert.equal("sessionLockCounts" in owner, false,
        `${owner.method} must not mix a transaction with a session advisory lock`);
    } else {
      assert.deepEqual(owner.commandCounts, { begin: 0, commit: 0, rollback: 0 },
        `${owner.method} mixes session-lock and transaction ownership`);
      assert.deepEqual(owner.sessionLockCounts, { lock: 1, unlock: 1 },
        `${owner.method} must acquire and release its session advisory lock exactly once`);
      assert.equal(owner.reachableConnectionOwners.length, 1,
        `${owner.method} must reach exactly one protected transaction owner`);
      const lockEvent = owner.boundaryEvents.find((item) => eventName(item) === "session_lock");
      const unlockEvent = owner.boundaryEvents.find((item) => eventName(item) === "session_unlock");
      assert.ok(lockEvent && insideControl(lockEvent, "try"), `${owner.method} must acquire its session lock in try`);
      assert.ok(unlockEvent && insideControl(unlockEvent, "finally"), `${owner.method} must release its session lock in finally`);
    }
  }
  for (const command of boundaries.clientScopedCommands) {
    assert.equal(command.isPrivate, true, `${command.method} accepts PoolClient and must remain internal`);
    assert.ok(command.callers.length > 0, `${command.method} accepts PoolClient but has no checked repository caller`);
  }
  return boundaries;
}

export function boundaryDiff(expected, actual) {
  const expectedText = JSON.stringify(expected, null, 2);
  const actualText = JSON.stringify(actual, null, 2);
  return expectedText === actualText ? null : actualText;
}
