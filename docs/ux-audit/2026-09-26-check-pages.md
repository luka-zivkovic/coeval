# UX audit 3: the evaluator pages (evaluator, editor, versions, compare)

Status: **audit record, not product authority.** It records CURRENT
observations and proposals for founder review. Its open questions were
settled on 2026-09-26 by taking the recommended options; see
[Decisions](#decisions). No item proposes an ADR.

Last reviewed: 2026-09-26 · code at `2c82321`

Vocabulary: findings quote today's UI words. Proposals, blueprints, and
decisions use the single vocabulary of
[ADR-0015](../decisions/0015-one-vocabulary-and-two-display-modes.md)
(Proposed): evaluator, rubric, case, assessment, golden set, review queue,
and regression check. It applies in both of that ADR's display modes,
Beginner and Standard.

This round covers the pages behind the Review guide nav item:

- the evaluator page at `/skill`;
- the editor at `/skill/edit`, with its regression-check outcomes;
- version history at `/skill/versions` and one version at
  `/skill/versions/:id`;
- the comparison at `/skill/compare`.

First-run setup (`/skill/edit?first=1`) is out of scope; it is the next
round. The shell findings from [round 1](2026-09-26-shell-and-overview.md)
apply here and are not repeated:

- S1: nav label, crumb, and title disagree ("Review guide", "Skill", "Edit
  the evaluator");
- S2: `/skill/versions` never shows its own crumb;
- S3: no route sets a document title, and page titles are not headings.

Round 2's T10 (buttons that navigate instead of links) also applies. These
pages hold 17 of the app's 58 `onClick={() => navigate(…)}` handlers: 14 on
buttons, and three on clickable rows that keep a real link inside.

## How to read this

Evidence labels, severity scale, and statuses follow
[round 1](2026-09-26-shell-and-overview.md#how-to-read-this). Each finding
also carries an effort estimate:

- quick: under an hour;
- medium: under a day;
- large: more than a day, or a new pattern that several screens adopt.

There is no product analytics, so every severity was judged without frequency
data.

Rules cite the `ux-craft` references on overclock branch
`claude/app-layout-dashboard-audit-ywvz9j` at `8fa9f51`. That commit added the
rules this round leans on most:

- `states.md` › Three kinds of empty, and › Rules ("Every wait ends", "Offer
  Retry only when retrying can work");
- `decisions.md` › Errors and recovery;
- `navigation.md` › "The URL holds the view" and "Navigation is a link";
- `review.md` › "Behind a scroll".

Components in proposals follow the middle path recorded in
[round 2](2026-09-26-triage-flow.md#components-in-the-proposals). Each one is
marked *installed*, *add*, or *Rubrist*.

## Method

- **Code read.** The five route components and their parts:
  - `screens/skill.tsx`;
  - `screens/skill-edit.tsx`, `screens/skill-edit/editor.tsx`, and
    `screens/skill-edit/regression.tsx`;
  - `screens/skill-versions.tsx` and `screens/compare-versions.tsx`;
  - `components/skill-edit-flow.tsx` and `components/rubrist/gate.tsx`;
  - `lib/judge-provider-selection.ts`, and every screen that links to the
    editor (C3);
  - the version-creation route in
    `apps/api/src/routes/skill-administration.ts`.

  Paths are relative to `apps/web/src` unless they start with `apps/`.
- **TARGET intent.** Read in `PRODUCT.md`, `docs/beginner-onboarding-journey.md`
  (BOJ), `docs/glossary.md`, and ADR-0010 and ADR-0014 (both Accepted). No
  ADR is Proposed. BOJ is the first-run contract (BOJ:7-8), so applying it to
  these pages is marked ASSUMPTION.
- **CURRENT intent.** `docs/architecture.md` (ARCH) for the regression gate.
- **Rendering.** Demo stack at 1440×900 and 390×844 in Guided display, plus
  Technical display for the version page. The demo evaluator is "Support Answer
  Quality" at v1.2.0 (current) with one earlier version, v1.1.0. The owner is
  the viewer, and the Golden set holds 2 cases.
- **Synthetic states.** These came from `page.route` rewrites; no demo data
  was changed:
  - the viewer as a member, and an evaluator marked "Starter · unvalidated";
  - a 5 s delay for the loading states, and a 500 for the error states;
  - the regression check's four outcomes. The save request returns a
    blocked (409), passed, or failed (201) result, or a queued version (202)
    whose regression record never arrives.
- **Measurements** follow `review.md` §3, including the new split between
  clipped controls and controls behind a scroll.
- **Vocabulary.** I ran `scan_labels.py` over the seven evaluator-page files,
  using a throwaway `UX.md` built from the contract's glossary, as in round 2.
  The files are `screens/skill.tsx`, `screens/skill-edit.tsx`,
  `screens/skill-edit/editor.tsx`, `screens/skill-edit/regression.tsx`,
  `screens/skill-versions.tsx`, `screens/compare-versions.tsx`, and
  `components/skill-edit-flow.tsx`.

## Top findings, in fix order

| # | Finding | Sev | Effort | Status |
|---|---|---|---|---|
| 1 | Missing regression evidence reads as clean. Versions with no recorded check wear "regression · clean". Compare reports 0 regressions from zero recorded runs, and its header counts saves as recorded runs. (C1) | 4 | medium | fix |
| 2 | Members can open an editor they cannot save. Six entry points skip the owner check, and in Postgres mode the API refuses the save with a 403. (C3) | 3 | medium | fix |
| 3 | The editor discards unsaved work. A template click, "Reset", Cancel, Back, and Version history all drop typed text without asking. (C2) | 3 | medium | fix |
| 4 | Opening the editor swaps an unavailable provider without asking, and the change review counts the swap as the owner's edit. (C13) | 3 | medium | fix |
| 5 | On phones, the override button runs off the screen, and the version tables hide their evidence columns behind a sideways scroll. (C4) | 3 | medium | fix |
| 6 | The version page is titled with the model name, opens with the Judge Card before what changed, says "current" twice, and offers no next step. (C5) | 3 | medium | fix (D1, D5) |
| 7 | The editor is reached through seven different labels, and status words come from legacy version status. (C12) | 3 | large | fix (D6) |
| 8 | Load failures read as "Version not found" or "Nothing to compare yet". Failed evidence reads vanish or show as empty, and error states tell users to start the API. (C7) | 2 | large | fix |
| 9 | Waits never end. The running check polls forever with no elapsed time, and a count can say "Loading…" indefinitely. (C6) | 2 | medium | fix |
| 10 | The check's outcomes point away from the fix. A blocked result makes the override the filled button, and a failed check offers no Retry. (C8) | 2 | quick | fix (D2, D3) |
| 11 | The editor buries the Review guide below four blocks. A chosen template looks like a primary, and save is enabled with nothing changed. (C9) | 2 | medium | fix (D4) |
| 12 | The evaluator page's tabs are not in the URL. A metric doubles as a navigation button, and the guide's own heading repeats the title in bold. (C10) | 2 | medium | fix |
| 13 | Compare's pickers can trap a reversed pair that the page then asks you to swap. (C11) | 2 | quick | fix |

---

## What holds up (*keep*)

- **Saving never overwrites.** Every save creates an immutable version, and the
  editor says so before the save. Its change review marks each field changed
  or unchanged, gives line counts, and shows both sources side by side on wide
  screens (`components/skill-edit-flow.tsx:124-146,167-223`). This matches
  TARGET ADR-0014:224 ("Evaluator versions are immutable").
- **The save has visible stages.** A four-step strip (review, create, check,
  outcome) announces each step through a live region, moves focus to the
  current step (`components/skill-edit-flow.tsx:65-67`), and stays pinned on
  wider screens (`:73`).
- **A reload resumes the exact version.** The queued version's id stays in
  `?version=`, so a reload during the check returns to it
  (`screens/skill-edit.tsx:280-313,355-361`).
- **Compare keeps its pair in the URL** (`?from=` and `?to=`,
  `screens/compare-versions.tsx:44-45,134-141`). Its totals sum only recorded
  runs (`:120-129`), and its subtitle says it "does not invent missing
  results" (`:176`). Its header still counts saves as recorded runs (C1).
- **The honesty copy is present.**
  - "Passing is not an overall quality or release decision"
    (`screens/skill.tsx:186-192`). This matches TARGET PRODUCT.md:116-117: a
    release decision "is not part of Rubrist's evidence."
  - "Runnable is not the same as accurate" on a starter Check (`:106-110`).
    BOJ:272 says the same for first run.
  - "A failed or partial check cannot count as a pass"
    (`screens/skill-edit/regression.tsx:326-329`). This matches TARGET
    PRODUCT.md:201; BOJ:279 repeats it for first run.

  C1 is where the pages contradict their own copy.
- **A pinned model stays pinned.**
  - A pinned model that dropped out of the catalog stays selected with a
    warning (`screens/skill-edit/editor.tsx:351-366`).
  - A movable alias gets a warning about activation
    (`screens/skill-edit/editor.tsx:389-394`).

  The provider is not protected the same way: when it is unavailable, the
  editor swaps it (C13).
- **Version rows are real links.** Each row keeps a `RowLink` on its version
  number (`screens/skill-versions.tsx:182-191`).
- **The editor's primary sits at the end of the form**, with Cancel apart on
  the left (`archetypes.md` › Form).

---

## Findings

### C1. Missing regression evidence reads as clean

Sev 4 · CURRENT vs TARGET · *fix* · medium

`gateStateForVersion` returns "clean" unless one of these holds
(`components/rubrist/gate.tsx:26-33`):

- the version failed or is regressing;
- it has no agreement value;
- a known-limitation string matches.

It never asks whether a regression run was recorded. Neither demo version has
one. As rendered:

- **Version history.** Both rows show "regression · clean"
  (`screens/skill-versions.tsx:196`) beside "no regression receipt"
  (`screens/skill-versions.tsx:227-229`).
- **Version page.** The chip reads "regression · clean"
  (`screens/skill-versions.tsx:390`). On the same page, the Judge Card says
  "Evaluator regression: no recorded run" (`screens/skill-versions.tsx:649-654`),
  and its basis says "no recorded gate run for this version".
- **Compare.**
  - The path row shows "regression · clean"
    (`screens/compare-versions.tsx:284-287`) next to "no run recorded for this
    save" (`screens/compare-versions.tsx:310`).
  - The tiles read "Regressions across versions 0" and "Improvements 0"
    (`screens/compare-versions.tsx:234-240`), summed from zero recorded runs.
    Only the fourth tile's foot says "0 with a recorded run".
  - The picker bar reads "1 recorded run between them"
    (`screens/compare-versions.tsx:203-205`). It counts saves, not runs: the
    same number fills the "Saves between" tile (`:241-245`).
  - The path card says "Each row is a recorded evaluator-version regression
    check" (`:252`) above a row whose run was never recorded.
  - On phones, the "On the record" column that explains the gap sits behind
    the sideways scroll (C4).

TARGET: PRODUCT.md:201: "Missing or failed evaluation is never converted into
a favorable result."

By analogy only, since that section governs Analyze workflow measurements:
ADR-0010:264-266, "Missing, still-running, censored, incomplete, and
later-revoked states remain explicit rather than becoming zero or success."

Rule: `states.md` › Rules ("show '—' for a missing value");
`review.md` › Mislabelled data.

Proposal:

- Add a "No recorded regression check" gate state, neutral rather than the
  pass variant, for every version without a regression run.
- In compare, show "—" with "no recorded regression check" for any total that
  includes an unrecorded hop, never a bare 0.
- Count saves and runs separately in the picker bar: "1 save between them ·
  0 recorded runs".

Any version with no persisted run shows this. That includes versions created
before the gate, which the Judge Card's basis names as one case.

### C2. The editor discards unsaved work

Sev 3 · CURRENT · *fix* · medium

Nothing guards the form. The trace-test builder already does: it calls
`useBlocker(dirty)` (`screens/trace-test-builder.tsx:148`) and asks "Leave with
unsaved changes?" (`screens/trace-test-builder/components.tsx:789`).

- **Leaving loses the text.** I typed into the Review guide and clicked
  "Version history". The page left without asking. Once the versions page had
  rendered, I pressed Back: the editor showed the saved guide, and the typed
  text was gone.
- **A template click overwrites it.** Clicking a template replaces the Review
  guide and the prompt (`applyStarter`, `screens/skill-edit.tsx:184-192`) with
  no confirmation or undo. Rendered: the typed text became the "RAG
  faithfulness" template. The only warning is a mono caption, "templates
  overwrite the form · model binding kept"
  (`screens/skill-edit/editor.tsx:175`).
- **"Reset to v1.2.0" does the same without asking**
  (`screens/skill-edit/editor.tsx:116-118`, `screens/skill-edit.tsx:209-213`).
- **Other exits leave without asking:**
  - "Back to skill" (`screens/skill-edit/editor.tsx:100-102`);
  - "Version history" (`screens/skill-edit/editor.tsx:113-115`);
  - Cancel (`screens/skill-edit/editor.tsx:508-510`).

Rule: `decisions.md` › Back, Cancel, Close, and unsaved changes;
`decisions.md` › Confirmation, undo, or nothing.

Proposal:

- Block leaving while the form differs from its state when it opened, as the
  trace-test builder does. Ask in an `AlertDialog` (*add*), not another
  hand-built dialog. Compare with the opened form, not the base version: C13's
  provider swap makes those differ before the user types anything.
- Make template and reset undoable: apply at once and offer Undo in a toast
  (`Sonner`, *add*). Alternatively, confirm in an `AlertDialog` only when the
  form has unsaved changes.

### C3. Members can open an editor they cannot save

Sev 3 · CURRENT · *fix* · medium

- **The API refuses non-owners.** In Postgres mode it rejects a new version
  from anyone but an owner, returning 403 "Only owners can edit skills"
  (`apps/api/src/routes/skill-administration.ts:386-391`). Demo mode skips
  this check, so the synthetic member in the renders below could still save.
- **Two entry points check the role; six do not.** The evaluator page hides "Edit
  evaluator" from non-owners (`screens/skill.tsx:97-101`), and the setup
  ledger shows "Review the Check" only to owners
  (`components/first-run-setup-ledger.tsx:53-54`). These open the editor for
  anyone:
  - "Open rubric alongside" on the provisional queue
    (`screens/exceptions.tsx:330-332`);
  - "Draft rubric edit from these cases" in the review done view
    (`screens/review.tsx:168-170`, navigating at `:100`);
  - "Review the rubric" on the provisional Traces page
    (`screens/traces.tsx:223-225`);
  - "Review Check", the Overview journey's next action once the evaluator is
    no longer a starter and its current version is neither approved nor in
    production (`components/rubrist/journey-pipeline.tsx:39-44`,
    `lib/journey.ts:50-53`). Rendered with the
    viewer as a member and the version "validated": the button landed on
    `/skill/edit`;
  - "Set up without a run" in the setup ledger, which opens the ordinary
    editor once the evaluator is no longer a starter
    (`components/first-run-setup-ledger.tsx:21,40-41`);
  - "Review the Check" on a failed first Result
    (`screens/first-result.tsx:334-336`).
- **The editor checks the role only in first-run setup**
  (`screens/skill-edit.tsx:781`). Rendered with the viewer as a member, the
  ordinary editor shows every field and an enabled "Create version & check
  references", and never mentions owners.

A member can rewrite a whole rubric and learn only at save that they
cannot keep it.

Rule: `decisions.md` › Errors and recovery ("Prevent what you can foresee";
"Offer an action the viewer can take").

Proposal:

- For non-owners, show the entry points as "View evaluator", linking to
  `/skill`.
- If a member reaches `/skill/edit` directly, render the evaluator read-only
  with "Only an owner can save a new version. Ask Product Lead." The owner's
  name is already on the evaluator page (`screens/skill.tsx:161`).

### C4. On phones, the override runs off the screen

Sev 3 · CURRENT · *fix* · medium

- **Blocked result.** "Create a new version with override" spans x=178–423 at
  390 px, so the page scrolls sideways by 33 px. Its row does not wrap. It
  holds "Back to edit", a spacer, and a label that does not wrap
  (`screens/skill-edit/regression.tsx:441-453`).
- **Version history.**
  - The table scrolls inside a 348 px region to 649 px.
  - Version, Status, and "Changes / model" show, and "Golden agree" is cut in
    half.
  - Strict, Lenient, and Recorded sit behind the scroll with no visible cue
    (`screens/skill-versions.tsx:147-239`).
- **Compare.** The path table scrolls to 493 px. "On the record", the column
  that explains a missing run, is fully hidden.
- **Evaluator page.** The tab rail, Regression, and Ownership blocks stack above
  the Review guide, which starts at y=789 (`screens/skill.tsx:124-184`).

The severity rests on the blocked result: the whole page scrolls sideways at
the one moment an owner has to act. The tables alone repeat round 2's T5,
which rated Sev 2.

Rule:

- `shadcn.md` › Responsive rules in Tailwind (a row that holds actions wraps);
- `review.md` › "Behind a scroll";
- `layouts.md` › Table page (cards or a stacked list on narrow screens).

Proposal:

- Let the override row wrap (`flex-wrap`), and shorten the button to "Override
  with reason".
- Below `md`, render version rows and compare steps as stacked items that keep
  status and the gate state visible.
- On the evaluator page below `lg`, put the rubric first and the metadata
  after it.

### C5. The version page names the model, leads with evidence, and offers no next step

Sev 3 · CURRENT · *fix* · medium · decided in D1 and D5 · extends round 1's O7

- **The title is the model id,** "anthropic/claude-sonnet-4-6"
  (`screens/skill-versions.tsx:380-382`). The version number appears only in
  small type: the eyebrow ("Judge card · v1.2.0", `:381`), a mono line
  (`:372`), and the Judge Card's own eyebrow (`:619`). Two versions on the
  same model share a title. This extends S1 and S3.
- **"Current" appears twice.** The status chip maps `production` to "current"
  (`screens/skill-versions.tsx:388`, with the label at `:33`), and a second
  chip is added when the version is current (`:391`). Rendered: "CURRENT ·
  regression · clean · CURRENT".
- **Technical evidence comes first.** The page opens with the attested Judge
  Card (`screens/skill-versions.tsx:396`): execution binding, rubric
  provenance, κ with reviewer ids, and self-consistency. The Review guide, which
  the evaluator page's own copy calls "the main content reviewers should read and
  edit" (`screens/skill.tsx:202-203`), comes after it
  (`screens/skill-versions.tsx:398-408`).
- **Facts repeat.**
  - The model appears in four places: the mono line (`:371-377`), the title
    (`:382`), a Judge Card row (`:639-640`), and the binding card
    (`:446-478`). The full binding is spelled out twice: in that Judge Card
    row and in the card's "Binding" row (`:460-461`).
  - Known-failure agreement appears twice in two formats: "recorded ratio 0.86"
    (`:643-648`) and "86%" (`:432-435`).
- **An empty state is a bare API instruction.** On v1.1.0, which has no
  repeat runs, the self-consistency section tells users to call
  `POST /api/v1/judge` with `force: true` (`:700-705`). It never says what
  self-consistency measures. Guided and Technical display render the same
  page (2,612 px tall at 1440 in both).
- **No next step.** The page offers no "Compare with current" and no "Start a
  new version from this one". Its actions are "Back to versions", three
  exports ("Export as Markdown", "Copy", and "SkillFormat"), and the case
  links in the convergence card.

CURRENT promise: Guided display "hides secondary diagnostics and technical
details" (`lib/display-mode.ts:15`). This page hides none of them. ADR-0015
(Proposed) drops that promise: both of its display modes show technical
detail, and Beginner mode explains it. The page's problems are its order, its
title, and its missing next step, not the detail it shows.

Rule: `archetypes.md` › Detail (the primary action is the object's most
common next step); `review.md` › Repeated facts; `labels.md` › Page titles
and navigation labels.

Proposal:

- Title the page "Version 1.2.0", with one status chip.
- Lead with what changed from the previous version, then the rubric.
- Move the Judge Card, κ, and self-consistency into an "Evidence" section
  after the rubric, open in both display modes (D1).
- Add "Compare with current" as a link to `/skill/compare?from=…&to=…`.
- For owners, add "Start a new version from v1.2.0", linking to
  `/skill/edit?from=<id>` (D5).
- Keep the API instruction, which technical users can act on, and say what
  it measures: "No case has been assessed twice under this version. To
  measure self-consistency, re-assess a case with `force: true` on
  `POST /api/v1/judge`."

### C6. Waits never end

Sev 2 · CURRENT · *fix* · medium

- **The running check polls forever.** It polls every 2 s with no limit
  (`screens/skill-edit.tsx:393-431`, repeating at `:423`). With the regression
  record withheld, it made 7 requests in about 8 s: three at the start in the
  dev build, then one every 2 s. It never showed elapsed time or an end.
- **A count can load forever.** "Cases in revision" reads "Loading exact
  count…" whenever the count is unknown
  (`screens/skill-edit/regression.tsx:165`). The count stays unknown when the
  version has no pinned revision, or when the metadata read fails or returns
  nothing (`screens/skill-edit.tsx:371-391`, the swallowed failure at
  `:380-387`). The API refuses to queue a version without a pinned revision
  (`apps/api/src/routes/skill-administration.ts:432-436`), so in practice a
  failed read is the cause. Rendered with a synthetic unpinned version: still
  "Loading exact count…" after 10 s.
- **Version history polls too.** It polls every 3 s while any version is
  "regression running" (`screens/skill-versions.tsx:81-103`). The chip shows
  no elapsed time either.

Rule: `states.md` › Rules ("Every wait ends"); `decisions.md` › Errors and
recovery ("A long wait says what it is waiting on").

Proposal:

- Show "Started 2 min ago" on the running card and on the list chip.
- Past a set time, say the check is taking longer than usual. Keep "safe to
  leave" and the link to history.
- Say "Count unavailable" when there is no revision or the read failed.

### C7. Failures read as "not found", "nothing to compare", or empty

Sev 2 · CURRENT · *fix* · large

- **Version page.**
  - A failed read of the skill, the version list, or the regression record
    titles the page "Version not found" (`screens/skill-versions.tsx:282-293`,
    caught at `:322-323`, rendered at `:344-360`). That includes a version that
    loaded but whose regression read failed. Rendered with the versions
    request returning 500: "Version not found".
  - The Judge Card, convergence, and self-consistency reads swallow their
    failures (`:299-320`). With the Judge Card request returning 500, the card
    was missing with no message. A failed self-consistency read shows "No
    repeat runs under this version yet" (`:700-705`).
- **Compare.**
  - The version list has no loading state. While it loads, the list is empty,
    so the page renders "Nothing to compare yet" with "All versions"
    (`screens/compare-versions.tsx:151-164`). Rendered 1.5 s into a 5 s load.
    Only the path table has a loading row, "Loading recorded runs…"
    (`:267-270`).
  - While those runs load, the tiles already read "Regressions across
    versions 0", "Improvements 0", and "0 with a recorded run": the totals
    start from an empty list (`:120-129`). Rendered 1.5 s into a 5 s load.
  - A failed regression read becomes "no run recorded for this save"
    (`.catch(() => null)` at `:110`). Rendered with that request returning
    500.
- **Error states.**
  - The evaluator page, the editor, and version history print the raw error, or
    the developer instruction "Start the API with `pnpm dev:api` and refresh."
    None offers Retry (`screens/skill.tsx:62-73`, `screens/skill-edit.tsx:668-684`,
    `screens/skill-versions.tsx:113-124`).
  - Compare puts the raw error in its subtitle
    (`screens/compare-versions.tsx:146`).
  - A malformed response (synthetic, during this round's rendering) printed a
    raw JSON validation dump under "Could not load skill".
- **Loading states are a title alone**, with no skeleton: "Loading skill",
  "Loading versions", "Loading version".

The queue's error state in round 2 has the same shape.

Rule: `states.md` › Three kinds of empty ("A failed load is none of these");
`states.md` › Rules ("A value that has not loaded is not zero"; "Offer Retry
only when retrying can work"); `review.md` › Errors shown as empty;
`review.md` › Hardcoded diagnostics; `decisions.md` › Errors and recovery
(the error's surface matches its scope).

Proposal: one page-state pattern for all five routes:

- `EmptyShell` (*Rubrist*) with "Couldn't load … " and Retry;
- `Skeleton` (*add*) in the page's shape while loading;
- "Version not found" only on a 404;
- a failed section read says so inside its section, with Retry, while the
  rest of the page keeps working;
- compare's tiles show "—" until every run has loaded.

### C8. The check's outcomes point away from the fix

Sev 2 · CURRENT · *fix* · quick · decided in D2 and D3

- **Blocked.**
  - The only filled button is "Create a new version with override", in the
    `signal` variant (`screens/skill-edit/regression.tsx:446-452`). It stays
    disabled until the reason has 8 characters.
  - "Back to edit" is a ghost button (`:442-444`).
  - At 1440 the override sits at y≈1301, below the fold.
- **Regression check incomplete.** The card says to "retry from the editor"
  (`screens/skill-edit/regression.tsx:328`), but there is no Retry. The filled
  button is "View skill versions" (`:461-463`), and "Back to edit" is a ghost
  button (`:458-460`).
- **Passed and failed** both end on "View skill versions"
  (`screens/skill-edit.tsx:749,761`), not on the evaluator the user just
  changed.

Context:

- CURRENT (ARCH:214-216): a regressing version cannot replace the approved one
  "unless an owner records an explicit override reason."
- TARGET for Batch 6 lineages (ADR-0010:214-216): "blocked, overridden, or
  error results cannot activate."

Rule: `placement.md` › In shadcn apps ("One filled button per page state");
`decisions.md` › Errors and recovery ("One way forward"; "Offer Retry only
when retrying can work"). Which path gets the filled button is a design
choice, not a rule: D2 makes revising the default because the override
records an exception to the gate.

Proposal (decided in D2 and D3):

- **Blocked:** the primary is "Revise the edit". The override moves into a
  secondary "Record an override…" disclosure, which keeps its reason field.
- **Regression check incomplete:** the primary is "Back to edit". There, the
  unchanged form's save reads "Re-run the regression check" and creates the
  next version (D4). When the
  version's provider is unavailable, retrying cannot work, so the primary is
  "Open Settings" instead.
- **Passed:** the primary is "View evaluator" (`/skill`).

### C9. The editor buries the Review guide and blurs its controls

Sev 2 · CURRENT · *fix* · medium · decided in D4

- **The guide starts low.** The editable Review guide starts at y≈739 in a
  900 px window. Four blocks come first: the subtitle, the step strip, the
  regression banner, and the template row
  (`screens/skill-edit/editor.tsx:105-178`).
- **A chosen template looks like a primary.** A selected template chip uses the
  primary's ink fill (`screens/skill-edit/editor.tsx:165-167`). After applying
  one, the page measured two filled buttons. Round 2's T7 made the same
  diagnosis for the queue's filter chips.
- **Step 1 is misnamed.** The progress strip's first step reads "Review changes"
  while the user is editing (`components/skill-edit-flow.tsx:52`).
- **"Apply to" says "verdicts".** Its scopes read "New traces only" and
  "Existing verdicts untouched" (`screens/skill-edit/editor.tsx:24-28`). The
  glossary's word for an evaluator's output is "assessment"
  (`docs/glossary.md:53-55`).
- **Save works with nothing changed.**
  - The save condition has no change check (`screens/skill-edit.tsx:552-563`),
    so save stays enabled.
  - When the stored provider is available, the change review reads "0
    evaluator fields changed" (`components/skill-edit-flow.tsx:183-185`), and
    saving creates an identical version. The demo already holds one: v1.2.0
    matches v1.1.0 in every evaluator field, so Version history labels it "no
    evaluator-field change" (`lib/skill-edit-flow.ts:49`). ADR-0014:236-237
    notes that identical definitions and bindings share a digest.
  - Without that provider, as in the demo, the editor swaps in another binding
    and counts it as a change (C13).

Rule: `archetypes.md` › Form; `placement.md` › In shadcn apps ("One filled
button per page state"); `labels.md` › Terminology.

Proposal:

- Put the rubric first under the title.
- Move templates into a "Start from a template…" `DropdownMenu` (*add*), or
  into the empty-rubric state. Templates are one-shot actions, not toggles.
- Rename step 1 "Edit".
- Name the scopes in cases and assessments: "New cases only" and "Existing
  assessments unchanged" (ADR-0015).
- When no evaluator field changed, name the save "Re-run the regression
  check" and say what it does: it creates the next version with the same
  definition and checks it against the current golden set (D4). "Changed" means
  against the base version, as the digest does; C13's fix keeps the editor
  from adding a change the owner did not make.

### C10. The evaluator page mixes tabs, metrics, and navigation

Sev 2 · CURRENT · *fix* · medium

- **The tab isn't kept.** The four tabs are buttons with `aria-pressed`, and
  their state lives in `useState` (`screens/skill.tsx:16-23,32,127-140`).
  Measured: the URL stays `/skill`, and a reload returns to the Review guide.
- **The rail mixes roles.** The tab rail is labelled "Skill"
  (`screens/skill.tsx:126`). It shares its column with a metric that is a
  button: "Known-failure agreement 86%" opens Version history
  (`screens/skill.tsx:144-153`).
- **The title appears twice.** The Review guide's own Markdown heading repeats
  the page title at the same 24 px, in a bolder sans. Round 1's S3 covers its
  `h1`.

Rule: `navigation.md` › "The URL holds the view"; `archetypes.md` › List
("The same holds for the active tab on a detail page"); `shadcn.md` ›
Headings and titles.

Proposal:

- Use `Tabs` (*add*; its Radix package is already installed), with the tab in
  `?tab=`.
- Label the rail "Evaluator".
- Show agreement as a stat with a separate "View history" link.
- Render Markdown headings from `h3` down, as S3 proposed.

### C11. Compare's pickers can trap a reversed pair

Sev 2 · CURRENT · *fix* · quick

Each picker disables the other picker's version
(`screens/compare-versions.tsx:409`). I opened
`/skill/compare?from=<v1.2.0>&to=<v1.1.0>` in the demo, which has two
versions. Each picker's only other option was disabled, so the page's advice,
"swap the pickers" (`screens/compare-versions.tsx:208`), cannot be followed.

Rule: `decisions.md` › Errors and recovery ("Prevent what you can foresee").

Proposal: order the pair older → newer automatically. Otherwise, add a Swap
button and list only older versions in From.

### C12. Naming and status words

Sev 3 · CURRENT · *fix* · large · decided in D6 · extends round 1's naming
proposal and O9

- **Seven labels lead to the editor:**
  - "Edit evaluator" (`screens/skill.tsx:98-100`);
  - "Open rubric alongside" (`screens/exceptions.tsx:331`);
  - "Draft rubric edit from these cases" (`screens/review.tsx:169`);
  - "Review the rubric" (`screens/traces.tsx:224`);
  - "Review the Check" (`screens/first-result.tsx:335`,
    `components/first-run-setup-ledger.tsx:54`);
  - "Review Check" (`components/rubrist/journey-pipeline.tsx:39`);
  - "Set up without a run" (`components/first-run-setup-ledger.tsx:40`).

  The editor is titled "Edit the evaluator", sits under the crumb "Skill"
  (S1), and has the Back link "Back to skill".
- **Scanner drift.** Over the seven evaluator-page files, the onboarding
  contract's words find drift toward:
  - "judge" 23×;
  - "Skill" 9×;
  - "trace" 7×;
  - "verdict" 5×;
  - "golden" or "Golden set" 4×.

  It found no generic labels, filler copy, or banned error words. Against
  ADR-0015's vocabulary, "judge", "Skill", and "verdict" are still drift;
  "golden set" is the chosen term, and "trace" is right where it names the
  imported source.
- **Status words come from legacy version status:**
  - "Approved 4/30/2026" on the evaluator page (`screens/skill.tsx:165`) and
    "Approved 4/30/2026, 8:00:00 PM" on the version page
    (`screens/skill-versions.tsx:385`);
  - the status chips "approved", "validated", and "draft · held"
    (`screens/skill-versions.tsx:32-42`).

Context:

- TARGET for first run: BOJ:61-62 names the **Check** and the **Review
  guide**, and BOJ:70-71 prefers Check before Evaluator in Guided display.
  BOJ:316-317 says "assurance copy derives from absent, supplied-label,
  governed-comparison, and calibrated evidence rather than legacy version
  status."
- TARGET for Batch 6-created lineages: a candidate is never "described as
  approved" (ADR-0010:187-188). Other lineages keep their compatibility
  behavior (ADR-0010:193-195).

ADR-0015 (Proposed) would replace the onboarding contract's beginner names
with the glossary's terms in every display mode. BOJ:316-317's rule on
assurance copy stays.

Proposal:

- Use one label for the way in: "Edit evaluator" for owners, the label the
  evaluator page already uses, and "View evaluator" for others. Match it in
  the title and the Back link. Round 2's T6 keeps "Open rubric alongside" for
  the queue banner, which opens the rubric beside the queue.
- Apply ADR-0015's vocabulary: evaluator, rubric, case, assessment, and golden
  set.
- Map the status words and the date line as D6 sets out.

### C13. Opening the editor swaps an unavailable provider without asking

Sev 3 · CURRENT · *fix* · medium

- **The swap.** When the stored provider is not available,
  `resolveJudgeProviderSelection` picks the first available provider, or the
  mock (`lib/judge-provider-selection.ts:16-21`). The editor then clears the
  model fields (`applyBindingFields`, `screens/skill-edit.tsx:163-179`), and
  the model catalog fills in its first model (`:470`). "Reset to v1.2.0" does
  the same (`:209-213`).
- **Rendered in the demo,** which has no provider keys. The stored
  `anthropic/claude-sonnet-4-6` became "Mock (local testing)", the only
  provider option. Before anything was typed, the change review read "1
  evaluator field changed", with "Execution binding · Changed ·
  claude-sonnet-4-6 → mock". The only notice sits by the provider field, below
  the fold (y≈1376): "Only the local mock is available. Add an Anthropic,
  OpenAI, OpenRouter, or custom provider key in Settings…". It does not say
  the stored binding was replaced.
- **What it risks.** In code, when another provider is available, an owner
  who edits only the rubric saves a version bound to a provider and
  model they never chose. When only the mock remains, Postgres mode refuses
  the save: "The mock judge is only available in local demo mode"
  (`apps/api/src/routes/skill-administration.ts:400-402`).

Context (TARGET, ADR-0014:222-226): every part of the binding is fixed when a
version is saved, and resolution "never changes it." The swap does not break
that, because it creates a new version, but it chooses the new version's
binding for the owner.

Rule: `decisions.md` › Defaults, derivation, deferral ("Never default a
consequential choice silently"); `decisions.md` › Errors and recovery
("Prevent what you can foresee").

Proposal:

- Keep the stored binding in the form, marked unavailable with the reason
  ("no Anthropic key"), and link to Settings beside it.
- Block saving until the owner adds the key or picks another provider and
  model. Never pick them on the owner's behalf.
- Apply the same rule to "Reset".

---

## Page blueprints

### Evaluator page (`/skill`)

Desktop:

```text
Project / Evaluator                                                   [+ Import trace]
Support Answer Quality  (h1)  [Current · v1.2.0]          View history  [ Edit evaluator ]
The criterion this evaluator assesses, in one line. Starter or evidence status.
[ Rubric | Prompt | Execution binding | Output contract ]                    (tabs, ?tab=)
┌ Rubric ──────────────────────────────────────────────┐ ┌ Evidence ─────────────────────┐
│ The rubric, with Markdown headings from h3 down      │ │ Golden cases: 2               │
│                                                      │ │ Golden-set agreement 86%      │
│                                                      │ │ 5 too strict · 2 too lenient  │
│                                                      │ │ View history ›                │
│                                                      │ │ Owner · Product Lead          │
└──────────────────────────────────────────────────────┘ └───────────────────────────────┘
Every save creates a new version. Passing the regression check is not a release decision.
```

Narrow: title, status, and the primary; then the tabs as a scrolling
`TabsList`; then the rubric; then the Evidence block.

| Zone | Contents | Why |
|---|---|---|
| Header | The evaluator's name, status chip (C1 states), history link, one primary for owners | S1, S3; C3 |
| Tabs | Rubric, prompt, execution binding, output contract; the tab is kept in the URL | C10; ADR-0015 |
| Main | The rubric first | C4, C10 |
| Evidence | Golden cases, golden-set agreement, and ownership, as stats with links | C10; ADR-0015 |

### Editor (`/skill/edit`)

Desktop, edit state:

```text
Project / Evaluator / Edit                                            [+ Import trace]
Edit evaluator  (h1)   from v1.2.0                   Start from a template… ▾   Reset…
┌ Rubric ──────────────────────────────────────────────────────────────────────────────┐
│ [ Edit | Preview ]                                                                   │
│ # Support Answer Quality …                                                           │
└──────────────────────────────────────────────────────────────────────────────────────┘
▸ Prompt       ▸ Execution binding       ▸ Output contract       ▸ Apply to: new cases
Before saving: the regression check re-runs 2 golden cases; a regression needs review.
Review changes: rubric changed (12 → 14 lines) ▸ exact comparison
Cancel                                                     [ Create version ] (filled)
```

The step strip appears once the save starts.

| State | Heading | Primary | Secondary | Notes |
|---|---|---|---|---|
| Editing, unchanged | Edit evaluator | Re-run the regression check (creates the next version) | Cancel | C9, D4 |
| Stored provider unavailable | Edit evaluator, with the binding marked unavailable | Create version (disabled until a provider is chosen) | Open Settings | C13 |
| Editing, changed | Edit evaluator | Create version | Cancel (asks before discarding) | C2 |
| Member | View evaluator (read-only) | — | "Ask Product Lead" | C3 |
| Running | Regression check running on 2 golden cases · started 1 min ago | View history | — | C6 |
| Passed | v1.3.0 is current | View evaluator | Compare with v1.2.0 | C8 |
| Blocked | 1 golden case would regress | Revise the edit | Record an override… (owners) | C8, C4 |
| Regression check incomplete | v1.3.0 was saved; its regression check did not finish | Back to edit, or Open Settings when the provider is unavailable | View history | C8, D3 |

### Version page (`/skill/versions/:id`)

```text
Project / Evaluator / Versions / v1.2.0                                       [+ Import trace]
Version 1.2.0 (h1)                                 Compare with current  [ Start from v1.2.0 ]
[Current] [No recorded regression check] · anthropic/claude-sonnet-4-6 · 2 known limitations
┌ What changed from v1.1.0 ──────────────────────────────────────────────────────────────────┐
│ No evaluator field changed: same rubric, prompt, execution binding, and output contract    │
└────────────────────────────────────────────────────────────────────────────────────────────┘
┌ Rubric ──────────────────────────────────────┐ ┌ Regression check ─────────────────────────┐
│ …                                            │ │ No recorded regression check              │
└──────────────────────────────────────────────┘ └───────────────────────────────────────────┘
Evidence: Judge Card, κ, self-consistency, execution binding, output contract
```

| Zone | Contents | Why |
|---|---|---|
| Header | The version as the title, one status chip, compare link, owner primary | C5, C1 |
| Change | What changed from the previous version | C5 |
| Main | The rubric, then the regression check, with "No recorded regression check" when there is none | C1, C5 |
| Evidence | Judge Card, κ, self-consistency, execution binding, output contract; open in both display modes, explained in Beginner mode | C5, D1 |

| Zone | Empty | Loading | Error |
|---|---|---|---|
| Version page | — | `Skeleton` (*add*) in the page's shape | `EmptyShell` (*Rubrist*): "Couldn't load this version" with Retry; "Version not found" only on a 404 |
| Version page sections (Judge Card, convergence, self-consistency) | Each section's own empty copy; self-consistency keeps its API instruction and says what it measures (C5) | `Skeleton` in the section | "Couldn't load the Judge Card" in the section, with Retry; the page keeps working |
| Compare | "Save a second version to compare." | `Skeleton` rows (*add*); tiles show "—"; never the empty state | `EmptyShell` with Retry; a failed run read says so in its row |
| Running regression check | — | "Started N min ago"; past a set time, "taking longer than usual" | Poll errors keep the last state and say when it was last checked |

## Decisions

Decided 2026-09-26: the founder asked to take the recommended options. Later
the same day, the founder chose one vocabulary and two display modes
([ADR-0015](../decisions/0015-one-vocabulary-and-two-display-modes.md),
Proposed), so D1 and D6 follow that ADR instead of the earlier Guided and
Technical split. These are design decisions for implementing this audit, not
product authority. `PRODUCT.md`, the accepted ADRs, and the onboarding
contract are unchanged.

1. **Content of the version page (C5).** Both display modes show the same
   page: the header, what changed, the rubric, and the regression check, with
   "No recorded regression check" when there is none. The Judge Card, κ,
   self-consistency, execution binding, and output contract follow in an
   "Evidence" section, open in both modes. Beginner mode adds a one-line
   explanation to each.
2. **Override prominence (C8).** Revising is the default. "Revise the edit"
   is the filled button, and the override moves into a "Record an override…"
   disclosure for owners, which keeps its reason field. An override records an
   exception to the gate (ARCH:214-216), so it should not be the easiest path.
3. **Retrying an incomplete regression check (C8).** There is no re-run for an
   existing version. The check already retries provider failures up to five
   times with backoff (`apps/api/src/routes/skill-administration.ts:437-444`,
   `apps/api/src/workers/gate.ts:8-35`), and each version keeps one terminal
   check record. After an incomplete check, the primary is "Back to edit",
   where saving the unchanged form re-runs the regression check as the next
   version (D4). When the version's provider is unavailable, the primary is
   "Open Settings", because retrying cannot work.
4. **Identical saves (C9).** Allow them, and name them for what they do. When
   no evaluator field changed, the save button reads "Re-run the regression
   check", and the change review says: "No evaluator field changed. Saving
   creates v1.3.0 with the same definition and checks it against the current
   golden set." A save pins the current golden-set revision
   (`components/skill-edit-flow.tsx:179-180`), and that set can change after a
   version's check (`apps/api/src/lib/judge-card.ts:75`). An unchanged
   definition can therefore be re-checked only as a new version.
5. **A base version for the editor (C5).** Add `/skill/edit?from=<versionId>`
   for owners. It reuses the editor's `editFromVersion`
   (`screens/skill-edit.tsx:215-224`), which today only "Back to edit" calls
   (`:736`). The change review still compares with the current version and
   names the starting point ("Started from v1.1.0"). `?version=` stays
   reserved for resuming a queued version (`screens/skill-edit.tsx:73,280-314`).
6. **Status vocabulary (C12).** Each status gets one label in both display
   modes, and its raw value stays available in a tooltip. BOJ:316-317's rule
   still applies: assurance copy derives from evidence, not legacy version
   status.

   | Status and its CURRENT meaning | Label |
   |---|---|
   | `production`: the current version | Current |
   | `approved` after a passing check | Regression check passed |
   | `approved` after an override | Override recorded |
   | `approved` with no golden cases to compare (`apps/api/src/repository.pg/skill-lifecycle-repository.ts:714-725`) | No golden cases to check |
   | `approved` by a starter sign-off, recorded as `skill_version.signoff` (`:253-275`) | Signed off |
   | `approved` with no recorded check, such as a version saved before the gate | No recorded regression check |
   | `validated`: no code path sets it | Legacy status (validated) |
   | `calibrating` | Regression check running |
   | `regressing` | Blocked by a regression |
   | `failed` | Regression check incomplete |
   | `needs_review` | Needs review |
   | `draft` | Draft |
   | `deprecated` | Superseded |

   "Incomplete" follows the glossary: missing or failed evidence is not a
   failed candidate (`docs/glossary.md:77-78`). The "Approved <date>" line
   becomes the basis and its date, for example "Regression check passed Apr
   30, 2026 · 2 golden cases" or "Saved Mar 15, 2026 · no recorded regression
   check". No label reads "approved", in line with BOJ:272.

## Next rounds

1. First run, end to end (`/skill/edit?first=1` → `/first-result`).
2. Traces list and import.
3. Analyze and Human truth, which need Postgres 17.
4. Settings.
