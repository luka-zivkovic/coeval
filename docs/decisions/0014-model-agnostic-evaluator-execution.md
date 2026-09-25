# ADR-0014: Model-agnostic evaluator execution and evidence v2

Status: **Proposed**

Date: 2026-09-24

Decision owner: Luka Živković (founder).

- On 2026-09-24 the founder asked that anyone be able to run any model as a
  judge. They chose to decide the temperature problem (#120) and TypeSafe
  Jev as an evaluator provider (#101) in one record, so Dailies sees one
  contract revision.
- Two independent review passes on 2026-09-24 added:
  - separating identity from resolution;
  - pinning injected text;
  - revalidation before sealed runs;
  - one failure taxonomy;
  - the completeness rule;
  - the rules for moving between versions;
  - OpenRouter routing.
- Nothing here is built until the founder accepts it.

## Context

### CURRENT, checked on 2026-09-24

**Rubrist can't judge with current Claude 5 models (#120).**

- Every runtime Anthropic judge uses the single-physical-call policy. The
  eval-item worker keeps a one-call ledger, and sealed calibration counts
  physical calls.
- That policy always sends `temperature` and forces the verdict tool with
  `tool_choice: {type: "tool"}`. The OpenAI adapter always sends
  `temperature` and forces its verdict function.
- `claude-sonnet-5`, `claude-opus-5-5`, and `claude-fable-5-1` reject
  `temperature` with HTTP 400.
- `claude-opus-5-5` also rejects a forced tool choice. Structured outputs
  work on it, and it thinks by default before answering.

**The binding can't say "not sent", and some recorded values aren't sent.**

- `ModelBindingInputSchema` requires `temperature`, and so do three
  contracts: `assessment-receipt/v1`, `binary-calibration/v1` (inside
  `requestedBindingDigest`), and `skill-format/v1`.
  `GET /api/skills/:skillId/versions/:versionId/skill-format` exports
  `skill-format/v1` documents.
- `topP` is accepted, stored, and recorded in receipt v1 and `skillDigest`,
  but neither adapter sends `top_p`. Receipt v1 can therefore already state
  a request that never happened. Sealed calibration refuses `topP` bindings
  outright.
- An `openai` binding names no endpoint, yet eval runs honour an
  `OPENAI_BASE_URL` override. Sealed calibration always calls
  `api.openai.com`.

**Evaluator identity leaves out what the model is actually shown.**

- `skillDigest` hashes the rubric, the prompt template, the binding, and
  the output contract.
- It leaves out:
  - the injected protocol text (`TRUSTED_JUDGE_PROTOCOL`, the verdict
    instructions, the tool-schema descriptions);
  - the provider-side schema transform;
  - the output token limit: the Anthropic adapter sends a fixed
    `max_tokens: 1200`, and the OpenAI adapter sends none.
- #121 changed what every judge receives without changing any digest.
- The trusted protocol tells the model to use the verdict tool, and so do
  these templates:
  - the default prompt template;
  - the seed template;
  - the web starter templates.

**The evidence contracts disagree on outcomes.**

- Receipt v1 marks the whole receipt incomplete if any item abstained.
  Calibration v1 counts an abstention as a completed observation with lower
  coverage.
- Calibration v1 has a closed error-code set:
  - `provider_unavailable`
  - `provider_authentication`
  - `provider_rate_limit`
  - `provider_timeout`
  - `provider_transport`
  - `provider_protocol`
  - `invalid_evaluator_output`
  - `outcome_unknown`
  - `internal`

  Receipt v1 has a free-text error.

**Contracts are closed and vendored.**

- `skillDigest` is pinned by `evaluator-suite-manifest/v1`.
- Dailies vendors the receipt, calibration, and suite-manifest contracts,
  and checks that `receipt.skillDigest` equals `member.skillDigest`.
- ADR-0001 closes v1: changing a field needs a new contract version and a
  coordinated compatibility window. ADR-0011 keeps that rule before launch.

**Providers publish some capability data.**

- Anthropic's Models API returns per-model `capabilities`. These include:
  - `structured_outputs`;
  - effort levels;
  - supported `thinking` types (`claude-opus-5-5`: adaptive only;
    `claude-haiku-4-5-20251001`: enabled only, with no effort).

  It doesn't report temperature support.
- OpenRouter's models API lists `supported_parameters` per model. That list
  is a union across upstream providers, and OpenRouter drops a parameter
  an upstream doesn't support unless `provider.require_parameters` is set.
- OpenAI's models API and OpenAI-compatible custom endpoints publish no
  capability data.

### ASSUMPTION: the #101 spike

The spike is at tag `jev-comparison-2026-09-24`, under
`tools/typesafe-loop/results/2026-09-24-compare`. Its data is public and not
governed truth. The first Anthropic key ran out of credit, and the refused
calls were resumed with identical requests. Every judge answered every set,
except one Sonnet 5 MT-Bench verdict that still has no rationale.

- **Judges and deviations.**
  - `jev-1.13.0`: one `noul` question per case.
  - Four Claude judges on Rubrist's verdict request: Haiku 4.5; Sonnet 4.6,
    Rubrist's seeded default; Sonnet 5; and Opus 5.5.
  - Deviations, each recorded per judge: Sonnet 5 and Opus 5.5 ran without
    temperature, and Opus 5.5 with `tool_choice: auto`.
  - Every Claude run used the pre-#121 verdict instructions.
- **Short-context results.** On ChaosMNLI (200 cases) and MT-Bench (150
  cases, both response orders), McNemar found no accuracy difference between
  Jev and Sonnet 4.6, Sonnet 5, or Opus 5.5 (p ≥ 0.065). That is "no
  difference detected", not equivalence. The paired bootstrap does separate
  Jev from Sonnet 5 on original-order MT-Bench, with Jev ahead (0.048
  [0.007, 0.088]). Against Opus 5.5 the AUCs agree within 0.01.
- **Cost and latency.** On the short-context sets, Jev cost 0.8–1.4% of
  Haiku 4.5 per trace and 0.1–0.2% of Opus 5.5, and its median latency was
  8–12% of Haiku's.
- **Order consistency on MT-Bench** (the same pick with the responses
  swapped):

  | Judge | Same pick in both orders |
  | --- | --- |
  | Opus 5.5 | 148 of 150 |
  | Jev | 143 of 150 |
  | Sonnet 4.6 | 130 of 148 |
  | Sonnet 5 | 128 of 147 |
  | Haiku 4.5 | 81 of 150 |

- **Long agent trajectories: only Opus 5.5 held up.**
  - On tau-bench (109 runs), always answering pass scores 0.578. Opus 5.5
    reached accuracy 0.743 (AUC 0.824).
  - Jev (0.505, AUC 0.547), Haiku 4.5, and Sonnet 4.6 were at chance, and
    Sonnet 5 was only slightly above.
  - Opus beat Jev by 0.24 [0.14, 0.34] in paired accuracy (McNemar
    p < 0.001).
  - Opus 5.5 reasoned first by default: its responses carried thinking
    blocks in our checks.
  - The other judges answered without thinking. Haiku 4.5 and Sonnet 4.6
    don't reason unless asked, and a spot check of Sonnet 5 under the forced
    verdict call returned no thinking.
  - The run didn't isolate whether reasoning, model capability, or the kind
    of task explains the gap, and it can't separate trace length from task
    type.
- **Score orientation.** Before #121, Rubrist's verdict instructions didn't
  say which way the binary `score` points. On ChaosMNLI, judges' scores
  contradicted their own labels (Haiku 4.5 in 81 of 191 verdicts).

### Dated market context (not product authority), 2026-09-24

- [LiteLLM](https://docs.litellm.ai/docs/completion/drop_params) raises an
  error on an unsupported parameter by default. With `drop_params` enabled
  it drops the parameter.
- [Vercel's AI SDK](https://ai-sdk.dev/docs/ai-sdk-core/settings) drops
  unsupported settings and reports each one in the result's `warnings`. Its
  per-model rules are keyed on model ids and
  [can go stale](https://github.com/vercel/ai/issues/10932).
- [Inspect AI](https://inspect.aisi.org.uk/models.html) sends no key for an
  unset setting and records the generation config in its eval log.
- [OpenRouter](https://openrouter.ai/docs/guides/overview/models) publishes
  `supported_parameters` and can refuse to route to an upstream that can't
  honour them.

Evidence can't use any mechanism that drops a parameter after the binding
has stated it.

## Decision

### 1. Identity, execution binding, and resolution are separate

An evaluator version has three parts.

- **Evaluator definition** (identity). It has one of two kinds:
  - `prompted`: the rubric, the prompt template, and the output contract;
  - `typed-question`: section 5.
- **Execution binding** (identity). It holds:
  - the provider;
  - the endpoint identity: `managed`, or the digest of a custom base URL;
  - the model id and model version;
  - sampling settings;
  - reasoning settings;
  - the output token limit;
  - the verdict protocol id and version;
  - for OpenRouter, the routing requirements in section 2.
- **Resolution record** (not identity). It holds the capability-snapshot
  digest, the probe outcomes and their cost, the credential source (project
  key or platform key), the time of the check, and a status of `resolved`,
  `unresolved`, or `failed`.

Every part of the execution binding is fixed when the version is saved,
including the verdict protocol (section 3). Resolution can confirm a binding
or fail it; it never changes it. Evaluator versions are immutable, so a
binding that fails resolution is fixed by creating a new evaluator
version.

`skillDigest` v2 covers the definition and the execution binding, never the
resolution record. Two identical definitions saved at different times
therefore have the same digest. In every v2 contract, an unset value is
canonical JSON `null`; it is never omitted.

### 2. The binding states exactly what is sent

- **Sampling** (`temperature`, `topP`) is either an explicit value or unset,
  and unset means not sent. v2 is the first version that actually sends
  `topP`.
- **Governed gates.**
  - At candidate creation, activation, and sealed calibration,
    `temperature` must be explicit whenever the model accepts it. It may be
    unset only where resolution recorded the model rejecting an explicit
    temperature. Otherwise a provider could change its default under a
    pinned model id, and "unset" evidence couldn't tell those runs apart.
  - `topP` may stay unset at the gates. Some models reject `temperature`
    and `top_p` together.
  - Authoring may leave either unset.
  - The seeded default binding keeps an explicit temperature of 0 and
    reasoning `disabled` wherever the model accepts them.
- **Reasoning** has a closed, typed shape per provider family:
  - Anthropic: `thinking` of `disabled`, `enabled` with a token budget, or
    `adaptive`, plus an effort level where supported.
  - OpenAI: `reasoning_effort`.
  - OpenRouter: its `reasoning` object.

  - At the governed gates reasoning must be explicit. A model with a
    single mode, such as `claude-opus-5-5` with adaptive only, states that
    mode explicitly.
  - Observed reasoning is recorded as observed provenance, next to the
    observed model identity: whether thinking blocks came back, and the
    reasoning token count where the provider reports it.
- **The output token limit** is part of the binding, and the protocol
  version pins its parameter name (`max_tokens` or
  `max_completion_tokens`). It may be unset where the provider allows it;
  Anthropic requires one.
- **Endpoint.** Evidence-producing runs call exactly the endpoint the
  binding names. A platform `OPENAI_BASE_URL` override is recorded in the
  binding as its endpoint identity, the digest of the base URL. It is never
  applied implicitly.
- **OpenRouter.** Bindings send `provider.require_parameters: true` and
  `provider.allow_fallbacks: false`, and record both, so every call goes to
  an upstream that honours the stated parameters. The upstream that served
  each call is recorded as observed provenance.
- **No parameter changes after a rejection.** Rubrist never drops,
  rewrites, or retries with changed parameters. A rejected request is a
  failed call, classified in section 6. The ordinary-path "retry without
  temperature" fallback is removed.
- **Evidence attests what was sent, not what the endpoint honoured.** This
  matters most for OpenAI-compatible custom endpoints, which can accept a
  parameter and ignore it.

### 3. Verdict protocols pin everything the model is shown

A verdict protocol is a named, versioned id: `anthropic.structured-output/v1`,
`anthropic.forced-tool/v1`, `openai.structured-output/v1`,
`openai.forced-function/v1`, `typed-question/v1`, and `mock/v1`.

Each version pins:

- the judge preamble;
- the injected protocol and verdict-instruction text;
- the user-message wrapper;
- the evidence serialization (`canonical-json-html-safe-v1`);
- the output schema and its descriptions;
- the provider-side schema transform;
- the token-limit parameter;
- the parse rule.

Any change to injected text, of the kind #121 made, is a new protocol
version, and therefore a new evaluator identity for bindings that adopt it.
Old versions stay runnable, so an evaluator can be reproduced. The default,
seed, and starter templates stop naming a mechanism ("use the verdict
tool"); the protocol text supplies it.

The protocol is fixed when the binding is saved:

1. Where capability data exists, Rubrist takes the first supported
   protocol in this order: native structured output, then a forced tool or
   function.
2. Where no capability data exists, probes choose the protocol in the same
   order.
3. Where probes can't run, such as when no credential exists yet, the
   provider family's deterministic default applies:
   - Anthropic, OpenAI, and OpenRouter: structured output;
   - custom endpoints: forced function.

   Resolution later confirms or fails that choice.

The author can override the choice, for example to reproduce an earlier
evaluator.
Whether to add `prompted-json/v1` as a last resort is an open question. If
it is added, its parse rule is strict: the whole response is exactly one
JSON object, and a verdict is never extracted from prose.

### 4. Capabilities are resolved when a binding is saved and re-checked before governed runs

**Resolution.** When a binding is saved, Rubrist resolves it:

1. **Read capability data** where the provider publishes it: Anthropic's
   `capabilities` and OpenRouter's `supported_parameters`.
2. **Probe with a fixed, non-sensitive input.**
   - Rubrist sends the exact request shape: one probe when the protocol is
     already fixed, otherwise up to three in the section 3 order.
   - For a binding that leaves `temperature` unset, it sends one extra
     probe with an explicit temperature and records whether the model
     accepts it. The governed-gate rule in section 2 depends on that
     record.
   - A binding costs at most 4 probe calls.
3. **Store the resolution record.** A binding that can't be probed is saved
   `unresolved`: for example, no credential yet (projects are seeded before
   any key exists), a 429, a 5xx, or a timeout. The record includes the
   credential source, because capabilities can differ per key.

**Where resolution is required.** Drafts and authoring may use unresolved
bindings. Candidate creation, activation, and sealed calibration require
`resolved`. If the author requested a parameter the model rejects,
resolution fails with the provider's message and a suggestion, such as
"leave temperature unset".

**Re-check before governed runs.** Before a sealed calibration is
authorized, which happens before its exposure event, and before any
governed run starts, Rubrist repeats the stored probe on the probe input,
never on sealed data. If the resolution no longer holds, the run doesn't
start and no sealed item is exposed. This keeps a provider change from
wasting a sealed revision: ADR-0009 counts an incomplete run toward the
reuse barrier, and the only remedy then is a new evaluator version.
Execution itself never re-resolves, so every item is still one physical
call.

### 5. Typed-question evaluators (#101)

`typesafe` becomes an optional provider. Rubrist must never depend on it.
This ADR covers only binary `noul` questions. `choice` and `score` wait for
ADR-0004's categorical and scalar calibration.

A typed-question evaluator's definition holds:

- **the question**: its instructions and its true and false criteria, as a
  digest;
- **polarity**: `true` means pass;
- **a decision threshold** that maps the probability to pass or fail. The
  threshold is part of the evaluator's identity, not release policy
  (ADR-0004). It is chosen on nonsealed data;
- **an output contract**: a probability and no rationale.

The execution binding carries the pinned model and `typed-question/v1`, and
#108's alias rule applies (`jev-latest` is refused at governed gates). The
verdict record states `rationale: not_provided`; it is never an empty
string or an invented summary. Receipts carry no rationale for any
evaluator, in v1 or v2.

Guidance for criterion authors says what the spike did and didn't show:

- On short, self-contained criteria, no accuracy gap showed up against
  frontier LLM judges.
- On whole-agent-run criteria, the typed-question model was at chance where
  Opus 5.5 was not.
- Injection wasn't tested.

A typed-question evaluator for a whole-run criterion therefore needs its
own calibration evidence before anyone relies on it. There is no automatic
trace-length gate until an effect is measured.

### 6. One failure taxonomy and one outcome model

Receipt v2, calibration v2, and the calibration private ledger v2 share one
closed item model.

- **Outcome** applies only to a successful call: `pass`, `fail`, or
  `abstain`.
- **Failure** takes one closed code:
  - `provider_rejected_request` (a 4xx other than authentication or rate
    limit)
  - `provider_unavailable`
  - `provider_authentication`
  - `provider_rate_limit`
  - `provider_timeout`
  - `provider_transport`
  - `provider_protocol`
  - `invalid_evaluator_output`
  - `outcome_unknown`
  - `internal`
- **`not_attempted`** marks an item that never reached the provider.
- An abstention is never a failure, and a failure is never an abstention.
- **Completeness.** A receipt is `complete` when every item was attempted
  and has an outcome. Abstentions count as outcomes and reduce coverage,
  which is reported, as in calibration. Any failure or `not_attempted` item
  makes the receipt `incomplete`.

### 7. Evidence contracts, version 2

The contracts move together in one Dailies window. The receipt answers
ADR-0003's questions as follows.

**`rubrist/assessment-receipt/v2`**:

- **Abstention versus failure:** section 6.
- **Uncertainty.** An item may carry `evaluatorScore` with a `value` in
  [0,1] and a `kind`:
  - `native_probability`: the model's own stated probability, not a
    calibrated one;
  - `self_reported_score`: an LLM's score.

  It is `null` when there is no score. A score produced by a protocol
  version that didn't state its orientation is never recorded.
- **Calibration linkage and transport.** A receipt never embeds
  calibration. Calibration stays a separately addressed artifact
  (ADR-0009). A consumer retrieves it by the evaluator version's immutable
  identity, never by a field the receipt can change.
- **Compatibility and downgrade.**
  - v1 receipts stay verifiable, and nothing rewrites them.
  - Evaluator versions created after rollout have v2 bindings and emit v2
    receipts.
  - A v1 evaluator version keeps emitting v1 until it is retired.
  - A v2 receipt is never down-converted to v1.
- **Binding.** `requestedModelBinding` is replaced by the v2 evaluator
  definition and execution binding, and `skillDigest` v2 covers them.

**`rubrist/binary-calibration/v2`** and its private-ledger v2:

- The requested binding and `requestedBindingDigest` are defined over the
  v2 execution binding.
- Error codes follow section 6.
- Aggregate-only disclosure (ADR-0009) is unchanged.

**`rubrist/evaluator-suite-manifest/v2`** references `skillDigest` v2.

**`skill-format/v2`** carries the v2 binding. A v2 binding is never exported
as `skill-format/v1`; the export refuses instead.

**Moving between versions:**

- An evaluator version has exactly one digest version.
- A v2 receipt links only to a v2 manifest and v2 calibration.
- The compatibility window ends when Dailies ships v2 verification and
  Rubrist stops emitting v1.
- Under ADR-0011's clean-install policy, no stored binding is migrated.
- If ADR-0011's exit is reached before rollout, existing v1 evaluator
  versions stay v1 and never get a second digest. Moving one to v2 means a
  new evaluator version, and ADR-0009's reuse barrier applies to it.
  - That successor's default binding copies the v1 request:
    - explicit temperature;
    - unset `topP` (v1 never sent it);
    - `anthropic.forced-tool/v1` or `openai.forced-function/v1`;
    - reasoning `disabled` where the model accepts it, otherwise the
      model's only mode, stated explicitly;
    - a token limit of 1,200 for Anthropic, unset for the OpenAI family.

### 8. Rollout

Implementation follows its own batch in `docs/implementation-batches.md`,
vendored into Dailies and Casefile. It covers:

- the shared contracts, fixtures, and conformance vectors;
- the judge runtime: protocols, capability resolution, probes, and
  re-checks;
- binding validation and persistence;
- the model picker.

Dailies vendors the v2 contracts before any v2 evidence is published.

## Alternatives considered

- **Drop unsupported parameters**, like LiteLLM's `drop_params` or the
  Vercel AI SDK. Rejected: the evidence would state a request that didn't
  happen.
- **Keep a hand-maintained list of which models accept what.** Rejected as
  the primary mechanism, because it goes stale. Provider metadata and
  probes replace it.
- **Retry at call time with different parameters.** Rejected: it breaks
  the single-physical-call ledger.
- **Keep v1 and refuse models v1 can't express.** Rejected: it excludes
  current frontier models, and the founder's requirement is that any model
  can be run.
- **Treat Jev as an OpenAI-compatible `custom` provider.** Not possible:
  its API takes state and typed questions, not chat messages.

## Consequences

- Any model whose request can be expressed and probed can be bound. The
  evidence then states exactly what was sent, with which protocol and
  reasoning, and what the provider reported back.
- Evaluator identity finally covers the injected text. A change like #121
  becomes visible as a new protocol version.
- A provider change that is visible at the re-check stops a governed run
  before any sealed item is exposed. A change that happens during a run
  still ends it incomplete, and ADR-0009's reuse barrier counts that run.
- Receipts gain a shared failure taxonomy, a completeness rule that matches
  calibration, and a clearly sourced score. #102's uncertainty selection
  can then use a real probability source.
- Dailies must ship v2 support before Rubrist publishes v2 evidence.
- Each new binding costs up to four probe calls, and each governed run
  costs one re-check call. Both are recorded.

## Open questions for the founder

1. **Explicit settings at governed gates.** Should an explicit temperature
   and reasoning setting be required wherever the model accepts them, as
   proposed, or only recommended?
2. **Default reasoning for new bindings.** Should it be `none`, which is
   cheaper and more repeatable, or an explicit provider-default level that
   is recorded as such?
3. **`prompted-json/v1`.** Should it be offered for models with neither
   structured output nor tools, or should those models be refused?
4. **Typed-evaluator threshold.** Should it be required per evaluator, or
   default to 0.5?
