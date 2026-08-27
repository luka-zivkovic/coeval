export type GovernedReviewConflictCode =
  | "governed_review_stream_conflict"
  | "governed_review_idempotency_conflict"
  | "governed_review_transition_conflict"
  | "sealed_overlap"
  | "sealed_separation_unknown"
  | "sealed_separation_ineligible"
  | "label_already_revealed";

export class GovernedReviewDomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 413 | 422 | 500,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "GovernedReviewDomainError";
  }
}

export class GovernedReviewNotFoundError extends GovernedReviewDomainError {
  constructor(message = "Governed review resource not found") {
    super(message, "governed_review_not_found", 404);
    this.name = "GovernedReviewNotFoundError";
  }
}

export class GovernedReviewForbiddenError extends GovernedReviewDomainError {
  constructor(message = "This governed review action is not permitted") {
    super(message, "governed_review_forbidden", 403);
    this.name = "GovernedReviewForbiddenError";
  }
}

export class GovernedReviewConflictError extends GovernedReviewDomainError {
  constructor(
    code: GovernedReviewConflictCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message, code, 409, details);
    this.name = "GovernedReviewConflictError";
  }
}

export class GovernedReviewStreamConflictError extends GovernedReviewConflictError {
  constructor(input: { currentState: string; currentVersion: number }) {
    super(
      "governed_review_stream_conflict",
      "The governed review stream changed before this action was committed",
      input
    );
    this.name = "GovernedReviewStreamConflictError";
  }
}

export class GovernedReviewIdempotencyConflictError extends GovernedReviewConflictError {
  constructor() {
    super(
      "governed_review_idempotency_conflict",
      "This idempotency key was already used for a different governed review request"
    );
    this.name = "GovernedReviewIdempotencyConflictError";
  }
}

export class GovernedReviewTransitionConflictError extends GovernedReviewConflictError {
  constructor(input: { currentState: string; attemptedAction: string }) {
    super(
      "governed_review_transition_conflict",
      `Governed review action ${input.attemptedAction} is not valid from ${input.currentState}`,
      input
    );
    this.name = "GovernedReviewTransitionConflictError";
  }
}

export class GovernedReviewSealedOverlapError extends GovernedReviewConflictError {
  constructor() {
    super(
      "sealed_overlap",
      "A sealed intake input overlaps evidence outside its one eligible protected lineage"
    );
    this.name = "GovernedReviewSealedOverlapError";
  }
}

export class GovernedReviewSeparationUnknownError extends GovernedReviewConflictError {
  constructor() {
    super(
      "sealed_separation_unknown",
      "Sealed separation of duties could not be established from recorded capability evidence"
    );
    this.name = "GovernedReviewSeparationUnknownError";
  }
}

export class GovernedReviewSeparationIneligibleError extends GovernedReviewConflictError {
  constructor() {
    super(
      "sealed_separation_ineligible",
      "A sealed review participant has a disqualifying evaluator-development capability or exposure"
    );
    this.name = "GovernedReviewSeparationIneligibleError";
  }
}

export class GovernedReviewLabelAlreadyRevealedError extends GovernedReviewConflictError {
  constructor() {
    super(
      "label_already_revealed",
      "A governed label cannot be withdrawn after it has been revealed to another actor"
    );
    this.name = "GovernedReviewLabelAlreadyRevealedError";
  }
}

export class GovernedReviewBodyTooLargeError extends GovernedReviewDomainError {
  constructor(maxBytes: number) {
    super(
      `Governed review request exceeds ${maxBytes} bytes`,
      "governed_review_body_too_large",
      413,
      { maxBytes }
    );
    this.name = "GovernedReviewBodyTooLargeError";
  }
}

export class GovernedReviewIntegrityError extends GovernedReviewDomainError {
  constructor(message = "Stored governed review evidence failed integrity verification") {
    super(message, "governed_review_integrity_error", 500);
    this.name = "GovernedReviewIntegrityError";
  }
}

export class GovernedImportedTruthVerificationUnavailableError extends GovernedReviewDomainError {
  constructor() {
    super(
      "Verified imported truth requires a configured server-side verifier; caller evidence is not sufficient",
      "imported_truth_verification_unavailable",
      422
    );
    this.name = "GovernedImportedTruthVerificationUnavailableError";
  }
}
