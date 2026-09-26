# ADR-0015: One product vocabulary and two display modes

Status: **Proposed**

Date: 2026-09-26

Decision owner: Luka Živković (founder). The founder set the direction on
2026-09-26: one vocabulary that is not simplified for beginners, friendly
explanations for people new to evaluation, and two display modes instead of
three. The term mapping below is the recommended implementation of that
direction and awaits founder review.

## Context

Rubrist currently speaks two vocabularies:

- The onboarding contract's product language table gives beginner words (Run,
  Check, Result, Review guide, Protected example). It keeps technical terms
  "exact on Technical surfaces and in evidence"
  (`docs/beginner-onboarding-journey.md` › Product language).
- The README's Concepts section says the Guided view uses the beginner words
  and the Technical view uses the rest.

The web app has three display modes: Guided (the default), Technical, and
Summary. They are stored per browser (`apps/web/src/hooks/use-mode.ts`) and
today change the level of detail, not the names of things.

The UX audits in `docs/ux-audit/` found the same thing named four to seven
ways: four names for the evaluator on the Overview, and seven for the review
queue along the triage flow. Their first proposals paired a Guided name with a
Technical name for each concept. Two names per concept would show people on
the same project different words for the same screen, depending on a
per-browser setting. It would also double the copy, help text, screenshots,
and tests.

Rubrist's users are expected to be mostly technical. Simplified words make the
product less precise for them, while people new to evaluation need
explanations, not different words. `docs/glossary.md` already defines precise
shared terms for most of these concepts.

## Decision

### One vocabulary

Every surface uses one term per concept: the app in both display modes, the
README, help text, and API-facing copy. Terms follow `docs/glossary.md` where it
defines them.

| Concept | Term | Replaces in the app today |
| --- | --- | --- |
| One named quality dimension | criterion | "one thing to Check" |
| The automated evaluation of one criterion | evaluator (an LLM judging skill is its current type) | Check, Skill, judge |
| One immutable version of it | evaluator version | skill version, Check version |
| The evaluator's written grading instructions | rubric | Review guide, guide |
| The model prompt around the rubric | prompt | Judge instructions |
| The required output shape | output contract | Result format |
| Exactly what is sent to the model | execution binding | Binding, model binding |
| The unit an evaluator assesses | case: one imported trace, or one dataset example in a bench project | Run, and trace or example used as the unit |
| The evaluator's output for one case | assessment, whose label is pass, fail, or ambiguous | Result, verdict, "Skill said", evaluator opinion |
| A label a reviewer records while seeing the assessment | ungoverned human label, recorded by "Accept assessment" or "Correct assessment" | human verdict, ruling, "Correct this result" |
| An evaluator-blind reviewed label | human truth | — |
| Cases waiting for a person | review queue | Exceptions, Needs a human, Waiting on a person, Humans next |
| Curated cases that guard against regressions | golden set, whose members are golden cases | Protected examples, regression references |
| The golden-set run on each new evaluator version | regression check | gate, known-failure check, check |

When copy talks about a source system, it uses that system's word for the
source and Rubrist's word for the result, for example "12 LangSmith traces
imported as 12 cases".

### Two display modes

- **Standard**, the default, and **Beginner** replace Guided, Technical, and
  Summary.
- Both modes show the same words, data, navigation, and actions. No mode
  renames, hides, or removes anything.
- Beginner adds explanation: a one-sentence definition the first time a term
  appears on a screen, fuller empty states, and the first-run guidance.
  Standard offers the same definitions on demand.
- Bulky internals, such as raw request and response bodies, sit in collapsed
  sections in both modes.
- Onboarding asks one question, whether the person has built LLM evaluations
  before, and sets the mode from the answer. People can switch at any time.
  The mode is a personal preference and never grants or removes access.

### What stays

- The onboarding journey's steps and its truth and safety rules, including
  "A successful run is not called calibration, accuracy, approval, or trust."
- The product language table's "Consequence to explain" column. It becomes a
  source for Beginner explanations.

## Consequences

- When accepted, this supersedes the onboarding contract's beginner words and
  its Guided-display word rules (`docs/beginner-onboarding-journey.md:56-77`).
  That section is rewritten as a table of terms with their Beginner
  explanations, and "Guided display" becomes "Beginner mode" throughout the
  contract.
- The README's Concepts and "Your first Check" sections are rewritten in this
  vocabulary.
- `apps/web/src/lib/display-mode.ts` and `apps/web/src/hooks/use-mode.ts` move
  to two modes. Content marked `.dev-only` becomes visible in both modes, and
  stored values from the three-mode switch map to Standard.
- Terms used here but not defined in `docs/glossary.md` (case, review queue,
  regression check, golden case, ungoverned human label) are added to all
  three vendored copies of the glossary together.
- Route paths and API names, such as `/skill`, `/exceptions`, and the
  `verdicts` endpoints, are unchanged by this ADR. Renaming them is a separate
  change.
- The UX audits in `docs/ux-audit/` use this vocabulary in their proposals.
