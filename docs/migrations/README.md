# Database change policy

Coeval is pre-launch and has no supported upgrade path between development
schemas. The current database is defined by
`packages/db/migrations/0001_baseline.sql`; development databases are dropped
and recreated when that baseline changes.

The former 0048–0055 rollout, preflight, compatibility, and rollback runbooks
were removed when [ADR-0011](../decisions/0011-prelaunch-blank-slate-database-policy.md)
was accepted. Their history remains available in Git and must not be used as
current operator guidance. The one-time old-chain-to-baseline schema audit is
recorded in [0001-baseline-verification.md](0001-baseline-verification.md).
