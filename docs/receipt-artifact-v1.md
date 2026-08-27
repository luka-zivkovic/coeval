# Assessment receipt artifact v1

Status: **accepted Batch 1A storage contract**

The receipt body remains the closed
[`coeval/assessment-receipt/v1`](../contracts/assessment-receipt-v1.md) wire
contract. This document specifies how Coeval preserves and serves those exact
bytes; it does not add fields to receipt v1.

## Stored artifact

`assessment_receipt_artifacts` stores one append-only lineage per terminal
`release_evidence` eval run:

| Field | Contract |
| --- | --- |
| `id` | Stable artifact identity. |
| `project_id`, `eval_run_id` | Owning assessment identity. |
| `receipt_id` | Receipt v1 identity; unique across artifacts. |
| `contract_version` | Positive integer; Batch 1A writes `1`. |
| `artifact_revision` | Positive lineage revision; root is `1`. |
| `canonical_bytes` | Exact canonical UTF-8 receipt bytes as `bytea`. |
| `artifact_digest` | `sha256:` digest over all `canonical_bytes`. |
| `evidence_digest` | Receipt v1 `evidenceDigest`. |
| `source_snapshot_digest` | Digest of the source rows observed at mint/freeze; for a correction, digest of the governed correction artifact supplied to the append operation. |
| `source_kind` | `terminal_mint`, `historical_freeze`, or `correction`. |
| `predecessor_artifact_id` | Null only for the root; corrections link backward. |
| `correction_reason` | Required only for a correction. |
| `created_by_user_id`, `created_at` | Artifact provenance outside receipt v1. |

Unique constraints enforce one revision and one receipt identity. Database
triggers reject mutation or direct deletion while the project exists. Project
deletion is the explicit erasure boundary.

`assessment_receipt_comparisons` retains an optional consumer-held byte copy,
its digest, and `match|diverged` result against one persisted artifact. It is
append-only and deduplicated by artifact plus consumer byte digest.

The comparison endpoint accepts canonical receipt bytes. Before Batch 1A the
HTTP endpoint serialized a receipt as ordinary JSON, so a consumer that kept
those raw response bytes must parse and re-canonicalize the receipt according
to [`contracts/assessment-receipt-v1.md`](../contracts/assessment-receipt-v1.md)
before submitting it. The evidence and dataset digests remain unchanged by
that representation-only step.

## State machine

```text
non-release run ───────────────────────────────► unavailable

release run, pending/running ─────────────────► nonterminal (no receipt)
          │
          ├─ terminal transition, no artifact ─► mint root atomically
          │                                      source=terminal_mint
          │
          └─ already terminal before Batch 1A ─► freeze root once on read/admin path
                                                 source=historical_freeze

root artifact ── read ─────────────────────────► return stored root bytes
      │
      ├─ compare consumer copy ────────────────► append match/diverged comparison
      │
      └─ governed correction ──────────────────► append successor revision
                                                  root bytes remain unchanged
```

## Terminal-mint truth table

| Run | Existing root | Operation | Result |
| --- | --- | --- | --- |
| Non-release | any | receipt read/mint | Reject as unavailable. |
| Release, nonterminal | none | GET or comparison | Reject; mint nothing. |
| Release, newly terminal | none | item/create transaction | Insert revision 1 in the same transaction. |
| Release, historical terminal | none | first GET/comparison | Insert revision 1 under run lock with `historical_freeze`. |
| Release, terminal | root exists | any concurrent mint/read | Reuse exact stored root. |
| Release, terminal | root exists | source rows later change | Return unchanged stored bytes. |

## Correction truth table

| Candidate | Result |
| --- | --- |
| Unknown project/run or non-release run | Reject. |
| Invalid v1 schema or evidence digest | Reject. |
| Different `projectId` or `evalRunId` | Reject identity swap. |
| Reused `receiptId` | Reject. |
| Valid correction with a reason | Append next revision linked to current latest artifact. |
| Retry of the same correction receipt | Return the existing artifact idempotently. |

## API behavior

- `GET /api/v1/eval-runs/:evalRunId/assessment-receipt` returns the exact root
  bytes. It lazily freezes a historical terminal run and returns `409` for a
  nonterminal run.
- `GET /api/v1/assessment-receipts/:receiptId` returns the exact bytes for a
  root or successor identity in the caller's project.
- `POST /api/v1/eval-runs/:evalRunId/assessment-receipt/comparisons` accepts a
  base64-encoded exact consumer copy, freezes the historical root if needed,
  validates receipt identity/integrity, and records `match` or `diverged`.

Correction creation remains an internal governed repository operation in Batch
1A. It is not exposed as an API-key route. An operator can pre-freeze a
historical terminal run by reading its root endpoint before rollout.

No route emits release thresholds, deployment policy, or ship/hold state.
