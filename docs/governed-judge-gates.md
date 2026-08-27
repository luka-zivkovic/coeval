# Governed judge correctness gates

## Adversarial evidence boundary

Judge execution treats the rubric, verdict protocol, and provider-enforced
tool schema as trusted control data. Trace input, output, metadata, and steps
are untrusted evidence. The central builder therefore:

1. sends the fixed protocol, governed judging skill, and verdict instructions
   through the provider's system channel;
2. sends only trace evidence through the user channel;
3. recursively sorts JSON object keys and preserves array order;
4. escapes `<`, `>`, `&`, U+2028, and U+2029 in JSON strings so evidence
   cannot open or close the surrounding data envelope; and
5. fails closed on cycles, non-finite numbers, and other non-JSON values.

Provider tool choice remains forced and its schema stays out of the trace
message. The adversarial suite covers delimiter-closing strings, fake
system/developer roles, verdict and tool-schema overrides, prompt-exfiltration
requests, encoded instructions, multilingual instructions, semantic JSON
round-trips, and deterministic prompt bytes. These tests enforce the
instruction/data boundary; they do not claim that an LLM is mathematically
immune to every possible adversarial string.

## Postgres migration and invariant gate

GitHub CI runs the full suite with PostgreSQL 17. Collection guards reject a CI
run without `PG_SMOKE_DATABASE_URL`, so database coverage cannot silently
become `describe.skip`.

The database suite migrates the current clean baseline into an isolated
database or schema per test, exercises repository and auth flows, and verifies
constraints including release-evidence
receipt identity: general eval runs retain unique `(eval_run_id, case_id)`,
while release-evidence rows may share a case only when they have distinct
`client_item_id` values.

To run the same gate locally with an automatically managed disposable
PostgreSQL 17 container:

```bash
pnpm test:pg
```
