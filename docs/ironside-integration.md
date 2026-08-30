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
different project requires a new connection.

## Import correctness

Ironside owns quiet-period settlement. Coeval consumes
`GET /api/v1/evaluator/traces` using the returned opaque cursor and fetches each
item by `(traceId, traceVersion)`. Coeval stores that pair as the source
identity, so a reopened trace creates a new immutable case snapshot instead of
being discarded as a duplicate.

If a trace reopens between listing and detail retrieval, Ironside returns 409.
Coeval skips that obsolete version and continues: Ironside publishes the newer
settled version as a subsequent feed activity. A 404 is also skipped because
retention may remove a trace between list and detail. Cursor state is committed
only after imported cases have durable judging work. Poll requests have a
15-second transport timeout, and one import job yields after 100 pages or a
30-second aggregate budget (plus at most the one in-flight request timeout) so
an upstream that keeps returning empty changing pages cannot monopolize a
worker. Yielding partway through a page retains that page's starting cursor;
exact source dedupe makes its already-visited prefix safe to replay.

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
re-enabled. Imports never run under a synthetic remote identity.

Only one verified Ironside connection may exist per Coeval project. Repeating
the create request returns 409; credential rotation uses update, and changing
to another remote project requires disconnecting first. This keeps historical
case writeback attached to the original remote.

For rollout, apply the Coeval migration before starting upgraded API and worker
processes. Upgrade Ironside's migration and feed-writing worker before exposing
its evaluator API, then upgrade Coeval. An old Ironside does not advertise the
v1 context route; connection tests fail closed rather than silently using the
LangFuse compatibility path.

## Assessment writeback

Recorded assessments are written to `POST /api/v1/evaluator/scores` with a
stable feedback job ID, the original Ironside trace ID, the exact Coeval
evaluator version, and the criterion stable key. Score names use
`coeval_assessment/<criterion-key>` so multiple single-criterion evaluators do
not overwrite one another. Coeval bounds the diagnostic comment to Ironside's
20,000-character contract while retaining the stable score ID for retries.

The connection transport does not define release thresholds, promotion,
blocking, rollout, or deployment policy.
