# Beginner onboarding journey

Status: **product-language contract for implementation**

Last reviewed: 2026-08-28

This contract defines Coeval's first-run experience for people who care about
AI quality but may not know what an eval, rubric, judging skill, calibration
set, or model binding is. It is subordinate to `PRODUCT.md` and accepted ADRs.
It simplifies how the evaluator lifecycle is introduced; it does not weaken or
rename the evidence stored underneath it.

## Outcome

> Show Coeval what your AI did, choose one thing that matters, and get a
> reusable Check you can improve over time.

The first-value moment is seeing the first understandable result from a Check
over a real recorded run. Creating a Check without a run is allowed, but it is
setup completion rather than first value.

Onboarding creates a usable, explicitly unvalidated starter evaluator. It does
not create human truth, prove evaluator accuracy, establish calibration,
approve a governed candidate, or decide whether a release should ship.

## Authority labels

- **TARGET:** the beginner journey and language in this document.
- **CURRENT:** new projects already receive a starter evaluator; owners can
  configure one manually or through a short-lived agent pairing, add cases or
  traces, run evaluations, and inspect results.
- **ASSUMPTION TO TEST:** an evidence-linked proposal plus one
  decision-changing question will usually get a beginner to a useful first
  Check faster than a blank editor or a long setup interview.

## Beginner mental model

The default journey teaches five concepts through use:

1. **Run:** one recorded example of what an AI system did.
2. **Check:** one reusable automated evaluation of one thing that matters.
3. **Result:** what the Check concluded from the recorded evidence.
4. **Your review:** a person's judgment about whether a result is right.
5. **Agreement with people:** how often a Check matches reviewed human
   outcomes on an identified set of runs.

The first session needs to answer only:

- What is being checked?
- What recorded information can Coeval see?
- Has a person confirmed the result?

## Product language

| Beginner language | Technical meaning | Consequence to explain |
| --- | --- | --- |
| Run | case, trace, or ordered recorded trajectory | Coeval reads the record; it does not replay the AI system or its tools. |
| Check | one criterion and its evaluator | A Check should answer one independently judgeable quality question. |
| Review guide | evaluator rubric | It defines pass, fail, and insufficient-evidence behavior. |
| Result | evaluator assessment | This is the Check's output, not human truth or a release decision. |
| Your review | human ruling or governed label, depending on the named path | The UI must state which evidence class the action creates. |
| Protected example | regression/golden case | It catches changes on a known case; it does not estimate production quality. |
| Agreement with people | evaluator-to-human comparison | The named people, dataset, coverage, and evaluator version still matter. |
| Technical details | prompts, schemas, model bindings, versions, revisions, and digests | Available for inspection without blocking the default journey. |

In Guided display, prefer **Check** before introducing **Evaluator**. Explain
the relationship once in context:

> Coeval calls this reusable automated Check an evaluator.

Do not lead first-run screens with `eval`, `criterion`, `rubric`, `judging
skill`, `golden`, `model binding`, `output schema`, `calibration`, or revision
identifiers. These terms remain exact on Technical surfaces and in evidence.

## One journey, two entrances

The app and an external agent teach the same mental model and produce the same
kind of starter evaluator. The MVP does not require a durable shared setup
session. Each entrance must still make its draft, assumptions, and next action
visible.

### In the app

1. **Name what you are evaluating.** Choose an agent or workflow, production
   runs, or examples without requiring evaluation terminology.
2. **Bring one run.** Paste an example, import traces, use sample data, or ask
   an external agent to connect the project. A person may continue without a
   run and create an untested Check.
3. **Choose what matters first.** Ask one short question grounded in the
   available run or project context.
4. **Review the proposed Check.** Show its one quality question, the evidence
   it reads, what it cannot know, and the editable Review guide.
5. **Create or refine.** Offer **Create this Check** and **Refine it first**.
   During refinement, keep **Create with current draft** available.
6. **See the first result.** When a run is available, execute the Check and
   open that result instead of returning to a dashboard with no explanation.
7. **Finish for now.** State what was created, what was run, and what has not
   been human-confirmed. Offer optional next steps.

Only one primary next action appears at each state. Back and exit actions stay
available without competing visually with it.

### Through an external agent

1. Inspect safe, relevant project text before asking the user to restate it.
2. Identify the likely AI system, evidence source, and possible first quality
   questions.
3. Reflect what was found and name material uncertainty.
4. Ask only the first decision-changing question, using concrete options.
5. Show the proposed Check and offer **Create** or **Refine**.
6. Ask the user to mint the short-lived Coeval connection only after the
   non-secret setup draft is ready.
7. Apply the draft through the existing bootstrap path and submit one real run
   when one is already available. Never invent a run to demonstrate success.
8. Return an honest receipt and hand ongoing capture, submission, and findings
   work to the audit workflow.

The preparation phase never needs a pairing token or provider secret. The
connection remains project-scoped, single-use, and short-lived.

## Question behavior

Question fatigue is caused by effort, ambiguity, repetition, stakes, and lack
of visible progress—not only by a numeric question count. The setup experience
therefore follows these rules:

- Inspect before asking.
- Prefer one question at a time. At most two tightly related questions may
  appear in one message.
- Ask only when the answer can change the target, Check, available evidence,
  data permission, or required authority.
- State discovered facts for correction instead of asking the user to repeat
  them.
- Use short, context-derived choices rather than open-ended evaluator jargon.
- Mark a recommendation when the evidence supports one.
- Stop asking once the current information can produce a useful draft.
- Treat terse replies, repeated skips, and repeated delegation as signals to
  shorten the path and use reversible defaults.

There is no universal maximum number of setup questions. A blocked target,
sensitive-data decision, or missing authority may require another question;
cosmetic and technical preferences should not.

## Decide for me

Offer **Decide for me** when the setup agent can make a reversible choice from
available evidence. After choosing, state the decision and short reason, mark
it as agent-decided, and continue without another confirmation.

Safe examples include:

- choosing the first of several plausible quality questions;
- naming the Check;
- choosing a starter template or result shape;
- selecting among already authorized judge providers or models;
- ordering setup work;
- creating an untested draft when no real run is available.

Do not offer silent delegation for:

- deciding which unknown system or repository is in scope;
- reading or sending sensitive data without permission;
- entering or exposing credentials;
- creating human labels or adjudications;
- promoting a protected/Golden case;
- approving or activating a governed evaluator;
- changing shared hooks or configuration;
- making a release decision.

## Proposed Check

After the minimum clarification, show one persistent editable card:

```text
What this Check decides
  One plain-language quality question.

What it reads
  The exact run fields, response, and recorded steps or tool calls it may use.

What it cannot know
  Missing side effects, external state, or evidence outside the record.

Review guide
  Pass, fail, and insufficient-evidence conditions.

Status
  Starter · unvalidated
```

Generated or inferred content remains a proposal. The interface must not use
silence, inactivity, or a preselected action as approval.

## Completion states

### Check created without a run

> Starter Check created. Add a run to see its first result.

This is a valid low-friction exit. Do not claim first value, testing, or human
agreement.

### Check created and run

> Starter Check created and run on one recorded example. Its result has not
> been compared with a human decision.

Execution proves operability on that run only. It does not prove evaluator
quality.

### Optional next steps

After the receipt, a person may:

- review or correct the result;
- try another run;
- refine the Check;
- protect a reviewed example against future evaluator regressions;
- collect human-reviewed examples and measure agreement;
- enter governed review and calibration when the intended use requires it.

These are progressive milestones, not first-run requirements.

## Non-negotiable boundaries

Low friction may defer assurance, but it must not falsify state or authority:

- Human truth and evaluator output remain different evidence classes.
- A successful run is not called calibration, accuracy, approval, or trust.
- Coeval never implies that it executed the AI system, replayed tools, or
  verified side effects absent from the record.
- Secrets are not inspected, copied, persisted, or displayed by setup logic.
- Sensitive content is not sent for draft generation without a visible scope
  and permission boundary.
- Human-only, shared, and irreversible actions require explicit authority.
- Missing, ambiguous, or failed execution never becomes a favorable result.
- One Check measures one criterion; suites do not collapse separate evidence
  into a composite release decision.
- Semantic clustering remains outside the journey.

## MVP scope and deferred work

The first implementation should reuse the existing starter evaluator,
templates, agent bootstrap, project authorization, and evaluation run paths.
It does not require:

- mandatory positive and negative examples;
- mandatory human labeling or contrastive validation;
- calibration during onboarding;
- a durable setup-session state machine;
- cross-channel app/agent resume;
- multiple criteria in one first-run flow;
- persona classification;
- model, prompt, schema, revision, or digest choices in Guided display.

A durable shared app-agent setup session changes persistence, concurrency, and
handoff semantics. It remains a later decision gate and must not be smuggled
into the MVP as incidental UI state.

## Validation

Test the implemented journey with people who are new to evaluation
methodology, including technically capable builders and less-technical domain
or product owners. Observe whether they can:

- explain a Run, Check, and Result in their own words;
- create one Check that uses evidence actually present in the run;
- identify what Coeval could and could not see;
- understand that Coeval did not replay the AI system or its tools;
- recognize that the starter result is not human-verified;
- reach the first result without intervention;
- resume after leaving the flow.

Speed and completion are secondary when a person finishes with a materially
wrong Check or mental model. Public product patterns are design precedents,
not evidence that the journey works for Coeval's users.
