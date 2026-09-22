# Native Ironside integration

Coeval integrates with Ironside through the versioned `ironside/evaluator/v1`
machine contract. The native path is independent of deployment topology: the
Ironside URL may be a Coolify deployment, another container platform, or a
managed installation.

## Connection

An Ironside **Integration** credential must grant `traces:read` and
`scores:write`. Before Coeval stores it, Coeval calls
`GET /api/v1/evaluator/context` and records the protocol version and remote
project identity. Rotating the URL or credential preserves the import cursor
only when the replacement resolves to the same Ironside project. Moving to a
different project requires a new connection. Every import and assessment
writeback rechecks the live remote identity before using the credential. A
mismatch atomically disables polling, marks the connection for revalidation,
and records the failed test instead of importing from or writing to the wrong
project.

## Import correctness

Ironside owns quiet-period settlement. Coeval consumes
`GET /api/v1/evaluator/traces` using the returned opaque cursor and fetches each
item by `(traceId, traceVersion)`. Coeval stores that pair as the source
identity, so a reopened trace creates a new immutable case snapshot instead of
being discarded as a duplicate. Detail responses must echo both the requested
trace ID and version; either mismatch fails before the feed cursor can commit.

If a trace reopens, is retained away, or becomes unsettled between listing and
detail retrieval, Ironside returns 404 or 409. Coeval retains the page-start
cursor and yields. Exact source dedupe makes the already imported prefix safe
to replay; the next list either exposes the settled version or advances past a
retention orphan. This also prevents a quiet-period configuration increase from
silently skipping a trace that produces no new feed activity. Cursor state is
committed only after imported cases have durable judging work. Poll requests have a
15-second transport timeout, and one import job yields after 100 pages or a
30-second aggregate budget (plus at most the one in-flight request timeout) so
an upstream that keeps returning empty changing pages cannot monopolize a
worker. Yielding partway through a page retains that page's starting cursor;
exact source dedupe makes its already-visited prefix safe to replay.
Concurrent workers update the opaque cursor with compare-and-set semantics, so
a slower stale run cannot move the connection behind a cursor already saved by
a newer run.

Coeval does not silently flatten only part of a trace. A detail tree exceeding
the current 50-observation case limit is logged and skipped explicitly, with no
assessment scheduled over incomplete context.

Before PostgreSQL storage, Coeval applies an injective encoding to NUL and
unpaired UTF-16 surrogate code units across payload values, object keys, and
observation names. Literal escape-looking input remains distinct, so valid
upstream strings cannot poison a cursor or collide during normalization.

Source identity is `(remote project, traceId, traceVersion)`, including after a
disconnect and later reconnect. This prevents colliding IDs in two Ironside
projects from aliasing one another.

## Connection recovery

The API, poll scheduler, and UI all enforce the runtime revalidation flag. A
credential or URL cannot be changed while that flag is set; revalidate the
unchanged connection or disconnect it explicitly. Remote-mismatch quarantine
uses the expected stored
identity and a monotonic connection revision as compare-and-set guards, so a
stale worker cannot undo a newer successful revalidation. Feedback writeback
that encounters quarantine is parked durably rather than exhausted through the
queue retry budget; the next successful connection test re-enqueues those jobs
with their original idempotent feedback ids.

Only one verified Ironside connection may exist per Coeval project. Repeating
the create request returns 409; credential rotation uses update, and changing
to another remote project requires disconnecting first. This keeps historical
case writeback attached to the original remote.

## Trace links

Status: **CURRENT**. Both directions are read-only navigation; neither imports,
writes back, nor creates evidence.

### Into Coeval from Ironside

Ironside's trace viewer links to one shared, stable route:

```text
/links/trace?source=ironside&project=<ironside project id>&trace=<traceId>&version=<traceVersion, optional>
```

The shape is a contract with Ironside; change it only together with Ironside's
link builder. `parseTraceDeepLink` in `@coeval/shared` validates it strictly:
`source` must be `ironside` (any other value renders a 400-style "can't open
this link" page), `project` and `trace` are 1–500 characters with no
surrounding whitespace or control characters, `version` is an ISO-8601 instant
with an offset and is matched exactly, and repeating a recognized parameter is
invalid. An empty `version` is treated as omitted; unrelated parameters are
ignored.

The web page calls `GET /api/links/trace` with the same query. The resolver
matches the import source identity `(remote project, traceId, traceVersion)`
across **every project the signed-in user is a member of**, so it is exempt
from the usual single-project pin and filters by membership itself; a pinned
`x-coeval-project` header neither narrows nor widens it. Without a `version`,
each project's newest imported version is the match.

- Exactly one member project holds the trace: the page selects that project
  and replaces itself with the case page, `/cases/<caseId>`.
- More than one does: the page lists the projects and the user picks.
- None does: the page says the trace (or that version) has not been imported
  yet. It lists other imported versions of the same trace, if any, and each
  member project already connected to that Ironside project with that
  connection's existing **Import now** action, which runs the ordinary
  cursor-based import with the connection's own polling criterion. A
  connection that needs revalidation or has no polling criterion sends the
  user to Integrations instead. With no connection, the page explains that a
  project owner connects Ironside from Integrations; no new import pathway
  exists for links.

Unauthenticated visitors get the normal login screen; signing in reloads the
same URL and continues. The route sits outside the project-scoped layout so no
project provider loads before a project is chosen.

### Back to Ironside from Coeval

A case imported through the native connection shows **View in Ironside**,
linking to Ironside's viewer route `/projects/<project id>/traces/<traceId>`.
That pattern lives only in `ironsideTraceViewerUrl` in `@coeval/shared`.
`GET /api/cases/:caseId/source-link` builds the URL from the case's stored
source identity and the project's current connection to that remote project.
The base is the connection's optional **Ironside web URL** — set at connect
time or later with **Set web URL** on the Integrations card, for deployments
whose web app and API have different addresses — falling back to the
deployment (API) URL. Only `http`/`https` bases produce a link. After a
disconnect, no base remains and the case notes that the Ironside source has no
current connection. The viewer link names the trace, not the version: Ironside
shows its current version of that trace.

## Assessment writeback

Recorded assessments are written to `POST /api/v1/evaluator/scores` with a
stable feedback job ID, the original Ironside trace ID, the exact Coeval
evaluator version, and the criterion stable key. Score names use
`coeval_assessment/<criterion-key>` so multiple single-criterion evaluators do
not overwrite one another. Coeval bounds the diagnostic comment to Ironside's
20,000-character contract while retaining the stable score ID for retries.

The connection transport does not define release thresholds, promotion,
blocking, rollout, or deployment policy.
