# ADR-0005: Policy-free evaluator suites

Status: **Accepted**

Date: 2026-08-22

## Context

Real AI applications have several quality dimensions. Combining them inside
one judge prompt or one composite score makes calibration ambiguous and can
smuggle release policy into Coeval. Conversely, leaving every evaluator
unrelated makes it difficult to reproduce which set was applied together.

## Decision

One evaluator measures one named criterion. Coeval may group evaluators in a
versioned, policy-free suite whose identity pins:

- criterion identity and definition;
- evaluator version and output contract for each criterion;
- membership and deterministic ordering;
- applicability rules; and
- an optional repeated-trial plan.

Coeval emits separately verifiable assessment and calibration evidence per
criterion. A suite run groups those artifacts under a pinned suite identity;
it does not collapse them into one pass rate, weighted score, or release
decision.

Coeval does not mark suite criteria mandatory, advisory, compensatory, or
blocking for a release. Dailies maps criterion evidence to those policy roles.
The first interoperable contract therefore uses a suite manifest plus separate
criterion evidence rather than a suite-level verdict receipt.

Incomplete evidence remains attributable to the affected criterion. Another
criterion's result cannot make missing evidence complete.

## Consequences

- Each quality claim can be calibrated against the corresponding human truth.
- Suites are reproducible without owning customer release policy.
- Dailies can apply different non-compensatory or advisory policies to the same
  Coeval evidence.
- A future compact suite receipt must preserve criterion-level identity and
  semantics and requires a new versioned contract decision.
