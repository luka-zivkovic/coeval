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

## Upgrade reconciliation

Migration `0002_ironside_trace_versions` resets legacy native-import cursors so
the first upgraded poll uses Ironside's bounded bootstrap instead of sending an
old cursor shape to the v1 endpoint. Historical imports do not have a truthful
`traceVersion`; the migration deliberately leaves it null.

On the first native version for a historical trace, Coeval compares the
normalized imported content. Identical content records the cutover version on
the existing case without pretending the legacy snapshot had that provenance.
Changed content creates a new immutable case. Later versions always create or
deduplicate by the full native source identity.

Legacy connections are quarantined with polling disabled because the old
contract did not persist a verifiable remote project identity. An owner must
run the connection test once; a successful v1 context check atomically stores
the protocol, remote project, and settlement settings. Polling can then be
re-enabled from the integration card. Imports never run under a synthetic
remote identity, and enabling polling is unavailable until the latest
connection test succeeds.

Migration `0003_ironside_revalidation_hardening` clears legacy test success and
polling state for every connection that still requires revalidation. The API,
poll scheduler, and UI all enforce the same flag. A credential or URL cannot be
changed while that flag is set; revalidate the unchanged connection or
disconnect it explicitly. Remote-mismatch quarantine uses the expected stored
identity and a monotonic connection revision as compare-and-set guards, so a
stale worker cannot undo a newer successful revalidation. Feedback writeback
that encounters quarantine is parked durably rather than exhausted through the
queue retry budget; the next successful connection test re-enqueues those jobs
with their original idempotent feedback ids.

Only one verified Ironside connection may exist per Coeval project. Repeating
the create request returns 409; credential rotation uses update, and changing
to another remote project requires disconnecting first. This keeps historical
case writeback attached to the original remote.

For rollout, apply the Coeval migration before starting upgraded API and worker
processes. On Ironside, stop the old workers, drain or reconcile their pending
ingest intents, apply the feed migrations, and complete the feed-writing worker
deployment before exposing its evaluator API; then upgrade Coeval. Running old
and new Ironside workers together is not sufficient because an old worker can
materialize a queued trace without publishing it. An old Ironside does not
advertise the v1 context route; connection tests fail closed rather than
silently using the LangFuse compatibility path.

## Assessment writeback

Recorded assessments are written to `POST /api/v1/evaluator/scores` with a
stable feedback job ID, the original Ironside trace ID, the exact Coeval
evaluator version, and the criterion stable key. Score names use
`coeval_assessment/<criterion-key>` so multiple single-criterion evaluators do
not overwrite one another. Coeval bounds the diagnostic comment to Ironside's
20,000-character contract while retaining the stable score ID for retries.

The connection transport does not define release thresholds, promotion,
blocking, rollout, or deployment policy.
