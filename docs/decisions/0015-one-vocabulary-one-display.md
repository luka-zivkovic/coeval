# ADR-0015: One product vocabulary and one display with a help layer

Status: **Proposed**

Date: 2026-09-26

Decision owner: Luka Živković (founder). On 2026-09-26 the founder set the
direction: one vocabulary that is not simplified for beginners, and friendly
explanations for people new to evaluation. After reviewing a two-mode design
the same day, the founder chose one display with a help layer instead of
display modes. The term mapping below is the recommended implementation and
awaits founder review.

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
differ in a few places. Technical shows raw ids, the judge call's raw request
and response, and more navigation items. Summary trims the navigation and
changes one Overview button. The UX audits in `docs/ux-audit/` found that
Guided does not keep its promise to hide technical details on at least two
pages. They also found that hiding pages by mode creates dead ends: the review
queue links Guided users to a page their navigation does not list.

The same audits found one thing named four to seven ways: four names for the
evaluator on the Overview, and seven for the review queue along the triage
flow. Their first proposals paired a Guided name with a Technical name for
each concept. Two names per concept, or two versions of each screen, would
show people on the same project different products depending on a
per-browser setting. It would also double the copy, help text, screenshots,
and tests.

Rubrist's users are expected to be mostly technical, so simplified words make
the product less precise for most of them. People new to evaluation need
explanations, and what they do not know varies by concept, so a single
beginner switch fits them poorly. `docs/glossary.md` already defines precise
shared terms for most of these concepts.

## Decision

### One vocabulary

Every surface uses one term per concept: the app, the README, help text, and
API-facing copy. Terms follow `docs/glossary.md` where it defines them.

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

### One display

- Guided, Technical, and Summary are removed. Everyone sees the same screens,
  words, data, navigation, and actions.
- Bulky internals, such as raw request and response bodies and digests, sit in
  collapsed sections.
- If stakeholders need a status view, the job Summary approximated, it is a
  page or a shareable report, not a display setting.

### A help layer

- Every product term has on-demand help that shows its definition.
- Explanations also appear where the need is predictable: the first-run
  journey, empty states, and the first time a concept appears for a person.
  Each can be dismissed, concept by concept.
- One personal preference, "Show explanations", turns the proactive
  explanations off; on-demand help stays. It is on for new accounts, so
  onboarding does not ask people to rate their own experience.
- The onboarding contract's "Consequence to explain" column is a source for
  these explanations.

### What stays

The onboarding journey's steps and its truth and safety rules stay, including
"A successful run is not called calibration, accuracy, approval, or trust."

## Consequences

- When accepted, this supersedes the onboarding contract's beginner words and
  its Guided-display word rules (`docs/beginner-onboarding-journey.md:56-77`).
  That section is rewritten as a table of terms with their explanations, and
  references to Guided display become references to the help layer.
- The README's Concepts and "Your first Check" sections are rewritten in this
  vocabulary, and its description of the Guided and Technical views is
  removed.
- `apps/web/src/lib/display-mode.ts` and `apps/web/src/hooks/use-mode.ts` give
  way to the "Show explanations" preference. Content marked `.dev-only`
  becomes visible to everyone, navigation filtering by mode is removed, and
  stored mode values are ignored.
- Terms used here but not defined in `docs/glossary.md` (case, review queue,
  regression check, golden case, ungoverned human label) are added to all
  three vendored copies of the glossary together.
- Route paths and API names, such as `/skill`, `/exceptions`, and the
  `verdicts` endpoints, are unchanged by this ADR. Renaming them is a separate
  change.
- The UX audits in `docs/ux-audit/` use this vocabulary and display in their
  proposals.
