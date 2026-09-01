import { createHash } from "node:crypto";
import type { SkillVersion } from "@coeval/shared";
import type { PoolClient } from "pg";

export async function insertSkillVersion(
  client: PoolClient,
  version: SkillVersion,
  projectId: string,
  criterionVersionId: string,
  actorUserId: string | null,
  onboardingRequest?: { idempotencyKey: string; requestDigest: string }
): Promise<void> {
  const developerSubjectId = actorUserId
    ? await getOrCreateGovernedReviewerSubject(client, projectId, actorUserId)
    : null;
  const recordedActorUserId = developerSubjectId ? actorUserId : null;
  await client.query(
    `insert into skill_versions
       (id, skill_id, project_id, version, status, rubric_markdown, prompt, output_schema, model_binding,
        golden_set_agreement, too_strict_count, too_lenient_count, ambiguous_count, known_limitations,
        verdict_kind, scalar_range, categorical_choice_scores, rubric_provenance,
        regression_dataset_revision_id, created_at, approved_at, criterion_version_id,
        created_by_user_id, created_by_subject_id, developer_identity_status,
        onboarding_idempotency_key, onboarding_request_digest, onboarding_assurance)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
    [
      version.id,
      version.skillId,
      projectId,
      version.version,
      version.status,
      version.rubricMarkdown,
      version.prompt,
      JSON.stringify(version.outputSchema),
      JSON.stringify(version.modelBinding),
      version.goldenSetAgreement,
      version.tooStrictCount,
      version.tooLenientCount,
      version.ambiguousCount,
      version.knownLimitations,
      version.verdictKind,
      version.scalarRange === null ? null : JSON.stringify(version.scalarRange),
      version.categoricalChoiceScores === null ? null : JSON.stringify(version.categoricalChoiceScores),
      version.rubricProvenance,
      version.regressionDatasetRevisionId ?? null,
      version.createdAt,
      version.approvedAt,
      criterionVersionId,
      recordedActorUserId,
      developerSubjectId,
      developerSubjectId ? "recorded" : "unknown_legacy",
      onboardingRequest?.idempotencyKey ?? null,
      onboardingRequest?.requestDigest ?? null,
      version.onboardingAssurance ?? null
    ]
  );
}

/**
 * Account links are removable PII; governed evidence uses the durable,
 * project-scoped subject instead. The unique account binding is also the
 * serialization point when two evaluator versions are authored at once.
 */
export async function getOrCreateGovernedReviewerSubject(
  client: PoolClient,
  projectId: string,
  accountUserId: string
): Promise<string | null> {
  // API-key and internal callers may supply an actor string that is not a
  // verified account membership. It cannot become governed identity
  // evidence: keep the version unknown_legacy and let sealed eligibility
  // fail closed.
  const verifiedAccount = await client.query(
    `select 1
       from "user" account
       join project_members membership
         on membership.user_id = account.id and membership.project_id = $1
       where account.id = $2`,
    [projectId, accountUserId]
  );
  if (!verifiedAccount.rowCount) return null;
  const candidateId = `grs_${createHash("sha256")
    .update([projectId, accountUserId].join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, 48)}`;
  await client.query(
    `insert into governed_reviewer_subjects
         (id, project_id, account_user_id, subject_digest)
       values ($1, $2, $3,
         governed_content_v1_digest(
           'governed-reviewer-subject/v1',
           jsonb_build_object('projectId', $2::text, 'subjectId', $1::text)
         )
       )
       on conflict do nothing`,
    [candidateId, projectId, accountUserId]
  );
  const subject = await client.query(
    `select id
       from governed_reviewer_subjects
       where project_id = $1 and account_user_id = $2`,
    [projectId, accountUserId]
  );
  if (!subject.rows[0]?.id) {
    throw new Error("Unable to establish governed evaluator-author subject");
  }
  return String(subject.rows[0].id);
}

export async function nextVersion(client: PoolClient, skillId: string): Promise<string> {
  const result = await client.query(
    `select version from skill_versions where skill_id = $1 order by created_at desc limit 1`,
    [skillId]
  );
  const current = String(result.rows[0]?.version ?? "0.0.0");
  const [major = "0", minor = "0", patch = "0"] = current.split(".");
  return `${major}.${minor}.${Number(patch) + 1}`;
}
