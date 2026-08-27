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

The default journey teaches six concepts through use:

1. **Run:** one recorded example of what an AI system did.
2. **Check:** one reusable automated evaluation of one thing that matters.
3. **Result:** what the Check concluded from the recorded evidence.
4. **Correct this result:** a visible, ungoverned ruling when a person thinks
   the Check is wrong.
5. **Independent human review:** a person judges the run without seeing the
   Check's result; this separate path may create governed human evidence.
6. **Agreement with people:** how often a Check matches reviewed human
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
| Correct this result | evaluator-visible legacy human ruling | This is `ungoverned_legacy` triage and never becomes governed truth. |
| Independent human review | evaluator-blind governed label | The reviewer judges the criterion from frozen case evidence without seeing the evaluator output. |
| Protected example | regression/golden case | It catches changes on a known case; it does not estimate production quality. |
| Agreement with people | evaluator-to-human comparison | The named people, dataset, coverage, and evaluator version still matter. |
| Technical details | prompts, schemas, model bindings, versions, revisions, and digests | Available for inspection without blocking the default journey. |

In Guided display, prefer **Check** before introducing **Evaluator**. Explain
the relationship once in context:

> Coeval calls this reusable automated Check an evaluator.

Do not lead first-run screens with `eval`, `criterion`, `rubric`, `judging
skill`, `golden`, `model binding`, `output schema`, `calibration`, or revision
identifiers. These terms remain exact on Technical surfaces and in evidence.

Visible result correction and independent human review are not two names for
the same action. The first starts from an evaluator result and records an
ungoverned ruling. The second hides evaluator output and follows the governed
review contract. Agreement or calibration compares the two evidence types only
after their separately authorized collection.

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
   During refinement, keep **Create with current draft** available. Creation
   must append the exact criterion definition shown in the card and atomically
   bind the evaluator version to it.
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
7. Apply the draft through the mode-appropriate setup path and submit one real
   run when one is already available. Never invent a run to demonstrate
   success.
8. Return an honest completion summary and route ongoing work by source:
   Agent Skill projects use the audit workflow, supplied examples use the
   bench batch flow, and production runs use the selected trace integration or
   manual import.

The preparation phase never needs a pairing token or provider secret. The
connection remains project-scoped, single-use, and short-lived.

The visible Check, immutable criterion definition and digest, evaluator
version, and every executed Result must name the same quality question. A
generic seeded criterion cannot remain underneath a more specific proposed
Check. App and agent creation fail before mutation when that exact binding
cannot be established.

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

`Starter · unvalidated` is an assurance projection, not an alias for
`is_starter`, evaluator lifecycle state, or legacy version approval. It remains
visible until named comparison evidence exists. Later states must say what was
measured and against which evidence class; only currently admissible
calibration may be described as calibrated.

## Completion states

### Check created without a run

> Starter Check created. Add a run to see its first result.

This is a valid low-friction exit. Do not claim first value, testing, or human
agreement.

### Check created and run without a supplied label

> Starter Check created and run on one recorded example. Its result has not
> been compared with a human decision.

Execution proves operability on that run only. It does not prove evaluator
quality.

### Check created and run with a supplied label

> Starter Check created and compared with the label supplied for this example.
> That label is not governed human truth.

If the run belongs to an exact governed truth revision, name that revision,
evidence class, coverage, and comparison instead of using either generic
message. Completion copy is always derived from recorded evidence; the
presence of a label never silently upgrades its provenance.

### Optional next steps

After the completion summary, a person may:

- review or correct the result;
- try another run;
- refine the Check;
- start **Protect this behavior** or **Prevent this next time**. This enters
  the trace-to-test journey and retains its person-confirmed contrasting
  example and successful-validation requirements before protection;
- collect human-reviewed examples and measure agreement;
- enter governed review and calibration when the intended use requires it.

These are progressive milestones, not first-run requirements. In particular,
the absence of mandatory contrasting examples applies only to creation of the
unvalidated Check; it does not relax trace-to-test enablement.

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

The first implementation should reuse the existing templates, project
authorization, and evaluation run paths. It may extend the starter and agent
bootstrap writers only when they atomically append and bind the exact criterion
definition shown to the user. It does not require:

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

### Automated acceptance

Before release, tests must cover:

- app and external-agent creation bind the displayed Check, exact criterion
  definition and digest, evaluator version, and Result;
- Agent Skill, supplied-example, and production-trace entrances route to the
  correct ongoing workflow;
- ungoverned correction and evaluator-blind governed review never share copy,
  payloads, or authority;
- assurance copy derives from absent, supplied-label, governed-comparison, and
  calibrated evidence rather than legacy version status;
- missing, ambiguous, provider-failed, and queue-failed execution cannot render
  a favorable Result or a successful completion claim;
- authorization, selected-data scope, redaction, pairing-token expiry,
  single-use consumption, and non-disclosure remain enforced;
- the app draft survives Back, refresh, and a return to the same entrance, and
  the agent's non-secret local draft survives a new conversation; cross-channel
  resume remains deferred;
- primary actions, focus order, status announcements, error recovery, and
  keyboard-only operation remain accessible at every state;
- protection always enters the existing trace-to-test contract and cannot
  bypass its validation rules.

### Moderated release gate

Run at least five formative sessions with people new to evaluation methodology:
at least two technically capable AI builders and at least two less-technical
domain or product owners. The sample is a launch gate, not statistical proof.
Release the first-run path only when:

- at least four of five reach a Check proposal without moderator intervention;
- at least four of five create one criterion that is supported by recorded
  evidence and can explain the Run, Check, and Result in their own words;
- all five understand after completion that Coeval did not replay the AI
  system, that the starter is not governed human truth or calibrated, and that
  the Result cannot decide whether a release ships;
- no session sends or retains sensitive fields outside the person's visible
  selection; and
- every participant can return to unfinished work in the same entrance.

If a threshold misses, revise and repeat the formative round rather than
averaging the failure into a launch score. During the sessions, also observe
whether participants can:

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
