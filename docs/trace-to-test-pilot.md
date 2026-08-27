# Trace-to-test pilot protocol

Status: release protocol for milestone [#157](https://github.com/luka-zivkovic/coeval/issues/157),
implemented in hardening batch [#164](https://github.com/luka-zivkovic/coeval/issues/164).

## Decision to make

The pilot answers one question: can a person who is new to evals turn a prepared
conversation into a trustworthy, rerunnable test without learning Coeval's
internal data model?

Do not use the pilot to choose clustering, bulk creation, CI policy, arbitrary
agent replay, or advanced checker controls. Those remain follow-up products.

## Participants and fixtures

Recruit at least five design-partner participants who have not used the
trace-to-test flow. Give each participant the same three redacted fixtures:

1. Harmful response: an assistant promises a refund without checking policy.
   The participant should create a test that makes the promise fail and a
   policy-qualified answer pass.
2. Useful response: an assistant verifies account ownership before recovery.
   The participant should preserve that behavior and make an unsafe answer
   fail.
3. Incorrect Coeval verdict: Coeval fails a correct, policy-qualified answer.
   The participant should record an evaluator correction without creating a
   product test.

Use real production UI with fixture-backed provider outcomes. Redact names,
credentials, account values, and other customer content before the session.

## Session procedure

For each fixture:

1. Start on the conversation screen and ask the participant to make the
   behavior safe to check again. Do not explain product terminology.
2. Start timing when they open the trace-to-test journey. Stop at **Test
   enabled** or **Correction recorded**.
3. Ask them to explain, in their own words, what the two validation rows prove.
4. For product tests, ask them to choose **Run now**, read the result, open the
   exact saved evidence, and return to the conversation.
5. Record requested assistance, backtracking, errors, misunderstood words, and
   whether the participant thought a suggested draft was already trusted.
6. On one fixture, ask them to leave and return. Confirm saved drafts resume,
   completed conversations show a concise protected state, and a dismissed
   first-run prompt does not reappear.

Test once at desktop width and once at 390 px. Complete one journey with only a
keyboard and a screen reader's heading/live-region navigation.

## Release criteria

Ship the beginner flow to a wider cohort only when all are true:

- At least 80% of prepared product-test journeys reach enablement in under
  three minutes; report median and 90th percentile separately.
- At least 90% reach the correct receipt without moderator intervention.
- Every participant can distinguish a product test from an evaluator
  correction after completing both paths.
- At least 80% correctly explain **Passed**, **Regressed**, **Needs review**,
  and **Could not run**; nobody classifies a provider/runtime failure as a
  behavior regression.
- Nobody treats generated suggestions as trusted evidence before checking the
  should-fail and should-pass examples.
- No cross-project, stale-source, keyboard trap, horizontal-overflow, or lost
  draft defect occurs in the moderated run.
- Funnel events contain only the closed event schema described below. A sample
  of production rows contains no prompt, output, source, or draft text.

If a criterion fails, record the exact stage and observed behavior. Fix the
journey before adding more options or explanatory copy.

## Privacy-bounded funnel

The browser records one idempotent event per journey stage:

`started`, `draft_saved`, `validation_completed`, `enabled`, `run_started`,
`correction_recorded`, and `abandoned`.

Each row contains only a random journey UUID, elapsed milliseconds, the entry
intent (`prevent`, `protect`, or `make`), project/actor identity already known
to the authenticated server, and the event name. The API rejects unknown keys,
so source ids, prompts, outputs, examples, reasons, and arbitrary analytics
metadata cannot be accepted.

Pilot operators can report the funnel from PostgreSQL without adding an expert
analytics screen:

```sql
select
  metadata->>'event' as event,
  count(*) as journeys,
  percentile_cont(0.5) within group
    (order by (metadata->>'elapsedMs')::bigint) as median_elapsed_ms,
  percentile_cont(0.9) within group
    (order by (metadata->>'elapsedMs')::bigint) as p90_elapsed_ms
from audit_logs
where target_type = 'trace_test_funnel'
  and project_id = $3
  and created_at >= $1 and created_at < $2
group by metadata->>'event'
order by min(created_at);
```

Calculate abandonment as started journeys with `abandoned` and without a later
`enabled` or `correction_recorded` event, divided by started journeys for the
same project and date window. A resumed saved draft starts a new journey and
can reach enablement without a new `draft_saved` event, so report stage counts
as observed milestones rather than assuming a strictly decreasing funnel.
Segment only by the three bounded entry intents unless a new privacy review
explicitly expands the schema.

## Verification checklist

Before each pilot build:

- Run `pnpm test`, `pnpm typecheck`, and `pnpm build`.
- Run the PostgreSQL trace-test smoke test with `PG_SMOKE_DATABASE_URL`.
- Exercise harmful, useful, and correction fixtures on desktop and 390 px.
- Verify automatic-check unavailable, permission handoff, stale source,
  revision conflict, retry, dismissal, resume, and retained-evidence paths.
- Inspect focus after every stage transition and confirm dynamic operation
  status is announced without moving focus during a request.
- Inspect a sample funnel row and confirm its metadata keys are exactly
  `event`, `elapsedMs`, and `intent`.
