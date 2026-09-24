# ADR-0014: Model-agnostic evaluator execution and evidence v2

Status: **Proposed**

Date: 2026-09-24

Decision owner: Luka Živković (founder). The founder asked on 2026-09-24 that
anyone be able to run any model as a judge, and chose to decide the
temperature problem (#120) and TypeSafe Jev as an evaluator provider (#101) in
one record, so Dailies sees one contract revision. Nothing here is built until
the founder accepts it.

## Context

CURRENT facts, checked on 2026-09-24:

- **Rubrist can't judge with current Claude 5 models (#120).**
  - Every runtime Anthropic judge uses the single-physical-call policy. The
    eval-item worker keeps an honest one-call ledger, and sealed calibration
    counts physical calls.
  - That policy always sends `temperature` and always forces the verdict tool
    with `tool_choice: {type: "tool"}`.
  - `claude-sonnet-5`, `claude-opus-5-5`, and `claude-fable-5-1` reject
    `temperature`, and `claude-opus-5-5` also rejects a forced tool choice.
    Both rejections are HTTP 400.
  - The OpenAI adapter has the same shape: it always sends `temperature` and
    forces its verdict function.
- **The model binding can't say "not sent."** `ModelBindingInputSchema`,
  `assessment-receipt/v1` (`requestedModelBinding.temperature`), and
  `binary-calibration/v1` (`requestedModelBinding.temperatureDecimal`, inside
  `requestedBindingDigest`) all require a temperature.
  - `skillDigest` hashes the whole binding, and
    `evaluator-suite-manifest/v1` pins `skillDigest` as frozen by receipt v1.
  - Dailies vendors all three contracts.
  - ADR-0001 closes v1: changing a field needs a new contract version and a
    coordinated compatibility window. ADR-0011 keeps that rule before launch.
- **Evidence doesn't say how a verdict was produced.** Neither receipt nor
  calibration records the request protocol (forced tool, structured output),
  whether the model reasoned first, or at what effort. `claude-opus-5-5`
  thinks by default before it answers.
- **Providers publish capability data.**
  - Anthropic's Models API returns per-model `capabilities`: for example,
    `structured_outputs`, `effort` levels, and supported `thinking` types.
    Both `claude-opus-5-5` and `claude-haiku-4-5-20251001` report
    structured outputs as supported. The API doesn't report temperature
    support.
  - OpenRouter lists `supported_parameters` per model (`temperature`,
    `tools`, `tool_choice`, `structured_outputs`, `response_format`, and
    others).
  - OpenAI-compatible custom endpoints publish nothing reliable.
- **A typed-question model is a different kind of evaluator (#101).** Jev
  answers `noul`/`choice`/`score` questions with a probability and no
  rationale.
  - The spike on branch `spike/jev-evaluator-comparison` compared
    `jev-1.13.0` with Rubrist's LLM judge request on public human-labeled
    data. The Claude judges were Haiku 4.5; Sonnet 4.6, Rubrist's seeded
    default; Sonnet 5; and Opus 5.5.
  - On ChaosMNLI (200 cases) and MT-Bench (150 cases, both response orders),
    Jev's accuracy was statistically indistinguishable from Sonnet 4.6,
    Sonnet 5, and Opus 5.5 (paired McNemar p > 0.1). Opus 5.5 completed one
    response order; the account ran out of credit during the other.
  - On the same sets Jev cost under 1.5% of Haiku 4.5 per trace and had
    under 12% of its median latency.
  - Jev was the most order-consistent MT-Bench judge: it made the same call
    with the two responses swapped 95% of the time, against 54% for
    Haiku 4.5.
  - This is ASSUMPTION-class evidence: the data is public, not governed
    truth.
  - The spike also found that Rubrist's verdict instructions didn't say
    which way the binary `score` points; only the tool schema did. Judges
    often reported confidence in their own label instead (#121, fixed on
    2026-09-24).

How comparable tools handle the same problem (dated market context, not
product authority):

- LiteLLM (`drop_params`) and Vercel's AI SDK (`unsupported-setting`
  warnings) silently drop parameters a model rejects.
- Inspect AI treats an unset setting as not sent, adapts per provider, and
  records the config it used.
- OpenRouter exposes capability metadata and can refuse to route to an
  endpoint that can't honour a required parameter.
- Instructor picks a structured-output mode per model.

Silently dropping a parameter is acceptable for an application. For Rubrist it
would make the evidence claim a request that never happened.

## Decision

### 1. The binding states exactly what is sent

A model binding records the provider, model id, and model version as today,
plus explicit execution settings. Rubrist sends exactly these settings and
nothing else.

- **Sampling parameters** (`temperature`, `topP`) are optional.
  - Unset means the parameter is not sent and the provider's default
    applies. Evidence records it as unset, never as a default value.
  - New bindings leave them unset unless the author sets them.
- **Reasoning** is explicit: `none`, or a provider-supported effort level or
  thinking mode. Unset means the provider's default, and that is recorded.
- **Verdict protocol** is a named, versioned id, for example
  `anthropic.structured-output/v1`, `anthropic.forced-tool/v1`,
  `openai.structured-output/v1`, `openai.forced-function/v1`,
  `prompted-json/v1`, or `typed-question/v1`. Each protocol produces the same
  verdict schema.
- **Rubrist never drops, rewrites, or retries with changed parameters.**
  - A request the provider rejects is a failed call with an error kind. It
    is never followed by a second call with different parameters.
  - The ordinary-path "retry without temperature" fallback is removed.

### 2. Capabilities are resolved when a binding is saved, not at call time

When an evaluator version's binding is created, Rubrist resolves it once:

1. **Read the provider's capability data** where it exists: Anthropic's
   `capabilities`, or OpenRouter's `supported_parameters`.
2. **Choose the verdict protocol** in a fixed order: native structured
   output, then a forced tool or function, then `prompted-json/v1` as a last
   resort that is labelled as such.
3. **Make one preflight call** with the exact request shape, on a fixed
   probe input. This covers what metadata can't tell, such as temperature
   support or a custom endpoint.
4. **Store the resolution with the binding**: the chosen protocol, a
   capability-snapshot digest, the preflight outcome, and the time of the
   check.

If the author requested a parameter the model rejects, saving fails with the
provider's message and a suggestion, such as "leave temperature unset". It
doesn't silently drop the parameter. Execution never re-resolves the
binding, so the single-physical-call rule holds.

### 3. Typed-question evaluators (#101)

`typesafe` becomes an optional provider. Rubrist must never depend on it.

- **Identity.** The evaluator's definition is a typed question set (the
  question kind, instructions, and criteria per option). Its digest replaces
  the rendered prompt in the evaluator's identity.
- **Pinning.** The model is pinned to a version, and #108's alias rule
  applies (`jev-latest` is refused at governed gates).
- **Labels.** The evaluator declares a decision threshold, which maps its
  probability to pass or fail for receipts and binary calibration. The
  threshold is part of the evaluator's identity, not release policy
  (ADR-0004). Choosing one is the evaluator author's development decision,
  measured by calibration like any other evaluator property.
- **Rationale.** A verdict without a rationale records
  `rationale: not_provided`. It is never an empty string or an invented
  summary.
- **Guidance.** Criterion authors get written guidance on injection (text in
  the trace can move the answer) and on long traces. The spike didn't
  establish a trace-length effect, so there is no length gate until one is
  measured.

### 4. Evidence contracts, version 2

Three contracts move together to v2, in one Dailies compatibility window.

**`rubrist/assessment-receipt/v2`** answers the questions ADR-0003 requires
before any v2:

- **Abstention versus failure.** An item's evaluator outcome is `pass`,
  `fail`, or `abstain`, and applies only when the call succeeded. A failed
  item carries a `failureKind`: `provider_rejected`, `provider_error`,
  `timeout`, `invalid_output`, or `outcome_unknown`. An abstention is never a
  failure, and a failure is never an abstention.
- **Uncertainty.** An item may carry `passProbability` with a
  `probabilitySource`:
  - `native_probability` for a typed-question model;
  - `self_reported_score` for an LLM's own score, which is never called a
    probability;
  - absent.

  #121 made the instructions state the score's orientation. A score
  produced before that fix is never recorded as `self_reported_score`.
- **Calibration linkage and transport.** A receipt never embeds calibration.
  Calibration stays a separately addressed artifact (ADR-0009). A consumer
  retrieves it by the evaluator version's immutable identity, never by a
  field the receipt can change.
- **Compatibility and downgrade.**
  - v1 receipts stay verifiable forever, and nothing rewrites them.
  - New assessments emit v2 after rollout.
  - A v2 receipt is never down-converted to v1, because v1 can't express an
    unset parameter, a protocol, or a probability.
  - Consumers accept both versions during the window.
- **Binding and identity.** `requestedModelBinding` becomes the v2 binding
  from section 1: optional sampling, reasoning, and verdict protocol. For
  typed-question evaluators it holds the question-set digest and threshold.
  `skillDigest` v2 is defined over that binding.

**`rubrist/binary-calibration/v2`**:

- `requestedModelBinding` and `requestedBindingDigest` are defined over the
  v2 binding.
- Unset sampling parameters are `null` in canonical form.
- The artifact names the verdict protocol and reasoning settings.
- Aggregate-only disclosure (ADR-0009) is unchanged.

**`rubrist/evaluator-suite-manifest/v2`** references `skillDigest` v2. Its
other rules are unchanged.

### 5. Rollout

- Implementation follows its own batch in `docs/implementation-batches.md`,
  vendored into Dailies and Casefile.
- The batch plan updates the shared contracts and fixtures, the judge
  runtime (protocols, capability resolution, preflight), binding validation
  and persistence, and the model picker.
- Dailies vendors the v2 contracts before any v2 evidence is published.
- ADR-0011's clean-install policy means there is no stored binding to
  migrate. Published v1 fixtures and any v1 artifacts remain verifiable.

## Alternatives considered

- **Drop unsupported parameters silently**, as LiteLLM and Vercel do.
  Rejected: evidence would state a request that never happened.
- **Keep a hand-maintained list of which models accept what.** Rejected as
  the primary mechanism: it goes stale, and Vercel's list already has for
  reasoning-effort models. Provider metadata plus one preflight replaces it.
- **Retry at call time with different parameters.** Rejected: it breaks the
  single-physical-call ledger that sealed calibration depends on.
- **Keep v1 and refuse models v1 can't express.** Rejected: it permanently
  excludes the current frontier models, and the founder's requirement is
  that any model can be run.
- **Treat Jev as an OpenAI-compatible `custom` provider.** Not possible: its
  API takes state and typed questions, not chat messages.

## Consequences

- Any model whose request can be expressed and preflighted can be bound. The
  evidence then states exactly what was sent and how the verdict was
  produced.
- Two calibrations of the same model under different protocols or reasoning
  settings have different evaluator identities, as they should.
- Receipts gain an explicit failure taxonomy and a clearly sourced
  probability. That makes #102's uncertainty selection possible without
  mistaking an LLM's self-reported score for a probability.
- Dailies must ship v2 support before Rubrist publishes v2 evidence.
- The judge runtime gains a capability-resolution step and a preflight call
  per new binding, which costs one extra provider call per evaluator version.

## Open questions for the founder

1. **Default reasoning for new bindings.** Should a new binding default to
   `none` or to the provider's default? `none` is cheaper and more repeatable.
   The provider default may judge better, and its cost shows up in the
   evidence either way.
2. **`prompted-json/v1`.** Should the last-resort protocol be offered at all,
   or should a model with neither structured output nor tools be refused?
3. **Typed-evaluator threshold.** Is the threshold required per evaluator,
   or should 0.5 be the default?
