# Assessment receipt artifact v1

Status: **accepted Batch 1A storage contract**

The receipt body is the closed
[`rubrist/assessment-receipt/v2`](../contracts/assessment-receipt-v2.md) wire
contract, which replaced receipt v1 in Batch 8D (Rubrist ADR-0014). This
document specifies how Rubrist preserves and serves those exact bytes; it does
not add fields to the receipt.

## Stored artifact

`assessment_receipt_artifacts` stores one append-only lineage per terminal
`release_evidence` eval run:

| Field | Contract |
| --- | --- |
| `id` | Stable artifact identity. |
| `project_id`, `eval_run_id` | Owning assessment identity. |
| `receipt_id` | Receipt identity; unique across artifacts. |
| `contract_version` | The receipt's `schemaVersion`; every artifact holds receipt v2 and writes `2`. |
| `artifact_revision` | Positive lineage revision; root is `1`. |
| `canonical_bytes` | Exact canonical UTF-8 receipt bytes as `bytea`. |
| `artifact_digest` | `sha256:` digest over all `canonical_bytes`. |
| `evidence_digest` | Receipt `evidenceDigest`. |
| `source_snapshot_digest` | Digest of the source rows observed at mint/freeze (the run, its items, the evaluator version, and each completed item's verdict); for a correction, digest of the governed correction artifact supplied to the append operation. |
| `source_kind` | `terminal_mint`, `historical_freeze`, or `correction`. |
| `predecessor_artifact_id` | Null only for the root; corrections link backward. |
| `correction_reason` | Required only for a correction. |
| `created_by_user_id`, `created_at` | Artifact provenance outside the receipt. |

Unique constraints enforce one revision and one receipt identity. Database
triggers reject mutation or direct deletion while the project exists. Project
deletion is the explicit erasure boundary.

`assessment_receipt_comparisons` retains an optional consumer-held byte copy,
its digest, and `match|diverged` result against one persisted artifact. It is
append-only and deduplicated by artifact plus consumer byte digest.

The comparison endpoint accepts canonical receipt bytes, as
[`contracts/assessment-receipt-v2.md`](../contracts/assessment-receipt-v2.md)
defines them.

## Item evidence

Each outcome in a receipt carries its verdict's evaluator score and what its
call observed, so a mint reads the verdict of every completed item. Nothing is
synthesized for a verdict that recorded no observation: such an item can't be
minted. Two rules keep that from happening:

- release evidence is judged only by the bound evaluator, never by the
  demo's heuristic fallback, so an item without the evaluator's credential is
  not attempted;
- a release batch reuses a recorded verdict only when it states its call's
  observation.

A failed item records its failure kind and observation, or that it was never
attempted, and a pending item of a run that ended is not attempted.

An outcome is the verdict's label, as Rubrist labels every verdict: a binary
verdict passes, fails, or abstains, and a scalar or categorical verdict is
labelled by where its comparable score falls, passing at two thirds or above,
failing at one third or below, and abstaining between. Receipt v1 recorded the
same labels.

A recorded observation holds only what a receipt can carry: bounded text with
no lone surrogate, and an upstream provider only for an OpenRouter binding.
The executor records an upstream from an OpenRouter response or error body;
another provider's error metadata stays diagnostic detail and never becomes
evidence. So recording a call can never leave a run unable to mint its
receipt.

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
| Invalid receipt v2 schema, semantic rule, or evidence digest | Reject. |
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
