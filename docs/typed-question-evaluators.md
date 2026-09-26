# Typed-question evaluators

A guide for criterion authors (ADR-0014 section 5, Batch 8E). It says what a
typed-question evaluator is, when the #101 spike suggests it fits, and what
Rubrist records for it. The spike's numbers are in ADR-0014 under
"ASSUMPTION: the #101 spike"; they come from public data, not governed truth.

## What it is

A typed-question evaluator asks a TypeSafe typed-question model, such as
`jev-1.13.0`, one yes-or-no (`noul`) question about a trace. The model answers
with the probability that the answer is true. Rubrist reads true as pass, and
the item passes when that probability is at or above the evaluator's decision
threshold.

Its definition is:

- **the question**: instructions, plus what a true and a false answer mean;
- **polarity**: true means pass;
- **a decision threshold** strictly between 0 and 1. It is required, has no
  default, and is part of the evaluator's identity;
- **a fixed output contract**: a probability, and no rationale.

The model sees the trace's input and output, and each step's name, input, and
output when there are steps. It doesn't see the trace id or any metadata.

A typed-question evaluator never abstains and never states a rationale. Its
verdict records `rationaleStatus: "not_provided"` instead of text, and its
probability is the verdict's `native_probability` score. That score is
uncalibrated.

Only binary questions are supported. Choice and score questions wait for
ADR-0004's categorical and scalar calibration.

## When to use one

What the #101 spike showed, and didn't:

- **Short, self-contained criteria.** On ChaosMNLI and MT-Bench, no accuracy
  difference from frontier LLM judges was detected. That is "no difference
  detected", not equivalence. There, Jev cost about 1% of Haiku 4.5 per trace
  and answered in about a tenth of the time.
- **Whole-agent-run criteria.** On tau-bench trajectories, Jev was at chance
  where Opus 5.5 was not. The run couldn't tell whether trace length, task
  type, reasoning, or model capability explains the gap.
- **Prompt injection wasn't tested.**

So a typed-question evaluator for a criterion over whole agent runs needs its
own calibration evidence before anyone relies on it. Rubrist has no automatic
trace-length gate; one waits until an effect is measured.

## Writing the question

- State one property of the answer, in the instructions.
- Say concretely what makes it true and what makes it false. Both criteria
  are required.
- Make true the passing answer. Polarity is fixed, so a question whose "yes"
  means failure must be reworded.
- The question's text is part of the definition, and its digest is part of
  the evaluator's identity. Any change is a new evaluator version.

## Choosing the threshold

- Choose it on nonsealed data, such as development cases or governed
  nonsealed truth, by looking at the probabilities the model gives passing
  and failing cases. Never tune it on sealed calibration data.
- The threshold is part of the evaluator's identity, not release policy. A
  different threshold is a different evaluator, with its own calibration.

## Binding and credentials

- Bind the `typesafe` provider with `typed-question/v1` and a pinned model,
  such as `jev-1.13.0`. TypeSafe takes no sampling, reasoning, or token-limit
  settings, so every such field is `null`.
- A mutable alias such as `jev-latest` can be saved, but it is refused at
  every governed gate: candidates, activation, and sealed calibration.
- Credentials come from a project's TypeSafe key (Settings, "Judge provider
  keys") or the platform's `TYPESAFE_API_KEY`. The project key wins.
- Resolution confirms the binding with one probe, which asks a fixed question
  about a fixed trace. No project data is sent.

## Saving one

Authoring in the web app arrives in Batch 8F. Until then, save a version
through the API:

```http
POST /api/skills/{skillId}/versions
content-type: application/json

{
  "typedQuestion": {
    "type": "noul",
    "instructions": "Is every refund the agent offers allowed by the refund policy?",
    "criteria": {
      "true": "Every refund offered is allowed.",
      "false": "A refund is offered outside the policy."
    }
  },
  "decisionThreshold": 0.62,
  "executionBinding": {
    "provider": "typesafe",
    "endpoint": { "kind": "managed" },
    "modelId": "jev-1.13.0",
    "modelVersion": "jev-1.13.0",
    "sampling": { "temperature": null, "topP": null },
    "reasoning": null,
    "outputTokenLimit": null,
    "verdictProtocol": "typed-question/v1",
    "routing": null
  }
}
```

A typed-question version sends no rubric, prompt, or output schema.
Governed candidates take the same `typedQuestion` and `decisionThreshold`
fields in place of `rubricMarkdown` and `prompt`.

## What the evidence shows

- **Receipts** carry each item's outcome (pass or fail) and its
  `native_probability` score, never a rationale.
- **Sealed calibration** records pass or fail per attempt. A typed-question
  trial never abstains.
- **skill-format/v2 exports** carry the question's text beside the identity,
  which names the question only by its digest.
- **Feedback sync** to LangSmith, Langfuse, and Ironside sends the label and
  score with no comment.
