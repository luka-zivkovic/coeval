# UX audit 1: app shell and Overview

Status: **audit record, not product authority.** It records CURRENT
observations and proposals for founder review. Its open questions were
settled on 2026-09-26 by taking the recommended options; see
[Decisions](#decisions). No item proposes an ADR.

Last reviewed: 2026-09-26 · code at `2c82321`

This is round 1 of a page-by-page UX audit of the web app (`apps/web`). It
covers:

- the shell every signed-in page shares: sidebar, topbar, content frame, and
  shell-level loading and error states;
- the Overview route (`/`) in its three journey states (day 0, provisional,
  production), including their tracing and bench variants.

Later rounds add files to this folder; see [Next rounds](#next-rounds).

## How to read this

- **Evidence labels** follow `AGENTS.md`:
  - `TARGET` comes from `PRODUCT.md`, accepted ADRs, and
    `docs/beginner-onboarding-journey.md`. That file labels its own journey and
    language TARGET and is subordinate to the charter.
  - `CURRENT` is code at `2c82321` and the rendered UI.
  - `ASSUMPTION` is auditor inference. Test it before relying on it.
- **Severity** follows NN/g's scale:
  - **4** misstates evidence or blocks the job;
  - **3** is major: a likely wrong turn, a lost location, or a hidden primary
    action;
  - **2** is minor: it repeats, slows, or muddles;
  - **1** is cosmetic.
- **Rules** cite the `ux-craft` skill references from
  [overclock#37](https://github.com/luka-zivkovic/overclock/pull/37) at
  `e08b2e0`, written as `file › section`:
  - `archetypes.md`, `layouts.md`, `placement.md`, and `states.md` are in
    `page-structure`;
  - `navigation.md` and `decisions.md` are in `user-flow`;
  - `labels.md`, `errors.md`, and `casing.md` are in `ui-naming`.

  Each file lists its primary sources (NN/g, GOV.UK, Apple HIG, Material 3,
  WCAG).
- **Status** is one of *fix* (no product decision needed), *decide* (needs a
  founder decision), or *keep*. Every *decide* item is now settled, and each
  names its decision, for example "decided in D2".

## Method

- I read the shell, the Overview and its components, and the routes in
  `App.tsx`. A read-only sweep then inventoried every routed screen's header,
  primary actions, container width, and states.
- I ran the API in demo mode (in-memory fixtures, no auth) with the Vite web
  app. Captures were at 1440×900 and 390×844, in Guided, Technical, and
  Summary displays.
- The demo fixture has no day-0, provisional, bench, or populated-exception
  data. I rendered those states by rewriting the demo `/api/dashboard`
  response in the browser:
  - day 0 (tracing and bench);
  - provisional (owner and member);
  - production with 7 exceptions and 3 categories (tracing and bench).

  Values are synthetic. Only the fields that select a journey stage changed.
  I rendered 401, 500, and slow responses by intercepting the same request.
- Postgres-backed mode was not exercised: the local server was PostgreSQL 16,
  and the migrations need 17.
- Skills applied:
  - `page-structure`: blueprint, archetypes, layouts, placement, and states;
  - `user-flow`: navigation rules;
  - `ui-naming`: label rules and its read-only `scan_labels.py`.

  Per `ui-naming` step 0, a project's own content guide outranks the skill's
  generic defaults. Terminology is therefore judged against Rubrist's
  product-language contract.
- **Scanner caveat:** `scan_labels.py` extracted 1,267 strings from
  `apps/web/src`, but it misses three kinds of text:
  - elements whose props contain an inline arrow function, which includes
    `<Button onClick={() => …}>Submit</Button>`, so its generic-label check
    misses those buttons too;
  - elements with icon children;
  - object-literal labels.

  It found none of the 14 sidebar labels and none of the Overview's buttons,
  so the scanner counts below are a lower bound.

## Top findings, in fix order

| # | Finding | Sev | Status |
|---|---|---|---|
| 1 | At phone width the Overview's primary actions break. The next-action button is clipped. The day-0 first step collapses to one word per line under an overlapping button. The provisional banner makes the page 43 px wider than the screen. (O10) | 3 | fix |
| 2 | The topbar shows numbers that are not what they say. An all-time count is labelled "this week". "0 traces · 0 exceptions" shows while data loads and after a 401. (S4) | 3 | fix |
| 3 | Location cues are unreliable. Nav label, breadcrumb, and page title disagree on most routes. No route sets its own document title. Most page titles are not headings. (S1–S3) | 3 | fix |
| 4 | One journey is told three ways, with different names and numbers: sidebar acts, Overview pipeline, and setup ledger. (O2) | 3 | fix (D1) |
| 5 | Guided surfaces name the evaluator four ways and the human queue five ways on the production Overview (six counting provisional), against the product-language contract. (O4, O8) | 3 | fix (D2, D11) |
| 6 | The production Overview has no dominant element. The only filled button and the attention list are in the last card, below the fold. (O3) | 3 | fix |
| 7 | Shell error states mislead. A 401 leaves the page loading with no way back to sign-in. A 500 reads as a lost internet connection. (S6) | 2 | fix |
| 8 | Guided display shows the model binding, and bench projects are labelled "production". (O7, O9) | 2 | fix |

---

## Part 1: App shell

### Job and structure

Job line: on every signed-in page, the quality owner **knows which project,
Check, and page they are on and can reach any stage of the evaluator
lifecycle in one move**, so that **they never act on the wrong evidence**.

`page-structure` has no archetype for a shell. I assessed it with:

- `layouts.md` › Sidebar + content;
- `navigation.md`;
- `placement.md` › Header zone contents.

CURRENT zones at desktop width (below 1024 px, the sidebar becomes a
drawer):

```text
┌ sidebar 232 px ────────┐┌ topbar (sticky) ─────────────────────────────────────────┐
│ brand · "v0.4 · Audit" ││ Project / Page  [Demo mode] [+ Import trace] [Criterion▾]│
│ project switcher       ││                  1,248 traces this week · 0 exceptions   │
│ nav: 5–7 groups,       ││                  [GUIDED DISPLAY]                        │
│      6–14 destinations │├──────────────────────────────────────────────────────────┤
│ ────────────────────── ││ content: each page sets its own max width                │
│ display switch         ││                                                          │
│ user · theme toggle    ││                                                          │
└────────────────────────┘└──────────────────────────────────────────────────────────┘
```

What holds up (*keep*):

- Sidebar + content fits 6–14 destinations (`layouts.md` › Sidebar + content;
  decision rule 4).
- The phone drawer works. It moves focus in, closes on Escape and on route
  change, returns focus to its trigger, and marks the page `inert`
  (`components/layout/root-layout.tsx:91-121,164`).
- The shell has a skip link and an active-nav indicator.
- The project switcher says what it switches.
- The shell renders no-project and API-unavailable as separate states
  (`root-layout.tsx:123-136`) instead of blurring them.
- Blind review runs in its own minimal shell, which cannot enrich the frozen
  task view (`layouts/blind-review-layout.tsx`). That is structurally right
  for the governed-review boundary in `PRODUCT.md` (TARGET).

### S1. Nav label, breadcrumb, and page title disagree

Sev 3 · CURRENT · *fix*

Rendered at 1440 px in Technical display, which shows every destination.
Demo mode shows a notice on `/analyze` and `/human-truth`, so their titles
here come from the code:

| Route | Nav label | Breadcrumb | Page title |
|---|---|---|---|
| `/` | Overview | Overview | Project overview |
| `/skill` | Review guide | Skill | *(the Check's name)* |
| `/skill/edit` | Review guide *(prefix-active)* | Skill | Edit the evaluator |
| `/skill/versions` | Review guide *(prefix-active)* | Skill | Evaluator versions |
| `/traces` | Live traces | Traces | Traces |
| `/exceptions` | Needs a human · ungoverned | Exceptions | Cases that need human review |
| `/review-queues` | Review sessions · ungoverned | Review queues | Review queues |
| `/datasets` | Saved datasets | Datasets | Datasets |
| `/reliability` | Reliability signals | Reliability | Reliability |
| `/analyze` | Analyze · find failures | *(project only)* | Analyze why runs fail |
| `/human-truth` | Human truth · governed | *(project only)* | Human truth |
| `/cases/:id` | *(none)* | *(project only)* | *(the case title)* |
| `/first-result` | *(none)* | First Result | Applying the saved Check to a recorded Run |

The Review guide destination is the sharpest case. The nav calls it "Review
guide", the breadcrumb "Skill", the page titles "evaluator", and the Overview
button that opens it says "Check".

- Rule: `navigation.md` › "Location is always visible… The page title matches
  the label that led there"; `labels.md` › Page titles and navigation labels.
- Proposal: a single route registry. It maps each path to its nav label,
  breadcrumb trail, page title, and document title, and `Sidebar`, `Topbar`,
  and `SectionHead` all read from it. Today those four facts live in three
  places:
  - `components/layout/sidebar.tsx:52-127`;
  - `root-layout.tsx:20-48`;
  - each screen's `SectionHead`.

### S2. Breadcrumb resolver gaps

Sev 2 · CURRENT · *fix*

- `/skill/versions` never shows its own crumb. `crumbsFor` returns the first
  prefix match, and `"/skill"` comes before `"/skill/versions"`
  (`root-layout.tsx:28-29,38-39`).
- `/analyze` and `/human-truth` are nav destinations with no crumb entry.
- These routes also fall back to the project name alone:
  - `/cases/:id`;
  - `/cases/:id/make-test`;
  - `/tests/:id/evidence`;
  - `/review`;
  - `/compare-runs`;
  - `/human-truth/new/:kind`;
  - the resolution route under `/human-truth`.

  A case opened from the Overview therefore shows neither a crumb nor an
  active nav item.
- The `/exceptions` → "Exceptions / Trace" special case
  (`root-layout.tsx:40-42`) matches no nested route in `App.tsx`. Only the 404
  page and a trailing-slash `/exceptions/` URL render it. The router ignores
  the trailing slash, so `/exceptions/` shows the real Exceptions screen under
  a bogus "Trace" crumb.
- Crumbs are plain text (`components/layout/topbar.tsx:28-34`), so the trail
  cannot take the user up a level.
- "First Result" is the only Title Case crumb (`casing.md`: default sentence
  case). Of the labels the scanner extracted, 89% are sentence case.

Rule: `navigation.md` › "Location is always visible… a breadcrumb for
hierarchies deeper than two levels".

Proposal:

- resolve crumbs by longest prefix, or from the S1 registry;
- render parent crumbs as links;
- give detail pages their parent, for example "Exceptions / Refund request…".

### S3. Page titles are not headings, and no route sets its own document title

Sev 3 · CURRENT · *fix*

- All 22 routes I rendered keep the document title "Rubrist". Tabs, history,
  and bookmarks cannot tell pages apart.
- `SectionHead` renders the page title in a `div`
  (`components/rubrist/section-head.tsx:19`). `CardTitle` is also a `div`
  (`components/ui/card.tsx:18-22`).
- Across the 22 rendered routes, the only `h1` is inside the rubric's own
  Markdown on `/skill` (`components/markdown-preview.tsx:134`). There, a
  user-written heading becomes the page's top heading.
- A few screens outside `SectionHead` render their own `h1`: the
  trace-to-test builder, test evidence, human-truth create and resolution,
  and blind review.

Rule: `navigation.md` › "Location is always visible"; `page-structure` step 5
(hierarchy). Page titles and headings are also WCAG 2.4.2 and 1.3.1. Apart
from that, this round does not audit accessibility, which `ux-craft`
delegates.

Proposal:

- `SectionHead` renders one `h1` per page;
- `CardTitle` accepts `as="h2"`;
- set `document.title` from the S1 registry as "Page · Project · Rubrist";
- demote Markdown headings inside previews to `h3` or lower.

### S4. The topbar shows numbers it does not have

Sev 3 · CURRENT · *fix*

- "1,248 traces this week" labels `project.importedTraceCount`
  (`root-layout.tsx:198-202`). That value is an all-time count of the
  project's imported raw traces (excluding gate-candidate and release-evidence
  cases), with no time filter
  (`apps/api/src/repository.pg/project-counter-commands.ts:3-17`). The
  Overview labels the same number "Traces imported".
- While the dashboard request is in flight, and after a 401 until the session
  refreshes (S6), the topbar shows "0 traces this week · 0 exceptions" and the
  breadcrumb "Rubrist / Overview". The `?? 0` fallbacks at
  `root-layout.tsx:84-85` turn missing data into zero.

TARGET context: `PRODUCT.md` principle 2 says "Missing or failed evaluation is
never converted into a favorable result." Showing "0 exceptions" before
anything has loaded is that conversion in miniature.

Rule: `states.md` › Loading (a skeleton in the shape of the ideal state) and
Error (what failed, what the user can do, and only the data that did load).

Proposal:

- label the count "Runs imported", with no 7-day count (D7);
- show placeholders, not zeros, until the dashboard loads;
- hide the stats on error.

### S5. The topbar's right zone does five jobs

Sev 2 · CURRENT · *fix* · decided in D6

The zone (`root-layout.tsx:170-207`) holds:

- the demo badge;
- the global create action ("Import trace", or "Add examples" in bench);
- the criterion selector, shown only when there is more than one criterion;
- project stats;
- a "Guided display" pill.

Problems:

- The pill has the same border and fill as the Import trace button but does
  nothing (`topbar.tsx:42-48`). The working control is in the sidebar footer.
  Per `page-structure` step 4, identical-looking controls should behave
  identically.
- The criterion selector changes the data on every page. It sits between a
  button and the stats, with a small mono-caps label. ASSUMPTION: an owner of
  a project with several criteria will lose track of which criterion the page
  shows. Scope belongs with location (`archetypes.md` › Dashboard: "Title +
  time range / scope selector"; `placement.md` › Header zone contents).
- At 390 px the sticky topbar wraps to two rows and keeps about 97 px of an
  844 px screen.

Proposal:

- decided in D6: make the breadcrumb `Project / Criterion / Page`, with the
  criterion crumb as the switcher, when the project has more than one
  criterion;
- *fix*: remove the display pill, or turn it into the switch;
- *keep* Import trace as the one global action. ASSUMPTION: importing is the
  product's main input and the day-0 path, so a global entry beats a
  Traces-only entry.

### S6. Shell loading and error states

Sev 2 · CURRENT · *fix*

- **401 after load**, for example an expired session. `classify` returns
  `unauthorized` (`lib/dashboard-context.tsx:28-35`), but the shell only
  branches on `no-project` and `unavailable` (`root-layout.tsx:127-136`). The
  comment at `root-layout.tsx:125` says AuthGate handles 401. AuthGate follows
  Better Auth's session hook, which refetches when the window regains focus;
  it does not react to API 401s. Until that refetch, every criterion-scoped
  route shows "Loading the selected criterion’s evaluator and evidence…" with
  no way back to sign-in.
- **500.** The page reads "Connection lost · Rubrist can't reach its backend
  right now" with the detail `net::ERR_INTERNET_DISCONNECTED`. That detail is
  hardcoded whenever no status is passed (`screens/system.tsx:73`), and the
  shell never passes one (`root-layout.tsx:133`). The backend answered, but
  the page says the connection is down.
- **Loading.** The shell's loading message (`root-layout.tsx:216-219`) is
  plain text in a box. In Guided display it leads with "criterion" and
  "evaluator".
- **Unreachable branches.** `/` and most other routes are criterion-scoped
  (`lib/criterion-selection.ts:5-13`), so the shell replaces the page before
  the screens' own branches can render. These are therefore unreachable:
  - the Overview's loading branch, titled "Monday morning"
    (`screens/dashboard.tsx:77-86`);
  - the Overview's error branch, "API unavailable… Start the API with `pnpm
    dev:api`" (`screens/dashboard.tsx:88-102`);
  - the same loading and error branches in `screens/exceptions.tsx:260-282`;
  - the loading branch in `screens/review.tsx:54-60`.

  They should be deleted, not fixed.

Rule: `states.md` › Loading and Error; `errors.md` › The shape of an error
message, and "A code may be appended for support… after a human sentence."

Proposal:

- add a signed-out branch that returns to sign-in and keeps the route;
- pass the HTTP status to `ApiUnavailableScreen`, and word 5xx responses as
  "Rubrist's server returned an error";
- use a skeleton in the page's shape instead of the text box;
- delete the dead branches.

### S7. Sidebar grouping mixes two schemes

Sev 2 · CURRENT · *fix* · decided in D5

The groups interleave journey stages with evidence classes
(`sidebar.tsx:52-127`):

1. Journey
2. 1 · Define good
3. Governed lifecycle
4. 2 · Operational triage
5. 3 · Guard known failures · 2/5
6. Ungoverned diagnostics
7. System

Guided shows 6 groups and 10 destinations, Technical 7 and 14, and Summary 5
and 6. Governance is encoded twice: once in group names and again as item
suffixes. For example, "Human truth · governed" sits inside "Governed
lifecycle", and "Needs a human · ungoverned" sits inside a numbered act. At
232 px, the suffixes wrap "Needs a human · ungoverned" and "Review sessions ·
ungoverned" onto two lines.

On the day-0 Overview in Guided display, the sidebar lists "Criteria",
"Golden set", and "Human truth · governed". The contract asks that first-run
screens not *lead* with "criterion" or "golden" (TARGET,
`docs/beginner-onboarding-journey.md` › Product language). D5 treats
persistent navigation as leading.

- TARGET: the separation itself is required. See `PRODUCT.md` principles 1
  and 10, and the intent comment at `sidebar.tsx:49-51`: a trace count or
  golden-set size must not imply stronger evidence. Keep the separation; D5
  sets its form.
- ASSUMPTION: an unnumbered group between "1" and "2" reads as part of the
  numbered sequence.
- Rule: `navigation.md` › "mutually exclusive… named in the user's
  vocabulary"; "Seven is a smell… group, then count groups… test the tree with
  real tasks".
- Proposal (decided in D5): group by evidence class, with the ungoverned
  loop's items ordered by stage and unnumbered, and no label suffixes.
  Tree-test 5–8 real tasks before changing it.

### S8. Small shell defects

Sev 1–2 · CURRENT · *fix*

- The group label "3 · Guard known failures · 2/5" plus "now" does not fit in
  232 px. The count wraps under the label and "now" crowds it
  (`sidebar.tsx:192-194,404-415`). Move the count to the Golden set item.
- The brand line hardcodes "v0.4 · Audit" (`sidebar.tsx:183`), but the
  workspace version is 0.3.0 (`package.json`). Inject the build version or
  drop the line.
- When there is no email, the account block's second line falls back to the
  role label "Skill owner" (`sidebar.tsx:164`), a third name for the owner of
  the evaluator (see O8).
- Sign out exists only inside Settings (`screens/settings.tsx:271-272`). The
  sidebar account block offers only the theme toggle. ASSUMPTION: people look
  for sign-out on their own name.
- In Technical display, the nav pushes the display switch and account block
  below the bottom of a 900 px-tall window.
- The same fixed-column pattern as O10 appears in two shell-level dialogs:
  - the Import trace modal (`components/import-trace-launcher.tsx:158`);
  - project creation (`components/project-task.tsx:39`).

  Neither was rendered at 390 px in this round.

### S9. Content width varies within one archetype

Sev 1 · CURRENT · *fix* · decided in D8

The shell's content frame is `max-w-none` (`root-layout.tsx:209`), so each
page sets its own width:

- list pages use 1760 px (Exceptions, Review queues, Integrations) or no limit
  (Traces, Golden set, Datasets, Criteria);
- Settings and the evaluator editor use 1600 px;
- flow pages use about 900–1200 px.

Narrow flow pages are right (`layouts.md` › Centered narrow). The spread
among list pages only shows on screens wider than about 2,090 px (1,760 px
content, 232 px sidebar, and 96 px of padding).

Rule: `layouts.md` › Grid and reading order: "Keep one consistent content
max-width per archetype across the app."

Proposal: one width token per archetype (list/detail/dashboard, settings,
flow), set in the shell.

---

## Part 2: Overview (`/`)

### Job line and archetype

On the Overview, the quality owner **notices what is waiting on them and the
one next step for the selected Check**, so that **they can go and act on it**.

| Journey state (`lib/journey.ts:27-32`) | Screen | Leading archetype |
|---|---|---|
| Day 0: nothing imported | `DashboardWelcome`, `DashboardBenchWelcome` | Empty or first-run |
| Provisional: Runs in, starter never approved | `DashboardProvisional` | First-run, plus a dashboard strip |
| Production: an approved version is judging | `DashboardScreen` | Dashboard |

TARGET: an Overview that changes with the state matches the contract: "Only
one primary next action appears at each state. Back and exit actions stay
available without competing visually with it." (`docs/beginner-onboarding-journey.md`
› In the app).

What holds up (*keep*):

- The journey state comes from durable project state, never from click flags
  (`lib/journey.ts:16-18,55-59`), so there is nothing to drift.
- In production, every KPI tile links to the page where the user acts on it
  (`archetypes.md` › Dashboard). The provisional "Imported" and "Results ·
  provisional" tiles do not link (`screens/dashboard-provisional.tsx:128-137`).
- The honesty copy is present and TARGET-aligned (`PRODUCT.md` principles 1,
  9, and 10). Examples: "not governed human truth", "ungoverned", "The
  remaining Results rely only on the Check", and "Rubrist does not group cases
  by semantic similarity".
- For owners, day 0 and provisional each render exactly one filled button:
  "Add a recorded run", and the ledger's "Review the Check". The banner's
  button of the same name is unfilled. Provisional members see no filled
  button.
- The categories and exceptions tables explain why they are empty
  (`states.md` › Empty).

### O1. The page title changes with the state

Sev 2 · CURRENT · *fix* · decided in D9

The page titles are:

- day 0: "Get your first Check result";
- provisional: a sentence, such as "12 runs imported. Here is what the starter
  Check found.";
- production: "Project overview".

Nav and breadcrumb say "Overview" throughout. On day 0, the card title "Get
your first result" repeats the page title.

Rule: `labels.md` › Page titles ("The page title equals the navigation label
that led to it") and › Section headings ("Noun phrases… Not sentences").

Proposal: use `h1` "Overview" in every state. Put the state in the eyebrow and
the lead sentence, which the provisional and production states already have.

### O2. One journey, three step models

Sev 3 · CURRENT · *fix* · decided in D1

| Where | Step 1 | Step 2 | Step 3 |
|---|---|---|---|
| Sidebar groups (`sidebar.tsx:54-78`) | 1 · Define good | 2 · Operational triage | 3 · Guard known failures |
| Overview pipeline, tracing production (`components/rubrist/journey-pipeline.tsx:33,49,63`) | Act 1 · Choose what to Check | Act 2 · See Results on real Runs | Act 3 · Protect reviewed examples |
| Setup ledger: day 0, provisional, bench (`components/first-run-setup-ledger.tsx:28-74`) | 1 · Bring one recorded run (bench: "Bring one example run") | 2 · Choose one thing to Check | 3 · See the first Result |
| First project key card (`components/first-project-key.tsx:50`) | — | "Act 2 · judge something real" | — |

The same step carries different numbers. "Choose one thing to Check" is ledger
step 2, pipeline Act 1, and sidebar group 1.

On day 0 and provisional, the sidebar acts and the ledger are visible at the
same time, with different "now" markers. On day 0, for example:

- the sidebar marks "1 · Define good" as now;
- the ledger's current step is "Bring one recorded run";
- the key card says "Act 2".

In bench production the ledger replaces the pipeline
(`screens/dashboard.tsx:192-196`). Bench users never see the Overview's Act 1–3
strip, so the sidebar's numbered groups are their only view of the loop.

- Rule: `navigation.md` › Consistency across the app; `labels.md` ›
  Terminology (one term per concept); `decisions.md` › Progress indication.
- TARGET: the contract describes one journey in seven steps
  (`docs/beginner-onboarding-journey.md` › In the app). It does not define the
  acts.
- Proposal (decided in D1): name two things, not three.
  - **Setup** is the ledger. It shows until complete and then leaves (see O6).
  - The ongoing **loop** is the acts, with the same names in the sidebar and
    the pipeline.

  Never show two numbered sequences on one screen.

### O3. No dominant element, and the attention list comes last

Sev 3 · CURRENT · *fix*

The production order (`screens/dashboard.tsx:176-514`) is:

1. key card (shown once);
2. setup receipt;
3. header;
4. pipeline, then the first-Result card when exactly one Result exists
   (`screens/dashboard.tsx:198-204`);
5. a three-line serif summary;
6. four KPI tiles of equal weight;
7. distribution;
8. categories beside the Check card;
9. Exceptions waiting;
10. Manage integrations.

At 1440×900 with 7 Results waiting, the only filled button, "Review all 7"
(`screens/dashboard.tsx:443-451`), sits about 1,345 px down, below the fold.
The first screen holds only the title, the pipeline, the sentence, and the
four tiles.

In bench production a second filled button can appear. When a new version has
no Result yet, the ledger's current step has a primary button
(`components/rubrist/setup-ledger.tsx:83`) alongside "Review all N".

Rule: `archetypes.md` › Dashboard ("Headline metrics row (3–5 tiles, one
dominant)… Attention list: what needs action now"; "a dashboard with eight
equal tiles has no hierarchy"); `placement.md` › Universal rules (one primary,
placed where the eye ends after the page's purpose).

Proposal: see the [blueprint](#proposed-blueprint-production). Put a dominant
next-action zone first and the attention list second.

### O4. Six routes to one queue, and five names for it

Sev 3 · CURRENT · *fix*

With 7 Results waiting, the topbar shows "7 exceptions" as plain text, and the
production Overview offers six routes to the queue:

- sidebar "Needs a human · ungoverned 7";
- the sentence's link "7 are waiting on a person";
- the KPI tile "Exceptions 7 · Waiting on a reviewer · Humans next · open
  queue →";
- the pipeline's Act 3 button "Review Results";
- the card's "Review all 7" and "Open queue" buttons.

All of them go to `/exceptions` except "Review all 7", which goes to
`/review`. The five names are "Exceptions", "Needs a human", "waiting on a
person", "Waiting on a reviewer", and "Humans next". The provisional state
adds a sixth, "Need a closer look".

Rule: `page-structure` step 2 ("Cut before arranging"); `labels.md` ›
Terminology.

Proposal: one next-action button, one list with an "Open queue" link, and one
name for the queue (see O8).

### O5. Act 3's button does not match Act 3

Sev 2 · CURRENT · *fix*

When Act 3 is the current act and anything is waiting, "Protect reviewed
examples" shows a "Review Results" button that goes to `/exceptions`
(`journey-pipeline.tsx:67,94-98`). The step
promises protection, but its button goes to triage. ASSUMPTION: the intent is
"review first, then protect".

Rule: `labels.md` › Buttons and actions (say what happens). This is also the
`user-flow` leading idea: every step keeps the scent of what happens next.

Proposal: label the button by its outcome, for example "Review 7 Results to
protect". Alternatively, let the next-action zone own triage and keep Act 3's
button for protection.

### O6. Facts repeat, and finished work keeps the top slot

Sev 2 · CURRENT · *fix*

- The waiting count appears five times: topbar, sidebar badge, sentence, KPI
  tile, and the card's "Review all 7" button. The imported total appears
  three times, and "as of" twice.
- Bench production pins the completed ledger to the top ("3 of 3 complete ·
  first result ready", every row struck through) with no way to dismiss it
  (`screens/dashboard.tsx:192-196`). Yet the component describes itself as a
  checklist that "persists on the Overview until completed"
  (`setup-ledger.tsx:7`). Bench users also never get the next-action
  pipeline.
- "Manage integrations" (`screens/dashboard.tsx:510-514`) duplicates the
  sidebar item and the Sync-back tile's link.
- The exceptions table shows the first 5 with no "5 of 7" count
  (`screens/dashboard.tsx:471`).
- At 1280 px and wider, the categories card stretches to the Check card's
  height, leaving an empty block under three rows.

Rule: `page-structure` step 2; `states.md` › Partial.

Proposal:

- collapse the finished ledger into a one-line receipt, and show the pipeline
  in bench mode too;
- remove "Manage integrations";
- add "Showing 5 of 7";
- use `items-start` on the two-column grid.

### O7. Guided display shows the model binding

Sev 2 · CURRENT · *fix*

The Check card prints two technical lines in every display
(`screens/dashboard.tsx:412-422`):

- "Model · anthropic/claude-sonnet-4-6";
- the full binding, which repeats the model: "Binding ·
  anthropic/claude-sonnet-4-6 · temperature 0 · thinking disabled at effort
  high · 1200 output tokens · anthropic.structured-output/v1".

Only "Too strict / lenient" is marked `dev-only`. Guided promises to hide
"secondary diagnostics and technical details" (`lib/display-mode.ts:15`).

TARGET: the contract files model bindings, versions, and digests under
"Technical details", which are "available for inspection without blocking the
default journey". It also says such terms "remain exact on Technical surfaces
and in evidence" (`docs/beginner-onboarding-journey.md` › Product language).

Proposal: move Model and Binding into `.dev-only`. Keep the name, status,
agreement, and owner.

### O8. Terminology on Guided surfaces

Sev 3 · CURRENT vs TARGET · *fix* · decided in D2 and D11

TARGET vocabulary (`docs/beginner-onboarding-journey.md` › Product language):
Guided display uses **Run**, **Check**, **Result**, **Review guide**,
**Protected example**, **Correct this result**, **Independent human review**,
and **Agreement with people**.

In Guided display, prefer **Check** before introducing **Evaluator**, and
explain the relationship once in context: "Rubrist calls this reusable
automated Check an evaluator." First-run screens do not lead with `eval`,
`criterion`, `rubric`, `judging skill`, `golden`, `model binding`, `output
schema`, `calibration`, or revision identifiers, which "remain exact on
Technical surfaces and in evidence".

`README.md` › Concepts (CURRENT guidance) agrees.

CURRENT on the Guided Overview:

- **The evaluator:**
  - "Check": the sentence and the "Open Check" button;
  - "Skill": "Skill in production" and the column "Skill said";
  - "evaluator": the exceptions card description and the categories empty
    state;
  - "judge": "No judge categories yet".
- **The unit of evidence:** "traces", "Runs", "cases", and "examples" on one
  screen.
- **The regression set:** "Golden set" (sentence, sidebar), "golden cases",
  "Golden-set agreement", and, in bench only, "Protected examples".
- **The queue:** see O4.
- **Raw enum values shown as copy:** the version status "v1.2.0 · production"
  (`lib/skill-presentation.ts:12-18`). Outside the Overview, the `/traces`
  eyebrow reads "Audit · ungoverned_legacy verdicts".

The scanner's lower-bound counts cover every display, including Technical,
where "evaluator" is correct. By number of strings: "evaluator" 47, "judge"
43, "Check" 33, "Skill" 7. The vocabulary's center of gravity is not the
contract's.

Rule: `labels.md` › Terminology; `ui-naming` step 0.

Proposal: the [naming table](#naming-proposal) below.

### O9. Bench projects say "production"

Sev 2 · CURRENT · *fix*

`screens/dashboard.tsx:160-162` sets a bench copy rule: "'established', never
production language". Three things break it:

- `skillVersionStateLabel` prints the raw status
  (`lib/skill-presentation.ts:12-18`);
- the `active` lifecycle state maps to `production` in the query that feeds
  the dashboard (`apps/api/src/repository.pg/skill-lifecycle-repository.ts:169`,
  repeated at `:120`, `:160`, and `:878`);
- the bench card, titled "Skill on the bench", therefore wears a "v1.2.0 ·
  production" chip.

Proposal: map statuses to copy per mode in one helper.

### O10. Phone width breaks the primary actions

Sev 3 · CURRENT · *fix*

Rendered at 390×844:

- **Pipeline.** `grid grid-cols-3` has no breakpoint (`journey-pipeline.tsx:74`).
  Each act is about 115 px wide, and the next-action button is clipped ("Open
  protected…", "Review Results").
- **Setup ledger.** The button group is `shrink-0` (`setup-ledger.tsx:76`) next
  to `min-w-0 flex-1` text (`:61`). On day 0, step 1's text collapses to one
  word per line, and "Set up without a run" overlaps the step title.
- **Provisional banner.** It is a flex row that does not wrap
  (`components/rubrist/provisional.tsx:27`). The page becomes 433 px wide, and
  "Review the Check" is cut off at the edge.
- **Cards.** `FirstVerdictCard` (`components/first-verdict.tsx:64`,
  `grid-cols-2`) and `FirstProjectKeyCard` (`first-project-key.tsx:70`,
  `grid-cols-3`) keep their columns at 390 px.
- **Key card.** On day 0 the one-time project key stacks below the setup
  ledger, starting about 1,050 px down, past the first 844 px screen. Yet it
  "cannot be shown again" (`first-project-key.tsx:58`).

Rule: `layouts.md` › Decision rules, 7 ("Narrow first… The zone that serves the
job stacks first").

Proposal:

- use a single-column base with `sm:` and `lg:` breakpoints;
- wrap button rows under their text below `sm`;
- while the key is unsaved, put the key card first in every state and at every
  width.

### O11. Day 0 offers eight ways to start

Sev 2 · CURRENT · *fix* · decided in D10

Besides the primary "Add a recorded run", day 0 offers:

- "Set up without a run";
- the topbar's "Import trace";
- in the key card: "Paste one trace", "Call the API", and "Connect a tracer";
- in the agent card: "Copy setup prompt" and "I have a proposal · connect".

The aside column (key, agent, and two explanations) runs about 900 px longer
than the main column, and it carries the heavier color.

TARGET: "Only one primary next action appears at each state… without
competing visually with it."

Rule: `archetypes.md` › Empty or first-run ("One primary action, never a tour of
features").

Proposal: keep the primary and one "Other ways to bring a Run" disclosure for
the tracer, API, and agent paths. Cut each explanation to one line.

### O12. Provisional sign-off is one click next to the primary

Sev 2 · CURRENT · *fix* · decided in D4

"Use this starter Check" (ghost style) sits next to "Review the Check" in the
banner (`screens/dashboard-provisional.tsx:77-86`) and signs off at once. A
code comment says nothing syncs back until sign-off
(`components/rubrist/provisional.tsx:7`), so this click may start writing
Results to the tracing platform.

- ASSUMPTION, now in doubt: the sync code shows no sign-off gate. Both judge
  paths queue a write-back for every judged Run with a tracing source
  (`apps/api/src/workers/judge.ts:53-67`,
  `apps/api/src/workers/eval-run.ts:346-365`), and the job insert has no
  sign-off condition (`apps/api/src/repository.pg/judge-feedback-repository.ts:195-214`).
  If provisional Results already sync, they reach the tracing platform before
  an owner has reviewed the starter guide, which the comment says should not
  happen. Verify this in Postgres mode before writing the confirmation.
- TARGET: the click is deliberate, so explicit authority is present. The
  contract does not require a confirmation.
- Rule: `placement.md` › Universal rules (keep consequential options apart from
  benign ones); `decisions.md` › Confirmation, undo, or nothing.
- Proposal (decided in D4): add a confirmation that names the effect, such as
  "Sign off Check v0.1.0? Its Results stop being provisional." Add the
  write-back sentence only if the check above confirms it.

### O13. Governed evidence is absent from the Overview

Sev 2 · TARGET vs CURRENT · *fix* · decided in D3

The Overview reports only the operational loop: imports, legacy human checks,
exceptions, sync-back, and the golden set.

`PRODUCT.md`'s first job is analyze → criteria → governed review →
calibration. It also lists a CURRENT integrated measurement view covering:

- coding completion;
- taxonomy coverage;
- reviewer disagreement;
- calibration error and coverage.

That view renders only inside the Analyze workspace
(`screens/analysis-study-workspace.tsx`). The pipeline's footnote admits the
gap: "Operational setup only. Governed analysis and human truth are tracked
separately" (`journey-pipeline.tsx:103`).

Proposal (decided in D3): add a visually separate "Governed evidence" status
zone to the Overview, with:

- status only: study open or closed, truth revisions, and whether
  calibration is admissible;
- links to Analyze and Human truth;
- no numbers shared with the ungoverned zones.

This keeps the separation `PRODUCT.md` requires while making the charter's
main loop visible from the home page.

### Proposed blueprint (production)

*Proposal; not built.* The shell is unchanged apart from S1–S5.

Desktop, tracing, 7 Results waiting:

```text
Project / Overview                                       [+ Import trace]     ← topbar
───────────────────────────────────────────────────────────────────────────
Overview                                             Data as of Apr 30, 20:00
Support Answer Quality · Check v1.2.0 · active
┌─ Next ──────────────────────────────────────────────────────────────────┐
│ 7 Results are waiting on a person.               [ Review 7 Results → ] │ dominant
│ ✓ Choose a Check    ✓ See Results    ● Protect examples · 2 of 5        │
└─────────────────────────────────────────────────────────────────────────┘
Waiting on a person · showing 5 of 7                            Open queue →
  When     Run                                   Check said   Why
  20:00    Refund request for duplicate charge   Fail         Answer cites a…
  …
┌ Runs imported ┐┌ Latest Results ───────┐┌ Agreement ─────────┐┌ Sync-back ┐
│ 1,248         ││ 1,196 · 87% pass      ││ 86% · 2 protected  ││ 97%       │
│ LangSmith     ││ ▇▇▇▇▇▇▇▇▇▇▇▇▇▆▂       ││ examples           ││ partial   │
└───────────────┘└───────────────────────┘└────────────────────┘└───────────┘
Failure categories                          │ Check
  Unsupported promise   41   high volume    │ Support Answer Quality
  Policy misquote       22   moderate       │ v1.2.0 · active · Owner: Product Lead
  Missing escalation     9   low            │ [Open Check]   Technical: model, binding
───────────────────────────────────────────────────────────────────────────
Governed evidence · status only                                    (O13, D3)
  Analysis study: closed · Human truth: 1 revision · Calibration: not admissible
```

Narrow (390 px), same content, stacked in job order:

```text
[☰] Project / Overview       [+]
Overview · as of Apr 30, 20:00
Support Answer Quality · v1.2.0 active
┌───────────────────────────────┐
│ 7 Results are waiting on a    │
│ person.                       │
│ [ Review 7 Results → ]        │
│ ✓ Check  ✓ Results  ● 2 of 5  │
└───────────────────────────────┘
Waiting on a person · 5 of 7
  Refund request for dup…  Fail
  Apr 30, 20:00
  …                  Open queue →
[Runs 1,248   ] [Results 1,196 ]
[Agreement 86%] [Sync-back 97% ]
Failure categories (stacked list)
Check summary
Governed evidence (D3)
```

**Zones**

| Zone | Contents | Why |
|---|---|---|
| Location (topbar) | Breadcrumb `Project / Overview` with links; Import trace | S1, S2; `navigation.md` › Location |
| Header | `h1` Overview; the Check's name and status beside it; data as of | O1; `placement.md` › Header zone contents (status beside the title) |
| Next *(dominant)* | One sentence, one primary button, and the loop strip using the sidebar's act names | O2–O4; `archetypes.md` › Dashboard; contract: one primary per state |
| Waiting | The first 5 waiting Results, "showing 5 of N", and an Open queue link | `archetypes.md` › Dashboard (attention list); `states.md` › Partial |
| Health | 3–4 tiles of equal weight, each linking to where the user acts; the distribution bar inside the Results tile | `archetypes.md` › Dashboard |
| Breakdown | Failure categories, still with no similarity claim | `PRODUCT.md` principle 9 (TARGET) |
| Check | Name, mapped status, owner, and agreement; model and binding in Technical only | O7, O9 |
| Governed evidence | Status only, visually separate | O13, D3; `PRODUCT.md` principles 1 and 10 |

Removed:

- the Exceptions tile, because Next and Waiting cover it;
- "Manage integrations";
- the repeated "as of" line;
- on this page only, the topbar stats. Other pages keep them, hidden below
  `sm` (D7).

**Placement decisions**

1. **One filled button.** It reads "Review N Results", or, when nothing is
   waiting, the first incomplete act's action. It goes at the top, in Next.
   - `placement.md` › Universal rules.
   - The dashboard exception applies (`archetypes.md` › Dashboard): the
     Overview is the launch point for the loop's next task.
2. **"Open queue" is a text link** in the Waiting header, and clicking a row
   opens that Run (`placement.md` › Row and item actions).
3. **The Check's status sits beside its name in the header**, not in a chip
   inside a card (`placement.md` › Header zone contents).
4. **Provisional sign-off is a separate secondary action** with a confirmation
   that names its effect (O12; `placement.md` › Universal rules;
   `decisions.md` › Confirmation, undo, or nothing).
5. **The one-time project key is the first zone** in every state and at every
   width until it is saved or dismissed (`layouts.md` › Decision rules, 7).

**States**

| Zone | Empty | Loading | Partial | Error |
|---|---|---|---|---|
| Next | Nothing waiting and every act done: "Nothing is waiting on a person." with the loop strip and no primary | One-line skeleton and a disabled button | — | "Couldn't load the Overview." with Retry and whatever did load; never zeros |
| Waiting | "Nothing is waiting on a person. Failed or ambiguous Results appear here." | Five-row skeleton | Fewer than 5 rows: no "showing" line | Inline "Couldn't load waiting Results" with Retry |
| Health | Day 0 uses the first-run layout instead | Tile skeletons; numbers show "—", never "0" | A tile with no source says why (a manual import has no sync-back) | "Unavailable" in the tile itself |
| Breakdown | "No failure categories yet. They appear when the Check returns one." | Table skeleton | One or two rows are fine | Inline retry |
| Check | — | Skeleton | Starter versions show "Starter · unvalidated" (contract) | Inline retry |
| Governed evidence | "No analysis study yet" with a link to Analyze | Skeleton | Each item not yet started says "not started" | Inline retry |

### Day 0 and provisional (differences from production)

Day 0, first-run archetype:

```text
Overview                                  eyebrow: New project · no Runs yet
Get your first Result from one recorded Run.
┌ Save your project key · shown once ────────── [Copy key]  [I saved it] ┐   only while unsaved
└────────────────────────────────────────────────────────────────────────┘
Setup · 0 of 3
  ① Bring one Run                  [ Add a recorded Run ]   Set up without a Run
  ② Choose one thing to Check
  ③ See the first Result
▸ Other ways to bring a Run: connect LangSmith or Langfuse · call the API · ask your AI agent
What "starter" means, in one line · What Rubrist can see, in one line
```

Provisional:

```text
Overview                                  eyebrow: First import · LangSmith
12 Runs imported; the starter Check returned 10 Results.   [Provisional]
Results stay provisional until an owner signs off the Review guide.
  [ Review the Check ]                               Sign off as is…  (confirms)
Latest Result (stacks on phones)
Setup · 2 of 3 (step 2 current)
```

### Naming proposal

In `ui-naming` format. Each row names a concept once for Guided display and
once for Technical display. Rules are `labels.md` › Terminology and the
contract's Product language table.

| Concept | Current names (where) | Proposed: Guided / Technical | Status |
|---|---|---|---|
| The evaluator | Check (sentence, button); Skill (card title, "Skill said", breadcrumb, "Skill owner"); evaluator; judge | Check / evaluator | rename |
| Its rubric | Review guide (nav); guide; starter guide; rubric; breadcrumb "Skill" | Review guide / rubric | keep; fix the breadcrumb |
| Unit of evidence | traces, Runs, cases, examples | Run / trace or case; bench uses "example" | rename (D11) |
| The evaluator's output | Result; verdict; "Skill said" | Result / verdict; column "Check said" | rename |
| Waiting queue | Exceptions; Needs a human; waiting on a person; Waiting on a reviewer; Humans next; Need a closer look (provisional) | Waiting on a person / Exceptions | rename (D2) |
| Ungoverned human rulings | Legacy human checks | Corrections · ungoverned, from the contract's "Correct this result" | rename (D11) |
| Regression set | Golden set; golden cases; Golden-set agreement; Protected examples; Guard known failures | Protected examples / Golden set | rename |
| Loop steps | Three sets (O2) | Setup: three numbered steps. Loop: "Choose a Check", "See Results", "Protect examples", unnumbered, identical in the sidebar and the Overview | rename (D1) |
| This page | Overview; Project overview; "Monday morning" (dead loading title); project dashboard | Overview | rename |
| Version status | Raw `status` enum | Copy mapped per mode (O9) | rename |
| Imported count | "traces this week" (topbar); "Traces imported" (KPI) | Runs imported | rename |
| Crumb casing | First Result | First result | rename |

These names are decided (D1, D2, D11). They become TARGET only when the queue
name, the loop step names, and the rejected synonyms are added to the
contract's Product language table, which is effectively Rubrist's interface
glossary.

## Decisions

Decided 2026-09-26: the founder asked to take the recommended options. These
are design decisions for implementing this audit, not product authority.
`PRODUCT.md`, the accepted ADRs, and the onboarding contract are unchanged.
Items 9–11 were marked *decide* in their findings but were not in the open
questions.

1. **Loop and setup naming (O2).** Setup is the ledger's three numbered
   steps. It shows until complete, then collapses to a one-line receipt. The
   loop is three unnumbered stages with the same names in the sidebar and on
   the Overview: "Choose a Check", "See Results", and "Protect examples".
   Bench projects get the loop strip once setup is complete (O6). Only setup
   is numbered, so no screen shows two numbered sequences.
2. **The queue's name (O4, O8).** "Waiting on a person" in Guided display and
   "Exceptions" in Technical display, the same in the nav, crumb, title, and
   eyebrow. Round 2's T8 uses the same names.
3. **Governed evidence on the Overview (O13).** Add the status-only zone to the
   production Overview, visually separate from the operational zones. It shows
   whether an analysis study is open, the number of truth revisions, and
   whether calibration is admissible. It links to Analyze and Human truth and
   shares no numbers with the ungoverned zones. The dashboard response carries
   none of these statuses today (`packages/shared/src/index.ts:711-725`);
   the Analyze and Human truth round should confirm where they come from.
4. **Sign-off (O12).** Keep sign-off on the Overview as a separate secondary
   action, behind an `AlertDialog` (*add*) that names its effect. Write that
   copy from verified behavior: O12 now records a doubt about when Results
   sync back.
5. **Sidebar grouping (S7).** Group by evidence class: the ungoverned loop,
   governed evidence, and system. Order the loop's items by stage, without
   numbers, and drop the per-item governance suffixes. Persistent navigation
   counts as leading, so Guided display names the regression set "Protected
   examples" (D11) and hides "Criteria" during setup unless the project has a
   second criterion. Tree-test 5–8 real tasks before shipping.
6. **Criterion scope (S5).** When a project has more than one criterion, the
   breadcrumb reads `Project / Criterion / Page`, and the criterion crumb is
   the switcher (`DropdownMenu`, *add*). With one criterion, the crumb is
   omitted.
7. **Topbar count (S4).** "Imported" is enough: the stat reads "N Runs
   imported", with no 7-day count. Pages other than the Overview keep the
   topbar stats, hidden below `sm`.
8. **Content widths (S9).** One width token per archetype, set in the shell:
   one for list, detail, and dashboard pages, one for settings, and one for
   flows.
9. **The Overview's title (O1).** `h1` "Overview" in every journey state, with
   the state in the eyebrow and the lead sentence.
10. **Ways to start on day 0 (O11).** One primary, "Add a recorded Run", and
    one "Other ways to bring a Run" disclosure for the tracer, API, and agent
    paths. Each explanation is cut to one line.
11. **The naming table (O8).** Adopt it as written. Bench projects say
    "example" for the unit of evidence, and ungoverned human rulings are
    "Corrections · ungoverned".

## Next rounds

Each round is one page or flow, in this order:

1. **Case detail (`/cases/:id`) and the Exceptions queue.** Done in
   [round 2](2026-09-26-triage-flow.md), which audits the whole triage flow,
   the review player included.
2. **Review guide and Check** (`/skill`, `/skill/edit`, versions, compare).
   This is the most-renamed destination.
3. **First run, end to end** (`/skill/edit?first=1` → `/first-result`),
   checked against the contract's seven steps.
4. **Traces list and import.**
5. **Analyze and Human truth.** These are the governed paths and need
   Postgres 17.
6. **Settings.** It is the only place to sign out, and it has a filled
   "Apply now" button in a card header.
