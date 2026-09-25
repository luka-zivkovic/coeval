# ADR-0014: Model-agnostic evaluator execution and evidence v2

Status: **Accepted**

Date: 2026-09-24; accepted 2026-09-25

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
- The founder accepted it on 2026-09-25 and settled its four open
  questions. The last section records the answers. Implementation follows
  Batch 8 in `docs/implementation-batches.md`.

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
- **Resolution record** (not identity). It holds:
  - the capability check and probe outcomes, with the settings each probe
    sent and its cost;
  - the capability-snapshot digest;
  - the credential source (project key or platform key);
  - the reasoning-defaults table version;
  - the time of the check;
  - a status of `resolved`, `unresolved`, or `failed`.

Every part of the execution binding is fixed when the version is saved,
including the verdict protocol (section 3). Resolution can confirm a binding
or fail it; it never changes it. Evaluator versions are immutable, so a
binding that fails resolution is fixed by creating a new evaluator
version.

`skillDigest` v2 covers the definition and the execution binding, never the
resolution record. Two versions with identical definitions and bindings
therefore have the same digest, whenever they were saved. In every v2
contract, an unset value is canonical JSON `null`; it is never omitted.

### 2. The binding states exactly what is sent

- **Sampling** (`temperature`, `topP`) is either an explicit value or unset,
  and unset means not sent. v2 is the first version that actually sends
  `topP`.
- **Governed gates.**
  - At candidate creation, activation, and sealed calibration,
    `temperature` must be explicit whenever the model accepts it. It may be
    unset only where the resolution record shows the model rejecting the
    `temperature` parameter itself when sent with the saved reasoning, or
    where the family takes no sampling settings (`typesafe`, `mock`). A
    rejected value, such as a model that accepts only temperature 1, still
    requires an explicit value. Otherwise a provider could change its
    default under a pinned model id, and "unset" evidence couldn't tell
    those runs apart.
  - `topP` may stay unset at the gates. Some models reject `temperature`
    and `top_p` together.
  - Authoring may leave either unset.
  - The seeded default binding keeps an explicit temperature of 0 where
    the model accepts it.
  - The model picker hides any sampling field the capability check (section
    4) shows the model rejecting outright. That field is recorded as not
    sent, and the author never sees or sets it. A temperature outcome holds
    only for the reasoning it was probed with, so if the author saves
    different reasoning, the field is shown again and resolution probes it.
    Where no check could run, the field is shown, and resolution decides the
    gate.
- **Reasoning** has a closed, typed shape per provider family:
  - Anthropic: `thinking` of `disabled`, `enabled` with a token budget, or
    `adaptive`, plus an effort level where supported.
  - OpenAI: `reasoning_effort`.
  - OpenRouter: its `reasoning` object.

  - **A new binding starts from the provider's default reasoning, which the
    author saves explicitly.**
    - Capability data can't say what a model's default is. ASSUMPTION, per
      Anthropic's model documentation as reviewed on 2026-09-25:
      `claude-opus-4-8` and `claude-opus-5-5` report the same thinking
      capabilities, but the first defaults to no thinking and the second to
      adaptive.
    - So the default comes from a dated, versioned table of documented
      provider defaults (`rubrist-reasoning-defaults/v1`). Each entry
      records its source. ASSUMPTION, per Anthropic's documentation as
      reviewed on 2026-09-25:
      - `claude-sonnet-4-6`: `disabled` at effort `high`;
      - `claude-opus-5-5`: `adaptive` at effort `medium`.
    - The table is a source of suggestions, not of capability truth. The
      capability check decides what the model accepts, and the author's
      saved value is what is sent.
  - **The capability check fills the picker** (section 4). The picker shows
    the documented default as the starting value, including effort where
    the shape has one. It offers every mode of the family's shape except
    those that published data or a probe shows the model rejecting, and
    marks modes no probe tested as "confirmed at resolution". Where the
    model rejects the reasoning parameter itself, the field is hidden and
    recorded as not sent.
  - **The author saves an explicit value.** Where the table has no entry,
    the author chooses and there is no pre-filled default. The author can
    choose any offered mode. ASSUMPTION, per Anthropic's documentation:
    `claude-opus-5-5` accepts only `adaptive`, and its `disabled` returns an
    error.
  - **Resolution only confirms.** The confirming probe sends the saved
    reasoning. Resolution never writes it, and a mode the model rejects
    fails resolution. A stale table entry can therefore only suggest the
    wrong starting value. It can never put a request into the evidence
    that wasn't sent.
  - **Governed gates.** Reasoning must be explicit. It may be unset
    (`null`, not sent) in only two cases:
    - where the family has no reasoning shape (`typesafe`, `mock`);
    - where the record shows the model rejecting the reasoning parameter
      itself, not just some of its values, as for OpenAI-compatible models
      that reject `reasoning_effort`.
  - **The seeded default binding** states every identity field:
    - provider `anthropic` on its managed endpoint, with no OpenRouter
      routing;
    - model id and model version `claude-sonnet-4-6`;
    - temperature 0, and `topP` unset;
    - thinking `disabled` at effort `high`, the table's documented default
      (an ASSUMPTION as above);
    - `anthropic.structured-output/v1`;
    - an output token limit of 1,200.

    It is saved `unresolved`, because projects are seeded before any key
    exists, and it resolves when a governed gate or run first needs it, or
    on demand (section 4).
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
`openai.forced-function/v1`, `prompted-json/v1`, `typed-question/v1`, and
`mock/v1`.

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
   function, then `prompted-json/v1`.
2. Where no capability data exists, the capability check's probes choose
   the protocol in the same order, before save.
3. Where probes can't run, such as when no credential exists yet, the
   provider family's deterministic default applies:
   - Anthropic, OpenAI, and OpenRouter: structured output;
   - custom endpoints: forced function.

   The author saves it, and resolution later confirms or fails it.

The author can override the choice, for example to reproduce an earlier
evaluator.
`prompted-json/v1` is offered as the last resort, for models with neither
structured output nor tool calling. Its parse rule is strict: the whole
response must be exactly one JSON object, and a verdict is never extracted
from prose. Because the protocol id is part of the binding, the evidence
names it, and consumers can see it.

### 4. Capabilities are checked before save, confirmed after, and re-checked before governed runs

**Capability check (before save).** When the author picks a model and a
credential exists, the model picker runs a capability check.

1. **Read the published data.** It reads capability data where the provider
   publishes it (Anthropic's `capabilities`, OpenRouter's
   `supported_parameters`) and the reasoning-defaults table from section 2.
2. **Probe with a fixed, non-sensitive input**, at most 6 calls:
   - up to three protocol probes, in the section 3 order, until one
     succeeds. They send no optional sampling or reasoning fields, so a
     parameter the model rejects can't hide which mechanism works;
   - one temperature probe on that protocol, with an explicit temperature
     and the documented default reasoning (no reasoning fields where the
     table has no entry). Its outcome holds only for that reasoning,
     because (ASSUMPTION, per Anthropic's documentation) some models accept
     temperature only with thinking off;
   - up to two reasoning probes on that protocol: the documented default,
     or a middle value of the family's shape (such as effort `medium`)
     where the table has no entry; and the no-reasoning setting where the
     shape has one (`disabled`, or `none` for OpenAI).
3. **Record the outcomes, which drive the picker.** The picker:
   - pre-selects the protocol that succeeded;
   - hides the temperature field where the model rejected the parameter
     with the reasoning the author has selected;
   - offers the family's reasoning modes as section 2 describes, and hides
     the field where the model rejected the reasoning parameter itself;
   - pre-fills the documented default.

**How probe failures are read.** A rejection that names the output
mechanism (tool choice, response format) moves on to the next protocol. A
rejection that names a parameter marks the parameter rejected outright; one
that names only a value marks that value rejected. Neither moves the
protocol down. On a temperature or reasoning probe, a rejection Rubrist
can't attribute counts as a value rejection, so it never lets a setting go
unset. A protocol probe sends no optional settings, so its unattributed
rejection moves on to the next protocol.

**Resolution (after save).** When the author saves, the check's outcomes
become the binding's resolution record. Resolution then sends one confirming
probe with the exact saved request. Where temperature is unset and no
temperature probe with the saved reasoning has a recorded outcome, it also
sends one, so at most 2 calls. Resolution never changes the binding, and
every identity field, including the protocol, is the author's saved value.

**Unresolved bindings.** Where no check can run, the picker shows the
provider family's fields, the table default, and the family's deterministic
protocol from section 3. Examples:

- no credential yet (projects are seeded before any key exists);
- a 429, a 5xx, or a timeout.

The binding is saved `unresolved`, and resolution runs automatically the
first time a governed gate or governed run needs it, or on demand. At that
point it sends the confirming probe. Where the family has the setting and
the binding leaves it unset, it also sends a temperature probe with the
saved reasoning and a reasoning probe (the documented default, or a middle
value), so at most 3 calls. That
gives the gate rules in section 2 a recorded answer.

**Which outcomes fail a binding.** Only the confirming probe can set
`failed`, and only when the provider rejects the request
(`provider_rejected_request`) or the response breaks the protocol
(`provider_protocol`). Authentication, rate-limit, timeout, transport,
availability, and invalid-output errors leave the binding `unresolved`: the
gate or run doesn't proceed, and resolution runs again the next time it's
needed. The record keeps the latest resolution attempt's probes, which the
status and gates read. An earlier attempt that ended `unresolved` is
recorded, with its probes and cost, against the gate, run, or request that
triggered it, as the re-check is.

**Where resolution is required.** Drafts and authoring may use unresolved
bindings. Candidate creation, activation, and sealed calibration require
`resolved`. A binding that fails resolution is fixed only by a new evaluator
version. The failure carries the provider's message and a suggestion that
depends on what was rejected: "leave temperature unset" only where the
parameter itself was rejected, and "choose another value" where only a value
was.

**The resolution record** holds the fields listed in section 1. It records
the credential source because capabilities can differ per key.

**Re-check before governed runs.** Before a sealed calibration is
authorized, which happens before its exposure event, and before any
governed run starts, Rubrist repeats the confirming probe. Where the family
has the setting and the binding leaves it unset, it also repeats the
temperature probe with the saved reasoning or the reasoning probe, so one to
three calls. A
provider that starts accepting an unset setting would otherwise apply its
own default unseen. It uses the probe input and never sealed data. If the
resolution no longer holds, the run doesn't start and no sealed item is
exposed. The re-check is recorded with the run or authorization it guards,
and it never changes the resolution record, so a transient error delays a
run but never fails the binding. This keeps a provider change from wasting a
sealed revision: ADR-0009 counts an incomplete run toward the reuse barrier,
and the only remedy then is a new evaluator version. Execution itself never
re-resolves, so every item is still one physical call.

### 5. Typed-question evaluators (#101)

`typesafe` becomes an optional provider. Rubrist must never depend on it.
This ADR covers only binary `noul` questions. `choice` and `score` wait for
ADR-0004's categorical and scalar calibration.

A typed-question evaluator's definition holds:

- **the question**: its instructions and its true and false criteria, as a
  digest;
- **polarity**: `true` means pass;
- **a decision threshold** that maps the probability to pass or fail. Every
  typed-question evaluator must declare one; there is no default. The
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
  probes replace it. The only table Rubrist keeps, the documented reasoning
  defaults, suggests a starting value. It never decides what a model
  accepts or what is sent.
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
- Each capability check costs up to six probe calls, each resolution
  attempt up to three, and each governed-run re-check one to three. All
  are recorded.
- A provider that rejects the temperature or reasoning parameter with an
  error Rubrist can't attribute can't be governed on that setting: unset is
  refused at the gate, and every explicit value fails resolution. Better
  attribution for that provider is the fix, never a looser gate.

## Founder decisions on the open questions (2026-09-25)

1. **Explicit settings at governed gates: required.** Where the model
   accepts it, a governed evaluator states its temperature and reasoning.
   The model picker hides a field the capability check shows the model
   doesn't support. Where no check could run, resolution enforces the gate.
   Sections 2 and 4 cover this.
2. **Default reasoning for new bindings: the provider's default, stated
   explicitly.** The picker pre-fills it from a dated table of documented
   defaults, and the author saves it. For a model with no table entry, the
   author chooses. Section 2 covers this. An independent review on
   2026-09-25 found that capability data can't supply the default, so the
   table replaced that mechanism before implementation.
3. **`prompted-json/v1`: offered**, with the strict single-object parse
   described in section 3.
4. **Typed-evaluator threshold: required per evaluator**, with no default.
   Section 5 covers this.
