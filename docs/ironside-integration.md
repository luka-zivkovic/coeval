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
settled version as a subsequent feed activity. Cursor state is committed only
after imported cases have durable judging work.

## Assessment writeback

Recorded assessments are written to `POST /api/v1/evaluator/scores` with a
stable feedback job ID, the original Ironside trace ID, the exact Coeval
evaluator version, and the criterion stable key. Score names use
`coeval_assessment/<criterion-key>` so multiple single-criterion evaluators do
not overwrite one another.

The connection transport does not define release thresholds, promotion,
blocking, rollout, or deployment policy.
