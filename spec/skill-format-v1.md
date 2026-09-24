# SkillFormat v1

SkillFormat v1 is Rubrist's portable representation of a governed LLM-judging skill.

A skill is the team-owned artifact that defines how traces are judged. It combines a human-readable review guide, portable labeled examples, a requested model binding, and structured output schema. Rubrist's runtime stores and executes skills, but the format is intended to become implementation-independent once a second implementation exists.

## Required fields

```ts
type SkillFormatV1 = {
  name: string
  description: string
  owner: string
  version: string
  status: SkillStatus
  modelBinding: ModelBinding
  rubricMarkdown: string
  examples: SkillExample[]
  outputSchema: JsonSchema
}
```

## Status

```ts
type SkillStatus =
  | "draft"
  | "calibrating"
  | "validated"
  | "approved"
  | "production"
  | "regressing"
  | "failed"
  | "needs_review"
  | "deprecated"
```

## Model binding

`modelId` is the identifier sent to the provider. It must not be a mutable alias once the evaluator becomes a governed candidate, is activated, or runs sealed calibration; Rubrist rejects those requests (`evaluator_lifecycle_mutable_model_alias`, or `binary_calibration_ineligible` for calibration) and only warns while authoring. Rule `rubrist-mutable-model-alias/v1` treats a model id as an alias when, ignoring case, it is `latest`, `default`, or `auto` (also as its final `/` segment, as in `openrouter/auto`), or it ends in `-latest` or `:latest`. Undated ids such as `gpt-4o` are not aliases under v1. `modelVersion` is catalog identity captured with the skill and is not execution proof; provider-returned model/request/fingerprint metadata is the authoritative observed provenance when available.

Honest limitation: provider catalogs (Anthropic, OpenAI, OpenRouter) expose no
immutable snapshot id separate from the model id, so `modelVersion` is stored
as a copy of `modelId` on every pin path today. The field records *which model
was requested*, not a dated snapshot — a silent upstream revision of the same
model id is not detectable through it. Pin a dated model id (for example
`claude-sonnet-4-5-20250929` rather than an alias) when the provider offers
one and snapshot stability matters.

```ts
type ModelBinding = {
  provider: string
  modelId: string
  modelVersion: string
  temperature: number
  topP?: number
}
```

## Rubric

`rubricMarkdown` is the plain-language review guide. PMs and domain reviewers should be able to read it without understanding prompt engineering.

The rubric should define:

- pass criteria
- fail criteria
- ambiguous / unjudgeable policy
- required context
- known limitations
- untrusted-content handling

## Examples

Examples are portable labeled cases that may support calibration, testing,
stale/flaky checks, and golden-set workflows. SkillFormat can carry examples,
but the current Rubrist judge runtime does **not** inject them as few-shot prompt
content. Few-shot selection and train/holdout semantics are future product
decisions, not current runtime guarantees.

```ts
type SkillExample = {
  id: string
  label: "pass" | "fail" | "ambiguous"
  input: unknown
  output: unknown
  reason: string
  metadata?: Record<string, unknown>
}
```

Examples are not automatically golden. A case becomes golden only after human promotion with an agreed immutable verdict.

## Output schema

`outputSchema` is JSON Schema. The minimum compatible verdict shape is:

```json
{
  "type": "object",
  "required": ["label", "score", "reason", "confidence"],
  "properties": {
    "label": { "type": "string", "enum": ["pass", "fail", "ambiguous"] },
    "score": { "type": "number", "minimum": 0, "maximum": 1 },
    "reason": { "type": "string" },
    "failureCategory": { "type": "string" },
    "expectedBehavior": { "type": "string" },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "criteria": { "type": "object" }
  }
}
```

## Current implementations

- `apps/audit/src/skill/compile.ts` compiles submitted audit prompts into a starter SkillFormat-compatible unified skill.
- `packages/shared/src/index.ts` exposes `SkillVersionSchema` and related Zod contracts for the runtime representation.

These should stay aligned until the spec graduates to a standalone permissively licensed repository.
