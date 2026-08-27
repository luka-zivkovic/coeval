# ADR-0002: Human truth and dataset revisions

Status: **Accepted**

Date: 2026-08-22

## Context

Coeval's target job includes validating evaluators against reviewed human
truth. Current datasets are mutable collections, so they cannot prove exactly
which cases and labels supported a calibration result or whether those cases
also shaped the evaluator.

## Decision

Coeval owns the human-review, adjudication, and calibration workflow while
also supporting import of externally reviewed truth. Imported truth keeps its
source, rater/adjudication, instructions, and content provenance rather than
becoming an anonymous label.

Native review is part of the product rather than a data-entry afterthought. A
review task preserves the full relevant trace, the criterion and instructions
shown to the reviewer, an independent label, rationale, open failure codes,
reviewer identity, and any defer/undo state. When rigor requires multiple
reviewers, they label independently before seeing one another's answers.
Alignment may improve instructions and adjudication may establish resolved
truth, but neither operation deletes or retroactively changes the independent
labels that exposed disagreement.

Review batches record how cases were selected and the population they came
from. Random or declared stratified sampling supports representative estimates;
uncertainty sampling and failure hunting support discovery and rubric
improvement. Coeval does not present a convenience or uncertainty-selected
queue as an unbiased prevalence sample.

A calibration references an immutable, content-identified dataset revision.
A revision freezes case identity, input identity, reference label, and
relevant review provenance. Editing a collection creates a new revision.

Every revision has one declared exposure role:

- **analysis/authoring:** traces and cases used for open coding, failure
  taxonomy, criterion discovery, rubric authoring, or example selection;
- **iterative development:** cases used repeatedly for prompt, rubric, model,
  implementation, or threshold-independent evaluator tuning;
- **sealed validation:** cases isolated from analysis and development until a
  declared final validation run; and
- **regression/golden:** curated known failures and important cases used to
  prevent known behavior from returning, without claiming representative
  production accuracy.

Coeval records dataset exposure to people, evaluator versions, and development
activities. Running a sealed revision for final validation is recorded. If its
cases then influence a later evaluator version, that revision is exposed and
cannot support the same sealed claim for the later version; a new protected
revision is required. A visible regression set never becomes sealed merely
because it was not used in the most recent edit.

Disjointness is checked using an input-only identity appropriate to the case
contract. The existing input-plus-output assessment content digest is not a
leakage key.

Exact identity checks are necessary but cannot detect semantically duplicated
cases. Semantic clustering remains deferred, so the product must state that
limit instead of claiming semantic leakage detection.

## Consequences

- Calibration becomes reproducible and leakage checks become enforceable.
- Existing mutable datasets remain authoring collections, not validation
  evidence by themselves.
- Known-failure regression performance remains useful without being presented
  as a representative quality estimate.
- Review UX and imported-truth contracts must preserve provenance and raw
  disagreement, not just a resolved label.
