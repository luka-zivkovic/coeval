# Trace to test — beginner journey contract

Status: product contract for milestone [#157](https://github.com/luka-zivkovic/coeval/issues/157),
defined in journey batch [#158](https://github.com/luka-zivkovic/coeval/issues/158).
This document fixes the user journey and language before persistence or
model-assisted drafting is added.

## Outcome

A person who recognizes a useful or harmful AI response can turn it into a
rerunnable test in under three minutes without understanding datasets, rubrics,
judge models, schemas, thresholds, or CI configuration.

The first-value moment is not creating a test. It is seeing that the test
distinguishes the response that prompted it from the behavior the person wants.

## Language

| Product term | Meaning | Internal concepts it may map to |
| --- | --- | --- |
| Conversation | The complete source evidence | trace, case, steps, input/output |
| Test | One scenario with expected behavior | eval case, dataset item |
| Test suite | A named collection of enabled tests | dataset, immutable run snapshot |
| Check | How Coeval decides whether behavior matches the expectation | deterministic assertion, judging skill, manual review |
| Run | Check enabled tests with the project's current setup | eval run against the current approved skill version |
| Needs review | The evidence supports more than one reasonable judgment | ambiguous verdict, human review |
| Could not run | Coeval could not complete the check | missing evidence, provider/runtime/queue/parsing error |

Do not use `eval`, `golden`, `rubric`, `skill version`, or `model binding` in
the default journey. Those concepts remain available on existing expert
surfaces and in developer documentation.

## Entry actions

The conversation-detail surface offers one contextual action. The response already on
screen determines the copy; it does not change the underlying flow.

- Known or suspected bad response: **Prevent this next time**
- Good response worth preserving: **Protect this behavior**
- Unclassified response: **Make this a test**

The action never implies that Coeval already knows the truth.

## Journey states

Only one primary action appears at a time. Cancel remains visible before the
receipt, and Back remains visible after the source state. The first and receipt
states use the explicit secondary actions listed below.

### 1. Source conversation

**Question:** What are we protecting?

Show the complete conversation with the currently selected assistant response.
For multi-turn conversations, preselect the response from which the journey was
opened and allow the person to adjust the relevant turn range.

Primary action: **Use this response**

Secondary actions: **Cancel**, **Choose different turns**

Rules:

- Minimization never replaces or mutates the complete source evidence.
- Tool calls and intermediate steps are collapsed by default, but remain
  inspectable and selectable when they affect the expected outcome.
- If the source was deleted, expired, or belongs to another project, stop with
  an unavailable-source state. Never construct a partial test from stale UI
  state.

### 2. Desired behavior

**Question:** What do you want to improve or protect?

Choices:

1. **The AI response** — create a product-behavior test.
2. **Coeval's verdict** — record evaluator calibration evidence; do not create
   a product-behavior test.
3. **Nothing is wrong; this is worth preserving** — create a product-behavior
   test anchored on the observed good outcome.

The entry action preselects the likely choice but never skips this confirmation.
These observations are not logically exclusive in the domain model. The
beginner flow chooses the primary job now and offers other applicable jobs as
next actions on the receipt.

For product behavior, ask one free-text question:

> What should happen when this situation comes up again?

Primary action: **Draft the test**

Secondary actions: **Back**, **Cancel**

Rules:

- The person's statement is authoritative. Later assistance may clarify or
  structure it, but must not silently replace it.
- Empty input does not advance.
- Saving is not implicit when leaving this state.

If the person chooses **Coeval's verdict**, replace the product-behavior
question with two required fields:

- **Correct result:** Pass, Fail, or Needs review.
- **Why is that the right result?** A free-text reason grounded in the source.

Primary action for this branch: **Record correction**

Secondary actions for this branch: **Back**, **Cancel**

This branch proceeds directly to the correction receipt. It does not pass
through product-test drafting or validation.

### 3. Drafted test

**Question:** Does this capture the behavior you want?

Present one editable card:

```text
Scenario
  The smallest replayable input and necessary context.

Expected behavior
  The outcome stated in plain language.

Must do
  Observable requirements.

Must avoid
  Observable prohibited behavior.

Examples
  One output that should pass and one that should fail.
```

Primary action: **Check this test**

Secondary actions: **Back**, **Save draft**, **Cancel**

Rules:

- Every generated field is editable and visually marked as a suggestion until
  the person confirms it.
- The source output is preclassified according to the confirmed job: bad for
  **The AI response**, good for **Nothing is wrong**. Coeval suggests the
  contrasting example from the person's desired behavior; the person must edit
  or confirm it. If assistance is unavailable, they can write or paste the
  contrasting example manually.
- Neither example is treated as trusted evidence until the person confirms its
  expected result.
- Advanced checker/model controls are absent from the default flow.
- Save draft records incomplete work but never enables or runs it.

### 4. Validation

**Question:** Does the test tell good behavior from bad?

Show two evidence rows:

1. The original or person-designated bad output.
2. A person-confirmed known-good output.

Each row resolves to **Pass**, **Fail**, **Needs review**, or **Could not run**.
The normal success condition is: bad output fails and known-good output passes.

Primary action on success: **Add to Regression tests**

Primary action on a behavioral mismatch: **Improve the test**

Primary action on **Needs review**: **Review evidence**

Primary action on **Could not run**: **Retry check**

Secondary actions: **Save draft**, **Cancel**

Rules:

- Provider, timeout, queue, parsing, or missing-evidence failures render as
  **Could not run**, never as behavioral Pass or Fail.
- Ambiguity renders as **Needs review** and cannot silently enable the test.
- The default beginner destination is the project's **Regression tests** suite.
  Coeval creates it on first use and reuses it thereafter; suite selection and
  creation controls stay off the first-run path.
- A manual override is an advanced escape hatch and requires a recorded
  reason. It is not shown in the first-run path.

### 5. Enabled receipt

**Headline:** Test added

Explain what is now protected, name the **Regression tests** suite, and retain
links to the source conversation and validation evidence.

Primary action: **Run it now**

Secondary actions: **Open test suite**, **Return to conversation**

**Run it now** checks the newly enabled test immediately with the project's
current setup. It does not run the whole suite or configure a release gate.

If the primary job was correcting Coeval's verdict, the receipt instead says
**Correction recorded** and offers **Review evaluator accuracy**. It never
claims that a product test was created.

## State behavior

| Situation | Required behavior |
| --- | --- |
| Initial load | Keep the source context visible and use a local loading label; do not replace the whole app shell. |
| Drafting or validation is slow | Preserve all entered text, show the active operation, and allow Cancel. |
| Provider unavailable | Keep the manual draft usable and explain that automatic assistance could not run. |
| Source becomes stale | Stop before enablement, retain the draft, and require the source to be refreshed or replaced. |
| Back navigation | Restore the previous state and entered values. |
| Cancel with no edits | Return immediately to the source conversation. |
| Cancel with edits | Ask whether to save a draft or discard; never save implicitly. |
| Retry | Retry only the failed operation, not completed drafting or human decisions. |
| Deep link without source access | Render unavailable-source guidance; do not redirect to a misleading empty form. |
| Resume saved draft | Show **Resume test draft** on the source conversation and list the draft under **Regression tests**; restore every confirmed value. |

## Worked journeys

### Prevent a bad response

Source: an assistant promises a refund without checking policy.

Person's desired behavior:

> Explain the cancellation path and do not promise a refund before checking
> eligibility.

Draft:

- Scenario: customer asks to cancel after renewal.
- Expected: explain cancellation and accurately qualify refund eligibility.
- Must do: give the next cancellation step.
- Must avoid: promise or deny a refund without policy evidence.

Validation succeeds only when the unsupported promise fails and a
policy-qualified response passes.

### Preserve a good response

Source: an assistant asks for the minimum account information before beginning
a sensitive recovery flow.

Person's desired behavior:

> Keep verifying account ownership before giving recovery instructions.

The observed response serves as the initial known-good example. Coeval suggests
a contrasting unsafe output for the person to edit or confirm; if assistance is
unavailable, the person writes or pastes one. Both examples are required before
normal enablement.

### Correct Coeval

Source: Coeval marked a correct policy-qualified refund response as failing.

The person chooses **Coeval's verdict**, selects the correct result, records a
reason, and chooses **Record correction**. They reach the correction receipt and
return to evaluator calibration. No product test is created implicitly.

## Validation protocol for the journey

Use a moderated clickable prototype with fixture-backed, explicitly mocked
drafting and check results; production persistence, generation, and runtime are
not prerequisites. Include at least three redacted conversations: one harmful
response, one good response worth preserving, and one incorrect Coeval verdict.
Ask at least three participants to complete all three journeys without product
documentation.

Record:

- completion and abandonment;
- time to enabled test or recorded correction;
- every term or decision that requires explanation;
- edits to the desired behavior and drafted test;
- whether the participant can explain what will happen on **Run it now**;
- whether they can distinguish a product test from an evaluator correction.

Before the implementation contract is locked, participants must reach the
correct receipt without assistance and must not mistake a generated draft for
trusted ground truth. Timing is a product target, not a reason to skip human
confirmation. Batch [#164](https://github.com/luka-zivkovic/coeval/issues/164)
records the production pilot separately from this prototype check.

## Deferred decisions

- Clustering, similarity, novelty, and coverage recommendations.
- Automatic selection of representative traces.
- New CI setup or release-policy controls.
- Arbitrary agent/environment replay.
- Bulk trace-to-test creation.

These require evidence from the single-conversation journey and are not part of
journey batch #158.
