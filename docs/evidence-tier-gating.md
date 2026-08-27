# Legacy recipe: evidence-tier gating for agent-skill changes

> **Status: historical compatibility recipe.** The steps below document the
> deprecated Coeval-owned product-gate surface and must not guide new product
> architecture. New release automation requests policy-free
> `release_evidence` from Coeval and lets Dailies apply release policy. See
> [`../PRODUCT.md`](../PRODUCT.md) and
> [ADR-0001](decisions/0001-evidence-contract-ownership-and-versioning.md).

How to use coeval as the **rubric-tier release verifier** when changing an
agent skill (Claude/Codex/pi SKILL.md artifacts). This replaces hand-rolled
"blind pairwise judge, 3+ runs" scripts with governed, versioned evidence.
Baseline and candidate versions are evaluated separately against the same
human-approved cases; baseline results are context, while only the candidate
gate controls release.

## The tiers (doctrine)

- **objective** — a script or test verifies the change. Coeval is not needed.
- **rubric** — quality is observable but not exactly checkable. Use this
  recipe.
- **subjective** — no reliable scorer exists. Do not fake a scored gate;
  record review notes.

## Rubric-tier recipe

1. **One bench project per audited skill** (see `skills/coeval-audit/`),
   with a judging skill whose `rubricMarkdown` encodes the skill's
   contract — invariants as specific probes, not vibes.
2. **Build the governed test set**: capture representative runs, have a
   human adjudicate their pass/fail labels, and promote them to the project's
   golden set. A label typed into local JSONL is not golden until that review
   and promotion have happened.
3. **Re-run BOTH versions on the same golden inputs**, using independent
   execution contexts. Keep their outputs in separate product-gate files:
   `baseline-candidates.jsonl` and `candidate-candidates.jsonl`. Each line is
   `{"goldenCaseId":"case_...","output":{"answer":"..."}}`. Never
   concatenate the two files: pooled agreement can hide a candidate regression.
4. **Record the baseline, then gate only the candidate**:

   ```bash
   # Baseline disagreement is evidence, not a release block. Infrastructure
   # and configuration errors still stop the workflow.
   COEVAL_URL=https://your-coeval.example COEVAL_API_KEY=coeval_sk_... \
     node tools/ci/gate.mjs --product baseline-candidates.jsonl \
       --max-disagreements 0 --label "$BASELINE_SHA" || test "$?" -eq 1

   # This is the release gate.
   COEVAL_URL=https://your-coeval.example COEVAL_API_KEY=coeval_sk_... \
     node tools/ci/gate.mjs --product candidate-candidates.jsonl \
       --max-disagreements 0 --label "$GIT_SHA"
   ```

   The baseline result is comparison evidence, not a release decision. For
   the candidate command, exit 0 means judged disagreements are within the
   configured limit; exit 1 means the candidate exceeded that limit; exit 2
   means invalid input, configuration, or judging infrastructure — never a
   product verdict.
5. **Independence rule**: the authoring agent must not self-score or assign
   expected labels. Coeval judges new candidate content in a separate provider
   request with the approved skill's pinned model. Identical content already
   judged with that skill version may reuse its recorded verdict.
6. **Golden-set maturity**: a gate over fewer than ~10 adjudicated golden
   cases is wiring evidence, not quality evidence. Say which one you have.

## Anti-patterns

- Optimizing a skill against a small golden set (Goodhart: the optimizer
  farms judge wobble, not quality). Optimization loops require a large,
  kappa-stable golden set and an explicit return-on-investment gate.
- Labeling judgment skills `objective` because something about them can be
  counted.
