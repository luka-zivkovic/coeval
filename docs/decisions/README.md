# Rubrist architecture decisions

ADRs record product and architecture choices that refine `PRODUCT.md`.

Status meanings:

- **Accepted:** authoritative until superseded by another accepted ADR.
- **Proposed:** recommended direction awaiting founder review; do not build new
  runtime behavior that depends on it.
- **Superseded:** retained for history, with a link to its replacement.

## Index

- [0001 — Evidence contract ownership and versioning](0001-evidence-contract-ownership-and-versioning.md) — Accepted; ADR-0014 narrowly supersedes its compatibility window for the pre-launch v1 to v2 transition, and its new-version rule for the pre-launch v1 baseline (decision 7)
- [0002 — Human truth and dataset revisions](0002-human-truth-and-dataset-revisions.md) — Accepted
- [0003 — Receipt evolution and immutability](0003-receipt-evolution-and-immutability.md) — Accepted; ADR-0014 decision 7 narrowly supersedes its frozen v1 wire contract before launch
- [0004 — Calibration semantics](0004-calibration-semantics.md) — Accepted
- [0005 — Policy-free evaluator suites](0005-policy-free-evaluator-suites.md) — Accepted
- [0006 — Receipt artifact storage, historical freeze, and legacy gate removal](0006-receipt-artifact-storage-and-freeze.md) — Accepted
- [0007 — Dataset-role compatibility and exposure](0007-dataset-role-compatibility-and-exposure.md) — Accepted; ADR-0011 narrowly supersedes its pre-launch rolling-deployment late-pinning path
- [0008 — Governed human truth and sealed collection](0008-governed-human-truth-and-sealed-collection.md) — Accepted; ADR-0011 narrowly supersedes its pre-launch unresolved historical-identity path
- [0009 — Binary calibration artifact contract](0009-binary-calibration-artifact-contract.md) — Accepted; ADR-0014 narrowly supersedes the calibration v1 compatibility window for the pre-launch v1 to v2 transition, and its accepted contract file for the pre-launch v1 baseline (decision 7)
- [0010 — Representative analysis and taxonomy lifecycle](0010-representative-analysis-and-taxonomy-lifecycle.md) — Accepted
- [0011 — Pre-launch blank-slate database policy](0011-prelaunch-blank-slate-database-policy.md) — Accepted; clean-install policy remains active for founder-only disposable testing; ADR-0014 decision 7 narrowly supersedes its frozen-schema rule before launch
- [0012 — Rename Coeval to Rubrist](0012-rename-coeval-to-rubrist.md) — Accepted
- [0013 — Production outcome monitoring](0013-production-outcome-monitoring.md) — Accepted
- [0014 — Model-agnostic evaluator execution and evidence v2](0014-model-agnostic-evaluator-execution.md) — Accepted
