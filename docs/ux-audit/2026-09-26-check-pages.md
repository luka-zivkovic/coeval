# UX audit 3: the Check pages (Review guide, editor, versions, compare)

Status: **audit record, not product authority.** It records CURRENT
observations and proposals for founder review. Items marked *decide* need a
decision before implementation. No item proposes an ADR.

Last reviewed: 2026-09-26 · code at `2c82321`

This round covers the pages behind the Review guide nav item:

- the Check page at `/skill`;
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
pages hold 14 of the app's 58 `onClick={() => navigate(…)}` handlers on
buttons. Three clickable rows also navigate, but they keep a real link
inside.

## How to read this

Evidence labels, severity scale, and statuses follow
[round 1](2026-09-26-shell-and-overview.md#how-to-read-this). Each finding
also carries an effort estimate:

- quick: one file, under an hour;
- medium: a few files;
- large: a shared component or several screens.

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
  - the version-creation route in
    `apps/api/src/routes/skill-administration.ts`.

  Paths are relative to `apps/web/src` unless they start with `apps/`.
- **TARGET intent.** Read in `PRODUCT.md`, `docs/beginner-onboarding-journey.md`
  (BOJ), `docs/glossary.md`, and ADR-0010 and ADR-0014 (both Accepted). No
  ADR is Proposed.
- **Rendering.** Demo stack at 1440×900 and 390×844 in Guided display, plus
  Technical display for the version page. The demo Check is "Support Answer
  Quality" at v1.2.0 (current) with one earlier version, v1.1.0. The owner is
  the viewer, and the Golden set holds 2 cases.
- **Synthetic states.** These came from `page.route` rewrites; no demo data
  was changed:
  - the viewer as a member, and a Starter · unvalidated Check;
  - a 5 s delay for the loading states, and a 500 for the error states;
  - the regression check's four outcomes. The save request returns a
    blocked (409), passed, or failed (201) result, or a queued version (202)
    whose regression record never arrives.
- **Measurements** follow `review.md` §3, including the new split between
  clipped controls and controls behind a scroll.
- **Vocabulary.** I ran `scan_labels.py` over the seven Check-page files,
  using a throwaway `UX.md` built from the contract's glossary, as in round 2.

## Top findings, in fix order

| # | Finding | Sev | Effort | Status |
|---|---|---|---|---|
| 1 | Missing regression evidence reads as clean. Versions with no recorded check wear "regression · clean", and the comparison reports 0 regressions from zero recorded runs. (C1) | 4 | quick | fix |
| 2 | Members can open an editor they cannot save. Three entry points skip the owner check, and the API refuses the save with a 403. (C3) | 3 | quick | fix |
| 3 | The editor discards unsaved work. A template click, "Reset", Cancel, Back, and Version history all drop typed text without asking. (C2) | 3 | medium | fix |
| 4 | On phones, the override button runs off the screen, and the version tables hide their evidence columns behind a sideways scroll. (C4) | 3 | quick | fix |
| 5 | The version page is titled with the model name, leads with technical evidence, says "current" twice, and offers no next step. (C5) | 3 | medium | fix, *decide* Guided content |
| 6 | The editor is reached through five different labels, and status words come from legacy version status. (C12) | 3 | medium | *decide* |
| 7 | Load failures read as "Version not found" or "Nothing to compare yet", and error states tell users to start the API. (C7) | 2 | medium | fix |
| 8 | Waits never end. The running check polls forever with no elapsed time, and a count can say "Loading…" indefinitely. (C6) | 2 | quick | fix |
| 9 | The check's outcomes point away from the fix. A blocked result makes the override the filled button, and a failed check offers no Retry. (C8) | 2 | quick | *decide* |
| 10 | The editor buries the Review guide below four blocks. A chosen template looks like a primary, and save is enabled with nothing changed. (C9) | 2 | medium | fix, *decide* identical saves |
| 11 | The Check page's tabs are not in the URL. A metric doubles as a navigation button, and the guide's own heading repeats the title in bold. (C10) | 2 | quick | fix |
| 12 | Compare's pickers can trap a reversed pair that the page then asks you to swap. (C11) | 2 | quick | fix |

---

## What holds up (*keep*)

- **Saving never overwrites.** Every save creates an immutable version, and the
  editor says so before the save. Its change review compares the new text with
  the base version line by line (`components/skill-edit-flow.tsx:152-227`).
  This matches TARGET ADR-0014 ("Evaluator versions are immutable").
- **The save has visible stages.** A four-step strip (review, create, check,
  outcome) announces each step through a live region and stays pinned on
  wider screens (`components/skill-edit-flow.tsx:69-111`).
- **A reload resumes the exact version.** The queued version's id stays in
  `?version=`, so a reload during the check returns to it
  (`screens/skill-edit.tsx:280-313,355-361`).
- **Compare keeps its pair in the URL** (`?from=` and `?to=`,
  `screens/compare-versions.tsx:44-45,134-141`). It computes only from recorded
  runs and says so in its subtitle.
- **The honesty copy is present.**
  - "Passing is not an overall quality or release decision"
    (`screens/skill.tsx:186-192`).
  - "Runnable is not the same as accurate" on a starter Check (`:106-110`).
  - "A failed or partial check cannot count as a pass"
    (`screens/skill-edit/regression.tsx:326-329`).

  These match TARGET PRODUCT.md:201 and BOJ:279. C1 is where the page
  contradicts its own copy.
- **Model pins stay honest.**
  - A pinned model that dropped out of the catalog stays selected with a
    warning (`screens/skill-edit/editor.tsx:351-366`).
  - A movable alias gets a warning about activation
    (`screens/skill-edit/editor.tsx:389-394`).
- **Version rows are real links.** Each row keeps a `RowLink` on its version
  number (`screens/skill-versions.tsx:182-191`).
- **The editor's primary sits at the end of the form**, with Cancel apart on
  the left (`archetypes.md` › Form).

---

## Findings

### C1. Missing regression evidence reads as clean

Sev 4 · CURRENT vs TARGET · *fix* · quick

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
  - On phones, the "On the record" column that explains the gap sits behind
    the sideways scroll (C4).

TARGET:

- PRODUCT.md:201: "Missing or failed evaluation is never converted into a
  favorable result."
- ADR-0010:265-266: "still-running, censored, incomplete, and later-revoked
  states remain explicit rather than becoming zero or success."

Rule: `states.md` › Rules ("A value that has not loaded is not zero");
`review.md` › Mislabelled data.

Proposal:

- Add a "no recorded check" gate state, neutral rather than the pass variant,
  for every version without a regression run.
- In compare, show "—" with "no recorded run" for any total that includes an
  unrecorded hop, never a bare 0.

Any version with no persisted run shows this. That includes versions created
before the gate, which the Judge Card's basis names as one case.

### C2. The editor discards unsaved work

Sev 3 · CURRENT · *fix* · medium

Nothing guards the form. The trace-test builder already does: it calls
`useBlocker(dirty)` (`screens/trace-test-builder.tsx:148`) and asks "Leave with
unsaved changes?" (`screens/trace-test-builder/components.tsx:789`).

- **Leaving loses the text.** I typed into the Review guide and clicked
  "Version history". The page left without asking. After Back, the editor
  showed the saved guide and the typed text was gone.
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

- Block leaving while the form differs from its base, as the trace-test builder
  does. Ask in an `AlertDialog` (*add*), not another hand-built dialog.
- Make template and reset undoable: apply at once and offer Undo in a toast
  (`Sonner`, *add*). Alternatively, confirm in an `AlertDialog` only when the
  form has unsaved changes.

### C3. Members can open an editor they cannot save

Sev 3 · CURRENT · *fix* · quick

- **The API refuses non-owners.** In Postgres mode it rejects a new version
  from anyone but an owner, returning 403 "Only owners can edit skills"
  (`apps/api/src/routes/skill-administration.ts:386-391`).
- **Only the Check page hides the way in.** It hides "Edit evaluator" from
  non-owners (`screens/skill.tsx:97-101`). Three other entry points open the
  editor for anyone:
  - "Open rubric alongside" on the provisional queue
    (`screens/exceptions.tsx:330-332`);
  - "Draft rubric edit from these cases" in the review done view
    (`screens/review.tsx:168-170`, navigating at `:100`);
  - "Review the rubric" on the provisional Traces page
    (`screens/traces.tsx:223-225`).
- **The editor checks the role only in first-run setup**
  (`screens/skill-edit.tsx:781`). Rendered with the viewer as a member, the
  ordinary editor shows every field and an enabled "Create version & check
  references", and never mentions owners.

A member can write a whole Review guide and learn only at save that they
cannot keep it.

Rule: `decisions.md` › Errors and recovery ("Prevent what you can foresee";
"Offer an action the viewer can take").

Proposal:

- For non-owners, show the entry points as "View the Review guide", linking to
  `/skill`.
- If a member reaches `/skill/edit` directly, render the guide read-only with
  "Only an owner can save a new version. Ask Product Lead." The owner's name
  is already on the Check page (`screens/skill.tsx:161`).

### C4. On phones, the override runs off the screen

Sev 3 · CURRENT · *fix* · quick

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
- **Check page.** The tab rail, Regression, and Ownership blocks stack above
  the Review guide, which starts at y=789 (`screens/skill.tsx:124-184`).

Rule:

- `shadcn.md` › Responsive rules (a row that holds actions wraps);
- `review.md` › "Behind a scroll";
- `layouts.md` › Table page (cards or a stacked list on narrow screens).

Proposal:

- Let the override row wrap (`flex-wrap`), and shorten the button to "Override
  with reason".
- Below `md`, render version rows and compare steps as stacked items that keep
  status and the gate state visible.
- On the Check page below `lg`, put the Review guide first and the metadata
  after it.

### C5. The version page names the model, leads with evidence, and offers no next step

Sev 3 · CURRENT vs TARGET · *fix* · medium · Guided content *decide*

- **The title is the model id,** "anthropic/claude-sonnet-4-6"
  (`screens/skill-versions.tsx:380-382`). The version number appears only in
  the eyebrow ("Judge card · v1.2.0") and a mono line (`:371-377`). Two versions
  on the same model share a title. This extends S1 and S3.
- **"Current" appears twice.** The status chip maps `production` to "current"
  (`screens/skill-versions.tsx:388`, with the label at `:33`), and a second
  chip is added when the version is current (`:391`). Rendered: "CURRENT ·
  regression · clean · CURRENT".
- **Technical evidence comes first.** The page opens with the attested Judge
  Card (`screens/skill-versions.tsx:396`): execution binding, rubric
  provenance, κ with reviewer ids, and self-consistency. The Review guide, which
  the Check page's own copy calls "the main content reviewers should read and
  edit" (`screens/skill.tsx:202-203`), comes after it
  (`screens/skill-versions.tsx:398-408`).
- **Facts repeat.**
  - The execution binding appears four times: the mono line (`:371-377`), the
    title (`:382`), a Judge Card row (`:639-640`), and the binding card
    (`:446-478`).
  - Known-failure agreement appears twice in two formats: "recorded ratio 0.86"
    (`:643-648`) and "86%" (`:432-435`).
- **Guided and Technical display render the same page** (2,612 px tall at
  1440 in both). In either display, the self-consistency empty state tells
  users to call `POST /api/v1/judge` with `force: true` (`:700-705`).
- **No next step.** The page offers no "Compare with current" and no "Start a
  new version from this one". Its only actions are Back and three exports.

TARGET:

- BOJ:68: technical details are "Available for inspection without blocking
  the default journey."
- BOJ:70-71: "In Guided display, prefer **Check** before introducing
  **Evaluator**."

Rule: `archetypes.md` › Detail (the primary action is the object's most
common next step); `review.md` › Repeated facts; `labels.md` › Page titles.

Proposal:

- Title the page "Version 1.2.0", with one status chip.
- Lead with the Review guide and what changed from the previous version.
- Move the Judge Card, κ, and self-consistency into a "Technical evidence"
  section. It is open by default in Technical display and collapsed in Guided
  (*decide* the Guided content).
- Add "Compare with current" as a link to `/skill/compare?from=…&to=…`.
- For owners, add "Start a new version from v1.2.0". The editor has no
  parameter for a base version yet (*decide*).
- Replace the API instruction with "No case has been judged twice under this
  version yet."

### C6. Waits never end

Sev 2 · CURRENT · *fix* · quick

- **The running check polls forever.** It polls every 2 s with no limit
  (`screens/skill-edit.tsx:393-431`, repeating at `:423`). With the regression
  record withheld, it polled 7 times in about 10 s. It never showed elapsed
  time or an end.
- **A count can load forever.** "Cases in revision" reads "Loading exact
  count…" whenever the count is unknown
  (`screens/skill-edit/regression.tsx:165`). The count stays unknown when the
  version has no pinned revision, or when the metadata read fails
  (`screens/skill-edit.tsx:371-391`). Rendered: still "Loading exact count…"
  after 10 s.
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

### C7. Failures read as "not found" or "nothing to compare"

Sev 2 · CURRENT · *fix* · medium

- **Version page.** Any load failure is titled "Version not found"
  (`screens/skill-versions.tsx:344-360`). Rendered with the versions request
  returning 500: "Version not found".
- **Compare.** The page has no loading state. While versions load, the list is
  empty, so it renders "Nothing to compare yet" with "All versions"
  (`screens/compare-versions.tsx:151-164`). Rendered 1.5 s into a 5 s load.
- **Error states.**
  - The Check page, the editor, and version history print the raw error, or
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
`states.md` › Rules ("Offer Retry only when retrying can work");
`review.md` › Hardcoded diagnostics.

Proposal: one page-state pattern for all five routes:

- `EmptyShell` (*Rubrist*) with "Couldn't load … " and Retry;
- `Skeleton` (*add*) in the page's shape while loading;
- "Version not found" only on a 404.

### C8. The check's outcomes point away from the fix

Sev 2 · CURRENT · *decide* · quick

- **Blocked.**
  - The only filled button is "Create a new version with override", in the
    `signal` variant (`screens/skill-edit/regression.tsx:446-452`). It stays
    disabled until the reason has 8 characters.
  - "Back to edit" is a ghost button (`:442-444`).
  - At 1440 the override sits at y≈1301, below the fold.
- **Check failed.** The card says to "retry from the editor"
  (`screens/skill-edit/regression.tsx:328`), but there is no Retry. The filled
  button is "View skill versions" (`:461-463`), and "Back to edit" is a ghost
  button (`:458-460`).
- **Passed and failed** both end on "View skill versions"
  (`screens/skill-edit.tsx:749,761`), not on the Check the user just changed.

Context:

- CURRENT (ARCH:214-216): a regressing version cannot replace the approved one
  "unless an owner records an explicit override reason."
- TARGET for Batch 6 lineages (ADR-0010:214-216): "blocked, overridden, or
  error results cannot activate."

Rule: `placement.md` (one filled button per state, on the recommended path);
`decisions.md` › Errors and recovery ("Offer Retry only when retrying can
work").

Proposal (*decide*):

- **Blocked:** the primary is "Revise the edit". The override moves into a
  secondary "Record an override…" disclosure, which keeps its reason field.
- **Check failed:** if the API can re-run one version's check, the primary is
  "Retry the check". Otherwise it is "Back to edit", noting that saving again
  creates the next version.
- **Passed:** the primary is "View the Check" (`/skill`).

### C9. The editor buries the Review guide and blurs its controls

Sev 2 · CURRENT · *fix* · medium · identical saves *decide*

- **The guide starts low.** The editable Review guide starts at y≈739 in a
  900 px window. Four blocks come first: the subtitle, the step strip, the
  regression banner, and the template row
  (`screens/skill-edit/editor.tsx:105-178`).
- **A chosen template looks like a primary.** A selected template chip uses the
  primary's ink fill (`screens/skill-edit/editor.tsx:165-167`). After applying
  one, the page measured two filled buttons.
- **Step 1 is misnamed.** The progress strip's first step reads "Review changes"
  while the user is editing (`components/skill-edit-flow.tsx:52`).
- **"Apply to" uses the wrong words.** It names its scopes in traces and
  verdicts: "New traces only", "Existing verdicts untouched"
  (`screens/skill-edit/editor.tsx:24-28`).
- **Save works with nothing changed.**
  - The save condition has no change check (`screens/skill-edit.tsx:552-563`),
    so save stays enabled.
  - The change review then reads "0 evaluator fields changed"
    (`components/skill-edit-flow.tsx:183-185`).
  - Saving creates an identical version. ADR-0014:236-237 notes that identical
    definitions and bindings share a digest.

Rule: `archetypes.md` › Form; `placement.md` (one filled button per state);
`labels.md` › Terminology.

Proposal:

- Put the Review guide first under the title.
- Move templates into a "Start from a template…" `DropdownMenu` (*add*), or
  into the empty-guide state. Templates are one-shot actions, not toggles.
- Rename step 1 "Edit".
- Use Runs and Results in Guided display.
- Disable save until something changes, or name the identical save "Re-run the
  check" if that use is intended (*decide*).

### C10. The Check page mixes tabs, metrics, and navigation

Sev 2 · CURRENT · *fix* · quick

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
- Label the rail "Check".
- Show agreement as a stat with a separate "View history" link.
- Render Markdown headings from `h3` down.

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

Sev 3 · CURRENT vs TARGET · *decide* · medium · extends round 1's naming
proposal and O9

- **Five labels lead to the editor:**
  - "Edit evaluator" (`screens/skill.tsx:98-100`);
  - "Open rubric alongside" (`screens/exceptions.tsx:331`);
  - "Draft rubric edit from these cases" (`screens/review.tsx:169`);
  - "Review the rubric" (`screens/traces.tsx:224`);
  - "Review the Check" (`screens/first-result.tsx:335`).

  The editor is titled "Edit the evaluator", sits under the crumb "Skill"
  (S1), and has the Back link "Back to skill".
- **Scanner drift.** Over the seven Check-page files, the contract's glossary
  finds drift toward:
  - "judge" 23×;
  - "Skill" 9×;
  - "trace" 7×;
  - "verdict" 5×;
  - "golden" or "Golden set" 4×.

  It found no generic labels, filler copy, or banned error words.
- **Status words come from legacy version status:**
  - "Approved 4/30/2026" on the Check page (`screens/skill.tsx:165`) and the
    version page (`screens/skill-versions.tsx:385`);
  - the status chips "approved", "validated", and "draft · held"
    (`screens/skill-versions.tsx:32-42`).

TARGET:

- BOJ:61-62: **Check** and **Review guide** are the names.
- BOJ:70-71: in Guided display, prefer Check before Evaluator.
- BOJ:316-317: "assurance copy derives from absent, supplied-label,
  governed-comparison, and calibrated evidence rather than legacy version
  status."
- ADR-0010:187-188: a candidate is never "described as approved". This covers
  Batch 6-created lineages; others keep their compatibility behavior
  (ADR-0010:193-195).

ASSUMPTION: BOJ:316-317 sits in the onboarding contract. Whether it governs
the Check pages is part of the decision.

Proposal:

- Use one label for the way in: "Edit the Review guide" for owners and "View
  the Review guide" for others. Match it in the title and the Back link.
- Apply round 1's Guided names (Check, Run, Result, Protected examples).
- *Decide* the status vocabulary: what "approved" and "validated" become, and
  whether the date line stays.

---

## Page blueprints

### Check page (`/skill`)

Desktop:

```text
Project / Review guide                                                [+ Import trace]
Support Answer Quality  (h1)  [Current · v1.2.0]   View history  [ Edit the Review guide ]
What this Check judges, in one line. Starter or evidence status in one line.
[ Review guide | Judge instructions | Execution binding | Result format ]   (tabs, ?tab=)
┌ Review guide ────────────────────────────────────────┐ ┌ Evidence ─────────────────────┐
│ The guide, with Markdown headings from h3 down       │ │ Protected examples: 2         │
│                                                      │ │ Agreement 86% · 5 strict · 2  │
│                                                      │ │ lenient     View history ›    │
│                                                      │ │ Owner · Product Lead          │
└──────────────────────────────────────────────────────┘ └───────────────────────────────┘
Every save creates a new version. Passing is not a quality or release decision.
```

Narrow: title, status, and the primary; then the tabs as a scrolling
`TabsList`; then the guide; then the Evidence block.

| Zone | Contents | Why |
|---|---|---|
| Header | The Check's name, status chip (C1 states), history link, one primary for owners | S1, S3; C3 |
| Tabs | Review guide, judge instructions, binding, result format; the tab is kept in the URL | C10 |
| Main | The Review guide first | C4, C10 |
| Evidence | Protected examples, agreement, and ownership, as stats with links | C10; C12 names |

### Editor (`/skill/edit`)

Desktop, edit state:

```text
Project / Review guide / Edit                                         [+ Import trace]
Edit the Review guide  (h1)   from v1.2.0            Start from a template… ▾   Reset…
┌ Review guide ────────────────────────────────────────────────────────────────────────┐
│ [ Edit | Preview ]                                                                   │
│ # Support Answer Quality …                                                           │
└──────────────────────────────────────────────────────────────────────────────────────┘
▸ Judge instructions (advanced)         ▸ Execution binding         ▸ Apply to: new Runs
Before saving: 2 Protected examples are re-checked; a regression needs review.
Review changes: Review guide changed (12 → 14 lines) ▸ exact comparison
Cancel                                                       [ Create version ] (filled)
```

The step strip appears once the save starts.

| State | Heading | Primary | Secondary | Notes |
|---|---|---|---|---|
| Editing, unchanged | Edit the Review guide | Create version (disabled) | Cancel | C9 |
| Editing, changed | Edit the Review guide | Create version | Cancel (asks before discarding) | C2 |
| Member | The Review guide (read-only) | — | "Ask Product Lead" | C3 |
| Running | Checking 2 Protected examples · started 1 min ago | View history | — | C6 |
| Passed | v1.3.0 is current | View the Check | Compare with v1.2.0 | C8 |
| Blocked | 1 Protected example would regress | Revise the edit | Record an override… (owners) | C8, C4 |
| Check failed | v1.3.0 was saved; its check did not finish | Retry the check, or Back to edit | View history | C8, *decide* |

### Version page (`/skill/versions/:id`)

```text
Project / Review guide / Versions / v1.2.0                                    [+ Import trace]
Version 1.2.0 (h1) [Current] [no recorded check]    Compare with current [ Start from v1.2.0 ]
Saved Apr 30, 2026 · anthropic/claude-sonnet-4-6 · 2 known limitations
┌ What changed from v1.1.0 ──────────────────────────────────────────────────────────────────┐
│ Review guide changed · model unchanged                                                     │
└────────────────────────────────────────────────────────────────────────────────────────────┘
┌ Review guide ────────────────────────────────┐ ┌ Known-failure check ──────────────────────┐
│ …                                            │ │ No recorded run for this version          │
└──────────────────────────────────────────────┘ └───────────────────────────────────────────┘
▸ Technical evidence: Judge Card, κ, self-consistency, binding, schema (open in Technical)
```

| Zone | Contents | Why |
|---|---|---|
| Header | The version as the title, one status chip, compare link, owner primary | C5, C1 |
| Change | What changed from the previous version | C5 |
| Main | The Review guide, then the known-failure check with an explicit "no recorded run" | C1, C5 |
| Technical | Judge Card, κ, self-consistency, binding, schema; collapsed in Guided | C5; BOJ:68 |

| Zone | Empty | Loading | Error |
|---|---|---|---|
| Version page | — | `Skeleton` (*add*) in the page's shape | `EmptyShell` (*Rubrist*): "Couldn't load this version" with Retry; "Version not found" only on a 404 |
| Compare | "Save a second version to compare." | `Skeleton` rows (*add*); never the empty state | `EmptyShell` with Retry |
| Running check | — | "Started N min ago"; past a set time, "taking longer than usual" | Poll errors keep the last state and say when it was last checked |

## Open questions

1. **Guided content of the version page (C5).** What should Guided display
   show, and what goes under Technical evidence?
2. **Override prominence (C8).** Should revising be the default path, with the
   override behind a disclosure?
3. **Retrying a failed check (C8).** Can the API re-run the check for an
   existing version, or does retrying always mean a new version?
4. **Identical saves (C9).** Block them, or name them "Re-run the check"?
5. **A base version for the editor (C5).** Should "Start from v1.2.0" exist,
   and through which parameter?
6. **Status vocabulary (C12).** What should "approved" and "validated" say,
   and does BOJ:316-317 govern these pages?

## Next rounds

1. First run, end to end (`/skill/edit?first=1` → `/first-result`).
2. Traces list and import.
3. Analyze and Human truth, which need Postgres 17.
4. Settings.
