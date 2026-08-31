import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeRepositorySources,
  boundaryDiff,
  validateRepositoryBoundaries
} from "./repository-boundaries-lib.mjs";

const fileName = "apps/api/src/repository.pg.ts";
const source = `
  type PoolClient = { query(sql: string): Promise<unknown>; release(): void };
  type DbClient = PoolClient;
  class PgRepository {
    constructor(private readonly pool: { connect(): Promise<PoolClient>; query(sql: string): Promise<unknown> }) {}

    async save(): Promise<void> {
      await this.pool.query("select 42");
      const client = await this.pool.connect();
      try {
        await client.query("begin");
        await this.saveOnClient("value", client);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }

    async serialize(): Promise<void> {
      const lockClient = await this.pool.connect();
      try {
        await lockClient.query("select pg_advisory_lock(1)");
        await this.save();
      } finally {
        await lockClient.query("select pg_advisory_unlock(1)");
        lockClient.release();
      }
    }

    private async saveOnClient(value: unknown, client: DbClient): Promise<void> {
      void value;
      await client.query("select 1");
    }
  }
`;

function analyze(value = source) {
  return analyzeRepositorySources(new Map([[fileName, value]]), {
    minimumConnectionOwners: 2,
    minimumClientScopedCommands: 1
  });
}

describe("repository boundary guard", () => {
  it("maps ordered transaction events, session locks, aliases, and exact client parameters", () => {
    assert.deepEqual(validateRepositoryBoundaries(analyze()), {
      version: 2,
      sources: [fileName],
      externalPoolDelegates: [],
      minimums: { connectionOwners: 2, clientScopedCommands: 1 },
      connectionOwners: [
        {
          method: "save",
          kind: "transaction",
          commandCounts: { begin: 1, commit: 1, rollback: 1 },
          releaseCount: 1,
          boundaryEvents: [
            "root :: pool_query",
            "root :: connect",
            "try :: begin",
            "try :: client_command:saveOnClient",
            "try :: commit",
            "catch :: rollback",
            "finally :: release"
          ],
          reachableConnectionOwners: []
        },
        {
          method: "serialize",
          kind: "session_advisory_lock",
          commandCounts: { begin: 0, commit: 0, rollback: 0 },
          sessionLockCounts: { lock: 1, unlock: 1 },
          releaseCount: 1,
          boundaryEvents: [
            "root :: connect",
            "try :: session_lock",
            "try :: repository_call:save",
            "finally :: session_unlock",
            "finally :: release"
          ],
          reachableConnectionOwners: ["save"]
        }
      ],
      clientScopedCommands: [
        {
          method: "saveOnClient",
          scope: "private_method",
          isPrivate: true,
          clientParameterIndexes: [1],
          callers: ["save"]
        }
      ]
    });
  });

  it("makes command order and control placement part of the exact fixture", () => {
    const moved = analyze(source.replace(
      'await this.saveOnClient("value", client);\n        await client.query("commit");',
      'await client.query("commit");\n        await this.saveOnClient("value", client);'
    ));
    assert.match(boundaryDiff(analyze(), moved), /commit[\s\S]*client_command:saveOnClient/u);
    const poolQueryMoved = analyze(source
      .replace('await this.pool.query("select 42");\n      ', "")
      .replace('await client.query("begin");', 'await client.query("begin");\n        await this.pool.query("select 42");'));
    assert.match(boundaryDiff(analyze(), poolQueryMoved), /begin[\s\S]*pool_query/u);
    const deadBranchCommit = analyze(source.replace(
      'await client.query("commit");',
      'if (false) await client.query("commit");'
    ));
    assert.match(boundaryDiff(analyze(), deadBranchCommit), /if\.then :: commit/u);
    assert.throws(
      () => validateRepositoryBoundaries(analyze(source.replace(
        "} finally {\n        client.release();\n      }",
        "client.release();\n      } finally {}"
      ))),
      /save must release in finally/u
    );
    assert.throws(
      () => validateRepositoryBoundaries(analyze(source
        .replace('await client.query("commit");', 'await client.query("rollback");')
        .replace('await client.query("rollback");\n        throw error;', 'await client.query("commit");\n        throw error;'))),
      /save must keep BEGIN and COMMIT in try|save must retain a catch rollback path/u
    );
  });

  it("rejects indirect, optional, bracketed-extra, and nested owner escapes", () => {
    assert.throws(
      () => analyze(source.replace(
        "const client = await this.pool.connect();",
        "const acquire = this.pool.connect.bind(this.pool);\n      const client = await acquire();"
      )),
      /must invoke connect directly/u
    );
    assert.throws(
      () => analyze(source.replace(
        "const client = await this.pool.connect();",
        "const pool = this.pool;\n      const client = await pool.connect();"
      )),
      /must not alias this or this\.pool/u
    );
    assert.throws(
      () => analyze(source.replace(
        "const client = await this.pool.connect();",
        'const pool = this["pool"];\n      const client = await pool["connect"]();'
      )),
      /must not alias this or this\.pool/u
    );
    assert.throws(
      () => analyze(source.replace(
        "const client = await this.pool.connect();",
        "const { connect } = this.pool;\n      const client = await connect();"
      )),
      /must not destructure connect|must invoke connect directly/u
    );
    assert.throws(
      () => analyze(source.replace(
        "const client = await this.pool.connect();",
        'const client = await Reflect.get(this.pool, "connect").call(this.pool);'
      )),
      /must not alias or pass this\.pool/u
    );
    assert.equal(
      validateRepositoryBoundaries(analyze(source.replace("this.pool.connect()", 'this.pool["connect"]()')))
        .connectionOwners.length,
      2
    );
    assert.equal(
      boundaryDiff(analyze(), analyze(source.replace('this.pool.query("select 42")', 'this["pool"]["query"]("select 42")'))),
      null
    );
    assert.throws(
      () => analyze(source.replace("this.pool.connect()", "this.pool?.connect()")),
      /must not use optional connection acquisition/u
    );
    assert.throws(
      () => validateRepositoryBoundaries(analyze(source.replace(
        "client.release();",
        'client.release(); client["release"]();'
      ))),
      /save must release its owned connection exactly once/u
    );
    assert.throws(
      () => validateRepositoryBoundaries(analyze(source.replace(
        'await this.saveOnClient("value", client);',
        'await this["serialize"]();'
      ))),
      /save must not directly or transitively call another connection owner/u
    );
    assert.throws(
      () => analyze(source.replace(
        'await this.saveOnClient("value", client);',
        "const nested = this.serialize.bind(this);\n        await nested();"
      )),
      /must invoke serialize directly; aliases and bind are forbidden/u
    );
  });

  it("binds the owned client to the command's exact aliased PoolClient parameter", () => {
    assert.throws(
      () => analyze(source.replace(
        'this.saveOnClient("value", client)',
        'this.saveOnClient("value", {} as DbClient)'
      )),
      /save must pass its owned or caller-supplied PoolClient to saveOnClient parameter 1/u
    );
    assert.throws(
      () => analyze(source.replace(
        'this.saveOnClient("value", client)',
        "this.saveOnClient(client, client)"
      )),
      /save uses its PoolClient outside a direct query, release, or exact client-command parameter/u
    );
  });

  it("makes the sole external pool delegation explicit", () => {
    const withDelegate = source
      .replace("  class PgRepository {", "  class ExternalRepository { constructor(pool: unknown) { void pool; } }\n  class PgRepository {")
      .replace("    async save(): Promise<void> {", "    delegate(): void { new ExternalRepository(this.pool); }\n\n    async save(): Promise<void> {");
    assert.throws(() => analyze(withDelegate), /passes this\.pool to unapproved constructor ExternalRepository/u);
    const actual = validateRepositoryBoundaries(analyzeRepositorySources(
      new Map([[fileName, withDelegate]]),
      {
        allowedExternalPoolDelegates: ["ExternalRepository"],
        minimumConnectionOwners: 2,
        minimumClientScopedCommands: 1
      }
    ));
    assert.deepEqual(actual.externalPoolDelegates, ["ExternalRepository"]);
  });

  it("discovers arrow owners and fails closed on lost source coverage", () => {
    const withArrow = analyze(source.replace(
      "private async saveOnClient",
      `extra = async (): Promise<void> => {
        const client = await this.pool.connect();
        try { await client.query("begin"); await client.query("commit"); }
        catch (error) { await client.query("rollback"); throw error; }
        finally { client.release(); }
      };

    private async saveOnClient`
    ));
    assert.ok(withArrow.connectionOwners.some((owner) => owner.method === "extra"));
    const empty = { ...analyze(), connectionOwners: [], clientScopedCommands: [] };
    assert.throws(() => validateRepositoryBoundaries(empty), /coverage fell below 2 connection owners/u);
  });

  it("tracks transitive calls and treats checked extracted commands as internal", () => {
    const extractedFile = "apps/api/src/repository.pg/save-command.ts";
    const extracted = `
      export type PoolClient = { query(sql: string): Promise<unknown> };
      export async function inner(client: PoolClient): Promise<void> {
        await client.query("select 1");
      }
      export async function outer(client: PoolClient): Promise<void> {
        await inner(client);
      }
    `;
    const repository = source
      .replace("type PoolClient = { query(sql: string): Promise<unknown>; release(): void };", "type PoolClient = import('./repository.pg/save-command.js').PoolClient & { release(): void };")
      .replace('await this.saveOnClient("value", client);', "await outer(client);")
      .replace("  class PgRepository {", "  import { outer } from './repository.pg/save-command.js';\n  class PgRepository {")
      .replace(`
    private async saveOnClient(value: unknown, client: DbClient): Promise<void> {
      void value;
      await client.query("select 1");
    }
`, "");
    const actual = validateRepositoryBoundaries(analyzeRepositorySources(
      new Map([[fileName, repository], [extractedFile, extracted]]),
      { minimumConnectionOwners: 2, minimumClientScopedCommands: 2 }
    ));
    const outer = actual.clientScopedCommands.find((command) => command.method.endsWith("#outer"));
    const inner = actual.clientScopedCommands.find((command) => command.method.endsWith("#inner"));
    assert.deepEqual(outer, {
      method: `${extractedFile}#outer`,
      scope: "internal_module_function",
      isPrivate: true,
      clientParameterIndexes: [0],
      callers: ["save"]
    });
    assert.deepEqual(inner, {
      method: `${extractedFile}#inner`,
      scope: "internal_module_function",
      isPrivate: true,
      clientParameterIndexes: [0],
      callers: [`${extractedFile}#outer`]
    });
  });

  it("reports source-inventory and boundary drift", () => {
    const actual = analyze();
    assert.equal(boundaryDiff(actual, structuredClone(actual)), null);
    const changed = structuredClone(actual);
    changed.sources.push("apps/api/src/repository.pg/new-command.ts");
    assert.match(boundaryDiff(actual, changed), /new-command\.ts/u);
  });
});
