<!-- vendored from luka-zivkovic/overclock@master plugins/natural-writing/skills/natural-writing/SKILL.md -->
---
name: natural-writing
description: "Draft or revise multi-sentence human-facing prose such as blog posts, articles, essays, newsletters, landing copy, and narrative documentation. Match the author's or project's established voice; when none exists, use a plainspoken house style that avoids canned AI scaffolding, showy vocabulary, repetitive rhythm, and decorative analogies while preserving claims, uncertainty, caveats, and quoted spans exactly. Use for editing prose around quotations as well as prose without them. Do NOT use for code, code comments, commit messages, one-line UI strings, or API, legal, and reference text whose exact terminology is load-bearing."
---

# Natural Writing

Write prose in the author's voice. When the project supplies no voice or style guide, use the
plainspoken defaults below. They are fallback house style, not a detector for whether a person or a
model wrote the text.

It is stateless and lightweight on purpose: a writing discipline, not a tool. No memory, no ceremony.

## When it fires (and when it doesn't)

Fires for **multi-sentence prose meant for human readers**: blog posts, articles, essays, newsletters, landing copy, narrative sections of docs.

Stay silent. Do not apply this for:
- Code, code comments, config.
- Commit messages, PR titles.
- API / reference docs where a precise technical term is the *right* word.
- One-line UI strings, labels, error messages.
- A request concerning only a quote that must remain verbatim. A larger article containing that
  quote remains in scope: preserve the quoted/cited span or verbatim data byte-for-byte while
  editing its surrounding prose.
- Legal or precise technical text where a qualifier is load-bearing.

Never run the full pass on a single sentence. If someone asks to reword one line, just reword it.

## The rules

1. **Use punctuation intentionally.** In the fallback house style, prefer a comma, period, colon,
   parentheses, or two sentences over an em dash used as a generic connective. Prefer "to" for a
   prose range. Preserve an author's deliberate dash usage, conventional notation, and any project
   rule that calls for it; never rewrite a quoted dash.
2. **Cut AI-tell vocabulary.** Replace with the plain word: delve → look at; leverage → use; utilize → use; tapestry / realm / landscape → drop; testament to → shows; underscore / highlight → show; crucial / pivotal / vital → important (or cut); robust / seamless / synergy / paradigm / "boasts" → say what you mean. Delete performed-casual openers ("here's the thing", "here's the kicker", "the magic is", "let's be real"), announced honesty ("my honest take", "to be frank"), and unsupported value verbs ("unlock", "empower", "elevate", "supercharge", "transform"). Keep one only when its literal meaning or the author's voice requires it.
3. **Drop bot scaffolding.** No "In conclusion", "Furthermore", "Moreover", "Firstly / Secondly", "Let's dive in", "Without further ado", "Buckle up." Just say the thing. Don't preview an argument before you make it or recap it after.
4. **Write for information, not manufactured impact.** Cut a symmetrical contrast, verbless
   parallel, summary button, significance tail, or flourish ending when its main job is to sound
   punchy or conclusive. State the supported point once and stop. Preserve a contrast that marks a
   real distinction, an ending that adds information, or a recognizable authorial choice. This is
   an editing test, not a ban on a sentence shape.
5. **Vary the rhythm.** Mix short sentences with longer ones. Uniform sentence length is the second loudest tell, and so is a run of identical short ones. A two-word sentence is fine. Join closely related ideas with a plain "and", "because", or "so" when they belong together; only split ideas that are genuinely separate. Over-splitting makes prose choppy. Don't chain a long run of clauses with "and… and… and."
6. **Use everyday words and contractions.** Write the way you'd explain it to a smart friend. "Don't", "it's", "you'll" are natural, not sloppy.
7. **Be concrete without inventing.** Prefer a supported noun, number, date, actor, or example over
   a vague placeholder ("situation", "process", "factor"), and a named source over "experts say" or
   "studies show." If the source text does not supply the detail, keep the uncertainty or ask for it.
8. **Lead with the point without strengthening it.** Move the claim before throat-clearing when that
   reads better, then keep every caveat that changes its truth conditions. "Mixed evidence" must
   remain mixed; "may" must not become "does" merely to sound confident.
9. **Cut canned or decorative analogies.** Say the thing directly instead of reaching for
   the stock symphony, dance, tapestry, or journey. Preserve an author's original metaphor
   when it carries meaning or voice, and do not invent a new one unless the user wants it.
10. **Use strong verbs.** Don't bury the action in a noun: "decide", not "make a decision"; "investigate", not "conduct an investigation"; "to configure the runner, set…", not "configuring the runner involves…".
11. **Use active voice when the actor is known.** "The team missed the deadline" is clearer than
    "the deadline was missed" only when the source establishes that the team did it. Keep passive
    voice when the actor is unknown, contested, irrelevant, or deliberately withheld.
12. **Don't bold for decoration.** Bolding the lead phrase of every bullet just for emphasis is a classic AI tell. Bold is fine only as a real structural header on a list item, where the bold text names the thing and the rest explains it, e.g. "**Live feedback loop.** Poll the file and react as events arrive."

See `references/examples.md` for before/after pairs that calibrate the fallback style.

## How to work

- **Drafting:** write it naturally with these rules from the start, not as a cleanup afterthought.
- **Ground concepts before prose leans on them.** A term, name, or idea the reader can't be
  assumed to know must be introduced — or be a stated prerequisite of the piece — before a later
  sentence depends on it. While drafting or revising, track where each concept first appears; when
  a passage leans on something introduced later or never, move the introduction earlier or add the
  one-line grounding at first use. Ground in place; don't bolt on a glossary. (Structural
  counterpart to the style rules: reordering here is fine, but it still preserves the author's
  meaning and voice.)
- **Revising a draft — two passes:**
  - *Pass 1 — fix violations.* Go rule by rule above and fix what breaks them.
  - *Pass 2 — cut what doesn't earn its place.* Check hooks and paragraph endings first: remove
    restatements, editorialized significance, and cadence-only closers. Then remove other words,
    sentences, and whole sections that add nothing. Preserve the author's meaning and voice, and
    keep every caveat that changes the claim. Cutting a real qualifier to sound confident is worse
    than leaving it.
- Match how the author actually writes. Don't flatten their voice into a generic plain one.
- Before returning a revision, compare every factual claim, actor, number, date, causal statement,
  modal ("may", "will"), and scope qualifier against the original. Restore anything that was
  invented, dropped, or strengthened.

## Revision report (strictly opt-in)

By default, return only the rewritten prose. Produce the visual report only when the user
explicitly asks for a report, visual diff, or change-by-change view. Length or edit size alone is
never permission to create one.

1. Read `references/revision-report-schema.md`, then build a JSON file from the exact original and
   revised strings. The ordered changes must reconstruct both strings exactly.
2. Resolve the absolute directory of this loaded skill from the host's skill context. Also resolve
   the authorized project root, normally with `git rev-parse --show-toplevel`. Run the bundled
   helper by absolute path, never a target-repository `scripts/` path:
   ```bash
   python3 /absolute/path/to/natural-writing/scripts/build_revision_report.py DATA_JSON OUTPUT_HTML --root /absolute/project/root
   ```
   This helper is mandatory: it validates the schema, confines input/output paths to the project,
   verifies exact reconstruction, refuses linked input or output paths, and embeds UTF-8 JSON as
   base64 so HTML or `</script>` cannot become executable markup. Do not read or edit files under
   `assets/`; the helper owns that trusted asset. Never insert report data manually. If the helper
   cannot run, report the error and do not create fallback HTML. Use `--replace` only after the
   user explicitly approves replacing the named existing regular file.
3. Remove the temporary JSON data file unless the user asked to keep it, then tell the user
   the report path. It renders Original, Revised, and Diff tabs.

Never generate the report for a one-liner or a trivial edit. It is opt-in, so it stays out of the way.

## Overrides

These are defaults, not laws. The user's request and the project's applicable style instructions
win. Preserve a demonstrable authorial choice unless the user asks to change it.
