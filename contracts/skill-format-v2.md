# Skill format v2 specification

This document is normative for `skill-format/v2` alongside
`skill-format-v2.schema.json`. A skill-format document is the portable export
of one Rubrist evaluator version: enough to read it, move it to another
installation, and confirm that the evaluator received is the one exported.
Rubrist ADR-0014 section 7 decides it. It replaces `skill-format/v1`
(`spec/skill-format-v1.md`), which described a v1 model binding and left out
the prompt and verdict kind; that document stays unchanged, as superseded
history.

Unlike evidence, a skill-format document carries the evaluator's full
definition, including the rubric and prompt text, and a typed question's text.
An export exists to move an evaluator, so it discloses what receipts and
calibration only digest (ADR-0014 decision 5). Treat an export with the same
care as the evaluator itself.

## Fields

- `formatVersion`: exactly `skill-format/v2`.
- `name`, `description`, `owner`, `version`, `status`: the evaluator's
  catalog metadata. `status` is one of `draft`, `calibrating`, `validated`,
  `approved`, `production`, `regressing`, `failed`, `needs_review`, or
  `deprecated`.
- `evaluator.identity`: the evaluator identity of ADR-0014 section 1, with
  `basis` `rubrist/evaluator-identity/v2`, the full `definition`, and the
  `executionBinding`. Every setting in the binding is present, and `null`
  means not sent. The definition and binding rules are receipt v2's and
  ADR-0014 section 5's:
  - a prompted definition holds the rubric, prompt, verdict kind, output
    schema, and, exactly for its verdict kind, an ascending scalar range or
    non-empty categorical scores in `[0,1]`;
  - a typed-question definition holds its question as a digest, the
    `true_is_pass` polarity, a threshold strictly between 0 and 1, and
    `rationale: not_provided`, and runs only on `typed-question/v1`, which
    no other definition uses.
- `evaluator.question`: the typed question's text, `{ "type": "noul",
  "instructions": ..., "criteria": { "true": ..., "false": ... } }`, whose
  canonical JSON hashes to the definition's `question.digest`. It is `null`
  exactly for a prompted definition.
- `digests`: `definitionDigest`, `skillDigest`, and `outputContractDigest`, as
  defined below.
- `examples`: at most 50 labelled golden cases, each with an `id`, a human
  `label` (`pass`, `fail`, or `ambiguous`), the redacted trace `input` and
  `output` as JSON values, a `reason`, and `metadata` (an object or `null`).
  An `id` is at most 200 characters.
  Examples support calibration and testing; the runtime does not inject them
  as few-shot prompt content.
- `notes`: at most 20 honest notes about anything the export could not
  source. A value is never fabricated to fill a field.

There is no resolution record: what one installation learned about a binding
from its credentials is not part of the evaluator and is re-established by
the importer.

A custom endpoint's base URL is not exported either. It is often specific to
one installation and can name internal infrastructure, so the binding names
it only by `endpoint.baseUrlDigest`: SHA-256 over the UTF-8 bytes of
`rubrist/endpoint-base-url/v1`, a NUL byte, and the base URL exactly as
configured, with no normalization. An importer supplies the URL and checks it
against that digest; a different URL is a different endpoint, and so a
different evaluator identity.

## Digests

Digests are SHA-256 over canonical JSON, the algorithm of assessment receipt
v2, written as `sha256:` and 64 lowercase hexadecimal characters.

- `definitionDigest` hashes `evaluator.identity.definition`.
- `skillDigest` hashes `{ "basis": ..., "definitionDigest": ...,
  "executionBinding": ... }`: the same value receipt v2, calibration v2, and
  the suite manifest v2 carry for this evaluator.
- `outputContractDigest` hashes the definition's output contract, as in
  calibration v2 and the suite manifest v2.
- A typed question's `question.digest` hashes `evaluator.question`.

An importer recomputes all four from the document before accepting it, and
compares `skillDigest` with the identity it expected, such as a suite
manifest member's. A self-consistent document for a different evaluator
passes the digest checks, so the expected-identity comparison is what
detects a substitution.

## Validity

Every object is closed. No object has a `__proto__` key, and every string,
keys included, is a sequence of Unicode scalar values, every number is finite,
and nesting is bounded: the document root is depth 0, and an array or object
at a depth greater than 64 is invalid. JSON Schema can't express five
rules, which runtime validators check: lone surrogates, `__proto__` keys
inside open objects (an output schema, categorical choice scores, or an
example's payload or metadata), an ascending scalar range, finite numbers in
example payloads (JSON text such as `1e400` parses to infinity), and the depth
limit, which a validator applies before parsing example payloads recursively. String limits are UTF-16 code units
at runtime; JSON Schema's `maxLength` counts code points, so producers must
stay within both.

The document is not an exact-byte artifact: exports are formatted for people,
and every digest is computed over the canonical JSON of the part it covers.

## Portable fixtures

- `fixtures/skill-format-v2.prompted.json`: a prompted evaluator on the seeded
  Sonnet 4.6 binding, with two examples.
- `fixtures/skill-format-v2.typed-question.json`: a Jev typed-question
  evaluator with its question text and one example.
- `fixtures/skill-format-v2.conformance.json`: the mutation corpus. Each case
  starts from its `baseFixture`, or the corpus's, and applies its mutations in
  order. `add`, `replace`, and `remove` target an RFC 6901 JSON Pointer, and
  `add` and `replace` create an own member even for a `__proto__` key, as
  `JSON.parse` does; `recompute-question-digest` sets
  `evaluator.identity.definition.question.digest` to the digest of the
  current `evaluator.question`; and `recompute-digests` recomputes all three
  `digests` from the current document. `structural` states the required result from both
  JSON Schema and runtime schema validation, and `semantic` the result after
  structural acceptance, using the case's optional `expectedSkillDigest`.

The two evaluators are the same ones the suite manifest v2 fixture names, so
their `skillDigest` values agree across the contracts.

## Compatibility

Skill format v2 is closed. New fields require a new version.
