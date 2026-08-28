-- Coeval pre-launch clean-schema baseline.
--
-- Generated from the normalized PostgreSQL 17 schema produced by migrations
-- 0001-0055 at commit 17530fd. ADR-0011 declares pre-launch databases
-- disposable and requires a verified single baseline. This file intentionally
-- contains current DDL only: no historical row backfills, rolling-writer
-- transitions, or application seed data.
--
-- PostgreSQL 17 is the supported development and CI target.
--
-- PostgreSQL database dump
--


-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.11

SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = 0;
SET LOCAL idle_in_transaction_session_timeout = 0;
SET LOCAL transaction_timeout = 0;
SET LOCAL client_encoding = 'UTF8';
SET LOCAL standard_conforming_strings = on;
SET LOCAL check_function_bodies = false;
SET LOCAL xmloption = content;
SET LOCAL client_min_messages = warning;
SET LOCAL row_security = off;

--
-- Objects install into the migration session's active schema.
--



--
-- Name: analysis_actor_has_role_v1(text, text, text, text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_actor_has_role_v1(project_id_value text, user_id_value text, subject_id_value text, role_value text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  select exists (
    select 1
    from governed_reviewer_subjects subject
    join project_members membership
      on membership.project_id = subject.project_id
     and membership.user_id = subject.account_user_id
    where subject.id = subject_id_value
      and subject.project_id = project_id_value
      and subject.account_user_id = user_id_value
      and (
        (role_value = 'owner' and membership.role = 'owner')
        or (role_value = 'member' and membership.role in ('owner','member'))
      )
  )
$$;


--
-- Name: analysis_actor_role_exact_v1(text, text, text, text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_actor_role_exact_v1(project_id_value text, user_id_value text, subject_id_value text, role_value text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  select exists (
    select 1
    from governed_reviewer_subjects subject
    join project_members membership
      on membership.project_id = subject.project_id
     and membership.user_id = subject.account_user_id
    where subject.id = subject_id_value
      and subject.project_id = project_id_value
      and subject.account_user_id = user_id_value
      and membership.role = role_value
      and role_value in ('owner','member')
  )
$$;


SET LOCAL default_tablespace = '';

SET LOCAL default_table_access_method = heap;

--
-- Name: analysis_observation_assignment_events; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE analysis_observation_assignment_events (
    id text NOT NULL,
    project_id text NOT NULL,
    study_id text NOT NULL,
    study_item_id text NOT NULL,
    observation_event_id text NOT NULL,
    version bigint NOT NULL,
    predecessor_event_id text,
    predecessor_event_digest text,
    event_type text NOT NULL,
    taxonomy_id text NOT NULL,
    taxonomy_revision_id text NOT NULL,
    taxonomy_revision_sequence integer NOT NULL,
    code_id text,
    rationale text NOT NULL,
    actor_subject_id text NOT NULL,
    actor_user_id text NOT NULL,
    actor_role text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    event_digest text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_observation_assignmen_taxonomy_revision_sequence_check CHECK (((taxonomy_revision_sequence > 0) AND (taxonomy_revision_sequence <= 10000))),
    CONSTRAINT analysis_observation_assignment__predecessor_event_digest_check CHECK (((predecessor_event_digest IS NULL) OR (predecessor_event_digest ~ '^sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT analysis_observation_assignment_events_actor_role_check CHECK ((actor_role = ANY (ARRAY['owner'::text, 'member'::text]))),
    CONSTRAINT analysis_observation_assignment_events_check CHECK (((predecessor_event_id IS NULL) = (predecessor_event_digest IS NULL))),
    CONSTRAINT analysis_observation_assignment_events_check1 CHECK (((event_type = 'withdrawn'::text) = (code_id IS NULL))),
    CONSTRAINT analysis_observation_assignment_events_event_digest_check CHECK ((event_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_observation_assignment_events_event_type_check CHECK ((event_type = ANY (ARRAY['assigned'::text, 'withdrawn'::text]))),
    CONSTRAINT analysis_observation_assignment_events_idempotency_key_check CHECK (((length(idempotency_key) > 0) AND (idempotency_key = TRIM(BOTH FROM idempotency_key)) AND (char_length(idempotency_key) <= 240))),
    CONSTRAINT analysis_observation_assignment_events_rationale_check CHECK (((length(rationale) > 0) AND (rationale = TRIM(BOTH FROM rationale)) AND (char_length(rationale) <= 5000))),
    CONSTRAINT analysis_observation_assignment_events_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_observation_assignment_events_version_check CHECK ((version > 0))
);


--
-- Name: analysis_assignment_event_digest_v1(analysis_observation_assignment_events); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_assignment_event_digest_v1(value analysis_observation_assignment_events) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'actorRole', value.actor_role,
    'actorSubjectId', value.actor_subject_id,
    'actorUserId', value.actor_user_id,
    'basis', 'analysis-observation-assignment/v1',
    'codeId', value.code_id,
    'eventType', value.event_type,
    'id', value.id,
    'idempotencyKey', value.idempotency_key,
    'observationEventId', value.observation_event_id,
    'occurredAt', analysis_timestamp_v1(value.occurred_at),
    'predecessorEventDigest', value.predecessor_event_digest,
    'predecessorEventId', value.predecessor_event_id,
    'projectId', value.project_id,
    'rationale', value.rationale,
    'requestDigest', value.request_digest,
    'studyId', value.study_id,
    'studyItemId', value.study_item_id,
    'taxonomyId', value.taxonomy_id,
    'taxonomyRevisionId', value.taxonomy_revision_id,
    'taxonomyRevisionSequence', value.taxonomy_revision_sequence,
    'version', value.version::text
  ))
$$;


--
-- Name: analysis_assignment_request_digest_v1(analysis_observation_assignment_events); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_assignment_request_digest_v1(value analysis_observation_assignment_events) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-observation-assignment-request/v1',
    'codeId', value.code_id,
    'eventType', value.event_type,
    'expectedPredecessorEventDigest', value.predecessor_event_digest,
    'expectedPredecessorEventId', value.predecessor_event_id,
    'expectedVersion', (value.version - 1)::text,
    'observationEventId', value.observation_event_id,
    'rationale', value.rationale,
    'taxonomyRevisionId', value.taxonomy_revision_id
  ))
$$;


--
-- Name: analysis_clear_deadline_retry_v1(text, text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_clear_deadline_retry_v1(project_id_value text, study_id_value text) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
declare
  removed_count integer;
begin
  if not exists (
    select 1 from analysis_studies study
    where study.project_id = project_id_value and study.id = study_id_value
  ) then
    return false;
  end if;
  perform analysis_study_lock_v1(study_id_value);
  delete from analysis_study_deadline_retry_state row_value
  where row_value.project_id = project_id_value
    and row_value.study_id = study_id_value;
  get diagnostics removed_count = row_count;
  return removed_count = 1;
end;
$$;


--
-- Name: analysis_criterion_promotions; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE analysis_criterion_promotions (
    id text NOT NULL,
    project_id text NOT NULL,
    contract_version text NOT NULL,
    study_id text NOT NULL,
    study_closure_id text NOT NULL,
    study_closure_digest text NOT NULL,
    population_id text NOT NULL,
    draw_id text NOT NULL,
    source_dataset_revision_id text NOT NULL,
    source_dataset_revision_content_digest text NOT NULL,
    source_dataset_revision_digest text NOT NULL,
    taxonomy_id text NOT NULL,
    taxonomy_revision_id text NOT NULL,
    taxonomy_revision_sequence integer NOT NULL,
    taxonomy_revision_digest text NOT NULL,
    code_id text NOT NULL,
    code_entry_id text NOT NULL,
    code_entry_digest text NOT NULL,
    code_label text NOT NULL,
    code_definition text NOT NULL,
    criterion_id text NOT NULL,
    criterion_version_id text NOT NULL,
    criterion_stable_key text NOT NULL,
    criterion_name text NOT NULL,
    criterion_definition text NOT NULL,
    criterion_digest text NOT NULL,
    rationale text NOT NULL,
    support_count integer NOT NULL,
    support_set_digest text NOT NULL,
    criterion_authoring_exposure_event_id text NOT NULL,
    promoted_by_user_id text NOT NULL,
    promoted_by_subject_id text NOT NULL,
    promoter_role text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    content_digest text NOT NULL,
    handoff_version text NOT NULL,
    handoff_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_criterion_promotion_source_dataset_revision_cont_check CHECK ((source_dataset_revision_content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_criterion_promotion_source_dataset_revision_dige_check CHECK ((source_dataset_revision_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_criterion_promotions_code_definition_check CHECK (((length(code_definition) > 0) AND (code_definition = TRIM(BOTH FROM code_definition)) AND (char_length(code_definition) <= 5000))),
    CONSTRAINT analysis_criterion_promotions_code_entry_digest_check CHECK ((code_entry_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_criterion_promotions_code_label_check CHECK (((length(code_label) > 0) AND (code_label = TRIM(BOTH FROM code_label)) AND (char_length(code_label) <= 500))),
    CONSTRAINT analysis_criterion_promotions_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_criterion_promotions_contract_version_check CHECK ((contract_version = 'analysis-criterion-promotion/v1'::text)),
    CONSTRAINT analysis_criterion_promotions_criterion_definition_check CHECK (((length(criterion_definition) > 0) AND (criterion_definition = TRIM(BOTH FROM criterion_definition)) AND (char_length(criterion_definition) <= 20000))),
    CONSTRAINT analysis_criterion_promotions_criterion_digest_check CHECK ((criterion_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_criterion_promotions_criterion_name_check CHECK (((length(criterion_name) > 0) AND (criterion_name = TRIM(BOTH FROM criterion_name)) AND (char_length(criterion_name) <= 200))),
    CONSTRAINT analysis_criterion_promotions_criterion_stable_key_check CHECK (((length(criterion_stable_key) > 0) AND (criterion_stable_key = TRIM(BOTH FROM criterion_stable_key)) AND (char_length(criterion_stable_key) <= 200))),
    CONSTRAINT analysis_criterion_promotions_handoff_digest_check CHECK ((handoff_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_criterion_promotions_handoff_version_check CHECK ((handoff_version = 'analysis-criterion-promotion-handoff/v1'::text)),
    CONSTRAINT analysis_criterion_promotions_idempotency_key_check CHECK (((length(idempotency_key) > 0) AND (idempotency_key = TRIM(BOTH FROM idempotency_key)) AND (char_length(idempotency_key) <= 240))),
    CONSTRAINT analysis_criterion_promotions_promoter_role_check CHECK ((promoter_role = 'owner'::text)),
    CONSTRAINT analysis_criterion_promotions_rationale_check CHECK (((length(rationale) > 0) AND (rationale = TRIM(BOTH FROM rationale)) AND (char_length(rationale) <= 5000))),
    CONSTRAINT analysis_criterion_promotions_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_criterion_promotions_study_closure_digest_check CHECK ((study_closure_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_criterion_promotions_support_count_check CHECK (((support_count > 0) AND (support_count <= 1000))),
    CONSTRAINT analysis_criterion_promotions_support_set_digest_check CHECK ((support_set_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_criterion_promotions_taxonomy_revision_digest_check CHECK ((taxonomy_revision_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_criterion_promotions_taxonomy_revision_sequence_check CHECK (((taxonomy_revision_sequence > 0) AND (taxonomy_revision_sequence <= 10000)))
);


--
-- Name: analysis_criterion_authoring_exposure_details_v1(analysis_criterion_promotions); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_criterion_authoring_exposure_details_v1(value analysis_criterion_promotions) RETURNS jsonb
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select jsonb_build_object(
    'codeId', value.code_id,
    'contract', 'coeval/analysis-criterion-promotion-exposure/v1',
    'criterionId', value.criterion_id,
    'criterionVersionId', value.criterion_version_id,
    'promotionId', value.id,
    'studyClosureId', value.study_closure_id,
    'studyId', value.study_id,
    'taxonomyId', value.taxonomy_id,
    'taxonomyRevisionId', value.taxonomy_revision_id
  )
$$;


--
-- Name: analysis_criterion_promotion_content_digest_v1(analysis_criterion_promotions); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_criterion_promotion_content_digest_v1(value analysis_criterion_promotions) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-criterion-promotion-content/v1',
    'codeDefinition', value.code_definition,
    'codeEntryDigest', value.code_entry_digest,
    'codeEntryId', value.code_entry_id,
    'codeId', value.code_id,
    'codeLabel', value.code_label,
    'contractVersion', value.contract_version,
    'criterionAuthoringExposureEventId', value.criterion_authoring_exposure_event_id,
    'criterionDefinition', value.criterion_definition,
    'criterionDigest', value.criterion_digest,
    'criterionId', value.criterion_id,
    'criterionName', value.criterion_name,
    'criterionStableKey', value.criterion_stable_key,
    'criterionVersionId', value.criterion_version_id,
    'drawId', value.draw_id,
    'handoffDigest', value.handoff_digest,
    'handoffVersion', value.handoff_version,
    'populationId', value.population_id,
    'projectId', value.project_id,
    'promotedBySubjectId', value.promoted_by_subject_id,
    'rationale', value.rationale,
    'sourceDatasetRevisionContentDigest', value.source_dataset_revision_content_digest,
    'sourceDatasetRevisionDigest', value.source_dataset_revision_digest,
    'sourceDatasetRevisionId', value.source_dataset_revision_id,
    'studyClosureDigest', value.study_closure_digest,
    'studyClosureId', value.study_closure_id,
    'studyId', value.study_id,
    'supportCount', value.support_count,
    'supportSetDigest', value.support_set_digest,
    'taxonomyId', value.taxonomy_id,
    'taxonomyRevisionDigest', value.taxonomy_revision_digest,
    'taxonomyRevisionId', value.taxonomy_revision_id,
    'taxonomyRevisionSequence', value.taxonomy_revision_sequence
  ))
$$;


--
-- Name: analysis_criterion_promotion_handoff_digest_v1(analysis_criterion_promotions); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_criterion_promotion_handoff_digest_v1(value analysis_criterion_promotions) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-criterion-promotion-handoff/v1',
    'createsEvaluator', false,
    'createsTruth', false,
    'criterionDigest', value.criterion_digest,
    'criterionId', value.criterion_id,
    'criterionVersionId', value.criterion_version_id,
    'evidenceClass', 'development_authoring_not_truth',
    'handoffVersion', value.handoff_version,
    'projectId', value.project_id,
    'promotionId', value.id,
    'roleIntent', 'analysis_authoring',
    'sourceDatasetRevisionContentDigest', value.source_dataset_revision_content_digest,
    'sourceDatasetRevisionDigest', value.source_dataset_revision_digest,
    'sourceDatasetRevisionId', value.source_dataset_revision_id,
    'sourceKind', 'analysis_promotion_handoff'
  ))
$$;


--
-- Name: analysis_criterion_promotion_request_digest_v1(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_criterion_promotion_request_digest_v1(promotion_id_value text) RETURNS text
    LANGUAGE sql STABLE STRICT
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-criterion-promotion-request/v1',
    'codeId', promotion.code_id,
    'criterionDefinition', promotion.criterion_definition,
    'criterionName', promotion.criterion_name,
    'expectedClosureDigest', promotion.study_closure_digest,
    'expectedClosureId', promotion.study_closure_id,
    'expectedCodeEntryDigest', promotion.code_entry_digest,
    'expectedTaxonomyRevisionDigest', promotion.taxonomy_revision_digest,
    'projectId', promotion.project_id,
    'rationale', promotion.rationale,
    'studyId', promotion.study_id,
    'supportingObservations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'assignmentEventDigest', support.assignment_event_digest,
        'assignmentEventId', support.assignment_event_id,
        'closureItemDigest', support.closure_item_digest,
        'closureItemId', support.closure_item_id,
        'observationEventDigest', support.observation_event_digest,
        'observationEventId', support.observation_event_id,
        'studyItemId', support.study_item_id
      ) order by support.position)
      from analysis_criterion_promotion_supports support
      where support.promotion_id = promotion.id
    ), '[]'::jsonb),
    'taxonomyId', promotion.taxonomy_id,
    'taxonomyRevisionId', promotion.taxonomy_revision_id
  ))
  from analysis_criterion_promotions promotion
  where promotion.id = promotion_id_value
$$;


--
-- Name: analysis_criterion_promotion_supports; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE analysis_criterion_promotion_supports (
    id text NOT NULL,
    project_id text NOT NULL,
    promotion_id text NOT NULL,
    "position" integer NOT NULL,
    study_id text NOT NULL,
    study_item_id text NOT NULL,
    closure_id text NOT NULL,
    closure_item_id text NOT NULL,
    closure_item_digest text NOT NULL,
    source_dataset_revision_id text NOT NULL,
    source_dataset_revision_item_id text NOT NULL,
    source_item_digest text NOT NULL,
    observation_event_id text NOT NULL,
    observation_event_digest text NOT NULL,
    assignment_event_id text NOT NULL,
    assignment_event_digest text NOT NULL,
    observation_author_user_id text NOT NULL,
    observation_author_subject_id text NOT NULL,
    example_selection_exposure_event_id text NOT NULL,
    content_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_criterion_promotion_sup_observation_event_digest_check CHECK ((observation_event_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_criterion_promotion_supp_assignment_event_digest_check CHECK ((assignment_event_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_criterion_promotion_supports_closure_item_digest_check CHECK ((closure_item_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_criterion_promotion_supports_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_criterion_promotion_supports_position_check CHECK ((("position" >= 0) AND ("position" < 1000))),
    CONSTRAINT analysis_criterion_promotion_supports_source_item_digest_check CHECK ((source_item_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: analysis_criterion_promotion_support_digest_v1(analysis_criterion_promotion_supports); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_criterion_promotion_support_digest_v1(value analysis_criterion_promotion_supports) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'assignmentEventDigest', value.assignment_event_digest,
    'assignmentEventId', value.assignment_event_id,
    'basis', 'analysis-criterion-promotion-support/v1',
    'closureId', value.closure_id,
    'closureItemDigest', value.closure_item_digest,
    'closureItemId', value.closure_item_id,
    'exampleSelectionExposureEventId', value.example_selection_exposure_event_id,
    'observationAuthorSubjectId', value.observation_author_subject_id,
    'observationEventDigest', value.observation_event_digest,
    'observationEventId', value.observation_event_id,
    'position', value.position,
    'promotionId', value.promotion_id,
    'sourceDatasetRevisionId', value.source_dataset_revision_id,
    'sourceDatasetRevisionItemId', value.source_dataset_revision_item_id,
    'sourceItemDigest', value.source_item_digest,
    'studyId', value.study_id,
    'studyItemId', value.study_item_id
  ))
$$;


--
-- Name: analysis_criterion_promotion_support_set_digest_v1(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_criterion_promotion_support_set_digest_v1(promotion_id_value text) RETURNS text
    LANGUAGE sql STABLE STRICT
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-criterion-promotion-support-set/v1',
    'promotionId', promotion_id_value,
    'supports', coalesce((
      select jsonb_agg(jsonb_build_object(
        'contentDigest', support.content_digest,
        'position', support.position,
        'supportId', support.id
      ) order by support.position)
      from analysis_criterion_promotion_supports support
      where support.promotion_id = promotion_id_value
    ), '[]'::jsonb)
  ))
$$;


--
-- Name: analysis_criterion_support_exposure_details_v1(analysis_criterion_promotions, analysis_criterion_promotion_supports); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_criterion_support_exposure_details_v1(promotion analysis_criterion_promotions, support analysis_criterion_promotion_supports) RETURNS jsonb
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select jsonb_build_object(
    'assignmentEventId', support.assignment_event_id,
    'closureItemId', support.closure_item_id,
    'contract', 'coeval/analysis-criterion-promotion-support-exposure/v1',
    'criterionId', promotion.criterion_id,
    'criterionVersionId', promotion.criterion_version_id,
    'observationEventId', support.observation_event_id,
    'promotionId', promotion.id,
    'promotionSupportId', support.id,
    'studyId', support.study_id,
    'studyItemId', support.study_item_id
  )
$$;


--
-- Name: analysis_dataset_revision_content_digest_v1(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_dataset_revision_content_digest_v1(population_id_value text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'dataset-revision-content/v1',
    'inputIdentityBasis', 'input-identity/v1',
    'itemDigests', coalesce(jsonb_agg(to_jsonb(member.item_digest) order by member.item_digest), '[]'::jsonb)
  ))
  from analysis_population_members member
  where member.population_id = population_id_value
$$;


--
-- Name: analysis_dataset_revision_digest_v1(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_dataset_revision_digest_v1(population_id_value text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'dataset-revision/v1',
    'inputIdentityBasis', 'input-identity/v1',
    'itemDigests', coalesce(jsonb_agg(to_jsonb(member.item_digest) order by member.item_digest), '[]'::jsonb),
    'role', 'analysis_authoring'
  ))
  from analysis_population_members member
  where member.population_id = population_id_value
$$;


--
-- Name: analysis_dataset_revision_item_digest_v1(text, jsonb, jsonb); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_dataset_revision_item_digest_v1(input_digest_value text, payload_snapshot_value jsonb, reference_provenance_value jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'dataset-revision-item/v1',
    'expectedFailStep', null,
    'inputIdentity', jsonb_build_object(
      'basis', 'input-identity/v1',
      'digest', input_digest_value
    ),
    'note', null,
    'redactedPayload', payload_snapshot_value,
    'referenceLabel', null,
    'reviewProvenance', reference_provenance_value
  ))
$$;


--
-- Name: analysis_failure_codes; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE analysis_failure_codes (
    id text NOT NULL,
    project_id text NOT NULL,
    taxonomy_id text NOT NULL,
    created_in_revision_id text NOT NULL,
    client_token text NOT NULL,
    content_digest text NOT NULL,
    created_by_user_id text NOT NULL,
    created_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_failure_codes_client_token_check CHECK (((length(client_token) > 0) AND (client_token = TRIM(BOTH FROM client_token)) AND (char_length(client_token) <= 120))),
    CONSTRAINT analysis_failure_codes_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: analysis_failure_code_content_digest_v1(analysis_failure_codes); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_failure_code_content_digest_v1(value analysis_failure_codes) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-taxonomy-code/v1',
    'codeId', value.id,
    'createdInRevisionId', value.created_in_revision_id,
    'projectId', value.project_id,
    'taxonomyId', value.taxonomy_id
  ))
$$;


--
-- Name: governed_canonical_json_v1(jsonb); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION governed_canonical_json_v1(value jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select case jsonb_typeof(value)
    when 'object' then coalesce((
      select '{' || string_agg(
        to_jsonb(entry.key)::text || ':' || governed_canonical_json_v1(entry.value),
        ',' order by governed_utf16_sort_key_v1(entry.key)
      ) || '}'
      from jsonb_each(value) entry
    ), '{}')
    when 'array' then coalesce((
      select '[' || string_agg(
        governed_canonical_json_v1(entry.value),
        ',' order by entry.ordinality
      ) || ']'
      from jsonb_array_elements(value) with ordinality entry(value, ordinality)
    ), '[]')
    when 'string' then to_jsonb(value #>> '{}')::text
    when 'number' then trim_scale((value #>> '{}')::numeric)::text
    else value::text
  end
$$;


--
-- Name: analysis_failure_taxonomies; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE analysis_failure_taxonomies (
    id text NOT NULL,
    project_id text NOT NULL,
    contract_version text NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    idempotency_key text NOT NULL,
    request_payload jsonb NOT NULL,
    request_digest text NOT NULL,
    content_digest text NOT NULL,
    created_by_user_id text NOT NULL,
    created_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_failure_taxonomies_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_failure_taxonomies_contract_version_check CHECK ((contract_version = 'analysis-taxonomy/v1'::text)),
    CONSTRAINT analysis_failure_taxonomies_description_check CHECK (((length(description) > 0) AND (description = TRIM(BOTH FROM description)) AND (char_length(description) <= 5000))),
    CONSTRAINT analysis_failure_taxonomies_idempotency_key_check CHECK (((length(idempotency_key) > 0) AND (idempotency_key = TRIM(BOTH FROM idempotency_key)) AND (char_length(idempotency_key) <= 240))),
    CONSTRAINT analysis_failure_taxonomies_name_check CHECK (((length(name) > 0) AND (name = TRIM(BOTH FROM name)) AND (char_length(name) <= 240))),
    CONSTRAINT analysis_failure_taxonomies_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_failure_taxonomies_request_payload_check CHECK (((jsonb_typeof(request_payload) = 'object'::text) AND (octet_length(governed_canonical_json_v1(request_payload)) <= 8388608)))
);


--
-- Name: analysis_failure_taxonomy_content_digest_v1(analysis_failure_taxonomies); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_failure_taxonomy_content_digest_v1(value analysis_failure_taxonomies) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-taxonomy-content/v1',
    'contractVersion', value.contract_version,
    'description', value.description,
    'name', value.name,
    'projectId', value.project_id
  ))
$$;


--
-- Name: analysis_linearization_clock_v1(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_linearization_clock_v1() RETURNS timestamp with time zone
    LANGUAGE sql
    AS $$
  select date_trunc('milliseconds', clock_timestamp())
$$;


--
-- Name: analysis_observation_assignment_head_v1(text, integer); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_observation_assignment_head_v1(observation_event_id_value text, maximum_revision_sequence_value integer DEFAULT NULL::integer) RETURNS TABLE(assignment_event_id text, assignment_event_digest text, assignment_event_type text, taxonomy_id text, taxonomy_revision_id text, taxonomy_revision_sequence integer, code_id text, version bigint)
    LANGUAGE sql STABLE
    AS $$
  select event.id, event.event_digest, event.event_type, event.taxonomy_id,
         event.taxonomy_revision_id, event.taxonomy_revision_sequence,
         event.code_id, event.version
  from analysis_observation_assignment_events event
  where event.observation_event_id = observation_event_id_value
    and (maximum_revision_sequence_value is null
      or event.taxonomy_revision_sequence <= maximum_revision_sequence_value)
  order by event.version desc
  limit 1
$$;


--
-- Name: analysis_population_content_digest_v1(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_population_content_digest_v1(population_id_value text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-population-content/v1',
    'itemDigests', coalesce(jsonb_agg(to_jsonb(member.item_digest) order by member.position), '[]'::jsonb)
  ))
  from analysis_population_members member
  where member.population_id = population_id_value
$$;


--
-- Name: analysis_population_draw_content_digest_v1(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_population_draw_content_digest_v1(draw_id_value text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-population-draw-content/v1',
    'drawItemContentDigests', coalesce(jsonb_agg(to_jsonb(item.content_digest) order by item.position), '[]'::jsonb)
  ))
  from analysis_population_draw_items item
  where item.draw_id = draw_id_value
$$;


--
-- Name: analysis_population_draw_digest_v1(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_population_draw_digest_v1(draw_id_value text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'algorithmVersion', draw.algorithm_version,
    'basis', 'coeval-analysis-draw/v1',
    'contentDigest', draw.content_digest,
    'datasetRevisionId', draw.dataset_revision_id,
    'drawExecutor', draw.draw_executor,
    'drawItemContentDigests', coalesce((
      select jsonb_agg(to_jsonb(item.content_digest) order by item.position)
      from analysis_population_draw_items item
      where item.draw_id = draw.id
    ), '[]'::jsonb),
    'fixedBudget', draw.fixed_budget,
    'frameDigest', population.frame_digest,
    'inclusionProbability', jsonb_build_object(
      'denominator', draw.inclusion_denominator,
      'numerator', draw.inclusion_numerator
    ),
    'method', draw.method,
    'populationId', draw.population_id,
    'populationSize', draw.population_size,
    'rngVersion', draw.rng_version,
    'seed', draw.seed,
    'stoppingRule', draw.stopping_rule
  ))
  from analysis_population_draws draw
  join analysis_populations population on population.id = draw.population_id
  where draw.id = draw_id_value
$$;


--
-- Name: analysis_population_frame_digest_v1(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_population_frame_digest_v1(population_id_value text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-population-frame/v1',
    'canonicalizationVersion', population.canonicalization_version,
    'eligibleIngestionPurposes', to_jsonb(population.eligible_ingestion_purposes),
    'eligibleSources', to_jsonb(population.eligible_sources),
    'frameMemberDigests', coalesce((
      select jsonb_agg(to_jsonb(member.frame_member_digest) order by member.position)
      from analysis_population_members member
      where member.population_id = population.id
    ), '[]'::jsonb),
    'orderingVersion', population.ordering_version,
    'projectId', population.project_id,
    'windowEnd', analysis_timestamp_v1(population.window_end),
    'windowStart', analysis_timestamp_v1(population.window_start)
  ))
  from analysis_populations population
  where population.id = population_id_value
$$;


--
-- Name: analysis_recomputed_population_frame_digest_v1(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_recomputed_population_frame_digest_v1(population_id_value text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  with population as (
    select row_value.* from analysis_populations row_value
    where row_value.id = population_id_value
  ), eligible as (
    select case_row.*,
           row_number() over (order by case_row.created_at, case_row.id) - 1 as position,
           raw.id as retained_raw_trace_id,
           raw.source_trace_id,
           identity.input_digest,
           identity.identity_count,
           claim.usage_class
    from population
    join cases case_row
      on case_row.project_id = population.project_id
     and case_row.created_at >= population.window_start
     and case_row.created_at < population.window_end
     and (
       (case_row.case_type = 'manual' and case_row.ingestion_purpose = 'analysis_eligible_manual')
       or (case_row.case_type = 'langsmith' and case_row.ingestion_purpose = 'analysis_eligible_langsmith')
       or (case_row.case_type = 'langfuse' and case_row.ingestion_purpose = 'analysis_eligible_langfuse')
       or (case_row.case_type = 'ironside' and case_row.ingestion_purpose = 'analysis_eligible_ironside')
     )
    left join raw_traces raw
      on raw.id = case_row.raw_trace_id
     and raw.project_id = case_row.project_id
    left join lateral (
      select identity_value.input_digest,
             count(*) over() as identity_count
      from case_input_identity_records identity_value
      where identity_value.project_id = case_row.project_id
        and identity_value.source_case_id = case_row.id
        and identity_value.identity_basis = 'input-identity/v1'
        and identity_value.record_kind in ('authoring_import','identity_resolved')
        and identity_value.input_digest is not null
      order by case when identity_value.record_kind = 'authoring_import' then 0 else 1 end,
               identity_value.created_at, identity_value.id
      limit 1
    ) identity on true
    left join governed_input_identity_claims claim
      on claim.project_id = case_row.project_id
     and claim.input_digest = identity.input_digest
  ), members as (
    select eligible.*,
           analysis_dataset_revision_item_digest_v1(
             eligible.input_digest,
             eligible.normalized_payload,
             jsonb_build_object(
               'actorUserIds', '[]'::jsonb,
               'basis', 'Analysis population member; no reference label.',
               'kind', 'unlabeled',
               'sourceId', eligible.id,
               'verdictIds', '[]'::jsonb
             )
           ) item_digest
    from eligible
  ), frame_members as (
    select members.*,
           analysis_sha256_v1(jsonb_build_object(
             'basis', 'analysis-population-frame-member/v1',
             'caseId', members.id,
             'ingestionTime', analysis_timestamp_v1(members.created_at),
             'inputDigest', members.input_digest,
             'itemDigest', members.item_digest,
             'position', members.position
           )) frame_member_digest
    from members
    where members.retained_raw_trace_id is not null
      and members.source_trace_id is not null
      and members.input_digest is not null
      and members.identity_count = 1
      and members.usage_class = 'nonsealed'
  )
  select case
    when exists (
      select 1 from eligible
      where retained_raw_trace_id is null or source_trace_id is null
         or input_digest is null or identity_count <> 1
         or usage_class is distinct from 'nonsealed'
    ) or exists (
      select 1
      from analysis_population_members frozen_member
      where frozen_member.population_id = population.id
        and not exists (
          select 1 from eligible current_member
          where current_member.id = frozen_member.case_id
            and current_member.retained_raw_trace_id = frozen_member.raw_trace_id
            and current_member.source_trace_id = frozen_member.source_trace_id
            and current_member.input_digest = frozen_member.input_digest
            and current_member.identity_count = 1
            and current_member.usage_class = 'nonsealed'
        )
    ) then null
    else analysis_sha256_v1(jsonb_build_object(
      'basis', 'analysis-population-frame/v1',
      'canonicalizationVersion', population.canonicalization_version,
      'eligibleIngestionPurposes', to_jsonb(population.eligible_ingestion_purposes),
      'eligibleSources', to_jsonb(population.eligible_sources),
      'frameMemberDigests', coalesce((
        select jsonb_agg(to_jsonb(frame_member.frame_member_digest)
                         order by frame_member.position)
        from frame_members frame_member
      ), '[]'::jsonb),
      'orderingVersion', population.ordering_version,
      'projectId', population.project_id,
      'windowEnd', analysis_timestamp_v1(population.window_end),
      'windowStart', analysis_timestamp_v1(population.window_start)
    ))
  end
  from population
$$;


--
-- Name: analysis_study_deadline_retry_state; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE analysis_study_deadline_retry_state (
    study_id text NOT NULL,
    project_id text NOT NULL,
    failure_count integer NOT NULL,
    last_error_code text NOT NULL,
    last_failed_at timestamp with time zone NOT NULL,
    next_retry_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT analysis_study_deadline_retry_state_check CHECK ((updated_at = last_failed_at)),
    CONSTRAINT analysis_study_deadline_retry_state_check1 CHECK ((next_retry_at > last_failed_at)),
    CONSTRAINT analysis_study_deadline_retry_state_check2 CHECK ((next_retry_at <= (last_failed_at + '01:00:00'::interval))),
    CONSTRAINT analysis_study_deadline_retry_state_failure_count_check CHECK (((failure_count >= 1) AND (failure_count <= 1000000))),
    CONSTRAINT analysis_study_deadline_retry_state_last_error_code_check CHECK ((last_error_code = 'closure_failed'::text))
);


--
-- Name: analysis_record_deadline_retry_v1(text, text, text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_record_deadline_retry_v1(project_id_value text, study_id_value text, error_code_value text) RETURNS analysis_study_deadline_retry_state
    LANGUAGE plpgsql
    AS $$
declare
  opened analysis_study_events%rowtype;
  existing analysis_study_deadline_retry_state%rowtype;
  recorded analysis_study_deadline_retry_state%rowtype;
  linearized_at timestamptz;
  next_failure_count integer;
  delay_seconds integer;
begin
  if error_code_value <> 'closure_failed' then
    raise exception 'deadline retry error code is not recognized'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from analysis_studies study
    where study.project_id = project_id_value and study.id = study_id_value
  ) then
    raise exception 'deadline retry state requires an exact project study'
      using errcode = '23514';
  end if;
  perform analysis_study_lock_v1(study_id_value);
  linearized_at := analysis_linearization_clock_v1();
  select event.* into opened
  from analysis_study_events event
  where event.project_id = project_id_value
    and event.study_id = study_id_value
    and event.event_type = 'coding_opened';
  if opened.id is null
     or opened.stopping_rule <> 'server_deadline'
     or opened.close_at > linearized_at
     or analysis_study_state_v1(study_id_value) <> 'coding_open' then
    raise exception 'deadline retry state requires an exact overdue open deadline study'
      using errcode = '23514';
  end if;
  select row_value.* into existing
  from analysis_study_deadline_retry_state row_value
  where row_value.project_id = project_id_value
    and row_value.study_id = study_id_value;
  next_failure_count := least(coalesce(existing.failure_count, 0), 999999) + 1;
  delay_seconds := least(
    3600,
    (5 * power(2::numeric, least(next_failure_count - 1, 10)))::integer
  );
  insert into analysis_study_deadline_retry_state
    (study_id,project_id,failure_count,last_error_code,last_failed_at,next_retry_at,updated_at)
  values (
    study_id_value,project_id_value,next_failure_count,error_code_value,linearized_at,
    linearized_at + make_interval(secs => delay_seconds),linearized_at
  )
  on conflict (study_id) do update
    set failure_count = excluded.failure_count,
        last_error_code = excluded.last_error_code,
        last_failed_at = excluded.last_failed_at,
        next_retry_at = excluded.next_retry_at,
        updated_at = excluded.updated_at
  returning * into recorded;
  return recorded;
end;
$$;


--
-- Name: analysis_sha256_v1(jsonb); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_sha256_v1(value jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select 'sha256:' || encode(sha256(convert_to(governed_canonical_json_v1(value), 'UTF8')), 'hex')
$$;


--
-- Name: analysis_study_closures; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE analysis_study_closures (
    id text NOT NULL,
    project_id text NOT NULL,
    study_id text NOT NULL,
    population_id text NOT NULL,
    draw_id text NOT NULL,
    dataset_revision_id text NOT NULL,
    stopping_rule text NOT NULL,
    close_at timestamp with time zone,
    close_cause text NOT NULL,
    close_actor_user_id text,
    close_actor_subject_id text,
    close_actor_role text NOT NULL,
    close_reason text,
    effective_closed_at timestamp with time zone NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    selected_item_count integer NOT NULL,
    viewed_item_count integer NOT NULL,
    completed_item_count integer NOT NULL,
    view_set_digest text NOT NULL,
    assessment_version text NOT NULL,
    method text NOT NULL,
    frozen_frame_digest text NOT NULL,
    recomputed_frame_digest text,
    frozen_draw_digest text NOT NULL,
    recomputed_draw_digest text,
    method_eligible boolean NOT NULL,
    frame_reproducible boolean NOT NULL,
    draw_complete boolean NOT NULL,
    coding_complete boolean NOT NULL,
    closure_item_count integer NOT NULL,
    drawn_from_population_id text NOT NULL,
    representative_of_population_id text,
    representative_reason text,
    assessment_digest text NOT NULL,
    content_digest text NOT NULL,
    closure_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_study_closures_assessment_digest_check CHECK ((assessment_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_study_closures_assessment_version_check CHECK ((assessment_version = 'representative-assessment-time/v1'::text)),
    CONSTRAINT analysis_study_closures_check CHECK ((viewed_item_count <= selected_item_count)),
    CONSTRAINT analysis_study_closures_check1 CHECK ((completed_item_count <= selected_item_count)),
    CONSTRAINT analysis_study_closures_check2 CHECK ((closure_item_count <= selected_item_count)),
    CONSTRAINT analysis_study_closures_check3 CHECK ((((representative_of_population_id IS NOT NULL) AND (representative_reason IS NULL)) OR ((representative_of_population_id IS NULL) AND (representative_reason IS NOT NULL)))),
    CONSTRAINT analysis_study_closures_check4 CHECK ((((stopping_rule = 'server_deadline'::text) AND (close_cause = 'server_deadline'::text) AND (close_at IS NOT NULL) AND (close_actor_user_id IS NULL) AND (close_actor_subject_id IS NULL) AND (close_actor_role = 'system'::text) AND (close_reason IS NULL) AND (effective_closed_at = close_at) AND (recorded_at >= close_at)) OR ((stopping_rule = 'explicit_owner_close'::text) AND (close_cause = 'explicit_owner_close'::text) AND (close_at IS NULL) AND (close_actor_user_id IS NOT NULL) AND (close_actor_subject_id IS NOT NULL) AND (close_actor_role = 'owner'::text) AND (close_reason IS NOT NULL) AND (effective_closed_at = recorded_at)))),
    CONSTRAINT analysis_study_closures_close_actor_role_check CHECK ((close_actor_role = ANY (ARRAY['owner'::text, 'system'::text]))),
    CONSTRAINT analysis_study_closures_close_cause_check CHECK ((close_cause = ANY (ARRAY['server_deadline'::text, 'explicit_owner_close'::text]))),
    CONSTRAINT analysis_study_closures_close_reason_check CHECK (((close_reason IS NULL) OR ((length(TRIM(BOTH FROM close_reason)) > 0) AND (char_length(close_reason) <= 2000)))),
    CONSTRAINT analysis_study_closures_closure_digest_check CHECK ((closure_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_study_closures_closure_item_count_check CHECK (((closure_item_count > 0) AND (closure_item_count <= 10000))),
    CONSTRAINT analysis_study_closures_completed_item_count_check CHECK ((completed_item_count >= 0)),
    CONSTRAINT analysis_study_closures_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_study_closures_frozen_draw_digest_check CHECK ((frozen_draw_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_study_closures_frozen_frame_digest_check CHECK ((frozen_frame_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_study_closures_method_check CHECK (((length(method) > 0) AND (char_length(method) <= 100))),
    CONSTRAINT analysis_study_closures_recomputed_draw_digest_check CHECK (((recomputed_draw_digest IS NULL) OR (recomputed_draw_digest ~ '^sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT analysis_study_closures_recomputed_frame_digest_check CHECK (((recomputed_frame_digest IS NULL) OR (recomputed_frame_digest ~ '^sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT analysis_study_closures_representative_reason_check CHECK ((representative_reason = ANY (ARRAY['method_not_eligible'::text, 'frame_not_reproducible'::text, 'draw_not_complete'::text, 'coding_not_complete'::text]))),
    CONSTRAINT analysis_study_closures_selected_item_count_check CHECK (((selected_item_count > 0) AND (selected_item_count <= 10000))),
    CONSTRAINT analysis_study_closures_stopping_rule_check CHECK ((stopping_rule = ANY (ARRAY['server_deadline'::text, 'explicit_owner_close'::text]))),
    CONSTRAINT analysis_study_closures_view_set_digest_check CHECK ((view_set_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_study_closures_viewed_item_count_check CHECK ((viewed_item_count >= 0))
);


--
-- Name: analysis_study_assessment_digest_v1(analysis_study_closures); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_study_assessment_digest_v1(value analysis_study_closures) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'assessmentVersion', value.assessment_version,
    'basis', 'representative-assessment-time/v1',
    'codingComplete', value.coding_complete,
    'completedItemCount', value.completed_item_count,
    'drawComplete', value.draw_complete,
    'drawnFromPopulationId', value.drawn_from_population_id,
    'frameReproducible', value.frame_reproducible,
    'frozenDrawDigest', value.frozen_draw_digest,
    'frozenFrameDigest', value.frozen_frame_digest,
    'methodEligible', value.method_eligible,
    'recomputedDrawDigest', value.recomputed_draw_digest,
    'recomputedFrameDigest', value.recomputed_frame_digest,
    'representativeOfPopulationId', value.representative_of_population_id,
    'representativeReason', value.representative_reason,
    'selectedItemCount', value.selected_item_count
  ))
$$;


--
-- Name: analysis_study_closure_content_digest_v1(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_study_closure_content_digest_v1(closure_id_value text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-study-closure-content/v1',
    'closureItemContentDigests', coalesce(
      jsonb_agg(to_jsonb(item.content_digest) order by item.position), '[]'::jsonb
    )
  ))
  from analysis_study_closure_items item
  where item.closure_id = closure_id_value
$$;


--
-- Name: analysis_study_closure_digest_v1(analysis_study_closures); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_study_closure_digest_v1(value analysis_study_closures) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'assessmentDigest', value.assessment_digest,
    'assessmentVersion', value.assessment_version,
    'basis', 'analysis-study-closure/v1',
    'closeActorRole', value.close_actor_role,
    'closeActorSubjectId', value.close_actor_subject_id,
    'closeActorUserId', value.close_actor_user_id,
    'closeCause', value.close_cause,
    'closeReason', value.close_reason,
    'closureItemCount', value.closure_item_count,
    'codingComplete', value.coding_complete,
    'completedItemCount', value.completed_item_count,
    'contentDigest', value.content_digest,
    'datasetRevisionId', value.dataset_revision_id,
    'drawComplete', value.draw_complete,
    'drawId', value.draw_id,
    'drawnFromPopulationId', value.drawn_from_population_id,
    'effectiveClosedAt', analysis_timestamp_v1(value.effective_closed_at),
    'frameReproducible', value.frame_reproducible,
    'frozenDrawDigest', value.frozen_draw_digest,
    'frozenFrameDigest', value.frozen_frame_digest,
    'method', value.method,
    'methodEligible', value.method_eligible,
    'populationId', value.population_id,
    'recomputedDrawDigest', value.recomputed_draw_digest,
    'recomputedFrameDigest', value.recomputed_frame_digest,
    'recordedAt', analysis_timestamp_v1(value.recorded_at),
    'representativeOfPopulationId', value.representative_of_population_id,
    'representativeReason', value.representative_reason,
    'selectedItemCount', value.selected_item_count,
    'stoppingRule', jsonb_build_object(
      'closeAt', case when value.stopping_rule = 'server_deadline'
        then analysis_timestamp_v1(value.close_at) else null end,
      'kind', value.stopping_rule
    ),
    'studyId', value.study_id,
    'viewSetDigest', value.view_set_digest,
    'viewedItemCount', value.viewed_item_count
  ))
$$;


--
-- Name: analysis_study_closure_items; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE analysis_study_closure_items (
    id text NOT NULL,
    project_id text NOT NULL,
    study_id text NOT NULL,
    closure_id text NOT NULL,
    study_item_id text NOT NULL,
    draw_item_id text NOT NULL,
    case_id text NOT NULL,
    "position" integer NOT NULL,
    item_state text NOT NULL,
    item_event_version bigint NOT NULL,
    current_event_id text,
    current_event_digest text,
    active_failure_observation_event_ids text[] NOT NULL,
    active_failure_observation_event_digests text[] NOT NULL,
    active_failure_assignment_event_ids text[] NOT NULL,
    active_failure_assignment_event_digests text[] NOT NULL,
    active_no_failure_event_id text,
    active_no_failure_event_digest text,
    completion_event_id text,
    completion_event_digest text,
    view_event_ids text[] NOT NULL,
    view_event_digests text[] NOT NULL,
    content_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_study_closure_items_active_no_failure_event_dige_check CHECK (((active_no_failure_event_digest IS NULL) OR (active_no_failure_event_digest ~ '^sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT analysis_study_closure_items_check CHECK (((item_event_version = 0) = ((current_event_id IS NULL) AND (current_event_digest IS NULL)))),
    CONSTRAINT analysis_study_closure_items_check1 CHECK (((current_event_id IS NULL) = (current_event_digest IS NULL))),
    CONSTRAINT analysis_study_closure_items_check2 CHECK (((active_no_failure_event_id IS NULL) = (active_no_failure_event_digest IS NULL))),
    CONSTRAINT analysis_study_closure_items_check3 CHECK (((completion_event_id IS NULL) = (completion_event_digest IS NULL))),
    CONSTRAINT analysis_study_closure_items_check4 CHECK ((cardinality(view_event_ids) = cardinality(view_event_digests))),
    CONSTRAINT analysis_study_closure_items_check5 CHECK (((active_no_failure_event_id IS NULL) OR (cardinality(active_failure_observation_event_ids) = 0))),
    CONSTRAINT analysis_study_closure_items_check6 CHECK ((cardinality(active_failure_observation_event_ids) = cardinality(active_failure_observation_event_digests))),
    CONSTRAINT analysis_study_closure_items_check7 CHECK ((cardinality(active_failure_observation_event_ids) = cardinality(active_failure_assignment_event_ids))),
    CONSTRAINT analysis_study_closure_items_check8 CHECK ((cardinality(active_failure_observation_event_ids) = cardinality(active_failure_assignment_event_digests))),
    CONSTRAINT analysis_study_closure_items_completion_event_digest_check CHECK (((completion_event_digest IS NULL) OR (completion_event_digest ~ '^sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT analysis_study_closure_items_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_study_closure_items_current_event_digest_check CHECK (((current_event_digest IS NULL) OR (current_event_digest ~ '^sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT analysis_study_closure_items_item_event_version_check CHECK ((item_event_version >= 0)),
    CONSTRAINT analysis_study_closure_items_item_state_check CHECK ((item_state = ANY (ARRAY['uncoded'::text, 'in_progress'::text, 'completed'::text]))),
    CONSTRAINT analysis_study_closure_items_position_check CHECK ((("position" >= 0) AND ("position" < 10000)))
);


--
-- Name: analysis_study_closure_item_digest_v1(analysis_study_closure_items); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_study_closure_item_digest_v1(value analysis_study_closure_items) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'activeFailureAssignmentEventDigests', to_jsonb(value.active_failure_assignment_event_digests),
    'activeFailureAssignmentEventIds', to_jsonb(value.active_failure_assignment_event_ids),
    'activeFailureObservationEventDigests', to_jsonb(value.active_failure_observation_event_digests),
    'activeFailureObservationEventIds', to_jsonb(value.active_failure_observation_event_ids),
    'activeNoFailureEventDigest', value.active_no_failure_event_digest,
    'activeNoFailureEventId', value.active_no_failure_event_id,
    'basis', 'analysis-study-closure-item/v1',
    'caseId', value.case_id,
    'completionEventDigest', value.completion_event_digest,
    'completionEventId', value.completion_event_id,
    'currentEventDigest', value.current_event_digest,
    'currentEventId', value.current_event_id,
    'drawItemId', value.draw_item_id,
    'itemEventVersion', value.item_event_version::text,
    'itemState', value.item_state,
    'position', value.position,
    'studyId', value.study_id,
    'studyItemId', value.study_item_id,
    'viewEventDigests', to_jsonb(value.view_event_digests),
    'viewEventIds', to_jsonb(value.view_event_ids)
  ))
$$;


--
-- Name: analysis_studies; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE analysis_studies (
    id text NOT NULL,
    project_id text NOT NULL,
    population_id text NOT NULL,
    draw_id text NOT NULL,
    dataset_revision_id text NOT NULL,
    contract_version text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    content_digest text NOT NULL,
    created_by_user_id text NOT NULL,
    created_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_studies_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_studies_contract_version_check CHECK ((contract_version = 'analysis-study/v1'::text)),
    CONSTRAINT analysis_studies_idempotency_key_check CHECK (((length(idempotency_key) > 0) AND (idempotency_key = TRIM(BOTH FROM idempotency_key)) AND (char_length(idempotency_key) <= 240))),
    CONSTRAINT analysis_studies_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: analysis_study_content_digest_v1(analysis_studies); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_study_content_digest_v1(value analysis_studies) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-study/v1',
    'contractVersion', value.contract_version,
    'datasetRevisionId', value.dataset_revision_id,
    'drawId', value.draw_id,
    'populationId', value.population_id,
    'projectId', value.project_id
  ))
$$;


--
-- Name: analysis_study_events; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE analysis_study_events (
    id text NOT NULL,
    project_id text NOT NULL,
    study_id text NOT NULL,
    version bigint NOT NULL,
    predecessor_event_id text,
    predecessor_event_digest text,
    event_type text NOT NULL,
    from_state text NOT NULL,
    to_state text NOT NULL,
    stopping_rule text,
    close_at timestamp with time zone,
    close_cause text,
    closure_id text,
    closure_digest text,
    expected_closure_digest text,
    reason text,
    actor_subject_id text,
    actor_user_id text,
    actor_role text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    event_digest text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_study_events_actor_role_check CHECK ((actor_role = ANY (ARRAY['owner'::text, 'system'::text]))),
    CONSTRAINT analysis_study_events_check CHECK (((predecessor_event_id IS NULL) = (predecessor_event_digest IS NULL))),
    CONSTRAINT analysis_study_events_check1 CHECK (((actor_subject_id IS NULL) = (actor_user_id IS NULL))),
    CONSTRAINT analysis_study_events_check2 CHECK (((actor_role = 'system'::text) = (actor_subject_id IS NULL))),
    CONSTRAINT analysis_study_events_check3 CHECK ((((event_type = 'coding_opened'::text) AND (stopping_rule IS NOT NULL) AND (close_cause IS NULL) AND (closure_id IS NULL) AND (closure_digest IS NULL) AND (expected_closure_digest IS NULL)) OR ((event_type = 'coding_closed'::text) AND (stopping_rule IS NULL) AND (close_at IS NULL) AND (close_cause IS NOT NULL) AND (closure_id IS NOT NULL) AND (closure_digest IS NOT NULL) AND (expected_closure_digest IS NULL)) OR ((event_type = 'study_completed'::text) AND (stopping_rule IS NULL) AND (close_at IS NULL) AND (close_cause IS NULL) AND (closure_id IS NULL) AND (closure_digest IS NULL) AND (expected_closure_digest IS NOT NULL)) OR ((event_type = 'study_abandoned'::text) AND (stopping_rule IS NULL) AND (close_at IS NULL) AND (close_cause IS NULL) AND (closure_id IS NULL) AND (closure_digest IS NULL) AND (expected_closure_digest IS NULL)))),
    CONSTRAINT analysis_study_events_check4 CHECK ((((event_type = 'coding_opened'::text) AND (stopping_rule = 'server_deadline'::text) AND (close_at IS NOT NULL)) OR ((event_type = 'coding_opened'::text) AND (stopping_rule = 'explicit_owner_close'::text) AND (close_at IS NULL)) OR (event_type <> 'coding_opened'::text))),
    CONSTRAINT analysis_study_events_close_cause_check CHECK ((close_cause = ANY (ARRAY['server_deadline'::text, 'explicit_owner_close'::text]))),
    CONSTRAINT analysis_study_events_closure_digest_check CHECK (((closure_digest IS NULL) OR (closure_digest ~ '^sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT analysis_study_events_event_digest_check CHECK ((event_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_study_events_event_type_check CHECK ((event_type = ANY (ARRAY['coding_opened'::text, 'coding_closed'::text, 'study_completed'::text, 'study_abandoned'::text]))),
    CONSTRAINT analysis_study_events_expected_closure_digest_check CHECK (((expected_closure_digest IS NULL) OR (expected_closure_digest ~ '^sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT analysis_study_events_from_state_check CHECK ((from_state = ANY (ARRAY['draft'::text, 'coding_open'::text, 'coding_closed'::text]))),
    CONSTRAINT analysis_study_events_idempotency_key_check CHECK (((length(idempotency_key) > 0) AND (idempotency_key = TRIM(BOTH FROM idempotency_key)) AND (char_length(idempotency_key) <= 240))),
    CONSTRAINT analysis_study_events_predecessor_event_digest_check CHECK (((predecessor_event_digest IS NULL) OR (predecessor_event_digest ~ '^sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT analysis_study_events_reason_check CHECK (((reason IS NULL) OR ((length(reason) > 0) AND (reason = TRIM(BOTH FROM reason)) AND (char_length(reason) <= 2000)))),
    CONSTRAINT analysis_study_events_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_study_events_stopping_rule_check CHECK ((stopping_rule = ANY (ARRAY['server_deadline'::text, 'explicit_owner_close'::text]))),
    CONSTRAINT analysis_study_events_to_state_check CHECK ((to_state = ANY (ARRAY['coding_open'::text, 'coding_closed'::text, 'completed'::text, 'abandoned'::text]))),
    CONSTRAINT analysis_study_events_version_check CHECK ((version > 0))
);


--
-- Name: analysis_study_event_digest_v1(analysis_study_events); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_study_event_digest_v1(value analysis_study_events) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(
    jsonb_build_object(
      'actorRole', value.actor_role,
      'actorSubjectId', value.actor_subject_id,
      'actorUserId', value.actor_user_id,
      'basis', 'analysis-study-event/v1',
      'eventType', value.event_type,
      'fromState', value.from_state,
      'id', value.id,
      'idempotencyKey', value.idempotency_key,
      'occurredAt', analysis_timestamp_v1(value.occurred_at),
      'predecessorEventDigest', value.predecessor_event_digest,
      'predecessorEventId', value.predecessor_event_id,
      'projectId', value.project_id,
      'requestDigest', value.request_digest,
      'studyId', value.study_id,
      'toState', value.to_state,
      'version', value.version::text
    ) || case value.event_type
      when 'coding_opened' then jsonb_build_object(
        'closeCause', null,
        'closureDigest', null,
        'closureId', null,
        'expectedClosureDigest', null,
        'reason', null,
        'stoppingRule', jsonb_build_object(
          'closeAt', case when value.stopping_rule = 'server_deadline'
            then analysis_timestamp_v1(value.close_at) else null end,
          'kind', value.stopping_rule
        )
      )
      when 'coding_closed' then jsonb_build_object(
        'closeCause', value.close_cause,
        'closureDigest', value.closure_digest,
        'closureId', value.closure_id,
        'expectedClosureDigest', null,
        'reason', value.reason,
        'stoppingRule', null
      )
      when 'study_completed' then jsonb_build_object(
        'closeCause', null,
        'closureDigest', null,
        'closureId', null,
        'expectedClosureDigest', value.expected_closure_digest,
        'reason', null,
        'stoppingRule', null
      )
      else jsonb_build_object(
        'closeCause', null,
        'closureDigest', null,
        'closureId', null,
        'expectedClosureDigest', null,
        'reason', value.reason,
        'stoppingRule', null
      )
    end
  )
$$;


--
-- Name: analysis_study_event_request_digest_v1(analysis_study_events); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_study_event_request_digest_v1(value analysis_study_events) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(
    jsonb_build_object(
      'basis', 'analysis-study-event-request/v1',
      'eventType', value.event_type,
      'expectedVersion', (value.version - 1)::text,
      'studyId', value.study_id
    ) || case value.event_type
      when 'coding_opened' then jsonb_build_object(
        'stoppingRule', jsonb_build_object(
          'closeAt', case when value.stopping_rule = 'server_deadline'
            then analysis_timestamp_v1(value.close_at) else null end,
          'kind', value.stopping_rule
        )
      )
      when 'coding_closed' then jsonb_build_object('reason', value.reason)
      when 'study_completed' then jsonb_build_object(
        'expectedClosureDigest', value.expected_closure_digest
      )
      else jsonb_build_object('reason', value.reason)
    end
  )
$$;


--
-- Name: analysis_study_items; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE analysis_study_items (
    id text NOT NULL,
    project_id text NOT NULL,
    study_id text NOT NULL,
    draw_item_id text NOT NULL,
    member_id text NOT NULL,
    revision_item_id text NOT NULL,
    case_id text NOT NULL,
    "position" integer NOT NULL,
    content_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_study_items_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_study_items_position_check CHECK ((("position" >= 0) AND ("position" < 10000)))
);


--
-- Name: analysis_study_item_content_digest_v1(analysis_study_items); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_study_item_content_digest_v1(value analysis_study_items) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-study-item/v1',
    'caseId', value.case_id,
    'drawItemId', value.draw_item_id,
    'memberId', value.member_id,
    'position', value.position,
    'revisionItemId', value.revision_item_id,
    'studyId', value.study_id
  ))
$$;


--
-- Name: analysis_study_item_events; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE analysis_study_item_events (
    id text NOT NULL,
    project_id text NOT NULL,
    study_id text NOT NULL,
    study_item_id text NOT NULL,
    version bigint NOT NULL,
    predecessor_event_id text,
    predecessor_event_digest text,
    event_type text NOT NULL,
    target_event_id text,
    target_event_digest text,
    failure_label text,
    rationale text,
    anchor_kind text,
    anchor_step_index integer,
    actor_subject_id text NOT NULL,
    actor_user_id text NOT NULL,
    actor_role text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    event_digest text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_study_item_events_actor_role_check CHECK ((actor_role = ANY (ARRAY['owner'::text, 'member'::text]))),
    CONSTRAINT analysis_study_item_events_anchor_kind_check CHECK ((anchor_kind = ANY (ARRAY['case_output'::text, 'step'::text]))),
    CONSTRAINT analysis_study_item_events_anchor_step_index_check CHECK (((anchor_step_index IS NULL) OR ((anchor_step_index >= 0) AND (anchor_step_index < 50)))),
    CONSTRAINT analysis_study_item_events_check CHECK (((predecessor_event_id IS NULL) = (predecessor_event_digest IS NULL))),
    CONSTRAINT analysis_study_item_events_check1 CHECK (((target_event_id IS NULL) = (target_event_digest IS NULL))),
    CONSTRAINT analysis_study_item_events_check2 CHECK ((((event_type = 'failure_observed'::text) AND (target_event_id IS NULL) AND (failure_label IS NOT NULL) AND (rationale IS NOT NULL) AND (anchor_kind IS NOT NULL) AND (((anchor_kind = 'case_output'::text) AND (anchor_step_index IS NULL)) OR ((anchor_kind = 'step'::text) AND (anchor_step_index IS NOT NULL)))) OR ((event_type = ANY (ARRAY['failure_withdrawn'::text, 'no_failure_withdrawn'::text])) AND (target_event_id IS NOT NULL) AND (failure_label IS NULL) AND (rationale IS NOT NULL) AND (anchor_kind IS NULL) AND (anchor_step_index IS NULL)) OR ((event_type = 'no_failure_observed'::text) AND (target_event_id IS NULL) AND (failure_label IS NULL) AND (rationale IS NOT NULL) AND (anchor_kind IS NULL) AND (anchor_step_index IS NULL)) OR ((event_type = 'coding_completed'::text) AND (target_event_id IS NULL) AND (failure_label IS NULL) AND (rationale IS NULL) AND (anchor_kind IS NULL) AND (anchor_step_index IS NULL)) OR ((event_type = 'coding_reopened'::text) AND (target_event_id IS NOT NULL) AND (failure_label IS NULL) AND (rationale IS NOT NULL) AND (anchor_kind IS NULL) AND (anchor_step_index IS NULL)))),
    CONSTRAINT analysis_study_item_events_event_digest_check CHECK ((event_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_study_item_events_event_type_check CHECK ((event_type = ANY (ARRAY['failure_observed'::text, 'failure_withdrawn'::text, 'no_failure_observed'::text, 'no_failure_withdrawn'::text, 'coding_completed'::text, 'coding_reopened'::text]))),
    CONSTRAINT analysis_study_item_events_failure_label_check CHECK (((failure_label IS NULL) OR ((length(failure_label) > 0) AND (failure_label = TRIM(BOTH FROM failure_label)) AND (char_length(failure_label) <= 500)))),
    CONSTRAINT analysis_study_item_events_idempotency_key_check CHECK (((length(idempotency_key) > 0) AND (idempotency_key = TRIM(BOTH FROM idempotency_key)) AND (char_length(idempotency_key) <= 240))),
    CONSTRAINT analysis_study_item_events_predecessor_event_digest_check CHECK (((predecessor_event_digest IS NULL) OR (predecessor_event_digest ~ '^sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT analysis_study_item_events_rationale_check CHECK (((rationale IS NULL) OR ((length(rationale) > 0) AND (rationale = TRIM(BOTH FROM rationale)) AND (char_length(rationale) <= 5000)))),
    CONSTRAINT analysis_study_item_events_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_study_item_events_target_event_digest_check CHECK (((target_event_digest IS NULL) OR (target_event_digest ~ '^sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT analysis_study_item_events_version_check CHECK ((version > 0))
);


--
-- Name: analysis_study_item_event_digest_v1(analysis_study_item_events); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_study_item_event_digest_v1(value analysis_study_item_events) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(
    jsonb_build_object(
      'actorRole', value.actor_role,
      'actorSubjectId', value.actor_subject_id,
      'actorUserId', value.actor_user_id,
      'basis', 'analysis-study-item-event/v1',
      'eventType', value.event_type,
      'id', value.id,
      'idempotencyKey', value.idempotency_key,
      'occurredAt', analysis_timestamp_v1(value.occurred_at),
      'predecessorEventDigest', value.predecessor_event_digest,
      'predecessorEventId', value.predecessor_event_id,
      'projectId', value.project_id,
      'requestDigest', value.request_digest,
      'studyId', value.study_id,
      'studyItemId', value.study_item_id,
      'version', value.version::text
    ) || case value.event_type
      when 'failure_observed' then jsonb_build_object(
        'evidenceAnchor', case value.anchor_kind
          when 'case_output' then jsonb_build_object('kind', 'case_output')
          else jsonb_build_object('kind', 'step', 'stepIndex', value.anchor_step_index)
        end,
        'failureLabel', value.failure_label,
        'rationale', value.rationale
      )
      when 'failure_withdrawn' then jsonb_build_object(
        'rationale', value.rationale,
        'targetEventDigest', value.target_event_digest,
        'targetEventId', value.target_event_id
      )
      when 'no_failure_observed' then jsonb_build_object('rationale', value.rationale)
      when 'no_failure_withdrawn' then jsonb_build_object(
        'rationale', value.rationale,
        'targetEventDigest', value.target_event_digest,
        'targetEventId', value.target_event_id
      )
      when 'coding_completed' then '{}'::jsonb
      else jsonb_build_object(
        'rationale', value.rationale,
        'targetEventDigest', value.target_event_digest,
        'targetEventId', value.target_event_id
      )
    end
  )
$$;


--
-- Name: analysis_study_item_event_request_digest_v1(analysis_study_item_events); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_study_item_event_request_digest_v1(value analysis_study_item_events) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(
    jsonb_build_object(
      'basis', 'analysis-study-item-event-request/v1',
      'eventType', value.event_type,
      'expectedVersion', (value.version - 1)::text,
      'projectId', value.project_id,
      'studyId', value.study_id,
      'studyItemId', value.study_item_id
    ) || case value.event_type
      when 'failure_observed' then jsonb_build_object(
        'evidenceAnchor', case value.anchor_kind
          when 'case_output' then jsonb_build_object('kind', 'case_output')
          else jsonb_build_object('kind', 'step', 'stepIndex', value.anchor_step_index)
        end,
        'failureLabel', value.failure_label,
        'rationale', value.rationale
      )
      when 'failure_withdrawn' then jsonb_build_object(
        'rationale', value.rationale,
        'targetEventDigest', value.target_event_digest,
        'targetEventId', value.target_event_id
      )
      when 'no_failure_observed' then jsonb_build_object('rationale', value.rationale)
      when 'no_failure_withdrawn' then jsonb_build_object(
        'rationale', value.rationale,
        'targetEventDigest', value.target_event_digest,
        'targetEventId', value.target_event_id
      )
      when 'coding_completed' then '{}'::jsonb
      else jsonb_build_object(
        'rationale', value.rationale,
        'targetEventDigest', value.target_event_digest,
        'targetEventId', value.target_event_id
      )
    end
  )
$$;


--
-- Name: analysis_study_item_projection_v1(text, timestamp with time zone); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_study_item_projection_v1(study_item_id_value text, as_of_value timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS TABLE(item_state text, current_version bigint, current_event_id text, current_event_digest text, view_event_ids text[], view_event_digests text[], active_failure_observation_event_ids text[], active_failure_observation_event_digests text[], active_failure_assignment_event_ids text[], active_failure_assignment_event_digests text[], active_no_failure_event_id text, active_no_failure_event_digest text, completion_event_id text, completion_event_digest text)
    LANGUAGE sql STABLE
    AS $$
  with item_events as (
    select event.* from analysis_study_item_events event
    where event.study_item_id = study_item_id_value
      and (as_of_value is null or event.occurred_at <= as_of_value)
  ), head as (
    select event.* from item_events event order by event.version desc limit 1
  ), views as (
    select coalesce(array_agg(view_row.id order by view_row.viewed_at, view_row.id), array[]::text[]) ids,
           coalesce(array_agg(view_row.content_digest order by view_row.viewed_at, view_row.id), array[]::text[]) digests
    from analysis_study_item_views view_row
    where view_row.study_item_id = study_item_id_value
      and view_row.counts_toward_closure
      and (as_of_value is null or view_row.viewed_at <= as_of_value)
  ), active_failures as (
    select observation.*
    from item_events observation
    where observation.event_type = 'failure_observed'
      and not exists (
        select 1 from item_events withdrawal
        where withdrawal.event_type = 'failure_withdrawn'
          and withdrawal.target_event_id = observation.id
      )
  ), failure_projection as (
    select coalesce(array_agg(observation.id order by observation.version), array[]::text[]) ids,
           coalesce(array_agg(observation.event_digest order by observation.version), array[]::text[]) digests,
           coalesce(array_agg(assignment.assignment_event_id order by observation.version), array[]::text[]) assignment_ids,
           coalesce(array_agg(assignment.assignment_event_digest order by observation.version), array[]::text[]) assignment_digests
    from active_failures observation
    left join lateral analysis_observation_assignment_head_v1(observation.id, null) assignment on true
  ), active_no_failure as (
    select observation.*
    from item_events observation
    where observation.event_type = 'no_failure_observed'
      and not exists (
        select 1 from item_events withdrawal
        where withdrawal.event_type = 'no_failure_withdrawn'
          and withdrawal.target_event_id = observation.id
      )
    order by observation.version desc limit 1
  ), active_completion as (
    select completion.*
    from item_events completion
    where completion.event_type = 'coding_completed'
      and not exists (
        select 1 from item_events reopen
        where reopen.event_type = 'coding_reopened'
          and reopen.target_event_id = completion.id
      )
    order by completion.version desc limit 1
  )
  select case
           when active_completion.id is not null then 'completed'
           when head.id is null and cardinality(views.ids) = 0 then 'uncoded'
           else 'in_progress'
         end,
         coalesce(head.version, 0), head.id, head.event_digest,
         views.ids, views.digests,
         failure_projection.ids, failure_projection.digests,
         failure_projection.assignment_ids, failure_projection.assignment_digests,
         active_no_failure.id, active_no_failure.event_digest,
         active_completion.id, active_completion.event_digest
  from (select 1) seed
  cross join views
  cross join failure_projection
  left join head on true
  left join active_no_failure on true
  left join active_completion on true
$$;


--
-- Name: analysis_study_item_views; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE analysis_study_item_views (
    id text NOT NULL,
    project_id text NOT NULL,
    study_id text NOT NULL,
    study_item_id text NOT NULL,
    dataset_exposure_event_id text NOT NULL,
    viewer_user_id text NOT NULL,
    viewer_subject_id text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    content_digest text NOT NULL,
    counts_toward_closure boolean NOT NULL,
    viewed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_study_item_views_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_study_item_views_idempotency_key_check CHECK (((length(idempotency_key) > 0) AND (idempotency_key = TRIM(BOTH FROM idempotency_key)) AND (char_length(idempotency_key) <= 240))),
    CONSTRAINT analysis_study_item_views_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: analysis_study_item_view_digest_v1(analysis_study_item_views); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_study_item_view_digest_v1(value analysis_study_item_views) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-study-item-view/v1',
    'countsTowardClosure', value.counts_toward_closure,
    'datasetExposureEventId', value.dataset_exposure_event_id,
    'projectId', value.project_id,
    'requestDigest', value.request_digest,
    'studyId', value.study_id,
    'studyItemId', value.study_item_id,
    'viewedAt', analysis_timestamp_v1(value.viewed_at),
    'viewerSubjectId', value.viewer_subject_id,
    'viewerUserId', value.viewer_user_id
  ))
$$;


--
-- Name: analysis_study_item_view_request_digest_v1(analysis_study_item_views, text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_study_item_view_request_digest_v1(value analysis_study_item_views, dataset_revision_id_value text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-study-item-view-request/v1',
    'datasetRevisionId', dataset_revision_id_value,
    'projectId', value.project_id,
    'studyId', value.study_id,
    'studyItemId', value.study_item_id,
    'viewerSubjectId', value.viewer_subject_id,
    'viewerUserId', value.viewer_user_id
  ))
$$;


--
-- Name: analysis_study_lock_v1(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_study_lock_v1(study_id_value text) RETURNS void
    LANGUAGE plpgsql
    AS $$
begin
  perform pg_advisory_xact_lock(hashtextextended(
    jsonb_build_array('analysis-study/v1', study_id_value)::text, 0
  ));
end;
$$;


--
-- Name: analysis_study_projection_v1(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_study_projection_v1(study_id_value text) RETURNS TABLE(state text, current_version bigint, current_event_id text, current_event_digest text, stopping_rule text, close_at timestamp with time zone, closure_id text, closure_digest text)
    LANGUAGE sql STABLE
    AS $$
  with head as (
    select event.* from analysis_study_events event
    where event.study_id = study_id_value
    order by event.version desc limit 1
  ), opened as (
    select event.* from analysis_study_events event
    where event.study_id = study_id_value and event.event_type = 'coding_opened'
    limit 1
  ), closed as (
    select event.* from analysis_study_events event
    where event.study_id = study_id_value and event.event_type = 'coding_closed'
    limit 1
  )
  select coalesce(head.to_state, 'draft'), coalesce(head.version, 0),
         head.id, head.event_digest, opened.stopping_rule, opened.close_at,
         closed.closure_id, closed.closure_digest
  from (select 1) seed
  left join head on true
  left join opened on true
  left join closed on true
$$;


--
-- Name: analysis_study_request_digest_v1(analysis_studies); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_study_request_digest_v1(value analysis_studies) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-study-request/v1',
    'populationId', value.population_id,
    'projectId', value.project_id
  ))
$$;


--
-- Name: analysis_study_state_v1(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_study_state_v1(study_id_value text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select coalesce(
    (select event.to_state
     from analysis_study_events event
     where event.study_id = study_id_value
     order by event.version desc
     limit 1),
    'draft'
  )
$$;


--
-- Name: analysis_study_view_set_digest_v1(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_study_view_set_digest_v1(closure_id_value text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-study-view-set/v1',
    'viewEventDigests', coalesce(jsonb_agg(to_jsonb(view_value.digest)
      order by item.position, view_value.ordinality), '[]'::jsonb)
  ))
  from analysis_study_closure_items item
  left join lateral unnest(item.view_event_digests) with ordinality
    as view_value(digest, ordinality) on true
  where item.closure_id = closure_id_value
    and view_value.digest is not null
$$;


--
-- Name: analysis_taxonomy_content_digest_v1(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_taxonomy_content_digest_v1(revision_id_value text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-taxonomy-content/v1',
    'entryDigests', coalesce(jsonb_agg(to_jsonb(entry.entry_digest) order by entry.position), '[]'::jsonb)
  ))
  from analysis_failure_taxonomy_revision_codes entry
  where entry.taxonomy_revision_id = revision_id_value
$$;


--
-- Name: analysis_taxonomy_coverage_v1(text, text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_taxonomy_coverage_v1(study_id_value text, taxonomy_revision_id_value text) RETURNS TABLE(project_id text, taxonomy_id text, taxonomy_revision_sequence integer, selected_item_count bigint, completed_item_count bigint, no_failure_observed_item_count bigint, active_failure_observation_count bigint, categorized bigint, assigned_to_retired_code bigint, uncategorized bigint, categorized_item_count bigint, assigned_to_retired_code_item_count bigint, uncategorized_item_count bigint)
    LANGUAGE sql STABLE
    AS $$
  with target as (
    select revision.* from analysis_failure_taxonomy_revisions revision
    where revision.id = taxonomy_revision_id_value
  ), active_failures as (
    select event.id, event.study_item_id
    from analysis_study_item_events event
    where event.study_id = study_id_value
      and event.event_type = 'failure_observed'
      and not exists (
        select 1 from analysis_study_item_events withdrawal
        where withdrawal.study_item_id = event.study_item_id
          and withdrawal.event_type = 'failure_withdrawn'
          and withdrawal.target_event_id = event.id
      )
  ), projected as (
    select observation.id, observation.study_item_id,
           case
             when assignment.event_type is null or assignment.event_type = 'withdrawn'
               then 'uncategorized'
             when entry.status = 'retired' then 'assigned_to_retired_code'
             when entry.status = 'active' then 'categorized'
             else 'uncategorized'
           end bucket
    from active_failures observation
    cross join target
    left join lateral (
      select event.*
      from analysis_observation_assignment_events event
      where event.observation_event_id = observation.id
        and event.taxonomy_id = target.taxonomy_id
        and event.taxonomy_revision_sequence <= target.sequence
      order by event.version desc limit 1
    ) assignment on true
    left join analysis_failure_taxonomy_revision_codes entry
      on entry.taxonomy_revision_id = target.id
     and entry.code_id = assignment.code_id
  ), item_projection as (
    select item.id,
           projection.item_state,
           projection.active_no_failure_event_id
    from analysis_study_items item
    cross join lateral analysis_study_item_projection_v1(item.id, null) projection
    where item.study_id = study_id_value
  )
  select target.project_id, target.taxonomy_id, target.sequence,
         (select count(*) from analysis_study_items item where item.study_id = study_id_value),
         (select count(*) from item_projection item where item.item_state = 'completed'),
         (select count(*) from item_projection item
          where item.active_no_failure_event_id is not null),
         count(projected.id),
         count(projected.id) filter (where projected.bucket = 'categorized'),
         count(projected.id) filter (where projected.bucket = 'assigned_to_retired_code'),
         count(projected.id) filter (where projected.bucket = 'uncategorized'),
         count(distinct projected.study_item_id) filter (where projected.bucket = 'categorized'),
         count(distinct projected.study_item_id) filter (
           where projected.bucket = 'assigned_to_retired_code'
         ),
         count(distinct projected.study_item_id) filter (where projected.bucket = 'uncategorized')
  from target
  left join projected on true
  group by target.project_id, target.taxonomy_id, target.sequence
$$;


--
-- Name: analysis_taxonomy_lock_v1(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_taxonomy_lock_v1(taxonomy_id_value text) RETURNS void
    LANGUAGE plpgsql
    AS $$
begin
  perform pg_advisory_xact_lock(hashtextextended(
    jsonb_build_array('analysis-taxonomy/v1', taxonomy_id_value)::text, 0
  ));
end;
$$;


--
-- Name: analysis_taxonomy_request_digest_v1(text, text, jsonb); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_taxonomy_request_digest_v1(project_id_value text, taxonomy_id_value text, request_payload_value jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(
    request_payload_value || jsonb_build_object(
      'basis', 'analysis-taxonomy-request/v1',
      case when taxonomy_id_value is null then 'projectId' else 'taxonomyId' end,
      coalesce(taxonomy_id_value, project_id_value)
    )
  )
$$;


--
-- Name: analysis_failure_taxonomy_revision_codes; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE analysis_failure_taxonomy_revision_codes (
    id text NOT NULL,
    project_id text NOT NULL,
    taxonomy_id text NOT NULL,
    taxonomy_revision_id text NOT NULL,
    code_id text NOT NULL,
    "position" integer NOT NULL,
    label text NOT NULL,
    definition text NOT NULL,
    status text NOT NULL,
    entry_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_failure_taxonomy_revision_codes_definition_check CHECK (((length(definition) > 0) AND (definition = TRIM(BOTH FROM definition)) AND (char_length(definition) <= 5000))),
    CONSTRAINT analysis_failure_taxonomy_revision_codes_entry_digest_check CHECK ((entry_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_failure_taxonomy_revision_codes_label_check CHECK (((length(label) > 0) AND (label = TRIM(BOTH FROM label)) AND (char_length(label) <= 500))),
    CONSTRAINT analysis_failure_taxonomy_revision_codes_position_check CHECK ((("position" >= 0) AND ("position" < 1000))),
    CONSTRAINT analysis_failure_taxonomy_revision_codes_status_check CHECK ((status = ANY (ARRAY['active'::text, 'retired'::text])))
);


--
-- Name: analysis_taxonomy_revision_code_digest_v1(analysis_failure_taxonomy_revision_codes); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_taxonomy_revision_code_digest_v1(value analysis_failure_taxonomy_revision_codes) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-taxonomy-revision-code/v1',
    'codeId', value.code_id,
    'definition', value.definition,
    'label', value.label,
    'position', value.position,
    'status', value.status,
    'taxonomyId', value.taxonomy_id,
    'taxonomyRevisionId', value.taxonomy_revision_id
  ))
$$;


--
-- Name: analysis_failure_taxonomy_revisions; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE analysis_failure_taxonomy_revisions (
    id text NOT NULL,
    project_id text NOT NULL,
    taxonomy_id text NOT NULL,
    sequence integer NOT NULL,
    predecessor_revision_id text,
    predecessor_revision_digest text,
    code_count integer NOT NULL,
    reason text NOT NULL,
    content_digest text NOT NULL,
    revision_digest text NOT NULL,
    created_by_user_id text NOT NULL,
    created_by_subject_id text NOT NULL,
    idempotency_key text NOT NULL,
    request_payload jsonb NOT NULL,
    request_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_failure_taxonomy_rev_predecessor_revision_digest_check CHECK (((predecessor_revision_digest IS NULL) OR (predecessor_revision_digest ~ '^sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT analysis_failure_taxonomy_revisions_check CHECK (((predecessor_revision_id IS NULL) = (predecessor_revision_digest IS NULL))),
    CONSTRAINT analysis_failure_taxonomy_revisions_code_count_check CHECK (((code_count > 0) AND (code_count <= 1000))),
    CONSTRAINT analysis_failure_taxonomy_revisions_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_failure_taxonomy_revisions_idempotency_key_check CHECK (((length(idempotency_key) > 0) AND (idempotency_key = TRIM(BOTH FROM idempotency_key)) AND (char_length(idempotency_key) <= 240))),
    CONSTRAINT analysis_failure_taxonomy_revisions_reason_check CHECK (((length(reason) > 0) AND (reason = TRIM(BOTH FROM reason)) AND (char_length(reason) <= 2000))),
    CONSTRAINT analysis_failure_taxonomy_revisions_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_failure_taxonomy_revisions_request_payload_check CHECK (((jsonb_typeof(request_payload) = 'object'::text) AND (octet_length(governed_canonical_json_v1(request_payload)) <= 8388608))),
    CONSTRAINT analysis_failure_taxonomy_revisions_revision_digest_check CHECK ((revision_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_failure_taxonomy_revisions_sequence_check CHECK (((sequence > 0) AND (sequence <= 10000)))
);


--
-- Name: analysis_taxonomy_revision_digest_v1(analysis_failure_taxonomy_revisions); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_taxonomy_revision_digest_v1(value analysis_failure_taxonomy_revisions) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-taxonomy-revision/v1',
    'contentDigest', value.content_digest,
    'predecessorRevisionDigest', value.predecessor_revision_digest,
    'predecessorRevisionId', value.predecessor_revision_id,
    'reason', value.reason,
    'sequence', value.sequence,
    'taxonomyId', value.taxonomy_id
  ))
$$;


--
-- Name: analysis_timestamp_v1(timestamp with time zone); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION analysis_timestamp_v1(value timestamp with time zone) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select to_char(value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;


--
-- Name: append_evaluator_needs_review_on_revocation_v1(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION append_evaluator_needs_review_on_revocation_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare lifecycle evaluator_lifecycles%rowtype;
declare head evaluator_lifecycle_events%rowtype;
declare next_id text;
declare next_request_digest text;
declare next_content_digest text;
declare next_row evaluator_lifecycle_events%rowtype;
begin
  select candidate.* into lifecycle
  from evaluator_lifecycles candidate
  cross join lateral evaluator_lifecycle_head_v1(candidate.id) current_head
  where candidate.project_id=new.project_id and current_head.state='active'
    and current_head.transition='activated'
    and current_head.calibration_artifact_id=new.artifact_id
  order by current_head.sequence desc limit 1;
  if lifecycle.id is null then return new; end if;
  select * into head from evaluator_lifecycle_head_v1(lifecycle.id);
  next_id := 'elce_' || substr(replace(governed_content_v1_digest(
    'evaluator-lifecycle-revocation-id/v1',jsonb_build_object('revocationId',new.id)),':',''),8,48);
  next_request_digest := governed_content_v1_digest(
    'evaluator-lifecycle-revocation-request/v1',jsonb_build_object(
      'artifactId',new.artifact_id,'lifecycleId',lifecycle.id,'revocationId',new.id));
  next_row.id:=next_id;
  next_row.contract_version:='coeval/evaluator-lifecycle-event/v1';
  next_row.lifecycle_id:=lifecycle.id;
  next_row.project_id:=lifecycle.project_id;
  next_row.criterion_id:=lifecycle.criterion_id;
  next_row.skill_version_id:=lifecycle.skill_version_id;
  next_row.sequence:=head.sequence+1;
  next_row.transition:='calibration_revoked';
  next_row.state:='needs_review';
  next_row.predecessor_event_id:=head.id;
  next_row.predecessor_event_digest:=head.content_digest;
  next_row.actor_role:='system';
  next_row.reason:='Calibration artifact revoked: ' || new.reason;
  next_row.idempotency_key:='calibration-revocation:' || new.id;
  next_row.request_digest:=next_request_digest;
  next_row.content_digest:=evaluator_lifecycle_event_content_digest_v1(next_row);
  insert into evaluator_lifecycle_events
    (id,contract_version,lifecycle_id,project_id,criterion_id,skill_version_id,sequence,
     transition,state,predecessor_event_id,predecessor_event_digest,activation_bundle_id,
     calibration_artifact_id,calibration_artifact_digest,calibration_evidence_digest,
     regression_run_id,regression_dataset_revision_id,replaced_skill_version_id,
     actor_user_id,actor_subject_id,actor_role,reason,idempotency_key,request_digest,content_digest)
  values
    (next_row.id,next_row.contract_version,next_row.lifecycle_id,next_row.project_id,
     next_row.criterion_id,next_row.skill_version_id,next_row.sequence,next_row.transition,
     next_row.state,next_row.predecessor_event_id,next_row.predecessor_event_digest,null,
     null,null,null,null,null,null,null,null,next_row.actor_role,next_row.reason,
     next_row.idempotency_key,next_row.request_digest,next_row.content_digest)
  on conflict (project_id,idempotency_key) do nothing;
  return new;
end;
$$;


--
-- Name: append_skill_version_development_event(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION append_skill_version_development_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.developer_identity_status = 'recorded' then
    insert into governed_evaluator_development_events
      (id, project_id, criterion_version_id, skill_version_id, developer_subject_id,
       developer_role_at_recording, activity_kind, source_kind, content_digest)
    values
      ('grede_' || new.id, new.project_id, new.criterion_version_id, new.id,
       new.created_by_subject_id, 'evaluator_developer', 'evaluator_development',
       'system_recorded', governed_content_v1_digest(
         'governed-evaluator-development/v1', jsonb_build_object(
           'activityKind', 'evaluator_development',
           'criterionVersionId', new.criterion_version_id,
           'developerRoleAtRecording', 'evaluator_developer',
           'developerSubjectId', new.created_by_subject_id,
           'skillVersionId', new.id,
           'sourceKind', 'system_recorded'
         )
       ));
  end if;
  return new;
end;
$$;


--
-- Name: claim_case_input_identity_nonsealed(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION claim_case_input_identity_nonsealed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.input_digest is not null then
    perform claim_governed_input_identity(new.project_id, new.input_digest, 'nonsealed');
  end if;
  return new;
end;
$$;


--
-- Name: claim_dataset_revision_item_identity(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION claim_dataset_revision_item_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  revision_role text;
begin
  select role into strict revision_role
  from dataset_revisions revision
  where revision.id = new.revision_id and revision.project_id = new.project_id;
  perform claim_governed_input_identity(
    new.project_id,
    new.input_digest,
    case when revision_role = 'sealed_validation' then 'sealed' else 'nonsealed' end
  );
  return new;
exception
  when no_data_found then
    raise exception 'dataset revision item must belong to its revision project'
      using errcode = '23514';
end;
$$;


--
-- Name: claim_governed_input_identity(text, text, text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION claim_governed_input_identity(project_id_value text, input_digest_value text, usage_class_value text) RETURNS void
    LANGUAGE plpgsql
    AS $$
declare
  claimed_class text;
begin
  if input_digest_value is null then
    return;
  end if;

  -- Additional evidence in a class that already owns this identity is the
  -- common path. A plain MVCC read neither rewrites nor locks the claim, so a
  -- long population freeze cannot stall duplicate ingestion (or vice versa).
  select claim.usage_class into claimed_class
  from governed_input_identity_claims claim
  where claim.project_id = project_id_value
    and claim.input_digest = input_digest_value;
  if found then
    if claimed_class <> usage_class_value then
      raise exception 'input identity is already claimed by % evidence', claimed_class
        using errcode = '23514';
    end if;
    return;
  end if;

  -- A missing claim can still race an invisible insert under REPEATABLE READ.
  -- Keep the atomic conflict path for first ownership only: its returned class
  -- makes opposite-class creation fail closed when the winner was not visible
  -- in this transaction's snapshot.
  insert into governed_input_identity_claims (project_id, input_digest, usage_class)
  values (project_id_value, input_digest_value, usage_class_value)
  on conflict (project_id, input_digest) do update
    set usage_class = governed_input_identity_claims.usage_class
  returning usage_class into claimed_class;
  if claimed_class <> usage_class_value then
    raise exception 'input identity is already claimed by % evidence', claimed_class
      using errcode = '23514';
  end if;
end;
$$;


--
-- Name: claim_governed_sealed_review_identity(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION claim_governed_sealed_review_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.source_kind = 'sealed_intake' then
    perform claim_governed_input_identity(new.project_id, new.input_digest, 'sealed');
  end if;
  return new;
end;
$$;


--
-- Name: criterion_v1_digest(text, text, text, text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION criterion_v1_digest(criterion_id_value text, criterion_version_id_value text, criterion_name_value text, criterion_definition_value text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
  select 'sha256:' || encode(sha256(convert_to(
    '{"criterionDefinition":' || to_json(criterion_definition_value)::text ||
    ',"criterionId":' || to_json(criterion_id_value)::text ||
    ',"criterionName":' || to_json(criterion_name_value)::text ||
    ',"criterionVersionId":' || to_json(criterion_version_id_value)::text || '}',
    'UTF8'
  )), 'hex')
$$;


--
-- Name: ensure_dataset_revision_criterion_scope(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION ensure_dataset_revision_criterion_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.role = 'regression_golden' and new.criterion_version_id is null then
    raise exception 'regression/golden revision requires an explicit criterion version'
      using errcode = '23514';
  end if;
  if new.criterion_version_id is not null and not exists (
    select 1 from criterion_versions version
    where version.id = new.criterion_version_id
      and version.project_id = new.project_id
  ) then
    raise exception 'dataset revision criterion version must belong to the same project'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: ensure_golden_criterion_binding(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION ensure_golden_criterion_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  source_criterion_version_id text;
begin
  if tg_op = 'UPDATE' and new.criterion_version_id is distinct from old.criterion_version_id then
    raise exception 'golden evidence cannot change criterion version'
      using errcode = '55000';
  end if;
  select version.criterion_version_id into source_criterion_version_id
  from skill_versions version
  where version.id = new.source_skill_version_id
    and version.project_id = new.project_id;
  if source_criterion_version_id is null then
    raise exception 'golden evidence source evaluator must belong to the same project'
      using errcode = '23514';
  end if;
  if new.criterion_version_id <> source_criterion_version_id then
    raise exception 'golden evidence criterion must match its source evaluator version'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: ensure_human_verdict_criterion_binding(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION ensure_human_verdict_criterion_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  -- Project deletion can fire this trigger before the verdict row cascades.
  if not exists (select 1 from projects project where project.id = new.project_id) then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.source in ('human', 'adjudicated')
     and new.skill_version_id is distinct from old.skill_version_id
  then
    raise exception 'human verdict evaluator scope is immutable'
      using errcode = '55000';
  end if;
  if new.source not in ('human', 'adjudicated') then
    return new;
  end if;
  if not exists (
    select 1 from cases evaluation_case
    where evaluation_case.id = new.case_id
      and evaluation_case.project_id = new.project_id
  ) then
    raise exception 'human verdict case must belong to the same project'
      using errcode = '23514';
  end if;
  if new.skill_version_id is null then
    raise exception 'human verdict requires an explicit evaluator version'
      using errcode = '23514';
  end if;
  if new.skill_version_id is null or not exists (
    select 1
    from skill_versions version
    where version.project_id = new.project_id
      and version.id = new.skill_version_id
  ) then
    raise exception 'human verdict evaluator must belong to the same project'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: ensure_import_job_skill_version_binding(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION ensure_import_job_skill_version_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'UPDATE'
     and new.skill_version_id is distinct from old.skill_version_id
  then
    raise exception 'an import job cannot change its pinned evaluator version'
      using errcode = '55000';
  end if;
  if new.skill_version_id is null then
    if new.status <> 'failed' then
      raise exception 'only a terminal failed import selection attempt may omit evaluator version'
        using errcode = '23514';
    end if;
    return new;
  end if;
  if not exists (
    select 1
    from skill_versions version
    where version.id = new.skill_version_id
      and version.project_id = new.project_id
  ) then
    raise exception 'import job evaluator version must belong to the same project'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: ensure_regression_run_criterion_binding(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION ensure_regression_run_criterion_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  evaluator_criterion_version_id text;
begin
  if tg_op = 'UPDATE' and new.criterion_version_id is distinct from old.criterion_version_id then
    raise exception 'regression evidence cannot change criterion version'
      using errcode = '55000';
  end if;
  select version.criterion_version_id into evaluator_criterion_version_id
  from skill_versions version
  where version.id = new.skill_version_id
    and version.project_id = new.project_id;
  if evaluator_criterion_version_id is null then
    raise exception 'regression evidence evaluator must belong to the same project'
      using errcode = '23514';
  end if;
  if new.criterion_version_id <> evaluator_criterion_version_id then
    raise exception 'regression evidence criterion must match its evaluator version'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: ensure_review_queue_item_criterion_binding(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION ensure_review_queue_item_criterion_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  queue_project_id text;
begin
  if tg_op = 'UPDATE' and new.criterion_version_id is distinct from old.criterion_version_id then
    raise exception 'review queue item criterion scope is immutable'
      using errcode = '55000';
  end if;
  select queue.project_id into queue_project_id
  from review_queues queue
  where queue.id = new.queue_id;
  if queue_project_id is null then
    raise exception 'review queue item requires an existing queue'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from cases evaluation_case
    where evaluation_case.id = new.case_id
      and evaluation_case.project_id = queue_project_id
  ) then
    raise exception 'review queue item case must belong to the queue project'
      using errcode = '23514';
  end if;
  if new.criterion_version_id is null then
    raise exception 'review queue item requires an explicit criterion version'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from criterion_versions version
    where version.id = new.criterion_version_id
      and version.project_id = queue_project_id
  ) then
    raise exception 'review queue item criterion must belong to the queue project'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: FUNCTION ensure_review_queue_item_criterion_binding(); Type: COMMENT; Schema: current; Owner: -
--

COMMENT ON FUNCTION ensure_review_queue_item_criterion_binding() IS 'Ownership and immutable criterion-scope guard for current review-queue writers.';


--
-- Name: ensure_skill_criterion_binding(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION ensure_skill_criterion_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'UPDATE' and new.criterion_id is distinct from old.criterion_id then
    raise exception 'a skill cannot change its stable criterion'
      using errcode = '55000';
  end if;
  if new.criterion_id is null then
    raise exception 'skill requires an explicit stable criterion'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from criteria criterion
    where criterion.id = new.criterion_id
      and criterion.project_id = new.project_id
  ) then
    raise exception 'skill criterion must belong to the same project'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: FUNCTION ensure_skill_criterion_binding(); Type: COMMENT; Schema: current; Owner: -
--

COMMENT ON FUNCTION ensure_skill_criterion_binding() IS 'Ownership and immutable stable-criterion guard for current skill writers.';


--
-- Name: ensure_skill_version_criterion_binding(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION ensure_skill_version_criterion_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  stable_criterion_id text;
begin
  if tg_op = 'UPDATE' and new.criterion_version_id is distinct from old.criterion_version_id then
    raise exception 'a skill version cannot change criterion version'
      using errcode = '55000';
  end if;
  select skill.criterion_id into stable_criterion_id
  from skills skill
  where skill.id = new.skill_id
    and skill.project_id = new.project_id;
  if stable_criterion_id is null then
    raise exception 'skill version must reference a skill in the same project'
      using errcode = '23514';
  end if;
  if new.criterion_version_id is null then
    raise exception 'skill version requires an explicit criterion version'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from criterion_versions version
    where version.id = new.criterion_version_id
      and version.project_id = new.project_id
      and version.criterion_id = stable_criterion_id
  ) then
    raise exception 'skill version criterion must match its skill lineage and project'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: FUNCTION ensure_skill_version_criterion_binding(); Type: COMMENT; Schema: current; Owner: -
--

COMMENT ON FUNCTION ensure_skill_version_criterion_binding() IS 'Ownership and immutable criterion-definition guard for current skill-version writers.';


--
-- Name: evaluator_lifecycle_calibration_admissibility_v1(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION evaluator_lifecycle_calibration_admissibility_v1(target_skill_version_id text) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
declare
  head evaluator_lifecycle_events%rowtype;
  completion_at timestamptz;
  run_revision_id text;
  artifact_status text;
begin
  select event.* into head
  from evaluator_lifecycles lifecycle
  cross join lateral evaluator_lifecycle_head_v1(lifecycle.id) event
  where lifecycle.skill_version_id = target_skill_version_id;
  if head.id is null or head.state <> 'active' or head.calibration_artifact_id is null then
    return 'not_applicable';
  end if;
  select artifact.status,run.dataset_revision_id,completion.recorded_at
    into artifact_status,run_revision_id,completion_at
  from binary_calibration_artifacts artifact
  join binary_calibration_runs run on run.id=artifact.run_id
  join binary_calibration_exposure_checks completion
    on completion.id=run.completion_check_id and completion.phase='completion'
  where artifact.id=head.calibration_artifact_id
    and artifact.project_id=head.project_id
    and run.skill_version_id=head.skill_version_id;
  if artifact_status is null then return 'unknown'; end if;
  if artifact_status <> 'complete' then return 'revoked'; end if;
  if exists (select 1 from binary_calibration_revocation_events revocation
             where revocation.artifact_id=head.calibration_artifact_id) then
    return 'revoked';
  end if;
  if exists (
    select 1 from dataset_exposure_events exposure
    where exposure.revision_id=run_revision_id
      and exposure.occurred_at >= completion_at
      and (exposure.exposure_class='development' or exposure.activity in (
        'declassify','analysis_authoring','rubric_authoring','prompt_tuning',
        'example_selection','model_selection','development_run','regression_run'
      ))
  ) then return 'revoked'; end if;
  return 'admissible';
end;
$$;


--
-- Name: evaluator_lifecycles; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE evaluator_lifecycles (
    id text NOT NULL,
    contract_version text NOT NULL,
    project_id text NOT NULL,
    criterion_id text NOT NULL,
    criterion_version_id text NOT NULL,
    skill_id text NOT NULL,
    skill_version_id text NOT NULL,
    promotion_id text NOT NULL,
    governed_batch_id text NOT NULL,
    governed_batch_digest text NOT NULL,
    truth_dataset_revision_id text NOT NULL,
    truth_revision_digest text NOT NULL,
    truth_content_digest text NOT NULL,
    truth_item_count integer NOT NULL,
    regression_dataset_revision_id text NOT NULL,
    regression_revision_digest text NOT NULL,
    regression_content_digest text NOT NULL,
    regression_item_count integer NOT NULL,
    developer_exposure_event_id text NOT NULL,
    created_by_user_id text NOT NULL,
    created_by_subject_id text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    content_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT date_trunc('milliseconds'::text, clock_timestamp()) NOT NULL,
    CONSTRAINT evaluator_lifecycles_check CHECK ((truth_item_count = regression_item_count)),
    CONSTRAINT evaluator_lifecycles_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT evaluator_lifecycles_contract_version_check CHECK ((contract_version = 'coeval/evaluator-lifecycle/v1'::text)),
    CONSTRAINT evaluator_lifecycles_governed_batch_digest_check CHECK ((governed_batch_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT evaluator_lifecycles_idempotency_key_check CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 240))),
    CONSTRAINT evaluator_lifecycles_regression_content_digest_check CHECK ((regression_content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT evaluator_lifecycles_regression_item_count_check CHECK (((regression_item_count >= 1) AND (regression_item_count <= 10000))),
    CONSTRAINT evaluator_lifecycles_regression_revision_digest_check CHECK ((regression_revision_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT evaluator_lifecycles_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT evaluator_lifecycles_truth_content_digest_check CHECK ((truth_content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT evaluator_lifecycles_truth_item_count_check CHECK (((truth_item_count >= 1) AND (truth_item_count <= 10000))),
    CONSTRAINT evaluator_lifecycles_truth_revision_digest_check CHECK ((truth_revision_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: evaluator_lifecycle_content_digest_v1(evaluator_lifecycles); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION evaluator_lifecycle_content_digest_v1(row_value evaluator_lifecycles) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select governed_content_v1_digest('evaluator-lifecycle/v1',jsonb_build_object(
    'contractVersion',row_value.contract_version,
    'createdBySubjectId',row_value.created_by_subject_id,
    'createdByUserId',row_value.created_by_user_id,
    'criterionId',row_value.criterion_id,
    'criterionVersionId',row_value.criterion_version_id,
    'developerExposureEventId',row_value.developer_exposure_event_id,
    'governedBatchDigest',row_value.governed_batch_digest,
    'governedBatchId',row_value.governed_batch_id,
    'id',row_value.id,
    'idempotencyKey',row_value.idempotency_key,
    'projectId',row_value.project_id,
    'promotionId',row_value.promotion_id,
    'regressionContentDigest',row_value.regression_content_digest,
    'regressionDatasetRevisionId',row_value.regression_dataset_revision_id,
    'regressionItemCount',row_value.regression_item_count,
    'regressionRevisionDigest',row_value.regression_revision_digest,
    'requestDigest',row_value.request_digest,
    'skillId',row_value.skill_id,
    'skillVersionId',row_value.skill_version_id,
    'truthContentDigest',row_value.truth_content_digest,
    'truthDatasetRevisionId',row_value.truth_dataset_revision_id,
    'truthItemCount',row_value.truth_item_count,
    'truthRevisionDigest',row_value.truth_revision_digest
  ))
$$;


--
-- Name: evaluator_lifecycle_events; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE evaluator_lifecycle_events (
    id text NOT NULL,
    contract_version text NOT NULL,
    lifecycle_id text NOT NULL,
    project_id text NOT NULL,
    criterion_id text NOT NULL,
    skill_version_id text NOT NULL,
    sequence bigint NOT NULL,
    transition text NOT NULL,
    state text NOT NULL,
    predecessor_event_id text,
    predecessor_event_digest text,
    activation_bundle_id text,
    calibration_artifact_id text,
    calibration_artifact_digest text,
    calibration_evidence_digest text,
    regression_run_id text,
    regression_dataset_revision_id text,
    replaced_skill_version_id text,
    actor_user_id text,
    actor_subject_id text,
    actor_role text NOT NULL,
    reason text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    content_digest text NOT NULL,
    occurred_at timestamp with time zone DEFAULT date_trunc('milliseconds'::text, clock_timestamp()) NOT NULL,
    CONSTRAINT evaluator_lifecycle_events_actor_role_check CHECK ((actor_role = ANY (ARRAY['owner'::text, 'system'::text]))),
    CONSTRAINT evaluator_lifecycle_events_calibration_artifact_digest_check CHECK (((calibration_artifact_digest IS NULL) OR (calibration_artifact_digest ~ '^sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT evaluator_lifecycle_events_calibration_evidence_digest_check CHECK (((calibration_evidence_digest IS NULL) OR (calibration_evidence_digest ~ '^sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT evaluator_lifecycle_events_check CHECK (((sequence = 1) = (transition = 'candidate_created'::text))),
    CONSTRAINT evaluator_lifecycle_events_check1 CHECK (((sequence = 1) = (predecessor_event_id IS NULL))),
    CONSTRAINT evaluator_lifecycle_events_check10 CHECK (((calibration_artifact_id IS NULL) = (regression_run_id IS NULL))),
    CONSTRAINT evaluator_lifecycle_events_check11 CHECK (((calibration_artifact_id IS NULL) = (regression_dataset_revision_id IS NULL))),
    CONSTRAINT evaluator_lifecycle_events_check12 CHECK ((((actor_role = 'owner'::text) AND (actor_user_id IS NOT NULL) AND (actor_subject_id IS NOT NULL)) OR ((actor_role = 'system'::text) AND (actor_user_id IS NULL) AND (actor_subject_id IS NULL)))),
    CONSTRAINT evaluator_lifecycle_events_check2 CHECK (((predecessor_event_id IS NULL) = (predecessor_event_digest IS NULL))),
    CONSTRAINT evaluator_lifecycle_events_check3 CHECK (((transition = 'candidate_created'::text) = (state = 'candidate'::text))),
    CONSTRAINT evaluator_lifecycle_events_check4 CHECK (((transition = 'activated'::text) = (state = 'active'::text))),
    CONSTRAINT evaluator_lifecycle_events_check5 CHECK (((transition = 'calibration_revoked'::text) = (state = 'needs_review'::text))),
    CONSTRAINT evaluator_lifecycle_events_check6 CHECK (((transition = 'retired'::text) = (state = 'retired'::text))),
    CONSTRAINT evaluator_lifecycle_events_check7 CHECK (((transition = 'activated'::text) = (calibration_artifact_id IS NOT NULL))),
    CONSTRAINT evaluator_lifecycle_events_check8 CHECK (((calibration_artifact_id IS NULL) = (calibration_artifact_digest IS NULL))),
    CONSTRAINT evaluator_lifecycle_events_check9 CHECK (((calibration_artifact_id IS NULL) = (calibration_evidence_digest IS NULL))),
    CONSTRAINT evaluator_lifecycle_events_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT evaluator_lifecycle_events_contract_version_check CHECK ((contract_version = 'coeval/evaluator-lifecycle-event/v1'::text)),
    CONSTRAINT evaluator_lifecycle_events_idempotency_key_check CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 240))),
    CONSTRAINT evaluator_lifecycle_events_predecessor_event_digest_check CHECK (((predecessor_event_digest IS NULL) OR (predecessor_event_digest ~ '^sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT evaluator_lifecycle_events_reason_check CHECK (((char_length(btrim(reason)) >= 1) AND (char_length(btrim(reason)) <= 5000))),
    CONSTRAINT evaluator_lifecycle_events_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT evaluator_lifecycle_events_sequence_check CHECK ((sequence > 0)),
    CONSTRAINT evaluator_lifecycle_events_state_check CHECK ((state = ANY (ARRAY['candidate'::text, 'active'::text, 'needs_review'::text, 'retired'::text]))),
    CONSTRAINT evaluator_lifecycle_events_transition_check CHECK ((transition = ANY (ARRAY['candidate_created'::text, 'activated'::text, 'calibration_revoked'::text, 'retired'::text])))
);


--
-- Name: evaluator_lifecycle_event_content_digest_v1(evaluator_lifecycle_events); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION evaluator_lifecycle_event_content_digest_v1(row_value evaluator_lifecycle_events) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select governed_content_v1_digest('evaluator-lifecycle-event/v1',jsonb_build_object(
    'activationBundleId',row_value.activation_bundle_id,
    'activationEvidence',case when row_value.calibration_artifact_id is null then null else jsonb_build_object(
      'calibrationArtifactDigest',row_value.calibration_artifact_digest,
      'calibrationArtifactId',row_value.calibration_artifact_id,
      'calibrationEvidenceDigest',row_value.calibration_evidence_digest,
      'regressionDatasetRevisionId',row_value.regression_dataset_revision_id,
      'regressionRunId',row_value.regression_run_id
    ) end,
    'actorRole',row_value.actor_role,
    'actorSubjectId',row_value.actor_subject_id,
    'actorUserId',row_value.actor_user_id,
    'contractVersion',row_value.contract_version,
    'criterionId',row_value.criterion_id,
    'id',row_value.id,
    'idempotencyKey',row_value.idempotency_key,
    'lifecycleId',row_value.lifecycle_id,
    'predecessorEventDigest',row_value.predecessor_event_digest,
    'predecessorEventId',row_value.predecessor_event_id,
    'projectId',row_value.project_id,
    'reason',row_value.reason,
    'replacedSkillVersionId',row_value.replaced_skill_version_id,
    'requestDigest',row_value.request_digest,
    'sequence',row_value.sequence::text,
    'skillVersionId',row_value.skill_version_id,
    'state',row_value.state,
    'transition',row_value.transition
  ))
$$;


--
-- Name: evaluator_lifecycle_event_request_digest_v1(evaluator_lifecycle_events); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION evaluator_lifecycle_event_request_digest_v1(row_value evaluator_lifecycle_events) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
declare
  predecessor evaluator_lifecycle_events%rowtype;
  replaced_predecessor evaluator_lifecycle_events%rowtype;
  revocation_id text;
begin
  if row_value.transition='candidate_created' then
    return governed_content_v1_digest(
      'evaluator-lifecycle-candidate-created-request/v1',
      jsonb_build_object('lifecycleId',row_value.lifecycle_id,'skillVersionId',row_value.skill_version_id)
    );
  end if;
  select * into predecessor from evaluator_lifecycle_events where id=row_value.predecessor_event_id;
  if row_value.transition='retired' and row_value.activation_bundle_id is null then
    return governed_content_v1_digest(
      'evaluator-lifecycle-retired-request/v1',
      jsonb_build_object(
        'expectedEventDigest',predecessor.content_digest,
        'expectedEventId',predecessor.id,
        'expectedSequence',predecessor.sequence::text,
        'expectedState',predecessor.state,
        'projectId',row_value.project_id,
        'rationale',row_value.reason,
        'skillVersionId',row_value.skill_version_id
      )
    );
  end if;
  if row_value.transition='activated' then
    if row_value.replaced_skill_version_id is not null then
      select prior.* into replaced_predecessor
      from evaluator_lifecycle_events retired
      join evaluator_lifecycle_events prior on prior.id=retired.predecessor_event_id
      where retired.activation_bundle_id=row_value.activation_bundle_id
        and retired.transition='retired'
        and retired.skill_version_id=row_value.replaced_skill_version_id;
    end if;
    return governed_content_v1_digest(
      'evaluator-lifecycle-activated-request/v1',
      jsonb_build_object(
        'calibrationArtifactId',row_value.calibration_artifact_id,
        'expectedCalibrationArtifactDigest',row_value.calibration_artifact_digest,
        'expectedCalibrationEvidenceDigest',row_value.calibration_evidence_digest,
        'expectedEventDigest',predecessor.content_digest,
        'expectedEventId',predecessor.id,
        'expectedPriorActiveEventDigest',replaced_predecessor.content_digest,
        'expectedPriorActiveEventId',replaced_predecessor.id,
        'expectedPriorActiveSkillVersionId',row_value.replaced_skill_version_id,
        'expectedSequence',predecessor.sequence::text,
        'expectedState',predecessor.state,
        'projectId',row_value.project_id,
        'rationale',row_value.reason,
        'regressionRunId',row_value.regression_run_id,
        'skillVersionId',row_value.skill_version_id
      )
    );
  end if;
  if row_value.transition='calibration_revoked' then
    revocation_id:=nullif(substr(row_value.idempotency_key,length('calibration-revocation:')+1),'');
    if revocation_id is null or not exists (
      select 1 from binary_calibration_revocation_events revocation
      where revocation.id=revocation_id and revocation.project_id=row_value.project_id
    ) then return null;
    end if;
    return governed_content_v1_digest(
      'evaluator-lifecycle-revocation-request/v1',
      jsonb_build_object(
        'artifactId',(select artifact_id from binary_calibration_revocation_events where id=revocation_id),
        'lifecycleId',row_value.lifecycle_id,
        'revocationId',revocation_id
      )
    );
  end if;
  -- A replacement retirement carries the activation request digest and is
  -- checked reciprocally by the deferred activation bundle guard.
  return row_value.request_digest;
end;
$$;


--
-- Name: evaluator_lifecycle_head_v1(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION evaluator_lifecycle_head_v1(target_lifecycle_id text) RETURNS evaluator_lifecycle_events
    LANGUAGE sql STABLE
    AS $$
  select event.* from evaluator_lifecycle_events event
  where event.lifecycle_id = target_lifecycle_id
  order by event.sequence desc,event.id desc limit 1
$$;


--
-- Name: evaluator_lifecycle_request_digest_v1(evaluator_lifecycles); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION evaluator_lifecycle_request_digest_v1(row_value evaluator_lifecycles) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select governed_content_v1_digest('evaluator-candidate-request/v1',jsonb_build_object(
    'criterionId',row_value.criterion_id,
    'criterionVersionId',row_value.criterion_version_id,
    'expectedBatchDigest',row_value.governed_batch_digest,
    'expectedTruthContentDigest',row_value.truth_content_digest,
    'expectedTruthRevisionDigest',row_value.truth_revision_digest,
    'governedBatchId',row_value.governed_batch_id,
    'modelBinding',(select version.model_binding from skill_versions version where version.id=row_value.skill_version_id),
    'outputSchema',(select version.output_schema from skill_versions version where version.id=row_value.skill_version_id),
    'prompt',(select version.prompt from skill_versions version where version.id=row_value.skill_version_id),
    'projectId',row_value.project_id,
    'rubricMarkdown',(select version.rubric_markdown from skill_versions version where version.id=row_value.skill_version_id),
    'skillDescription',(select skill.description from skills skill where skill.id=row_value.skill_id),
    'skillName',(select skill.name from skills skill where skill.id=row_value.skill_id),
    'truthDatasetRevisionId',row_value.truth_dataset_revision_id
  ))
$$;


--
-- Name: evaluator_skill_version_context_allowed_v1(text, text, text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION evaluator_skill_version_context_allowed_v1(target_project_id text, target_skill_version_id text, target_context text) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
declare
  governed boolean;
  lifecycle_id text;
  head evaluator_lifecycle_events%rowtype;
begin
  select criterion.source_kind='analysis_promotion',lifecycle.id
    into governed,lifecycle_id
  from skill_versions version
  join criterion_versions definition on definition.id=version.criterion_version_id
  join criteria criterion on criterion.id=definition.criterion_id
  left join evaluator_lifecycles lifecycle on lifecycle.skill_version_id=version.id
  where version.id=target_skill_version_id and version.project_id=target_project_id;
  if governed is null then return false; end if;
  if lifecycle_id is null then return governed is false; end if;
  select * into head from evaluator_lifecycle_head_v1(lifecycle_id);
  if head.id is null or head.state='retired' then return false; end if;
  if target_context in (
    'explicit_nonproduction_dataset','governed_nonsealed_evaluation',
    'binary_calibration_evidence','candidate_regression_evidence'
  ) then return true; end if;
  return head.state='active'
    and evaluator_lifecycle_calibration_admissibility_v1(target_skill_version_id)='admissible';
end;
$$;


--
-- Name: evaluator_suite_manifest_v1_canonical_json(jsonb, boolean); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION evaluator_suite_manifest_v1_canonical_json(artifact jsonb, include_manifest_digest boolean) RETURNS text
    LANGUAGE plpgsql IMMUTABLE STRICT
    AS $$
declare
  member jsonb;
  member_json text;
  members_json text := '';
  trial_plan_json text;
  position integer;
begin
  if artifact -> 'trialPlan' = 'null'::jsonb then
    trial_plan_json := 'null';
  else
    trial_plan_json :=
      '{"kind":' || to_json(artifact -> 'trialPlan' ->> 'kind')::text ||
      ',"trialsPerItem":' || ((artifact -> 'trialPlan' ->> 'trialsPerItem')::integer)::text || '}';
  end if;
  for position in 0..jsonb_array_length(artifact -> 'members') - 1 loop
    member := artifact -> 'members' -> position;
    member_json :=
      '{"applicability":{"kind":' || to_json(member -> 'applicability' ->> 'kind')::text || '}' ||
      ',"criterionDefinition":' || to_json(member ->> 'criterionDefinition')::text ||
      ',"criterionDigest":' || to_json(member ->> 'criterionDigest')::text ||
      ',"criterionId":' || to_json(member ->> 'criterionId')::text ||
      ',"criterionName":' || to_json(member ->> 'criterionName')::text ||
      ',"criterionVersionId":' || to_json(member ->> 'criterionVersionId')::text ||
      ',"outputContractDigest":' || to_json(member ->> 'outputContractDigest')::text ||
      ',"position":' || ((member ->> 'position')::integer)::text ||
      ',"skillDigest":' || to_json(member ->> 'skillDigest')::text ||
      ',"skillId":' || to_json(member ->> 'skillId')::text ||
      ',"skillVersionId":' || to_json(member ->> 'skillVersionId')::text || '}';
    if position > 0 then members_json := members_json || ','; end if;
    members_json := members_json || member_json;
  end loop;
  return
    '{"contract":' || to_json(artifact ->> 'contract')::text ||
    case when include_manifest_digest
      then ',"manifestDigest":' || to_json(artifact ->> 'manifestDigest')::text
      else ''
    end ||
    ',"manifestId":' || to_json(artifact ->> 'manifestId')::text ||
    ',"members":[' || members_json || ']' ||
    ',"projectId":' || to_json(artifact ->> 'projectId')::text ||
    ',"revision":' || ((artifact ->> 'revision')::integer)::text ||
    ',"schemaVersion":' || ((artifact ->> 'schemaVersion')::integer)::text ||
    ',"suiteId":' || to_json(artifact ->> 'suiteId')::text ||
    ',"trialPlan":' || trial_plan_json || '}';
end;
$$;


--
-- Name: governed_bounded_text_array(text[], integer, integer, integer); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION governed_bounded_text_array(values_value text[], max_items integer, max_item_octets integer, max_total_octets integer) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
  select cardinality(values_value) <= max_items
    and coalesce((select max(octet_length(value)) from unnest(values_value) value), 0) <= max_item_octets
    and coalesce((select sum(octet_length(value)) from unnest(values_value) value), 0) <= max_total_octets
$$;


--
-- Name: governed_bytes_v1_digest(bytea); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION governed_bytes_v1_digest(bytes_value bytea) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
  select 'sha256:' || encode(sha256(bytes_value), 'hex')
$$;


--
-- Name: governed_content_v1_digest(text, jsonb); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION governed_content_v1_digest(kind_value text, content_value jsonb) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  select 'sha256:' || encode(sha256(convert_to(
    governed_canonical_json_v1(jsonb_build_object('content', content_value, 'kind', kind_value)),
    'UTF8'
  )), 'hex')
$$;


--
-- Name: governed_nonempty_text_array(text[]); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION governed_nonempty_text_array(values_value text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
  select not exists (
    select 1 from unnest(values_value) value where length(value) = 0
  )
$$;


--
-- Name: governed_review_current_batch_state(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION governed_review_current_batch_state(batch_id_value text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select coalesce((
    select event.event_kind
    from governed_review_batch_events event
    where event.batch_id = batch_id_value
    order by event.state_version desc
    limit 1
  ), 'draft')
$$;


--
-- Name: governed_review_current_task_state(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION governed_review_current_task_state(task_id_value text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select coalesce((
    select case event.event_kind
      when 'resumed' then 'viewed'
      when 'label_submitted' then 'submitted'
      when 'label_withdrawn' then 'withdrawn'
      else event.event_kind
    end
    from governed_review_task_events event
    where event.task_id = task_id_value
    order by event.state_version desc
    limit 1
  ), 'assigned')
$$;


--
-- Name: governed_review_draw_digest(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION governed_review_draw_digest(batch_id_value text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select governed_content_v1_digest(
    'governed-review-draw/v1',
    coalesce(jsonb_agg(jsonb_build_object(
      'drawPosition', item.draw_position,
      'frameMemberDigest', item.frame_member_digest,
      'inclusionProbability', item.inclusion_probability,
      'reviewItemId', item.review_item_id,
      'samplingWeight', item.sampling_weight,
      'stratumKey', item.stratum_key
    ) order by item.draw_position), '[]'::jsonb)
  )
  from governed_review_batch_items item
  where item.batch_id = batch_id_value
$$;


--
-- Name: governed_review_has_eligible_capability_check(text, text, text, text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION governed_review_has_eligible_capability_check(batch_id_value text, scope_value text, subject_id_value text, evaluator_version_id_value text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  select coalesce((
    select check_row.result = 'eligible'
      and not exists (
        select 1
        from governed_reviewer_subjects subject
        join dataset_exposure_events exposure
          on exposure.project_id = subject.project_id
         and exposure.exposure_class = 'development'
         and (
           exposure.subject_id = subject.id
           or (subject.account_user_id is not null
             and exposure.subject_id = subject.account_user_id)
         )
        where subject.id = check_row.subject_id
          and subject.project_id = check_row.project_id
      )
    from governed_review_capability_checks check_row
    where check_row.batch_id = batch_id_value
      and check_row.check_scope = scope_value
      and check_row.subject_id = subject_id_value
      and check_row.evaluator_version_id is not distinct from evaluator_version_id_value
    order by check_row.sequence desc
    limit 1
  ), false)
$$;


--
-- Name: governed_review_item_label_set_digest(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION governed_review_item_label_set_digest(batch_item_id_value text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select governed_content_v1_digest(
    'governed-review-item-label-set/v1',
    coalesce(jsonb_agg(jsonb_build_object(
      'labelId', active.label_id,
      'taskId', active.task_id
    ) order by active.task_id, active.label_id), '[]'::jsonb)
  )
  from governed_active_review_labels active
  where active.batch_item_id = batch_item_id_value
$$;


--
-- Name: governed_review_item_resolution(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION governed_review_item_resolution(batch_item_id_value text) RETURNS TABLE(resolution_kind text, resolved_label text, adjudication_id text)
    LANGUAGE plpgsql STABLE
    AS $$
declare
  required_count integer;
  task_count integer;
  active_count integer;
  pass_count integer;
  fail_count integer;
  cannot_count integer;
  head governed_review_adjudications%rowtype;
begin
  select batch.required_labels_per_item
    into required_count
  from governed_review_batch_items item
  join governed_review_batches batch on batch.id = item.batch_id
  where item.id = batch_item_id_value;
  if required_count is null then return; end if;

  select count(*)::integer into task_count
  from governed_review_tasks task where task.batch_item_id = batch_item_id_value;
  select count(*)::integer,
         count(*) filter (where active.label = 'pass')::integer,
         count(*) filter (where active.label = 'fail')::integer,
         count(*) filter (where active.label = 'cannot_determine')::integer
    into active_count, pass_count, fail_count, cannot_count
  from governed_active_review_labels active
  where active.batch_item_id = batch_item_id_value;

  if task_count <> required_count or active_count <> required_count then
    return query select 'coverage_gap'::text, null::text, null::text;
    return;
  end if;
  if cannot_count = 0 and pass_count = required_count then
    return query select case when required_count = 1 then 'single_rater' else 'unanimous' end,
                        'pass'::text, null::text;
    return;
  end if;
  if cannot_count = 0 and fail_count = required_count then
    return query select case when required_count = 1 then 'single_rater' else 'unanimous' end,
                        'fail'::text, null::text;
    return;
  end if;

  select candidate.* into head
  from governed_review_adjudications candidate
  where candidate.batch_item_id = batch_item_id_value
    and not exists (
      select 1 from governed_review_adjudications successor
      where successor.supersedes_adjudication_id = candidate.id
    )
  limit 1;
  if head.id is null then
    return query select 'conflict'::text, null::text, null::text;
  elsif head.decision = 'unresolvable' then
    return query select 'unresolvable'::text, null::text, head.id;
  else
    return query select 'adjudicated'::text, head.decision, head.id;
  end if;
end;
$$;


--
-- Name: governed_review_label_set_digest(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION governed_review_label_set_digest(batch_id_value text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select governed_content_v1_digest(
    'governed-review-label-set/v1',
    coalesce(jsonb_agg(jsonb_build_object(
      'batchItemId', active.batch_item_id,
      'labelId', active.label_id,
      'taskId', active.task_id
    ) order by active.batch_item_id, active.task_id, active.label_id), '[]'::jsonb)
  )
  from governed_active_review_labels active
  where active.batch_id = batch_id_value
$$;


--
-- Name: governed_review_payload_v1_is_safe(jsonb); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION governed_review_payload_v1_is_safe(payload_value jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
  select jsonb_typeof(payload_value) = 'object'
    and not exists (
      select 1 from jsonb_object_keys(payload_value) key
      where key not in ('input','output','steps')
    )
    and payload_value ? 'input'
    and payload_value ? 'output'
    and (
      not payload_value ? 'steps'
      or (
        jsonb_typeof(payload_value -> 'steps') = 'array'
        and jsonb_array_length(payload_value -> 'steps') <= 1000
        and not exists (
          select 1
          from jsonb_array_elements(payload_value -> 'steps') step
          where jsonb_typeof(step) <> 'object'
            or not step ? 'input'
            or not step ? 'output'
            or (
              step ? 'name'
              and (
                jsonb_typeof(step -> 'name') <> 'string'
                or length(step ->> 'name') = 0
                or octet_length(step ->> 'name') > 1024
              )
            )
            or exists (
              select 1 from jsonb_object_keys(step) key
              where key not in ('name','input','output')
            )
        )
      )
    )
$$;


--
-- Name: governed_sealed_intake_frame_digest(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION governed_sealed_intake_frame_digest(population_id_value text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select governed_content_v1_digest(
    'governed-sealed-intake-frame/v1',
    coalesce(jsonb_agg(jsonb_build_object(
      'framePosition', item.sealed_frame_position,
      'inputDigest', item.input_digest,
      'reviewItemId', item.id
    ) order by item.sealed_frame_position), '[]'::jsonb)
  )
  from governed_review_items item
  where item.sealed_intake_population_id = population_id_value
$$;


--
-- Name: governed_utf16_sort_key_v1(text); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION governed_utf16_sort_key_v1(value text) RETURNS integer[]
    LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
declare
  result integer[] := '{}'::integer[];
  code_point integer;
  index_value integer;
begin
  for index_value in 1..char_length(value) loop
    code_point := ascii(substr(value, index_value, 1));
    if code_point <= 65535 then
      result := array_append(result, code_point);
    else
      code_point := code_point - 65536;
      result := array_append(result, 55296 + (code_point / 1024));
      result := array_append(result, 56320 + (code_point % 1024));
    end if;
  end loop;
  return result;
end;
$$;


--
-- Name: guard_activated_regression_run_immutable_v1(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_activated_regression_run_immutable_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if exists (
    select 1 from evaluator_lifecycle_events event
    where event.regression_run_id=old.id and event.transition='activated'
  ) then
    raise exception 'regression evidence cited by evaluator activation is immutable' using errcode='55000';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;


--
-- Name: guard_analysis_6b2_append_only(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_6b2_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'UPDATE' then
    raise exception '% rows are append-only', tg_table_name using errcode = '55000';
  end if;
  if tg_op = 'DELETE' and exists (
    select 1 from projects project where project.id = old.project_id
  ) then
    raise exception '% rows are append-only while their project exists', tg_table_name
      using errcode = '55000';
  end if;
  return old;
end;
$$;


--
-- Name: guard_analysis_6b3_append_only(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_6b3_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'UPDATE' then
    raise exception '% rows are append-only', tg_table_name using errcode = '55000';
  end if;
  if tg_op = 'DELETE' and exists (
    select 1 from projects project where project.id = old.project_id
  ) then
    raise exception '% rows are append-only while their project exists', tg_table_name
      using errcode = '55000';
  end if;
  return old;
end;
$$;


--
-- Name: guard_analysis_criterion_promotion(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_criterion_promotion() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  study analysis_studies%rowtype;
  closure_row analysis_study_closures%rowtype;
  revision dataset_revisions%rowtype;
  taxonomy_revision analysis_failure_taxonomy_revisions%rowtype;
  code_entry analysis_failure_taxonomy_revision_codes%rowtype;
begin
  -- Do exact tenant ownership checks before taking caller-controlled advisory
  -- locks. Foreign guessed IDs therefore fail without cross-project contention.
  select * into study from analysis_studies row_value
  where row_value.id = new.study_id and row_value.project_id = new.project_id;
  select * into taxonomy_revision from analysis_failure_taxonomy_revisions row_value
  where row_value.id = new.taxonomy_revision_id
    and row_value.taxonomy_id = new.taxonomy_id
    and row_value.project_id = new.project_id;
  if study.id is null or taxonomy_revision.id is null then
    raise exception 'analysis promotion must bind an exact project study and taxonomy revision'
      using errcode = '23514';
  end if;

  -- Assignment mutations already use this canonical order. Preserve it so a
  -- promotion cannot deadlock a concurrent assignment or taxonomy successor.
  perform analysis_study_lock_v1(new.study_id);
  perform analysis_taxonomy_lock_v1(new.taxonomy_id);

  select * into study from analysis_studies row_value
  where row_value.id = new.study_id and row_value.project_id = new.project_id;
  select * into closure_row from analysis_study_closures row_value
  where row_value.id = new.study_closure_id
    and row_value.project_id = new.project_id
    and row_value.study_id = new.study_id;
  select * into revision from dataset_revisions row_value
  where row_value.id = new.source_dataset_revision_id
    and row_value.project_id = new.project_id
  for key share;
  select * into taxonomy_revision from analysis_failure_taxonomy_revisions row_value
  where row_value.id = new.taxonomy_revision_id
    and row_value.taxonomy_id = new.taxonomy_id
    and row_value.project_id = new.project_id;
  select * into code_entry from analysis_failure_taxonomy_revision_codes row_value
  where row_value.id = new.code_entry_id
    and row_value.project_id = new.project_id
    and row_value.taxonomy_id = new.taxonomy_id
    and row_value.taxonomy_revision_id = new.taxonomy_revision_id
    and row_value.code_id = new.code_id;

  if not analysis_actor_has_role_v1(
       new.project_id, new.promoted_by_user_id, new.promoted_by_subject_id, 'owner'
     ) or new.promoter_role <> 'owner' then
    raise exception 'analysis promotion requires the exact current project owner subject'
      using errcode = '23514';
  end if;
  if analysis_study_state_v1(new.study_id) not in ('coding_closed','completed')
     or closure_row.id is null
     or closure_row.closure_digest <> new.study_closure_digest
     or closure_row.population_id <> new.population_id
     or closure_row.draw_id <> new.draw_id
     or closure_row.dataset_revision_id <> new.source_dataset_revision_id
     or study.population_id <> new.population_id
     or study.draw_id <> new.draw_id
     or study.dataset_revision_id <> new.source_dataset_revision_id then
    raise exception 'analysis promotion requires the exact closed study and immutable closure'
      using errcode = '23514';
  end if;
  if revision.id is null
     or revision.role <> 'analysis_authoring'
     or revision.source_kind <> 'analysis_population'
     or revision.content_digest <> new.source_dataset_revision_content_digest
     or revision.revision_digest <> new.source_dataset_revision_digest then
    raise exception 'analysis promotion handoff must bind the exact analysis-authoring revision'
      using errcode = '23514';
  end if;
  if taxonomy_revision.sequence <> new.taxonomy_revision_sequence
     or taxonomy_revision.revision_digest <> new.taxonomy_revision_digest
     or exists (
       select 1 from analysis_failure_taxonomy_revisions successor
       where successor.predecessor_revision_id = taxonomy_revision.id
     ) then
    raise exception 'analysis promotion must target the exact current taxonomy head'
      using errcode = '23514';
  end if;
  if code_entry.id is null
     or code_entry.status <> 'active'
     or code_entry.entry_digest <> new.code_entry_digest
     or code_entry.label <> new.code_label
     or code_entry.definition <> new.code_definition then
    raise exception 'analysis promotion must target one active code entry in the exact taxonomy head'
      using errcode = '23514';
  end if;
  if new.criterion_stable_key <> 'analysis-failure-code:' || new.code_id
     or char_length(new.criterion_stable_key) > 200
     or new.criterion_digest <> criterion_v1_digest(
       new.criterion_id, new.criterion_version_id,
       new.criterion_name, new.criterion_definition
     ) then
    raise exception 'analysis promotion criterion identity or digest is not canonical'
      using errcode = '23514';
  end if;
  new.created_at := analysis_linearization_clock_v1();
  return new;
end;
$$;


--
-- Name: guard_analysis_criterion_promotion_complete(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_criterion_promotion_complete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if (select count(*) from analysis_criterion_promotion_supports support
      where support.promotion_id = new.id) <> new.support_count
     or exists (
       select expected.position, expected.observation_event_id,
              expected.study_item_id, expected.closure_item_id,
              expected.assignment_event_id
       from (
         select row_number() over (
                  order by governed_utf16_sort_key_v1(support.observation_event_id),
                           governed_utf16_sort_key_v1(support.study_item_id),
                           governed_utf16_sort_key_v1(support.closure_item_id),
                           governed_utf16_sort_key_v1(support.assignment_event_id)
                ) - 1 as position,
                support.observation_event_id, support.study_item_id,
                support.closure_item_id, support.assignment_event_id
         from analysis_criterion_promotion_supports support
         where support.promotion_id = new.id
       ) expected
       except
       select support.position::bigint, support.observation_event_id,
              support.study_item_id, support.closure_item_id,
              support.assignment_event_id
       from analysis_criterion_promotion_supports support
       where support.promotion_id = new.id
     )
     or exists (
       select 1 from analysis_criterion_promotion_supports support
       where support.promotion_id = new.id
         and (support.project_id <> new.project_id
           or support.study_id <> new.study_id
           or support.closure_id <> new.study_closure_id
           or support.source_dataset_revision_id <> new.source_dataset_revision_id
           or support.created_at <> new.created_at
           or support.content_digest <>
                analysis_criterion_promotion_support_digest_v1(support))
     ) then
    raise exception 'analysis promotion must atomically bind its complete canonical support set'
      using errcode = '23514';
  end if;
  if new.support_set_digest <>
       analysis_criterion_promotion_support_set_digest_v1(new.id)
     or new.request_digest <>
       analysis_criterion_promotion_request_digest_v1(new.id)
     or new.handoff_digest <>
       analysis_criterion_promotion_handoff_digest_v1(new)
     or new.content_digest <>
       analysis_criterion_promotion_content_digest_v1(new) then
    raise exception 'analysis promotion canonical request, support, handoff, or content digest mismatch'
      using errcode = '23514';
  end if;
  if not exists (
       select 1 from criteria criterion
       where criterion.id = new.criterion_id
         and criterion.project_id = new.project_id
         and criterion.stable_key = new.criterion_stable_key
         and criterion.source_kind = 'analysis_promotion'
         and criterion.created_by_user_id = new.promoted_by_user_id
         and criterion.created_at = new.created_at
     )
     or not exists (
       select 1 from criterion_versions version
       where version.id = new.criterion_version_id
         and version.project_id = new.project_id
         and version.criterion_id = new.criterion_id
         and version.revision = 1
         and version.name = new.criterion_name
         and version.definition = new.criterion_definition
         and version.criterion_digest = new.criterion_digest
         and version.source_kind = 'analysis_promotion'
         and version.created_by_user_id = new.promoted_by_user_id
         and version.created_at = new.created_at
     )
     or (select count(*) from criterion_versions version
         where version.criterion_id = new.criterion_id) <> 1
     or exists (select 1 from skills skill where skill.criterion_id = new.criterion_id)
     or exists (
       select 1 from skill_versions version
       where version.criterion_version_id = new.criterion_version_id
     ) then
    raise exception 'analysis promotion must create only one immutable criterion definition and no evaluator'
      using errcode = '23514';
  end if;
  if not exists (
       select 1 from dataset_exposure_events exposure
       where exposure.id = new.criterion_authoring_exposure_event_id
         and exposure.project_id = new.project_id
         and exposure.evidence_ref_kind = 'analysis_criterion_promotion'
         and exposure.evidence_ref_id = new.id
     )
     or (select count(*) from dataset_exposure_events exposure
         where exposure.project_id = new.project_id
           and exposure.evidence_ref_kind = 'analysis_criterion_promotion'
           and exposure.evidence_ref_id = new.id) <> new.support_count + 1
     or exists (
       select 1 from analysis_criterion_promotion_supports support
       where support.promotion_id = new.id and not exists (
         select 1 from dataset_exposure_events exposure
         where exposure.id = support.example_selection_exposure_event_id
           and exposure.project_id = new.project_id
           and exposure.evidence_ref_kind = 'analysis_criterion_promotion'
           and exposure.evidence_ref_id = new.id
       )
     ) then
    raise exception 'analysis promotion and complete development exposure fanout must commit atomically'
      using errcode = '23514';
  end if;
  return null;
end;
$$;


--
-- Name: guard_analysis_criterion_promotion_support(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_criterion_promotion_support() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  promotion analysis_criterion_promotions%rowtype;
  closure_item analysis_study_closure_items%rowtype;
  study_item analysis_study_items%rowtype;
  revision_item dataset_revision_items%rowtype;
  observation analysis_study_item_events%rowtype;
  assignment analysis_observation_assignment_events%rowtype;
  aligned_observation_digest text;
  aligned_assignment_id text;
  aligned_assignment_digest text;
begin
  select * into promotion from analysis_criterion_promotions row_value
  where row_value.id = new.promotion_id and row_value.project_id = new.project_id;
  if promotion.id is null or new.position >= promotion.support_count then
    raise exception 'promotion support must bind one exact promotion position'
      using errcode = '23514';
  end if;
  perform analysis_study_lock_v1(promotion.study_id);
  perform analysis_taxonomy_lock_v1(promotion.taxonomy_id);

  select * into closure_item from analysis_study_closure_items row_value
  where row_value.id = new.closure_item_id
    and row_value.project_id = new.project_id
    and row_value.study_id = promotion.study_id
    and row_value.closure_id = promotion.study_closure_id;
  select * into study_item from analysis_study_items row_value
  where row_value.id = new.study_item_id
    and row_value.project_id = new.project_id
    and row_value.study_id = promotion.study_id;
  select * into revision_item from dataset_revision_items row_value
  where row_value.id = new.source_dataset_revision_item_id
    and row_value.project_id = new.project_id
    and row_value.revision_id = promotion.source_dataset_revision_id;
  select * into observation from analysis_study_item_events row_value
  where row_value.id = new.observation_event_id
    and row_value.project_id = new.project_id
    and row_value.study_id = promotion.study_id
    and row_value.study_item_id = new.study_item_id
    and row_value.event_type = 'failure_observed';
  select * into assignment from analysis_observation_assignment_events row_value
  where row_value.id = new.assignment_event_id
    and row_value.project_id = new.project_id
    and row_value.study_id = promotion.study_id
    and row_value.study_item_id = new.study_item_id
    and row_value.observation_event_id = new.observation_event_id;

  select closure_item.active_failure_observation_event_digests[index_value],
         closure_item.active_failure_assignment_event_ids[index_value],
         closure_item.active_failure_assignment_event_digests[index_value]
    into aligned_observation_digest, aligned_assignment_id, aligned_assignment_digest
  from generate_subscripts(
    closure_item.active_failure_observation_event_ids, 1
  ) index_value
  where closure_item.active_failure_observation_event_ids[index_value]
        = new.observation_event_id;

  if new.study_id <> promotion.study_id
     or new.closure_id <> promotion.study_closure_id
     or new.source_dataset_revision_id <> promotion.source_dataset_revision_id
     or closure_item.id is null
     or closure_item.content_digest <> new.closure_item_digest
     or closure_item.study_item_id <> new.study_item_id
     or study_item.id is null
     or study_item.revision_item_id <> new.source_dataset_revision_item_id
     or revision_item.id is null
     or revision_item.item_digest <> new.source_item_digest
     or observation.id is null
     or observation.event_digest <> new.observation_event_digest
     or observation.actor_user_id <> new.observation_author_user_id
     or observation.actor_subject_id <> new.observation_author_subject_id
     or aligned_observation_digest is distinct from new.observation_event_digest
     or aligned_assignment_id is distinct from new.assignment_event_id
     or aligned_assignment_digest is distinct from new.assignment_event_digest
     or assignment.id is null
     or assignment.event_digest <> new.assignment_event_digest
     or assignment.event_type <> 'assigned'
     or assignment.code_id <> promotion.code_id
     or not exists (
       select 1
       from analysis_observation_assignment_head_v1(
         new.observation_event_id, promotion.taxonomy_revision_sequence
       ) head
       where head.assignment_event_id = new.assignment_event_id
         and head.assignment_event_digest = new.assignment_event_digest
         and head.assignment_event_type = 'assigned'
         and head.taxonomy_id = promotion.taxonomy_id
         and head.code_id = promotion.code_id
     ) then
    raise exception 'promotion support must bind one closure-active observation and aligned assignment head'
      using errcode = '23514';
  end if;
  new.study_id := promotion.study_id;
  new.closure_id := promotion.study_closure_id;
  new.source_dataset_revision_id := promotion.source_dataset_revision_id;
  new.created_at := promotion.created_at;
  if new.content_digest <> analysis_criterion_promotion_support_digest_v1(new) then
    raise exception 'promotion support digest does not match canonical evidence'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_analysis_evidence_append_only(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_evidence_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'UPDATE' then
    raise exception '% rows are append-only', tg_table_name using errcode = '55000';
  end if;
  if tg_op = 'DELETE' and exists (
    select 1 from projects project where project.id = old.project_id
  ) then
    raise exception '% rows are append-only while their project exists', tg_table_name
      using errcode = '55000';
  end if;
  return old;
end;
$$;


--
-- Name: guard_analysis_failure_code(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_failure_code() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.created_at <> transaction_timestamp()
     or not analysis_actor_has_role_v1(
       new.project_id, new.created_by_user_id, new.created_by_subject_id, 'owner'
     ) or not exists (
       select 1 from analysis_failure_taxonomy_revisions revision
       where revision.id = new.created_in_revision_id
         and revision.project_id = new.project_id
         and revision.taxonomy_id = new.taxonomy_id
         and revision.created_by_user_id = new.created_by_user_id
         and revision.created_by_subject_id = new.created_by_subject_id
         and revision.created_at = new.created_at
     ) then
    raise exception 'failure code must be created atomically in its exact taxonomy revision'
      using errcode = '23514';
  end if;
  if new.content_digest <> analysis_failure_code_content_digest_v1(new) then
    raise exception 'failure code content digest does not match stable identity evidence'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_analysis_failure_taxonomy(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_failure_taxonomy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.created_at <> transaction_timestamp()
     or not analysis_actor_has_role_v1(
       new.project_id, new.created_by_user_id, new.created_by_subject_id, 'owner'
     ) then
    raise exception 'failure taxonomy creation requires the database clock and exact owner actor'
      using errcode = '23514';
  end if;
  if (select count(*) from jsonb_object_keys(new.request_payload)) <> 4
     or not new.request_payload ?& array['name','description','reason','codes']
     or new.request_payload ->> 'name' is distinct from new.name
     or new.request_payload ->> 'description' is distinct from new.description
     or jsonb_typeof(new.request_payload -> 'reason') <> 'string'
     or length(new.request_payload ->> 'reason') = 0
     or new.request_payload ->> 'reason' <> trim(new.request_payload ->> 'reason')
     or char_length(new.request_payload ->> 'reason') > 2000
     or jsonb_typeof(new.request_payload -> 'codes') <> 'array'
     or jsonb_array_length(new.request_payload -> 'codes') not between 1 and 1000
     or new.request_digest <> analysis_taxonomy_request_digest_v1(
       new.project_id, null, new.request_payload
     )
     or new.content_digest <> analysis_failure_taxonomy_content_digest_v1(new) then
    raise exception 'failure taxonomy request/content evidence is not canonical or exact'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_analysis_failure_taxonomy_complete(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_failure_taxonomy_complete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if not exists (
    select 1 from analysis_failure_taxonomy_revisions revision
    where revision.taxonomy_id = new.id
      and revision.project_id = new.project_id
      and revision.sequence = 1
      and revision.predecessor_revision_id is null
      and revision.created_by_user_id = new.created_by_user_id
      and revision.created_by_subject_id = new.created_by_subject_id
      and revision.created_at = new.created_at
      and revision.request_payload = new.request_payload
      and revision.request_digest = new.request_digest
  ) then
    raise exception 'failure taxonomy must atomically include its exact nonempty initial revision'
      using errcode = '23514';
  end if;
  return null;
end;
$$;


--
-- Name: guard_analysis_failure_taxonomy_revision(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_failure_taxonomy_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  existing analysis_failure_taxonomy_revisions%rowtype;
  head analysis_failure_taxonomy_revisions%rowtype;
  taxonomy_row analysis_failure_taxonomies%rowtype;
begin
  select * into existing from analysis_failure_taxonomy_revisions revision
  where revision.taxonomy_id = new.taxonomy_id
    and revision.idempotency_key = new.idempotency_key;
  if existing.id is not null then
    if existing.request_digest <> new.request_digest then
      raise exception 'taxonomy revision idempotency key already has a different request'
        using errcode = '23514';
    end if;
    raise exception 'taxonomy revision replay must reuse the existing revision'
      using errcode = '23505';
  end if;
  perform analysis_taxonomy_lock_v1(new.taxonomy_id);
  select * into existing from analysis_failure_taxonomy_revisions revision
  where revision.taxonomy_id = new.taxonomy_id
    and revision.idempotency_key = new.idempotency_key;
  if existing.id is not null then
    if existing.request_digest <> new.request_digest then
      raise exception 'taxonomy revision idempotency key already has a different request'
        using errcode = '23514';
    end if;
    raise exception 'taxonomy revision replay must reuse the existing revision'
      using errcode = '23505';
  end if;
  select * into taxonomy_row from analysis_failure_taxonomies row_value
  where row_value.id = new.taxonomy_id and row_value.project_id = new.project_id;
  if new.created_at <> transaction_timestamp()
     or not analysis_actor_has_role_v1(
       new.project_id, new.created_by_user_id, new.created_by_subject_id, 'owner'
     ) or not exists (
       select 1 from analysis_failure_taxonomies taxonomy_record
       where taxonomy_record.id = new.taxonomy_id
         and taxonomy_record.project_id = new.project_id
     ) then
    raise exception 'taxonomy revision requires its exact taxonomy, owner, and database clock'
      using errcode = '23514';
  end if;
  select * into head from analysis_failure_taxonomy_revisions revision
  where revision.taxonomy_id = new.taxonomy_id
  order by revision.sequence desc limit 1;
  if new.sequence <> coalesce(head.sequence, 0) + 1
     or new.predecessor_revision_id is distinct from head.id
     or new.predecessor_revision_digest is distinct from head.revision_digest then
    raise exception 'taxonomy revision compare-and-swap head mismatch'
      using errcode = '23514';
  end if;
  if new.sequence = 1 then
    if new.request_payload is distinct from taxonomy_row.request_payload
       or new.request_digest <> taxonomy_row.request_digest then
      raise exception 'initial taxonomy revision must retain the exact create request evidence'
        using errcode = '23514';
    end if;
  elsif (select count(*) from jsonb_object_keys(new.request_payload)) <> 5
     or not new.request_payload ?& array[
       'expectedPredecessorRevisionId','expectedPredecessorRevisionDigest',
       'expectedPredecessorSequence','reason','codes'
     ]
     or new.request_payload ->> 'expectedPredecessorRevisionId'
          is distinct from new.predecessor_revision_id
     or new.request_payload ->> 'expectedPredecessorRevisionDigest'
          is distinct from new.predecessor_revision_digest
     or (new.request_payload ->> 'expectedPredecessorSequence')::integer
          is distinct from new.sequence - 1
     or new.request_payload ->> 'reason' is distinct from new.reason
     or jsonb_typeof(new.request_payload -> 'codes') <> 'array'
     or jsonb_array_length(new.request_payload -> 'codes') <> new.code_count
     or new.request_digest <> analysis_taxonomy_request_digest_v1(
       new.project_id, new.taxonomy_id, new.request_payload
     ) then
    raise exception 'taxonomy successor request evidence does not match exact CAS input'
      using errcode = '23514';
  end if;
  if new.revision_digest <> analysis_taxonomy_revision_digest_v1(new) then
    raise exception 'taxonomy revision digest does not match canonical causal evidence'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_analysis_observation_assignment_event(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_observation_assignment_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  existing analysis_observation_assignment_events%rowtype;
  head analysis_observation_assignment_events%rowtype;
  observation analysis_study_item_events%rowtype;
  opened analysis_study_events%rowtype;
  target_revision analysis_failure_taxonomy_revisions%rowtype;
  linearized_at timestamptz;
begin
  select * into existing from analysis_observation_assignment_events event
  where event.observation_event_id = new.observation_event_id
    and event.idempotency_key = new.idempotency_key;
  if existing.id is not null then
    if existing.request_digest <> new.request_digest then
      raise exception 'assignment idempotency key already has a different request'
        using errcode = '23514';
    end if;
    raise exception 'assignment replay must reuse the existing event'
      using errcode = '23505';
  end if;

  perform analysis_study_lock_v1(new.study_id);
  perform analysis_taxonomy_lock_v1(new.taxonomy_id);
  linearized_at := analysis_linearization_clock_v1();
  select * into existing from analysis_observation_assignment_events event
  where event.observation_event_id = new.observation_event_id
    and event.idempotency_key = new.idempotency_key;
  if existing.id is not null then
    if existing.request_digest <> new.request_digest then
      raise exception 'assignment idempotency key already has a different request'
        using errcode = '23514';
    end if;
    raise exception 'assignment replay must reuse the existing event'
      using errcode = '23505';
  end if;
  if not analysis_actor_role_exact_v1(
       new.project_id, new.actor_user_id, new.actor_subject_id, new.actor_role
     ) then
    raise exception 'assignment requires an exact project member actor'
      using errcode = '23514';
  end if;
  if analysis_study_state_v1(new.study_id) <> 'coding_open' then
    raise exception 'assignments are accepted only while study coding is open'
      using errcode = '23514';
  end if;
  select * into opened from analysis_study_events event
  where event.study_id = new.study_id and event.event_type = 'coding_opened';
  if opened.stopping_rule = 'server_deadline'
     and linearized_at >= opened.close_at then
    raise exception 'assignment is after the frozen study deadline'
      using errcode = '23514';
  end if;
  select * into observation from analysis_study_item_events event
  where event.id = new.observation_event_id
    and event.project_id = new.project_id
    and event.study_id = new.study_id
    and event.study_item_id = new.study_item_id
    and event.event_type = 'failure_observed';
  if observation.id is null or exists (
    select 1 from analysis_study_item_events withdrawal
    where withdrawal.study_item_id = observation.study_item_id
      and withdrawal.event_type = 'failure_withdrawn'
      and withdrawal.target_event_id = observation.id
  ) then
    raise exception 'assignment must target one exact active failure observation'
      using errcode = '23514';
  end if;
  select * into target_revision from analysis_failure_taxonomy_revisions revision
  where revision.id = new.taxonomy_revision_id
    and revision.project_id = new.project_id
    and revision.taxonomy_id = new.taxonomy_id;
  if target_revision.id is null
     or target_revision.sequence <> new.taxonomy_revision_sequence
     or exists (
       select 1 from analysis_failure_taxonomy_revisions successor
       where successor.predecessor_revision_id = target_revision.id
     ) then
    raise exception 'assignment must target the exact current taxonomy head revision'
      using errcode = '23514';
  end if;
  select * into head from analysis_observation_assignment_events event
  where event.observation_event_id = new.observation_event_id
  order by event.version desc limit 1;
  if new.version <> coalesce(head.version, 0) + 1
     or new.predecessor_event_id is distinct from head.id
     or new.predecessor_event_digest is distinct from head.event_digest
     or (head.id is null and new.event_type <> 'assigned')
     or (head.id is not null and new.taxonomy_id <> head.taxonomy_id)
     or (head.id is not null
       and new.taxonomy_revision_sequence < head.taxonomy_revision_sequence) then
    raise exception 'assignment compare-and-swap head or taxonomy ancestry mismatch'
      using errcode = '23514';
  end if;
  if new.event_type = 'assigned' and not exists (
    select 1 from analysis_failure_taxonomy_revision_codes entry
    where entry.taxonomy_revision_id = new.taxonomy_revision_id
      and entry.taxonomy_id = new.taxonomy_id
      and entry.code_id = new.code_id
      and entry.status = 'active'
  ) then
    raise exception 'assignment code must be active in the exact named taxonomy revision'
      using errcode = '23514';
  end if;
  new.occurred_at := linearized_at;
  if new.request_digest <> analysis_assignment_request_digest_v1(new) then
    raise exception 'assignment request digest does not match the exact CAS command'
      using errcode = '23514';
  end if;
  new.event_digest := analysis_assignment_event_digest_v1(new);
  return new;
end;
$$;


--
-- Name: guard_analysis_population_bundle_complete(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_population_bundle_complete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  revision dataset_revisions%rowtype;
  draw analysis_population_draws%rowtype;
  expected_request_digest text;
  expected_count bigint;
begin
  -- Project erasure can fire a previously queued deferred trigger after the
  -- cascade has removed the population. That is the only incomplete exit.
  if not exists (select 1 from analysis_populations row_value where row_value.id = new.id) then
    return null;
  end if;
  select * into revision from dataset_revisions row_value
  where row_value.id = new.dataset_revision_id and row_value.project_id = new.project_id;
  if revision.id is null
     or revision.analysis_population_id <> new.id
     or revision.source_kind <> 'analysis_population'
     or revision.role <> 'analysis_authoring'
     or revision.series_id <> 'analysis-population:' || new.id
     or revision.revision_number <> 1
     or revision.source_dataset_id is not null
     or revision.parent_revision_id is not null
     or revision.criterion_version_id is not null
     or revision.provenance_level <> 'unverified'
     or revision.created_by_user_id <> new.created_by_user_id
     or revision.created_at <> new.created_at
     or revision.item_count <> new.population_size then
    raise exception 'analysis population and dataset revision must be reciprocal and exact'
      using errcode = '23514';
  end if;
  if exists (
    select 1 from cases case_row
    where case_row.project_id = new.project_id
      and case_row.created_at >= new.window_start
      and case_row.created_at < new.window_end
      and case_row.ingestion_purpose = any(new.eligible_ingestion_purposes)
      and (
        not exists (
          select 1 from case_input_identity_records identity_record
          where identity_record.project_id = case_row.project_id
            and identity_record.source_case_id = case_row.id
            and identity_record.input_digest is not null
            and identity_record.identity_basis = 'input-identity/v1'
            and identity_record.record_kind in ('authoring_import','identity_resolved')
        )
        or (
          select count(distinct identity_record.input_digest)
          from case_input_identity_records identity_record
          where identity_record.project_id = case_row.project_id
            and identity_record.source_case_id = case_row.id
            and identity_record.input_digest is not null
            and identity_record.identity_basis = 'input-identity/v1'
            and identity_record.record_kind in ('authoring_import','identity_resolved')
        ) <> 1
      )
  ) then
    raise exception 'analysis population window contains an eligible case without retained input identity'
      using errcode = '23514';
  end if;
  select count(*) into expected_count
  from cases case_row
  where case_row.project_id = new.project_id
    and case_row.created_at >= new.window_start
    and case_row.created_at < new.window_end
    and case_row.ingestion_purpose = any(new.eligible_ingestion_purposes);
  if expected_count <> new.population_size
     or (select count(*) from analysis_population_members member
         where member.population_id = new.id) <> new.population_size
     or exists (
       with expected as (
         select case_row.id as case_id,
                case_row.created_at as ingestion_time,
                row_number() over (order by case_row.created_at, case_row.id) - 1 as position
         from cases case_row
         where case_row.project_id = new.project_id
           and case_row.created_at >= new.window_start
           and case_row.created_at < new.window_end
           and case_row.ingestion_purpose = any(new.eligible_ingestion_purposes)
       ), actual as (
         select member.case_id, member.ingestion_time, member.position::bigint as position
         from analysis_population_members member
         where member.population_id = new.id
       )
       (select expected.case_id, expected.ingestion_time, expected.position from expected
        except
        select actual.case_id, actual.ingestion_time, actual.position from actual)
       union all
       (select actual.case_id, actual.ingestion_time, actual.position from actual
        except
        select expected.case_id, expected.ingestion_time, expected.position from expected)
     ) then
    raise exception 'analysis population must freeze every eligible case in deterministic order'
      using errcode = '23514';
  end if;
  select count(*) into expected_count
  from cases case_row
  where case_row.project_id = new.project_id
    and case_row.created_at >= new.window_start
    and case_row.created_at < new.window_end
    and case_row.ingestion_purpose in (
      'judge_api','judge_batch_general','dataset_example','trace_test_synthetic',
      'release_evidence'
    );
  if expected_count <> new.exclusion_count
     or (select count(*) from analysis_population_exclusions exclusion
         where exclusion.population_id = new.id) <> new.exclusion_count
     or exists (
       with expected as (
         select case_row.id as case_id,
                case_row.created_at as ingestion_time,
                row_number() over (order by case_row.created_at, case_row.id) - 1 as position
         from cases case_row
         where case_row.project_id = new.project_id
           and case_row.created_at >= new.window_start
           and case_row.created_at < new.window_end
           and case_row.ingestion_purpose in (
             'judge_api','judge_batch_general','dataset_example','trace_test_synthetic',
             'release_evidence'
           )
       ), actual as (
         select exclusion.case_id, exclusion.ingestion_time, exclusion.position
         from analysis_population_exclusions exclusion
         where exclusion.population_id = new.id
       )
       (select expected.case_id, expected.ingestion_time, expected.position from expected
        except
        select actual.case_id, actual.ingestion_time, actual.position from actual)
       union all
       (select actual.case_id, actual.ingestion_time, actual.position from actual
        except
        select expected.case_id, expected.ingestion_time, expected.position from expected)
     ) then
    raise exception 'analysis population must retain every explicit exclusion in deterministic order'
      using errcode = '23514';
  end if;
  if new.frame_digest <> analysis_population_frame_digest_v1(new.id)
     or new.content_digest <> analysis_population_content_digest_v1(new.id)
     or revision.content_digest <> analysis_dataset_revision_content_digest_v1(new.id)
     or revision.revision_digest <> analysis_dataset_revision_digest_v1(new.id) then
    raise exception 'analysis population or dataset revision digest mismatch'
      using errcode = '23514';
  end if;
  select * into draw from analysis_population_draws row_value
  where row_value.population_id = new.id;
  if draw.id is null
     or draw.dataset_revision_id <> revision.id
     or draw.population_size <> new.population_size
     or (select count(*) from analysis_population_draw_items item
         where item.draw_id = draw.id) <> draw.fixed_budget
     or exists (
       select expected.member_id, expected.rank_digest, expected.expected_position
       from (
         select ranked.member_id, ranked.rank_digest,
                row_number() over (
                  order by ranked.rank_digest, ranked.frame_member_digest, ranked.case_id
                ) - 1 as expected_position
         from (
           select member.id as member_id,
                  member.case_id,
                  member.frame_member_digest,
                  analysis_sha256_v1(jsonb_build_object(
                    'basis', 'coeval-analysis-rank/v1',
                    'caseId', member.case_id,
                    'frameMemberDigest', member.frame_member_digest,
                    'seed', draw.seed
                  )) as rank_digest
           from analysis_population_members member
           where member.population_id = new.id
         ) ranked
       ) expected
       where expected.expected_position < draw.fixed_budget
       except
       select item.member_id, item.rank_digest, item.position
       from analysis_population_draw_items item
       where item.draw_id = draw.id
     )
     or draw.content_digest <> analysis_population_draw_content_digest_v1(draw.id)
     or draw.draw_digest <> analysis_population_draw_digest_v1(draw.id) then
    raise exception 'analysis population draw must be complete, deterministic, and digest-bound'
      using errcode = '23514';
  end if;
  expected_request_digest := analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-population-request/v1',
    'fixedBudget', draw.fixed_budget,
    'projectId', new.project_id,
    'windowEnd', analysis_timestamp_v1(new.window_end),
    'windowStart', analysis_timestamp_v1(new.window_start)
  ));
  if not exists (
    select 1 from analysis_population_requests request
    where request.population_id = new.id
  ) or exists (
    select 1 from analysis_population_requests request
    where request.population_id = new.id
      and (request.project_id <> new.project_id or request.request_digest <> expected_request_digest)
  ) then
    raise exception 'analysis population requires at least one exact idempotency request binding'
      using errcode = '23514';
  end if;
  return null;
end;
$$;


--
-- Name: guard_analysis_population_draw(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_population_draw() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  population analysis_populations%rowtype;
begin
  select * into population from analysis_populations row_value
  where row_value.id = new.population_id and row_value.project_id = new.project_id;
  if population.id is null
     or new.dataset_revision_id <> population.dataset_revision_id
     or new.population_size <> population.population_size then
    raise exception 'analysis draw must bind its exact population, revision, and frame size'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from governed_reviewer_subjects subject
    where subject.id = new.executed_by_subject_id and subject.project_id = new.project_id
  ) or new.executed_by_subject_id <> population.created_by_subject_id then
    raise exception 'analysis draw executor must be the population creation subject'
      using errcode = '23514';
  end if;
  if new.executed_at <> transaction_timestamp() then
    raise exception 'analysis draw must record database execution time'
      using errcode = '23514';
  end if;
  if (select count(*) from analysis_population_members member
      where member.population_id = population.id) <> population.population_size
     or (select count(*) from analysis_population_exclusions exclusion
         where exclusion.population_id = population.id) <> population.exclusion_count then
    raise exception 'analysis draw may be created only after the exact frame and exclusions'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_analysis_population_draw_item(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_population_draw_item() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  draw analysis_population_draws%rowtype;
  member analysis_population_members%rowtype;
  expected_digest text;
begin
  select * into draw from analysis_population_draws row_value
  where row_value.id = new.draw_id
    and row_value.project_id = new.project_id
    and row_value.population_id = new.population_id;
  if draw.id is null or new.position >= draw.fixed_budget then
    raise exception 'analysis draw item must occupy a bounded position in its draw'
      using errcode = '23514';
  end if;
  select * into member from analysis_population_members row_value
  where row_value.id = new.member_id
    and row_value.project_id = new.project_id
    and row_value.population_id = new.population_id;
  if member.id is null
     or member.revision_item_id <> new.revision_item_id
     or member.case_id <> new.case_id
     or member.frame_member_digest <> new.frame_member_digest then
    raise exception 'analysis draw item must bind one exact population member'
      using errcode = '23514';
  end if;
  expected_digest := analysis_sha256_v1(jsonb_build_object(
    'basis', 'coeval-analysis-rank/v1',
    'caseId', new.case_id,
    'frameMemberDigest', new.frame_member_digest,
    'seed', draw.seed
  ));
  if new.rank_digest <> expected_digest then
    raise exception 'analysis draw item rank digest mismatch' using errcode = '23514';
  end if;
  expected_digest := analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-population-draw-item/v1',
    'caseId', new.case_id,
    'frameMemberDigest', new.frame_member_digest,
    'memberId', new.member_id,
    'position', new.position,
    'rankDigest', new.rank_digest,
    'revisionItemId', new.revision_item_id
  ));
  if new.content_digest <> expected_digest then
    raise exception 'analysis draw item content digest mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_analysis_population_eval_run_boundary(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_population_eval_run_boundary() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.dataset_revision_id is not null and exists (
    select 1
    from dataset_revisions revision
    where revision.id = new.dataset_revision_id
      and revision.source_kind = 'analysis_population'
  ) then
    raise exception 'analysis population revisions require an explicit governed handoff before evaluation'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_analysis_population_exclusion(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_population_exclusion() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  population analysis_populations%rowtype;
  source_case cases%rowtype;
  raw raw_traces%rowtype;
  expected_digest text;
begin
  select * into population from analysis_populations row_value
  where row_value.id = new.population_id and row_value.project_id = new.project_id;
  if population.id is null or new.position >= population.exclusion_count then
    raise exception 'analysis exclusion must occupy a bounded position in its population'
      using errcode = '23514';
  end if;
  if exists (select 1 from analysis_population_draws draw where draw.population_id = population.id) then
    raise exception 'analysis population exclusions must precede the immutable draw'
      using errcode = '55000';
  end if;
  select * into source_case from cases row_value
  where row_value.id = new.case_id and row_value.project_id = new.project_id;
  if source_case.id is null
     or source_case.raw_trace_id is distinct from new.raw_trace_id
     or source_case.case_type <> new.case_type
     or source_case.ingestion_purpose <> new.ingestion_purpose
     or source_case.created_at <> new.ingestion_time
     or not (
       (new.ingestion_purpose in ('judge_api','judge_batch_general','dataset_example','trace_test_synthetic')
        and new.case_type = 'manual' and new.raw_trace_id is not null)
       or (new.ingestion_purpose = 'release_evidence' and new.case_type = 'release_evidence')
     ) then
    raise exception 'analysis exclusion must bind an exact explicitly ineligible case'
      using errcode = '23514';
  end if;
  if new.ingestion_time < population.window_start or new.ingestion_time >= population.window_end then
    raise exception 'analysis exclusion ingestion time must be inside its population window'
      using errcode = '23514';
  end if;
  if new.raw_trace_id is null then
    if new.source_trace_id is not null then
      raise exception 'analysis exclusion without a raw trace cannot claim a source trace'
        using errcode = '23514';
    end if;
  else
    select * into raw from raw_traces row_value
    where row_value.id = new.raw_trace_id and row_value.project_id = new.project_id;
    if raw.id is null or raw.source_trace_id is distinct from new.source_trace_id then
      raise exception 'analysis exclusion raw-trace reference mismatch'
        using errcode = '23514';
    end if;
  end if;
  expected_digest := analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-population-exclusion/v1',
    'caseId', new.case_id,
    'caseType', new.case_type,
    'ingestionPurpose', new.ingestion_purpose,
    'ingestionTime', analysis_timestamp_v1(new.ingestion_time),
    'position', new.position::text,
    'rawTraceId', new.raw_trace_id,
    'reason', new.reason,
    'sourceTraceId', new.source_trace_id
  ));
  if new.content_digest <> expected_digest then
    raise exception 'analysis population exclusion digest mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_analysis_population_member(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_population_member() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  population analysis_populations%rowtype;
  source_case cases%rowtype;
  raw raw_traces%rowtype;
  revision_item dataset_revision_items%rowtype;
  expected_reference jsonb;
  expected_digest text;
begin
  select * into population from analysis_populations row_value
  where row_value.id = new.population_id and row_value.project_id = new.project_id;
  if population.id is null or new.position >= population.population_size then
    raise exception 'analysis member must occupy a bounded position in its population'
      using errcode = '23514';
  end if;
  if exists (select 1 from analysis_population_draws draw where draw.population_id = population.id) then
    raise exception 'analysis population members must precede the immutable draw'
      using errcode = '55000';
  end if;
  select * into source_case from cases row_value
  where row_value.id = new.case_id and row_value.project_id = new.project_id;
  select * into raw from raw_traces row_value
  where row_value.id = new.raw_trace_id and row_value.project_id = new.project_id;
  if source_case.id is null or raw.id is null
     or source_case.raw_trace_id <> raw.id
     or raw.source_trace_id <> new.source_trace_id
     or source_case.case_type <> new.case_type
     or source_case.ingestion_purpose <> new.ingestion_purpose
     or source_case.created_at <> new.ingestion_time
     or not (
       (new.case_type = 'manual' and new.ingestion_purpose = 'analysis_eligible_manual')
       or (new.case_type = 'langsmith' and new.ingestion_purpose = 'analysis_eligible_langsmith')
       or (new.case_type = 'langfuse' and new.ingestion_purpose = 'analysis_eligible_langfuse')
       or (new.case_type = 'ironside' and new.ingestion_purpose = 'analysis_eligible_ironside')
     ) then
    raise exception 'analysis member must bind the exact eligible case and raw-trace origin'
      using errcode = '23514';
  end if;
  if new.ingestion_time < population.window_start or new.ingestion_time >= population.window_end then
    raise exception 'analysis member ingestion time must be inside its population window'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from case_input_identity_records identity_record
    where identity_record.project_id = new.project_id
      and identity_record.source_case_id = new.case_id
      and identity_record.input_digest = new.input_digest
      and identity_record.identity_basis = 'input-identity/v1'
      and identity_record.record_kind in ('authoring_import','identity_resolved')
  ) or exists (
    select 1 from case_input_identity_records identity_record
    where identity_record.project_id = new.project_id
      and identity_record.source_case_id = new.case_id
      and identity_record.input_digest is distinct from new.input_digest
      and identity_record.input_digest is not null
      and identity_record.identity_basis = 'input-identity/v1'
      and identity_record.record_kind in ('authoring_import','identity_resolved')
  ) or not exists (
    select 1 from governed_input_identity_claims claim
    where claim.project_id = new.project_id
      and claim.input_digest = new.input_digest
      and claim.usage_class = 'nonsealed'
  ) then
    raise exception 'analysis member requires an exact retained nonsealed input identity'
      using errcode = '23514';
  end if;
  select * into revision_item from dataset_revision_items row_value
  where row_value.id = new.revision_item_id
    and row_value.project_id = new.project_id
    and row_value.revision_id = population.dataset_revision_id;
  expected_reference := jsonb_build_object(
    'actorUserIds', '[]'::jsonb,
    'basis', 'Analysis population member; no reference label.',
    'kind', 'unlabeled',
    'sourceId', new.case_id,
    'verdictIds', '[]'::jsonb
  );
  if revision_item.id is null
     or revision_item.position <> new.position
     or revision_item.source_case_id <> new.case_id
     or revision_item.source_trace_id <> new.source_trace_id
     or revision_item.source_dataset_item_id is not null
     or revision_item.source_golden_entry_id is not null
     or revision_item.input_digest <> new.input_digest
     or revision_item.item_digest <> new.item_digest
     or revision_item.reference_label is not null
     or revision_item.reference_fail_step is not null
     or revision_item.note is not null
     or revision_item.reference_provenance <> expected_reference then
    raise exception 'analysis member must bind its exact unlabeled analysis revision item'
      using errcode = '23514';
  end if;
  if new.item_digest <> analysis_dataset_revision_item_digest_v1(
    new.input_digest, revision_item.payload_snapshot, expected_reference
  ) then
    raise exception 'analysis member revision item digest mismatch'
      using errcode = '23514';
  end if;
  expected_digest := analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-population-frame-member/v1',
    'caseId', new.case_id,
    'ingestionTime', analysis_timestamp_v1(new.ingestion_time),
    'inputDigest', new.input_digest,
    'itemDigest', new.item_digest,
    'position', new.position
  ));
  if new.frame_member_digest <> expected_digest then
    raise exception 'analysis frame-member digest mismatch' using errcode = '23514';
  end if;
  expected_digest := analysis_sha256_v1(jsonb_build_object(
    'basis', 'analysis-population-member/v1',
    'caseId', new.case_id,
    'ingestionTime', analysis_timestamp_v1(new.ingestion_time),
    'inputDigest', new.input_digest,
    'itemDigest', new.item_digest,
    'position', new.position,
    'revisionItemId', new.revision_item_id
  ));
  if new.lineage_digest <> expected_digest then
    raise exception 'analysis member lineage digest mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_analysis_population_request(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_population_request() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  population analysis_populations%rowtype;
  draw analysis_population_draws%rowtype;
  expected_digest text;
begin
  select * into population
  from analysis_populations row_value
  where row_value.id = new.population_id and row_value.project_id = new.project_id;
  if population.id is null then
    raise exception 'analysis population request must belong to its population project'
      using errcode = '23514';
  end if;
  select * into draw from analysis_population_draws row_value
  where row_value.population_id = population.id;
  if draw.id is not null then
    expected_digest := analysis_sha256_v1(jsonb_build_object(
      'basis', 'analysis-population-request/v1',
      'fixedBudget', draw.fixed_budget,
      'projectId', population.project_id,
      'windowEnd', analysis_timestamp_v1(population.window_end),
      'windowStart', analysis_timestamp_v1(population.window_start)
    ));
    if new.request_digest <> expected_digest then
      raise exception 'analysis population request digest does not match its immutable body'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;


--
-- Name: guard_analysis_population_review_batch_boundary(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_population_review_batch_boundary() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.source_population_kind = 'dataset_revision' and exists (
    select 1 from dataset_revisions revision
    where revision.id = new.source_population_id
      and revision.source_kind = 'analysis_population'
  ) then
    raise exception 'analysis population revisions require an explicit governed promotion handoff before review'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_analysis_population_review_item_boundary(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_population_review_item_boundary() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.source_kind = 'dataset_revision_item' and exists (
    select 1 from dataset_revisions revision
    where revision.id = new.source_revision_id
      and revision.source_kind = 'analysis_population'
  ) and not exists (
    select 1 from analysis_criterion_promotions promotion
    where promotion.project_id = new.project_id
      and promotion.source_dataset_revision_id = new.source_revision_id
  ) then
    raise exception 'analysis population revisions require an exact promotion handoff before review'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_analysis_population_row(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_population_row() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if current_setting('transaction_isolation') <> 'repeatable read' then
    raise exception 'analysis populations require a repeatable-read transaction'
      using errcode = '23514';
  end if;
  if not exists (
    select 1
    from governed_reviewer_subjects subject
    where subject.id = new.created_by_subject_id
      and subject.project_id = new.project_id
      and (
        new.created_by_user_id is null
        or subject.account_user_id = new.created_by_user_id
      )
  ) then
    raise exception 'analysis population actor must be a governed subject in its project'
      using errcode = '23514';
  end if;
  if new.window_end > transaction_timestamp() - interval '60 seconds' then
    raise exception 'analysis population window end must lag the database clock by at least 60 seconds'
      using errcode = '23514';
  end if;
  if new.snapshot_xid8 <> pg_current_snapshot()::text
     or new.snapshot_taken_at <> transaction_timestamp()
     or new.created_at <> transaction_timestamp() then
    raise exception 'analysis population must record the creating transaction snapshot and server time'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_analysis_promotion_criterion_batch(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_promotion_criterion_batch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  promotion analysis_criterion_promotions%rowtype;
  promotion_xmin text;
begin
  if not exists (
    select 1 from criterion_versions version
    where version.id = new.criterion_version_id
      and version.project_id = new.project_id
      and version.source_kind = 'analysis_promotion'
  ) then
    return new;
  end if;
  select * into promotion from analysis_criterion_promotions row_value
  where row_value.project_id = new.project_id
    and row_value.criterion_version_id = new.criterion_version_id;
  select row_value.xmin::text into promotion_xmin
  from analysis_criterion_promotions row_value
  where row_value.project_id = new.project_id
    and row_value.criterion_version_id = new.criterion_version_id;
  if promotion.id is null
     or promotion_xmin = pg_current_xact_id()::xid::text
     or not exists (
       select 1 from dataset_exposure_events exposure
       where exposure.id = promotion.criterion_authoring_exposure_event_id
         and exposure.project_id = promotion.project_id
         and exposure.evidence_ref_kind = 'analysis_criterion_promotion'
         and exposure.evidence_ref_id = promotion.id
     )
     or (select count(*) from dataset_exposure_events exposure
         where exposure.project_id = promotion.project_id
           and exposure.evidence_ref_kind = 'analysis_criterion_promotion'
           and exposure.evidence_ref_id = promotion.id) <> promotion.support_count + 1 then
    raise exception 'analysis-promotion criteria require a previously committed complete promotion and exposure bundle before governed review'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_analysis_promotion_criterion_complete(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_promotion_criterion_complete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.source_kind = 'analysis_promotion' and not exists (
    select 1 from analysis_criterion_promotions promotion
    where promotion.project_id = new.project_id
      and promotion.criterion_id = new.id
      and promotion.criterion_stable_key = new.stable_key
      and promotion.promoted_by_user_id = new.created_by_user_id
      and promotion.created_at = new.created_at
  ) then
    raise exception 'analysis-promotion criterion must be part of one complete promotion bundle'
      using errcode = '23514';
  end if;
  return null;
end;
$$;


--
-- Name: guard_analysis_promotion_criterion_source(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_promotion_criterion_source() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.source_kind = 'analysis_promotion' then
    if new.stable_key <> 'analysis-failure-code:' ||
         substring(new.stable_key from char_length('analysis-failure-code:') + 1)
       or new.stable_key not like 'analysis-failure-code:%'
       or char_length(new.stable_key) > 200 then
      raise exception 'analysis-promotion criterion requires its reserved stable-key namespace'
        using errcode = '23514';
    end if;
  elsif new.stable_key like 'analysis-failure-code:%' then
    raise exception 'analysis failure-code stable keys are reserved for atomic promotion'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_analysis_promotion_criterion_version_complete(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_promotion_criterion_version_complete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.source_kind = 'analysis_promotion' and not exists (
    select 1 from analysis_criterion_promotions promotion
    where promotion.project_id = new.project_id
      and promotion.criterion_id = new.criterion_id
      and promotion.criterion_version_id = new.id
      and promotion.criterion_name = new.name
      and promotion.criterion_definition = new.definition
      and promotion.criterion_digest = new.criterion_digest
      and promotion.promoted_by_user_id = new.created_by_user_id
      and promotion.created_at = new.created_at
      and new.revision = 1
  ) then
    raise exception 'analysis-promotion criterion version must be part of one complete promotion bundle'
      using errcode = '23514';
  end if;
  return null;
end;
$$;


--
-- Name: guard_analysis_promotion_evaluator_complete_v1(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_promotion_evaluator_complete_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  governed boolean;
begin
  if tg_table_name='skills' then
    select source_kind='analysis_promotion' into governed from criteria
    where id=new.criterion_id and project_id=new.project_id;
    if governed and not exists (select 1 from evaluator_lifecycles lifecycle
      where lifecycle.project_id=new.project_id and lifecycle.skill_id=new.id and lifecycle.criterion_id=new.criterion_id) then
      raise exception 'analysis-promotion skills require an exact candidate lifecycle bundle' using errcode='23514';
    end if;
  else
    select criterion.source_kind='analysis_promotion' into governed
    from criterion_versions definition join criteria criterion on criterion.id=definition.criterion_id
    where definition.id=new.criterion_version_id and definition.project_id=new.project_id;
    if governed and not exists (select 1 from evaluator_lifecycles lifecycle
      where lifecycle.project_id=new.project_id and lifecycle.skill_version_id=new.id) then
      raise exception 'analysis-promotion evaluator versions require an exact candidate lifecycle bundle' using errcode='23514';
    end if;
  end if;
  return null;
end;
$$;


--
-- Name: guard_analysis_promotion_handoff_batch(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_promotion_handoff_batch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  promotion analysis_criterion_promotions%rowtype;
  revision dataset_revisions%rowtype;
begin
  if new.source_population_kind <> 'analysis_promotion_handoff' then
    return new;
  end if;
  select * into promotion from analysis_criterion_promotions row_value
  where row_value.id = new.source_population_id
    and row_value.project_id = new.project_id;
  if promotion.id is null then
    raise exception 'analysis promotion handoff must belong to the exact batch project'
      using errcode = '23514';
  end if;
  select * into revision from dataset_revisions row_value
  where row_value.id = promotion.source_dataset_revision_id
    and row_value.project_id = promotion.project_id;
  if new.role_intent <> 'analysis_authoring'
     or new.criterion_version_id <> promotion.criterion_version_id
     or new.population_id <> promotion.source_dataset_revision_id
     or revision.id is null
     or revision.role <> 'analysis_authoring'
     or revision.source_kind <> 'analysis_population'
     or new.population_digest <> promotion.source_dataset_revision_content_digest
     or new.population_size <> revision.item_count
     or new.window_start is not null or new.window_end is not null
     or new.evaluator_blind is not true
     or new.peer_blind_until_labeling_closed is not true
     or new.separation_of_duties_required is not false
     or new.custodian_subject_id is not null
     or new.custodian_role_at_review is not null
     or new.population_definition <> jsonb_build_object(
       'criterionVersionId', promotion.criterion_version_id,
       'handoffDigest', promotion.handoff_digest,
       'kind', 'analysis_promotion_handoff',
       'promotionId', promotion.id,
       'sourceDatasetRevisionId', promotion.source_dataset_revision_id
     )
     or new.population_collection_provenance <> jsonb_build_object(
       'createsEvaluator', false,
       'createsTruth', false,
       'evidenceClass', 'development_authoring_not_truth',
       'handoffDigest', promotion.handoff_digest,
       'kind', 'analysis_promotion_handoff',
       'promotionId', promotion.id,
       'provenanceLevel', revision.provenance_level,
       'revisionDigest', promotion.source_dataset_revision_digest,
       'sourceKind', 'analysis_population'
     ) then
    raise exception 'governed review batch must bind the exact nonsealed analysis promotion handoff'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_analysis_promotion_handoff_batch_item(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_promotion_handoff_batch_item() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  batch governed_review_batches%rowtype;
  item governed_review_items%rowtype;
begin
  select * into batch from governed_review_batches row_value
  where row_value.id = new.batch_id and row_value.project_id = new.project_id;
  if batch.source_population_kind <> 'analysis_promotion_handoff' then
    return new;
  end if;
  select * into item from governed_review_items row_value
  where row_value.id = new.review_item_id and row_value.project_id = new.project_id;
  if item.id is null
     or item.source_kind <> 'dataset_revision_item'
     or item.source_revision_id <> batch.population_id then
    raise exception 'promotion handoff batch items must belong to its exact analysis revision'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_analysis_study(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_study() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.created_at <> transaction_timestamp() then
    raise exception 'analysis study creation time must be the database transaction time'
      using errcode = '23514';
  end if;
  if new.request_digest <> analysis_study_request_digest_v1(new)
     or new.content_digest <> analysis_study_content_digest_v1(new) then
    raise exception 'analysis study request/content digest does not match canonical evidence'
      using errcode = '23514';
  end if;
  if not analysis_actor_has_role_v1(
    new.project_id, new.created_by_user_id, new.created_by_subject_id, 'owner'
  ) then
    raise exception 'analysis study creation requires an exact project-owner subject'
      using errcode = '23514';
  end if;
  if not exists (
    select 1
    from analysis_populations population
    join analysis_population_draws draw
      on draw.population_id = population.id
     and draw.project_id = population.project_id
    join dataset_revisions revision
      on revision.id = population.dataset_revision_id
     and revision.project_id = population.project_id
    where population.id = new.population_id
      and population.project_id = new.project_id
      and draw.id = new.draw_id
      and revision.id = new.dataset_revision_id
      and draw.dataset_revision_id = revision.id
      and revision.source_kind = 'analysis_population'
      and revision.analysis_population_id = population.id
  ) then
    raise exception 'analysis study must bind one exact population, draw, and analysis revision'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_analysis_study_bundle_complete(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_study_bundle_complete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if (select count(*) from analysis_study_items item where item.study_id = new.id)
       <> (select draw.fixed_budget from analysis_population_draws draw where draw.id = new.draw_id)
     or exists (
       select draw_item.id, draw_item.member_id, draw_item.revision_item_id,
              draw_item.case_id, draw_item.position
       from analysis_population_draw_items draw_item
       where draw_item.draw_id = new.draw_id
       except
       select item.draw_item_id, item.member_id, item.revision_item_id,
              item.case_id, item.position
       from analysis_study_items item
       where item.study_id = new.id
     )
     or exists (
       select item.draw_item_id, item.member_id, item.revision_item_id,
              item.case_id, item.position
       from analysis_study_items item
       where item.study_id = new.id
       except
       select draw_item.id, draw_item.member_id, draw_item.revision_item_id,
              draw_item.case_id, draw_item.position
       from analysis_population_draw_items draw_item
       where draw_item.draw_id = new.draw_id
     ) then
    raise exception 'analysis study must atomically freeze every selected draw item exactly once'
      using errcode = '23514';
  end if;
  return null;
end;
$$;


--
-- Name: guard_analysis_study_closure(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_study_closure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  study analysis_studies%rowtype;
  opened analysis_study_events%rowtype;
  draw analysis_population_draws%rowtype;
  population analysis_populations%rowtype;
  expected_frame text;
  expected_draw text;
  expected_reason text;
  linearized_at timestamptz;
begin
  perform analysis_study_lock_v1(new.study_id);
  linearized_at := analysis_linearization_clock_v1();
  select * into study from analysis_studies row_value
  where row_value.id = new.study_id and row_value.project_id = new.project_id;
  select * into opened from analysis_study_events event
  where event.study_id = new.study_id and event.event_type = 'coding_opened';
  select * into draw from analysis_population_draws row_value where row_value.id = study.draw_id;
  select * into population from analysis_populations row_value where row_value.id = study.population_id;
  if study.id is null or opened.id is null or analysis_study_state_v1(new.study_id) <> 'coding_open'
     or new.population_id <> study.population_id or new.draw_id <> study.draw_id
     or new.dataset_revision_id <> study.dataset_revision_id
     or new.drawn_from_population_id <> study.population_id
     or new.stopping_rule <> opened.stopping_rule or new.close_cause <> opened.stopping_rule
     or new.selected_item_count <> draw.fixed_budget then
    raise exception 'analysis closure must bind the exact open study, draw, stop rule, and database clock'
      using errcode = '23514';
  end if;
  new.recorded_at := linearized_at;
  new.created_at := linearized_at;
  if opened.stopping_rule = 'server_deadline' then
    if linearized_at < opened.close_at
       or new.close_actor_role <> 'system' or new.close_actor_user_id is not null
       or new.close_actor_subject_id is not null or new.close_reason is not null then
      raise exception 'deadline closure must materialize at the exact frozen effective close time'
      using errcode = '23514';
    end if;
    new.close_at := opened.close_at;
    new.effective_closed_at := opened.close_at;
  elsif new.close_actor_role <> 'owner'
     or not analysis_actor_has_role_v1(
       new.project_id, new.close_actor_user_id, new.close_actor_subject_id, 'owner'
     ) or new.close_reason is null then
    raise exception 'explicit closure requires the exact owner actor, reason, and database time'
      using errcode = '23514';
  end if;
  if opened.stopping_rule = 'explicit_owner_close' then
    new.close_at := null;
    new.effective_closed_at := linearized_at;
  end if;

  expected_frame := analysis_recomputed_population_frame_digest_v1(study.population_id);
  expected_draw := analysis_population_draw_digest_v1(study.draw_id);
  if new.method <> draw.method or new.frozen_frame_digest <> population.frame_digest
     or new.recomputed_frame_digest is distinct from expected_frame
     or new.frozen_draw_digest <> draw.draw_digest
     or new.recomputed_draw_digest is distinct from expected_draw
     or new.method_eligible <> (draw.method = 'simple_random')
     or new.frame_reproducible <> (
       expected_frame is not null and expected_frame = population.frame_digest
     )
     or new.draw_complete <> (
       expected_draw is not null and expected_draw = draw.draw_digest
       and new.closure_item_count = new.selected_item_count
     )
     or new.coding_complete <> (
       expected_draw is not null and expected_draw = draw.draw_digest
       and new.closure_item_count = new.selected_item_count
       and new.completed_item_count = new.selected_item_count
     ) then
    raise exception 'analysis closure assessment inputs or booleans do not match database evidence'
      using errcode = '23514';
  end if;
  expected_reason := case
    when not new.method_eligible then 'method_not_eligible'
    when not new.frame_reproducible then 'frame_not_reproducible'
    when not new.draw_complete then 'draw_not_complete'
    when not new.coding_complete then 'coding_not_complete'
    else null
  end;
  if new.representative_reason is distinct from expected_reason
     or new.representative_of_population_id is distinct from (
       case when expected_reason is null then study.population_id else null end
     ) then
    raise exception 'analysis closure representative claim violates closed reason precedence'
      using errcode = '23514';
  end if;
  new.assessment_digest := analysis_study_assessment_digest_v1(new);
  new.closure_digest := analysis_study_closure_digest_v1(new);
  return new;
end;
$$;


--
-- Name: guard_analysis_study_closure_complete(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_study_closure_complete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if (select count(*) from analysis_study_closure_items item where item.closure_id = new.id)
       <> new.closure_item_count
     or new.closure_item_count <> new.selected_item_count
     or exists (
       select study_item.id, study_item.draw_item_id, study_item.case_id, study_item.position
       from analysis_study_items study_item where study_item.study_id = new.study_id
       except
       select item.study_item_id, item.draw_item_id, item.case_id, item.position
       from analysis_study_closure_items item where item.closure_id = new.id
     )
     or exists (
       select 1
       from analysis_study_closure_items item
       cross join lateral analysis_study_item_projection_v1(
         item.study_item_id, new.effective_closed_at
       ) projection
       where item.closure_id = new.id
         and (item.item_state <> projection.item_state
           or item.item_event_version <> projection.current_version
           or item.current_event_id is distinct from projection.current_event_id
           or item.current_event_digest is distinct from projection.current_event_digest
           or item.view_event_ids is distinct from projection.view_event_ids
           or item.view_event_digests is distinct from projection.view_event_digests
           or item.active_failure_observation_event_ids
              is distinct from projection.active_failure_observation_event_ids
           or item.active_failure_observation_event_digests
              is distinct from projection.active_failure_observation_event_digests
           or item.active_failure_assignment_event_ids
              is distinct from projection.active_failure_assignment_event_ids
           or item.active_failure_assignment_event_digests
              is distinct from projection.active_failure_assignment_event_digests
           or item.active_no_failure_event_id
              is distinct from projection.active_no_failure_event_id
           or item.active_no_failure_event_digest
              is distinct from projection.active_no_failure_event_digest
           or item.completion_event_id is distinct from projection.completion_event_id
           or item.completion_event_digest is distinct from projection.completion_event_digest)
     )
     or new.completed_item_count <> (
       select count(*) from analysis_study_closure_items item
       where item.closure_id = new.id and item.item_state = 'completed'
     )
     or new.viewed_item_count <> (
       select count(*) from analysis_study_closure_items item
       where item.closure_id = new.id and cardinality(item.view_event_ids) > 0
     )
     or new.view_set_digest <> analysis_study_view_set_digest_v1(new.id)
     or new.content_digest <> analysis_study_closure_content_digest_v1(new.id)
     or new.assessment_digest <> analysis_study_assessment_digest_v1(new)
     or new.closure_digest <> analysis_study_closure_digest_v1(new)
     or not exists (
       select 1 from analysis_study_events event
       where event.study_id = new.study_id
         and event.event_type = 'coding_closed'
         and event.closure_id = new.id
         and event.closure_digest = new.closure_digest
         and event.close_cause = new.close_cause
         and event.actor_role = new.close_actor_role
         and event.actor_user_id is not distinct from new.close_actor_user_id
         and event.actor_subject_id is not distinct from new.close_actor_subject_id
         and event.reason is not distinct from new.close_reason
         and event.occurred_at = new.recorded_at
     ) then
    raise exception 'analysis closure must atomically bind exact K item, view, coding, assignment, and close evidence'
      using errcode = '23514';
  end if;
  return null;
end;
$$;


--
-- Name: guard_analysis_study_closure_item(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_study_closure_item() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  closure_row analysis_study_closures%rowtype;
begin
  perform analysis_study_lock_v1(new.study_id);
  select * into closure_row from analysis_study_closures closure
  where closure.id = new.closure_id
    and closure.project_id = new.project_id
    and closure.study_id = new.study_id;
  if closure_row.id is null then
    raise exception 'closure item requires its exact closure'
      using errcode = '23514';
  end if;
  new.created_at := closure_row.created_at;
  if not exists (
    select 1
    from analysis_study_closures closure
    join analysis_study_items item
      on item.id = new.study_item_id
     and item.project_id = closure.project_id
     and item.study_id = closure.study_id
    where closure.id = new.closure_id
      and closure.project_id = new.project_id
      and closure.study_id = new.study_id
      and closure.created_at = new.created_at
      and item.draw_item_id = new.draw_item_id
      and item.case_id = new.case_id
      and item.position = new.position
  ) then
    raise exception 'closure item must bind its exact closure and selected study item'
      using errcode = '23514';
  end if;
  if cardinality(new.active_failure_observation_event_ids)
       <> cardinality(array(select distinct value from unnest(new.active_failure_observation_event_ids) value))
     or exists (select 1 from unnest(new.active_failure_observation_event_ids) value where value is null)
     or exists (select 1 from unnest(new.active_failure_observation_event_digests) value where value is null)
     or exists (
       select 1
       from unnest(new.active_failure_assignment_event_ids,
                   new.active_failure_assignment_event_digests) pair(event_id,event_digest)
       where (pair.event_id is null) <> (pair.event_digest is null)
     )
     or cardinality(new.view_event_ids)
       <> cardinality(array(select distinct value from unnest(new.view_event_ids) value)) then
    raise exception 'closure item evidence arrays must be aligned, unique, and pair-complete'
      using errcode = '23514';
  end if;
  if new.content_digest <> analysis_study_closure_item_digest_v1(new) then
    raise exception 'closure item digest does not match canonical item evidence'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_analysis_study_event(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_study_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  existing analysis_study_events%rowtype;
  head analysis_study_events%rowtype;
  current_state text;
  opened analysis_study_events%rowtype;
  closure analysis_study_closures%rowtype;
  linearized_at timestamptz;
begin
  select * into existing from analysis_study_events event
  where event.study_id = new.study_id and event.idempotency_key = new.idempotency_key;
  if existing.id is not null then
    if existing.request_digest <> new.request_digest then
      raise exception 'analysis study event idempotency key already has a different request'
        using errcode = '23514';
    end if;
    raise exception 'analysis study event replay must reuse the existing event'
      using errcode = '23505';
  end if;

  perform analysis_study_lock_v1(new.study_id);
  linearized_at := analysis_linearization_clock_v1();
  select * into existing from analysis_study_events event
  where event.study_id = new.study_id and event.idempotency_key = new.idempotency_key;
  if existing.id is not null then
    if existing.request_digest <> new.request_digest then
      raise exception 'analysis study event idempotency key already has a different request'
        using errcode = '23514';
    end if;
    raise exception 'analysis study event replay must reuse the existing event'
      using errcode = '23505';
  end if;
  select * into head from analysis_study_events event
  where event.study_id = new.study_id
  order by event.version desc limit 1;
  current_state := coalesce(head.to_state, 'draft');
  if new.version <> coalesce(head.version, 0) + 1
     or new.predecessor_event_id is distinct from head.id
     or new.predecessor_event_digest is distinct from head.event_digest then
    raise exception 'analysis study event compare-and-swap head mismatch'
      using errcode = '23514';
  end if;

  if new.event_type = 'coding_opened' then
    if current_state <> 'draft' or new.from_state <> 'draft' or new.to_state <> 'coding_open'
       or new.actor_role <> 'owner'
       or not analysis_actor_has_role_v1(
         new.project_id, new.actor_user_id, new.actor_subject_id, 'owner'
       )
       or new.reason is not null then
      raise exception 'coding_opened requires the draft head and an exact owner actor'
        using errcode = '23514';
    end if;
    if new.stopping_rule = 'server_deadline' and (
      new.close_at <= linearized_at
      or date_trunc('milliseconds', new.close_at) <> new.close_at
    ) then
      raise exception 'server deadline must be a future millisecond-normalized database timestamp'
        using errcode = '23514';
    end if;
  elsif new.event_type = 'study_abandoned' then
    select * into opened from analysis_study_events event
    where event.study_id = new.study_id and event.event_type = 'coding_opened';
    if current_state not in ('draft','coding_open')
       or new.from_state <> current_state or new.to_state <> 'abandoned'
       or new.actor_role <> 'owner'
       or not analysis_actor_has_role_v1(
         new.project_id, new.actor_user_id, new.actor_subject_id, 'owner'
       )
       or new.reason is null
       or (current_state = 'coding_open' and opened.stopping_rule = 'server_deadline'
         and linearized_at >= opened.close_at) then
      raise exception 'study_abandoned requires the draft/open head and an exact owner actor'
        using errcode = '23514';
    end if;
  elsif new.event_type = 'coding_closed' then
    select * into opened from analysis_study_events event
    where event.study_id = new.study_id and event.event_type = 'coding_opened';
    if current_state <> 'coding_open' or new.from_state <> 'coding_open'
       or new.to_state <> 'coding_closed' or opened.id is null
       or new.close_cause <> opened.stopping_rule then
      raise exception 'coding_closed requires the exact open study and frozen stopping rule'
        using errcode = '23514';
    end if;
    if opened.stopping_rule = 'server_deadline' then
      if linearized_at < opened.close_at
         or new.actor_role <> 'system' or new.actor_user_id is not null
         or new.actor_subject_id is not null or new.reason is not null then
        raise exception 'deadline close requires the database deadline and system actor'
          using errcode = '23514';
      end if;
    elsif new.actor_role <> 'owner'
       or not analysis_actor_has_role_v1(
         new.project_id, new.actor_user_id, new.actor_subject_id, 'owner'
       ) or new.reason is null then
      raise exception 'explicit close requires an exact owner actor and reason'
        using errcode = '23514';
    end if;
  elsif new.event_type = 'study_completed' then
    if current_state <> 'coding_closed' or new.from_state <> 'coding_closed'
       or new.to_state <> 'completed' or new.actor_role <> 'owner'
       or not analysis_actor_has_role_v1(
         new.project_id, new.actor_user_id, new.actor_subject_id, 'owner'
       )
       or new.expected_closure_digest <> head.closure_digest then
      raise exception 'study_completed requires the exact closure digest and owner acknowledgment'
        using errcode = '23514';
    end if;
  end if;
  if new.event_type = 'coding_closed' then
    select * into closure from analysis_study_closures row_value
    where row_value.id = new.closure_id
      and row_value.project_id = new.project_id
      and row_value.study_id = new.study_id
      and row_value.closure_digest = new.closure_digest
      and row_value.close_cause = new.close_cause
      and row_value.close_actor_role = new.actor_role
      and row_value.close_actor_user_id is not distinct from new.actor_user_id
      and row_value.close_actor_subject_id is not distinct from new.actor_subject_id
      and row_value.close_reason is not distinct from new.reason;
    if closure.id is null then
      raise exception 'coding_closed must bind the exact materialized closure'
        using errcode = '23514';
    end if;
    new.occurred_at := closure.recorded_at;
  else
    new.occurred_at := linearized_at;
  end if;
  if new.request_digest <> analysis_study_event_request_digest_v1(new) then
    raise exception 'analysis study event request digest does not match the exact transition'
      using errcode = '23514';
  end if;
  new.event_digest := analysis_study_event_digest_v1(new);
  return new;
end;
$$;


--
-- Name: guard_analysis_study_item(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_study_item() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  study analysis_studies%rowtype;
begin
  select * into study from analysis_studies row_value
  where row_value.id = new.study_id and row_value.project_id = new.project_id;
  if study.id is null or new.created_at <> study.created_at then
    raise exception 'analysis study items must be created atomically with their study'
      using errcode = '23514';
  end if;
  if new.content_digest <> analysis_study_item_content_digest_v1(new) then
    raise exception 'analysis study item content digest does not match canonical lineage'
      using errcode = '23514';
  end if;
  if exists (select 1 from analysis_study_events event where event.study_id = study.id) then
    raise exception 'analysis study items are frozen before the first study event'
      using errcode = '23514';
  end if;
  if not exists (
    select 1
    from analysis_population_draw_items draw_item
    join analysis_population_members member
      on member.id = draw_item.member_id
     and member.project_id = draw_item.project_id
     and member.population_id = draw_item.population_id
    where draw_item.id = new.draw_item_id
      and draw_item.project_id = new.project_id
      and draw_item.draw_id = study.draw_id
      and draw_item.population_id = study.population_id
      and draw_item.member_id = new.member_id
      and draw_item.revision_item_id = new.revision_item_id
      and draw_item.case_id = new.case_id
      and draw_item.position = new.position
      and member.revision_item_id = new.revision_item_id
      and member.case_id = new.case_id
  ) then
    raise exception 'analysis study item must bind its exact selected draw item and lineage'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_analysis_study_item_event(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_study_item_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  existing analysis_study_item_events%rowtype;
  head analysis_study_item_events%rowtype;
  target analysis_study_item_events%rowtype;
  study_item analysis_study_items%rowtype;
  study analysis_studies%rowtype;
  opened analysis_study_events%rowtype;
  current_state text;
  active_failure_count bigint;
  active_no_failure_id text;
  active_completion_id text;
  payload jsonb;
  linearized_at timestamptz;
begin
  select * into existing from analysis_study_item_events event
  where event.study_item_id = new.study_item_id
    and event.idempotency_key = new.idempotency_key;
  if existing.id is not null then
    if existing.request_digest <> new.request_digest then
      raise exception 'analysis item event idempotency key already has a different request'
        using errcode = '23514';
    end if;
    raise exception 'analysis item event replay must reuse the existing event'
      using errcode = '23505';
  end if;

  perform analysis_study_lock_v1(new.study_id);
  linearized_at := analysis_linearization_clock_v1();
  select * into existing from analysis_study_item_events event
  where event.study_item_id = new.study_item_id
    and event.idempotency_key = new.idempotency_key;
  if existing.id is not null then
    if existing.request_digest <> new.request_digest then
      raise exception 'analysis item event idempotency key already has a different request'
        using errcode = '23514';
    end if;
    raise exception 'analysis item event replay must reuse the existing event'
      using errcode = '23505';
  end if;
  select * into study from analysis_studies row_value
  where row_value.id = new.study_id and row_value.project_id = new.project_id;
  select * into study_item from analysis_study_items row_value
  where row_value.id = new.study_item_id and row_value.study_id = new.study_id
    and row_value.project_id = new.project_id;
  if study.id is null or study_item.id is null
     or not analysis_actor_role_exact_v1(
       new.project_id, new.actor_user_id, new.actor_subject_id, new.actor_role
     ) then
    raise exception 'analysis item event requires its exact study item, actor, and database clock'
      using errcode = '23514';
  end if;
  current_state := analysis_study_state_v1(new.study_id);
  select * into opened from analysis_study_events event
  where event.study_id = new.study_id and event.event_type = 'coding_opened';
  if current_state <> 'coding_open' or opened.id is null
     or (opened.stopping_rule = 'server_deadline'
       and linearized_at >= opened.close_at) then
    raise exception 'analysis item coding is closed by study state or deadline'
      using errcode = '23514';
  end if;

  select * into head from analysis_study_item_events event
  where event.study_item_id = new.study_item_id
  order by event.version desc limit 1;
  if new.version <> coalesce(head.version, 0) + 1
     or new.predecessor_event_id is distinct from head.id
     or new.predecessor_event_digest is distinct from head.event_digest then
    raise exception 'analysis item event compare-and-swap head mismatch'
      using errcode = '23514';
  end if;

  select count(*) into active_failure_count
  from analysis_study_item_events observation
  where observation.study_item_id = new.study_item_id
    and observation.event_type = 'failure_observed'
    and not exists (
      select 1 from analysis_study_item_events withdrawal
      where withdrawal.study_item_id = observation.study_item_id
        and withdrawal.event_type = 'failure_withdrawn'
        and withdrawal.target_event_id = observation.id
    );
  select observation.id into active_no_failure_id
  from analysis_study_item_events observation
  where observation.study_item_id = new.study_item_id
    and observation.event_type = 'no_failure_observed'
    and not exists (
      select 1 from analysis_study_item_events withdrawal
      where withdrawal.study_item_id = observation.study_item_id
        and withdrawal.event_type = 'no_failure_withdrawn'
        and withdrawal.target_event_id = observation.id
    )
  order by observation.version desc limit 1;
  select completion.id into active_completion_id
  from analysis_study_item_events completion
  where completion.study_item_id = new.study_item_id
    and completion.event_type = 'coding_completed'
    and not exists (
      select 1 from analysis_study_item_events reopen
      where reopen.study_item_id = completion.study_item_id
        and reopen.event_type = 'coding_reopened'
        and reopen.target_event_id = completion.id
    )
  order by completion.version desc limit 1;

  if active_completion_id is not null and new.event_type <> 'coding_reopened' then
    raise exception 'completed coding must be explicitly reopened before further coding changes'
      using errcode = '23514';
  end if;
  if new.target_event_id is not null then
    select * into target from analysis_study_item_events event
    where event.id = new.target_event_id and event.study_item_id = new.study_item_id;
  end if;

  if new.event_type = 'failure_observed' then
    if active_no_failure_id is not null then
      raise exception 'active no-failure evidence must be withdrawn before recording a failure'
        using errcode = '23514';
    end if;
    select item.payload_snapshot into payload
    from dataset_revision_items item where item.id = study_item.revision_item_id;
    if (new.anchor_kind = 'case_output' and not (payload ? 'output'))
       or (new.anchor_kind = 'step' and case
         when jsonb_typeof(payload -> 'steps') = 'array'
           then new.anchor_step_index >= jsonb_array_length(payload -> 'steps')
         else true
       end) then
      raise exception 'failure observation evidence anchor must exist in the frozen payload'
        using errcode = '23514';
    end if;
  elsif new.event_type = 'failure_withdrawn' then
    if target.id is null or target.event_type <> 'failure_observed'
       or exists (
         select 1 from analysis_study_item_events prior
         where prior.event_type = 'failure_withdrawn'
           and prior.target_event_id = target.id
       ) then
      raise exception 'failure withdrawal must target one active failure observation'
        using errcode = '23514';
    end if;
  elsif new.event_type = 'no_failure_observed' then
    if active_failure_count <> 0 or active_no_failure_id is not null then
      raise exception 'no-failure evidence is exclusive with active coding evidence'
        using errcode = '23514';
    end if;
  elsif new.event_type = 'no_failure_withdrawn' then
    if target.id is null or target.event_type <> 'no_failure_observed'
       or target.id is distinct from active_no_failure_id then
      raise exception 'no-failure withdrawal must target the active no-failure event'
        using errcode = '23514';
    end if;
  elsif new.event_type = 'coding_completed' then
    if active_failure_count = 0 and active_no_failure_id is null then
      raise exception 'coding completion requires active failure or explicit no-failure evidence'
        using errcode = '23514';
    end if;
  elsif new.event_type = 'coding_reopened' then
    if target.id is null or target.event_type <> 'coding_completed'
       or target.id is distinct from active_completion_id then
      raise exception 'coding reopen must target the active completion event'
        using errcode = '23514';
    end if;
  end if;
  new.occurred_at := linearized_at;
  if new.request_digest <> analysis_study_item_event_request_digest_v1(new) then
    raise exception 'analysis item event request digest does not match the exact command'
      using errcode = '23514';
  end if;
  new.event_digest := analysis_study_item_event_digest_v1(new);
  return new;
end;
$$;


--
-- Name: guard_analysis_study_item_view(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_study_item_view() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  study analysis_studies%rowtype;
  study_item analysis_study_items%rowtype;
  opened analysis_study_events%rowtype;
  current_state text;
  linearized_at timestamptz;
begin
  perform analysis_study_lock_v1(new.study_id);
  linearized_at := analysis_linearization_clock_v1();
  select * into study from analysis_studies row_value
  where row_value.id = new.study_id and row_value.project_id = new.project_id;
  select * into study_item from analysis_study_items row_value
  where row_value.id = new.study_item_id and row_value.study_id = new.study_id
    and row_value.project_id = new.project_id;
  if study.id is null or study_item.id is null then
    raise exception 'analysis study view must bind an exact selected study item'
      using errcode = '23514';
  end if;
  current_state := analysis_study_state_v1(new.study_id);
  select * into opened from analysis_study_events event
  where event.study_id = new.study_id and event.event_type = 'coding_opened';
  if current_state = 'coding_open' and opened.stopping_rule = 'server_deadline'
     and linearized_at >= opened.close_at then
    raise exception 'overdue analysis study must materialize closure before content view'
      using errcode = '23514';
  end if;
  if current_state in ('draft','abandoned') then
    raise exception 'analysis study content is unavailable before coding or after abandonment'
      using errcode = '23514';
  end if;
  if not analysis_actor_has_role_v1(
       new.project_id, new.viewer_user_id, new.viewer_subject_id, 'member'
     ) then
    raise exception 'analysis study view requires an exact member subject'
      using errcode = '23514';
  end if;
  new.viewed_at := linearized_at;
  new.counts_toward_closure := current_state = 'coding_open';
  if new.request_digest <> analysis_study_item_view_request_digest_v1(
       new, study.dataset_revision_id
     ) then
    raise exception 'analysis study view request digest does not match its exact route and viewer'
      using errcode = '23514';
  end if;
  if not exists (
    select 1 from dataset_exposure_events exposure
    where exposure.id = new.dataset_exposure_event_id
      and exposure.project_id = new.project_id
      and exposure.revision_id = study.dataset_revision_id
      and exposure.revision_item_id is null
      and exposure.kind = 'human_access'
      and exposure.exposure_class = 'development'
      and exposure.activity = 'content_view'
      and exposure.subject_kind = 'person'
      and exposure.subject_id = new.viewer_subject_id
      and exposure.actor_user_id = new.viewer_user_id
      and exposure.evidence_ref_kind = 'analysis_population'
      and exposure.evidence_ref_id = study.population_id
  ) then
    raise exception 'analysis study view requires its exact atomic analysis content exposure'
      using errcode = '23514';
  end if;
  new.content_digest := analysis_study_item_view_digest_v1(new);
  return new;
end;
$$;


--
-- Name: guard_analysis_taxonomy_revision_code(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_taxonomy_revision_code() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.created_at <> transaction_timestamp() or not exists (
    select 1
    from analysis_failure_taxonomy_revisions revision
    join analysis_failure_codes code
      on code.id = new.code_id
     and code.project_id = revision.project_id
     and code.taxonomy_id = revision.taxonomy_id
    where revision.id = new.taxonomy_revision_id
      and revision.project_id = new.project_id
      and revision.taxonomy_id = new.taxonomy_id
      and revision.created_at = new.created_at
      and new.position < revision.code_count
  ) then
    raise exception 'taxonomy revision code must bind its exact revision and stable code identity'
      using errcode = '23514';
  end if;
  if new.entry_digest <> analysis_taxonomy_revision_code_digest_v1(new) then
    raise exception 'taxonomy revision code digest does not match canonical entry evidence'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_analysis_taxonomy_revision_complete(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_analysis_taxonomy_revision_complete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  predecessor analysis_failure_taxonomy_revisions%rowtype;
begin
  if (select count(*) from analysis_failure_taxonomy_revision_codes entry
      where entry.taxonomy_revision_id = new.id) <> new.code_count
     or (select min(entry.position) from analysis_failure_taxonomy_revision_codes entry
         where entry.taxonomy_revision_id = new.id) <> 0
     or (select max(entry.position) from analysis_failure_taxonomy_revision_codes entry
         where entry.taxonomy_revision_id = new.id) <> new.code_count - 1
     or exists (
       select 1 from analysis_failure_codes code
       where code.created_in_revision_id = new.id
         and not exists (
           select 1 from analysis_failure_taxonomy_revision_codes entry
           where entry.taxonomy_revision_id = new.id and entry.code_id = code.id
         )
     ) or new.content_digest <> analysis_taxonomy_content_digest_v1(new.id)
     or new.revision_digest <> analysis_taxonomy_revision_digest_v1(new)
     or jsonb_array_length(new.request_payload -> 'codes') <> new.code_count
     or exists (
       select 1
       from jsonb_array_elements(new.request_payload -> 'codes')
         with ordinality command(value, ordinal)
       left join analysis_failure_taxonomy_revision_codes entry
         on entry.taxonomy_revision_id = new.id
        and entry.position = command.ordinal - 1
       left join analysis_failure_codes code on code.id = entry.code_id
       where entry.id is null or code.id is null
          or case command.value ->> 'kind'
            when 'new' then
              (select count(*) from jsonb_object_keys(command.value)) <> 4
              or not command.value ?& array['kind','clientToken','label','definition']
              or code.created_in_revision_id <> new.id
              or code.client_token is distinct from command.value ->> 'clientToken'
              or entry.label is distinct from command.value ->> 'label'
              or entry.definition is distinct from command.value ->> 'definition'
              or entry.status <> 'active'
            when 'existing' then
              (select count(*) from jsonb_object_keys(command.value)) <> 5
              or not command.value ?& array['kind','codeId','label','definition','status']
              or code.created_in_revision_id = new.id
              or entry.code_id is distinct from command.value ->> 'codeId'
              or entry.label is distinct from command.value ->> 'label'
              or entry.definition is distinct from command.value ->> 'definition'
              or entry.status is distinct from command.value ->> 'status'
            else true
          end
     ) then
    raise exception 'taxonomy revision must contain its exact canonical request-bound code set'
      using errcode = '23514';
  end if;
  if new.predecessor_revision_id is null then
    if exists (
      select 1
      from analysis_failure_taxonomy_revision_codes entry
      join analysis_failure_codes code on code.id = entry.code_id
      where entry.taxonomy_revision_id = new.id
        and (entry.status <> 'active' or code.created_in_revision_id <> new.id)
    ) then
      raise exception 'initial taxonomy revision codes must be newly created and active'
        using errcode = '23514';
    end if;
  else
    select * into predecessor from analysis_failure_taxonomy_revisions revision
    where revision.id = new.predecessor_revision_id;
    if exists (
      select prior.code_id
      from analysis_failure_taxonomy_revision_codes prior
      where prior.taxonomy_revision_id = predecessor.id
      except
      select current_entry.code_id
      from analysis_failure_taxonomy_revision_codes current_entry
      where current_entry.taxonomy_revision_id = new.id
    ) or exists (
      select 1
      from analysis_failure_taxonomy_revision_codes current_entry
      join analysis_failure_codes code on code.id = current_entry.code_id
      where current_entry.taxonomy_revision_id = new.id
        and code.created_in_revision_id not in (new.id, predecessor.id)
        and not exists (
          select 1 from analysis_failure_taxonomy_revision_codes prior
          where prior.taxonomy_revision_id = predecessor.id
            and prior.code_id = current_entry.code_id
        )
    ) or exists (
      select 1
      from analysis_failure_taxonomy_revision_codes prior
      join analysis_failure_taxonomy_revision_codes current_entry
        on current_entry.code_id = prior.code_id
       and current_entry.taxonomy_revision_id = new.id
      where prior.taxonomy_revision_id = predecessor.id
        and ((current_entry.status = 'retired' and (
            current_entry.label <> prior.label
            or current_entry.definition <> prior.definition
          ))
          or (prior.status = 'retired' and current_entry.status <> 'retired'))
    ) then
      raise exception 'taxonomy successor must retain every code and keep retired codes terminal and frozen'
        using errcode = '23514';
    end if;
  end if;
  return null;
end;
$$;


--
-- Name: guard_assessment_receipt_append_only(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_assessment_receipt_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'UPDATE' then
    raise exception '% rows are append-only', tg_table_name using errcode = '55000';
  end if;
  if tg_op = 'DELETE' and exists (select 1 from projects where id = old.project_id) then
    raise exception '% rows are append-only while their project exists', tg_table_name using errcode = '55000';
  end if;
  return old;
end;
$$;


--
-- Name: guard_assessment_receipt_comparison_owner(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_assessment_receipt_comparison_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if not exists (
    select 1
    from assessment_receipt_artifacts artifact
    where artifact.id = new.artifact_id
      and artifact.project_id = new.project_id
      and artifact.eval_run_id = new.eval_run_id
  ) then
    raise exception 'assessment receipt comparison must reference an artifact in the same assessment'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_assessment_receipt_lineage(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_assessment_receipt_lineage() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.artifact_revision = 1 then
    return new;
  end if;
  if not exists (
    select 1
    from assessment_receipt_artifacts predecessor
    where predecessor.id = new.predecessor_artifact_id
      and predecessor.project_id = new.project_id
      and predecessor.eval_run_id = new.eval_run_id
      and predecessor.contract_version = new.contract_version
      and predecessor.artifact_revision = new.artifact_revision - 1
  ) then
    raise exception 'assessment receipt predecessor must be the prior revision in the same lineage'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_batch3_evidence_append_only(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_batch3_evidence_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'UPDATE' then
    raise exception '% rows are append-only', tg_table_name using errcode = '55000';
  end if;
  if tg_op = 'DELETE' and exists (select 1 from projects where id = old.project_id) then
    raise exception '% rows are append-only while their project exists', tg_table_name using errcode = '55000';
  end if;
  return old;
end;
$$;


--
-- Name: guard_binary_calibration_append_only(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_binary_calibration_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'UPDATE' then
    raise exception '% rows are append-only', tg_table_name using errcode = '55000';
  end if;
  if tg_op = 'DELETE' and exists (
    select 1 from projects project where project.id = old.project_id
  ) then
    raise exception '% rows are append-only while their project exists', tg_table_name
      using errcode = '55000';
  end if;
  return old;
end;
$$;


--
-- Name: guard_binary_calibration_attempt(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_binary_calibration_attempt() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  run binary_calibration_runs%rowtype;
  item dataset_revision_items%rowtype;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from projects project where project.id = old.project_id) then
      raise exception 'binary calibration attempt rows cannot be deleted while their project exists'
        using errcode = '55000';
    end if;
    return old;
  end if;
  select * into run from binary_calibration_runs where id = new.run_id;
  select * into item from dataset_revision_items where id = new.dataset_revision_item_id;
  if run.id is null or item.id is null or run.project_id <> new.project_id
     or item.project_id <> new.project_id or item.revision_id <> run.dataset_revision_id
     or item.item_digest <> new.dataset_revision_item_digest
     or new.provider <> run.requested_provider then
    raise exception 'binary calibration attempt must bind one run item and requested provider'
      using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then return new; end if;
  if new.id is distinct from old.id or new.run_id is distinct from old.run_id
     or new.project_id is distinct from old.project_id
     or new.dataset_revision_item_id is distinct from old.dataset_revision_item_id
     or new.dataset_revision_item_digest is distinct from old.dataset_revision_item_digest
     or new.trial_index is distinct from old.trial_index
     or new.truth_label is distinct from old.truth_label
     or new.provider is distinct from old.provider
     or new.commitment_salt is distinct from old.commitment_salt
     or new.created_at is distinct from old.created_at then
    raise exception 'binary calibration attempt identity is immutable' using errcode = '55000';
  end if;
  if old.accounting_state = 'accounted' then
    raise exception 'accounted binary calibration attempts are immutable' using errcode = '55000';
  end if;
  if new.physical_provider_calls < old.physical_provider_calls
     or new.attempt_state = 'not_started' and old.attempt_state <> 'not_started'
     or new.attempt_state = 'started' and old.attempt_state = 'terminal' then
    raise exception 'binary calibration attempt state and call counts are monotonic' using errcode = '55000';
  end if;
  return new;
end;
$$;


--
-- Name: guard_binary_calibration_evidence_insert(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_binary_calibration_evidence_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_table_name = 'binary_calibration_exposure_checks' then
    if not exists (
      select 1 from binary_calibration_runs run
      where run.id = new.run_id and run.project_id = new.project_id
    ) or new.snapshot_digest <> governed_bytes_v1_digest(new.canonical_bytes) then
      raise exception 'binary calibration exposure snapshot ownership or digest mismatch'
        using errcode = '23514';
    end if;
  elsif tg_table_name = 'binary_calibration_private_ledgers' then
    if not exists (
      select 1 from binary_calibration_runs run
      where run.id = new.run_id and run.project_id = new.project_id
    ) or new.commitment_digest <> governed_bytes_v1_digest(new.canonical_bytes) then
      raise exception 'binary calibration private ledger ownership or commitment mismatch'
        using errcode = '23514';
    end if;
  elsif tg_table_name = 'binary_calibration_artifacts' then
    if not exists (
      select 1 from binary_calibration_runs run
      join binary_calibration_private_ledgers ledger on ledger.id = new.private_ledger_id
      where run.id = new.run_id and run.project_id = new.project_id
        and ledger.run_id = run.id and ledger.project_id = run.project_id
        and ledger.artifact_id = new.id
    ) or new.artifact_digest <> governed_bytes_v1_digest(new.canonical_bytes) then
      raise exception 'binary calibration artifact ownership or byte digest mismatch'
        using errcode = '23514';
    end if;
  elsif tg_table_name = 'binary_calibration_revocation_events' then
    if not exists (
      select 1 from binary_calibration_artifacts artifact
      where artifact.id = new.artifact_id and artifact.run_id = new.run_id
        and artifact.project_id = new.project_id
    ) then
      raise exception 'binary calibration revocation must bind one artifact project'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;


--
-- Name: guard_binary_calibration_exposure_during_lease(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_binary_calibration_exposure_during_lease() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.exposure_class = 'development' or new.activity in (
    'declassify','analysis_authoring','rubric_authoring','prompt_tuning',
    'example_selection','model_selection','development_run','regression_run'
  ) then
    perform 1 from dataset_revisions where id = new.revision_id for update;
    -- Occurrence is an observed server fact, not caller chronology. Assign it
    -- only after the revision lock so an insert which waited for terminal mint
    -- cannot backdate itself before the completion/lease-release boundary.
    new.occurred_at := date_trunc('milliseconds', clock_timestamp());
    if exists (
      select 1 from binary_calibration_revision_leases lease
      where lease.dataset_revision_id = new.revision_id
    ) then
      raise exception 'development exposure is blocked by active sealed calibration lease'
        using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;


--
-- Name: guard_binary_calibration_revision_lease(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_binary_calibration_revision_lease() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if not exists (
    select 1 from binary_calibration_runs run
    join dataset_revisions revision on revision.id = new.dataset_revision_id
    where run.id = new.run_id and run.dataset_revision_id = revision.id
      and run.project_id = new.project_id and revision.project_id = new.project_id
      and run.state in ('running','recovery_required')
  ) then
    raise exception 'binary calibration revision lease must bind one active run project'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_binary_calibration_run(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_binary_calibration_run() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  revision dataset_revisions%rowtype;
  version skill_versions%rowtype;
  skill_row skills%rowtype;
  criterion criterion_versions%rowtype;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from projects project where project.id = old.project_id) then
      raise exception 'binary calibration run rows cannot be deleted while their project exists'
        using errcode = '55000';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    select * into revision from dataset_revisions where id = new.dataset_revision_id;
    select * into version from skill_versions where id = new.skill_version_id;
    select * into skill_row from skills where id = new.skill_id;
    select * into criterion from criterion_versions where id = new.criterion_version_id;
    if revision.id is null or version.id is null or skill_row.id is null or criterion.id is null
       or revision.project_id <> new.project_id or version.project_id <> new.project_id
       or skill_row.project_id <> new.project_id or criterion.project_id <> new.project_id
       or revision.role <> 'sealed_validation' or revision.source_kind <> 'sealed_intake'
       or revision.provenance_level <> 'governed_blind'
       or revision.revision_digest <> new.revision_digest
       or revision.content_digest <> new.truth_content_digest
       or revision.item_count <> new.item_count
       or version.skill_id <> new.skill_id
       or version.criterion_version_id <> new.criterion_version_id
       or skill_row.criterion_id <> new.criterion_id
       or criterion.criterion_id <> new.criterion_id
       or criterion.criterion_digest <> new.criterion_digest
       or new.provider_policy_digest <> governed_bytes_v1_digest(new.provider_policy_canonical_bytes)
       or not exists (
         select 1 from governed_review_batches batch
         join review_instruction_versions instruction on instruction.id = batch.instruction_version_id
         join governed_review_batch_events frozen
           on frozen.batch_id = batch.id and frozen.event_kind = 'frozen'
         where batch.id = new.governed_review_batch_id
           and batch.project_id = new.project_id
           and batch.criterion_version_id = new.criterion_version_id
           and batch.content_digest = new.governed_review_batch_digest
           and batch.instruction_version_id = new.review_instruction_version_id
           and instruction.content_digest = new.review_instruction_digest
           and frozen.dataset_revision_id = new.dataset_revision_id
           and batch.population_id = new.population_id
           and batch.population_digest = new.population_digest
           and batch.draw_digest = new.draw_digest
           and batch.selection_method = new.selection_method
       ) then
      raise exception 'binary calibration run identity is not one governed sealed binary lineage'
        using errcode = '23514';
    end if;
    if (new.suite_manifest_id is not null) and not exists (
      select 1
      from evaluator_suite_manifests manifest
      join evaluator_suite_manifest_members member
        on member.manifest_id = manifest.id and member.position = new.suite_member_position
      where manifest.id = new.suite_manifest_id
        and manifest.project_id = new.project_id
        and manifest.manifest_digest = new.suite_manifest_digest
        and manifest.trial_plan = 'null'::jsonb
        and member.skill_version_id = new.skill_version_id
        and member.criterion_version_id = new.criterion_version_id
        and member.skill_digest = new.skill_digest
        and member.output_contract_digest = new.output_contract_digest
    ) then
      raise exception 'binary calibration suite binding is not the exact single-trial member'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.project_id is distinct from old.project_id
     or new.dataset_revision_id is distinct from old.dataset_revision_id
     or new.revision_digest is distinct from old.revision_digest
     or new.truth_content_digest is distinct from old.truth_content_digest
     or new.item_count is distinct from old.item_count
     or new.criterion_id is distinct from old.criterion_id
     or new.criterion_version_id is distinct from old.criterion_version_id
     or new.criterion_digest is distinct from old.criterion_digest
     or new.skill_id is distinct from old.skill_id
     or new.skill_version_id is distinct from old.skill_version_id
     or new.skill_digest is distinct from old.skill_digest
     or new.output_contract_digest is distinct from old.output_contract_digest
     or new.requested_provider is distinct from old.requested_provider
     or new.requested_model_id is distinct from old.requested_model_id
     or new.requested_model_version is distinct from old.requested_model_version
     or new.temperature_decimal is distinct from old.temperature_decimal
     or new.top_p_decimal is distinct from old.top_p_decimal
     or new.endpoint_kind is distinct from old.endpoint_kind
     or new.base_url_digest is distinct from old.base_url_digest
     or new.requested_binding_digest is distinct from old.requested_binding_digest
     or new.suite_manifest_id is distinct from old.suite_manifest_id
     or new.suite_manifest_digest is distinct from old.suite_manifest_digest
     or new.suite_member_position is distinct from old.suite_member_position
     or new.governed_review_batch_id is distinct from old.governed_review_batch_id
     or new.governed_review_batch_digest is distinct from old.governed_review_batch_digest
     or new.review_instruction_version_id is distinct from old.review_instruction_version_id
     or new.review_instruction_digest is distinct from old.review_instruction_digest
     or new.population_id is distinct from old.population_id
     or new.population_digest is distinct from old.population_digest
     or new.draw_digest is distinct from old.draw_digest
     or new.representative_of_population_id is distinct from old.representative_of_population_id
     or new.representative_ineligible_reasons is distinct from old.representative_ineligible_reasons
     or new.selection_method is distinct from old.selection_method
     or new.positive_class is distinct from old.positive_class
     or new.trial_plan_kind is distinct from old.trial_plan_kind
     or new.trials_per_item is distinct from old.trials_per_item
     or new.execution_environment is distinct from old.execution_environment
     or new.provider_policy_id is distinct from old.provider_policy_id
     or new.provider_policy_digest is distinct from old.provider_policy_digest
     or new.provider_policy_canonical_bytes is distinct from old.provider_policy_canonical_bytes
     or new.payload_transmission is distinct from old.payload_transmission
     or new.idempotency_key is distinct from old.idempotency_key
     or new.request_digest is distinct from old.request_digest
     or new.planned_observations is distinct from old.planned_observations
     or new.created_at is distinct from old.created_at then
    raise exception 'binary calibration pinned run identity is immutable' using errcode = '55000';
  end if;
  if old.state in ('complete','incomplete','rejected') then
    raise exception 'terminal binary calibration runs are immutable' using errcode = '55000';
  end if;
  if not (
    new.state = old.state
    or (old.state = 'queued' and new.state in ('running','recovery_required','rejected'))
    or (old.state = 'running' and new.state in ('recovery_required','complete','incomplete','rejected'))
    or (old.state = 'recovery_required' and new.state in ('running','complete','incomplete','rejected'))
  ) then
    raise exception 'invalid binary calibration run state transition' using errcode = '55000';
  end if;
  if new.accounted_observations < old.accounted_observations then
    raise exception 'binary calibration accounted observations are monotonic' using errcode = '55000';
  end if;
  return new;
end;
$$;


--
-- Name: guard_case_ingestion_purpose_update(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_case_ingestion_purpose_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'case ingestion purpose is immutable'
    using errcode = '55000';
end;
$$;


--
-- Name: guard_criterion_regression_revision(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_criterion_regression_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if not exists (
    select 1
    from criterion_versions criterion_version
    join dataset_revisions revision
      on revision.id = new.revision_id
     and revision.project_id = new.project_id
     and revision.criterion_version_id = new.criterion_version_id
     and revision.role = 'regression_golden'
    where criterion_version.id = new.criterion_version_id
      and criterion_version.project_id = new.project_id
  ) then
    raise exception 'criterion regression pointer must reference a matching regression/golden revision'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_criterion_version_owner(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_criterion_version_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  criterion criteria%rowtype;
begin
  select * into criterion from criteria row_value
  where row_value.id = new.criterion_id and row_value.project_id = new.project_id;
  if criterion.id is null then
    raise exception 'criterion version must belong to its criterion project'
      using errcode = '23514';
  end if;
  if criterion.source_kind = 'analysis_promotion' then
    if new.source_kind <> 'analysis_promotion' or new.revision <> 1 then
      raise exception 'analysis-promotion criterion definitions cannot gain generic successors'
        using errcode = '23514';
    end if;
  elsif new.source_kind = 'analysis_promotion' then
    raise exception 'analysis-promotion definition source requires an analysis-promotion criterion'
      using errcode = '23514';
  end if;
  if new.criterion_digest <> criterion_v1_digest(
    new.criterion_id, new.id, new.name, new.definition
  ) then
    raise exception 'criterion version digest does not match its canonical descriptor'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_dataset_evidence_append_only(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_dataset_evidence_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'UPDATE' then
    raise exception '% rows are append-only', tg_table_name using errcode = '55000';
  end if;
  if tg_op = 'DELETE' and exists (select 1 from projects where id = old.project_id) then
    raise exception '% rows are append-only while their project exists', tg_table_name using errcode = '55000';
  end if;
  return old;
end;
$$;


--
-- Name: guard_dataset_exposure_owner(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_dataset_exposure_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  revision dataset_revisions%rowtype;
  promotion analysis_criterion_promotions%rowtype;
  support analysis_criterion_promotion_supports%rowtype;
begin
  select * into revision from dataset_revisions row_value
  where row_value.id = new.revision_id and row_value.project_id = new.project_id;
  if revision.id is null then
    raise exception 'dataset exposure must belong to its revision project'
      using errcode = '23514';
  end if;
  if new.revision_item_id is not null and not exists (
    select 1 from dataset_revision_items item
    where item.id = new.revision_item_id
      and item.revision_id = new.revision_id
      and item.project_id = new.project_id
  ) then
    raise exception 'dataset exposure item must belong to its revision and project'
      using errcode = '23514';
  end if;

  if new.evidence_ref_kind = 'analysis_criterion_promotion'
     or new.idempotency_key like 'analysis-promotion:%' then
    select * into promotion from analysis_criterion_promotions row_value
    where row_value.project_id = new.project_id
      and row_value.criterion_authoring_exposure_event_id = new.id;
    select * into support from analysis_criterion_promotion_supports row_value
    where row_value.project_id = new.project_id
      and row_value.example_selection_exposure_event_id = new.id;
    if promotion.id is not null then
      if revision.source_kind <> 'analysis_population'
         or new.revision_id <> promotion.source_dataset_revision_id
         or new.revision_item_id is not null
         or new.kind <> 'development_use'
         or new.exposure_class <> 'development'
         or new.activity <> 'criterion_authoring'
         or new.subject_kind <> 'person'
         or new.subject_id <> promotion.promoted_by_subject_id
         or new.actor_user_id <> promotion.promoted_by_user_id
         or new.evidence_ref_kind <> 'analysis_criterion_promotion'
         or new.evidence_ref_id <> promotion.id
         or new.reason <> 'Analysis failure-code criterion authoring'
         or new.details <> analysis_criterion_authoring_exposure_details_v1(promotion)
         or new.idempotency_key <> 'analysis-promotion:criterion-authoring:' || promotion.id
         or new.occurred_at < promotion.created_at then
        raise exception 'criterion-authoring exposure must bind the exact promotion and durable promoter'
          using errcode = '23514';
      end if;
    elsif support.id is not null then
      select * into promotion from analysis_criterion_promotions row_value
      where row_value.id = support.promotion_id and row_value.project_id = support.project_id;
      if revision.source_kind <> 'analysis_population'
         or new.revision_id <> promotion.source_dataset_revision_id
         or new.revision_item_id <> support.source_dataset_revision_item_id
         or new.kind <> 'development_use'
         or new.exposure_class <> 'development'
         or new.activity <> 'example_selection'
         or new.subject_kind <> 'person'
         or new.subject_id <> support.observation_author_subject_id
         or new.actor_user_id <> promotion.promoted_by_user_id
         or new.evidence_ref_kind <> 'analysis_criterion_promotion'
         or new.evidence_ref_id <> promotion.id
         or new.reason <> 'Analysis promotion supporting observation'
         or new.details <> analysis_criterion_support_exposure_details_v1(promotion, support)
         or new.idempotency_key <>
              'analysis-promotion:example-selection:' || promotion.id || ':' || support.id
         or new.occurred_at < promotion.created_at then
        raise exception 'example-selection exposure must bind the exact promotion support and author'
          using errcode = '23514';
      end if;
    else
      raise exception 'analysis promotion exposure namespace is reserved for an exact promotion bundle'
        using errcode = '23514';
    end if;
  elsif new.evidence_ref_kind = 'analysis_population'
        or new.idempotency_key like 'analysis-content-view:%' then
    if revision.source_kind <> 'analysis_population'
       or revision.analysis_population_id is null
       or new.evidence_ref_id <> revision.analysis_population_id
       or new.revision_item_id is not null
       or new.kind <> 'human_access'
       or new.exposure_class <> 'development'
       or new.activity <> 'content_view'
       or new.subject_kind <> 'person'
       or new.subject_id is null
       or new.actor_user_id is null
       or new.idempotency_key <> 'analysis-content-view:' || new.revision_id || ':' || new.subject_id
       or not exists (
         select 1 from governed_reviewer_subjects subject
         where subject.id = new.subject_id
           and subject.project_id = new.project_id
           and subject.account_user_id = new.actor_user_id
       ) then
      raise exception 'analysis population content exposure must bind its exact human subject and revision'
        using errcode = '23514';
    end if;
  elsif revision.source_kind = 'analysis_population'
        and new.activity in ('criterion_authoring','example_selection') then
    raise exception 'analysis promotion development exposure requires the exact promotion evidence reference'
      using errcode = '23514';
  elsif revision.source_kind = 'analysis_population' and new.activity = 'content_view' then
    raise exception 'analysis population content views require the exact analysis population evidence reference'
      using errcode = '23514';
  elsif revision.source_kind = 'analysis_population'
        and new.kind = 'created'
        and new.activity <> 'revision_create' then
    raise exception 'analysis population revision creation activity must be revision_create'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_dataset_revision_item_owner(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_dataset_revision_item_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if not exists (
    select 1 from dataset_revisions revision
    where revision.id = new.revision_id
      and revision.project_id = new.project_id
  ) then
    raise exception 'dataset revision item must belong to its revision project'
      using errcode = '23514';
  end if;
  if new.source_case_id is not null and not exists (
    select 1 from cases source_case
    where source_case.id = new.source_case_id
      and source_case.project_id = new.project_id
      and (
        jsonb_build_object(
          'input', source_case.normalized_payload -> 'input',
          'output', source_case.normalized_payload -> 'output',
          'metadata', coalesce(source_case.normalized_payload -> 'metadata', '{}'::jsonb)
        ) || case
          when jsonb_typeof(source_case.normalized_payload -> 'steps') = 'array'
            then jsonb_build_object('steps', source_case.normalized_payload -> 'steps')
          else '{}'::jsonb
        end
      ) = new.payload_snapshot
  ) then
    raise exception 'dataset revision payload must equal its source case snapshot at freeze time'
      using errcode = '23514';
  end if;
  -- Batch 2 intentionally rejects every exact sealed/nonsealed crossing. A
  -- future declassification batch must amend this item-level guard as well as
  -- enabling the revision-level declassification path above.
  if exists (
    select 1
    from dataset_revisions target
    join dataset_revision_items existing on existing.project_id = new.project_id
    join dataset_revisions source on source.id = existing.revision_id
    where target.id = new.revision_id
      and existing.revision_id <> new.revision_id
      and existing.input_digest = new.input_digest
      and (
        (target.role = 'sealed_validation' and source.role <> 'sealed_validation')
        or
        (target.role <> 'sealed_validation' and source.role = 'sealed_validation')
      )
  ) then
    raise exception 'exact input identity cannot cross the sealed/nonsealed boundary without governed declassification'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_dataset_revision_owner(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_dataset_revision_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  parent_role text;
  parent_source_kind text;
begin
  if new.parent_revision_id is not null and not exists (
    select 1 from dataset_revisions parent
    where parent.id = new.parent_revision_id
      and parent.project_id = new.project_id
      and parent.series_id = new.series_id
  ) then
    raise exception 'dataset revision parent must belong to the same project and series'
      using errcode = '23514';
  end if;
  if new.source_dataset_id is not null and not exists (
    select 1 from datasets source
    where source.id = new.source_dataset_id
      and source.project_id = new.project_id
  ) then
    raise exception 'dataset revision source must belong to the same project'
      using errcode = '23514';
  end if;
  if (new.role = 'sealed_validation') <> (new.source_kind = 'sealed_intake') then
    raise exception 'sealed validation revisions require sealed intake, and sealed intake requires sealed validation'
      using errcode = '23514';
  end if;
  if new.source_kind = 'golden_snapshot' and new.role <> 'regression_golden' then
    raise exception 'golden snapshots require the regression/golden role'
      using errcode = '23514';
  end if;
  if new.role = 'regression_golden' and new.source_kind <> 'golden_snapshot' then
    raise exception 'regression/golden revisions require a governed golden snapshot'
      using errcode = '23514';
  end if;
  if new.role = 'sealed_validation' and new.source_dataset_id is not null then
    raise exception 'sealed validation cannot be created from a mutable working collection'
      using errcode = '23514';
  end if;
  if new.source_kind = 'analysis_population' then
    if new.analysis_population_id is null
       or new.role <> 'analysis_authoring'
       or new.source_dataset_id is not null
       or new.parent_revision_id is not null
       or new.criterion_version_id is not null
       or new.revision_number <> 1
       or new.provenance_level <> 'unverified'
       or new.series_id <> 'analysis-population:' || new.analysis_population_id
       or new.idempotency_key is not null
       or not exists (
         select 1 from analysis_populations population
         where population.id = new.analysis_population_id
           and population.project_id = new.project_id
           and population.dataset_revision_id = new.id
           and population.created_by_user_id = new.created_by_user_id
           and population.created_at = new.created_at
       ) then
      raise exception 'analysis population revision must bind its exact immutable population contract'
        using errcode = '23514';
    end if;
  elsif new.analysis_population_id is not null then
    raise exception 'only an analysis population revision may name an analysis population'
      using errcode = '23514';
  end if;
  if new.parent_revision_id is not null then
    select role, source_kind into parent_role, parent_source_kind
    from dataset_revisions where id = new.parent_revision_id;
    if parent_source_kind = 'analysis_population' then
      raise exception 'analysis population revisions cannot have successors'
        using errcode = '23514';
    end if;
    if new.role = 'sealed_validation' then
      if parent_role <> 'sealed_validation' then
        raise exception 'nonsealed revisions cannot transition into sealed validation'
          using errcode = '23514';
      end if;
      if exists (
        select 1 from dataset_exposure_events exposure
        where exposure.revision_id = new.parent_revision_id
          and exposure.exposure_class = 'development'
      ) then
        raise exception 'an exposed sealed revision cannot create a sealed successor'
          using errcode = '23514';
      end if;
      if exists (
        select 1 from dataset_revisions child
        where child.parent_revision_id = new.parent_revision_id
          and child.role = 'sealed_validation'
      ) then
        raise exception 'a sealed revision may have only one direct sealed successor'
          using errcode = '23514';
      end if;
    elsif parent_role = 'sealed_validation' and not exists (
      select 1 from dataset_exposure_events exposure
      where exposure.revision_id = new.parent_revision_id
        and exposure.kind = 'declassification'
        and exposure.exposure_class = 'development'
    ) then
      raise exception 'sealed to nonsealed transition requires recorded declassification'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;


--
-- Name: guard_eval_run_revision_binding(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_eval_run_revision_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.dataset_revision_id is not null and not exists (
    select 1 from dataset_revisions revision
    where revision.id = new.dataset_revision_id
      and revision.project_id = new.project_id
  ) then
    raise exception 'eval run revision must belong to the same project'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_eval_run_revision_item(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_eval_run_revision_item() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if exists (
    select 1 from eval_runs run
    where run.id = new.eval_run_id
      and run.project_id = new.project_id
      and run.dataset_revision_id is not null
  ) and new.dataset_revision_item_id is null then
    raise exception 'revision-bound eval items require an immutable revision item binding'
      using errcode = '23514';
  end if;
  if new.dataset_revision_item_id is not null and not exists (
    select 1
    from dataset_revision_items item
    join eval_runs run
      on run.id = new.eval_run_id
     and run.project_id = new.project_id
    where item.id = new.dataset_revision_item_id
      and item.project_id = new.project_id
      and item.revision_id = run.dataset_revision_id
      and item.source_case_id = new.case_id
  ) then
    raise exception 'eval run revision item must belong to the run revision and project'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_evaluator_execution_authorization_v1(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_evaluator_execution_authorization_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  lifecycle evaluator_lifecycles%rowtype;
  head evaluator_lifecycle_events%rowtype;
  target_criterion_id text;
begin
  select skill.criterion_id into target_criterion_id
  from skill_versions version
  join skills skill on skill.id=version.skill_id and skill.project_id=version.project_id
  where version.project_id=new.project_id and version.id=new.skill_version_id;
  if target_criterion_id is null then
    raise exception 'execution authorization evaluator does not exist in the named project' using errcode='23514';
  end if;
  perform 1 from criteria where id=target_criterion_id and project_id=new.project_id for update;
  if not evaluator_skill_version_context_allowed_v1(new.project_id,new.skill_version_id,new.execution_context) then
    raise exception 'evaluator version is not authorized for the requested execution context' using errcode='23514';
  end if;
  select * into lifecycle from evaluator_lifecycles where project_id=new.project_id and skill_version_id=new.skill_version_id;
  if lifecycle.id is not null then
    select * into head from evaluator_lifecycle_head_v1(lifecycle.id);
    if new.lifecycle_event_id<>head.id then
      raise exception 'execution authorization must bind the current lifecycle head' using errcode='23514';
    end if;
    if new.calibration_artifact_id is distinct from head.calibration_artifact_id then
      raise exception 'execution authorization must bind the current activation artifact' using errcode='23514';
    end if;
  elsif new.lifecycle_event_id is not null or new.calibration_artifact_id is not null then
    raise exception 'legacy execution cannot claim lifecycle evidence' using errcode='23514';
  end if;
  if new.content_digest<>governed_content_v1_digest(
    'evaluator-execution-authorization/v1',jsonb_build_object(
      'projectId',new.project_id,
      'skillVersionId',new.skill_version_id,
      'context',new.execution_context,
      'lifecycleEventId',new.lifecycle_event_id,
      'calibrationArtifactId',new.calibration_artifact_id,
      'resourceKind',new.resource_kind,
      'resourceId',new.resource_id
    )
  ) then
    raise exception 'execution authorization content digest mismatch' using errcode='23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_evaluator_lifecycle_append_only_v1(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_evaluator_lifecycle_append_only_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op='UPDATE' then raise exception '% rows are append-only',tg_table_name using errcode='55000'; end if;
  if tg_op='DELETE' and exists (select 1 from projects where id=old.project_id) then
    raise exception '% rows are append-only while their project exists',tg_table_name using errcode='55000';
  end if;
  return old;
end;
$$;


--
-- Name: guard_evaluator_lifecycle_complete_v1(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_evaluator_lifecycle_complete_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if not exists (
    select 1
    from criteria criterion
    join criterion_versions definition on definition.id=new.criterion_version_id
      and definition.criterion_id=criterion.id and definition.project_id=criterion.project_id
    join analysis_criterion_promotions promotion on promotion.id=new.promotion_id
      and promotion.project_id=criterion.project_id
      and promotion.criterion_id=criterion.id and promotion.criterion_version_id=definition.id
    join governed_review_batches batch on batch.id=new.governed_batch_id
      and batch.project_id=criterion.project_id and batch.criterion_version_id=definition.id
      and batch.role_intent in ('analysis_authoring','iterative_development')
    join governed_review_batch_states state on state.batch_id=batch.id and state.state='frozen'
    join governed_review_batch_events frozen on frozen.batch_id=batch.id
      and frozen.event_kind='frozen' and frozen.dataset_revision_id=new.truth_dataset_revision_id
    join dataset_revisions truth on truth.id=new.truth_dataset_revision_id
      and truth.project_id=criterion.project_id and truth.criterion_version_id=definition.id
      and truth.role in ('analysis_authoring','iterative_development')
      and truth.provenance_level='governed_blind'
    join skills skill on skill.id=new.skill_id and skill.project_id=criterion.project_id
      and skill.criterion_id=criterion.id
    join skill_versions version on version.id=new.skill_version_id
      and version.project_id=criterion.project_id and version.skill_id=skill.id
      and version.criterion_version_id=definition.id
      and version.regression_dataset_revision_id=new.regression_dataset_revision_id
      and version.developer_identity_status='recorded'
      and version.created_by_user_id=new.created_by_user_id
      and version.created_by_subject_id=new.created_by_subject_id
    join dataset_revisions regression on regression.id=new.regression_dataset_revision_id
      and regression.project_id=criterion.project_id and regression.criterion_version_id=definition.id
      and regression.role='regression_golden' and regression.source_kind='golden_snapshot'
    where criterion.id=new.criterion_id and criterion.project_id=new.project_id
      and criterion.source_kind='analysis_promotion'
      and batch.content_digest=new.governed_batch_digest
      and truth.revision_digest=new.truth_revision_digest
      and truth.content_digest=new.truth_content_digest and truth.item_count=new.truth_item_count
      and regression.revision_digest=new.regression_revision_digest
      and regression.content_digest=new.regression_content_digest
      and regression.item_count=new.regression_item_count
  ) then raise exception 'candidate lifecycle bundle does not bind exact promotion, frozen truth, evaluator, and regression evidence' using errcode='23514';
  end if;
  if (select count(*) from skills skill where skill.project_id=new.project_id and skill.criterion_id=new.criterion_id)<>1
     or not exists (
       select 1 from evaluator_lifecycle_events event
       where event.lifecycle_id=new.id and event.sequence=1 and event.state='candidate'
         and event.transition='candidate_created' and event.actor_role='owner'
         and event.actor_user_id=new.created_by_user_id
         and event.actor_subject_id=new.created_by_subject_id
         and event.reason='Candidate created from exact frozen governed nonsealed truth.'
         and event.idempotency_key='candidate-created:' || new.id
     )
     or not exists (
       select 1 from dataset_exposure_events exposure
       where exposure.id=new.developer_exposure_event_id and exposure.project_id=new.project_id
         and exposure.revision_id=new.truth_dataset_revision_id
         and exposure.kind='human_access' and exposure.exposure_class='development'
         and exposure.activity='rubric_authoring' and exposure.subject_kind='person'
         and exposure.subject_id=new.created_by_subject_id and exposure.actor_user_id=new.created_by_user_id
         and exposure.evidence_ref_kind='evaluator_lifecycle' and exposure.evidence_ref_id=new.id
         and exposure.reason='Candidate evaluator authored from governed nonsealed truth'
         and exposure.details=jsonb_build_object(
           'criterionId',new.criterion_id,'skillVersionId',new.skill_version_id
         )
         and exposure.idempotency_key='candidate-authoring:' || new.id
     ) then raise exception 'candidate lifecycle requires one seed event and exact developer exposure' using errcode='23514';
  end if;
  if (select count(*) from governed_dataset_truth_links link
      where link.dataset_revision_id=new.truth_dataset_revision_id and link.resolved_label in ('pass','fail'))<>new.truth_item_count
     or exists (
       select 1 from dataset_revision_items truth
       left join dataset_revision_items regression
         on regression.revision_id=new.regression_dataset_revision_id and regression.position=truth.position
       left join governed_dataset_truth_links link
         on link.dataset_revision_item_id=truth.id and link.dataset_revision_id=truth.revision_id
       where truth.revision_id=new.truth_dataset_revision_id
         and (regression.id is null or link.id is null
           or regression.input_digest is distinct from truth.input_digest
           or regression.payload_snapshot is distinct from truth.payload_snapshot
           or regression.reference_label is distinct from truth.reference_label
           or regression.reference_provenance->>'sourceId' is distinct from link.id)
     ) then raise exception 'candidate regression revision must be an exact full copy of governed truth' using errcode='23514';
  end if;
  return null;
end;
$$;


--
-- Name: guard_evaluator_lifecycle_event_v1(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_evaluator_lifecycle_event_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  lifecycle evaluator_lifecycles%rowtype;
  predecessor evaluator_lifecycle_events%rowtype;
  artifact_evidence record;
  regression record;
begin
  select * into lifecycle from evaluator_lifecycles where id=new.lifecycle_id;
  if lifecycle.id is null or lifecycle.project_id<>new.project_id
     or lifecycle.criterion_id<>new.criterion_id
     or lifecycle.skill_version_id<>new.skill_version_id then
    raise exception 'lifecycle event must belong to its exact lifecycle' using errcode='23514';
  end if;
  perform 1 from criteria where id=new.criterion_id and project_id=new.project_id for update;
  if new.sequence=1 then
    if new.transition<>'candidate_created' then
      raise exception 'lifecycle seed must be candidate_created' using errcode='23514';
    end if;
  else
    select * into predecessor from evaluator_lifecycle_events where id=new.predecessor_event_id;
    if predecessor.id is null or predecessor.lifecycle_id<>new.lifecycle_id
       or predecessor.sequence+1<>new.sequence
       or predecessor.content_digest<>new.predecessor_event_digest
       or exists (select 1 from evaluator_lifecycle_events later
                  where later.lifecycle_id=new.lifecycle_id and later.sequence>=new.sequence) then
      raise exception 'lifecycle event predecessor is stale or belongs to another chain' using errcode='40001';
    end if;
    if predecessor.state='candidate' and new.state not in ('active','retired')
       or predecessor.state='active' and new.state not in ('needs_review','retired')
       or predecessor.state='needs_review' and new.state not in ('active','retired')
       or predecessor.state='retired' then
      raise exception 'invalid evaluator lifecycle transition' using errcode='23514';
    end if;
  end if;
  if new.actor_role='owner' and not exists (
    select 1 from governed_reviewer_subjects subject
    join project_members member on member.project_id=subject.project_id
      and member.user_id=subject.account_user_id and member.role='owner'
    where subject.id=new.actor_subject_id and subject.project_id=new.project_id
      and subject.account_user_id=new.actor_user_id
  ) then raise exception 'lifecycle owner event requires a current durable owner subject' using errcode='23514';
  end if;
  if (new.transition='calibration_revoked')<>(new.actor_role='system') then
    raise exception 'only calibration revocation is system-authored; lifecycle commands require an owner' using errcode='23514';
  end if;
  if new.transition='activated' and new.activation_bundle_id is null
     or new.transition in ('candidate_created','calibration_revoked')
        and (new.activation_bundle_id is not null or new.replaced_skill_version_id is not null)
     or new.transition='retired' and new.replaced_skill_version_id is not null then
    raise exception 'lifecycle transition bundle shape is invalid' using errcode='23514';
  end if;
  if new.transition='activated' and (new.activation_bundle_id is null
       or new.request_digest is distinct from evaluator_lifecycle_event_request_digest_v1(new)) then
    raise exception 'activation lifecycle request digest mismatch' using errcode='23514';
  elsif new.transition in ('candidate_created','calibration_revoked')
       and new.request_digest is distinct from evaluator_lifecycle_event_request_digest_v1(new) then
    raise exception 'lifecycle event request digest mismatch' using errcode='23514';
  elsif new.transition='retired' and new.activation_bundle_id is null
       and new.request_digest is distinct from evaluator_lifecycle_event_request_digest_v1(new) then
    raise exception 'retirement lifecycle request digest mismatch' using errcode='23514';
  end if;
  if new.transition='activated' then
    select calibration_artifact.artifact_digest,calibration_artifact.evidence_digest,calibration_artifact.status,
           run.skill_version_id,run.criterion_version_id
      into artifact_evidence
    from binary_calibration_artifacts calibration_artifact
    join binary_calibration_runs run on run.id=calibration_artifact.run_id
    where calibration_artifact.id=new.calibration_artifact_id and calibration_artifact.project_id=new.project_id;
    if artifact_evidence.artifact_digest is null or artifact_evidence.artifact_digest<>new.calibration_artifact_digest
       or artifact_evidence.evidence_digest<>new.calibration_evidence_digest
       or artifact_evidence.status<>'complete' or artifact_evidence.skill_version_id<>new.skill_version_id
       or artifact_evidence.criterion_version_id<>lifecycle.criterion_version_id
       or exists (select 1 from binary_calibration_revocation_events revocation
                  where revocation.artifact_id=new.calibration_artifact_id)
       or exists (
         select 1
         from binary_calibration_artifacts current_artifact
         join binary_calibration_runs current_run on current_run.id=current_artifact.run_id
         join binary_calibration_exposure_checks completion
           on completion.id=current_run.completion_check_id and completion.phase='completion'
         join dataset_exposure_events exposure on exposure.revision_id=current_run.dataset_revision_id
         where current_artifact.id=new.calibration_artifact_id
           and exposure.occurred_at>=completion.recorded_at
           and (exposure.exposure_class='development' or exposure.activity in (
             'declassify','analysis_authoring','rubric_authoring','prompt_tuning',
             'example_selection','model_selection','development_run','regression_run'
           ))
       ) then
      raise exception 'activation requires exact complete currently admissible calibration evidence' using errcode='23514';
    end if;
    select run.status,run.skill_version_id,run.dataset_revision_id,run.compared,run.golden_set_missing,
           run.regressed,run.override_reason,run.error_message,run.cases,
           revision.item_count into regression
    from regression_runs run
    join dataset_revisions revision on revision.id=run.dataset_revision_id
    where run.id=new.regression_run_id and run.project_id=new.project_id
    for share of run,revision;
    if regression.status is null or regression.status<>'passed'
       or regression.skill_version_id<>new.skill_version_id
       or regression.dataset_revision_id<>lifecycle.regression_dataset_revision_id
       or regression.dataset_revision_id<>new.regression_dataset_revision_id
       or regression.golden_set_missing is true or regression.item_count<1
       or regression.compared<>regression.item_count or regression.regressed<>0
       or regression.override_reason is not null or regression.error_message is not null
       or jsonb_typeof(regression.cases)<>'array'
       or jsonb_array_length(regression.cases)<>regression.item_count
       or exists (
         select 1
         from dataset_revision_items item
         where item.revision_id=regression.dataset_revision_id
           and not exists (
             select 1 from jsonb_array_elements(regression.cases) outcome
             where outcome->>'caseId'=item.id
               and outcome->>'agreedLabel'=item.reference_label
               and outcome->>'newLabel' in ('pass','fail','ambiguous')
               and outcome->>'change' in ('agree','improve')
           )
       )
       or exists (
         select 1 from jsonb_array_elements(regression.cases) outcome
         group by outcome->>'caseId' having count(*)<>1
       ) then
      raise exception 'activation requires a complete nonempty passed retained regression run' using errcode='23514';
    end if;
  end if;
  if new.content_digest<>evaluator_lifecycle_event_content_digest_v1(new) then
    raise exception 'lifecycle event content digest mismatch' using errcode='23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_evaluator_lifecycle_row_v1(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_evaluator_lifecycle_row_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.request_digest <> evaluator_lifecycle_request_digest_v1(new)
     or new.content_digest <> evaluator_lifecycle_content_digest_v1(new) then
    raise exception 'evaluator lifecycle digest mismatch (request expected %, got %; content expected %, got %)',
      evaluator_lifecycle_request_digest_v1(new),new.request_digest,
      evaluator_lifecycle_content_digest_v1(new),new.content_digest using errcode='23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_evaluator_lineage_state_v1(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_evaluator_lineage_state_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare active_count integer;
begin
  select count(*) into active_count
  from evaluator_lifecycles lifecycle
  cross join lateral evaluator_lifecycle_head_v1(lifecycle.id) head
  where lifecycle.project_id=new.project_id and lifecycle.criterion_id=new.criterion_id
    and head.state='active';
  if active_count>1 then
    raise exception 'at most one evaluator lifecycle may be active per criterion lineage' using errcode='23514';
  end if;
  if new.transition='activated' and new.replaced_skill_version_id is not null and not exists (
    select 1 from evaluator_lifecycles replaced
    cross join lateral evaluator_lifecycle_head_v1(replaced.id) head
    where replaced.project_id=new.project_id and replaced.criterion_id=new.criterion_id
      and replaced.skill_version_id=new.replaced_skill_version_id
      and head.state='retired' and head.activation_bundle_id=new.activation_bundle_id
      and head.request_digest=new.request_digest
      and head.reason='Replaced by activated evaluator ' || new.skill_version_id || '.'
      and head.actor_user_id=new.actor_user_id
      and head.actor_subject_id=new.actor_subject_id
      and head.actor_role=new.actor_role
      and head.idempotency_key='activation-replacement:' || new.activation_bundle_id
  ) then raise exception 'activation replacement must atomically retire the exact prior active evaluator' using errcode='23514';
  end if;
  if new.transition='activated' and new.replaced_skill_version_id is null and exists (
    select 1 from evaluator_lifecycle_events bundled
    where bundled.activation_bundle_id=new.activation_bundle_id and bundled.id<>new.id
  ) then raise exception 'activation without a prior active evaluator cannot claim replacement events' using errcode='23514';
  end if;
  if new.transition='retired' and new.activation_bundle_id is not null and not exists (
    select 1 from evaluator_lifecycle_events activated
    where activated.project_id=new.project_id
      and activated.criterion_id=new.criterion_id
      and activated.activation_bundle_id=new.activation_bundle_id
      and activated.transition='activated'
      and activated.replaced_skill_version_id=new.skill_version_id
      and activated.request_digest=new.request_digest
  ) then raise exception 'replacement retirement must belong to one exact activation bundle' using errcode='23514';
  end if;
  return null;
end;
$$;


--
-- Name: guard_evaluator_suite_manifest(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_evaluator_suite_manifest() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  artifact jsonb;
  canonical_json text;
  unsigned_canonical_json text;
begin
  if not exists (
    select 1 from evaluator_suites suite
    where suite.id = new.suite_id
      and suite.project_id = new.project_id
  ) then
    raise exception 'suite manifest must belong to its suite project'
      using errcode = '23514';
  end if;
  if new.artifact_digest <> 'sha256:' || encode(sha256(new.canonical_bytes), 'hex') then
    raise exception 'suite artifact digest does not match its exact canonical bytes'
      using errcode = '23514';
  end if;
  begin
    artifact := convert_from(new.canonical_bytes, 'UTF8')::jsonb;
  exception when others then
    raise exception 'suite canonical bytes must contain valid UTF-8 JSON'
      using errcode = '23514';
  end;
  if jsonb_typeof(artifact) is distinct from 'object'
     or artifact - array[
       'contract', 'schemaVersion', 'manifestId', 'suiteId', 'projectId',
       'revision', 'members', 'trialPlan', 'manifestDigest'
     ] <> '{}'::jsonb
     or artifact ->> 'contract' is distinct from new.contract
     or (artifact ->> 'schemaVersion')::integer is distinct from new.schema_version
     or artifact ->> 'manifestId' is distinct from new.id
     or artifact ->> 'suiteId' is distinct from new.suite_id
     or artifact ->> 'projectId' is distinct from new.project_id
     or (artifact ->> 'revision')::integer is distinct from new.revision
     or artifact ->> 'manifestDigest' is distinct from new.manifest_digest
     or jsonb_typeof(artifact -> 'members') is distinct from 'array'
     or jsonb_array_length(artifact -> 'members') is distinct from new.member_count
     or artifact -> 'trialPlan' is distinct from new.trial_plan
  then
    raise exception 'suite artifact identity fields must match its exact artifact row'
      using errcode = '23514';
  end if;
  begin
    canonical_json := evaluator_suite_manifest_v1_canonical_json(artifact, true);
    unsigned_canonical_json := evaluator_suite_manifest_v1_canonical_json(artifact, false);
  exception when others then
    raise exception 'suite artifact must conform to the canonical manifest structure'
      using errcode = '23514';
  end;
  if convert_from(new.canonical_bytes, 'UTF8') <> canonical_json then
    raise exception 'suite canonical bytes must be the exact canonical JSON serialization'
      using errcode = '23514';
  end if;
  if new.manifest_digest <> 'sha256:' || encode(
    sha256(convert_to(unsigned_canonical_json, 'UTF8')),
    'hex'
  ) then
    raise exception 'suite manifest digest does not match its unsigned canonical manifest'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_evaluator_suite_member(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_evaluator_suite_member() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  artifact_member jsonb;
begin
  select convert_from(manifest.canonical_bytes, 'UTF8')::jsonb -> 'members' -> new.position
    into artifact_member
  from evaluator_suite_manifests manifest
  where manifest.id = new.manifest_id
    and manifest.suite_id = new.suite_id
    and manifest.project_id = new.project_id
    and new.position < manifest.member_count;
  if artifact_member is null then
    raise exception 'suite member position must exist in its manifest artifact'
      using errcode = '23514';
  end if;
  if not exists (
    select 1
    from criterion_versions criterion_version
    join criteria criterion
      on criterion.id = criterion_version.criterion_id
     and criterion.project_id = new.project_id
    join skills skill
      on skill.id = new.skill_id
     and skill.project_id = new.project_id
     and skill.criterion_id = criterion.id
    join skill_versions skill_version
      on skill_version.id = new.skill_version_id
     and skill_version.project_id = new.project_id
     and skill_version.skill_id = skill.id
     and skill_version.criterion_version_id = criterion_version.id
    where criterion.id = new.criterion_id
      and criterion_version.id = new.criterion_version_id
      and criterion_version.name = new.criterion_name
      and criterion_version.definition = new.criterion_definition
      and criterion_version.criterion_digest = new.criterion_digest
  ) then
    raise exception 'suite member must bind one criterion definition to its exact evaluator lineage'
      using errcode = '23514';
  end if;
  if jsonb_typeof(artifact_member) is distinct from 'object'
     or artifact_member - array[
       'position', 'criterionId', 'criterionVersionId', 'criterionName',
       'criterionDefinition', 'criterionDigest', 'skillId',
       'skillVersionId', 'skillDigest', 'outputContractDigest', 'applicability'
     ] <> '{}'::jsonb
     or (artifact_member ->> 'position')::integer is distinct from new.position
     or artifact_member ->> 'criterionId' is distinct from new.criterion_id
     or artifact_member ->> 'criterionVersionId' is distinct from new.criterion_version_id
     or artifact_member ->> 'criterionName' is distinct from new.criterion_name
     or artifact_member ->> 'criterionDefinition' is distinct from new.criterion_definition
     or artifact_member ->> 'criterionDigest' is distinct from new.criterion_digest
     or artifact_member ->> 'skillId' is distinct from new.skill_id
     or artifact_member ->> 'skillVersionId' is distinct from new.skill_version_id
     or artifact_member ->> 'skillDigest' is distinct from new.skill_digest
     or artifact_member ->> 'outputContractDigest' is distinct from new.output_contract_digest
     or artifact_member -> 'applicability' is distinct from new.applicability
  then
    raise exception 'suite member row must match its exact manifest artifact position'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_evaluator_suite_member_lifecycle_v1(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_evaluator_suite_member_lifecycle_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if not evaluator_skill_version_context_allowed_v1(new.project_id,new.skill_version_id,'suite_publication') then
    raise exception 'suite publication requires an active currently admissible evaluator' using errcode='23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_evaluator_suite_members_complete(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_evaluator_suite_members_complete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  target_manifest_id text;
  expected_count integer;
  observed_count integer;
begin
  target_manifest_id := case
    when tg_table_name = 'evaluator_suite_manifests' then to_jsonb(new) ->> 'id'
    else to_jsonb(new) ->> 'manifest_id'
  end;
  select manifest.member_count into expected_count
  from evaluator_suite_manifests manifest
  where manifest.id = target_manifest_id;
  if expected_count is null then return null; end if;
  select count(*) into observed_count
  from evaluator_suite_manifest_members member
  where member.manifest_id = target_manifest_id;
  if observed_count <> expected_count then
    raise exception 'suite manifest requires exactly % ordered members, found %', expected_count, observed_count
      using errcode = '23514';
  end if;
  return null;
end;
$$;


--
-- Name: guard_golden_revision_item_criterion(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_golden_revision_item_criterion() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.source_golden_entry_id is not null and not exists (
    select 1
    from dataset_revisions revision
    join golden_set_entries golden
      on golden.id = new.source_golden_entry_id
     and golden.project_id = new.project_id
     and golden.criterion_version_id = revision.criterion_version_id
    where revision.id = new.revision_id
      and revision.project_id = new.project_id
      and revision.role = 'regression_golden'
  ) then
    raise exception 'golden revision item must match its revision criterion version'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_governed_adjudication(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_adjudication() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  batch governed_review_batches%rowtype;
  batch_item governed_review_batch_items%rowtype;
  current_head governed_review_adjudications%rowtype;
  current_version integer;
  expected_digest text;
begin
  select * into batch from governed_review_batches where id = new.batch_id for update;
  select * into batch_item from governed_review_batch_items where id = new.batch_item_id for update;
  if batch.id is null or batch_item.id is null
     or batch.project_id <> new.project_id
     or batch_item.project_id <> new.project_id
     or batch_item.batch_id <> batch.id
     or not exists (
       select 1 from governed_reviewer_subjects subject
       where subject.id = new.adjudicator_subject_id and subject.project_id = new.project_id
     ) then
    raise exception 'adjudication must bind its batch item, project, and actor snapshot'
      using errcode = '23514';
  end if;
  if governed_review_current_batch_state(batch.id) not in ('adjudicating','resolved') then
    raise exception 'adjudication requires the explicit adjudicating state' using errcode = '55000';
  end if;
  if governed_review_current_batch_state(batch.id) = 'resolved'
     and exists (
       select 1 from governed_review_batch_events event
       where event.batch_id = batch.id and event.event_kind = 'frozen'
     ) then
    raise exception 'frozen truth can only be corrected by an eligible dataset-revision successor'
      using errcode = '55000';
  end if;
  if governed_review_current_batch_state(batch.id) = 'resolved'
     and exists (
       select 1 from governed_dataset_truth_links truth
       where truth.batch_item_id = batch_item.id
     ) then
    raise exception 'materialized truth linkage is immutable; correct adjudication before materialization'
      using errcode = '55000';
  end if;
  if exists (
    select 1 from governed_review_tasks task
    where task.batch_item_id = batch_item.id
      and task.reviewer_subject_id = new.adjudicator_subject_id
  ) then
    raise exception 'adjudicator cannot be a rater for the item' using errcode = '23514';
  end if;
  if batch.role_intent = 'sealed_validation'
     and not governed_review_has_eligible_capability_check(
       batch.id, 'adjudication', new.adjudicator_subject_id, null
     ) then
    raise exception 'sealed adjudicator capability separation is missing or ineligible'
      using errcode = '23514';
  end if;

  select candidate.* into current_head
  from governed_review_adjudications candidate
  where candidate.batch_item_id = batch_item.id
    and not exists (
      select 1 from governed_review_adjudications successor
      where successor.supersedes_adjudication_id = candidate.id
    )
  order by candidate.chain_version desc limit 1 for update;
  current_version := coalesce(current_head.chain_version, 0);
  if new.expected_previous_chain_version <> current_version
     or new.chain_version <> current_version + 1
     or new.supersedes_adjudication_id is distinct from current_head.id then
    raise exception 'adjudication compare-and-swap conflict' using errcode = '40001';
  end if;
  if (new.chain_version = 1 and new.correction_reason is not null)
     or (new.chain_version > 1 and new.correction_reason is null) then
    raise exception 'only adjudication successors require a correction reason'
      using errcode = '23514';
  end if;
  if new.considered_label_count <> (
    select count(*) from governed_active_review_labels active
    where active.batch_item_id = batch_item.id
  ) or new.considered_label_set_digest <> governed_review_item_label_set_digest(batch_item.id) then
    raise exception 'adjudication must bind the complete active label set at the barrier'
      using errcode = '23514';
  end if;
  if not exists (
    select 1
    from governed_active_review_labels active
    where active.batch_item_id = batch_item.id and active.label = 'cannot_determine'
  ) and not (
    exists (select 1 from governed_active_review_labels active
            where active.batch_item_id = batch_item.id and active.label = 'pass')
    and exists (select 1 from governed_active_review_labels active
                where active.batch_item_id = batch_item.id and active.label = 'fail')
  ) then
    raise exception 'adjudication may resolve only a real disagreement or cannot_determine'
      using errcode = '23514';
  end if;
  expected_digest := governed_content_v1_digest('governed-review-adjudication/v1', jsonb_build_object(
    'adjudicatorRoleAtReview', new.adjudicator_role_at_review,
    'adjudicatorSubjectId', new.adjudicator_subject_id,
    'basis', new.basis,
    'batchId', new.batch_id,
    'batchItemId', new.batch_item_id,
    'chainVersion', new.chain_version,
    'consideredLabelCount', new.considered_label_count,
    'consideredLabelSetDigest', new.considered_label_set_digest,
    'correctionReason', new.correction_reason,
    'decision', new.decision,
    'rationale', new.rationale,
    'supersedesAdjudicationId', new.supersedes_adjudication_id
  ));
  if new.content_digest <> expected_digest then
    raise exception 'adjudication content digest mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_governed_adjudication_label(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_adjudication_label() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if not exists (
    select 1
    from governed_review_adjudications adjudication
    join governed_review_labels label on label.id = new.label_id
    join governed_review_tasks task on task.id = label.task_id
    where adjudication.id = new.adjudication_id
      and adjudication.project_id = new.project_id
      and label.project_id = new.project_id
      and task.batch_item_id = adjudication.batch_item_id
  ) then
    raise exception 'adjudication label must belong to the same item and project'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_governed_adjudication_label_set_complete(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_adjudication_label_set_complete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if (select count(*) from governed_review_adjudication_labels link
      where link.adjudication_id = new.id) <> new.considered_label_count
     or exists (
       select active.label_id from governed_active_review_labels active
       where active.batch_item_id = new.batch_item_id
       except
       select link.label_id from governed_review_adjudication_labels link
       where link.adjudication_id = new.id
     ) or exists (
       select link.label_id from governed_review_adjudication_labels link
       where link.adjudication_id = new.id
       except
       select active.label_id from governed_active_review_labels active
       where active.batch_item_id = new.batch_item_id
     ) then
    raise exception 'adjudication must commit its complete exact active label set'
      using errcode = '23514';
  end if;
  return null;
end;
$$;


--
-- Name: guard_governed_alignment_event(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_alignment_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  batch governed_review_batches%rowtype;
  current_sequence integer;
  current_digest text;
  expected_digest text;
begin
  select * into batch from governed_review_batches where id = new.batch_id for update;
  if batch.id is null or batch.project_id <> new.project_id
     or not exists (
       select 1 from governed_reviewer_subjects subject
       where subject.id = new.actor_subject_id and subject.project_id = new.project_id
     ) then
    raise exception 'alignment event must bind its batch project and actor snapshot'
      using errcode = '23514';
  end if;
  if governed_review_current_batch_state(batch.id) <> 'alignment_open' then
    raise exception 'alignment events require the explicit post-labeling alignment barrier'
      using errcode = '55000';
  end if;
  select coalesce(max(event.sequence), 0) into current_sequence
  from governed_review_alignment_events event where event.batch_id = batch.id;
  select event.event_digest into current_digest
  from governed_review_alignment_events event
  where event.batch_id = batch.id order by event.sequence desc limit 1;
  if new.expected_previous_sequence <> current_sequence
     or new.sequence <> current_sequence + 1
     or new.previous_event_digest is distinct from current_digest then
    raise exception 'alignment event sequence conflict' using errcode = '40001';
  end if;
  if exists (
    select 1 from governed_review_alignment_events event
    where event.batch_id = batch.id and event.event_kind = 'closed'
  ) then
    raise exception 'alignment history is closed' using errcode = '55000';
  end if;
  new.occurred_at := clock_timestamp();
  if new.visible_label_count <> (
    select count(*) from governed_active_review_labels active where active.batch_id = batch.id
  ) or new.visible_label_set_digest <> governed_review_label_set_digest(batch.id) then
    raise exception 'alignment event must bind the exact visible active label set'
      using errcode = '23514';
  end if;
  if new.proposed_instruction_version_id is not null and not exists (
    select 1 from review_instruction_versions instruction
    where instruction.id = new.proposed_instruction_version_id
      and instruction.project_id = new.project_id
      and instruction.criterion_version_id = batch.criterion_version_id
      and instruction.revision > (
        select base.revision from review_instruction_versions base
        where base.id = batch.instruction_version_id
      )
  ) then
    raise exception 'alignment instruction proposal must name a later immutable version of the same criterion'
      using errcode = '23514';
  end if;
  expected_digest := governed_content_v1_digest('governed-review-alignment-event/v1', jsonb_build_object(
    'actorRoleAtReview', new.actor_role_at_review,
    'actorSubjectId', new.actor_subject_id,
    'batchId', new.batch_id,
    'content', new.content,
    'eventKind', new.event_kind,
    'previousEventDigest', new.previous_event_digest,
    'proposedInstructionVersionId', new.proposed_instruction_version_id,
    'sequence', new.sequence,
    'visibleLabelCount', new.visible_label_count,
    'visibleLabelSetDigest', new.visible_label_set_digest
  ));
  if new.event_digest <> expected_digest then
    raise exception 'alignment event digest mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_governed_alignment_event_label(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_alignment_event_label() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if not exists (
    select 1
    from governed_review_alignment_events alignment
    join governed_review_labels label on label.id = new.label_id
    join governed_review_tasks task on task.id = label.task_id
    where alignment.id = new.alignment_event_id
      and alignment.project_id = new.project_id
      and label.project_id = new.project_id
      and task.batch_id = alignment.batch_id
  ) then
    raise exception 'alignment label must belong to the same batch and project'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_governed_alignment_label_set_complete(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_alignment_label_set_complete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if (select count(*) from governed_review_alignment_event_labels link
      where link.alignment_event_id = new.id) <> new.visible_label_count
     or exists (
       select active.label_id
       from governed_active_review_labels active
       where active.batch_id = new.batch_id
       except
       select link.label_id from governed_review_alignment_event_labels link
       where link.alignment_event_id = new.id
     ) or exists (
       select link.label_id from governed_review_alignment_event_labels link
       where link.alignment_event_id = new.id
       except
       select active.label_id
       from governed_active_review_labels active
       where active.batch_id = new.batch_id
     ) then
    raise exception 'alignment event must commit its complete exact visible label set'
      using errcode = '23514';
  end if;
  return null;
end;
$$;


--
-- Name: guard_governed_capability_check(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_capability_check() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  batch governed_review_batches%rowtype;
  current_sequence integer;
  expected_digest text;
begin
  select * into batch from governed_review_batches where id = new.batch_id for update;
  if batch.id is null or batch.project_id <> new.project_id
     or batch.criterion_version_id <> new.criterion_version_id
     or not exists (
       select 1 from governed_reviewer_subjects subject
       where subject.id = new.subject_id and subject.project_id = new.project_id
     ) then
    raise exception 'capability check must bind one batch criterion and project subject'
      using errcode = '23514';
  end if;
  if new.evaluator_version_id is not null and not exists (
    select 1
    from skill_versions version
    join criterion_versions version_criterion on version_criterion.id = version.criterion_version_id
    join criterion_versions target_criterion on target_criterion.id = new.criterion_version_id
    where version.id = new.evaluator_version_id
      and version.project_id = new.project_id
      and version_criterion.project_id = target_criterion.project_id
      and version_criterion.criterion_id = target_criterion.criterion_id
  ) then
    raise exception 'capability check evaluator must bind the same project criterion'
      using errcode = '23514';
  end if;
  select coalesce(max(check_row.sequence), 0) into current_sequence
  from governed_review_capability_checks check_row
  where check_row.batch_id = new.batch_id
    and check_row.check_scope = new.check_scope
    and check_row.subject_id = new.subject_id
    and check_row.evaluator_version_id is not distinct from new.evaluator_version_id;
  if new.expected_previous_sequence <> current_sequence
     or new.sequence <> current_sequence + 1 then
    raise exception 'capability check sequence conflict' using errcode = '40001';
  end if;
  if new.evidence_digest <> governed_content_v1_digest(
    'sealed-separation-evidence/v1', new.evidence
  ) then
    raise exception 'capability evidence digest mismatch' using errcode = '23514';
  end if;
  -- No allegedly eligible snapshot may contradict system-recorded authorship.
  if new.result = 'eligible' and exists (
    select 1
    from governed_evaluator_development_events development
    join criterion_versions development_criterion
      on development_criterion.id = development.criterion_version_id
    join criterion_versions target_criterion on target_criterion.id = new.criterion_version_id
    where development.project_id = new.project_id
      and development_criterion.project_id = target_criterion.project_id
      and development_criterion.criterion_id = target_criterion.criterion_id
      and development.developer_subject_id = new.subject_id
  ) then
    raise exception 'recorded evaluator developer cannot pass sealed capability separation'
      using errcode = '23514';
  end if;
  if new.result = 'eligible' and exists (
    select 1
    from governed_reviewer_subjects subject
    join criterion_versions target_criterion on target_criterion.id = new.criterion_version_id
    join governed_review_batches checked_batch on checked_batch.id = new.batch_id
    where subject.id = new.subject_id
      and (
        exists (
          select 1
          from criterion_versions lineage_criterion
          join review_instruction_versions instruction
            on instruction.project_id = lineage_criterion.project_id
           and instruction.criterion_version_id = lineage_criterion.id
          where lineage_criterion.project_id = target_criterion.project_id
            and lineage_criterion.criterion_id = target_criterion.criterion_id
            and instruction.created_by_subject_id = subject.id
        )
        or exists (
          select 1 from criterion_versions lineage_criterion
          where lineage_criterion.project_id = target_criterion.project_id
            and lineage_criterion.criterion_id = target_criterion.criterion_id
            and subject.account_user_id is not null
            and lineage_criterion.created_by_user_id = subject.account_user_id
        )
        or (
          subject.account_user_id is not null
          and exists (
          select 1 from dataset_exposure_events exposure
          where exposure.project_id = new.project_id
            and exposure.exposure_class = 'development'
            and exposure.subject_id in (subject.id, subject.account_user_id)
          )
        )
      )
  ) then
    raise exception 'recorded criterion/instruction/development author cannot pass sealed capability separation'
      using errcode = '23514';
  end if;
  -- Unknown historical evaluator-development authorship fails closed.
  if new.result = 'eligible' and exists (
    select 1
    from skill_versions version
    join criterion_versions version_criterion on version_criterion.id = version.criterion_version_id
    join criterion_versions target_criterion on target_criterion.id = new.criterion_version_id
    where version.project_id = new.project_id
      and version_criterion.project_id = target_criterion.project_id
      and version_criterion.criterion_id = target_criterion.criterion_id
      and (
        version.developer_identity_status <> 'recorded'
        or not exists (
          select 1 from governed_evaluator_development_events development
          where development.skill_version_id = version.id
            and development.project_id = version.project_id
            and development.criterion_version_id = version.criterion_version_id
        )
      )
  ) then
    raise exception 'unknown historical evaluator developer identity blocks sealed eligibility'
      using errcode = '23514';
  end if;
  expected_digest := governed_content_v1_digest('governed-review-capability-check/v1', jsonb_build_object(
    'batchId', new.batch_id,
    'capabilityQueryVersion', new.capability_query_version,
    'checkScope', new.check_scope,
    'coveredCapabilities', to_jsonb(new.covered_capabilities),
    'evidenceDigest', new.evidence_digest,
    'evaluatorVersionId', new.evaluator_version_id,
    'excludedCapabilities', to_jsonb(new.excluded_capabilities),
    'result', new.result,
    'sequence', new.sequence,
    'subjectId', new.subject_id,
    'unknownCapabilities', to_jsonb(new.unknown_capabilities),
    'verificationMethod', new.verification_method
  ));
  if new.content_digest <> expected_digest then
    raise exception 'capability check content digest mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_governed_capability_development_subject_v1(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_capability_development_subject_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.result = 'eligible' and exists (
    select 1
    from governed_reviewer_subjects subject
    join dataset_exposure_events exposure
      on exposure.project_id = subject.project_id
     and exposure.exposure_class = 'development'
     and exposure.subject_id = subject.id
    where subject.id = new.subject_id
      and subject.project_id = new.project_id
  ) then
    raise exception 'durable development-exposure subject cannot pass sealed capability separation'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_governed_dataset_truth_link(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_dataset_truth_link() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  revision dataset_revisions%rowtype;
  revision_item dataset_revision_items%rowtype;
  batch_item governed_review_batch_items%rowtype;
  batch governed_review_batches%rowtype;
  review_item governed_review_items%rowtype;
  resolution record;
  adjudication governed_review_adjudications%rowtype;
  imported governed_imported_truth%rowtype;
  expected_digest text;
begin
  select * into revision from dataset_revisions where id = new.dataset_revision_id for key share;
  select * into revision_item from dataset_revision_items where id = new.dataset_revision_item_id for key share;
  if revision.id is null or revision_item.id is null
     or revision.project_id <> new.project_id
     or revision_item.project_id <> new.project_id
     or revision_item.revision_id <> revision.id
     or revision.criterion_version_id <> new.criterion_version_id
     or revision_item.reference_label is distinct from new.resolved_label then
    raise exception 'governed truth link must bind its exact revision item, criterion, project, and label'
      using errcode = '23514';
  end if;
  if revision_item.reference_provenance ->> 'kind' <> 'dataset_claim'
     or revision_item.reference_provenance ->> 'sourceId' <> new.id then
    raise exception 'dataset revision compatibility provenance must point to its authoritative governed truth link'
      using errcode = '23514';
  end if;

  if new.source_kind in ('governed_labels','adjudication') then
    select * into batch_item from governed_review_batch_items where id = new.batch_item_id for key share;
    select parent.* into batch
    from governed_review_batches parent where parent.id = batch_item.batch_id for key share;
    select source.* into review_item
    from governed_review_items source where source.id = batch_item.review_item_id for key share;
    if batch_item.id is null or batch.id is null or review_item.id is null
       or batch.project_id <> new.project_id
       or batch.criterion_version_id <> new.criterion_version_id
       or revision.role <> batch.role_intent
       or revision.provenance_level <> 'governed_blind'
       or revision_item.input_digest <> review_item.input_digest
       or governed_review_current_batch_state(batch.id) <> 'resolved' then
      raise exception 'native governed truth must bind a resolved matching batch item and governed_blind revision'
        using errcode = '23514';
    end if;
    if batch.role_intent = 'sealed_validation' then
      if review_item.source_kind <> 'sealed_intake'
         or revision.source_kind <> 'sealed_intake'
         or revision_item.payload_snapshot <> review_item.review_payload_snapshot then
        raise exception 'sealed truth must materialize the exact protected review projection'
          using errcode = '23514';
      end if;
      if review_item.sealed_predecessor_revision_id is null then
        if revision.parent_revision_id is not null then
          raise exception 'initial sealed intake cannot materialize as an unrelated successor'
            using errcode = '23514';
        end if;
      elsif revision.parent_revision_id <> review_item.sealed_predecessor_revision_id then
        raise exception 'sealed successor truth must directly succeed its protected predecessor'
          using errcode = '23514';
      end if;
    end if;

    select * into resolution from governed_review_item_resolution(batch_item.id);
    if new.resolution_kind <> resolution.resolution_kind
       or new.resolved_label <> resolution.resolved_label then
      raise exception 'truth link resolution does not match immutable active evidence'
        using errcode = '23514';
    end if;
    if new.source_kind = 'governed_labels' then
      if new.supporting_label_count <> cardinality(new.governed_label_ids)
         or new.supporting_label_count <> batch.required_labels_per_item
         or new.adjudication_id is not null then
        raise exception 'direct governed truth must name every active independent label'
          using errcode = '23514';
      end if;
    else
      select * into adjudication from governed_review_adjudications
      where id = new.adjudication_id for key share;
      if adjudication.id is null or adjudication.id <> resolution.adjudication_id
         or adjudication.batch_item_id <> batch_item.id
         or adjudication.decision <> new.resolved_label
         or new.supporting_label_count <> adjudication.considered_label_count then
        raise exception 'adjudicated truth must name the authoritative adjudication head'
          using errcode = '23514';
      end if;
    end if;
  else
    select * into imported from governed_imported_truth where id = new.imported_truth_id for key share;
    if imported.id is null or imported.project_id <> new.project_id
       or imported.criterion_version_id <> new.criterion_version_id
       or imported.input_digest <> revision_item.input_digest
       or imported.payload_snapshot <> revision_item.payload_snapshot
       or imported.label <> new.resolved_label then
      raise exception 'imported truth link must bind its exact immutable import and revision snapshot'
        using errcode = '23514';
    end if;
    if new.resolution_kind <> (case imported.evidence_class
         when 'imported_self_attested' then 'imported_self_attested'
         when 'imported_verified_attested' then 'imported_verified_attested'
         else 'imported_unverified'
       end)
       or revision.provenance_level <> (case imported.evidence_class
         when 'imported_self_attested' then 'imported_self_attested'
         when 'imported_verified_attested' then 'imported_verified_attested'
         else 'unverified'
       end) then
      raise exception 'imported truth evidence class must remain honest in revision provenance'
        using errcode = '23514';
    end if;
  end if;

  expected_digest := governed_content_v1_digest('governed-dataset-truth-link/v1', jsonb_build_object(
    'adjudicationId', new.adjudication_id,
    'batchItemId', new.batch_item_id,
    'criterionVersionId', new.criterion_version_id,
    'datasetRevisionId', new.dataset_revision_id,
    'datasetRevisionItemId', new.dataset_revision_item_id,
    'governedLabelIds', to_jsonb(new.governed_label_ids),
    'importedTruthId', new.imported_truth_id,
    'resolutionKind', new.resolution_kind,
    'resolvedLabel', new.resolved_label,
    'sourceKind', new.source_kind,
    'supportingLabelCount', new.supporting_label_count
  ));
  if new.content_digest <> expected_digest then
    raise exception 'governed dataset truth link digest mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_governed_development_event(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_development_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if not exists (
    select 1 from skill_versions version
    join governed_reviewer_subjects subject on subject.id = new.developer_subject_id
    where version.id = new.skill_version_id
      and version.project_id = new.project_id
      and version.criterion_version_id = new.criterion_version_id
      and version.created_by_subject_id = new.developer_subject_id
      and version.developer_identity_status = 'recorded'
      and subject.project_id = new.project_id
  ) then
    raise exception 'evaluator development event must match recorded skill-version authorship'
      using errcode = '23514';
  end if;
  if new.content_digest <> governed_content_v1_digest(
    'governed-evaluator-development/v1', jsonb_build_object(
      'activityKind', new.activity_kind,
      'criterionVersionId', new.criterion_version_id,
      'developerRoleAtRecording', new.developer_role_at_recording,
      'developerSubjectId', new.developer_subject_id,
      'skillVersionId', new.skill_version_id,
      'sourceKind', new.source_kind
    )
  ) then
    raise exception 'evaluator development event digest mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_governed_evidence_append_only(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_evidence_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'UPDATE' then
    raise exception '% rows are append-only', tg_table_name using errcode = '55000';
  end if;
  if tg_op = 'DELETE' and exists (
    select 1 from projects project where project.id = old.project_id
  ) then
    raise exception '% rows are append-only while their project exists', tg_table_name
      using errcode = '55000';
  end if;
  return old;
end;
$$;


--
-- Name: guard_governed_imported_truth(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_imported_truth() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  expected_provenance_digest text;
  expected_content_digest text;
begin
  if not exists (
    select 1 from criterion_versions version
    where version.id = new.criterion_version_id and version.project_id = new.project_id
  ) then
    raise exception 'imported truth criterion must belong to its project' using errcode = '23514';
  end if;
  if new.source_artifact_digest <> governed_bytes_v1_digest(new.source_artifact_bytes) then
    raise exception 'imported source artifact digest mismatch' using errcode = '23514';
  end if;
  expected_provenance_digest := governed_content_v1_digest('governed-imported-truth-provenance/v1',
    jsonb_build_object(
      'adjudication', new.adjudication_provenance,
      'blindAttestation', new.blind_attestation,
      'instructions', new.instructions_provenance,
      'issuer', new.issuer,
      'raters', new.rater_provenance,
      'sourceArtifactDigest', new.source_artifact_digest,
      'subject', new.subject,
      'transport', new.transport_provenance,
      'verificationEvidence', new.verification_evidence,
      'verificationMethod', new.verification_method
    ));
  if new.provenance_digest <> expected_provenance_digest then
    raise exception 'imported truth provenance digest mismatch' using errcode = '23514';
  end if;
  expected_content_digest := governed_content_v1_digest('governed-imported-truth/v1', jsonb_build_object(
    'criterionVersionId', new.criterion_version_id,
    'evidenceClass', new.evidence_class,
    'failureCodes', to_jsonb(new.failure_codes),
    'identityBasis', new.identity_basis,
    'inputDigest', new.input_digest,
    'label', new.label,
    'payloadSnapshot', new.payload_snapshot,
    'provenanceDigest', new.provenance_digest,
    'rationale', new.rationale
  ));
  if new.content_digest <> expected_content_digest then
    raise exception 'imported truth content digest mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_governed_input_identity_claim(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_input_identity_claim() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'UPDATE' then
    if new is not distinct from old then
      return new;
    end if;
    raise exception 'governed input identity claims are immutable'
      using errcode = '55000';
  end if;
  if tg_op = 'DELETE' and exists (
    select 1 from projects project where project.id = old.project_id
  ) then
    raise exception 'governed input identity claims survive while their project exists'
      using errcode = '55000';
  end if;
  return old;
end;
$$;


--
-- Name: guard_governed_label_submission_complete(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_label_submission_complete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if not exists (
    select 1 from governed_review_task_events event
    where event.task_id = new.task_id
      and event.event_kind = 'label_submitted'
      and event.label_id = new.id
  ) then
    raise exception 'governed label and label_submitted event must commit atomically'
      using errcode = '23514';
  end if;
  return null;
end;
$$;


--
-- Name: guard_governed_review_batch(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_review_batch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  instruction review_instruction_versions%rowtype;
  sealed_population governed_sealed_intake_populations%rowtype;
  expected_digest text;
begin
  select * into instruction from review_instruction_versions
  where id = new.instruction_version_id for key share;
  if instruction.id is null or instruction.project_id <> new.project_id
     or instruction.criterion_version_id <> new.criterion_version_id then
    raise exception 'review batch instruction must bind the exact project criterion'
      using errcode = '23514';
  end if;
  if new.custodian_subject_id is not null and not exists (
    select 1 from governed_reviewer_subjects subject
    where subject.id = new.custodian_subject_id and subject.project_id = new.project_id
  ) then
    raise exception 'review batch custodian must belong to its project' using errcode = '23514';
  end if;
  if new.created_by_subject_id is not null and not exists (
    select 1 from governed_reviewer_subjects subject
    where subject.id = new.created_by_subject_id and subject.project_id = new.project_id
  ) then
    raise exception 'review batch creator must belong to its project' using errcode = '23514';
  end if;
  if new.source_population_kind = 'dataset_revision' and not exists (
    select 1 from dataset_revisions revision
    where revision.id = new.source_population_id
      and revision.project_id = new.project_id
      and revision.role = new.role_intent
      and revision.role <> 'sealed_validation'
      and revision.content_digest = new.population_digest
      and revision.item_count = new.population_size
  ) then
    raise exception 'nonsealed batch population must be an exact immutable revision of the intended role'
      using errcode = '23514';
  end if;
  if new.source_population_kind = 'sealed_intake' then
    select * into sealed_population
    from governed_sealed_intake_populations population
    where population.id = new.source_population_id for key share;
    if sealed_population.id is null
       or sealed_population.project_id <> new.project_id
       or sealed_population.custodian_subject_id <> new.custodian_subject_id
       or sealed_population.custodian_role_at_review <> new.custodian_role_at_review
       or sealed_population.population_definition <> new.population_definition
       or sealed_population.collection_provenance <> new.population_collection_provenance
       or sealed_population.window_start is distinct from new.window_start
       or sealed_population.window_end is distinct from new.window_end
       or sealed_population.frame_count <> new.population_size
       or sealed_population.frame_digest <> new.population_digest
       or new.population_id <> sealed_population.id then
      raise exception 'sealed batch must bind the exact immutable intake population and custodian'
        using errcode = '23514';
    end if;
  end if;
  expected_digest := governed_content_v1_digest('governed-review-batch/v1', jsonb_build_object(
    'criterionVersionId', new.criterion_version_id,
    'custodianRoleAtReview', new.custodian_role_at_review,
    'custodianSubjectId', new.custodian_subject_id,
    'drawDigest', new.draw_digest,
    'drawExecutedBy', new.draw_executed_by,
    'evaluatorBlind', new.evaluator_blind,
    'fixedBudget', new.fixed_budget,
    'instructionVersionId', new.instruction_version_id,
    'peerBlindUntilLabelingClosed', new.peer_blind_until_labeling_closed,
    'populationCollectionProvenance', new.population_collection_provenance,
    'populationDefinition', new.population_definition,
    'populationDigest', new.population_digest,
    'populationId', new.population_id,
    'populationSize', new.population_size,
    'requiredLabelsPerItem', new.required_labels_per_item,
    'rngVersion', new.rng_version,
    'roleIntent', new.role_intent,
    'selectionAlgorithmVersion', new.selection_algorithm_version,
    'selectionMethod', new.selection_method,
    'selectionSeed', new.selection_seed,
    'separationOfDutiesRequired', new.separation_of_duties_required,
    'sourcePopulationId', new.source_population_id,
    'sourcePopulationKind', new.source_population_kind,
    'stateMachineVersion', new.state_machine_version,
    'stopAt', new.stop_at,
    'stoppingRule', new.stopping_rule,
    'strata', new.strata,
    'windowEnd', new.window_end,
    'windowStart', new.window_start
  ));
  if new.content_digest <> expected_digest then
    raise exception 'governed review batch content digest mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_governed_review_batch_event(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_review_batch_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  batch governed_review_batches%rowtype;
  current_version integer;
  current_state text;
  current_event_digest text;
  current_event_occurred_at timestamptz;
  task_row record;
  task_version integer;
  expected_task_digest text;
  target_revision dataset_revisions%rowtype;
  expected_digest text;
begin
  select * into batch from governed_review_batches where id = new.batch_id for update;
  if batch.id is null or batch.project_id <> new.project_id then
    raise exception 'batch event must belong to its batch project' using errcode = '23514';
  end if;
  if new.actor_subject_id is not null and not exists (
    select 1 from governed_reviewer_subjects subject
    where subject.id = new.actor_subject_id and subject.project_id = new.project_id
  ) then
    raise exception 'batch event actor must belong to its project' using errcode = '23514';
  end if;
  if (new.actor_subject_id is null) <> (new.actor_role_at_review is null) then
    raise exception 'batch event actor subject and role snapshot must be supplied together'
      using errcode = '23514';
  end if;
  select coalesce(max(event.state_version), 0) into current_version
  from governed_review_batch_events event where event.batch_id = batch.id;
  select event.event_digest, event.occurred_at
  into current_event_digest, current_event_occurred_at
  from governed_review_batch_events event
  where event.batch_id = batch.id order by event.sequence desc limit 1;
  if new.occurred_at > clock_timestamp()
     or (current_event_occurred_at is not null and new.occurred_at < current_event_occurred_at)
     or (current_event_occurred_at is null and new.occurred_at < batch.created_at) then
    raise exception 'governed batch event time must be server-current and monotonic'
      using errcode = '23514';
  end if;
  current_state := governed_review_current_batch_state(batch.id);
  if new.expected_previous_state_version <> current_version
     or new.state_version <> current_version + 1
     or new.sequence <> current_version + 1
     or new.previous_event_digest is distinct from current_event_digest then
    raise exception 'governed batch state version conflict' using errcode = '40001';
  end if;

  if not (
    (current_state = 'draft' and new.event_kind in ('open','abandoned'))
    or (current_state = 'open' and new.event_kind in ('labeling_closed','abandoned'))
    or (current_state = 'labeling_closed' and new.event_kind in (
      'alignment_open','adjudicating','resolved','incomplete'
    ))
    or (current_state = 'alignment_open' and new.event_kind in ('adjudicating','incomplete'))
    or (current_state = 'adjudicating' and new.event_kind in ('resolved','incomplete'))
    or (current_state = 'resolved' and new.event_kind = 'frozen')
  ) then
    raise exception 'invalid governed batch transition % -> %', current_state, new.event_kind
      using errcode = '40001';
  end if;

  if new.event_kind = 'open' then
    if (select count(*) from governed_review_batch_items item where item.batch_id = batch.id)
       <> batch.fixed_budget then
      raise exception 'batch cannot open until exact fixed-budget membership is frozen'
        using errcode = '23514';
    end if;
    if exists (
      select 1 from governed_review_batch_items item
      where item.batch_id = batch.id
        and (select count(*) from governed_review_tasks task where task.batch_item_id = item.id)
            <> batch.required_labels_per_item
    ) then
      raise exception 'batch cannot open until every item has its exact independent assignments'
        using errcode = '23514';
    end if;
    if batch.draw_digest <> governed_review_draw_digest(batch.id) then
      raise exception 'server draw digest does not match frozen membership' using errcode = '23514';
    end if;
    if batch.role_intent = 'sealed_validation' then
      if not governed_review_has_eligible_capability_check(
        batch.id, 'batch_open', batch.custodian_subject_id, null
      ) then
        raise exception 'sealed custodian capability separation is missing or ineligible'
          using errcode = '23514';
      end if;
      if exists (
        select 1 from governed_review_tasks task
        where task.batch_id = batch.id
          and not governed_review_has_eligible_capability_check(
            batch.id, 'batch_open', task.reviewer_subject_id, null
          )
      ) then
        raise exception 'sealed reviewer capability separation is missing or ineligible'
          using errcode = '23514';
      end if;
    end if;
  elsif new.event_kind = 'labeling_closed' then
    if new.occurred_at >= batch.stop_at then
      for task_row in
        select task.id, task.project_id
        from governed_review_tasks task
        where task.batch_id = batch.id
          and governed_review_current_task_state(task.id) in ('assigned','viewed','withdrawn')
        order by task.id
        for update
      loop
        select coalesce(max(event.state_version), 0) into task_version
        from governed_review_task_events event where event.task_id = task_row.id;
        expected_task_digest := governed_content_v1_digest(
          'governed-review-task-event/v1',
          jsonb_build_object(
            'activity', null,
            'actorRoleAtReview', null,
            'actorSubjectId', null,
            'canonicalizationVersion', null,
            'eventKind', 'expired',
            'exposureClass', null,
            'labelId', null,
            'canonicalViewBytesBase64', null,
            'previousEventDigest', (select event.event_digest
              from governed_review_task_events event
              where event.task_id = task_row.id order by event.sequence desc limit 1),
            'reason', 'fixed_stop',
            'sequence', task_version + 1,
            'stateVersion', task_version + 1,
            'taskId', task_row.id,
            'viewContractVersion', null,
            'viewDigest', null
          )
        );
        insert into governed_review_task_events
          (id, project_id, task_id, sequence, state_version, expected_previous_state_version,
           event_kind, reason, previous_event_digest, event_digest, idempotency_key, request_digest,
           occurred_at)
        values
          ('grte_expired_' || new.id || '_' || task_row.id, task_row.project_id,
           task_row.id, task_version + 1, task_version + 1, task_version, 'expired', 'fixed_stop',
           (select event.event_digest from governed_review_task_events event
            where event.task_id = task_row.id order by event.sequence desc limit 1),
           expected_task_digest, 'expire:' || new.id,
           governed_content_v1_digest('governed-review-expiry-request/v1',
             jsonb_build_object('batchEventId', new.id, 'taskId', task_row.id)),
           new.occurred_at);
      end loop;
    elsif exists (
      select 1 from governed_review_tasks task
      where task.batch_id = batch.id
        and governed_review_current_task_state(task.id) not in ('submitted','deferred')
    ) then
      raise exception 'before the fixed stop every task must be submitted or deferred before closure'
        using errcode = '23514';
    end if;
    if exists (
      select 1 from governed_review_tasks task
      where task.batch_id = batch.id
        and governed_review_current_task_state(task.id) not in ('submitted','deferred','expired')
    ) then
      raise exception 'labeling closure left a nonterminal task' using errcode = '23514';
    end if;
  elsif new.event_kind = 'alignment_open' then
    if exists (
      select 1 from governed_review_batch_items item
      cross join lateral governed_review_item_resolution(item.id) resolution
      where item.batch_id = batch.id and resolution.resolution_kind = 'coverage_gap'
    ) or not exists (
      select 1 from governed_review_batch_items item
      cross join lateral governed_review_item_resolution(item.id) resolution
      where item.batch_id = batch.id and resolution.resolution_kind = 'conflict'
    ) then
      raise exception 'alignment requires an adjudicable conflict and complete task coverage'
        using errcode = '23514';
    end if;
  elsif new.event_kind = 'adjudicating' then
    if current_state = 'alignment_open' and not exists (
      select 1 from governed_review_alignment_events alignment
      where alignment.batch_id = batch.id and alignment.event_kind = 'closed'
        and alignment.sequence = (
          select max(candidate.sequence) from governed_review_alignment_events candidate
          where candidate.batch_id = batch.id
        )
    ) then
      raise exception 'alignment must close before adjudication begins' using errcode = '23514';
    end if;
    if exists (
      select 1 from governed_review_batch_items item
      cross join lateral governed_review_item_resolution(item.id) resolution
      where item.batch_id = batch.id and resolution.resolution_kind = 'coverage_gap'
    ) or not exists (
      select 1 from governed_review_batch_items item
      cross join lateral governed_review_item_resolution(item.id) resolution
      where item.batch_id = batch.id and resolution.resolution_kind = 'conflict'
    ) then
      raise exception 'adjudication requires conflicts with complete task coverage'
        using errcode = '23514';
    end if;
  elsif new.event_kind = 'resolved' then
    if exists (
      select 1 from governed_review_batch_items item
      cross join lateral governed_review_item_resolution(item.id) resolution
      where item.batch_id = batch.id
        and resolution.resolution_kind not in ('single_rater','unanimous','adjudicated')
    ) then
      raise exception 'batch cannot resolve until every selected item has resolved truth'
        using errcode = '23514';
    end if;
  elsif new.event_kind = 'incomplete' then
    if not exists (
      select 1 from governed_review_batch_items item
      cross join lateral governed_review_item_resolution(item.id) resolution
      where item.batch_id = batch.id
        and resolution.resolution_kind in ('coverage_gap','unresolvable')
    ) then
      raise exception 'incomplete requires a coverage gap or unresolvable adjudication'
        using errcode = '23514';
    end if;
  elsif new.event_kind = 'frozen' then
    select * into target_revision from dataset_revisions
    where id = new.dataset_revision_id for key share;
    if target_revision.id is null or target_revision.project_id <> batch.project_id
       or target_revision.criterion_version_id <> batch.criterion_version_id
       or target_revision.role <> batch.role_intent
       or target_revision.item_count <> batch.fixed_budget then
      raise exception 'frozen batch must bind one complete matching dataset revision'
        using errcode = '23514';
    end if;
    if batch.role_intent = 'sealed_validation'
       and target_revision.provenance_level <> 'governed_blind' then
      raise exception 'sealed governed truth must materialize as governed_blind'
        using errcode = '23514';
    end if;
    if exists (
      select 1 from governed_review_batch_items item
      where item.batch_id = batch.id
        and not exists (
          select 1
          from governed_dataset_truth_links truth
          join dataset_revision_items revision_item
            on revision_item.id = truth.dataset_revision_item_id
          where truth.batch_item_id = item.id
            and truth.project_id = batch.project_id
            and revision_item.revision_id = target_revision.id
        )
    ) then
      raise exception 'truth freeze requires one materialized truth link for every selected item'
        using errcode = '23514';
    end if;
    if batch.role_intent = 'sealed_validation' then
      if not governed_review_has_eligible_capability_check(
        batch.id, 'truth_freeze', batch.custodian_subject_id, null
      ) then
        raise exception 'sealed truth freeze requires a fresh eligible custodian capability check'
          using errcode = '23514';
      end if;
      if exists (
        select subject_id from (
          select task.reviewer_subject_id as subject_id
          from governed_review_tasks task where task.batch_id = batch.id
          union
          select adjudication.adjudicator_subject_id
          from governed_review_adjudications adjudication where adjudication.batch_id = batch.id
        ) exposed
        where not governed_review_has_eligible_capability_check(
          batch.id, 'truth_freeze', exposed.subject_id, null
        )
      ) then
        raise exception 'sealed truth freeze requires fresh eligible checks for every content-exposed subject'
          using errcode = '23514';
      end if;
    end if;

    if batch.selection_method in ('simple_random','stratified_random')
       and batch.draw_executed_by = 'coeval_server'
       and batch.selection_seed is not null
       and batch.rng_version is not null
       and batch.population_definition <> '{}'::jsonb
       and batch.population_collection_provenance <> '{}'::jsonb
       and batch.draw_digest = governed_review_draw_digest(batch.id)
       and not exists (
         select 1 from governed_active_review_labels active
         where active.batch_id = batch.id and active.label = 'cannot_determine'
       )
       and not exists (
         select 1 from governed_review_tasks task
         where task.batch_id = batch.id
           and governed_review_current_task_state(task.id) <> 'submitted'
       ) then
      new.representative_of_population_id := batch.population_id;
      new.representative_ineligible_reasons := '{}'::text[];
    else
      new.representative_of_population_id := null;
      new.representative_ineligible_reasons := array_remove(array[
        case when batch.selection_method not in ('simple_random','stratified_random')
          then 'selection_method_not_representative' end,
        case when batch.population_definition = '{}'::jsonb
          or batch.population_collection_provenance = '{}'::jsonb
          then 'population_provenance_incomplete' end,
        case when batch.selection_seed is null or batch.rng_version is null
          or batch.draw_digest <> governed_review_draw_digest(batch.id)
          then 'selection_or_draw_not_reproducible' end,
        case when exists (
          select 1 from governed_active_review_labels active
          where active.batch_id = batch.id and active.label = 'cannot_determine'
        ) then 'cannot_determine_present' end,
        case when exists (
          select 1 from governed_review_tasks task
          where task.batch_id = batch.id
            and governed_review_current_task_state(task.id) <> 'submitted'
        ) then 'review_coverage_incomplete' end
      ]::text[], null);
    end if;
  end if;

  if new.event_kind <> 'frozen' then
    if new.dataset_revision_id is not null or new.representative_of_population_id is not null
       or cardinality(new.representative_ineligible_reasons) <> 0 then
      raise exception 'only frozen batch events carry truth revision and representative scope'
        using errcode = '23514';
    end if;
  elsif new.dataset_revision_id is null then
    raise exception 'frozen batch event requires its materialized dataset revision'
      using errcode = '23514';
  elsif (new.representative_of_population_id is not null
         and cardinality(new.representative_ineligible_reasons) <> 0)
     or (new.representative_of_population_id is null
         and cardinality(new.representative_ineligible_reasons) = 0) then
    raise exception 'frozen representative scope must have either a population ID or ordered ineligibility reasons'
      using errcode = '23514';
  end if;

  expected_digest := governed_content_v1_digest('governed-review-batch-event/v1', jsonb_build_object(
    'actorRoleAtReview', new.actor_role_at_review,
    'actorSubjectId', new.actor_subject_id,
    'batchId', new.batch_id,
    'datasetRevisionId', new.dataset_revision_id,
    'details', new.details,
    'eventKind', new.event_kind,
    'previousEventDigest', new.previous_event_digest,
    'representativeIneligibleReasons', to_jsonb(new.representative_ineligible_reasons),
    'representativeOfPopulationId', new.representative_of_population_id,
    'sequence', new.sequence,
    'stateVersion', new.state_version
  ));
  if new.event_digest <> expected_digest then
    raise exception 'governed review batch event content digest mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_governed_review_batch_item(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_review_batch_item() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  batch governed_review_batches%rowtype;
  item governed_review_items%rowtype;
  expected_digest text;
begin
  select * into batch from governed_review_batches where id = new.batch_id for update;
  select * into item from governed_review_items where id = new.review_item_id for key share;
  if batch.id is null or item.id is null
     or batch.project_id <> new.project_id or item.project_id <> new.project_id then
    raise exception 'batch membership must belong to one project' using errcode = '23514';
  end if;
  if governed_review_current_batch_state(batch.id) <> 'draft' then
    raise exception 'batch membership is immutable after open' using errcode = '55000';
  end if;
  if (batch.source_population_kind = 'dataset_revision' and (
        item.source_kind <> 'dataset_revision_item'
        or item.source_revision_id <> batch.source_population_id
      )) or (batch.source_population_kind = 'sealed_intake' and (
        item.source_kind <> 'sealed_intake'
        or item.sealed_intake_population_id <> batch.source_population_id
      )) then
    raise exception 'batch item must belong to the frozen source population' using errcode = '23514';
  end if;
  if (select count(*) from governed_review_batch_items existing where existing.batch_id = batch.id)
     >= batch.fixed_budget then
    raise exception 'batch membership exceeds its fixed budget' using errcode = '23514';
  end if;
  if batch.selection_method = 'stratified_random' and new.stratum_key is null then
    raise exception 'stratified draws require a stratum for every selected item' using errcode = '23514';
  end if;
  if batch.selection_method in ('simple_random','stratified_random')
     and (new.inclusion_probability is null or new.sampling_weight is null) then
    raise exception 'random draws require inclusion probability and sampling weight'
      using errcode = '23514';
  end if;
  expected_digest := governed_content_v1_digest('governed-review-batch-item/v1', jsonb_build_object(
    'batchId', new.batch_id,
    'drawPosition', new.draw_position,
    'frameMemberDigest', new.frame_member_digest,
    'inclusionProbability', new.inclusion_probability,
    'reviewItemId', new.review_item_id,
    'samplingWeight', new.sampling_weight,
    'stratumKey', new.stratum_key
  ));
  if new.content_digest <> expected_digest then
    raise exception 'governed review batch item content digest mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_governed_review_item(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_review_item() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  source_item dataset_revision_items%rowtype;
  source_revision dataset_revisions%rowtype;
  sealed_population governed_sealed_intake_populations%rowtype;
  predecessor_item dataset_revision_items%rowtype;
  predecessor_revision dataset_revisions%rowtype;
  expected_digest text;
begin
  if new.source_kind = 'sealed_intake' then
    -- Serialize the exact-identity decision without prohibiting ADR-0007's one
    -- direct protected successor.
    perform pg_advisory_xact_lock(hashtextextended(new.project_id || ':governed-sealed-identity-index', 0));
    perform pg_advisory_xact_lock(hashtextextended(new.project_id || ':' || new.input_digest, 0));
    select * into sealed_population
    from governed_sealed_intake_populations population
    where population.id = new.sealed_intake_population_id for key share;
    if sealed_population.id is null
       or sealed_population.project_id <> new.project_id
       or new.created_by_subject_id is distinct from sealed_population.custodian_subject_id
       or new.sealed_predecessor_revision_id is distinct from sealed_population.predecessor_revision_id then
      raise exception 'sealed review item must bind its exact population, project, custodian, and predecessor'
        using errcode = '23514';
    end if;
  end if;
  if new.created_by_subject_id is not null and not exists (
    select 1 from governed_reviewer_subjects subject
    where subject.id = new.created_by_subject_id and subject.project_id = new.project_id
  ) then
    raise exception 'governed review item author subject must belong to its project' using errcode = '23514';
  end if;

  if new.source_kind = 'dataset_revision_item' then
    select item.* into source_item
    from dataset_revision_items item
    where item.id = new.source_revision_item_id
      and item.revision_id = new.source_revision_id
      and item.project_id = new.project_id;
    select revision.* into source_revision
    from dataset_revisions revision
    where revision.id = new.source_revision_id and revision.project_id = new.project_id;
    if source_item.id is null or source_revision.role = 'sealed_validation' then
      raise exception 'nonsealed review items must bind an exact nonsealed immutable revision item'
        using errcode = '23514';
    end if;
    if source_item.input_digest <> new.input_digest
       or source_item.item_digest <> new.source_item_digest then
      raise exception 'governed review item must bind its exact immutable source item and input identity'
        using errcode = '23514';
    end if;
  else
    if exists (
      select 1 from case_input_identity_records identity
      where identity.project_id = new.project_id and identity.input_digest = new.input_digest
    ) then
      raise exception 'sealed intake input overlaps an existing case identity' using errcode = '23514';
    end if;
    if exists (
      select 1 from dataset_revision_items item
      join dataset_revisions revision on revision.id = item.revision_id
      where item.project_id = new.project_id
        and item.input_digest = new.input_digest
        and revision.role <> 'sealed_validation'
    ) then
      raise exception 'sealed intake input overlaps nonsealed revision evidence' using errcode = '23514';
    end if;

    if new.sealed_predecessor_revision_item_id is null then
      if exists (
        select 1 from dataset_revision_items item
        where item.project_id = new.project_id and item.input_digest = new.input_digest
      ) or exists (
        select 1 from governed_review_items item
        where item.project_id = new.project_id
          and item.source_kind = 'sealed_intake'
          and item.input_digest = new.input_digest
      ) then
        raise exception 'sealed intake input overlaps unrelated sealed evidence' using errcode = '23514';
      end if;
    else
      select item.* into predecessor_item
      from dataset_revision_items item
      where item.id = new.sealed_predecessor_revision_item_id
        and item.revision_id = new.sealed_predecessor_revision_id
        and item.project_id = new.project_id
      for key share;
      select revision.* into predecessor_revision
      from dataset_revisions revision
      where revision.id = new.sealed_predecessor_revision_id
        and revision.project_id = new.project_id
        and revision.role = 'sealed_validation'
      for key share;
      if predecessor_item.id is null or predecessor_item.input_digest <> new.input_digest then
        raise exception 'sealed successor intake must bind an exact protected predecessor item'
          using errcode = '23514';
      end if;
      if exists (
        select 1 from dataset_exposure_events exposure
        where exposure.revision_id = predecessor_revision.id
          and exposure.exposure_class = 'development'
      ) or exists (
        select 1 from dataset_revisions child
        where child.parent_revision_id = predecessor_revision.id
          and child.role = 'sealed_validation'
      ) then
        raise exception 'sealed successor requires an unexposed predecessor with no sealed child'
          using errcode = '23514';
      end if;
      if exists (
        select 1 from dataset_revision_items item
        join dataset_revisions revision on revision.id = item.revision_id
        where item.project_id = new.project_id
          and item.input_digest = new.input_digest
          and revision.role = 'sealed_validation'
          and revision.series_id <> predecessor_revision.series_id
      ) then
        raise exception 'sealed successor input overlaps an unrelated sealed lineage' using errcode = '23514';
      end if;
      if exists (
        select 1 from governed_review_items existing
        where existing.project_id = new.project_id
          and existing.source_kind = 'sealed_intake'
          and existing.input_digest = new.input_digest
          and not exists (
            select 1
            from governed_dataset_truth_links truth
            join dataset_revision_items materialized on materialized.id = truth.dataset_revision_item_id
            join dataset_revisions revision on revision.id = materialized.revision_id
            where truth.batch_item_id in (
              select batch_item.id from governed_review_batch_items batch_item
              where batch_item.review_item_id = existing.id
            )
              and revision.series_id = predecessor_revision.series_id
          )
      ) then
        raise exception 'sealed successor input overlaps an unrelated intake' using errcode = '23514';
      end if;
    end if;
  end if;

  expected_digest := governed_content_v1_digest('governed-review-item/v1', jsonb_build_object(
    'identityBasis', new.identity_basis,
    'inputDigest', new.input_digest,
    'redactionProvenance', new.redaction_provenance,
    'reviewPayloadProjectionVersion', new.review_payload_projection_version,
    'reviewPayloadSnapshot', new.review_payload_snapshot,
    'sealedFramePosition', new.sealed_frame_position,
    'sealedIntakePopulationId', new.sealed_intake_population_id,
    'sealedPredecessorRevisionId', new.sealed_predecessor_revision_id,
    'sealedPredecessorRevisionItemId', new.sealed_predecessor_revision_item_id,
    'sourceKind', new.source_kind,
    'sourceItemDigest', new.source_item_digest,
    'sourceRevisionId', new.source_revision_id,
    'sourceRevisionItemId', new.source_revision_item_id
  ));
  if new.content_digest <> expected_digest then
    raise exception 'governed review item content digest mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_governed_review_label(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_review_label() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  task governed_review_tasks%rowtype;
  batch governed_review_batches%rowtype;
  replaced governed_review_labels%rowtype;
  task_state text;
  expected_digest text;
begin
  select * into task from governed_review_tasks where id = new.task_id;
  if task.id is null then
    raise exception 'governed label requires an existing task' using errcode = '23514';
  end if;
  select * into batch from governed_review_batches where id = task.batch_id for update;
  perform 1 from governed_review_tasks where id = task.id for update;
  if task.project_id <> new.project_id or task.reviewer_subject_id <> new.reviewer_subject_id
     or batch.project_id <> new.project_id then
    raise exception 'governed label must belong to its assigned reviewer and project'
      using errcode = '23514';
  end if;
  if governed_review_current_batch_state(batch.id) <> 'open' then
    raise exception 'labels are closed after the independent-submission barrier'
      using errcode = '55000';
  end if;
  task_state := governed_review_current_task_state(task.id);
  if task_state not in ('viewed','withdrawn') then
    raise exception 'label submission is invalid from task state %', task_state using errcode = '40001';
  end if;
  if new.replaces_label_id is not null then
    select * into replaced from governed_review_labels where id = new.replaces_label_id for key share;
    if task_state <> 'withdrawn' or replaced.id is null or replaced.task_id <> task.id
       or new.attempt <> replaced.attempt + 1 or replaced.reviewer_subject_id <> new.reviewer_subject_id then
      raise exception 'replacement label must extend the withdrawn attempt for the same task'
        using errcode = '23514';
    end if;
    if not exists (
      select 1 from governed_review_task_events event
      where event.task_id = task.id
        and event.event_kind = 'label_withdrawn'
        and event.label_id = replaced.id
        and event.state_version = (
          select max(latest.state_version) from governed_review_task_events latest
          where latest.task_id = task.id
        )
    ) then
      raise exception 'replacement label must name the active withdrawn label' using errcode = '23514';
    end if;
  end if;
  expected_digest := governed_content_v1_digest('governed-review-label/v1', jsonb_build_object(
    'attempt', new.attempt,
    'blindViewDigest', new.blind_view_digest,
    'failureCodes', to_jsonb(new.failure_codes),
    'label', new.label,
    'rationale', new.rationale,
    'replacesLabelId', new.replaces_label_id,
    'reviewerSubjectId', new.reviewer_subject_id,
    'taskId', new.task_id
  ));
  if new.content_digest <> expected_digest then
    raise exception 'governed label content digest mismatch' using errcode = '23514';
  end if;
  if new.blind_view_digest is distinct from (
    select event.view_digest from governed_review_task_events event
    where event.task_id = task.id and event.event_kind = 'viewed'
    order by event.sequence asc limit 1
  ) then
    raise exception 'label must bind the immutable blind reviewer view digest'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_governed_review_task(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_review_task() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  batch governed_review_batches%rowtype;
  batch_item governed_review_batch_items%rowtype;
  reviewer governed_reviewer_subjects%rowtype;
  expected_digest text;
begin
  select * into batch from governed_review_batches where id = new.batch_id for update;
  select * into batch_item from governed_review_batch_items where id = new.batch_item_id for update;
  select * into reviewer from governed_reviewer_subjects where id = new.reviewer_subject_id for key share;
  if batch.id is null or batch_item.id is null or reviewer.id is null
     or batch.project_id <> new.project_id
     or batch_item.project_id <> new.project_id
     or batch_item.batch_id <> batch.id
     or reviewer.project_id <> new.project_id then
    raise exception 'review task assignment must belong to its batch project' using errcode = '23514';
  end if;
  if governed_review_current_batch_state(batch.id) <> 'draft' then
    raise exception 'review assignments are immutable after batch open' using errcode = '55000';
  end if;
  if batch.role_intent = 'sealed_validation' and reviewer.id = batch.custodian_subject_id then
    raise exception 'sealed batch custodian cannot be a reviewer' using errcode = '23514';
  end if;
  if (select count(*) from governed_review_tasks task where task.batch_item_id = batch_item.id)
     >= batch.required_labels_per_item then
    raise exception 'review item already has its required immutable assignments' using errcode = '23514';
  end if;
  expected_digest := governed_content_v1_digest('governed-review-task/v1', jsonb_build_object(
    'batchId', new.batch_id,
    'batchItemId', new.batch_item_id,
    'reviewerRoleAtReview', new.reviewer_role_at_review,
    'reviewerSubjectId', new.reviewer_subject_id,
    'serveOrder', new.serve_order
  ));
  if new.content_digest <> expected_digest then
    raise exception 'governed review task content digest mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_governed_review_task_event(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_review_task_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  task governed_review_tasks%rowtype;
  batch governed_review_batches%rowtype;
  current_version integer;
  current_state text;
  current_event_digest text;
  current_event_occurred_at timestamptz;
  current_label_id text;
  submitted_label governed_review_labels%rowtype;
  expected_digest text;
begin
  select * into task from governed_review_tasks where id = new.task_id;
  if task.id is null then
    raise exception 'task event requires an existing review task' using errcode = '23514';
  end if;
  select * into batch from governed_review_batches where id = task.batch_id for update;
  perform 1 from governed_review_tasks where id = task.id for update;
  if task.project_id <> new.project_id or batch.project_id <> new.project_id then
    raise exception 'task event must belong to its task project' using errcode = '23514';
  end if;
  if governed_review_current_batch_state(batch.id) <> 'open' then
    raise exception 'task event rejected after labeling closed' using errcode = '55000';
  end if;
  select coalesce(max(event.state_version), 0) into current_version
  from governed_review_task_events event where event.task_id = task.id;
  select event.event_digest, event.occurred_at
  into current_event_digest, current_event_occurred_at
  from governed_review_task_events event
  where event.task_id = task.id order by event.sequence desc limit 1;
  if new.occurred_at > clock_timestamp()
     or (current_event_occurred_at is not null and new.occurred_at < current_event_occurred_at)
     or (current_event_occurred_at is null and new.occurred_at < task.created_at) then
    raise exception 'governed task event time must be server-current and monotonic'
      using errcode = '23514';
  end if;
  if new.expected_previous_state_version <> current_version
     or new.state_version <> current_version + 1
     or new.sequence <> current_version + 1
     or new.previous_event_digest is distinct from current_event_digest then
    raise exception 'governed task state version conflict' using errcode = '40001';
  end if;
  current_state := governed_review_current_task_state(task.id);

  if new.event_kind = 'viewed' then
    if current_state <> 'assigned' then
      raise exception 'viewed requires assigned task state' using errcode = '40001';
    end if;
    begin
      if new.view_digest <> governed_bytes_v1_digest(decode(new.canonical_view_bytes_base64, 'base64'))
         or octet_length(decode(new.canonical_view_bytes_base64, 'base64')) > 2097152 then
        raise exception 'reviewer-visible canonical bytes digest mismatch' using errcode = '23514';
      end if;
    exception when invalid_parameter_value then
      raise exception 'reviewer-visible canonical bytes digest mismatch' using errcode = '23514';
    end;
  elsif new.event_kind = 'deferred' then
    if current_state <> 'viewed' then
      raise exception 'deferred requires viewed task state' using errcode = '40001';
    end if;
  elsif new.event_kind = 'resumed' then
    if current_state <> 'deferred' then
      raise exception 'resumed requires deferred task state' using errcode = '40001';
    end if;
  elsif new.event_kind = 'label_submitted' then
    if current_state not in ('viewed','withdrawn') then
      raise exception 'label_submitted is invalid from task state %', current_state using errcode = '40001';
    end if;
    select * into submitted_label from governed_review_labels where id = new.label_id for key share;
    if submitted_label.id is null or submitted_label.task_id <> task.id
       or submitted_label.reviewer_subject_id <> task.reviewer_subject_id then
      raise exception 'submitted label must belong to the task reviewer' using errcode = '23514';
    end if;
    if current_state = 'withdrawn' and submitted_label.replaces_label_id is distinct from (
      select prior.label_id from governed_review_task_events prior
      where prior.task_id = task.id order by prior.state_version desc limit 1
    ) then
      raise exception 'replacement submission must name the withdrawn label' using errcode = '23514';
    end if;
  elsif new.event_kind = 'label_withdrawn' then
    if current_state <> 'submitted' then
      raise exception 'label_withdrawn requires submitted task state' using errcode = '40001';
    end if;
    select prior.label_id into current_label_id
    from governed_review_task_events prior
    where prior.task_id = task.id order by prior.state_version desc limit 1;
    if new.label_id <> current_label_id then
      raise exception 'withdrawal must name the current active label' using errcode = '23514';
    end if;
  elsif new.event_kind = 'expired' then
    if current_state not in ('assigned','viewed','withdrawn') or new.occurred_at < batch.stop_at then
      raise exception 'expired is server-only at the fixed stop for an incomplete task'
        using errcode = '40001';
    end if;
  end if;

  if new.event_kind = 'expired' then
    if new.actor_subject_id is not null or new.actor_role_at_review is not null then
      raise exception 'server expiry has no reviewer actor' using errcode = '23514';
    end if;
  elsif new.actor_subject_id <> task.reviewer_subject_id
        or new.actor_role_at_review is distinct from task.reviewer_role_at_review then
    raise exception 'task action actor must be the immutable assigned reviewer snapshot'
      using errcode = '23514';
  end if;

  expected_digest := governed_content_v1_digest('governed-review-task-event/v1', jsonb_build_object(
    'activity', new.activity,
    'actorRoleAtReview', new.actor_role_at_review,
    'actorSubjectId', new.actor_subject_id,
    'canonicalizationVersion', new.canonicalization_version,
    'eventKind', new.event_kind,
    'exposureClass', new.exposure_class,
    'labelId', new.label_id,
    'reason', new.reason,
    'canonicalViewBytesBase64', new.canonical_view_bytes_base64,
    'previousEventDigest', new.previous_event_digest,
    'sequence', new.sequence,
    'stateVersion', new.state_version,
    'taskId', new.task_id,
    'viewContractVersion', new.view_contract_version,
    'viewDigest', new.view_digest
  ));
  if new.event_digest <> expected_digest then
    raise exception 'governed review task event content digest mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_governed_reviewer_subject(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_reviewer_subject() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.subject_digest <> governed_content_v1_digest(
    'governed-reviewer-subject/v1',
    jsonb_build_object('projectId', new.project_id, 'subjectId', new.id)
  ) then
    raise exception 'governed reviewer subject digest mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_governed_sealed_identity_reverse_overlap(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_sealed_identity_reverse_overlap() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if exists (
    select 1 from governed_review_items item
    where item.project_id = new.project_id
      and item.source_kind = 'sealed_intake'
      and item.input_digest = new.input_digest
  ) then
    raise exception 'case identity overlaps protected sealed intake' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_governed_sealed_intake_population(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_sealed_intake_population() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  predecessor dataset_revisions%rowtype;
  expected_digest text;
begin
  if not exists (
    select 1 from governed_reviewer_subjects subject
    where subject.id = new.custodian_subject_id and subject.project_id = new.project_id
  ) then
    raise exception 'sealed intake population custodian must belong to its project'
      using errcode = '23514';
  end if;
  if new.predecessor_revision_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(
      new.project_id || ':sealed-predecessor:' || new.predecessor_revision_id, 0
    ));
    select * into predecessor from dataset_revisions
    where id = new.predecessor_revision_id and project_id = new.project_id
    for key share;
    if predecessor.id is null or predecessor.role <> 'sealed_validation' then
      raise exception 'sealed intake successor population requires an exact protected predecessor revision'
        using errcode = '23514';
    end if;
    if exists (
      select 1 from dataset_exposure_events exposure
      where exposure.revision_id = predecessor.id and exposure.exposure_class = 'development'
    ) or exists (
      select 1 from dataset_revisions child
      where child.parent_revision_id = predecessor.id and child.role = 'sealed_validation'
    ) then
      raise exception 'sealed intake successor population requires an unexposed predecessor with no sealed child'
        using errcode = '23514';
    end if;
  end if;
  expected_digest := governed_content_v1_digest(
    'governed-sealed-intake-population/v1', jsonb_build_object(
      'collectionProvenance', new.collection_provenance,
      'custodianRoleAtReview', new.custodian_role_at_review,
      'custodianSubjectId', new.custodian_subject_id,
      'frameCount', new.frame_count,
      'frameDigest', new.frame_digest,
      'populationDefinition', new.population_definition,
      'predecessorRevisionId', new.predecessor_revision_id,
      'windowEnd', new.window_end,
      'windowStart', new.window_start
    )
  );
  if new.content_digest <> expected_digest then
    raise exception 'sealed intake population content digest mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_governed_sealed_population_complete(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_sealed_population_complete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if (select count(*) from governed_review_items item
      where item.sealed_intake_population_id = new.id) <> new.frame_count
     or governed_sealed_intake_frame_digest(new.id) <> new.frame_digest then
    raise exception 'sealed intake population and its exact immutable frame must commit atomically'
      using errcode = '23514';
  end if;
  return null;
end;
$$;


--
-- Name: guard_governed_sealed_revision_reverse_overlap(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_sealed_revision_reverse_overlap() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  target_role text;
begin
  select role into target_role from dataset_revisions where id = new.revision_id;
  if target_role <> 'sealed_validation' and exists (
    select 1 from governed_review_items item
    where item.project_id = new.project_id
      and item.source_kind = 'sealed_intake'
      and item.input_digest = new.input_digest
  ) then
    raise exception 'nonsealed revision input overlaps protected sealed intake'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_governed_subject_append_only(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_subject_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'UPDATE' then
    if old.account_user_id is not null
       and new.account_user_id is null
       and old.id = new.id
       and old.project_id = new.project_id
       and old.subject_digest = new.subject_digest
       and old.created_at = new.created_at
       and not exists (select 1 from "user" account where account.id = old.account_user_id) then
      return new;
    end if;
    raise exception 'governed reviewer subjects are append-only except account-link erasure'
      using errcode = '55000';
  end if;
  if tg_op = 'DELETE' and exists (
    select 1 from projects project where project.id = old.project_id
  ) then
    raise exception 'governed reviewer subjects are append-only while their project exists'
      using errcode = '55000';
  end if;
  return old;
end;
$$;


--
-- Name: guard_governed_truth_link_label(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_truth_link_label() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if not exists (
    select 1
    from governed_dataset_truth_links truth
    join governed_review_labels label on label.id = new.label_id
    join governed_review_tasks task on task.id = label.task_id
    where truth.id = new.truth_link_id
      and truth.project_id = new.project_id
      and truth.source_kind = 'governed_labels'
      and label.project_id = new.project_id
      and task.batch_item_id = truth.batch_item_id
      and label.id = any(truth.governed_label_ids)
  ) then
    raise exception 'truth-link label must be one of the declared governed labels for the item'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_governed_truth_link_labels_complete(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_governed_truth_link_labels_complete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.source_kind = 'governed_labels' and (
    (select count(*) from governed_dataset_truth_link_labels link
     where link.truth_link_id = new.id) <> cardinality(new.governed_label_ids)
    or exists (
      select unnest(new.governed_label_ids)
      except
      select link.label_id from governed_dataset_truth_link_labels link
      where link.truth_link_id = new.id
    )
  ) then
    raise exception 'truth link must commit every declared governed label ID'
      using errcode = '23514';
  elsif new.source_kind <> 'governed_labels' and exists (
    select 1 from governed_dataset_truth_link_labels link where link.truth_link_id = new.id
  ) then
    raise exception 'adjudication/import truth links cannot carry direct governed labels'
      using errcode = '23514';
  end if;
  return null;
end;
$$;


--
-- Name: guard_regression_run_revision_binding(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_regression_run_revision_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.dataset_revision_id is not null and not exists (
    select 1
    from dataset_revisions revision
    join skill_versions version
      on version.id = new.skill_version_id
     and version.project_id = new.project_id
     and version.criterion_version_id = new.criterion_version_id
    where revision.id = new.dataset_revision_id
      and revision.project_id = new.project_id
      and revision.role = 'regression_golden'
      and revision.criterion_version_id = new.criterion_version_id
      and version.regression_dataset_revision_id = revision.id
  ) then
    raise exception 'regression run revision must match its evaluator and criterion binding'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_review_instruction_version(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_review_instruction_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  predecessor review_instruction_versions%rowtype;
  expected_digest text;
begin
  if not exists (
    select 1 from criterion_versions version
    where version.id = new.criterion_version_id and version.project_id = new.project_id
  ) then
    raise exception 'review instruction criterion must belong to its project' using errcode = '23514';
  end if;
  if new.created_by_subject_id is not null and not exists (
    select 1 from governed_reviewer_subjects subject
    where subject.id = new.created_by_subject_id and subject.project_id = new.project_id
  ) then
    raise exception 'review instruction author subject must belong to its project' using errcode = '23514';
  end if;
  if new.predecessor_instruction_version_id is null then
    if new.revision <> 1 then
      raise exception 'first review instruction version must have revision 1' using errcode = '23514';
    end if;
  else
    select * into predecessor from review_instruction_versions
    where id = new.predecessor_instruction_version_id for key share;
    if predecessor.id is null or predecessor.project_id <> new.project_id
       or predecessor.criterion_version_id <> new.criterion_version_id
       or new.revision <> predecessor.revision + 1 then
      raise exception 'review instruction successor must advance the same criterion lineage by one revision'
        using errcode = '23514';
    end if;
  end if;
  expected_digest := governed_content_v1_digest('review-instruction/v1', jsonb_build_object(
    'allowedLabels', to_jsonb(new.allowed_labels),
    'criterionVersionId', new.criterion_version_id,
    'failureCodeGuidance', new.failure_code_guidance,
    'id', new.id,
    'instructions', new.instructions,
    'predecessorInstructionVersionId', new.predecessor_instruction_version_id,
    'revision', new.revision,
    'title', new.title
  ));
  if new.content_digest <> expected_digest then
    raise exception 'review instruction content digest mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_revision_bound_case_payload_immutable(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_revision_bound_case_payload_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if old.normalized_payload is distinct from new.normalized_payload and exists (
    select 1 from dataset_revision_items item
    where item.project_id = old.project_id
      and item.source_case_id = old.id
  ) then
    raise exception 'a case backing an immutable dataset revision cannot change payload'
      using errcode = '55000';
  end if;
  return new;
end;
$$;


--
-- Name: guard_run_comparison_revision(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_run_comparison_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.dataset_revision_id is not null and not exists (
    select 1
    from dataset_revisions revision
    join eval_runs run_a
      on run_a.id = new.run_a_id
     and run_a.project_id = new.project_id
     and run_a.dataset_revision_id = revision.id
    join eval_runs run_b
      on run_b.id = new.run_b_id
     and run_b.project_id = new.project_id
     and run_b.dataset_revision_id = revision.id
    where revision.id = new.dataset_revision_id
      and revision.project_id = new.project_id
      and revision.source_dataset_id = new.dataset_id
  ) then
    raise exception 'run comparison revision must match its dataset and both eval runs'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_skill_version_developer_identity(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_skill_version_developer_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'UPDATE' then
    if new.created_by_subject_id is distinct from old.created_by_subject_id
       or new.developer_identity_status is distinct from old.developer_identity_status then
      raise exception 'skill-version developer subject provenance is immutable'
        using errcode = '55000';
    end if;
    if new.created_by_user_id is distinct from old.created_by_user_id
       and not (
         old.created_by_user_id is not null
         and new.created_by_user_id is null
         and not exists (select 1 from "user" account where account.id = old.created_by_user_id)
       ) then
      raise exception 'skill-version developer account link is immutable except account erasure'
        using errcode = '55000';
    end if;
  end if;
  if new.developer_identity_status = 'unknown_legacy' then
    if new.created_by_subject_id is not null or new.created_by_user_id is not null then
      raise exception 'unknown legacy developer identity cannot assert author links'
        using errcode = '23514';
    end if;
  elsif not exists (
    select 1 from governed_reviewer_subjects subject
    where subject.id = new.created_by_subject_id
      and subject.project_id = new.project_id
      and subject.account_user_id = new.created_by_user_id
  ) then
    raise exception 'recorded evaluator developer requires a same-project subject/account binding'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: guard_skill_version_revision_binding(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION guard_skill_version_revision_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.regression_dataset_revision_id is not null and not exists (
    select 1 from dataset_revisions revision
    where revision.id = new.regression_dataset_revision_id
      and revision.project_id = new.project_id
      and revision.role = 'regression_golden'
      and revision.criterion_version_id = new.criterion_version_id
  ) then
    raise exception 'skill version regression revision must match its criterion in the same project'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


--
-- Name: lock_evaluator_lineage_for_calibration_revocation_v1(); Type: FUNCTION; Schema: current; Owner: -
--

CREATE FUNCTION lock_evaluator_lineage_for_calibration_revocation_v1() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare target_criterion_id text;
begin
  select skill.criterion_id into target_criterion_id
  from binary_calibration_artifacts artifact
  join binary_calibration_runs run on run.id=artifact.run_id
  join skill_versions version on version.id=run.skill_version_id
  join skills skill on skill.id=version.skill_id
  where artifact.id=new.artifact_id and artifact.project_id=new.project_id;
  if target_criterion_id is not null then
    perform 1 from criteria where id=target_criterion_id and project_id=new.project_id for update;
  end if;
  return new;
end;
$$;


--
-- Name: account; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE account (
    id text NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    password text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_setup_pairings; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE agent_setup_pairings (
    id text NOT NULL,
    project_id text NOT NULL,
    created_by_user_id text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    claimed_at timestamp with time zone,
    consumed_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: analysis_population_draw_items; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE analysis_population_draw_items (
    id text NOT NULL,
    project_id text NOT NULL,
    draw_id text NOT NULL,
    population_id text NOT NULL,
    member_id text NOT NULL,
    revision_item_id text NOT NULL,
    case_id text NOT NULL,
    "position" integer NOT NULL,
    frame_member_digest text NOT NULL,
    rank_digest text NOT NULL,
    content_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_population_draw_items_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_population_draw_items_frame_member_digest_check CHECK ((frame_member_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_population_draw_items_position_check CHECK ((("position" >= 0) AND ("position" < 10000))),
    CONSTRAINT analysis_population_draw_items_rank_digest_check CHECK ((rank_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: analysis_population_draws; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE analysis_population_draws (
    id text NOT NULL,
    project_id text NOT NULL,
    population_id text NOT NULL,
    dataset_revision_id text NOT NULL,
    method text NOT NULL,
    stopping_rule text NOT NULL,
    draw_executor text NOT NULL,
    seed text NOT NULL,
    rng_version text NOT NULL,
    algorithm_version text NOT NULL,
    fixed_budget integer NOT NULL,
    population_size integer NOT NULL,
    inclusion_numerator integer NOT NULL,
    inclusion_denominator integer NOT NULL,
    draw_digest text NOT NULL,
    content_digest text NOT NULL,
    executed_by_subject_id text NOT NULL,
    executed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_population_draws_algorithm_version_check CHECK ((algorithm_version = 'coeval-analysis-draw/v1'::text)),
    CONSTRAINT analysis_population_draws_check CHECK ((fixed_budget <= population_size)),
    CONSTRAINT analysis_population_draws_check1 CHECK ((inclusion_numerator = fixed_budget)),
    CONSTRAINT analysis_population_draws_check2 CHECK ((inclusion_denominator = population_size)),
    CONSTRAINT analysis_population_draws_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_population_draws_draw_digest_check CHECK ((draw_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_population_draws_draw_executor_check CHECK ((draw_executor = 'coeval_server'::text)),
    CONSTRAINT analysis_population_draws_fixed_budget_check CHECK (((fixed_budget >= 1) AND (fixed_budget <= 10000))),
    CONSTRAINT analysis_population_draws_method_check CHECK ((method = 'simple_random'::text)),
    CONSTRAINT analysis_population_draws_population_size_check CHECK (((population_size >= 1) AND (population_size <= 100000))),
    CONSTRAINT analysis_population_draws_rng_version_check CHECK ((rng_version = 'sha256-rank/v1'::text)),
    CONSTRAINT analysis_population_draws_seed_check CHECK ((seed ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_population_draws_stopping_rule_check CHECK ((stopping_rule = 'fixed'::text))
);


--
-- Name: analysis_population_exclusions; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE analysis_population_exclusions (
    id text NOT NULL,
    project_id text NOT NULL,
    population_id text NOT NULL,
    case_id text NOT NULL,
    raw_trace_id text,
    source_trace_id text,
    case_type text NOT NULL,
    ingestion_purpose text NOT NULL,
    "position" bigint NOT NULL,
    ingestion_time timestamp with time zone NOT NULL,
    reason text NOT NULL,
    content_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_population_exclusions_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_population_exclusions_ingestion_purpose_check CHECK ((ingestion_purpose = ANY (ARRAY['judge_api'::text, 'judge_batch_general'::text, 'dataset_example'::text, 'trace_test_synthetic'::text, 'release_evidence'::text]))),
    CONSTRAINT analysis_population_exclusions_position_check CHECK (("position" >= 0)),
    CONSTRAINT analysis_population_exclusions_reason_check CHECK ((reason = 'ineligible_ingestion_purpose'::text))
);


--
-- Name: analysis_population_members; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE analysis_population_members (
    id text NOT NULL,
    project_id text NOT NULL,
    population_id text NOT NULL,
    revision_item_id text NOT NULL,
    case_id text NOT NULL,
    raw_trace_id text NOT NULL,
    source_trace_id text NOT NULL,
    case_type text NOT NULL,
    ingestion_purpose text NOT NULL,
    "position" integer NOT NULL,
    ingestion_time timestamp with time zone NOT NULL,
    input_digest text NOT NULL,
    item_digest text NOT NULL,
    frame_member_digest text NOT NULL,
    lineage_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_population_members_case_type_check CHECK ((case_type = ANY (ARRAY['manual'::text, 'langsmith'::text, 'langfuse'::text, 'ironside'::text]))),
    CONSTRAINT analysis_population_members_frame_member_digest_check CHECK ((frame_member_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_population_members_ingestion_purpose_check CHECK ((ingestion_purpose = ANY (ARRAY['analysis_eligible_manual'::text, 'analysis_eligible_langsmith'::text, 'analysis_eligible_langfuse'::text, 'analysis_eligible_ironside'::text]))),
    CONSTRAINT analysis_population_members_input_digest_check CHECK ((input_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_population_members_item_digest_check CHECK ((item_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_population_members_lineage_digest_check CHECK ((lineage_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_population_members_position_check CHECK ((("position" >= 0) AND ("position" < 100000))),
    CONSTRAINT analysis_population_members_source_trace_id_check CHECK ((length(source_trace_id) > 0))
);


--
-- Name: analysis_population_requests; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE analysis_population_requests (
    id text NOT NULL,
    project_id text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    population_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_population_requests_idempotency_key_check CHECK (((length(idempotency_key) > 0) AND (idempotency_key = TRIM(BOTH FROM idempotency_key)) AND (octet_length(idempotency_key) <= 1024))),
    CONSTRAINT analysis_population_requests_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: analysis_populations; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE analysis_populations (
    id text NOT NULL,
    project_id text NOT NULL,
    dataset_revision_id text NOT NULL,
    window_start timestamp with time zone NOT NULL,
    window_end timestamp with time zone NOT NULL,
    eligible_sources text[] NOT NULL,
    eligible_ingestion_purposes text[] NOT NULL,
    canonicalization_version text NOT NULL,
    ordering_version text NOT NULL,
    population_size integer NOT NULL,
    exclusion_count bigint NOT NULL,
    frame_digest text NOT NULL,
    content_digest text NOT NULL,
    snapshot_xid8 text NOT NULL,
    snapshot_taken_at timestamp with time zone NOT NULL,
    created_by_user_id text NOT NULL,
    created_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT analysis_populations_canonicalization_version_check CHECK ((canonicalization_version = 'governed-content-json/v1'::text)),
    CONSTRAINT analysis_populations_check CHECK ((window_end > window_start)),
    CONSTRAINT analysis_populations_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_populations_eligible_ingestion_purposes_check CHECK ((eligible_ingestion_purposes = ARRAY['analysis_eligible_manual'::text, 'analysis_eligible_langsmith'::text, 'analysis_eligible_langfuse'::text, 'analysis_eligible_ironside'::text])),
    CONSTRAINT analysis_populations_eligible_sources_check CHECK ((eligible_sources = ARRAY['manual'::text, 'langsmith'::text, 'langfuse'::text, 'ironside'::text])),
    CONSTRAINT analysis_populations_exclusion_count_check CHECK ((exclusion_count >= 0)),
    CONSTRAINT analysis_populations_frame_digest_check CHECK ((frame_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT analysis_populations_ordering_version_check CHECK ((ordering_version = 'cases-created-at-id/v1'::text)),
    CONSTRAINT analysis_populations_population_size_check CHECK (((population_size >= 1) AND (population_size <= 100000))),
    CONSTRAINT analysis_populations_snapshot_xid8_check CHECK (((length(snapshot_xid8) > 0) AND (octet_length(snapshot_xid8) <= 1048576))),
    CONSTRAINT analysis_populations_window_end_check CHECK ((date_trunc('milliseconds'::text, window_end) = window_end)),
    CONSTRAINT analysis_populations_window_start_check CHECK ((date_trunc('milliseconds'::text, window_start) = window_start))
);


--
-- Name: api_keys; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE api_keys (
    id text NOT NULL,
    project_id text NOT NULL,
    name text NOT NULL,
    key_hash text NOT NULL,
    key_prefix text NOT NULL,
    created_by_user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone
);


--
-- Name: assessment_receipt_artifacts; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE assessment_receipt_artifacts (
    id text NOT NULL,
    project_id text NOT NULL,
    eval_run_id text NOT NULL,
    receipt_id text NOT NULL,
    contract_version integer NOT NULL,
    artifact_revision integer NOT NULL,
    canonical_bytes bytea NOT NULL,
    artifact_digest text NOT NULL,
    evidence_digest text NOT NULL,
    source_snapshot_digest text NOT NULL,
    source_kind text NOT NULL,
    predecessor_artifact_id text,
    correction_reason text,
    created_by_user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT assessment_receipt_artifacts_artifact_digest_check CHECK ((artifact_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT assessment_receipt_artifacts_artifact_revision_check CHECK ((artifact_revision > 0)),
    CONSTRAINT assessment_receipt_artifacts_check CHECK ((((artifact_revision = 1) AND (predecessor_artifact_id IS NULL) AND (source_kind <> 'correction'::text) AND (correction_reason IS NULL)) OR ((artifact_revision > 1) AND (predecessor_artifact_id IS NOT NULL) AND (source_kind = 'correction'::text) AND (length(TRIM(BOTH FROM correction_reason)) > 0)))),
    CONSTRAINT assessment_receipt_artifacts_contract_version_check CHECK ((contract_version > 0)),
    CONSTRAINT assessment_receipt_artifacts_evidence_digest_check CHECK ((evidence_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT assessment_receipt_artifacts_source_kind_check CHECK ((source_kind = ANY (ARRAY['terminal_mint'::text, 'historical_freeze'::text, 'correction'::text]))),
    CONSTRAINT assessment_receipt_artifacts_source_snapshot_digest_check CHECK ((source_snapshot_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: assessment_receipt_comparisons; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE assessment_receipt_comparisons (
    id text NOT NULL,
    project_id text NOT NULL,
    eval_run_id text NOT NULL,
    artifact_id text NOT NULL,
    consumer_receipt_id text NOT NULL,
    consumer_canonical_bytes bytea NOT NULL,
    consumer_artifact_digest text NOT NULL,
    comparison_status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT assessment_receipt_comparisons_comparison_status_check CHECK ((comparison_status = ANY (ARRAY['match'::text, 'diverged'::text]))),
    CONSTRAINT assessment_receipt_comparisons_consumer_artifact_digest_check CHECK ((consumer_artifact_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT assessment_receipt_comparisons_consumer_canonical_bytes_check CHECK ((octet_length(consumer_canonical_bytes) > 0))
);


--
-- Name: audit_logs; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE audit_logs (
    id text NOT NULL,
    project_id text,
    actor_user_id text,
    action text NOT NULL,
    target_type text NOT NULL,
    target_id text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: binary_calibration_artifacts; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE binary_calibration_artifacts (
    id text NOT NULL,
    run_id text NOT NULL,
    project_id text NOT NULL,
    private_ledger_id text NOT NULL,
    artifact_revision integer NOT NULL,
    predecessor_artifact_id text,
    correction_reason text,
    status text NOT NULL,
    contract text NOT NULL,
    canonical_bytes bytea NOT NULL,
    artifact_digest text NOT NULL,
    evidence_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT binary_calibration_artifacts_artifact_digest_check CHECK ((artifact_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT binary_calibration_artifacts_artifact_revision_check CHECK ((artifact_revision > 0)),
    CONSTRAINT binary_calibration_artifacts_canonical_bytes_check CHECK (((octet_length(canonical_bytes) >= 2) AND (octet_length(canonical_bytes) <= 16777216))),
    CONSTRAINT binary_calibration_artifacts_check CHECK ((((artifact_revision = 1) AND (predecessor_artifact_id IS NULL) AND (correction_reason IS NULL)) OR ((artifact_revision > 1) AND (predecessor_artifact_id IS NOT NULL) AND (correction_reason IS NOT NULL)))),
    CONSTRAINT binary_calibration_artifacts_contract_check CHECK ((contract = 'coeval/binary-calibration/v1'::text)),
    CONSTRAINT binary_calibration_artifacts_evidence_digest_check CHECK ((evidence_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT binary_calibration_artifacts_status_check CHECK ((status = ANY (ARRAY['complete'::text, 'incomplete'::text])))
);


--
-- Name: binary_calibration_attempts; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE binary_calibration_attempts (
    id text NOT NULL,
    run_id text NOT NULL,
    project_id text NOT NULL,
    dataset_revision_item_id text NOT NULL,
    dataset_revision_item_digest text NOT NULL,
    trial_index integer NOT NULL,
    truth_label text NOT NULL,
    accounting_state text DEFAULT 'pending'::text NOT NULL,
    attempt_state text DEFAULT 'not_started'::text NOT NULL,
    terminal_evaluator_outcome text,
    error_code text,
    physical_provider_calls bigint DEFAULT 0 NOT NULL,
    provider text NOT NULL,
    observed_model text,
    observed_version text,
    system_fingerprint text,
    commitment_salt text NOT NULL,
    accounted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT binary_calibration_attempts_accounting_state_check CHECK ((accounting_state = ANY (ARRAY['pending'::text, 'accounted'::text]))),
    CONSTRAINT binary_calibration_attempts_attempt_state_check CHECK ((attempt_state = ANY (ARRAY['not_started'::text, 'started'::text, 'terminal'::text]))),
    CONSTRAINT binary_calibration_attempts_check CHECK ((((accounting_state = 'pending'::text) AND (terminal_evaluator_outcome IS NULL) AND (error_code IS NULL) AND (accounted_at IS NULL)) OR ((accounting_state = 'accounted'::text) AND (terminal_evaluator_outcome IS NOT NULL) AND (accounted_at IS NOT NULL)))),
    CONSTRAINT binary_calibration_attempts_check1 CHECK (((error_code IS NULL) OR (terminal_evaluator_outcome = 'errored'::text))),
    CONSTRAINT binary_calibration_attempts_check2 CHECK (((terminal_evaluator_outcome <> 'errored'::text) OR (error_code IS NOT NULL))),
    CONSTRAINT binary_calibration_attempts_check3 CHECK (((terminal_evaluator_outcome IS NULL) OR ((terminal_evaluator_outcome = ANY (ARRAY['evaluator_pass'::text, 'evaluator_fail'::text, 'abstained'::text])) AND (attempt_state = 'terminal'::text) AND (physical_provider_calls >= 1) AND (error_code IS NULL)) OR ((terminal_evaluator_outcome = 'unevaluated'::text) AND (attempt_state = 'not_started'::text) AND (physical_provider_calls = 0) AND (error_code IS NULL)) OR ((terminal_evaluator_outcome = 'errored'::text) AND (error_code = 'outcome_unknown'::text) AND (attempt_state = 'started'::text) AND (physical_provider_calls >= 1)) OR ((terminal_evaluator_outcome = 'errored'::text) AND (error_code <> 'outcome_unknown'::text) AND (attempt_state = 'terminal'::text)))),
    CONSTRAINT binary_calibration_attempts_check4 CHECK (((physical_provider_calls > 0) OR ((observed_model IS NULL) AND (observed_version IS NULL) AND (system_fingerprint IS NULL)))),
    CONSTRAINT binary_calibration_attempts_check5 CHECK ((((observed_version IS NULL) AND (system_fingerprint IS NULL)) OR (observed_model IS NOT NULL))),
    CONSTRAINT binary_calibration_attempts_check6 CHECK (((attempt_state <> 'not_started'::text) OR ((physical_provider_calls = 0) AND (observed_model IS NULL) AND (observed_version IS NULL) AND (system_fingerprint IS NULL)))),
    CONSTRAINT binary_calibration_attempts_commitment_salt_check CHECK ((commitment_salt ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT binary_calibration_attempts_dataset_revision_item_digest_check CHECK ((dataset_revision_item_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT binary_calibration_attempts_error_code_check CHECK ((error_code = ANY (ARRAY['provider_unavailable'::text, 'provider_authentication'::text, 'provider_rate_limit'::text, 'provider_timeout'::text, 'provider_transport'::text, 'provider_protocol'::text, 'invalid_evaluator_output'::text, 'outcome_unknown'::text, 'internal'::text]))),
    CONSTRAINT binary_calibration_attempts_observed_model_check CHECK (((char_length(observed_model) <= 4096) AND (octet_length(observed_model) <= 16384))),
    CONSTRAINT binary_calibration_attempts_observed_version_check CHECK (((char_length(observed_version) <= 4096) AND (octet_length(observed_version) <= 16384))),
    CONSTRAINT binary_calibration_attempts_physical_provider_calls_check CHECK (((physical_provider_calls >= 0) AND (physical_provider_calls <= '9007199254740991'::bigint))),
    CONSTRAINT binary_calibration_attempts_provider_check CHECK (((length(provider) > 0) AND (char_length(provider) <= 4096) AND (octet_length(provider) <= 16384))),
    CONSTRAINT binary_calibration_attempts_system_fingerprint_check CHECK (((char_length(system_fingerprint) <= 4096) AND (octet_length(system_fingerprint) <= 16384))),
    CONSTRAINT binary_calibration_attempts_terminal_evaluator_outcome_check CHECK ((terminal_evaluator_outcome = ANY (ARRAY['evaluator_pass'::text, 'evaluator_fail'::text, 'abstained'::text, 'errored'::text, 'unevaluated'::text]))),
    CONSTRAINT binary_calibration_attempts_trial_index_check CHECK ((trial_index = 0)),
    CONSTRAINT binary_calibration_attempts_truth_label_check CHECK ((truth_label = ANY (ARRAY['pass'::text, 'fail'::text])))
);


--
-- Name: binary_calibration_exposure_checks; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE binary_calibration_exposure_checks (
    id text NOT NULL,
    run_id text NOT NULL,
    project_id text NOT NULL,
    phase text NOT NULL,
    exposure_state text NOT NULL,
    eligibility_result text NOT NULL,
    eligibility_reasons text[] DEFAULT '{}'::text[] NOT NULL,
    canonical_bytes bytea NOT NULL,
    snapshot_digest text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT binary_calibration_exposure_checks_canonical_bytes_check CHECK (((octet_length(canonical_bytes) >= 2) AND (octet_length(canonical_bytes) <= 4194304))),
    CONSTRAINT binary_calibration_exposure_checks_check CHECK (((eligibility_result = 'eligible'::text) = (cardinality(eligibility_reasons) = 0))),
    CONSTRAINT binary_calibration_exposure_checks_check1 CHECK (((phase <> 'authorization'::text) OR ((exposure_state = 'protected'::text) AND (eligibility_result = 'eligible'::text)))),
    CONSTRAINT binary_calibration_exposure_checks_eligibility_result_check CHECK ((eligibility_result = ANY (ARRAY['eligible'::text, 'ineligible'::text]))),
    CONSTRAINT binary_calibration_exposure_checks_exposure_state_check CHECK ((exposure_state = ANY (ARRAY['protected'::text, 'exposed'::text]))),
    CONSTRAINT binary_calibration_exposure_checks_phase_check CHECK ((phase = ANY (ARRAY['authorization'::text, 'completion'::text]))),
    CONSTRAINT binary_calibration_exposure_checks_snapshot_digest_check CHECK ((snapshot_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: binary_calibration_private_ledgers; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE binary_calibration_private_ledgers (
    id text NOT NULL,
    run_id text NOT NULL,
    project_id text NOT NULL,
    artifact_id text NOT NULL,
    contract text NOT NULL,
    canonical_bytes bytea NOT NULL,
    commitment_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT binary_calibration_private_ledgers_canonical_bytes_check CHECK (((octet_length(canonical_bytes) >= 2) AND (octet_length(canonical_bytes) <= 16777216))),
    CONSTRAINT binary_calibration_private_ledgers_commitment_digest_check CHECK ((commitment_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT binary_calibration_private_ledgers_contract_check CHECK ((contract = 'coeval/binary-calibration-private-ledger/v1'::text))
);


--
-- Name: binary_calibration_revision_leases; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE binary_calibration_revision_leases (
    dataset_revision_id text NOT NULL,
    project_id text NOT NULL,
    run_id text NOT NULL,
    lease_generation integer DEFAULT 1 NOT NULL,
    acquired_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT binary_calibration_revision_leases_lease_generation_check CHECK ((lease_generation > 0))
);


--
-- Name: binary_calibration_revocation_events; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE binary_calibration_revocation_events (
    id text NOT NULL,
    artifact_id text NOT NULL,
    run_id text NOT NULL,
    project_id text NOT NULL,
    reason text NOT NULL,
    evidence_ref_kind text NOT NULL,
    evidence_ref_id text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT binary_calibration_revocation_events_evidence_ref_id_check CHECK (((length(evidence_ref_id) > 0) AND (octet_length(evidence_ref_id) <= 4096))),
    CONSTRAINT binary_calibration_revocation_events_evidence_ref_kind_check CHECK (((length(evidence_ref_kind) > 0) AND (octet_length(evidence_ref_kind) <= 256))),
    CONSTRAINT binary_calibration_revocation_events_reason_check CHECK ((reason = ANY (ARRAY['development_exposure'::text, 'provider_policy_invalidated'::text, 'provenance_invalidated'::text, 'artifact_superseded'::text])))
);


--
-- Name: binary_calibration_runs; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE binary_calibration_runs (
    id text NOT NULL,
    project_id text NOT NULL,
    dataset_revision_id text NOT NULL,
    revision_digest text NOT NULL,
    truth_content_digest text NOT NULL,
    item_count integer NOT NULL,
    criterion_id text NOT NULL,
    criterion_version_id text NOT NULL,
    criterion_digest text NOT NULL,
    skill_id text NOT NULL,
    skill_version_id text NOT NULL,
    skill_digest text NOT NULL,
    output_contract_digest text NOT NULL,
    requested_provider text NOT NULL,
    requested_model_id text NOT NULL,
    requested_model_version text NOT NULL,
    temperature_decimal text NOT NULL,
    top_p_decimal text,
    endpoint_kind text NOT NULL,
    base_url_digest text,
    requested_binding_digest text NOT NULL,
    suite_manifest_id text,
    suite_manifest_digest text,
    suite_member_position integer,
    governed_review_batch_id text NOT NULL,
    governed_review_batch_digest text NOT NULL,
    review_instruction_version_id text NOT NULL,
    review_instruction_digest text NOT NULL,
    population_id text NOT NULL,
    population_digest text NOT NULL,
    draw_digest text NOT NULL,
    representative_of_population_id text,
    representative_ineligible_reasons text[] DEFAULT '{}'::text[] NOT NULL,
    selection_method text NOT NULL,
    positive_class text NOT NULL,
    trial_plan_kind text NOT NULL,
    trials_per_item integer NOT NULL,
    execution_environment text NOT NULL,
    provider_policy_id text NOT NULL,
    provider_policy_digest text NOT NULL,
    provider_policy_canonical_bytes bytea NOT NULL,
    payload_transmission text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    state text NOT NULL,
    planned_observations integer NOT NULL,
    accounted_observations integer DEFAULT 0 NOT NULL,
    claim_worker_id text,
    claim_token text,
    claim_expires_at timestamp with time zone,
    authorization_check_id text,
    completion_check_id text,
    artifact_id text,
    artifact_digest text,
    evidence_digest text,
    rejection_reason text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT binary_calibration_runs_artifact_digest_check CHECK ((artifact_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT binary_calibration_runs_base_url_digest_check CHECK ((base_url_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT binary_calibration_runs_check CHECK (((accounted_observations >= 0) AND (accounted_observations <= planned_observations))),
    CONSTRAINT binary_calibration_runs_check1 CHECK (((endpoint_kind = 'custom'::text) = (base_url_digest IS NOT NULL))),
    CONSTRAINT binary_calibration_runs_check2 CHECK ((((suite_manifest_id IS NULL) AND (suite_manifest_digest IS NULL) AND (suite_member_position IS NULL)) OR ((suite_manifest_id IS NOT NULL) AND (suite_manifest_digest IS NOT NULL) AND (suite_member_position IS NOT NULL)))),
    CONSTRAINT binary_calibration_runs_check3 CHECK (((representative_of_population_id IS NULL) <> (cardinality(representative_ineligible_reasons) = 0))),
    CONSTRAINT binary_calibration_runs_check4 CHECK (((claim_token IS NOT NULL) OR ((claim_worker_id IS NULL) AND (claim_expires_at IS NULL)))),
    CONSTRAINT binary_calibration_runs_check5 CHECK (((claim_token IS NULL) OR ((claim_worker_id IS NOT NULL) AND (claim_expires_at IS NOT NULL)))),
    CONSTRAINT binary_calibration_runs_check6 CHECK (((state <> ALL (ARRAY['complete'::text, 'incomplete'::text, 'rejected'::text])) OR (completed_at IS NOT NULL))),
    CONSTRAINT binary_calibration_runs_check7 CHECK (((state <> ALL (ARRAY['complete'::text, 'incomplete'::text])) OR ((artifact_id IS NOT NULL) AND (artifact_digest IS NOT NULL) AND (evidence_digest IS NOT NULL)))),
    CONSTRAINT binary_calibration_runs_check8 CHECK (((state <> 'rejected'::text) OR (rejection_reason IS NOT NULL))),
    CONSTRAINT binary_calibration_runs_criterion_digest_check CHECK ((criterion_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT binary_calibration_runs_draw_digest_check CHECK ((draw_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT binary_calibration_runs_endpoint_kind_check CHECK ((endpoint_kind = ANY (ARRAY['managed'::text, 'custom'::text]))),
    CONSTRAINT binary_calibration_runs_evidence_digest_check CHECK ((evidence_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT binary_calibration_runs_execution_environment_check CHECK ((execution_environment = ANY (ARRAY['external_provider'::text, 'self_hosted_provider'::text, 'local_provider'::text]))),
    CONSTRAINT binary_calibration_runs_governed_review_batch_digest_check CHECK ((governed_review_batch_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT binary_calibration_runs_idempotency_key_check CHECK ((length(idempotency_key) BETWEEN 1 AND 200) AND (idempotency_key = TRIM(BOTH FROM idempotency_key))),
    CONSTRAINT binary_calibration_runs_item_count_check CHECK (((item_count >= 1) AND (item_count <= 5000))),
    CONSTRAINT binary_calibration_runs_output_contract_digest_check CHECK ((output_contract_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT binary_calibration_runs_payload_transmission_check CHECK ((payload_transmission = 'sealed_payload_to_pinned_provider'::text)),
    CONSTRAINT binary_calibration_runs_planned_observations_check CHECK (((planned_observations >= 1) AND (planned_observations <= 5000))),
    CONSTRAINT binary_calibration_runs_population_digest_check CHECK ((population_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT binary_calibration_runs_population_id_check CHECK (((length(population_id) > 0) AND (octet_length(population_id) <= 4096))),
    CONSTRAINT binary_calibration_runs_positive_class_check CHECK ((positive_class = ANY (ARRAY['pass'::text, 'fail'::text]))),
    CONSTRAINT binary_calibration_runs_provider_policy_canonical_bytes_check CHECK (((octet_length(provider_policy_canonical_bytes) >= 2) AND (octet_length(provider_policy_canonical_bytes) <= 65536))),
    CONSTRAINT binary_calibration_runs_provider_policy_digest_check CHECK ((provider_policy_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT binary_calibration_runs_provider_policy_id_check CHECK (((length(provider_policy_id) > 0) AND (octet_length(provider_policy_id) <= 4096))),
    CONSTRAINT binary_calibration_runs_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT binary_calibration_runs_requested_binding_digest_check CHECK ((requested_binding_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT binary_calibration_runs_requested_model_id_check CHECK (((length(requested_model_id) > 0) AND (char_length(requested_model_id) <= 4096) AND (octet_length(requested_model_id) <= 16384))),
    CONSTRAINT binary_calibration_runs_requested_model_version_check CHECK (((length(requested_model_version) > 0) AND (char_length(requested_model_version) <= 4096) AND (octet_length(requested_model_version) <= 16384))),
    CONSTRAINT binary_calibration_runs_requested_provider_check CHECK (((length(requested_provider) > 0) AND (char_length(requested_provider) <= 4096) AND (octet_length(requested_provider) <= 16384))),
    CONSTRAINT binary_calibration_runs_review_instruction_digest_check CHECK ((review_instruction_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT binary_calibration_runs_revision_digest_check CHECK ((revision_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT binary_calibration_runs_selection_method_check CHECK ((selection_method = ANY (ARRAY['simple_random'::text, 'systematic'::text, 'stratified_random'::text, 'convenience'::text, 'uncertainty'::text, 'failure_hunting'::text, 'manual'::text]))),
    CONSTRAINT binary_calibration_runs_skill_digest_check CHECK ((skill_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT binary_calibration_runs_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'running'::text, 'recovery_required'::text, 'complete'::text, 'incomplete'::text, 'rejected'::text]))),
    CONSTRAINT binary_calibration_runs_suite_manifest_digest_check CHECK ((suite_manifest_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT binary_calibration_runs_suite_member_position_check CHECK (((suite_member_position >= 0) AND (suite_member_position <= 99))),
    CONSTRAINT binary_calibration_runs_temperature_decimal_check CHECK ((temperature_decimal ~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'::text)),
    CONSTRAINT binary_calibration_runs_top_p_decimal_check CHECK ((top_p_decimal ~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'::text)),
    CONSTRAINT binary_calibration_runs_trial_plan_kind_check CHECK ((trial_plan_kind = 'single'::text)),
    CONSTRAINT binary_calibration_runs_trials_per_item_check CHECK ((trials_per_item = 1)),
    CONSTRAINT binary_calibration_runs_truth_content_digest_check CHECK ((truth_content_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: case_input_identity_records; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE case_input_identity_records (
    id text NOT NULL,
    project_id text NOT NULL,
    source_case_id text NOT NULL,
    record_kind text NOT NULL,
    identity_basis text NOT NULL,
    input_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT case_input_identity_records_identity_basis_check CHECK ((identity_basis = ANY (ARRAY['input-identity/v1'::text, 'redacted-input-identity/v1'::text]))),
    CONSTRAINT case_input_identity_records_input_digest_check CHECK ((input_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT case_input_identity_records_record_kind_check CHECK ((record_kind = ANY (ARRAY['authoring_import'::text, 'identity_resolved'::text, 'sealed_intake'::text])))
);


--
-- Name: cases; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE cases (
    id text NOT NULL,
    project_id text NOT NULL,
    raw_trace_id text,
    case_type text NOT NULL,
    normalized_payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ingestion_purpose text NOT NULL,
    CONSTRAINT cases_ingestion_purpose_check CHECK ((ingestion_purpose = ANY (ARRAY['analysis_eligible_manual'::text, 'analysis_eligible_langsmith'::text, 'analysis_eligible_langfuse'::text, 'analysis_eligible_ironside'::text, 'judge_api'::text, 'judge_batch_general'::text, 'dataset_example'::text, 'trace_test_synthetic'::text, 'release_evidence'::text]))),
    CONSTRAINT cases_ingestion_purpose_shape_check CHECK ((((ingestion_purpose = 'analysis_eligible_manual'::text) AND (case_type = 'manual'::text) AND (raw_trace_id IS NOT NULL)) OR ((ingestion_purpose = 'analysis_eligible_langsmith'::text) AND (case_type = 'langsmith'::text) AND (raw_trace_id IS NOT NULL)) OR ((ingestion_purpose = 'analysis_eligible_langfuse'::text) AND (case_type = 'langfuse'::text) AND (raw_trace_id IS NOT NULL)) OR ((ingestion_purpose = 'analysis_eligible_ironside'::text) AND (case_type = 'ironside'::text) AND (raw_trace_id IS NOT NULL)) OR ((ingestion_purpose = ANY (ARRAY['judge_api'::text, 'judge_batch_general'::text, 'dataset_example'::text, 'trace_test_synthetic'::text])) AND (case_type = 'manual'::text) AND (raw_trace_id IS NOT NULL)) OR ((ingestion_purpose = 'release_evidence'::text) AND (case_type = 'release_evidence'::text))))
);


--
-- Name: criteria; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE criteria (
    id text NOT NULL,
    project_id text NOT NULL,
    stable_key text NOT NULL,
    source_kind text NOT NULL,
    created_by_user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT criteria_source_kind_check CHECK ((source_kind = ANY (ARRAY['native'::text, 'analysis_promotion'::text]))),
    CONSTRAINT criteria_stable_key_check CHECK (((length(stable_key) > 0) AND (stable_key = TRIM(BOTH FROM stable_key))))
);


--
-- Name: criterion_regression_revisions; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE criterion_regression_revisions (
    project_id text NOT NULL,
    criterion_version_id text NOT NULL,
    revision_id text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: criterion_versions; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE criterion_versions (
    id text NOT NULL,
    project_id text NOT NULL,
    criterion_id text NOT NULL,
    revision integer NOT NULL,
    name text NOT NULL,
    definition text NOT NULL,
    criterion_digest text NOT NULL,
    source_kind text NOT NULL,
    created_by_user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT criterion_versions_criterion_digest_check CHECK ((criterion_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT criterion_versions_definition_check CHECK (((length(definition) > 0) AND (definition = TRIM(BOTH FROM definition)))),
    CONSTRAINT criterion_versions_name_check CHECK (((length(name) > 0) AND (name = TRIM(BOTH FROM name)))),
    CONSTRAINT criterion_versions_revision_check CHECK ((revision > 0)),
    CONSTRAINT criterion_versions_source_kind_check CHECK ((source_kind = ANY (ARRAY['native'::text, 'analysis_promotion'::text])))
);


--
-- Name: dataset_exposure_events; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE dataset_exposure_events (
    id text NOT NULL,
    project_id text NOT NULL,
    revision_id text NOT NULL,
    revision_item_id text,
    kind text NOT NULL,
    exposure_class text NOT NULL,
    activity text NOT NULL,
    subject_kind text NOT NULL,
    subject_id text,
    actor_user_id text,
    evidence_ref_kind text,
    evidence_ref_id text,
    reason text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    idempotency_key text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dataset_exposure_events_activity_check CHECK ((activity = ANY (ARRAY['revision_create'::text, 'legacy_import'::text, 'content_view'::text, 'export'::text, 'analysis_authoring'::text, 'criterion_authoring'::text, 'rubric_authoring'::text, 'prompt_tuning'::text, 'example_selection'::text, 'model_selection'::text, 'development_run'::text, 'final_validation_run'::text, 'regression_run'::text, 'declassify'::text, 'supersede'::text, 'exact_overlap'::text]))),
    CONSTRAINT dataset_exposure_events_exposure_class_check CHECK ((exposure_class = ANY (ARRAY['lineage'::text, 'provenance'::text, 'development'::text]))),
    CONSTRAINT dataset_exposure_events_kind_check CHECK ((kind = ANY (ARRAY['created'::text, 'legacy_pretracking'::text, 'human_access'::text, 'evaluator_execution'::text, 'development_use'::text, 'declassification'::text, 'superseded'::text, 'overlap_detected'::text, 'exported'::text]))),
    CONSTRAINT dataset_exposure_events_subject_kind_check CHECK ((subject_kind = ANY (ARRAY['person'::text, 'api_key'::text, 'evaluator_version'::text, 'activity'::text, 'system'::text])))
);


--
-- Name: dataset_items; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE dataset_items (
    id text NOT NULL,
    dataset_id text NOT NULL,
    project_id text NOT NULL,
    case_id text NOT NULL,
    trace_id text NOT NULL,
    expected_label text,
    note text,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    expected_fail_step integer
);


--
-- Name: dataset_revision_items; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE dataset_revision_items (
    id text NOT NULL,
    revision_id text NOT NULL,
    project_id text NOT NULL,
    "position" integer NOT NULL,
    source_case_id text,
    source_trace_id text,
    source_dataset_item_id text,
    source_golden_entry_id text,
    input_digest text NOT NULL,
    item_digest text NOT NULL,
    payload_snapshot jsonb NOT NULL,
    reference_label text,
    reference_fail_step integer,
    reference_provenance jsonb NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dataset_revision_items_input_digest_check CHECK ((input_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT dataset_revision_items_item_digest_check CHECK ((item_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT dataset_revision_items_position_check CHECK (("position" >= 0)),
    CONSTRAINT dataset_revision_items_reference_fail_step_check CHECK ((reference_fail_step >= 0)),
    CONSTRAINT dataset_revision_items_reference_label_check CHECK ((reference_label = ANY (ARRAY['pass'::text, 'fail'::text])))
);


--
-- Name: dataset_revisions; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE dataset_revisions (
    id text NOT NULL,
    project_id text NOT NULL,
    series_id text NOT NULL,
    revision_number integer NOT NULL,
    source_dataset_id text,
    parent_revision_id text,
    role text NOT NULL,
    source_kind text NOT NULL,
    identity_basis text NOT NULL,
    content_digest text NOT NULL,
    revision_digest text NOT NULL,
    item_count integer NOT NULL,
    provenance_level text NOT NULL,
    created_by_user_id text,
    idempotency_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    criterion_version_id text,
    analysis_population_id text,
    CONSTRAINT dataset_revisions_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT dataset_revisions_identity_basis_check CHECK ((identity_basis = 'input-identity/v1'::text)),
    CONSTRAINT dataset_revisions_item_count_check CHECK ((item_count >= 0)),
    CONSTRAINT dataset_revisions_provenance_level_check CHECK ((provenance_level = ANY (ARRAY['legacy'::text, 'unverified'::text, 'reviewed_unblinded'::text, 'governed_blind'::text, 'imported_self_attested'::text, 'imported_verified_attested'::text]))),
    CONSTRAINT dataset_revisions_regression_criterion_check CHECK (((role <> 'regression_golden'::text) OR (criterion_version_id IS NOT NULL))),
    CONSTRAINT dataset_revisions_revision_digest_check CHECK ((revision_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT dataset_revisions_revision_number_check CHECK ((revision_number > 0)),
    CONSTRAINT dataset_revisions_role_check CHECK ((role = ANY (ARRAY['analysis_authoring'::text, 'iterative_development'::text, 'sealed_validation'::text, 'regression_golden'::text]))),
    CONSTRAINT dataset_revisions_source_kind_check CHECK ((source_kind = ANY (ARRAY['collection_snapshot'::text, 'golden_snapshot'::text, 'sealed_intake'::text, 'analysis_population'::text])))
);


--
-- Name: datasets; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE datasets (
    id text NOT NULL,
    project_id text NOT NULL,
    name text NOT NULL,
    description text,
    kind text DEFAULT 'custom'::text NOT NULL,
    created_by_user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT datasets_kind_check CHECK ((kind = ANY (ARRAY['custom'::text, 'adhoc'::text])))
);


--
-- Name: eval_run_items; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE eval_run_items (
    id text NOT NULL,
    eval_run_id text NOT NULL,
    project_id text NOT NULL,
    dataset_item_id text,
    case_id text NOT NULL,
    status text NOT NULL,
    verdict_id text,
    expected_label text,
    result_label text,
    agreement boolean,
    latency_ms integer,
    cost_usd numeric(12,6),
    input_tokens integer,
    output_tokens integer,
    cached boolean DEFAULT false NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    expected_fail_step integer,
    failing_step integer,
    client_item_id text,
    content_digest text,
    provider_metadata jsonb,
    dataset_revision_item_id text,
    queue_job_id uuid,
    delivery_deadline_at timestamp with time zone,
    execution_token text,
    execution_claimed_at timestamp with time zone,
    provider_call_started_at timestamp with time zone,
    provider_call_returned_at timestamp with time zone,
    CONSTRAINT eval_run_items_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text, 'skipped'::text])))
);


--
-- Name: eval_runs; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE eval_runs (
    id text NOT NULL,
    project_id text NOT NULL,
    dataset_id text,
    skill_version_id text NOT NULL,
    trigger text NOT NULL,
    status text NOT NULL,
    blocking boolean DEFAULT false NOT NULL,
    total_items integer NOT NULL,
    completed_items integer DEFAULT 0 NOT NULL,
    failed_items integer DEFAULT 0 NOT NULL,
    agreed_items integer DEFAULT 0 NOT NULL,
    created_by_user_id text,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    source_trace_test_id text,
    source_trace_test_revision integer,
    source_trace_test_validation_id text,
    source_trace_test_validation_revision integer,
    source_trace_test_case_ref text,
    source_trace_test_case_id text,
    source_trace_test_dataset_item_id text,
    dataset_revision_id text,
    convergence_case_id text,
    ingestion_case_id text,
    queue_job_id uuid,
    queue_dispatch_token text,
    queue_dispatch_claimed_at timestamp with time zone,
    queue_dispatched_at timestamp with time zone,
    CONSTRAINT eval_runs_source_trace_test_revision_check CHECK ((((source_trace_test_revision IS NULL) OR (source_trace_test_revision > 0)) AND ((source_trace_test_validation_revision IS NULL) OR (source_trace_test_validation_revision > 0)))),
    CONSTRAINT eval_runs_source_trace_test_shape_check CHECK ((((source_trace_test_id IS NULL) AND (source_trace_test_revision IS NULL) AND (source_trace_test_validation_id IS NULL) AND (source_trace_test_validation_revision IS NULL) AND (source_trace_test_case_ref IS NULL) AND (source_trace_test_case_id IS NULL) AND (source_trace_test_dataset_item_id IS NULL)) OR ((source_trace_test_id IS NOT NULL) AND (source_trace_test_revision IS NOT NULL) AND (source_trace_test_validation_id IS NOT NULL) AND (source_trace_test_validation_revision IS NOT NULL) AND (source_trace_test_case_ref IS NOT NULL) AND (source_trace_test_case_id IS NOT NULL) AND (source_trace_test_dataset_item_id IS NOT NULL)))),
    CONSTRAINT eval_runs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text, 'canceled'::text]))),
    CONSTRAINT eval_runs_trigger_check CHECK ((trigger = ANY (ARRAY['manual'::text, 'api_batch'::text, 'backfill'::text, 'regression_gate'::text, 'product_gate'::text, 'release_evidence'::text])))
);


--
-- Name: evaluator_execution_authorizations; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE evaluator_execution_authorizations (
    id text NOT NULL,
    contract_version text NOT NULL,
    project_id text NOT NULL,
    skill_version_id text NOT NULL,
    execution_context text NOT NULL,
    lifecycle_event_id text,
    calibration_artifact_id text,
    resource_kind text NOT NULL,
    resource_id text NOT NULL,
    idempotency_key text NOT NULL,
    content_digest text NOT NULL,
    authorized_at timestamp with time zone DEFAULT date_trunc('milliseconds'::text, clock_timestamp()) NOT NULL,
    CONSTRAINT evaluator_execution_authorizations_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT evaluator_execution_authorizations_contract_version_check CHECK ((contract_version = 'coeval/evaluator-execution-authorization/v1'::text)),
    CONSTRAINT evaluator_execution_authorizations_execution_context_check CHECK ((execution_context = ANY (ARRAY['implicit_production'::text, 'manual_import'::text, 'scheduled_import'::text, 'suite_publication'::text, 'trace_test'::text, 'release_gate'::text, 'explicit_nonproduction_dataset'::text, 'governed_nonsealed_evaluation'::text, 'binary_calibration_evidence'::text, 'candidate_regression_evidence'::text]))),
    CONSTRAINT evaluator_execution_authorizations_idempotency_key_check CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 240))),
    CONSTRAINT evaluator_execution_authorizations_resource_id_check CHECK (((char_length(resource_id) >= 1) AND (char_length(resource_id) <= 4096))),
    CONSTRAINT evaluator_execution_authorizations_resource_kind_check CHECK (((char_length(resource_kind) >= 1) AND (char_length(resource_kind) <= 120)))
);


--
-- Name: evaluator_suite_manifest_members; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE evaluator_suite_manifest_members (
    manifest_id text NOT NULL,
    suite_id text NOT NULL,
    project_id text NOT NULL,
    "position" integer NOT NULL,
    criterion_id text NOT NULL,
    criterion_version_id text NOT NULL,
    criterion_name text NOT NULL,
    criterion_definition text NOT NULL,
    criterion_digest text NOT NULL,
    skill_id text NOT NULL,
    skill_version_id text NOT NULL,
    skill_digest text NOT NULL,
    output_contract_digest text NOT NULL,
    applicability jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT evaluator_suite_manifest_members_applicability_check CHECK ((applicability = '{"kind": "all_items"}'::jsonb)),
    CONSTRAINT evaluator_suite_manifest_members_criterion_definition_check CHECK ((length(TRIM(BOTH FROM criterion_definition)) > 0)),
    CONSTRAINT evaluator_suite_manifest_members_criterion_digest_check CHECK ((criterion_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT evaluator_suite_manifest_members_criterion_name_check CHECK ((length(TRIM(BOTH FROM criterion_name)) > 0)),
    CONSTRAINT evaluator_suite_manifest_members_output_contract_digest_check CHECK ((output_contract_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT evaluator_suite_manifest_members_position_check CHECK (("position" >= 0)),
    CONSTRAINT evaluator_suite_manifest_members_skill_digest_check CHECK ((skill_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: evaluator_suite_manifests; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE evaluator_suite_manifests (
    id text NOT NULL,
    suite_id text NOT NULL,
    project_id text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    revision integer NOT NULL,
    contract text NOT NULL,
    schema_version integer NOT NULL,
    member_count integer NOT NULL,
    trial_plan jsonb NOT NULL,
    canonical_bytes bytea NOT NULL,
    artifact_digest text NOT NULL,
    manifest_digest text NOT NULL,
    created_by_user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT evaluator_suite_manifests_artifact_digest_check CHECK ((artifact_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT evaluator_suite_manifests_canonical_bytes_check CHECK ((octet_length(canonical_bytes) > 0)),
    CONSTRAINT evaluator_suite_manifests_contract_check CHECK ((contract = 'coeval/evaluator-suite-manifest/v1'::text)),
    CONSTRAINT evaluator_suite_manifests_idempotency_key_check CHECK ((length(idempotency_key) BETWEEN 1 AND 200) AND (idempotency_key = TRIM(BOTH FROM idempotency_key))),
    CONSTRAINT evaluator_suite_manifests_manifest_digest_check CHECK ((manifest_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT evaluator_suite_manifests_member_count_check CHECK ((member_count > 0)),
    CONSTRAINT evaluator_suite_manifests_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT evaluator_suite_manifests_revision_check CHECK ((revision > 0)),
    CONSTRAINT evaluator_suite_manifests_schema_version_check CHECK ((schema_version = 1)),
    CONSTRAINT evaluator_suite_manifests_trial_plan_check CHECK (((trial_plan = 'null'::jsonb) OR ((jsonb_typeof(trial_plan) = 'object'::text) AND ((trial_plan ->> 'kind'::text) = 'independent_repetitions'::text) AND (jsonb_typeof((trial_plan -> 'trialsPerItem'::text)) = 'number'::text) AND ((((trial_plan ->> 'trialsPerItem'::text))::integer >= 2) AND (((trial_plan ->> 'trialsPerItem'::text))::integer <= 10)) AND (trial_plan = jsonb_build_object('kind', 'independent_repetitions', 'trialsPerItem', ((trial_plan ->> 'trialsPerItem'::text))::integer)))))
);


--
-- Name: evaluator_suites; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE evaluator_suites (
    id text NOT NULL,
    project_id text NOT NULL,
    created_by_user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: feedback_sync_jobs; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE feedback_sync_jobs (
    id text NOT NULL,
    project_id text NOT NULL,
    judge_run_id text NOT NULL,
    provider text NOT NULL,
    status text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: gate_check_items; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE gate_check_items (
    id text NOT NULL,
    gate_check_id text NOT NULL,
    project_id text NOT NULL,
    golden_entry_id text NOT NULL,
    golden_case_id text NOT NULL,
    candidate_case_id text NOT NULL,
    case_key text NOT NULL,
    expected_label text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT gate_check_items_expected_label_check CHECK ((expected_label = ANY (ARRAY['pass'::text, 'fail'::text])))
);


--
-- Name: gate_checks; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE gate_checks (
    id text NOT NULL,
    project_id text NOT NULL,
    skill_version_id text NOT NULL,
    eval_run_id text NOT NULL,
    label text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    max_disagreements integer DEFAULT 0 NOT NULL,
    created_by_user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT gate_checks_max_disagreements_check CHECK ((max_disagreements >= 0))
);


--
-- Name: golden_set_entries; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE golden_set_entries (
    id text NOT NULL,
    project_id text NOT NULL,
    case_id text NOT NULL,
    trace_id text NOT NULL,
    agreed_label text NOT NULL,
    reason text NOT NULL,
    promoted_by_user_id text,
    promoted_by text DEFAULT 'Unknown'::text NOT NULL,
    source_skill_version_id text NOT NULL,
    promoted_at timestamp with time zone DEFAULT now() NOT NULL,
    retired_at timestamp with time zone,
    criterion_version_id text NOT NULL
);


--
-- Name: governed_review_labels; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE governed_review_labels (
    id text NOT NULL,
    project_id text NOT NULL,
    task_id text NOT NULL,
    reviewer_subject_id text NOT NULL,
    attempt integer NOT NULL,
    label text NOT NULL,
    rationale text NOT NULL,
    failure_codes text[] DEFAULT '{}'::text[] NOT NULL,
    blind_view_digest text NOT NULL,
    replaces_label_id text,
    content_digest text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT governed_review_labels_attempt_check CHECK ((attempt > 0)),
    CONSTRAINT governed_review_labels_blind_view_digest_check CHECK ((blind_view_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_labels_check CHECK ((((attempt = 1) AND (replaces_label_id IS NULL)) OR ((attempt > 1) AND (replaces_label_id IS NOT NULL)))),
    CONSTRAINT governed_review_labels_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_labels_failure_codes_check CHECK (governed_nonempty_text_array(failure_codes)),
    CONSTRAINT governed_review_labels_failure_codes_check1 CHECK (governed_bounded_text_array(failure_codes, 100, 1024, 65536)),
    CONSTRAINT governed_review_labels_idempotency_key_check CHECK (((length(idempotency_key) > 0) AND (octet_length(idempotency_key) <= 1024))),
    CONSTRAINT governed_review_labels_label_check CHECK ((label = ANY (ARRAY['pass'::text, 'fail'::text, 'cannot_determine'::text]))),
    CONSTRAINT governed_review_labels_rationale_check CHECK (((length(rationale) > 0) AND (octet_length(rationale) <= 32768))),
    CONSTRAINT governed_review_labels_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: governed_review_task_events; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE governed_review_task_events (
    id text NOT NULL,
    project_id text NOT NULL,
    task_id text NOT NULL,
    sequence integer NOT NULL,
    state_version integer NOT NULL,
    expected_previous_state_version integer NOT NULL,
    event_kind text NOT NULL,
    actor_subject_id text,
    actor_role_at_review text,
    label_id text,
    canonical_view_bytes_base64 text,
    view_digest text,
    view_contract_version text,
    canonicalization_version text,
    exposure_class text,
    activity text,
    reason text,
    previous_event_digest text,
    event_digest text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT governed_review_task_events_activity_check CHECK ((activity = 'governed_review'::text)),
    CONSTRAINT governed_review_task_events_actor_role_at_review_check CHECK (((actor_role_at_review IS NULL) OR ((length(actor_role_at_review) > 0) AND (octet_length(actor_role_at_review) <= 256)))),
    CONSTRAINT governed_review_task_events_check CHECK ((((event_kind = 'viewed'::text) AND (canonical_view_bytes_base64 IS NOT NULL) AND (octet_length(canonical_view_bytes_base64) <= 2796204) AND (view_digest IS NOT NULL) AND (view_contract_version IS NOT NULL) AND (canonicalization_version IS NOT NULL) AND (exposure_class = 'provenance'::text) AND (activity = 'governed_review'::text)) OR ((event_kind <> 'viewed'::text) AND (canonical_view_bytes_base64 IS NULL) AND (view_digest IS NULL) AND (view_contract_version IS NULL) AND (canonicalization_version IS NULL) AND (exposure_class IS NULL) AND (activity IS NULL)))),
    CONSTRAINT governed_review_task_events_check1 CHECK ((((event_kind = ANY (ARRAY['label_submitted'::text, 'label_withdrawn'::text])) AND (label_id IS NOT NULL)) OR ((event_kind <> ALL (ARRAY['label_submitted'::text, 'label_withdrawn'::text])) AND (label_id IS NULL)))),
    CONSTRAINT governed_review_task_events_check2 CHECK (((event_kind <> 'deferred'::text) OR ((reason IS NOT NULL) AND (length(reason) > 0)))),
    CONSTRAINT governed_review_task_events_event_digest_check CHECK ((event_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_task_events_event_kind_check CHECK ((event_kind = ANY (ARRAY['viewed'::text, 'deferred'::text, 'resumed'::text, 'label_submitted'::text, 'label_withdrawn'::text, 'expired'::text]))),
    CONSTRAINT governed_review_task_events_expected_previous_state_versi_check CHECK ((expected_previous_state_version >= 0)),
    CONSTRAINT governed_review_task_events_exposure_class_check CHECK ((exposure_class = 'provenance'::text)),
    CONSTRAINT governed_review_task_events_idempotency_key_check CHECK (((length(idempotency_key) > 0) AND (octet_length(idempotency_key) <= 1024))),
    CONSTRAINT governed_review_task_events_previous_event_digest_check CHECK ((previous_event_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_task_events_reason_check CHECK (((reason IS NULL) OR (octet_length(reason) <= 32768))),
    CONSTRAINT governed_review_task_events_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_task_events_sequence_check CHECK ((sequence > 0)),
    CONSTRAINT governed_review_task_events_state_version_check CHECK ((state_version > 0)),
    CONSTRAINT governed_review_task_events_view_digest_check CHECK ((view_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: governed_review_tasks; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE governed_review_tasks (
    id text NOT NULL,
    project_id text NOT NULL,
    batch_id text NOT NULL,
    batch_item_id text NOT NULL,
    reviewer_subject_id text NOT NULL,
    reviewer_role_at_review text NOT NULL,
    serve_order integer NOT NULL,
    content_digest text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT governed_review_tasks_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_tasks_idempotency_key_check CHECK (((length(idempotency_key) > 0) AND (octet_length(idempotency_key) <= 1024))),
    CONSTRAINT governed_review_tasks_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_tasks_reviewer_role_at_review_check CHECK (((length(reviewer_role_at_review) > 0) AND (octet_length(reviewer_role_at_review) <= 256))),
    CONSTRAINT governed_review_tasks_serve_order_check CHECK (((serve_order >= 0) AND (serve_order <= 200000)))
);


--
-- Name: governed_active_review_labels; Type: VIEW; Schema: current; Owner: -
--

CREATE VIEW governed_active_review_labels AS
 SELECT task.project_id,
    task.batch_id,
    task.batch_item_id,
    task.id AS task_id,
    event.label_id,
    label.label,
    label.reviewer_subject_id
   FROM ((governed_review_tasks task
     JOIN LATERAL ( SELECT candidate.event_kind,
            candidate.label_id
           FROM governed_review_task_events candidate
          WHERE (candidate.task_id = task.id)
          ORDER BY candidate.state_version DESC
         LIMIT 1) event ON ((event.event_kind = 'label_submitted'::text)))
     JOIN governed_review_labels label ON ((label.id = event.label_id)));


--
-- Name: governed_dataset_truth_link_labels; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE governed_dataset_truth_link_labels (
    project_id text NOT NULL,
    truth_link_id text NOT NULL,
    label_id text NOT NULL
);


--
-- Name: governed_dataset_truth_links; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE governed_dataset_truth_links (
    id text NOT NULL,
    project_id text NOT NULL,
    dataset_revision_id text NOT NULL,
    dataset_revision_item_id text NOT NULL,
    criterion_version_id text NOT NULL,
    source_kind text NOT NULL,
    batch_item_id text,
    governed_label_ids text[] DEFAULT '{}'::text[] NOT NULL,
    adjudication_id text,
    imported_truth_id text,
    resolution_kind text NOT NULL,
    resolved_label text NOT NULL,
    supporting_label_count integer NOT NULL,
    content_digest text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT governed_dataset_truth_links_check CHECK ((((source_kind = 'governed_labels'::text) AND (batch_item_id IS NOT NULL) AND (cardinality(governed_label_ids) > 0) AND (adjudication_id IS NULL) AND (imported_truth_id IS NULL) AND (resolution_kind = ANY (ARRAY['single_rater'::text, 'unanimous'::text]))) OR ((source_kind = 'adjudication'::text) AND (batch_item_id IS NOT NULL) AND (cardinality(governed_label_ids) = 0) AND (adjudication_id IS NOT NULL) AND (imported_truth_id IS NULL) AND (resolution_kind = 'adjudicated'::text)) OR ((source_kind = 'imported_truth'::text) AND (batch_item_id IS NULL) AND (cardinality(governed_label_ids) = 0) AND (adjudication_id IS NULL) AND (imported_truth_id IS NOT NULL) AND (supporting_label_count = 0) AND (resolution_kind = ANY (ARRAY['imported_self_attested'::text, 'imported_verified_attested'::text, 'imported_unverified'::text]))))),
    CONSTRAINT governed_dataset_truth_links_check1 CHECK (((resolution_kind = 'adjudicated'::text) = (adjudication_id IS NOT NULL))),
    CONSTRAINT governed_dataset_truth_links_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_dataset_truth_links_governed_label_ids_check CHECK (governed_nonempty_text_array(governed_label_ids)),
    CONSTRAINT governed_dataset_truth_links_governed_label_ids_check1 CHECK (governed_bounded_text_array(governed_label_ids, 20, 256, 4096)),
    CONSTRAINT governed_dataset_truth_links_idempotency_key_check CHECK (((length(idempotency_key) > 0) AND (octet_length(idempotency_key) <= 1024))),
    CONSTRAINT governed_dataset_truth_links_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_dataset_truth_links_resolution_kind_check CHECK ((resolution_kind = ANY (ARRAY['single_rater'::text, 'unanimous'::text, 'adjudicated'::text, 'imported_self_attested'::text, 'imported_verified_attested'::text, 'imported_unverified'::text]))),
    CONSTRAINT governed_dataset_truth_links_resolved_label_check CHECK ((resolved_label = ANY (ARRAY['pass'::text, 'fail'::text]))),
    CONSTRAINT governed_dataset_truth_links_source_kind_check CHECK ((source_kind = ANY (ARRAY['governed_labels'::text, 'adjudication'::text, 'imported_truth'::text]))),
    CONSTRAINT governed_dataset_truth_links_supporting_label_count_check CHECK ((supporting_label_count >= 0))
);


--
-- Name: governed_evaluator_development_events; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE governed_evaluator_development_events (
    id text NOT NULL,
    project_id text NOT NULL,
    criterion_version_id text NOT NULL,
    skill_version_id text NOT NULL,
    developer_subject_id text NOT NULL,
    developer_role_at_recording text NOT NULL,
    activity_kind text NOT NULL,
    source_kind text NOT NULL,
    content_digest text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT governed_evaluator_developmen_developer_role_at_recording_check CHECK ((length(developer_role_at_recording) > 0)),
    CONSTRAINT governed_evaluator_development_events_activity_kind_check CHECK ((activity_kind = 'evaluator_development'::text)),
    CONSTRAINT governed_evaluator_development_events_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_evaluator_development_events_source_kind_check CHECK ((source_kind = 'system_recorded'::text))
);


--
-- Name: governed_imported_truth; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE governed_imported_truth (
    id text NOT NULL,
    project_id text NOT NULL,
    criterion_version_id text NOT NULL,
    issuer text NOT NULL,
    subject text NOT NULL,
    source_artifact_bytes bytea NOT NULL,
    source_artifact_digest text NOT NULL,
    transport_provenance jsonb,
    verification_method text NOT NULL,
    verification_evidence jsonb,
    instructions_provenance jsonb,
    rater_provenance jsonb,
    adjudication_provenance jsonb,
    blind_attestation jsonb,
    identity_basis text NOT NULL,
    input_digest text NOT NULL,
    payload_snapshot jsonb NOT NULL,
    label text NOT NULL,
    rationale text NOT NULL,
    failure_codes text[] DEFAULT '{}'::text[] NOT NULL,
    evidence_class text NOT NULL,
    provenance_digest text NOT NULL,
    content_digest text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT governed_imported_truth_check CHECK (((COALESCE(octet_length((transport_provenance)::text), 0) <= 262144) AND (COALESCE(octet_length((verification_evidence)::text), 0) <= 262144) AND (COALESCE(octet_length((instructions_provenance)::text), 0) <= 262144) AND (COALESCE(octet_length((rater_provenance)::text), 0) <= 262144) AND (COALESCE(octet_length((adjudication_provenance)::text), 0) <= 262144) AND (COALESCE(octet_length((blind_attestation)::text), 0) <= 262144))),
    CONSTRAINT governed_imported_truth_check1 CHECK (((evidence_class <> 'imported_self_attested'::text) OR ((verification_method = 'self_attested'::text) AND (transport_provenance IS NOT NULL) AND (transport_provenance <> 'null'::jsonb) AND (instructions_provenance IS NOT NULL) AND (instructions_provenance <> 'null'::jsonb) AND (rater_provenance IS NOT NULL) AND (rater_provenance <> 'null'::jsonb) AND (adjudication_provenance IS NOT NULL) AND (adjudication_provenance <> 'null'::jsonb) AND (blind_attestation IS NOT NULL) AND (blind_attestation <> 'null'::jsonb)))),
    CONSTRAINT governed_imported_truth_check2 CHECK (((evidence_class <> 'imported_verified_attested'::text) OR ((verification_method = ANY (ARRAY['verified_signature'::text, 'independently_verified_transport'::text])) AND (verification_evidence IS NOT NULL) AND (verification_evidence <> 'null'::jsonb) AND (transport_provenance IS NOT NULL) AND (transport_provenance <> 'null'::jsonb) AND (instructions_provenance IS NOT NULL) AND (instructions_provenance <> 'null'::jsonb) AND (rater_provenance IS NOT NULL) AND (rater_provenance <> 'null'::jsonb) AND (adjudication_provenance IS NOT NULL) AND (adjudication_provenance <> 'null'::jsonb) AND (blind_attestation IS NOT NULL) AND (blind_attestation <> 'null'::jsonb)))),
    CONSTRAINT governed_imported_truth_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_imported_truth_evidence_class_check CHECK ((evidence_class = ANY (ARRAY['unverified'::text, 'imported_self_attested'::text, 'imported_verified_attested'::text]))),
    CONSTRAINT governed_imported_truth_evidence_class_check1 CHECK ((evidence_class <> 'imported_verified_attested'::text)),
    CONSTRAINT governed_imported_truth_failure_codes_check CHECK (governed_nonempty_text_array(failure_codes)),
    CONSTRAINT governed_imported_truth_failure_codes_check1 CHECK (governed_bounded_text_array(failure_codes, 100, 1024, 65536)),
    CONSTRAINT governed_imported_truth_idempotency_key_check CHECK (((length(idempotency_key) > 0) AND (octet_length(idempotency_key) <= 1024))),
    CONSTRAINT governed_imported_truth_identity_basis_check CHECK ((identity_basis = 'input-identity/v1'::text)),
    CONSTRAINT governed_imported_truth_input_digest_check CHECK ((input_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_imported_truth_issuer_check CHECK (((length(issuer) > 0) AND (octet_length(issuer) <= 4096))),
    CONSTRAINT governed_imported_truth_label_check CHECK ((label = ANY (ARRAY['pass'::text, 'fail'::text, 'cannot_determine'::text]))),
    CONSTRAINT governed_imported_truth_payload_snapshot_check CHECK ((octet_length((payload_snapshot)::text) <= 2097152)),
    CONSTRAINT governed_imported_truth_provenance_digest_check CHECK ((provenance_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_imported_truth_rationale_check CHECK (((length(rationale) > 0) AND (octet_length(rationale) <= 32768))),
    CONSTRAINT governed_imported_truth_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_imported_truth_source_artifact_bytes_check CHECK ((octet_length(source_artifact_bytes) <= 10485760)),
    CONSTRAINT governed_imported_truth_source_artifact_digest_check CHECK ((source_artifact_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_imported_truth_subject_check CHECK (((length(subject) > 0) AND (octet_length(subject) <= 4096))),
    CONSTRAINT governed_imported_truth_verification_method_check CHECK ((verification_method = ANY (ARRAY['none'::text, 'self_attested'::text, 'verified_signature'::text, 'independently_verified_transport'::text])))
);


--
-- Name: governed_input_identity_claims; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE governed_input_identity_claims (
    project_id text NOT NULL,
    input_digest text NOT NULL,
    usage_class text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT governed_input_identity_claims_input_digest_check CHECK ((input_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_input_identity_claims_usage_class_check CHECK ((usage_class = ANY (ARRAY['nonsealed'::text, 'sealed'::text])))
);


--
-- Name: governed_review_adjudication_labels; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE governed_review_adjudication_labels (
    project_id text NOT NULL,
    adjudication_id text NOT NULL,
    label_id text NOT NULL
);


--
-- Name: governed_review_adjudications; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE governed_review_adjudications (
    id text NOT NULL,
    project_id text NOT NULL,
    batch_id text NOT NULL,
    batch_item_id text NOT NULL,
    chain_version integer NOT NULL,
    expected_previous_chain_version integer NOT NULL,
    supersedes_adjudication_id text,
    adjudicator_subject_id text NOT NULL,
    adjudicator_role_at_review text NOT NULL,
    decision text NOT NULL,
    rationale text NOT NULL,
    basis text NOT NULL,
    correction_reason text,
    considered_label_count integer NOT NULL,
    considered_label_set_digest text NOT NULL,
    content_digest text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT governed_review_adjudication_expected_previous_chain_vers_check CHECK ((expected_previous_chain_version >= 0)),
    CONSTRAINT governed_review_adjudications_adjudicator_role_at_review_check CHECK (((length(adjudicator_role_at_review) > 0) AND (octet_length(adjudicator_role_at_review) <= 256))),
    CONSTRAINT governed_review_adjudications_basis_check CHECK (((length(basis) > 0) AND (octet_length(basis) <= 32768))),
    CONSTRAINT governed_review_adjudications_chain_version_check CHECK ((chain_version > 0)),
    CONSTRAINT governed_review_adjudications_considered_label_count_check CHECK ((considered_label_count > 0)),
    CONSTRAINT governed_review_adjudications_considered_label_set_digest_check CHECK ((considered_label_set_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_adjudications_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_adjudications_correction_reason_check CHECK (((correction_reason IS NULL) OR ((length(correction_reason) > 0) AND (octet_length(correction_reason) <= 32768)))),
    CONSTRAINT governed_review_adjudications_decision_check CHECK ((decision = ANY (ARRAY['pass'::text, 'fail'::text, 'unresolvable'::text]))),
    CONSTRAINT governed_review_adjudications_idempotency_key_check CHECK (((length(idempotency_key) > 0) AND (octet_length(idempotency_key) <= 1024))),
    CONSTRAINT governed_review_adjudications_rationale_check CHECK (((length(rationale) > 0) AND (octet_length(rationale) <= 32768))),
    CONSTRAINT governed_review_adjudications_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: governed_review_alignment_event_labels; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE governed_review_alignment_event_labels (
    project_id text NOT NULL,
    alignment_event_id text NOT NULL,
    label_id text NOT NULL
);


--
-- Name: governed_review_alignment_events; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE governed_review_alignment_events (
    id text NOT NULL,
    project_id text NOT NULL,
    batch_id text NOT NULL,
    sequence integer NOT NULL,
    expected_previous_sequence integer NOT NULL,
    event_kind text NOT NULL,
    actor_subject_id text NOT NULL,
    actor_role_at_review text NOT NULL,
    content text NOT NULL,
    proposed_instruction_version_id text,
    visible_label_count integer NOT NULL,
    visible_label_set_digest text NOT NULL,
    previous_event_digest text,
    event_digest text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT governed_review_alignment_even_expected_previous_sequence_check CHECK ((expected_previous_sequence >= 0)),
    CONSTRAINT governed_review_alignment_events_actor_role_at_review_check CHECK (((length(actor_role_at_review) > 0) AND (octet_length(actor_role_at_review) <= 256))),
    CONSTRAINT governed_review_alignment_events_check CHECK ((((event_kind = 'instruction_change_proposed'::text) AND (proposed_instruction_version_id IS NOT NULL)) OR ((event_kind <> 'instruction_change_proposed'::text) AND (proposed_instruction_version_id IS NULL)))),
    CONSTRAINT governed_review_alignment_events_content_check CHECK (((length(content) > 0) AND (octet_length(content) <= 65536))),
    CONSTRAINT governed_review_alignment_events_event_digest_check CHECK ((event_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_alignment_events_event_kind_check CHECK ((event_kind = ANY (ARRAY['comment_recorded'::text, 'instruction_change_proposed'::text, 'closed'::text]))),
    CONSTRAINT governed_review_alignment_events_idempotency_key_check CHECK (((length(idempotency_key) > 0) AND (octet_length(idempotency_key) <= 1024))),
    CONSTRAINT governed_review_alignment_events_previous_event_digest_check CHECK ((previous_event_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_alignment_events_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_alignment_events_sequence_check CHECK ((sequence > 0)),
    CONSTRAINT governed_review_alignment_events_visible_label_count_check CHECK ((visible_label_count > 0)),
    CONSTRAINT governed_review_alignment_events_visible_label_set_digest_check CHECK ((visible_label_set_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: governed_review_batch_events; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE governed_review_batch_events (
    id text NOT NULL,
    project_id text NOT NULL,
    batch_id text NOT NULL,
    sequence integer NOT NULL,
    state_version integer NOT NULL,
    expected_previous_state_version integer NOT NULL,
    event_kind text NOT NULL,
    actor_subject_id text,
    actor_role_at_review text,
    dataset_revision_id text,
    representative_of_population_id text,
    representative_ineligible_reasons text[] DEFAULT '{}'::text[] NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    previous_event_digest text,
    event_digest text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT governed_review_batch_events_actor_role_at_review_check CHECK (((actor_role_at_review IS NULL) OR ((length(actor_role_at_review) > 0) AND (octet_length(actor_role_at_review) <= 256)))),
    CONSTRAINT governed_review_batch_events_details_check CHECK ((octet_length((details)::text) <= 65536)),
    CONSTRAINT governed_review_batch_events_event_digest_check CHECK ((event_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_batch_events_event_kind_check CHECK ((event_kind = ANY (ARRAY['open'::text, 'labeling_closed'::text, 'alignment_open'::text, 'adjudicating'::text, 'resolved'::text, 'incomplete'::text, 'frozen'::text, 'abandoned'::text]))),
    CONSTRAINT governed_review_batch_events_expected_previous_state_vers_check CHECK ((expected_previous_state_version >= 0)),
    CONSTRAINT governed_review_batch_events_idempotency_key_check CHECK (((length(idempotency_key) > 0) AND (octet_length(idempotency_key) <= 1024))),
    CONSTRAINT governed_review_batch_events_previous_event_digest_check CHECK ((previous_event_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_batch_events_representative_ineligible_r_check1 CHECK (governed_bounded_text_array(representative_ineligible_reasons, 16, 256, 4096)),
    CONSTRAINT governed_review_batch_events_representative_ineligible_re_check CHECK (governed_nonempty_text_array(representative_ineligible_reasons)),
    CONSTRAINT governed_review_batch_events_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_batch_events_sequence_check CHECK ((sequence > 0)),
    CONSTRAINT governed_review_batch_events_state_version_check CHECK ((state_version > 0))
);


--
-- Name: governed_review_batch_items; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE governed_review_batch_items (
    id text NOT NULL,
    project_id text NOT NULL,
    batch_id text NOT NULL,
    review_item_id text NOT NULL,
    draw_position integer NOT NULL,
    frame_member_digest text NOT NULL,
    stratum_key text,
    inclusion_probability numeric,
    sampling_weight numeric,
    content_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT governed_review_batch_items_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_batch_items_draw_position_check CHECK ((draw_position >= 0)),
    CONSTRAINT governed_review_batch_items_frame_member_digest_check CHECK ((frame_member_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_batch_items_inclusion_probability_check CHECK (((inclusion_probability > (0)::numeric) AND (inclusion_probability <= (1)::numeric))),
    CONSTRAINT governed_review_batch_items_sampling_weight_check CHECK ((sampling_weight > (0)::numeric))
);


--
-- Name: governed_review_batches; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE governed_review_batches (
    id text NOT NULL,
    project_id text NOT NULL,
    criterion_version_id text NOT NULL,
    instruction_version_id text NOT NULL,
    role_intent text NOT NULL,
    source_population_kind text NOT NULL,
    source_population_id text NOT NULL,
    population_id text NOT NULL,
    population_definition jsonb NOT NULL,
    population_collection_provenance jsonb NOT NULL,
    population_size integer NOT NULL,
    population_digest text NOT NULL,
    window_start timestamp with time zone,
    window_end timestamp with time zone,
    selection_method text NOT NULL,
    selection_seed text,
    rng_version text,
    selection_algorithm_version text NOT NULL,
    draw_executed_by text NOT NULL,
    fixed_budget integer NOT NULL,
    stopping_rule text NOT NULL,
    stop_at timestamp with time zone NOT NULL,
    draw_digest text NOT NULL,
    strata jsonb DEFAULT '[]'::jsonb NOT NULL,
    required_labels_per_item integer NOT NULL,
    evaluator_blind boolean NOT NULL,
    peer_blind_until_labeling_closed boolean NOT NULL,
    separation_of_duties_required boolean NOT NULL,
    custodian_subject_id text,
    custodian_role_at_review text,
    state_machine_version text NOT NULL,
    content_digest text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    created_by_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT governed_review_batches_check CHECK (((window_start IS NULL) = (window_end IS NULL))),
    CONSTRAINT governed_review_batches_check1 CHECK (((window_end IS NULL) OR (window_end > window_start))),
    CONSTRAINT governed_review_batches_check2 CHECK ((fixed_budget <= population_size)),
    CONSTRAINT governed_review_batches_check3 CHECK (((selection_method <> ALL (ARRAY['simple_random'::text, 'stratified_random'::text])) OR ((selection_seed IS NOT NULL) AND (rng_version IS NOT NULL)))),
    CONSTRAINT governed_review_batches_check4 CHECK ((((selection_method = 'stratified_random'::text) AND (jsonb_typeof(strata) = 'array'::text) AND (jsonb_array_length(strata) > 0) AND (jsonb_array_length(strata) <= 1000)) OR ((selection_method <> 'stratified_random'::text) AND (jsonb_typeof(strata) = 'array'::text) AND (jsonb_array_length(strata) <= 1000)))),
    CONSTRAINT governed_review_batches_check5 CHECK ((((role_intent = 'sealed_validation'::text) AND (source_population_kind = 'sealed_intake'::text) AND (required_labels_per_item >= 2) AND evaluator_blind AND peer_blind_until_labeling_closed AND separation_of_duties_required AND (custodian_subject_id IS NOT NULL) AND (custodian_role_at_review IS NOT NULL) AND (length(custodian_role_at_review) > 0)) OR ((role_intent <> 'sealed_validation'::text) AND (source_population_kind = 'dataset_revision'::text)) OR ((role_intent = 'analysis_authoring'::text) AND (source_population_kind = 'analysis_promotion_handoff'::text) AND (custodian_subject_id IS NULL) AND (custodian_role_at_review IS NULL)))),
    CONSTRAINT governed_review_batches_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_batches_custodian_role_at_review_check CHECK (((custodian_role_at_review IS NULL) OR ((length(custodian_role_at_review) > 0) AND (octet_length(custodian_role_at_review) <= 256)))),
    CONSTRAINT governed_review_batches_draw_digest_check CHECK ((draw_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_batches_draw_executed_by_check CHECK ((draw_executed_by = 'coeval_server'::text)),
    CONSTRAINT governed_review_batches_fixed_budget_check CHECK (((fixed_budget > 0) AND (fixed_budget <= 10000))),
    CONSTRAINT governed_review_batches_idempotency_key_check CHECK (((length(idempotency_key) > 0) AND (octet_length(idempotency_key) <= 1024))),
    CONSTRAINT governed_review_batches_population_collection_provenance_check CHECK ((octet_length((population_collection_provenance)::text) <= 262144)),
    CONSTRAINT governed_review_batches_population_definition_check CHECK ((octet_length((population_definition)::text) <= 262144)),
    CONSTRAINT governed_review_batches_population_digest_check CHECK ((population_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_batches_population_id_check CHECK (((length(population_id) > 0) AND (octet_length(population_id) <= 4096))),
    CONSTRAINT governed_review_batches_population_size_check CHECK (((population_size >= 0) AND (population_size <= 10000000))),
    CONSTRAINT governed_review_batches_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_batches_required_labels_per_item_check CHECK (((required_labels_per_item > 0) AND (required_labels_per_item <= 20))),
    CONSTRAINT governed_review_batches_rng_version_check CHECK (((rng_version IS NULL) OR (octet_length(rng_version) <= 256))),
    CONSTRAINT governed_review_batches_role_intent_check CHECK ((role_intent = ANY (ARRAY['analysis_authoring'::text, 'iterative_development'::text, 'sealed_validation'::text]))),
    CONSTRAINT governed_review_batches_selection_algorithm_version_check CHECK (((length(selection_algorithm_version) > 0) AND (octet_length(selection_algorithm_version) <= 256))),
    CONSTRAINT governed_review_batches_selection_method_check CHECK ((selection_method = ANY (ARRAY['simple_random'::text, 'stratified_random'::text, 'systematic'::text, 'convenience'::text, 'uncertainty'::text, 'failure_hunting'::text, 'manual'::text]))),
    CONSTRAINT governed_review_batches_selection_seed_check CHECK (((selection_seed IS NULL) OR (octet_length(selection_seed) <= 4096))),
    CONSTRAINT governed_review_batches_source_population_id_check CHECK (((length(source_population_id) > 0) AND (octet_length(source_population_id) <= 4096))),
    CONSTRAINT governed_review_batches_source_population_kind_check CHECK ((source_population_kind = ANY (ARRAY['dataset_revision'::text, 'sealed_intake'::text, 'analysis_promotion_handoff'::text]))),
    CONSTRAINT governed_review_batches_state_machine_version_check CHECK ((state_machine_version = 'governed-review-state/v1'::text)),
    CONSTRAINT governed_review_batches_stopping_rule_check CHECK ((stopping_rule = 'fixed'::text)),
    CONSTRAINT governed_review_batches_strata_check CHECK ((octet_length((strata)::text) <= 262144))
);


--
-- Name: governed_review_batch_states; Type: VIEW; Schema: current; Owner: -
--

CREATE VIEW governed_review_batch_states AS
 SELECT batch.id AS batch_id,
    batch.project_id,
    governed_review_current_batch_state(batch.id) AS state,
    COALESCE(max(event.state_version), 0) AS state_version
   FROM (governed_review_batches batch
     LEFT JOIN governed_review_batch_events event ON ((event.batch_id = batch.id)))
  GROUP BY batch.id, batch.project_id;


--
-- Name: governed_review_capability_checks; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE governed_review_capability_checks (
    id text NOT NULL,
    project_id text NOT NULL,
    batch_id text NOT NULL,
    criterion_version_id text NOT NULL,
    evaluator_version_id text,
    subject_id text NOT NULL,
    sequence integer NOT NULL,
    expected_previous_sequence integer NOT NULL,
    check_scope text NOT NULL,
    result text NOT NULL,
    verification_method text NOT NULL,
    capability_query_version text NOT NULL,
    covered_capabilities text[] NOT NULL,
    excluded_capabilities text[] DEFAULT '{}'::text[] NOT NULL,
    unknown_capabilities text[] DEFAULT '{}'::text[] NOT NULL,
    evidence jsonb NOT NULL,
    evidence_digest text NOT NULL,
    content_digest text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    checked_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT governed_review_capability_che_expected_previous_sequence_check CHECK ((expected_previous_sequence >= 0)),
    CONSTRAINT governed_review_capability_check_capability_query_version_check CHECK ((capability_query_version = 'sealed-separation/v1'::text)),
    CONSTRAINT governed_review_capability_checks_check CHECK (((check_scope <> 'final_validation'::text) OR (evaluator_version_id IS NOT NULL))),
    CONSTRAINT governed_review_capability_checks_check1 CHECK ((((result = 'eligible'::text) AND (cardinality(excluded_capabilities) = 0) AND (cardinality(unknown_capabilities) = 0)) OR ((result = 'ineligible'::text) AND (cardinality(excluded_capabilities) > 0)) OR ((result = 'unknown'::text) AND (cardinality(unknown_capabilities) > 0)))),
    CONSTRAINT governed_review_capability_checks_check_scope_check CHECK ((check_scope = ANY (ARRAY['batch_open'::text, 'adjudication'::text, 'truth_freeze'::text, 'final_validation'::text]))),
    CONSTRAINT governed_review_capability_checks_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_capability_checks_covered_capabilities_check CHECK ((covered_capabilities = ARRAY['criterion_authoring'::text, 'instruction_authoring'::text, 'evaluator_authoring'::text, 'rubric_authoring'::text, 'prompt_authoring'::text, 'example_selection'::text, 'development_exposure'::text])),
    CONSTRAINT governed_review_capability_checks_evidence_check CHECK ((octet_length((evidence)::text) <= 262144)),
    CONSTRAINT governed_review_capability_checks_evidence_digest_check CHECK ((evidence_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_capability_checks_excluded_capabilities_check CHECK (governed_nonempty_text_array(excluded_capabilities)),
    CONSTRAINT governed_review_capability_checks_excluded_capabilities_check1 CHECK (governed_bounded_text_array(excluded_capabilities, 100, 1024, 65536)),
    CONSTRAINT governed_review_capability_checks_idempotency_key_check CHECK (((length(idempotency_key) > 0) AND (octet_length(idempotency_key) <= 1024))),
    CONSTRAINT governed_review_capability_checks_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_capability_checks_result_check CHECK ((result = ANY (ARRAY['eligible'::text, 'ineligible'::text, 'unknown'::text]))),
    CONSTRAINT governed_review_capability_checks_sequence_check CHECK ((sequence > 0)),
    CONSTRAINT governed_review_capability_checks_unknown_capabilities_check CHECK (governed_nonempty_text_array(unknown_capabilities)),
    CONSTRAINT governed_review_capability_checks_unknown_capabilities_check1 CHECK (governed_bounded_text_array(unknown_capabilities, 100, 1024, 65536)),
    CONSTRAINT governed_review_capability_checks_verification_method_check CHECK ((verification_method = ANY (ARRAY['system_derived'::text, 'independently_verified'::text])))
);


--
-- Name: governed_review_items; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE governed_review_items (
    id text NOT NULL,
    project_id text NOT NULL,
    source_kind text NOT NULL,
    source_revision_id text,
    source_revision_item_id text,
    sealed_intake_population_id text,
    sealed_frame_position integer,
    sealed_predecessor_revision_id text,
    sealed_predecessor_revision_item_id text,
    identity_basis text NOT NULL,
    input_digest text NOT NULL,
    source_item_digest text,
    review_payload_projection_version text NOT NULL,
    review_payload_snapshot jsonb NOT NULL,
    redaction_provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    content_digest text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    created_by_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT governed_review_items_check CHECK ((((source_kind = 'dataset_revision_item'::text) AND (source_revision_id IS NOT NULL) AND (source_revision_item_id IS NOT NULL) AND (source_item_digest IS NOT NULL) AND (sealed_intake_population_id IS NULL) AND (sealed_frame_position IS NULL) AND (sealed_predecessor_revision_id IS NULL) AND (sealed_predecessor_revision_item_id IS NULL)) OR ((source_kind = 'sealed_intake'::text) AND (source_revision_id IS NULL) AND (source_revision_item_id IS NULL) AND (source_item_digest IS NULL) AND (sealed_intake_population_id IS NOT NULL) AND (sealed_frame_position IS NOT NULL) AND (((sealed_predecessor_revision_id IS NULL) AND (sealed_predecessor_revision_item_id IS NULL)) OR ((sealed_predecessor_revision_id IS NOT NULL) AND (sealed_predecessor_revision_item_id IS NOT NULL)))))),
    CONSTRAINT governed_review_items_check1 CHECK (((source_kind <> 'sealed_intake'::text) OR (redaction_provenance <> '{}'::jsonb))),
    CONSTRAINT governed_review_items_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_items_idempotency_key_check CHECK (((length(idempotency_key) > 0) AND (octet_length(idempotency_key) <= 1024))),
    CONSTRAINT governed_review_items_identity_basis_check CHECK ((identity_basis = 'input-identity/v1'::text)),
    CONSTRAINT governed_review_items_input_digest_check CHECK ((input_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_items_redaction_provenance_check CHECK ((octet_length((redaction_provenance)::text) <= 131072)),
    CONSTRAINT governed_review_items_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_items_review_payload_projection_version_check CHECK ((review_payload_projection_version = 'governed-review-payload/v1'::text)),
    CONSTRAINT governed_review_items_review_payload_snapshot_check CHECK ((governed_review_payload_v1_is_safe(review_payload_snapshot) AND (octet_length((review_payload_snapshot)::text) <= 2097152))),
    CONSTRAINT governed_review_items_sealed_frame_position_check CHECK (((sealed_frame_position IS NULL) OR (sealed_frame_position >= 0))),
    CONSTRAINT governed_review_items_source_item_digest_check CHECK ((source_item_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_review_items_source_kind_check CHECK ((source_kind = ANY (ARRAY['dataset_revision_item'::text, 'sealed_intake'::text])))
);


--
-- Name: governed_review_task_states; Type: VIEW; Schema: current; Owner: -
--

CREATE VIEW governed_review_task_states AS
 SELECT task.id AS task_id,
    task.project_id,
    task.batch_id,
    task.batch_item_id,
    governed_review_current_task_state(task.id) AS state,
    COALESCE(max(event.state_version), 0) AS state_version
   FROM (governed_review_tasks task
     LEFT JOIN governed_review_task_events event ON ((event.task_id = task.id)))
  GROUP BY task.id, task.project_id, task.batch_id, task.batch_item_id;


--
-- Name: governed_reviewer_subjects; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE governed_reviewer_subjects (
    id text NOT NULL,
    project_id text NOT NULL,
    account_user_id text,
    subject_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT governed_reviewer_subjects_subject_digest_check CHECK ((subject_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: governed_sealed_intake_populations; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE governed_sealed_intake_populations (
    id text NOT NULL,
    project_id text NOT NULL,
    custodian_subject_id text NOT NULL,
    custodian_role_at_review text NOT NULL,
    population_definition jsonb NOT NULL,
    window_start timestamp with time zone,
    window_end timestamp with time zone,
    collection_provenance jsonb NOT NULL,
    frame_count integer NOT NULL,
    frame_digest text NOT NULL,
    predecessor_revision_id text,
    content_digest text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT governed_sealed_intake_populatio_custodian_role_at_review_check CHECK (((length(custodian_role_at_review) > 0) AND (octet_length(custodian_role_at_review) <= 256))),
    CONSTRAINT governed_sealed_intake_populations_check CHECK (((window_start IS NULL) = (window_end IS NULL))),
    CONSTRAINT governed_sealed_intake_populations_check1 CHECK (((window_end IS NULL) OR (window_end > window_start))),
    CONSTRAINT governed_sealed_intake_populations_collection_provenance_check CHECK (((collection_provenance <> '{}'::jsonb) AND (octet_length((collection_provenance)::text) <= 262144))),
    CONSTRAINT governed_sealed_intake_populations_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_sealed_intake_populations_frame_count_check CHECK (((frame_count > 0) AND (frame_count <= 10000000))),
    CONSTRAINT governed_sealed_intake_populations_frame_digest_check CHECK ((frame_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT governed_sealed_intake_populations_idempotency_key_check CHECK (((length(idempotency_key) > 0) AND (octet_length(idempotency_key) <= 1024))),
    CONSTRAINT governed_sealed_intake_populations_population_definition_check CHECK (((population_definition <> '{}'::jsonb) AND (octet_length((population_definition)::text) <= 262144))),
    CONSTRAINT governed_sealed_intake_populations_request_digest_check CHECK ((request_digest ~ '^sha256:[0-9a-f]{64}$'::text))
);


--
-- Name: import_jobs; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE import_jobs (
    id text NOT NULL,
    project_id text NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    error text,
    source text DEFAULT 'manual'::text NOT NULL,
    source_integration_id text,
    queue_job_id text,
    requested_limit integer,
    imported_count integer DEFAULT 0 NOT NULL,
    queued_judge_count integer DEFAULT 0 NOT NULL,
    actor_user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    skill_version_id text,
    CONSTRAINT import_jobs_skill_version_state_check CHECK (((skill_version_id IS NOT NULL) OR (status = 'failed'::text))),
    CONSTRAINT import_jobs_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'langsmith'::text, 'langfuse'::text, 'ironside'::text])))
);


--
-- Name: integrations; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE integrations (
    id text NOT NULL,
    project_id text NOT NULL,
    provider text NOT NULL,
    encrypted_credentials text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    poll_enabled boolean DEFAULT true NOT NULL,
    poll_interval_seconds integer DEFAULT 300 NOT NULL,
    poll_limit integer DEFAULT 25 NOT NULL,
    last_polled_at timestamp with time zone,
    last_tested_at timestamp with time zone,
    last_test_result jsonb
);


--
-- Name: invitations; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE invitations (
    id text NOT NULL,
    organization_id text NOT NULL,
    project_id text NOT NULL,
    email text NOT NULL,
    token_hash text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    invited_by_user_id text NOT NULL,
    redeemed_by_user_id text,
    expires_at timestamp with time zone NOT NULL,
    redeemed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: judge_provider_keys; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE judge_provider_keys (
    id text NOT NULL,
    project_id text NOT NULL,
    provider text NOT NULL,
    encrypted_credentials text NOT NULL,
    key_display text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT judge_provider_keys_provider_check CHECK ((provider = ANY (ARRAY['anthropic'::text, 'openai'::text, 'openrouter'::text, 'custom'::text])))
);


--
-- Name: judge_runs; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE judge_runs (
    id text NOT NULL,
    project_id text NOT NULL,
    case_id text NOT NULL,
    skill_version_id text NOT NULL,
    verdict text NOT NULL,
    score numeric NOT NULL,
    reasoning text NOT NULL,
    raw_request jsonb,
    raw_response jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    latency_ms integer,
    input_tokens integer,
    output_tokens integer,
    provider_metadata jsonb
);


--
-- Name: organization_members; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE organization_members (
    id text NOT NULL,
    organization_id text NOT NULL,
    user_id text NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: organizations; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE organizations (
    id text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: project_members; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE project_members (
    id text NOT NULL,
    project_id text NOT NULL,
    user_id text NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: projects; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE projects (
    id text NOT NULL,
    organization_id text NOT NULL,
    name text NOT NULL,
    trace_provider text NOT NULL,
    imported_trace_count integer DEFAULT 0 NOT NULL,
    auto_judged_trace_count integer DEFAULT 0 NOT NULL,
    sync_back_coverage numeric DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    trace_retention_days integer,
    last_retention_pruned_at timestamp with time zone,
    mode text DEFAULT 'tracing'::text NOT NULL,
    CONSTRAINT projects_mode_check CHECK ((mode = ANY (ARRAY['tracing'::text, 'bench'::text]))),
    CONSTRAINT projects_trace_retention_days_positive CHECK (((trace_retention_days IS NULL) OR (trace_retention_days > 0)))
);


--
-- Name: raw_traces; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE raw_traces (
    id text NOT NULL,
    project_id text NOT NULL,
    source_integration_id text,
    source_trace_id text NOT NULL,
    import_job_id text,
    raw_payload jsonb NOT NULL,
    normalization_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: regression_runs; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE regression_runs (
    id text NOT NULL,
    project_id text NOT NULL,
    skill_version_id text NOT NULL,
    status text NOT NULL,
    compared integer NOT NULL,
    regressed integer NOT NULL,
    improved integer NOT NULL,
    flipped integer NOT NULL,
    override_reason text,
    override_actor_user_id text,
    golden_set_missing boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cases jsonb DEFAULT '[]'::jsonb NOT NULL,
    error_message text,
    dataset_revision_id text NOT NULL,
    criterion_version_id text NOT NULL
);


--
-- Name: review_instruction_versions; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE review_instruction_versions (
    id text NOT NULL,
    project_id text NOT NULL,
    criterion_version_id text NOT NULL,
    revision integer NOT NULL,
    predecessor_instruction_version_id text,
    title text NOT NULL,
    instructions text NOT NULL,
    allowed_labels text[] NOT NULL,
    failure_code_guidance text NOT NULL,
    content_digest text NOT NULL,
    created_by_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT review_instruction_versions_allowed_labels_check CHECK ((allowed_labels = ARRAY['pass'::text, 'fail'::text, 'cannot_determine'::text])),
    CONSTRAINT review_instruction_versions_content_digest_check CHECK ((content_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT review_instruction_versions_failure_code_guidance_check CHECK ((octet_length(failure_code_guidance) <= 65536)),
    CONSTRAINT review_instruction_versions_instructions_check CHECK (((length(instructions) > 0) AND (octet_length(instructions) <= 262144))),
    CONSTRAINT review_instruction_versions_revision_check CHECK ((revision > 0)),
    CONSTRAINT review_instruction_versions_title_check CHECK (((length(title) > 0) AND (octet_length(title) <= 1024)))
);


--
-- Name: review_queue_items; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE review_queue_items (
    id text NOT NULL,
    queue_id text NOT NULL,
    case_id text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    "position" integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    assigned_to_user_id text,
    criterion_version_id text NOT NULL,
    CONSTRAINT review_queue_items_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text])))
);


--
-- Name: review_queues; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE review_queues (
    id text NOT NULL,
    project_id text NOT NULL,
    name text NOT NULL,
    description text,
    status text DEFAULT 'open'::text NOT NULL,
    created_by_user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    CONSTRAINT review_queues_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text])))
);


--
-- Name: run_comparisons; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE run_comparisons (
    id text NOT NULL,
    project_id text NOT NULL,
    dataset_id text NOT NULL,
    version_a_id text NOT NULL,
    version_b_id text NOT NULL,
    run_a_id text NOT NULL,
    run_b_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    dataset_revision_id text
);


--
-- Name: session; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE session (
    id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ip_address text,
    user_agent text,
    user_id text NOT NULL
);


--
-- Name: skill_versions; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE skill_versions (
    id text NOT NULL,
    skill_id text NOT NULL,
    project_id text NOT NULL,
    version text NOT NULL,
    status text NOT NULL,
    rubric_markdown text NOT NULL,
    prompt text NOT NULL,
    output_schema jsonb NOT NULL,
    model_binding jsonb NOT NULL,
    golden_set_agreement numeric,
    too_strict_count integer DEFAULT 0 NOT NULL,
    too_lenient_count integer DEFAULT 0 NOT NULL,
    ambiguous_count integer DEFAULT 0 NOT NULL,
    known_limitations text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_at timestamp with time zone,
    verdict_kind text DEFAULT 'binary'::text NOT NULL,
    scalar_range jsonb,
    categorical_choice_scores jsonb,
    rubric_provenance text DEFAULT 'human-authored'::text NOT NULL,
    regression_dataset_revision_id text,
    criterion_version_id text NOT NULL,
    created_by_user_id text,
    created_by_subject_id text,
    developer_identity_status text DEFAULT 'unknown_legacy'::text NOT NULL,
    CONSTRAINT skill_versions_developer_identity_status_check CHECK ((developer_identity_status = ANY (ARRAY['unknown_legacy'::text, 'recorded'::text]))),
    -- Starter drafts and human sign-off can be approved without running a
    -- regression gate. Every other current lifecycle status requires the
    -- immutable regression snapshot selected before execution.
    CONSTRAINT skill_versions_regression_pin_by_status CHECK (((regression_dataset_revision_id IS NOT NULL) OR (status = ANY (ARRAY['draft'::text, 'approved'::text])))),
    CONSTRAINT skill_versions_rubric_provenance_check CHECK ((rubric_provenance = ANY (ARRAY['human-authored'::text, 'agent-drafted'::text]))),
    CONSTRAINT skill_versions_verdict_kind_check CHECK ((verdict_kind = ANY (ARRAY['binary'::text, 'scalar'::text, 'categorical'::text]))),
    CONSTRAINT skill_versions_verdict_shape_consistent CHECK ((((verdict_kind = 'binary'::text) AND (scalar_range IS NULL) AND (categorical_choice_scores IS NULL)) OR ((verdict_kind = 'scalar'::text) AND (scalar_range IS NOT NULL) AND (categorical_choice_scores IS NULL)) OR ((verdict_kind = 'categorical'::text) AND (scalar_range IS NULL) AND (categorical_choice_scores IS NOT NULL))))
);


--
-- Name: skills; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE skills (
    id text NOT NULL,
    project_id text NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    owner_user_id text,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_starter boolean DEFAULT false NOT NULL,
    criterion_id text NOT NULL
);


--
-- Name: trace_test_revisions; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE trace_test_revisions (
    id text NOT NULL,
    trace_test_id text NOT NULL,
    project_id text NOT NULL,
    revision integer NOT NULL,
    lifecycle text NOT NULL,
    desired_behavior text NOT NULL,
    scenario text NOT NULL,
    expected_behavior text NOT NULL,
    must_do jsonb DEFAULT '[]'::jsonb NOT NULL,
    must_avoid jsonb DEFAULT '[]'::jsonb NOT NULL,
    good_example jsonb NOT NULL,
    bad_example jsonb NOT NULL,
    checker jsonb NOT NULL,
    draft_provenance jsonb NOT NULL,
    validation_id text,
    validated_revision integer,
    created_by_user_id text,
    reviewed_by_user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    CONSTRAINT trace_test_revisions_check CHECK ((((lifecycle = 'draft'::text) AND (validation_id IS NULL) AND (validated_revision IS NULL) AND (reviewed_by_user_id IS NULL) AND (reviewed_at IS NULL)) OR ((lifecycle = 'enabled'::text) AND (validation_id IS NOT NULL) AND (validated_revision IS NOT NULL) AND (reviewed_by_user_id IS NOT NULL) AND (reviewed_at IS NOT NULL)))),
    CONSTRAINT trace_test_revisions_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['draft'::text, 'enabled'::text]))),
    CONSTRAINT trace_test_revisions_revision_check CHECK ((revision > 0))
);


--
-- Name: trace_test_validations; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE trace_test_validations (
    id text NOT NULL,
    trace_test_id text NOT NULL,
    project_id text NOT NULL,
    revision integer NOT NULL,
    status text NOT NULL,
    bad_evidence jsonb NOT NULL,
    good_evidence jsonb NOT NULL,
    recorded_by_user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    method text DEFAULT 'automated'::text NOT NULL,
    diagnostic text,
    evaluator jsonb,
    override_reason text,
    CONSTRAINT trace_test_validations_diagnostic_check CHECK (((diagnostic IS NULL) OR (diagnostic = ANY (ARRAY['always_pass'::text, 'always_fail'::text, 'reversed'::text, 'ambiguous'::text, 'evaluator_error'::text, 'unavailable'::text])))),
    CONSTRAINT trace_test_validations_manual_reason_check CHECK ((((method = 'automated'::text) AND (override_reason IS NULL)) OR ((method = 'manual_override'::text) AND (length(TRIM(BOTH FROM override_reason)) >= 10)))),
    CONSTRAINT trace_test_validations_method_check CHECK ((method = ANY (ARRAY['automated'::text, 'manual_override'::text]))),
    CONSTRAINT trace_test_validations_revision_check CHECK ((revision > 0)),
    CONSTRAINT trace_test_validations_status_check CHECK ((status = ANY (ARRAY['passed'::text, 'failed'::text, 'non_discriminating'::text, 'ambiguous'::text, 'evaluator_error'::text, 'unavailable'::text, 'needs_review'::text, 'could_not_run'::text])))
);


--
-- Name: trace_tests; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE trace_tests (
    id text NOT NULL,
    project_id text NOT NULL,
    source_case_id text,
    source_case_ref text NOT NULL,
    source_trace_ref text NOT NULL,
    source_snapshot jsonb NOT NULL,
    source_scope jsonb NOT NULL,
    current_revision integer DEFAULT 1 NOT NULL,
    enabled_revision integer,
    created_by_user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT trace_tests_current_revision_check CHECK ((current_revision > 0)),
    CONSTRAINT trace_tests_enabled_revision_check CHECK (((enabled_revision IS NULL) OR (enabled_revision > 0)))
);


--
-- Name: user; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE "user" (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: verdicts; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE verdicts (
    id text NOT NULL,
    project_id text NOT NULL,
    case_id text NOT NULL,
    skill_version_id text,
    source text NOT NULL,
    actor_user_id text,
    verdict_kind text NOT NULL,
    payload jsonb NOT NULL,
    external_run_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT verdicts_source_check CHECK ((source = ANY (ARRAY['llm_judge'::text, 'human'::text, 'imported_external'::text, 'adjudicated'::text]))),
    CONSTRAINT verdicts_verdict_kind_check CHECK ((verdict_kind = ANY (ARRAY['binary'::text, 'scalar'::text, 'categorical'::text])))
);


--
-- Name: verification; Type: TABLE; Schema: current; Owner: -
--

CREATE TABLE verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: agent_setup_pairings agent_setup_pairings_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY agent_setup_pairings
    ADD CONSTRAINT agent_setup_pairings_pkey PRIMARY KEY (id);


--
-- Name: agent_setup_pairings agent_setup_pairings_token_hash_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY agent_setup_pairings
    ADD CONSTRAINT agent_setup_pairings_token_hash_key UNIQUE (token_hash);


--
-- Name: analysis_criterion_promotion_supports analysis_criterion_promotion__project_id_example_selection__key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotion_supports
    ADD CONSTRAINT analysis_criterion_promotion__project_id_example_selection__key UNIQUE (project_id, example_selection_exposure_event_id);


--
-- Name: analysis_criterion_promotion_supports analysis_criterion_promotion__promotion_id_observation_even_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotion_supports
    ADD CONSTRAINT analysis_criterion_promotion__promotion_id_observation_even_key UNIQUE (promotion_id, observation_event_id);


--
-- Name: analysis_criterion_promotion_supports analysis_criterion_promotion_supports_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotion_supports
    ADD CONSTRAINT analysis_criterion_promotion_supports_pkey PRIMARY KEY (id);


--
-- Name: analysis_criterion_promotion_supports analysis_criterion_promotion_supports_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotion_supports
    ADD CONSTRAINT analysis_criterion_promotion_supports_project_id_id_key UNIQUE (project_id, id);


--
-- Name: analysis_criterion_promotion_supports analysis_criterion_promotion_supports_promotion_id_position_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotion_supports
    ADD CONSTRAINT analysis_criterion_promotion_supports_promotion_id_position_key UNIQUE (promotion_id, "position");


--
-- Name: analysis_criterion_promotions analysis_criterion_promotions_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotions
    ADD CONSTRAINT analysis_criterion_promotions_pkey PRIMARY KEY (id);


--
-- Name: analysis_criterion_promotions analysis_criterion_promotions_project_id_code_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotions
    ADD CONSTRAINT analysis_criterion_promotions_project_id_code_id_key UNIQUE (project_id, code_id);


--
-- Name: analysis_criterion_promotions analysis_criterion_promotions_project_id_criterion_authorin_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotions
    ADD CONSTRAINT analysis_criterion_promotions_project_id_criterion_authorin_key UNIQUE (project_id, criterion_authoring_exposure_event_id);


--
-- Name: analysis_criterion_promotions analysis_criterion_promotions_project_id_criterion_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotions
    ADD CONSTRAINT analysis_criterion_promotions_project_id_criterion_id_key UNIQUE (project_id, criterion_id);


--
-- Name: analysis_criterion_promotions analysis_criterion_promotions_project_id_criterion_version__key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotions
    ADD CONSTRAINT analysis_criterion_promotions_project_id_criterion_version__key UNIQUE (project_id, criterion_version_id);


--
-- Name: analysis_criterion_promotions analysis_criterion_promotions_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotions
    ADD CONSTRAINT analysis_criterion_promotions_project_id_id_key UNIQUE (project_id, id);


--
-- Name: analysis_criterion_promotions analysis_criterion_promotions_project_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotions
    ADD CONSTRAINT analysis_criterion_promotions_project_id_idempotency_key_key UNIQUE (project_id, idempotency_key);


--
-- Name: analysis_failure_codes analysis_failure_codes_created_in_revision_id_client_token_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_codes
    ADD CONSTRAINT analysis_failure_codes_created_in_revision_id_client_token_key UNIQUE (created_in_revision_id, client_token);


--
-- Name: analysis_failure_codes analysis_failure_codes_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_codes
    ADD CONSTRAINT analysis_failure_codes_pkey PRIMARY KEY (id);


--
-- Name: analysis_failure_codes analysis_failure_codes_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_codes
    ADD CONSTRAINT analysis_failure_codes_project_id_id_key UNIQUE (project_id, id);


--
-- Name: analysis_failure_codes analysis_failure_codes_taxonomy_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_codes
    ADD CONSTRAINT analysis_failure_codes_taxonomy_id_id_key UNIQUE (taxonomy_id, id);


--
-- Name: analysis_failure_taxonomies analysis_failure_taxonomies_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_taxonomies
    ADD CONSTRAINT analysis_failure_taxonomies_pkey PRIMARY KEY (id);


--
-- Name: analysis_failure_taxonomies analysis_failure_taxonomies_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_taxonomies
    ADD CONSTRAINT analysis_failure_taxonomies_project_id_id_key UNIQUE (project_id, id);


--
-- Name: analysis_failure_taxonomies analysis_failure_taxonomies_project_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_taxonomies
    ADD CONSTRAINT analysis_failure_taxonomies_project_id_idempotency_key_key UNIQUE (project_id, idempotency_key);


--
-- Name: analysis_failure_taxonomies analysis_failure_taxonomies_project_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_taxonomies
    ADD CONSTRAINT analysis_failure_taxonomies_project_id_key UNIQUE (project_id);


--
-- Name: analysis_failure_taxonomy_revision_codes analysis_failure_taxonomy_rev_taxonomy_revision_id_position_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_taxonomy_revision_codes
    ADD CONSTRAINT analysis_failure_taxonomy_rev_taxonomy_revision_id_position_key UNIQUE (taxonomy_revision_id, "position");


--
-- Name: analysis_failure_taxonomy_revision_codes analysis_failure_taxonomy_revi_taxonomy_revision_id_code_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_taxonomy_revision_codes
    ADD CONSTRAINT analysis_failure_taxonomy_revi_taxonomy_revision_id_code_id_key UNIQUE (taxonomy_revision_id, code_id);


--
-- Name: analysis_failure_taxonomy_revisions analysis_failure_taxonomy_revis_taxonomy_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_taxonomy_revisions
    ADD CONSTRAINT analysis_failure_taxonomy_revis_taxonomy_id_idempotency_key_key UNIQUE (taxonomy_id, idempotency_key);


--
-- Name: analysis_failure_taxonomy_revision_codes analysis_failure_taxonomy_revision_codes_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_taxonomy_revision_codes
    ADD CONSTRAINT analysis_failure_taxonomy_revision_codes_pkey PRIMARY KEY (id);


--
-- Name: analysis_failure_taxonomy_revision_codes analysis_failure_taxonomy_revision_codes_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_taxonomy_revision_codes
    ADD CONSTRAINT analysis_failure_taxonomy_revision_codes_project_id_id_key UNIQUE (project_id, id);


--
-- Name: analysis_failure_taxonomy_revisions analysis_failure_taxonomy_revisions_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_taxonomy_revisions
    ADD CONSTRAINT analysis_failure_taxonomy_revisions_pkey PRIMARY KEY (id);


--
-- Name: analysis_failure_taxonomy_revisions analysis_failure_taxonomy_revisions_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_taxonomy_revisions
    ADD CONSTRAINT analysis_failure_taxonomy_revisions_project_id_id_key UNIQUE (project_id, id);


--
-- Name: analysis_failure_taxonomy_revisions analysis_failure_taxonomy_revisions_taxonomy_id_sequence_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_taxonomy_revisions
    ADD CONSTRAINT analysis_failure_taxonomy_revisions_taxonomy_id_sequence_key UNIQUE (taxonomy_id, sequence);


--
-- Name: analysis_observation_assignment_events analysis_observation_assignme_observation_event_id_idempote_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_observation_assignment_events
    ADD CONSTRAINT analysis_observation_assignme_observation_event_id_idempote_key UNIQUE (observation_event_id, idempotency_key);


--
-- Name: analysis_observation_assignment_events analysis_observation_assignmen_observation_event_id_version_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_observation_assignment_events
    ADD CONSTRAINT analysis_observation_assignmen_observation_event_id_version_key UNIQUE (observation_event_id, version);


--
-- Name: analysis_observation_assignment_events analysis_observation_assignment_events_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_observation_assignment_events
    ADD CONSTRAINT analysis_observation_assignment_events_pkey PRIMARY KEY (id);


--
-- Name: analysis_observation_assignment_events analysis_observation_assignment_events_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_observation_assignment_events
    ADD CONSTRAINT analysis_observation_assignment_events_project_id_id_key UNIQUE (project_id, id);


--
-- Name: analysis_population_draw_items analysis_population_draw_items_draw_id_case_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_draw_items
    ADD CONSTRAINT analysis_population_draw_items_draw_id_case_id_key UNIQUE (draw_id, case_id);


--
-- Name: analysis_population_draw_items analysis_population_draw_items_draw_id_member_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_draw_items
    ADD CONSTRAINT analysis_population_draw_items_draw_id_member_id_key UNIQUE (draw_id, member_id);


--
-- Name: analysis_population_draw_items analysis_population_draw_items_draw_id_position_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_draw_items
    ADD CONSTRAINT analysis_population_draw_items_draw_id_position_key UNIQUE (draw_id, "position");


--
-- Name: analysis_population_draw_items analysis_population_draw_items_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_draw_items
    ADD CONSTRAINT analysis_population_draw_items_pkey PRIMARY KEY (id);


--
-- Name: analysis_population_draw_items analysis_population_draw_items_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_draw_items
    ADD CONSTRAINT analysis_population_draw_items_project_id_id_key UNIQUE (project_id, id);


--
-- Name: analysis_population_draws analysis_population_draws_dataset_revision_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_draws
    ADD CONSTRAINT analysis_population_draws_dataset_revision_id_key UNIQUE (dataset_revision_id);


--
-- Name: analysis_population_draws analysis_population_draws_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_draws
    ADD CONSTRAINT analysis_population_draws_pkey PRIMARY KEY (id);


--
-- Name: analysis_population_draws analysis_population_draws_population_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_draws
    ADD CONSTRAINT analysis_population_draws_population_id_key UNIQUE (population_id);


--
-- Name: analysis_population_draws analysis_population_draws_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_draws
    ADD CONSTRAINT analysis_population_draws_project_id_id_key UNIQUE (project_id, id);


--
-- Name: analysis_population_exclusions analysis_population_exclusions_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_exclusions
    ADD CONSTRAINT analysis_population_exclusions_pkey PRIMARY KEY (id);


--
-- Name: analysis_population_exclusions analysis_population_exclusions_population_id_case_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_exclusions
    ADD CONSTRAINT analysis_population_exclusions_population_id_case_id_key UNIQUE (population_id, case_id);


--
-- Name: analysis_population_exclusions analysis_population_exclusions_population_id_position_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_exclusions
    ADD CONSTRAINT analysis_population_exclusions_population_id_position_key UNIQUE (population_id, "position");


--
-- Name: analysis_population_exclusions analysis_population_exclusions_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_exclusions
    ADD CONSTRAINT analysis_population_exclusions_project_id_id_key UNIQUE (project_id, id);


--
-- Name: analysis_population_members analysis_population_members_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_members
    ADD CONSTRAINT analysis_population_members_pkey PRIMARY KEY (id);


--
-- Name: analysis_population_members analysis_population_members_population_id_case_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_members
    ADD CONSTRAINT analysis_population_members_population_id_case_id_key UNIQUE (population_id, case_id);


--
-- Name: analysis_population_members analysis_population_members_population_id_position_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_members
    ADD CONSTRAINT analysis_population_members_population_id_position_key UNIQUE (population_id, "position");


--
-- Name: analysis_population_members analysis_population_members_population_id_revision_item_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_members
    ADD CONSTRAINT analysis_population_members_population_id_revision_item_id_key UNIQUE (population_id, revision_item_id);


--
-- Name: analysis_population_members analysis_population_members_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_members
    ADD CONSTRAINT analysis_population_members_project_id_id_key UNIQUE (project_id, id);


--
-- Name: analysis_population_requests analysis_population_requests_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_requests
    ADD CONSTRAINT analysis_population_requests_pkey PRIMARY KEY (id);


--
-- Name: analysis_population_requests analysis_population_requests_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_requests
    ADD CONSTRAINT analysis_population_requests_project_id_id_key UNIQUE (project_id, id);


--
-- Name: analysis_population_requests analysis_population_requests_project_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_requests
    ADD CONSTRAINT analysis_population_requests_project_id_idempotency_key_key UNIQUE (project_id, idempotency_key);


--
-- Name: analysis_populations analysis_populations_dataset_revision_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_populations
    ADD CONSTRAINT analysis_populations_dataset_revision_id_key UNIQUE (dataset_revision_id);


--
-- Name: analysis_populations analysis_populations_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_populations
    ADD CONSTRAINT analysis_populations_pkey PRIMARY KEY (id);


--
-- Name: analysis_populations analysis_populations_project_id_frame_digest_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_populations
    ADD CONSTRAINT analysis_populations_project_id_frame_digest_key UNIQUE (project_id, frame_digest);


--
-- Name: analysis_populations analysis_populations_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_populations
    ADD CONSTRAINT analysis_populations_project_id_id_key UNIQUE (project_id, id);


--
-- Name: analysis_studies analysis_studies_draw_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_studies
    ADD CONSTRAINT analysis_studies_draw_id_key UNIQUE (draw_id);


--
-- Name: analysis_studies analysis_studies_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_studies
    ADD CONSTRAINT analysis_studies_pkey PRIMARY KEY (id);


--
-- Name: analysis_studies analysis_studies_project_id_draw_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_studies
    ADD CONSTRAINT analysis_studies_project_id_draw_id_key UNIQUE (project_id, draw_id);


--
-- Name: analysis_studies analysis_studies_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_studies
    ADD CONSTRAINT analysis_studies_project_id_id_key UNIQUE (project_id, id);


--
-- Name: analysis_studies analysis_studies_project_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_studies
    ADD CONSTRAINT analysis_studies_project_id_idempotency_key_key UNIQUE (project_id, idempotency_key);


--
-- Name: analysis_study_closure_items analysis_study_closure_items_closure_id_position_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_closure_items
    ADD CONSTRAINT analysis_study_closure_items_closure_id_position_key UNIQUE (closure_id, "position");


--
-- Name: analysis_study_closure_items analysis_study_closure_items_closure_id_study_item_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_closure_items
    ADD CONSTRAINT analysis_study_closure_items_closure_id_study_item_id_key UNIQUE (closure_id, study_item_id);


--
-- Name: analysis_study_closure_items analysis_study_closure_items_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_closure_items
    ADD CONSTRAINT analysis_study_closure_items_pkey PRIMARY KEY (id);


--
-- Name: analysis_study_closure_items analysis_study_closure_items_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_closure_items
    ADD CONSTRAINT analysis_study_closure_items_project_id_id_key UNIQUE (project_id, id);


--
-- Name: analysis_study_closures analysis_study_closures_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_closures
    ADD CONSTRAINT analysis_study_closures_pkey PRIMARY KEY (id);


--
-- Name: analysis_study_closures analysis_study_closures_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_closures
    ADD CONSTRAINT analysis_study_closures_project_id_id_key UNIQUE (project_id, id);


--
-- Name: analysis_study_closures analysis_study_closures_study_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_closures
    ADD CONSTRAINT analysis_study_closures_study_id_key UNIQUE (study_id);


--
-- Name: analysis_study_deadline_retry_state analysis_study_deadline_retry_state_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_deadline_retry_state
    ADD CONSTRAINT analysis_study_deadline_retry_state_pkey PRIMARY KEY (study_id);


--
-- Name: analysis_study_deadline_retry_state analysis_study_deadline_retry_state_project_id_study_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_deadline_retry_state
    ADD CONSTRAINT analysis_study_deadline_retry_state_project_id_study_id_key UNIQUE (project_id, study_id);


--
-- Name: analysis_study_events analysis_study_events_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_events
    ADD CONSTRAINT analysis_study_events_pkey PRIMARY KEY (id);


--
-- Name: analysis_study_events analysis_study_events_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_events
    ADD CONSTRAINT analysis_study_events_project_id_id_key UNIQUE (project_id, id);


--
-- Name: analysis_study_events analysis_study_events_study_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_events
    ADD CONSTRAINT analysis_study_events_study_id_idempotency_key_key UNIQUE (study_id, idempotency_key);


--
-- Name: analysis_study_events analysis_study_events_study_id_version_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_events
    ADD CONSTRAINT analysis_study_events_study_id_version_key UNIQUE (study_id, version);


--
-- Name: analysis_study_item_events analysis_study_item_events_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_item_events
    ADD CONSTRAINT analysis_study_item_events_pkey PRIMARY KEY (id);


--
-- Name: analysis_study_item_events analysis_study_item_events_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_item_events
    ADD CONSTRAINT analysis_study_item_events_project_id_id_key UNIQUE (project_id, id);


--
-- Name: analysis_study_item_events analysis_study_item_events_study_item_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_item_events
    ADD CONSTRAINT analysis_study_item_events_study_item_id_idempotency_key_key UNIQUE (study_item_id, idempotency_key);


--
-- Name: analysis_study_item_events analysis_study_item_events_study_item_id_version_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_item_events
    ADD CONSTRAINT analysis_study_item_events_study_item_id_version_key UNIQUE (study_item_id, version);


--
-- Name: analysis_study_item_views analysis_study_item_views_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_item_views
    ADD CONSTRAINT analysis_study_item_views_pkey PRIMARY KEY (id);


--
-- Name: analysis_study_item_views analysis_study_item_views_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_item_views
    ADD CONSTRAINT analysis_study_item_views_project_id_id_key UNIQUE (project_id, id);


--
-- Name: analysis_study_item_views analysis_study_item_views_study_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_item_views
    ADD CONSTRAINT analysis_study_item_views_study_id_idempotency_key_key UNIQUE (study_id, idempotency_key);


--
-- Name: analysis_study_item_views analysis_study_item_views_study_id_study_item_id_viewer_sub_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_item_views
    ADD CONSTRAINT analysis_study_item_views_study_id_study_item_id_viewer_sub_key UNIQUE (study_id, study_item_id, viewer_subject_id);


--
-- Name: analysis_study_items analysis_study_items_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_items
    ADD CONSTRAINT analysis_study_items_pkey PRIMARY KEY (id);


--
-- Name: analysis_study_items analysis_study_items_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_items
    ADD CONSTRAINT analysis_study_items_project_id_id_key UNIQUE (project_id, id);


--
-- Name: analysis_study_items analysis_study_items_study_id_case_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_items
    ADD CONSTRAINT analysis_study_items_study_id_case_id_key UNIQUE (study_id, case_id);


--
-- Name: analysis_study_items analysis_study_items_study_id_draw_item_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_items
    ADD CONSTRAINT analysis_study_items_study_id_draw_item_id_key UNIQUE (study_id, draw_item_id);


--
-- Name: analysis_study_items analysis_study_items_study_id_member_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_items
    ADD CONSTRAINT analysis_study_items_study_id_member_id_key UNIQUE (study_id, member_id);


--
-- Name: analysis_study_items analysis_study_items_study_id_position_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_items
    ADD CONSTRAINT analysis_study_items_study_id_position_key UNIQUE (study_id, "position");


--
-- Name: api_keys api_keys_key_hash_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY api_keys
    ADD CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: assessment_receipt_artifacts assessment_receipt_artifacts_eval_run_id_contract_version_a_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY assessment_receipt_artifacts
    ADD CONSTRAINT assessment_receipt_artifacts_eval_run_id_contract_version_a_key UNIQUE (eval_run_id, contract_version, artifact_revision);


--
-- Name: assessment_receipt_artifacts assessment_receipt_artifacts_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY assessment_receipt_artifacts
    ADD CONSTRAINT assessment_receipt_artifacts_pkey PRIMARY KEY (id);


--
-- Name: assessment_receipt_artifacts assessment_receipt_artifacts_receipt_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY assessment_receipt_artifacts
    ADD CONSTRAINT assessment_receipt_artifacts_receipt_id_key UNIQUE (receipt_id);


--
-- Name: assessment_receipt_comparisons assessment_receipt_comparison_artifact_id_consumer_artifact_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY assessment_receipt_comparisons
    ADD CONSTRAINT assessment_receipt_comparison_artifact_id_consumer_artifact_key UNIQUE (artifact_id, consumer_artifact_digest);


--
-- Name: assessment_receipt_comparisons assessment_receipt_comparisons_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY assessment_receipt_comparisons
    ADD CONSTRAINT assessment_receipt_comparisons_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: binary_calibration_artifacts binary_calibration_artifacts_artifact_digest_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_artifacts
    ADD CONSTRAINT binary_calibration_artifacts_artifact_digest_key UNIQUE (artifact_digest);


--
-- Name: binary_calibration_artifacts binary_calibration_artifacts_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_artifacts
    ADD CONSTRAINT binary_calibration_artifacts_pkey PRIMARY KEY (id);


--
-- Name: binary_calibration_artifacts binary_calibration_artifacts_private_ledger_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_artifacts
    ADD CONSTRAINT binary_calibration_artifacts_private_ledger_id_key UNIQUE (private_ledger_id);


--
-- Name: binary_calibration_artifacts binary_calibration_artifacts_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_artifacts
    ADD CONSTRAINT binary_calibration_artifacts_project_id_id_key UNIQUE (project_id, id);


--
-- Name: binary_calibration_artifacts binary_calibration_artifacts_run_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_artifacts
    ADD CONSTRAINT binary_calibration_artifacts_run_id_key UNIQUE (run_id);


--
-- Name: binary_calibration_attempts binary_calibration_attempts_commitment_salt_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_attempts
    ADD CONSTRAINT binary_calibration_attempts_commitment_salt_key UNIQUE (commitment_salt);


--
-- Name: binary_calibration_attempts binary_calibration_attempts_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_attempts
    ADD CONSTRAINT binary_calibration_attempts_pkey PRIMARY KEY (id);


--
-- Name: binary_calibration_attempts binary_calibration_attempts_run_id_dataset_revision_item_di_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_attempts
    ADD CONSTRAINT binary_calibration_attempts_run_id_dataset_revision_item_di_key UNIQUE (run_id, dataset_revision_item_digest, trial_index);


--
-- Name: binary_calibration_attempts binary_calibration_attempts_run_id_dataset_revision_item_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_attempts
    ADD CONSTRAINT binary_calibration_attempts_run_id_dataset_revision_item_id_key UNIQUE (run_id, dataset_revision_item_id, trial_index);


--
-- Name: binary_calibration_exposure_checks binary_calibration_exposure_checks_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_exposure_checks
    ADD CONSTRAINT binary_calibration_exposure_checks_pkey PRIMARY KEY (id);


--
-- Name: binary_calibration_exposure_checks binary_calibration_exposure_checks_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_exposure_checks
    ADD CONSTRAINT binary_calibration_exposure_checks_project_id_id_key UNIQUE (project_id, id);


--
-- Name: binary_calibration_exposure_checks binary_calibration_exposure_checks_run_id_phase_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_exposure_checks
    ADD CONSTRAINT binary_calibration_exposure_checks_run_id_phase_key UNIQUE (run_id, phase);


--
-- Name: binary_calibration_private_ledgers binary_calibration_private_ledgers_artifact_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_private_ledgers
    ADD CONSTRAINT binary_calibration_private_ledgers_artifact_id_key UNIQUE (artifact_id);


--
-- Name: binary_calibration_private_ledgers binary_calibration_private_ledgers_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_private_ledgers
    ADD CONSTRAINT binary_calibration_private_ledgers_pkey PRIMARY KEY (id);


--
-- Name: binary_calibration_private_ledgers binary_calibration_private_ledgers_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_private_ledgers
    ADD CONSTRAINT binary_calibration_private_ledgers_project_id_id_key UNIQUE (project_id, id);


--
-- Name: binary_calibration_private_ledgers binary_calibration_private_ledgers_run_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_private_ledgers
    ADD CONSTRAINT binary_calibration_private_ledgers_run_id_key UNIQUE (run_id);


--
-- Name: binary_calibration_revision_leases binary_calibration_revision_leases_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_revision_leases
    ADD CONSTRAINT binary_calibration_revision_leases_pkey PRIMARY KEY (dataset_revision_id);


--
-- Name: binary_calibration_revision_leases binary_calibration_revision_leases_run_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_revision_leases
    ADD CONSTRAINT binary_calibration_revision_leases_run_id_key UNIQUE (run_id);


--
-- Name: binary_calibration_revocation_events binary_calibration_revocation_artifact_id_reason_evidence_r_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_revocation_events
    ADD CONSTRAINT binary_calibration_revocation_artifact_id_reason_evidence_r_key UNIQUE (artifact_id, reason, evidence_ref_kind, evidence_ref_id);


--
-- Name: binary_calibration_revocation_events binary_calibration_revocation_events_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_revocation_events
    ADD CONSTRAINT binary_calibration_revocation_events_pkey PRIMARY KEY (id);


--
-- Name: binary_calibration_revocation_events binary_calibration_revocation_events_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_revocation_events
    ADD CONSTRAINT binary_calibration_revocation_events_project_id_id_key UNIQUE (project_id, id);


--
-- Name: binary_calibration_runs binary_calibration_runs_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_runs
    ADD CONSTRAINT binary_calibration_runs_pkey PRIMARY KEY (id);


--
-- Name: binary_calibration_runs binary_calibration_runs_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_runs
    ADD CONSTRAINT binary_calibration_runs_project_id_id_key UNIQUE (project_id, id);


--
-- Name: binary_calibration_runs binary_calibration_runs_project_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_runs
    ADD CONSTRAINT binary_calibration_runs_project_id_idempotency_key_key UNIQUE (project_id, idempotency_key);


--
-- Name: case_input_identity_records case_input_identity_records_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY case_input_identity_records
    ADD CONSTRAINT case_input_identity_records_pkey PRIMARY KEY (id);


--
-- Name: case_input_identity_records case_input_identity_records_project_id_source_case_id_recor_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY case_input_identity_records
    ADD CONSTRAINT case_input_identity_records_project_id_source_case_id_recor_key UNIQUE (project_id, source_case_id, record_kind);


--
-- Name: cases cases_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY cases
    ADD CONSTRAINT cases_pkey PRIMARY KEY (id);


--
-- Name: criteria criteria_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY criteria
    ADD CONSTRAINT criteria_pkey PRIMARY KEY (id);


--
-- Name: criteria criteria_project_id_stable_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY criteria
    ADD CONSTRAINT criteria_project_id_stable_key_key UNIQUE (project_id, stable_key);


--
-- Name: criterion_regression_revisions criterion_regression_revisions_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY criterion_regression_revisions
    ADD CONSTRAINT criterion_regression_revisions_pkey PRIMARY KEY (project_id, criterion_version_id);


--
-- Name: criterion_regression_revisions criterion_regression_revisions_revision_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY criterion_regression_revisions
    ADD CONSTRAINT criterion_regression_revisions_revision_id_key UNIQUE (revision_id);


--
-- Name: criterion_versions criterion_versions_criterion_id_revision_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY criterion_versions
    ADD CONSTRAINT criterion_versions_criterion_id_revision_key UNIQUE (criterion_id, revision);


--
-- Name: criterion_versions criterion_versions_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY criterion_versions
    ADD CONSTRAINT criterion_versions_pkey PRIMARY KEY (id);


--
-- Name: dataset_exposure_events dataset_exposure_events_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY dataset_exposure_events
    ADD CONSTRAINT dataset_exposure_events_pkey PRIMARY KEY (id);


--
-- Name: dataset_exposure_events dataset_exposure_events_project_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY dataset_exposure_events
    ADD CONSTRAINT dataset_exposure_events_project_id_idempotency_key_key UNIQUE (project_id, idempotency_key);


--
-- Name: dataset_items dataset_items_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY dataset_items
    ADD CONSTRAINT dataset_items_pkey PRIMARY KEY (id);


--
-- Name: dataset_revision_items dataset_revision_items_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY dataset_revision_items
    ADD CONSTRAINT dataset_revision_items_pkey PRIMARY KEY (id);


--
-- Name: dataset_revision_items dataset_revision_items_revision_id_position_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY dataset_revision_items
    ADD CONSTRAINT dataset_revision_items_revision_id_position_key UNIQUE (revision_id, "position");


--
-- Name: dataset_revisions dataset_revisions_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY dataset_revisions
    ADD CONSTRAINT dataset_revisions_pkey PRIMARY KEY (id);


--
-- Name: dataset_revisions dataset_revisions_project_id_series_id_revision_number_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY dataset_revisions
    ADD CONSTRAINT dataset_revisions_project_id_series_id_revision_number_key UNIQUE (project_id, series_id, revision_number);


--
-- Name: datasets datasets_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY datasets
    ADD CONSTRAINT datasets_pkey PRIMARY KEY (id);


--
-- Name: eval_run_items eval_run_items_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY eval_run_items
    ADD CONSTRAINT eval_run_items_pkey PRIMARY KEY (id);


--
-- Name: eval_runs eval_runs_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY eval_runs
    ADD CONSTRAINT eval_runs_pkey PRIMARY KEY (id);


--
-- Name: evaluator_execution_authorizations evaluator_execution_authorizatio_project_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_execution_authorizations
    ADD CONSTRAINT evaluator_execution_authorizatio_project_id_idempotency_key_key UNIQUE (project_id, idempotency_key);


--
-- Name: evaluator_execution_authorizations evaluator_execution_authorizations_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_execution_authorizations
    ADD CONSTRAINT evaluator_execution_authorizations_pkey PRIMARY KEY (id);


--
-- Name: evaluator_execution_authorizations evaluator_execution_authorizations_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_execution_authorizations
    ADD CONSTRAINT evaluator_execution_authorizations_project_id_id_key UNIQUE (project_id, id);


--
-- Name: evaluator_lifecycle_events evaluator_lifecycle_events_lifecycle_id_sequence_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycle_events
    ADD CONSTRAINT evaluator_lifecycle_events_lifecycle_id_sequence_key UNIQUE (lifecycle_id, sequence);


--
-- Name: evaluator_lifecycle_events evaluator_lifecycle_events_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycle_events
    ADD CONSTRAINT evaluator_lifecycle_events_pkey PRIMARY KEY (id);


--
-- Name: evaluator_lifecycle_events evaluator_lifecycle_events_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycle_events
    ADD CONSTRAINT evaluator_lifecycle_events_project_id_id_key UNIQUE (project_id, id);


--
-- Name: evaluator_lifecycle_events evaluator_lifecycle_events_project_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycle_events
    ADD CONSTRAINT evaluator_lifecycle_events_project_id_idempotency_key_key UNIQUE (project_id, idempotency_key);


--
-- Name: evaluator_lifecycles evaluator_lifecycles_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycles
    ADD CONSTRAINT evaluator_lifecycles_pkey PRIMARY KEY (id);


--
-- Name: evaluator_lifecycles evaluator_lifecycles_project_id_criterion_id_skill_version__key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycles
    ADD CONSTRAINT evaluator_lifecycles_project_id_criterion_id_skill_version__key UNIQUE (project_id, criterion_id, skill_version_id);


--
-- Name: evaluator_lifecycles evaluator_lifecycles_project_id_developer_exposure_event_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycles
    ADD CONSTRAINT evaluator_lifecycles_project_id_developer_exposure_event_id_key UNIQUE (project_id, developer_exposure_event_id);


--
-- Name: evaluator_lifecycles evaluator_lifecycles_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycles
    ADD CONSTRAINT evaluator_lifecycles_project_id_id_key UNIQUE (project_id, id);


--
-- Name: evaluator_lifecycles evaluator_lifecycles_project_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycles
    ADD CONSTRAINT evaluator_lifecycles_project_id_idempotency_key_key UNIQUE (project_id, idempotency_key);


--
-- Name: evaluator_lifecycles evaluator_lifecycles_project_id_skill_version_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycles
    ADD CONSTRAINT evaluator_lifecycles_project_id_skill_version_id_key UNIQUE (project_id, skill_version_id);


--
-- Name: evaluator_suite_manifest_members evaluator_suite_manifest_memb_manifest_id_criterion_version_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_suite_manifest_members
    ADD CONSTRAINT evaluator_suite_manifest_memb_manifest_id_criterion_version_key UNIQUE (manifest_id, criterion_version_id);


--
-- Name: evaluator_suite_manifest_members evaluator_suite_manifest_membe_manifest_id_skill_version_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_suite_manifest_members
    ADD CONSTRAINT evaluator_suite_manifest_membe_manifest_id_skill_version_id_key UNIQUE (manifest_id, skill_version_id);


--
-- Name: evaluator_suite_manifest_members evaluator_suite_manifest_members_manifest_id_criterion_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_suite_manifest_members
    ADD CONSTRAINT evaluator_suite_manifest_members_manifest_id_criterion_id_key UNIQUE (manifest_id, criterion_id);


--
-- Name: evaluator_suite_manifest_members evaluator_suite_manifest_members_manifest_id_skill_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_suite_manifest_members
    ADD CONSTRAINT evaluator_suite_manifest_members_manifest_id_skill_id_key UNIQUE (manifest_id, skill_id);


--
-- Name: evaluator_suite_manifest_members evaluator_suite_manifest_members_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_suite_manifest_members
    ADD CONSTRAINT evaluator_suite_manifest_members_pkey PRIMARY KEY (manifest_id, "position");


--
-- Name: evaluator_suite_manifests evaluator_suite_manifests_manifest_digest_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_suite_manifests
    ADD CONSTRAINT evaluator_suite_manifests_manifest_digest_key UNIQUE (manifest_digest);


--
-- Name: evaluator_suite_manifests evaluator_suite_manifests_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_suite_manifests
    ADD CONSTRAINT evaluator_suite_manifests_pkey PRIMARY KEY (id);


--
-- Name: evaluator_suite_manifests evaluator_suite_manifests_project_idempotency_unique; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_suite_manifests
    ADD CONSTRAINT evaluator_suite_manifests_project_idempotency_unique UNIQUE (project_id, idempotency_key);


--
-- Name: evaluator_suite_manifests evaluator_suite_manifests_suite_id_revision_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_suite_manifests
    ADD CONSTRAINT evaluator_suite_manifests_suite_id_revision_key UNIQUE (suite_id, revision);


--
-- Name: evaluator_suites evaluator_suites_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_suites
    ADD CONSTRAINT evaluator_suites_pkey PRIMARY KEY (id);


--
-- Name: evaluator_suites evaluator_suites_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_suites
    ADD CONSTRAINT evaluator_suites_project_id_id_key UNIQUE (project_id, id);


--
-- Name: feedback_sync_jobs feedback_sync_jobs_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY feedback_sync_jobs
    ADD CONSTRAINT feedback_sync_jobs_pkey PRIMARY KEY (id);


--
-- Name: gate_check_items gate_check_items_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY gate_check_items
    ADD CONSTRAINT gate_check_items_pkey PRIMARY KEY (id);


--
-- Name: gate_checks gate_checks_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY gate_checks
    ADD CONSTRAINT gate_checks_pkey PRIMARY KEY (id);


--
-- Name: golden_set_entries golden_set_entries_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY golden_set_entries
    ADD CONSTRAINT golden_set_entries_pkey PRIMARY KEY (id);


--
-- Name: governed_dataset_truth_link_labels governed_dataset_truth_link_labels_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_dataset_truth_link_labels
    ADD CONSTRAINT governed_dataset_truth_link_labels_pkey PRIMARY KEY (truth_link_id, label_id);


--
-- Name: governed_dataset_truth_links governed_dataset_truth_links_dataset_revision_item_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_dataset_truth_links
    ADD CONSTRAINT governed_dataset_truth_links_dataset_revision_item_id_key UNIQUE (dataset_revision_item_id);


--
-- Name: governed_dataset_truth_links governed_dataset_truth_links_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_dataset_truth_links
    ADD CONSTRAINT governed_dataset_truth_links_pkey PRIMARY KEY (id);


--
-- Name: governed_dataset_truth_links governed_dataset_truth_links_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_dataset_truth_links
    ADD CONSTRAINT governed_dataset_truth_links_project_id_id_key UNIQUE (project_id, id);


--
-- Name: governed_dataset_truth_links governed_dataset_truth_links_project_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_dataset_truth_links
    ADD CONSTRAINT governed_dataset_truth_links_project_id_idempotency_key_key UNIQUE (project_id, idempotency_key);


--
-- Name: governed_evaluator_development_events governed_evaluator_developmen_skill_version_id_developer_su_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_evaluator_development_events
    ADD CONSTRAINT governed_evaluator_developmen_skill_version_id_developer_su_key UNIQUE (skill_version_id, developer_subject_id);


--
-- Name: governed_evaluator_development_events governed_evaluator_development_events_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_evaluator_development_events
    ADD CONSTRAINT governed_evaluator_development_events_pkey PRIMARY KEY (id);


--
-- Name: governed_evaluator_development_events governed_evaluator_development_events_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_evaluator_development_events
    ADD CONSTRAINT governed_evaluator_development_events_project_id_id_key UNIQUE (project_id, id);


--
-- Name: governed_imported_truth governed_imported_truth_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_imported_truth
    ADD CONSTRAINT governed_imported_truth_pkey PRIMARY KEY (id);


--
-- Name: governed_imported_truth governed_imported_truth_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_imported_truth
    ADD CONSTRAINT governed_imported_truth_project_id_id_key UNIQUE (project_id, id);


--
-- Name: governed_imported_truth governed_imported_truth_project_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_imported_truth
    ADD CONSTRAINT governed_imported_truth_project_id_idempotency_key_key UNIQUE (project_id, idempotency_key);


--
-- Name: governed_input_identity_claims governed_input_identity_claims_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_input_identity_claims
    ADD CONSTRAINT governed_input_identity_claims_pkey PRIMARY KEY (project_id, input_digest);


--
-- Name: governed_review_adjudication_labels governed_review_adjudication_labels_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_adjudication_labels
    ADD CONSTRAINT governed_review_adjudication_labels_pkey PRIMARY KEY (adjudication_id, label_id);


--
-- Name: governed_review_adjudications governed_review_adjudications_batch_item_id_chain_version_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_adjudications
    ADD CONSTRAINT governed_review_adjudications_batch_item_id_chain_version_key UNIQUE (batch_item_id, chain_version);


--
-- Name: governed_review_adjudications governed_review_adjudications_batch_item_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_adjudications
    ADD CONSTRAINT governed_review_adjudications_batch_item_id_idempotency_key_key UNIQUE (batch_item_id, idempotency_key);


--
-- Name: governed_review_adjudications governed_review_adjudications_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_adjudications
    ADD CONSTRAINT governed_review_adjudications_pkey PRIMARY KEY (id);


--
-- Name: governed_review_adjudications governed_review_adjudications_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_adjudications
    ADD CONSTRAINT governed_review_adjudications_project_id_id_key UNIQUE (project_id, id);


--
-- Name: governed_review_alignment_event_labels governed_review_alignment_event_labels_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_alignment_event_labels
    ADD CONSTRAINT governed_review_alignment_event_labels_pkey PRIMARY KEY (alignment_event_id, label_id);


--
-- Name: governed_review_alignment_events governed_review_alignment_events_batch_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_alignment_events
    ADD CONSTRAINT governed_review_alignment_events_batch_id_idempotency_key_key UNIQUE (batch_id, idempotency_key);


--
-- Name: governed_review_alignment_events governed_review_alignment_events_batch_id_sequence_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_alignment_events
    ADD CONSTRAINT governed_review_alignment_events_batch_id_sequence_key UNIQUE (batch_id, sequence);


--
-- Name: governed_review_alignment_events governed_review_alignment_events_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_alignment_events
    ADD CONSTRAINT governed_review_alignment_events_pkey PRIMARY KEY (id);


--
-- Name: governed_review_alignment_events governed_review_alignment_events_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_alignment_events
    ADD CONSTRAINT governed_review_alignment_events_project_id_id_key UNIQUE (project_id, id);


--
-- Name: governed_review_batch_events governed_review_batch_events_batch_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_batch_events
    ADD CONSTRAINT governed_review_batch_events_batch_id_idempotency_key_key UNIQUE (batch_id, idempotency_key);


--
-- Name: governed_review_batch_events governed_review_batch_events_batch_id_sequence_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_batch_events
    ADD CONSTRAINT governed_review_batch_events_batch_id_sequence_key UNIQUE (batch_id, sequence);


--
-- Name: governed_review_batch_events governed_review_batch_events_batch_id_state_version_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_batch_events
    ADD CONSTRAINT governed_review_batch_events_batch_id_state_version_key UNIQUE (batch_id, state_version);


--
-- Name: governed_review_batch_events governed_review_batch_events_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_batch_events
    ADD CONSTRAINT governed_review_batch_events_pkey PRIMARY KEY (id);


--
-- Name: governed_review_batch_events governed_review_batch_events_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_batch_events
    ADD CONSTRAINT governed_review_batch_events_project_id_id_key UNIQUE (project_id, id);


--
-- Name: governed_review_batch_items governed_review_batch_items_batch_id_draw_position_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_batch_items
    ADD CONSTRAINT governed_review_batch_items_batch_id_draw_position_key UNIQUE (batch_id, draw_position);


--
-- Name: governed_review_batch_items governed_review_batch_items_batch_id_review_item_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_batch_items
    ADD CONSTRAINT governed_review_batch_items_batch_id_review_item_id_key UNIQUE (batch_id, review_item_id);


--
-- Name: governed_review_batch_items governed_review_batch_items_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_batch_items
    ADD CONSTRAINT governed_review_batch_items_pkey PRIMARY KEY (id);


--
-- Name: governed_review_batch_items governed_review_batch_items_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_batch_items
    ADD CONSTRAINT governed_review_batch_items_project_id_id_key UNIQUE (project_id, id);


--
-- Name: governed_review_batches governed_review_batches_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_batches
    ADD CONSTRAINT governed_review_batches_pkey PRIMARY KEY (id);


--
-- Name: governed_review_batches governed_review_batches_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_batches
    ADD CONSTRAINT governed_review_batches_project_id_id_key UNIQUE (project_id, id);


--
-- Name: governed_review_batches governed_review_batches_project_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_batches
    ADD CONSTRAINT governed_review_batches_project_id_idempotency_key_key UNIQUE (project_id, idempotency_key);


--
-- Name: governed_review_capability_checks governed_review_capability_check_project_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_capability_checks
    ADD CONSTRAINT governed_review_capability_check_project_id_idempotency_key_key UNIQUE (project_id, idempotency_key);


--
-- Name: governed_review_capability_checks governed_review_capability_checks_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_capability_checks
    ADD CONSTRAINT governed_review_capability_checks_pkey PRIMARY KEY (id);


--
-- Name: governed_review_capability_checks governed_review_capability_checks_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_capability_checks
    ADD CONSTRAINT governed_review_capability_checks_project_id_id_key UNIQUE (project_id, id);


--
-- Name: governed_review_items governed_review_items_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_items
    ADD CONSTRAINT governed_review_items_pkey PRIMARY KEY (id);


--
-- Name: governed_review_items governed_review_items_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_items
    ADD CONSTRAINT governed_review_items_project_id_id_key UNIQUE (project_id, id);


--
-- Name: governed_review_items governed_review_items_project_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_items
    ADD CONSTRAINT governed_review_items_project_id_idempotency_key_key UNIQUE (project_id, idempotency_key);


--
-- Name: governed_review_labels governed_review_labels_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_labels
    ADD CONSTRAINT governed_review_labels_pkey PRIMARY KEY (id);


--
-- Name: governed_review_labels governed_review_labels_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_labels
    ADD CONSTRAINT governed_review_labels_project_id_id_key UNIQUE (project_id, id);


--
-- Name: governed_review_labels governed_review_labels_task_id_attempt_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_labels
    ADD CONSTRAINT governed_review_labels_task_id_attempt_key UNIQUE (task_id, attempt);


--
-- Name: governed_review_labels governed_review_labels_task_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_labels
    ADD CONSTRAINT governed_review_labels_task_id_idempotency_key_key UNIQUE (task_id, idempotency_key);


--
-- Name: governed_review_task_events governed_review_task_events_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_task_events
    ADD CONSTRAINT governed_review_task_events_pkey PRIMARY KEY (id);


--
-- Name: governed_review_task_events governed_review_task_events_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_task_events
    ADD CONSTRAINT governed_review_task_events_project_id_id_key UNIQUE (project_id, id);


--
-- Name: governed_review_task_events governed_review_task_events_task_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_task_events
    ADD CONSTRAINT governed_review_task_events_task_id_idempotency_key_key UNIQUE (task_id, idempotency_key);


--
-- Name: governed_review_task_events governed_review_task_events_task_id_sequence_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_task_events
    ADD CONSTRAINT governed_review_task_events_task_id_sequence_key UNIQUE (task_id, sequence);


--
-- Name: governed_review_task_events governed_review_task_events_task_id_state_version_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_task_events
    ADD CONSTRAINT governed_review_task_events_task_id_state_version_key UNIQUE (task_id, state_version);


--
-- Name: governed_review_tasks governed_review_tasks_batch_id_reviewer_subject_id_serve_or_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_tasks
    ADD CONSTRAINT governed_review_tasks_batch_id_reviewer_subject_id_serve_or_key UNIQUE (batch_id, reviewer_subject_id, serve_order);


--
-- Name: governed_review_tasks governed_review_tasks_batch_item_id_reviewer_subject_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_tasks
    ADD CONSTRAINT governed_review_tasks_batch_item_id_reviewer_subject_id_key UNIQUE (batch_item_id, reviewer_subject_id);


--
-- Name: governed_review_tasks governed_review_tasks_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_tasks
    ADD CONSTRAINT governed_review_tasks_pkey PRIMARY KEY (id);


--
-- Name: governed_review_tasks governed_review_tasks_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_tasks
    ADD CONSTRAINT governed_review_tasks_project_id_id_key UNIQUE (project_id, id);


--
-- Name: governed_review_tasks governed_review_tasks_project_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_tasks
    ADD CONSTRAINT governed_review_tasks_project_id_idempotency_key_key UNIQUE (project_id, idempotency_key);


--
-- Name: governed_reviewer_subjects governed_reviewer_subjects_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_reviewer_subjects
    ADD CONSTRAINT governed_reviewer_subjects_pkey PRIMARY KEY (id);


--
-- Name: governed_reviewer_subjects governed_reviewer_subjects_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_reviewer_subjects
    ADD CONSTRAINT governed_reviewer_subjects_project_id_id_key UNIQUE (project_id, id);


--
-- Name: governed_sealed_intake_populations governed_sealed_intake_populatio_project_id_idempotency_key_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_sealed_intake_populations
    ADD CONSTRAINT governed_sealed_intake_populatio_project_id_idempotency_key_key UNIQUE (project_id, idempotency_key);


--
-- Name: governed_sealed_intake_populations governed_sealed_intake_populations_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_sealed_intake_populations
    ADD CONSTRAINT governed_sealed_intake_populations_pkey PRIMARY KEY (id);


--
-- Name: governed_sealed_intake_populations governed_sealed_intake_populations_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_sealed_intake_populations
    ADD CONSTRAINT governed_sealed_intake_populations_project_id_id_key UNIQUE (project_id, id);


--
-- Name: import_jobs import_jobs_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY import_jobs
    ADD CONSTRAINT import_jobs_pkey PRIMARY KEY (id);


--
-- Name: integrations integrations_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY integrations
    ADD CONSTRAINT integrations_pkey PRIMARY KEY (id);


--
-- Name: invitations invitations_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY invitations
    ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);


--
-- Name: invitations invitations_token_hash_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY invitations
    ADD CONSTRAINT invitations_token_hash_key UNIQUE (token_hash);


--
-- Name: judge_provider_keys judge_provider_keys_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY judge_provider_keys
    ADD CONSTRAINT judge_provider_keys_pkey PRIMARY KEY (id);


--
-- Name: judge_provider_keys judge_provider_keys_project_id_provider_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY judge_provider_keys
    ADD CONSTRAINT judge_provider_keys_project_id_provider_key UNIQUE (project_id, provider);


--
-- Name: judge_runs judge_runs_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY judge_runs
    ADD CONSTRAINT judge_runs_pkey PRIMARY KEY (id);


--
-- Name: organization_members organization_members_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY organization_members
    ADD CONSTRAINT organization_members_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);


--
-- Name: project_members project_members_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY project_members
    ADD CONSTRAINT project_members_pkey PRIMARY KEY (id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: raw_traces raw_traces_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY raw_traces
    ADD CONSTRAINT raw_traces_pkey PRIMARY KEY (id);


--
-- Name: regression_runs regression_runs_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY regression_runs
    ADD CONSTRAINT regression_runs_pkey PRIMARY KEY (id);


--
-- Name: review_instruction_versions review_instruction_versions_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY review_instruction_versions
    ADD CONSTRAINT review_instruction_versions_pkey PRIMARY KEY (id);


--
-- Name: review_instruction_versions review_instruction_versions_project_id_criterion_version_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY review_instruction_versions
    ADD CONSTRAINT review_instruction_versions_project_id_criterion_version_id_key UNIQUE (project_id, criterion_version_id, revision);


--
-- Name: review_instruction_versions review_instruction_versions_project_id_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY review_instruction_versions
    ADD CONSTRAINT review_instruction_versions_project_id_id_key UNIQUE (project_id, id);


--
-- Name: review_queue_items review_queue_items_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY review_queue_items
    ADD CONSTRAINT review_queue_items_pkey PRIMARY KEY (id);


--
-- Name: review_queues review_queues_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY review_queues
    ADD CONSTRAINT review_queues_pkey PRIMARY KEY (id);


--
-- Name: run_comparisons run_comparisons_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY run_comparisons
    ADD CONSTRAINT run_comparisons_pkey PRIMARY KEY (id);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY session
    ADD CONSTRAINT session_token_key UNIQUE (token);


--
-- Name: skill_versions skill_versions_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY skill_versions
    ADD CONSTRAINT skill_versions_pkey PRIMARY KEY (id);


--
-- Name: skills skills_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY skills
    ADD CONSTRAINT skills_pkey PRIMARY KEY (id);


--
-- Name: trace_test_revisions trace_test_revisions_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY trace_test_revisions
    ADD CONSTRAINT trace_test_revisions_pkey PRIMARY KEY (id);


--
-- Name: trace_test_revisions trace_test_revisions_trace_test_id_revision_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY trace_test_revisions
    ADD CONSTRAINT trace_test_revisions_trace_test_id_revision_key UNIQUE (trace_test_id, revision);


--
-- Name: trace_test_validations trace_test_validations_id_trace_test_id_revision_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY trace_test_validations
    ADD CONSTRAINT trace_test_validations_id_trace_test_id_revision_key UNIQUE (id, trace_test_id, revision);


--
-- Name: trace_test_validations trace_test_validations_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY trace_test_validations
    ADD CONSTRAINT trace_test_validations_pkey PRIMARY KEY (id);


--
-- Name: trace_test_validations trace_test_validations_project_identity_unique; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY trace_test_validations
    ADD CONSTRAINT trace_test_validations_project_identity_unique UNIQUE (project_id, trace_test_id, revision, id);


--
-- Name: trace_tests trace_tests_id_project_id_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY trace_tests
    ADD CONSTRAINT trace_tests_id_project_id_key UNIQUE (id, project_id);


--
-- Name: trace_tests trace_tests_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY trace_tests
    ADD CONSTRAINT trace_tests_pkey PRIMARY KEY (id);


--
-- Name: user user_email_key; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY "user"
    ADD CONSTRAINT user_email_key UNIQUE (email);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY "user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: verdicts verdicts_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY verdicts
    ADD CONSTRAINT verdicts_pkey PRIMARY KEY (id);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: agent_setup_pairings_expiry_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX agent_setup_pairings_expiry_idx ON agent_setup_pairings USING btree (expires_at) WHERE ((consumed_at IS NULL) AND (revoked_at IS NULL));


--
-- Name: agent_setup_pairings_project_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX agent_setup_pairings_project_idx ON agent_setup_pairings USING btree (project_id, created_at DESC);


--
-- Name: analysis_criterion_promotion_supports_author_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX analysis_criterion_promotion_supports_author_idx ON analysis_criterion_promotion_supports USING btree (project_id, observation_author_subject_id, promotion_id);


--
-- Name: analysis_criterion_promotion_supports_promotion_position_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX analysis_criterion_promotion_supports_promotion_position_idx ON analysis_criterion_promotion_supports USING btree (promotion_id, "position");


--
-- Name: analysis_criterion_promotions_project_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX analysis_criterion_promotions_project_created_idx ON analysis_criterion_promotions USING btree (project_id, created_at DESC, id DESC);


--
-- Name: analysis_criterion_promotions_revision_criterion_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX analysis_criterion_promotions_revision_criterion_idx ON analysis_criterion_promotions USING btree (source_dataset_revision_id, criterion_version_id, id);


--
-- Name: analysis_failure_taxonomy_revision_codes_active_label_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX analysis_failure_taxonomy_revision_codes_active_label_unique ON analysis_failure_taxonomy_revision_codes USING btree (taxonomy_revision_id, label) WHERE (status = 'active'::text);


--
-- Name: analysis_failure_taxonomy_revision_codes_exact_identity_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX analysis_failure_taxonomy_revision_codes_exact_identity_unique ON analysis_failure_taxonomy_revision_codes USING btree (id, project_id, taxonomy_id, taxonomy_revision_id, code_id, entry_digest);


--
-- Name: analysis_failure_taxonomy_revision_codes_revision_position_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX analysis_failure_taxonomy_revision_codes_revision_position_idx ON analysis_failure_taxonomy_revision_codes USING btree (taxonomy_revision_id, "position");


--
-- Name: analysis_failure_taxonomy_revisions_exact_identity_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX analysis_failure_taxonomy_revisions_exact_identity_unique ON analysis_failure_taxonomy_revisions USING btree (id, project_id, taxonomy_id, revision_digest);


--
-- Name: analysis_failure_taxonomy_revisions_initial_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX analysis_failure_taxonomy_revisions_initial_unique ON analysis_failure_taxonomy_revisions USING btree (taxonomy_id) WHERE (predecessor_revision_id IS NULL);


--
-- Name: analysis_failure_taxonomy_revisions_predecessor_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX analysis_failure_taxonomy_revisions_predecessor_unique ON analysis_failure_taxonomy_revisions USING btree (taxonomy_id, predecessor_revision_id) WHERE (predecessor_revision_id IS NOT NULL);


--
-- Name: analysis_failure_taxonomy_revisions_taxonomy_sequence_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX analysis_failure_taxonomy_revisions_taxonomy_sequence_idx ON analysis_failure_taxonomy_revisions USING btree (taxonomy_id, sequence);


--
-- Name: analysis_observation_assignment_events_exact_identity_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX analysis_observation_assignment_events_exact_identity_unique ON analysis_observation_assignment_events USING btree (id, project_id, observation_event_id, event_digest);


--
-- Name: analysis_observation_assignment_events_observation_version_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX analysis_observation_assignment_events_observation_version_idx ON analysis_observation_assignment_events USING btree (observation_event_id, version);


--
-- Name: analysis_observation_assignment_events_predecessor_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX analysis_observation_assignment_events_predecessor_unique ON analysis_observation_assignment_events USING btree (observation_event_id, predecessor_event_id) WHERE (predecessor_event_id IS NOT NULL);


--
-- Name: analysis_observation_assignment_events_support_identity_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX analysis_observation_assignment_events_support_identity_unique ON analysis_observation_assignment_events USING btree (id, project_id, study_id, study_item_id, observation_event_id, event_digest);


--
-- Name: analysis_population_draw_items_draw_position_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX analysis_population_draw_items_draw_position_idx ON analysis_population_draw_items USING btree (draw_id, "position");


--
-- Name: analysis_population_draw_items_id_project_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX analysis_population_draw_items_id_project_unique ON analysis_population_draw_items USING btree (id, project_id);


--
-- Name: analysis_population_draws_id_project_population_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX analysis_population_draws_id_project_population_unique ON analysis_population_draws USING btree (id, project_id, population_id);


--
-- Name: analysis_population_exclusions_population_position_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX analysis_population_exclusions_population_position_idx ON analysis_population_exclusions USING btree (population_id, "position");


--
-- Name: analysis_population_members_id_project_population_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX analysis_population_members_id_project_population_unique ON analysis_population_members USING btree (id, project_id, population_id);


--
-- Name: analysis_population_members_population_position_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX analysis_population_members_population_position_idx ON analysis_population_members USING btree (population_id, "position");


--
-- Name: analysis_population_members_project_case_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX analysis_population_members_project_case_idx ON analysis_population_members USING btree (project_id, case_id);


--
-- Name: analysis_population_requests_population_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX analysis_population_requests_population_idx ON analysis_population_requests USING btree (population_id, created_at, id);


--
-- Name: analysis_populations_project_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX analysis_populations_project_created_idx ON analysis_populations USING btree (project_id, created_at DESC, id DESC);


--
-- Name: analysis_studies_exact_identity_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX analysis_studies_exact_identity_unique ON analysis_studies USING btree (id, project_id, population_id, draw_id, dataset_revision_id);


--
-- Name: analysis_studies_project_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX analysis_studies_project_created_idx ON analysis_studies USING btree (project_id, created_at DESC, id DESC);


--
-- Name: analysis_study_closure_items_closure_position_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX analysis_study_closure_items_closure_position_idx ON analysis_study_closure_items USING btree (closure_id, "position");


--
-- Name: analysis_study_closure_items_exact_identity_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX analysis_study_closure_items_exact_identity_unique ON analysis_study_closure_items USING btree (id, project_id, study_id, closure_id, content_digest);


--
-- Name: analysis_study_closures_exact_identity_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX analysis_study_closures_exact_identity_unique ON analysis_study_closures USING btree (id, project_id, study_id, closure_digest);


--
-- Name: analysis_study_deadline_retry_due_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX analysis_study_deadline_retry_due_idx ON analysis_study_deadline_retry_state USING btree (project_id, next_retry_at, study_id);


--
-- Name: analysis_study_events_exact_identity_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX analysis_study_events_exact_identity_unique ON analysis_study_events USING btree (id, project_id, study_id, event_digest);


--
-- Name: analysis_study_events_predecessor_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX analysis_study_events_predecessor_unique ON analysis_study_events USING btree (study_id, predecessor_event_id) WHERE (predecessor_event_id IS NOT NULL);


--
-- Name: analysis_study_events_study_version_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX analysis_study_events_study_version_idx ON analysis_study_events USING btree (study_id, version);


--
-- Name: analysis_study_item_events_exact_identity_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX analysis_study_item_events_exact_identity_unique ON analysis_study_item_events USING btree (id, project_id, study_id, study_item_id, event_digest);


--
-- Name: analysis_study_item_events_item_version_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX analysis_study_item_events_item_version_idx ON analysis_study_item_events USING btree (study_item_id, version);


--
-- Name: analysis_study_item_events_predecessor_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX analysis_study_item_events_predecessor_unique ON analysis_study_item_events USING btree (study_item_id, predecessor_event_id) WHERE (predecessor_event_id IS NOT NULL);


--
-- Name: analysis_study_items_exact_identity_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX analysis_study_items_exact_identity_unique ON analysis_study_items USING btree (id, project_id, study_id, draw_item_id, case_id);


--
-- Name: analysis_study_items_id_project_study_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX analysis_study_items_id_project_study_unique ON analysis_study_items USING btree (id, project_id, study_id);


--
-- Name: analysis_study_items_study_position_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX analysis_study_items_study_position_idx ON analysis_study_items USING btree (study_id, "position");


--
-- Name: api_keys_hash_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX api_keys_hash_idx ON api_keys USING btree (key_hash) WHERE (revoked_at IS NULL);


--
-- Name: api_keys_project_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX api_keys_project_created_idx ON api_keys USING btree (project_id, created_at DESC);


--
-- Name: assessment_receipt_artifacts_lineage_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX assessment_receipt_artifacts_lineage_idx ON assessment_receipt_artifacts USING btree (eval_run_id, contract_version, artifact_revision);


--
-- Name: assessment_receipt_artifacts_project_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX assessment_receipt_artifacts_project_created_idx ON assessment_receipt_artifacts USING btree (project_id, created_at DESC, id DESC);


--
-- Name: assessment_receipt_artifacts_root_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX assessment_receipt_artifacts_root_unique ON assessment_receipt_artifacts USING btree (eval_run_id, contract_version) WHERE (artifact_revision = 1);


--
-- Name: assessment_receipt_comparisons_project_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX assessment_receipt_comparisons_project_created_idx ON assessment_receipt_comparisons USING btree (project_id, created_at DESC, id DESC);


--
-- Name: audit_logs_trace_test_funnel_unique_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX audit_logs_trace_test_funnel_unique_idx ON audit_logs USING btree (project_id, target_id, action) WHERE (target_type = 'trace_test_funnel'::text);


--
-- Name: binary_calibration_attempts_next_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX binary_calibration_attempts_next_idx ON binary_calibration_attempts USING btree (run_id, accounting_state, trial_index, dataset_revision_item_digest);


--
-- Name: binary_calibration_one_active_revision_skill_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX binary_calibration_one_active_revision_skill_idx ON binary_calibration_runs USING btree (dataset_revision_id, skill_version_id) WHERE (state = ANY (ARRAY['queued'::text, 'running'::text, 'recovery_required'::text]));


--
-- Name: binary_calibration_runs_project_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX binary_calibration_runs_project_created_idx ON binary_calibration_runs USING btree (project_id, created_at DESC, id DESC);


--
-- Name: binary_calibration_runs_runnable_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX binary_calibration_runs_runnable_idx ON binary_calibration_runs USING btree (state, claim_expires_at, created_at, id) WHERE (state = ANY (ARRAY['queued'::text, 'running'::text, 'recovery_required'::text]));


--
-- Name: case_input_identity_records_project_digest_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX case_input_identity_records_project_digest_idx ON case_input_identity_records USING btree (project_id, input_digest) WHERE (input_digest IS NOT NULL);


--
-- Name: cases_id_project_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX cases_id_project_unique ON cases USING btree (id, project_id);


--
-- Name: cases_project_created_id_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX cases_project_created_id_idx ON cases USING btree (project_id, created_at, id);


--
-- Name: cases_project_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX cases_project_idx ON cases USING btree (project_id);


--
-- Name: cases_project_raw_trace_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX cases_project_raw_trace_idx ON cases USING btree (project_id, raw_trace_id);


--
-- Name: criteria_id_project_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX criteria_id_project_unique ON criteria USING btree (id, project_id);


--
-- Name: criteria_project_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX criteria_project_created_idx ON criteria USING btree (project_id, created_at, id);


--
-- Name: criterion_regression_revisions_revision_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX criterion_regression_revisions_revision_idx ON criterion_regression_revisions USING btree (revision_id);


--
-- Name: criterion_versions_criterion_revision_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX criterion_versions_criterion_revision_idx ON criterion_versions USING btree (criterion_id, revision DESC);


--
-- Name: criterion_versions_exact_identity_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX criterion_versions_exact_identity_unique ON criterion_versions USING btree (id, project_id, criterion_id, criterion_digest);


--
-- Name: criterion_versions_project_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX criterion_versions_project_created_idx ON criterion_versions USING btree (project_id, created_at, id);


--
-- Name: dataset_exposure_events_id_project_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX dataset_exposure_events_id_project_unique ON dataset_exposure_events USING btree (id, project_id);


--
-- Name: dataset_exposure_events_revision_time_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX dataset_exposure_events_revision_time_idx ON dataset_exposure_events USING btree (revision_id, occurred_at, id);


--
-- Name: dataset_items_dataset_case_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX dataset_items_dataset_case_unique ON dataset_items USING btree (dataset_id, case_id);


--
-- Name: dataset_items_project_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX dataset_items_project_idx ON dataset_items USING btree (project_id);


--
-- Name: dataset_revision_items_id_project_revision_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX dataset_revision_items_id_project_revision_unique ON dataset_revision_items USING btree (id, project_id, revision_id);


--
-- Name: dataset_revision_items_id_project_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX dataset_revision_items_id_project_unique ON dataset_revision_items USING btree (id, project_id);


--
-- Name: dataset_revision_items_project_input_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX dataset_revision_items_project_input_idx ON dataset_revision_items USING btree (project_id, input_digest);


--
-- Name: dataset_revision_items_revision_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX dataset_revision_items_revision_idx ON dataset_revision_items USING btree (revision_id, "position");


--
-- Name: dataset_revisions_analysis_population_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX dataset_revisions_analysis_population_unique ON dataset_revisions USING btree (analysis_population_id) WHERE (analysis_population_id IS NOT NULL);


--
-- Name: dataset_revisions_id_project_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX dataset_revisions_id_project_unique ON dataset_revisions USING btree (id, project_id);


--
-- Name: dataset_revisions_parent_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX dataset_revisions_parent_idx ON dataset_revisions USING btree (parent_revision_id);


--
-- Name: dataset_revisions_project_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX dataset_revisions_project_created_idx ON dataset_revisions USING btree (project_id, created_at DESC, id DESC);


--
-- Name: dataset_revisions_project_idempotency_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX dataset_revisions_project_idempotency_unique ON dataset_revisions USING btree (project_id, idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: dataset_revisions_series_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX dataset_revisions_series_idx ON dataset_revisions USING btree (project_id, series_id, revision_number DESC);


--
-- Name: datasets_project_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX datasets_project_created_idx ON datasets USING btree (project_id, created_at DESC);


--
-- Name: datasets_project_name_active_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX datasets_project_name_active_unique ON datasets USING btree (project_id, name) WHERE (archived_at IS NULL);


--
-- Name: eval_run_items_dataset_revision_item_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX eval_run_items_dataset_revision_item_idx ON eval_run_items USING btree (dataset_revision_item_id);


--
-- Name: eval_run_items_run_case_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX eval_run_items_run_case_idx ON eval_run_items USING btree (eval_run_id, case_id);


--
-- Name: eval_run_items_run_case_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX eval_run_items_run_case_unique ON eval_run_items USING btree (eval_run_id, case_id) WHERE (client_item_id IS NULL);


--
-- Name: eval_run_items_run_client_item_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX eval_run_items_run_client_item_unique ON eval_run_items USING btree (eval_run_id, client_item_id) WHERE (client_item_id IS NOT NULL);


--
-- Name: eval_run_items_run_status_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX eval_run_items_run_status_idx ON eval_run_items USING btree (eval_run_id, status);


--
-- Name: eval_runs_dataset_revision_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX eval_runs_dataset_revision_idx ON eval_runs USING btree (dataset_revision_id);


--
-- Name: eval_runs_project_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX eval_runs_project_created_idx ON eval_runs USING btree (project_id, created_at DESC);


--
-- Name: eval_runs_project_skill_version_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX eval_runs_project_skill_version_idx ON eval_runs USING btree (project_id, skill_version_id);


--
-- Name: eval_runs_backfill_version_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX eval_runs_backfill_version_idx ON eval_runs USING btree (project_id, skill_version_id) WHERE (trigger = 'backfill'::text);


--
-- Name: eval_runs_convergence_case_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX eval_runs_convergence_case_idx ON eval_runs USING btree (project_id, skill_version_id, convergence_case_id) WHERE ((convergence_case_id IS NOT NULL) AND (status = ANY (ARRAY['pending'::text, 'running'::text])));


--
-- Name: eval_runs_ingestion_case_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX eval_runs_ingestion_case_idx ON eval_runs USING btree (project_id, skill_version_id, ingestion_case_id) WHERE (ingestion_case_id IS NOT NULL);


--
-- Name: eval_runs_source_trace_test_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX eval_runs_source_trace_test_idx ON eval_runs USING btree (project_id, source_trace_test_id, created_at DESC) WHERE (source_trace_test_id IS NOT NULL);


--
-- Name: evaluator_execution_authorizations_version_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX evaluator_execution_authorizations_version_idx ON evaluator_execution_authorizations USING btree (project_id, skill_version_id, authorized_at, id);


--
-- Name: evaluator_lifecycle_events_activation_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX evaluator_lifecycle_events_activation_idx ON evaluator_lifecycle_events USING btree (calibration_artifact_id) WHERE (transition = 'activated'::text);


--
-- Name: evaluator_lifecycle_events_head_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX evaluator_lifecycle_events_head_idx ON evaluator_lifecycle_events USING btree (lifecycle_id, sequence DESC, id);


--
-- Name: evaluator_lifecycles_lineage_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX evaluator_lifecycles_lineage_idx ON evaluator_lifecycles USING btree (project_id, criterion_id, created_at, id);


--
-- Name: evaluator_suite_manifests_project_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX evaluator_suite_manifests_project_created_idx ON evaluator_suite_manifests USING btree (project_id, created_at DESC, id);


--
-- Name: evaluator_suite_manifests_project_suite_revision_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX evaluator_suite_manifests_project_suite_revision_idx ON evaluator_suite_manifests USING btree (project_id, suite_id, revision DESC);


--
-- Name: evaluator_suite_members_project_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX evaluator_suite_members_project_idx ON evaluator_suite_manifest_members USING btree (project_id, manifest_id, "position");


--
-- Name: evaluator_suites_project_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX evaluator_suites_project_created_idx ON evaluator_suites USING btree (project_id, created_at, id);


--
-- Name: feedback_sync_jobs_judge_provider_unique_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX feedback_sync_jobs_judge_provider_unique_idx ON feedback_sync_jobs USING btree (judge_run_id, provider);


--
-- Name: feedback_sync_jobs_status_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX feedback_sync_jobs_status_idx ON feedback_sync_jobs USING btree (project_id, provider, status);


--
-- Name: gate_check_items_candidate_case_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX gate_check_items_candidate_case_idx ON gate_check_items USING btree (candidate_case_id);


--
-- Name: gate_check_items_check_golden_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX gate_check_items_check_golden_unique ON gate_check_items USING btree (gate_check_id, golden_case_id);


--
-- Name: gate_check_items_golden_case_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX gate_check_items_golden_case_idx ON gate_check_items USING btree (golden_case_id);


--
-- Name: gate_check_items_golden_entry_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX gate_check_items_golden_entry_idx ON gate_check_items USING btree (golden_entry_id);


--
-- Name: gate_check_items_project_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX gate_check_items_project_idx ON gate_check_items USING btree (project_id);


--
-- Name: gate_checks_eval_run_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX gate_checks_eval_run_idx ON gate_checks USING btree (eval_run_id);


--
-- Name: gate_checks_project_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX gate_checks_project_created_idx ON gate_checks USING btree (project_id, created_at DESC);


--
-- Name: gate_checks_skill_version_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX gate_checks_skill_version_idx ON gate_checks USING btree (skill_version_id);


--
-- Name: golden_set_entries_active_criterion_case_unique_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX golden_set_entries_active_criterion_case_unique_idx ON golden_set_entries USING btree (project_id, criterion_version_id, case_id) WHERE (retired_at IS NULL);


--
-- Name: golden_set_entries_project_criterion_active_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX golden_set_entries_project_criterion_active_idx ON golden_set_entries USING btree (project_id, criterion_version_id, promoted_at DESC, id) WHERE (retired_at IS NULL);


--
-- Name: golden_set_entries_project_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX golden_set_entries_project_idx ON golden_set_entries USING btree (project_id);


--
-- Name: governed_dataset_truth_link_labels_label_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_dataset_truth_link_labels_label_idx ON governed_dataset_truth_link_labels USING btree (label_id);


--
-- Name: governed_dataset_truth_links_batch_item_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_dataset_truth_links_batch_item_idx ON governed_dataset_truth_links USING btree (batch_item_id) WHERE (batch_item_id IS NOT NULL);


--
-- Name: governed_dataset_truth_links_criterion_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_dataset_truth_links_criterion_idx ON governed_dataset_truth_links USING btree (project_id, criterion_version_id, created_at);


--
-- Name: governed_dataset_truth_links_import_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_dataset_truth_links_import_idx ON governed_dataset_truth_links USING btree (imported_truth_id) WHERE (imported_truth_id IS NOT NULL);


--
-- Name: governed_dataset_truth_links_revision_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_dataset_truth_links_revision_idx ON governed_dataset_truth_links USING btree (dataset_revision_id, dataset_revision_item_id);


--
-- Name: governed_evaluator_development_events_subject_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_evaluator_development_events_subject_idx ON governed_evaluator_development_events USING btree (project_id, criterion_version_id, developer_subject_id);


--
-- Name: governed_imported_truth_project_input_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_imported_truth_project_input_idx ON governed_imported_truth USING btree (project_id, input_digest);


--
-- Name: governed_review_adjudication_labels_label_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_review_adjudication_labels_label_idx ON governed_review_adjudication_labels USING btree (label_id);


--
-- Name: governed_review_adjudications_item_version_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_review_adjudications_item_version_idx ON governed_review_adjudications USING btree (batch_item_id, chain_version DESC);


--
-- Name: governed_review_adjudications_one_root_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX governed_review_adjudications_one_root_idx ON governed_review_adjudications USING btree (batch_item_id) WHERE (supersedes_adjudication_id IS NULL);


--
-- Name: governed_review_adjudications_one_successor_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX governed_review_adjudications_one_successor_idx ON governed_review_adjudications USING btree (supersedes_adjudication_id) WHERE (supersedes_adjudication_id IS NOT NULL);


--
-- Name: governed_review_alignment_event_labels_label_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_review_alignment_event_labels_label_idx ON governed_review_alignment_event_labels USING btree (label_id);


--
-- Name: governed_review_alignment_events_batch_sequence_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_review_alignment_events_batch_sequence_idx ON governed_review_alignment_events USING btree (batch_id, sequence DESC);


--
-- Name: governed_review_batch_events_batch_version_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_review_batch_events_batch_version_idx ON governed_review_batch_events USING btree (batch_id, state_version DESC);


--
-- Name: governed_review_batch_events_revision_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_review_batch_events_revision_idx ON governed_review_batch_events USING btree (dataset_revision_id) WHERE (dataset_revision_id IS NOT NULL);


--
-- Name: governed_review_batch_items_review_item_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_review_batch_items_review_item_idx ON governed_review_batch_items USING btree (review_item_id);


--
-- Name: governed_review_batches_instruction_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_review_batches_instruction_idx ON governed_review_batches USING btree (instruction_version_id);


--
-- Name: governed_review_batches_project_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_review_batches_project_created_idx ON governed_review_batches USING btree (project_id, created_at, id);


--
-- Name: governed_review_capability_checks_stream_version_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX governed_review_capability_checks_stream_version_unique ON governed_review_capability_checks USING btree (batch_id, check_scope, subject_id, evaluator_version_id, sequence) NULLS NOT DISTINCT;


--
-- Name: governed_review_capability_checks_subject_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_review_capability_checks_subject_idx ON governed_review_capability_checks USING btree (subject_id, check_scope);


--
-- Name: governed_review_items_project_input_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_review_items_project_input_idx ON governed_review_items USING btree (project_id, input_digest);


--
-- Name: governed_review_items_revision_item_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_review_items_revision_item_idx ON governed_review_items USING btree (source_revision_item_id) WHERE (source_revision_item_id IS NOT NULL);


--
-- Name: governed_review_items_sealed_frame_position_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX governed_review_items_sealed_frame_position_unique ON governed_review_items USING btree (sealed_intake_population_id, sealed_frame_position) WHERE (source_kind = 'sealed_intake'::text);


--
-- Name: governed_review_items_sealed_input_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_review_items_sealed_input_idx ON governed_review_items USING btree (project_id, input_digest) WHERE (source_kind = 'sealed_intake'::text);


--
-- Name: governed_review_labels_replacement_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX governed_review_labels_replacement_unique ON governed_review_labels USING btree (replaces_label_id) WHERE (replaces_label_id IS NOT NULL);


--
-- Name: governed_review_task_events_submission_label_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX governed_review_task_events_submission_label_unique ON governed_review_task_events USING btree (label_id) WHERE (event_kind = 'label_submitted'::text);


--
-- Name: governed_review_task_events_task_version_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_review_task_events_task_version_idx ON governed_review_task_events USING btree (task_id, state_version DESC);


--
-- Name: governed_review_task_events_withdrawal_label_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX governed_review_task_events_withdrawal_label_unique ON governed_review_task_events USING btree (label_id) WHERE (event_kind = 'label_withdrawn'::text);


--
-- Name: governed_review_tasks_batch_item_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_review_tasks_batch_item_idx ON governed_review_tasks USING btree (batch_item_id);


--
-- Name: governed_review_tasks_reviewer_serve_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX governed_review_tasks_reviewer_serve_idx ON governed_review_tasks USING btree (batch_id, reviewer_subject_id, serve_order);


--
-- Name: governed_reviewer_subjects_project_account_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX governed_reviewer_subjects_project_account_unique ON governed_reviewer_subjects USING btree (project_id, account_user_id) WHERE (account_user_id IS NOT NULL);


--
-- Name: governed_sealed_intake_populations_predecessor_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX governed_sealed_intake_populations_predecessor_idx ON governed_sealed_intake_populations USING btree (predecessor_revision_id) WHERE (predecessor_revision_id IS NOT NULL);


--
-- Name: import_jobs_actor_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX import_jobs_actor_idx ON import_jobs USING btree (actor_user_id) WHERE (actor_user_id IS NOT NULL);


--
-- Name: import_jobs_project_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX import_jobs_project_created_idx ON import_jobs USING btree (project_id, created_at DESC);


--
-- Name: import_jobs_project_skill_version_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX import_jobs_project_skill_version_created_idx ON import_jobs USING btree (project_id, skill_version_id, created_at DESC, id);


--
-- Name: import_jobs_project_status_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX import_jobs_project_status_created_idx ON import_jobs USING btree (project_id, status, created_at DESC);


--
-- Name: integrations_ironside_last_tested_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX integrations_ironside_last_tested_idx ON integrations USING btree (project_id, last_tested_at DESC) WHERE ((provider = 'ironside'::text) AND (last_tested_at IS NOT NULL));


--
-- Name: integrations_ironside_poll_due_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX integrations_ironside_poll_due_idx ON integrations USING btree (provider, poll_enabled, last_polled_at) WHERE (provider = 'ironside'::text);


--
-- Name: integrations_langfuse_last_tested_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX integrations_langfuse_last_tested_idx ON integrations USING btree (project_id, last_tested_at DESC) WHERE ((provider = 'langfuse'::text) AND (last_tested_at IS NOT NULL));


--
-- Name: integrations_langfuse_poll_due_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX integrations_langfuse_poll_due_idx ON integrations USING btree (provider, poll_enabled, last_polled_at) WHERE (provider = 'langfuse'::text);


--
-- Name: integrations_langsmith_last_tested_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX integrations_langsmith_last_tested_idx ON integrations USING btree (project_id, last_tested_at DESC) WHERE ((provider = 'langsmith'::text) AND (last_tested_at IS NOT NULL));


--
-- Name: integrations_langsmith_poll_due_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX integrations_langsmith_poll_due_idx ON integrations USING btree (provider, poll_enabled, last_polled_at) WHERE (provider = 'langsmith'::text);


--
-- Name: integrations_project_provider_unique_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX integrations_project_provider_unique_idx ON integrations USING btree (project_id, provider);


--
-- Name: judge_runs_case_skill_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX judge_runs_case_skill_idx ON judge_runs USING btree (case_id, skill_version_id);


--
-- Name: judge_runs_project_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX judge_runs_project_idx ON judge_runs USING btree (project_id);


--
-- Name: organization_members_user_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX organization_members_user_idx ON organization_members USING btree (user_id);


--
-- Name: project_members_project_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX project_members_project_idx ON project_members USING btree (project_id);


--
-- Name: project_members_user_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX project_members_user_idx ON project_members USING btree (user_id);


--
-- Name: raw_traces_id_project_unique; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX raw_traces_id_project_unique ON raw_traces USING btree (id, project_id);


--
-- Name: raw_traces_project_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX raw_traces_project_idx ON raw_traces USING btree (project_id);


--
-- Name: raw_traces_project_import_job_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX raw_traces_project_import_job_idx ON raw_traces USING btree (project_id, import_job_id) WHERE (import_job_id IS NOT NULL);


--
-- Name: raw_traces_project_source_trace_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX raw_traces_project_source_trace_idx ON raw_traces USING btree (project_id, source_trace_id);


--
-- Name: regression_runs_dataset_revision_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX regression_runs_dataset_revision_idx ON regression_runs USING btree (dataset_revision_id);


--
-- Name: regression_runs_project_criterion_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX regression_runs_project_criterion_idx ON regression_runs USING btree (project_id, criterion_version_id, created_at DESC, id);


--
-- Name: regression_runs_project_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX regression_runs_project_idx ON regression_runs USING btree (project_id);


--
-- Name: review_queue_items_queue_assignee_pending_position_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX review_queue_items_queue_assignee_pending_position_idx ON review_queue_items USING btree (queue_id, assigned_to_user_id, "position") WHERE (status = 'pending'::text);


--
-- Name: review_queue_items_queue_case_criterion_assignee_unique_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX review_queue_items_queue_case_criterion_assignee_unique_idx ON review_queue_items USING btree (queue_id, case_id, criterion_version_id, assigned_to_user_id) NULLS NOT DISTINCT;


--
-- Name: review_queue_items_queue_criterion_status_position_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX review_queue_items_queue_criterion_status_position_idx ON review_queue_items USING btree (queue_id, criterion_version_id, status, "position");


--
-- Name: review_queue_items_queue_status_position_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX review_queue_items_queue_status_position_idx ON review_queue_items USING btree (queue_id, status, "position");


--
-- Name: review_queues_project_status_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX review_queues_project_status_created_idx ON review_queues USING btree (project_id, status, created_at DESC);


--
-- Name: run_comparisons_project_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX run_comparisons_project_created_idx ON run_comparisons USING btree (project_id, created_at DESC);


--
-- Name: run_comparisons_run_a_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX run_comparisons_run_a_idx ON run_comparisons USING btree (run_a_id);


--
-- Name: run_comparisons_run_b_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX run_comparisons_run_b_idx ON run_comparisons USING btree (run_b_id);


--
-- Name: skill_versions_created_by_subject_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX skill_versions_created_by_subject_idx ON skill_versions USING btree (project_id, criterion_version_id, created_by_subject_id) WHERE (created_by_subject_id IS NOT NULL);


--
-- Name: skill_versions_criterion_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX skill_versions_criterion_idx ON skill_versions USING btree (project_id, criterion_version_id, created_at, id);


--
-- Name: skill_versions_kind_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX skill_versions_kind_idx ON skill_versions USING btree (project_id, verdict_kind) WHERE (verdict_kind <> 'binary'::text);


--
-- Name: skill_versions_regression_revision_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX skill_versions_regression_revision_idx ON skill_versions USING btree (regression_dataset_revision_id);


--
-- Name: skill_versions_skill_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX skill_versions_skill_idx ON skill_versions USING btree (skill_id);


--
-- Name: skills_one_lineage_per_criterion_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE UNIQUE INDEX skills_one_lineage_per_criterion_idx ON skills USING btree (project_id, criterion_id);


--
-- Name: skills_project_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX skills_project_idx ON skills USING btree (project_id, created_at, id);


--
-- Name: trace_test_revisions_project_test_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX trace_test_revisions_project_test_idx ON trace_test_revisions USING btree (project_id, trace_test_id, revision);


--
-- Name: trace_test_validations_project_test_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX trace_test_validations_project_test_idx ON trace_test_validations USING btree (project_id, trace_test_id, created_at, id);


--
-- Name: trace_tests_project_source_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX trace_tests_project_source_idx ON trace_tests USING btree (project_id, source_case_ref, updated_at DESC);


--
-- Name: trace_tests_project_updated_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX trace_tests_project_updated_idx ON trace_tests USING btree (project_id, updated_at DESC, id DESC);


--
-- Name: verdicts_external_run_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX verdicts_external_run_idx ON verdicts USING btree (project_id, external_run_id) WHERE (external_run_id IS NOT NULL);


--
-- Name: verdicts_project_case_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX verdicts_project_case_created_idx ON verdicts USING btree (project_id, case_id, created_at DESC);


--
-- Name: verdicts_project_skill_version_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX verdicts_project_skill_version_idx ON verdicts USING btree (project_id, skill_version_id) WHERE (skill_version_id IS NOT NULL);


--
-- Name: verdicts_project_source_created_idx; Type: INDEX; Schema: current; Owner: -
--

CREATE INDEX verdicts_project_source_created_idx ON verdicts USING btree (project_id, source, created_at DESC);


--
-- Name: governed_review_batches aaa_analysis_promotion_criterion_batch_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER aaa_analysis_promotion_criterion_batch_guard BEFORE INSERT ON governed_review_batches FOR EACH ROW EXECUTE FUNCTION guard_analysis_promotion_criterion_batch();


--
-- Name: governed_review_batches aaa_analysis_promotion_handoff_batch_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER aaa_analysis_promotion_handoff_batch_guard BEFORE INSERT ON governed_review_batches FOR EACH ROW EXECUTE FUNCTION guard_analysis_promotion_handoff_batch();


--
-- Name: governed_review_batch_items aaa_analysis_promotion_handoff_batch_item_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER aaa_analysis_promotion_handoff_batch_item_guard BEFORE INSERT ON governed_review_batch_items FOR EACH ROW EXECUTE FUNCTION guard_analysis_promotion_handoff_batch_item();


--
-- Name: binary_calibration_revocation_events aaa_binary_calibration_revocation_lifecycle_lock; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER aaa_binary_calibration_revocation_lifecycle_lock BEFORE INSERT ON binary_calibration_revocation_events FOR EACH ROW EXECUTE FUNCTION lock_evaluator_lineage_for_calibration_revocation_v1();


--
-- Name: case_input_identity_records aaa_case_input_identity_records_structural_claim; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER aaa_case_input_identity_records_structural_claim BEFORE INSERT ON case_input_identity_records FOR EACH ROW EXECUTE FUNCTION claim_case_input_identity_nonsealed();


--
-- Name: criteria aaa_criteria_analysis_promotion_source_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER aaa_criteria_analysis_promotion_source_guard BEFORE INSERT ON criteria FOR EACH ROW EXECUTE FUNCTION guard_analysis_promotion_criterion_source();


--
-- Name: dataset_revision_items aaa_dataset_revision_items_structural_claim; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER aaa_dataset_revision_items_structural_claim BEFORE INSERT ON dataset_revision_items FOR EACH ROW EXECUTE FUNCTION claim_dataset_revision_item_identity();


--
-- Name: eval_runs aaa_eval_runs_analysis_population_boundary; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER aaa_eval_runs_analysis_population_boundary BEFORE INSERT OR UPDATE OF dataset_revision_id ON eval_runs FOR EACH ROW EXECUTE FUNCTION guard_analysis_population_eval_run_boundary();


--
-- Name: governed_review_capability_checks aaa_governed_capability_development_subject_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER aaa_governed_capability_development_subject_guard BEFORE INSERT ON governed_review_capability_checks FOR EACH ROW EXECUTE FUNCTION guard_governed_capability_development_subject_v1();


--
-- Name: governed_review_batches aaa_governed_review_batches_analysis_population_boundary; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER aaa_governed_review_batches_analysis_population_boundary BEFORE INSERT ON governed_review_batches FOR EACH ROW EXECUTE FUNCTION guard_analysis_population_review_batch_boundary();


--
-- Name: governed_review_items aaa_governed_review_items_analysis_population_boundary; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER aaa_governed_review_items_analysis_population_boundary BEFORE INSERT ON governed_review_items FOR EACH ROW EXECUTE FUNCTION guard_analysis_population_review_item_boundary();


--
-- Name: governed_review_items aaa_governed_review_items_structural_claim; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER aaa_governed_review_items_structural_claim BEFORE INSERT ON governed_review_items FOR EACH ROW EXECUTE FUNCTION claim_governed_sealed_review_identity();


--
-- Name: analysis_criterion_promotion_supports analysis_criterion_promotion_supports_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_criterion_promotion_supports_append_only BEFORE DELETE OR UPDATE ON analysis_criterion_promotion_supports FOR EACH ROW EXECUTE FUNCTION guard_analysis_6b3_append_only();


--
-- Name: analysis_criterion_promotion_supports analysis_criterion_promotion_supports_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_criterion_promotion_supports_guard BEFORE INSERT ON analysis_criterion_promotion_supports FOR EACH ROW EXECUTE FUNCTION guard_analysis_criterion_promotion_support();


--
-- Name: analysis_criterion_promotions analysis_criterion_promotions_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_criterion_promotions_append_only BEFORE DELETE OR UPDATE ON analysis_criterion_promotions FOR EACH ROW EXECUTE FUNCTION guard_analysis_6b3_append_only();


--
-- Name: analysis_criterion_promotions analysis_criterion_promotions_complete; Type: TRIGGER; Schema: current; Owner: -
--

CREATE CONSTRAINT TRIGGER analysis_criterion_promotions_complete AFTER INSERT ON analysis_criterion_promotions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_analysis_criterion_promotion_complete();


--
-- Name: analysis_criterion_promotions analysis_criterion_promotions_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_criterion_promotions_guard BEFORE INSERT ON analysis_criterion_promotions FOR EACH ROW EXECUTE FUNCTION guard_analysis_criterion_promotion();


--
-- Name: analysis_failure_codes analysis_failure_codes_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_failure_codes_append_only BEFORE DELETE OR UPDATE ON analysis_failure_codes FOR EACH ROW EXECUTE FUNCTION guard_analysis_6b2_append_only();


--
-- Name: analysis_failure_codes analysis_failure_codes_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_failure_codes_guard BEFORE INSERT ON analysis_failure_codes FOR EACH ROW EXECUTE FUNCTION guard_analysis_failure_code();


--
-- Name: analysis_failure_taxonomies analysis_failure_taxonomies_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_failure_taxonomies_append_only BEFORE DELETE OR UPDATE ON analysis_failure_taxonomies FOR EACH ROW EXECUTE FUNCTION guard_analysis_6b2_append_only();


--
-- Name: analysis_failure_taxonomies analysis_failure_taxonomies_complete; Type: TRIGGER; Schema: current; Owner: -
--

CREATE CONSTRAINT TRIGGER analysis_failure_taxonomies_complete AFTER INSERT ON analysis_failure_taxonomies DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_analysis_failure_taxonomy_complete();


--
-- Name: analysis_failure_taxonomies analysis_failure_taxonomies_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_failure_taxonomies_guard BEFORE INSERT ON analysis_failure_taxonomies FOR EACH ROW EXECUTE FUNCTION guard_analysis_failure_taxonomy();


--
-- Name: analysis_failure_taxonomy_revision_codes analysis_failure_taxonomy_revision_codes_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_failure_taxonomy_revision_codes_append_only BEFORE DELETE OR UPDATE ON analysis_failure_taxonomy_revision_codes FOR EACH ROW EXECUTE FUNCTION guard_analysis_6b2_append_only();


--
-- Name: analysis_failure_taxonomy_revision_codes analysis_failure_taxonomy_revision_codes_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_failure_taxonomy_revision_codes_guard BEFORE INSERT ON analysis_failure_taxonomy_revision_codes FOR EACH ROW EXECUTE FUNCTION guard_analysis_taxonomy_revision_code();


--
-- Name: analysis_failure_taxonomy_revisions analysis_failure_taxonomy_revisions_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_failure_taxonomy_revisions_append_only BEFORE DELETE OR UPDATE ON analysis_failure_taxonomy_revisions FOR EACH ROW EXECUTE FUNCTION guard_analysis_6b2_append_only();


--
-- Name: analysis_failure_taxonomy_revisions analysis_failure_taxonomy_revisions_complete; Type: TRIGGER; Schema: current; Owner: -
--

CREATE CONSTRAINT TRIGGER analysis_failure_taxonomy_revisions_complete AFTER INSERT ON analysis_failure_taxonomy_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_analysis_taxonomy_revision_complete();


--
-- Name: analysis_failure_taxonomy_revisions analysis_failure_taxonomy_revisions_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_failure_taxonomy_revisions_guard BEFORE INSERT ON analysis_failure_taxonomy_revisions FOR EACH ROW EXECUTE FUNCTION guard_analysis_failure_taxonomy_revision();


--
-- Name: analysis_observation_assignment_events analysis_observation_assignment_events_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_observation_assignment_events_append_only BEFORE DELETE OR UPDATE ON analysis_observation_assignment_events FOR EACH ROW EXECUTE FUNCTION guard_analysis_6b2_append_only();


--
-- Name: analysis_observation_assignment_events analysis_observation_assignment_events_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_observation_assignment_events_guard BEFORE INSERT ON analysis_observation_assignment_events FOR EACH ROW EXECUTE FUNCTION guard_analysis_observation_assignment_event();


--
-- Name: analysis_population_draw_items analysis_population_draw_items_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_population_draw_items_append_only BEFORE DELETE OR UPDATE ON analysis_population_draw_items FOR EACH ROW EXECUTE FUNCTION guard_analysis_evidence_append_only();


--
-- Name: analysis_population_draw_items analysis_population_draw_items_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_population_draw_items_guard BEFORE INSERT ON analysis_population_draw_items FOR EACH ROW EXECUTE FUNCTION guard_analysis_population_draw_item();


--
-- Name: analysis_population_draws analysis_population_draws_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_population_draws_append_only BEFORE DELETE OR UPDATE ON analysis_population_draws FOR EACH ROW EXECUTE FUNCTION guard_analysis_evidence_append_only();


--
-- Name: analysis_population_draws analysis_population_draws_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_population_draws_guard BEFORE INSERT ON analysis_population_draws FOR EACH ROW EXECUTE FUNCTION guard_analysis_population_draw();


--
-- Name: analysis_population_exclusions analysis_population_exclusions_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_population_exclusions_append_only BEFORE DELETE OR UPDATE ON analysis_population_exclusions FOR EACH ROW EXECUTE FUNCTION guard_analysis_evidence_append_only();


--
-- Name: analysis_population_exclusions analysis_population_exclusions_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_population_exclusions_guard BEFORE INSERT ON analysis_population_exclusions FOR EACH ROW EXECUTE FUNCTION guard_analysis_population_exclusion();


--
-- Name: analysis_population_members analysis_population_members_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_population_members_append_only BEFORE DELETE OR UPDATE ON analysis_population_members FOR EACH ROW EXECUTE FUNCTION guard_analysis_evidence_append_only();


--
-- Name: analysis_population_members analysis_population_members_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_population_members_guard BEFORE INSERT ON analysis_population_members FOR EACH ROW EXECUTE FUNCTION guard_analysis_population_member();


--
-- Name: analysis_population_requests analysis_population_requests_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_population_requests_append_only BEFORE DELETE OR UPDATE ON analysis_population_requests FOR EACH ROW EXECUTE FUNCTION guard_analysis_evidence_append_only();


--
-- Name: analysis_population_requests analysis_population_requests_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_population_requests_guard BEFORE INSERT ON analysis_population_requests FOR EACH ROW EXECUTE FUNCTION guard_analysis_population_request();


--
-- Name: analysis_populations analysis_populations_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_populations_append_only BEFORE DELETE OR UPDATE ON analysis_populations FOR EACH ROW EXECUTE FUNCTION guard_analysis_evidence_append_only();


--
-- Name: analysis_populations analysis_populations_bundle_complete; Type: TRIGGER; Schema: current; Owner: -
--

CREATE CONSTRAINT TRIGGER analysis_populations_bundle_complete AFTER INSERT ON analysis_populations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_analysis_population_bundle_complete();


--
-- Name: analysis_populations analysis_populations_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_populations_guard BEFORE INSERT ON analysis_populations FOR EACH ROW EXECUTE FUNCTION guard_analysis_population_row();


--
-- Name: analysis_studies analysis_studies_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_studies_append_only BEFORE DELETE OR UPDATE ON analysis_studies FOR EACH ROW EXECUTE FUNCTION guard_analysis_6b2_append_only();


--
-- Name: analysis_studies analysis_studies_bundle_complete; Type: TRIGGER; Schema: current; Owner: -
--

CREATE CONSTRAINT TRIGGER analysis_studies_bundle_complete AFTER INSERT ON analysis_studies DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_analysis_study_bundle_complete();


--
-- Name: analysis_studies analysis_studies_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_studies_guard BEFORE INSERT ON analysis_studies FOR EACH ROW EXECUTE FUNCTION guard_analysis_study();


--
-- Name: analysis_study_closure_items analysis_study_closure_items_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_study_closure_items_append_only BEFORE DELETE OR UPDATE ON analysis_study_closure_items FOR EACH ROW EXECUTE FUNCTION guard_analysis_6b2_append_only();


--
-- Name: analysis_study_closure_items analysis_study_closure_items_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_study_closure_items_guard BEFORE INSERT ON analysis_study_closure_items FOR EACH ROW EXECUTE FUNCTION guard_analysis_study_closure_item();


--
-- Name: analysis_study_closures analysis_study_closures_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_study_closures_append_only BEFORE DELETE OR UPDATE ON analysis_study_closures FOR EACH ROW EXECUTE FUNCTION guard_analysis_6b2_append_only();


--
-- Name: analysis_study_closures analysis_study_closures_complete; Type: TRIGGER; Schema: current; Owner: -
--

CREATE CONSTRAINT TRIGGER analysis_study_closures_complete AFTER INSERT ON analysis_study_closures DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_analysis_study_closure_complete();


--
-- Name: analysis_study_closures analysis_study_closures_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_study_closures_guard BEFORE INSERT ON analysis_study_closures FOR EACH ROW EXECUTE FUNCTION guard_analysis_study_closure();


--
-- Name: analysis_study_events analysis_study_events_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_study_events_append_only BEFORE DELETE OR UPDATE ON analysis_study_events FOR EACH ROW EXECUTE FUNCTION guard_analysis_6b2_append_only();


--
-- Name: analysis_study_events analysis_study_events_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_study_events_guard BEFORE INSERT ON analysis_study_events FOR EACH ROW EXECUTE FUNCTION guard_analysis_study_event();


--
-- Name: analysis_study_item_events analysis_study_item_events_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_study_item_events_append_only BEFORE DELETE OR UPDATE ON analysis_study_item_events FOR EACH ROW EXECUTE FUNCTION guard_analysis_6b2_append_only();


--
-- Name: analysis_study_item_events analysis_study_item_events_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_study_item_events_guard BEFORE INSERT ON analysis_study_item_events FOR EACH ROW EXECUTE FUNCTION guard_analysis_study_item_event();


--
-- Name: analysis_study_item_views analysis_study_item_views_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_study_item_views_append_only BEFORE DELETE OR UPDATE ON analysis_study_item_views FOR EACH ROW EXECUTE FUNCTION guard_analysis_6b2_append_only();


--
-- Name: analysis_study_item_views analysis_study_item_views_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_study_item_views_guard BEFORE INSERT ON analysis_study_item_views FOR EACH ROW EXECUTE FUNCTION guard_analysis_study_item_view();


--
-- Name: analysis_study_items analysis_study_items_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_study_items_append_only BEFORE DELETE OR UPDATE ON analysis_study_items FOR EACH ROW EXECUTE FUNCTION guard_analysis_6b2_append_only();


--
-- Name: analysis_study_items analysis_study_items_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER analysis_study_items_guard BEFORE INSERT ON analysis_study_items FOR EACH ROW EXECUTE FUNCTION guard_analysis_study_item();


--
-- Name: assessment_receipt_artifacts assessment_receipt_artifacts_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER assessment_receipt_artifacts_append_only BEFORE DELETE OR UPDATE ON assessment_receipt_artifacts FOR EACH ROW EXECUTE FUNCTION guard_assessment_receipt_append_only();


--
-- Name: assessment_receipt_artifacts assessment_receipt_artifacts_lineage_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER assessment_receipt_artifacts_lineage_guard BEFORE INSERT ON assessment_receipt_artifacts FOR EACH ROW EXECUTE FUNCTION guard_assessment_receipt_lineage();


--
-- Name: assessment_receipt_comparisons assessment_receipt_comparisons_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER assessment_receipt_comparisons_append_only BEFORE DELETE OR UPDATE ON assessment_receipt_comparisons FOR EACH ROW EXECUTE FUNCTION guard_assessment_receipt_append_only();


--
-- Name: assessment_receipt_comparisons assessment_receipt_comparisons_owner_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER assessment_receipt_comparisons_owner_guard BEFORE INSERT ON assessment_receipt_comparisons FOR EACH ROW EXECUTE FUNCTION guard_assessment_receipt_comparison_owner();


--
-- Name: binary_calibration_artifacts binary_calibration_artifacts_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER binary_calibration_artifacts_append_only BEFORE DELETE OR UPDATE ON binary_calibration_artifacts FOR EACH ROW EXECUTE FUNCTION guard_binary_calibration_append_only();


--
-- Name: binary_calibration_artifacts binary_calibration_artifacts_insert_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER binary_calibration_artifacts_insert_guard BEFORE INSERT ON binary_calibration_artifacts FOR EACH ROW EXECUTE FUNCTION guard_binary_calibration_evidence_insert();


--
-- Name: binary_calibration_attempts binary_calibration_attempts_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER binary_calibration_attempts_guard BEFORE INSERT OR DELETE OR UPDATE ON binary_calibration_attempts FOR EACH ROW EXECUTE FUNCTION guard_binary_calibration_attempt();


--
-- Name: dataset_exposure_events binary_calibration_dataset_exposure_lease_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER binary_calibration_dataset_exposure_lease_guard BEFORE INSERT ON dataset_exposure_events FOR EACH ROW EXECUTE FUNCTION guard_binary_calibration_exposure_during_lease();


--
-- Name: binary_calibration_exposure_checks binary_calibration_exposure_checks_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER binary_calibration_exposure_checks_append_only BEFORE DELETE OR UPDATE ON binary_calibration_exposure_checks FOR EACH ROW EXECUTE FUNCTION guard_binary_calibration_append_only();


--
-- Name: binary_calibration_exposure_checks binary_calibration_exposure_checks_insert_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER binary_calibration_exposure_checks_insert_guard BEFORE INSERT ON binary_calibration_exposure_checks FOR EACH ROW EXECUTE FUNCTION guard_binary_calibration_evidence_insert();


--
-- Name: binary_calibration_private_ledgers binary_calibration_private_ledgers_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER binary_calibration_private_ledgers_append_only BEFORE DELETE OR UPDATE ON binary_calibration_private_ledgers FOR EACH ROW EXECUTE FUNCTION guard_binary_calibration_append_only();


--
-- Name: binary_calibration_private_ledgers binary_calibration_private_ledgers_insert_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER binary_calibration_private_ledgers_insert_guard BEFORE INSERT ON binary_calibration_private_ledgers FOR EACH ROW EXECUTE FUNCTION guard_binary_calibration_evidence_insert();


--
-- Name: binary_calibration_revision_leases binary_calibration_revision_leases_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER binary_calibration_revision_leases_guard BEFORE INSERT OR UPDATE ON binary_calibration_revision_leases FOR EACH ROW EXECUTE FUNCTION guard_binary_calibration_revision_lease();


--
-- Name: binary_calibration_revocation_events binary_calibration_revocation_events_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER binary_calibration_revocation_events_append_only BEFORE DELETE OR UPDATE ON binary_calibration_revocation_events FOR EACH ROW EXECUTE FUNCTION guard_binary_calibration_append_only();


--
-- Name: binary_calibration_revocation_events binary_calibration_revocation_events_insert_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER binary_calibration_revocation_events_insert_guard BEFORE INSERT ON binary_calibration_revocation_events FOR EACH ROW EXECUTE FUNCTION guard_binary_calibration_evidence_insert();


--
-- Name: binary_calibration_runs binary_calibration_runs_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER binary_calibration_runs_guard BEFORE INSERT OR DELETE OR UPDATE ON binary_calibration_runs FOR EACH ROW EXECUTE FUNCTION guard_binary_calibration_run();


--
-- Name: case_input_identity_records case_input_identity_records_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER case_input_identity_records_append_only BEFORE DELETE OR UPDATE ON case_input_identity_records FOR EACH ROW EXECUTE FUNCTION guard_dataset_evidence_append_only();


--
-- Name: case_input_identity_records case_input_identity_records_governed_sealed_overlap_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER case_input_identity_records_governed_sealed_overlap_guard BEFORE INSERT ON case_input_identity_records FOR EACH ROW EXECUTE FUNCTION guard_governed_sealed_identity_reverse_overlap();


--
-- Name: cases cases_ingestion_purpose_insert_guard; Type: TRIGGER; Schema: current; Owner: -
--

-- Name: cases cases_ingestion_purpose_update_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER cases_ingestion_purpose_update_guard BEFORE UPDATE OF ingestion_purpose ON cases FOR EACH ROW EXECUTE FUNCTION guard_case_ingestion_purpose_update();


--
-- Name: cases cases_revision_payload_immutable_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER cases_revision_payload_immutable_guard BEFORE UPDATE OF normalized_payload ON cases FOR EACH ROW EXECUTE FUNCTION guard_revision_bound_case_payload_immutable();


--
-- Name: criteria criteria_analysis_promotion_complete; Type: TRIGGER; Schema: current; Owner: -
--

CREATE CONSTRAINT TRIGGER criteria_analysis_promotion_complete AFTER INSERT ON criteria DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_analysis_promotion_criterion_complete();


--
-- Name: criteria criteria_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER criteria_append_only BEFORE DELETE OR UPDATE ON criteria FOR EACH ROW EXECUTE FUNCTION guard_batch3_evidence_append_only();


--
-- Name: criterion_regression_revisions criterion_regression_revisions_owner_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER criterion_regression_revisions_owner_guard BEFORE INSERT OR UPDATE ON criterion_regression_revisions FOR EACH ROW EXECUTE FUNCTION guard_criterion_regression_revision();


--
-- Name: criterion_versions criterion_versions_analysis_promotion_complete; Type: TRIGGER; Schema: current; Owner: -
--

CREATE CONSTRAINT TRIGGER criterion_versions_analysis_promotion_complete AFTER INSERT ON criterion_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_analysis_promotion_criterion_version_complete();


--
-- Name: criterion_versions criterion_versions_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER criterion_versions_append_only BEFORE DELETE OR UPDATE ON criterion_versions FOR EACH ROW EXECUTE FUNCTION guard_batch3_evidence_append_only();


--
-- Name: criterion_versions criterion_versions_owner_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER criterion_versions_owner_guard BEFORE INSERT ON criterion_versions FOR EACH ROW EXECUTE FUNCTION guard_criterion_version_owner();


--
-- Name: dataset_exposure_events dataset_exposure_events_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER dataset_exposure_events_append_only BEFORE DELETE OR UPDATE ON dataset_exposure_events FOR EACH ROW EXECUTE FUNCTION guard_dataset_evidence_append_only();


--
-- Name: dataset_exposure_events dataset_exposure_events_owner_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER dataset_exposure_events_owner_guard BEFORE INSERT ON dataset_exposure_events FOR EACH ROW EXECUTE FUNCTION guard_dataset_exposure_owner();


--
-- Name: dataset_revision_items dataset_revision_items_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER dataset_revision_items_append_only BEFORE DELETE OR UPDATE ON dataset_revision_items FOR EACH ROW EXECUTE FUNCTION guard_dataset_evidence_append_only();


--
-- Name: dataset_revision_items dataset_revision_items_criterion_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER dataset_revision_items_criterion_guard BEFORE INSERT ON dataset_revision_items FOR EACH ROW EXECUTE FUNCTION guard_golden_revision_item_criterion();


--
-- Name: dataset_revision_items dataset_revision_items_governed_sealed_overlap_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER dataset_revision_items_governed_sealed_overlap_guard BEFORE INSERT ON dataset_revision_items FOR EACH ROW EXECUTE FUNCTION guard_governed_sealed_revision_reverse_overlap();


--
-- Name: dataset_revision_items dataset_revision_items_owner_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER dataset_revision_items_owner_guard BEFORE INSERT ON dataset_revision_items FOR EACH ROW EXECUTE FUNCTION guard_dataset_revision_item_owner();


--
-- Name: dataset_revisions dataset_revisions_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER dataset_revisions_append_only BEFORE DELETE OR UPDATE ON dataset_revisions FOR EACH ROW EXECUTE FUNCTION guard_dataset_evidence_append_only();


--
-- Name: dataset_revisions dataset_revisions_criterion_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER dataset_revisions_criterion_guard BEFORE INSERT ON dataset_revisions FOR EACH ROW EXECUTE FUNCTION ensure_dataset_revision_criterion_scope();


--
-- Name: dataset_revisions dataset_revisions_owner_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER dataset_revisions_owner_guard BEFORE INSERT ON dataset_revisions FOR EACH ROW EXECUTE FUNCTION guard_dataset_revision_owner();


--
-- Name: eval_run_items eval_run_items_revision_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER eval_run_items_revision_guard BEFORE INSERT OR UPDATE OF dataset_revision_item_id, case_id, eval_run_id, project_id ON eval_run_items FOR EACH ROW EXECUTE FUNCTION guard_eval_run_revision_item();


--
-- Name: eval_runs eval_runs_revision_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER eval_runs_revision_guard BEFORE INSERT OR UPDATE OF dataset_revision_id ON eval_runs FOR EACH ROW EXECUTE FUNCTION guard_eval_run_revision_binding();


--
-- Name: evaluator_execution_authorizations evaluator_execution_authorizations_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER evaluator_execution_authorizations_append_only BEFORE DELETE OR UPDATE ON evaluator_execution_authorizations FOR EACH ROW EXECUTE FUNCTION guard_evaluator_lifecycle_append_only_v1();


--
-- Name: evaluator_execution_authorizations evaluator_execution_authorizations_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER evaluator_execution_authorizations_guard BEFORE INSERT ON evaluator_execution_authorizations FOR EACH ROW EXECUTE FUNCTION guard_evaluator_execution_authorization_v1();


--
-- Name: evaluator_lifecycle_events evaluator_lifecycle_events_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER evaluator_lifecycle_events_append_only BEFORE DELETE OR UPDATE ON evaluator_lifecycle_events FOR EACH ROW EXECUTE FUNCTION guard_evaluator_lifecycle_append_only_v1();


--
-- Name: evaluator_lifecycle_events evaluator_lifecycle_events_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER evaluator_lifecycle_events_guard BEFORE INSERT ON evaluator_lifecycle_events FOR EACH ROW EXECUTE FUNCTION guard_evaluator_lifecycle_event_v1();


--
-- Name: evaluator_lifecycle_events evaluator_lifecycle_lineage_complete; Type: TRIGGER; Schema: current; Owner: -
--

CREATE CONSTRAINT TRIGGER evaluator_lifecycle_lineage_complete AFTER INSERT ON evaluator_lifecycle_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_evaluator_lineage_state_v1();


--
-- Name: evaluator_lifecycles evaluator_lifecycles_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER evaluator_lifecycles_append_only BEFORE DELETE OR UPDATE ON evaluator_lifecycles FOR EACH ROW EXECUTE FUNCTION guard_evaluator_lifecycle_append_only_v1();


--
-- Name: evaluator_lifecycles evaluator_lifecycles_complete; Type: TRIGGER; Schema: current; Owner: -
--

CREATE CONSTRAINT TRIGGER evaluator_lifecycles_complete AFTER INSERT ON evaluator_lifecycles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_evaluator_lifecycle_complete_v1();


--
-- Name: evaluator_lifecycles evaluator_lifecycles_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER evaluator_lifecycles_guard BEFORE INSERT ON evaluator_lifecycles FOR EACH ROW EXECUTE FUNCTION guard_evaluator_lifecycle_row_v1();


--
-- Name: evaluator_suite_manifests evaluator_suite_manifest_complete; Type: TRIGGER; Schema: current; Owner: -
--

CREATE CONSTRAINT TRIGGER evaluator_suite_manifest_complete AFTER INSERT ON evaluator_suite_manifests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_evaluator_suite_members_complete();


--
-- Name: evaluator_suite_manifests evaluator_suite_manifests_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER evaluator_suite_manifests_append_only BEFORE DELETE OR UPDATE ON evaluator_suite_manifests FOR EACH ROW EXECUTE FUNCTION guard_batch3_evidence_append_only();


--
-- Name: evaluator_suite_manifests evaluator_suite_manifests_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER evaluator_suite_manifests_guard BEFORE INSERT ON evaluator_suite_manifests FOR EACH ROW EXECUTE FUNCTION guard_evaluator_suite_manifest();


--
-- Name: evaluator_suite_manifest_members evaluator_suite_member_complete; Type: TRIGGER; Schema: current; Owner: -
--

CREATE CONSTRAINT TRIGGER evaluator_suite_member_complete AFTER INSERT ON evaluator_suite_manifest_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_evaluator_suite_members_complete();


--
-- Name: evaluator_suite_manifest_members evaluator_suite_member_lifecycle_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER evaluator_suite_member_lifecycle_guard BEFORE INSERT ON evaluator_suite_manifest_members FOR EACH ROW EXECUTE FUNCTION guard_evaluator_suite_member_lifecycle_v1();


--
-- Name: evaluator_suite_manifest_members evaluator_suite_members_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER evaluator_suite_members_append_only BEFORE DELETE OR UPDATE ON evaluator_suite_manifest_members FOR EACH ROW EXECUTE FUNCTION guard_batch3_evidence_append_only();


--
-- Name: evaluator_suite_manifest_members evaluator_suite_members_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER evaluator_suite_members_guard BEFORE INSERT ON evaluator_suite_manifest_members FOR EACH ROW EXECUTE FUNCTION guard_evaluator_suite_member();


--
-- Name: evaluator_suites evaluator_suites_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER evaluator_suites_append_only BEFORE DELETE OR UPDATE ON evaluator_suites FOR EACH ROW EXECUTE FUNCTION guard_batch3_evidence_append_only();


--
-- Name: golden_set_entries golden_set_entries_criterion_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER golden_set_entries_criterion_guard BEFORE INSERT OR UPDATE OF criterion_version_id, source_skill_version_id, project_id ON golden_set_entries FOR EACH ROW EXECUTE FUNCTION ensure_golden_criterion_binding();


--
-- Name: governed_dataset_truth_link_labels governed_dataset_truth_link_labels_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_dataset_truth_link_labels_append_only BEFORE DELETE OR UPDATE ON governed_dataset_truth_link_labels FOR EACH ROW EXECUTE FUNCTION guard_governed_evidence_append_only();


--
-- Name: governed_dataset_truth_links governed_dataset_truth_link_labels_complete; Type: TRIGGER; Schema: current; Owner: -
--

CREATE CONSTRAINT TRIGGER governed_dataset_truth_link_labels_complete AFTER INSERT ON governed_dataset_truth_links DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_governed_truth_link_labels_complete();


--
-- Name: governed_dataset_truth_link_labels governed_dataset_truth_link_labels_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_dataset_truth_link_labels_guard BEFORE INSERT ON governed_dataset_truth_link_labels FOR EACH ROW EXECUTE FUNCTION guard_governed_truth_link_label();


--
-- Name: governed_dataset_truth_links governed_dataset_truth_links_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_dataset_truth_links_append_only BEFORE DELETE OR UPDATE ON governed_dataset_truth_links FOR EACH ROW EXECUTE FUNCTION guard_governed_evidence_append_only();


--
-- Name: governed_dataset_truth_links governed_dataset_truth_links_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_dataset_truth_links_guard BEFORE INSERT ON governed_dataset_truth_links FOR EACH ROW EXECUTE FUNCTION guard_governed_dataset_truth_link();


--
-- Name: governed_evaluator_development_events governed_evaluator_development_events_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_evaluator_development_events_append_only BEFORE DELETE OR UPDATE ON governed_evaluator_development_events FOR EACH ROW EXECUTE FUNCTION guard_governed_evidence_append_only();


--
-- Name: governed_evaluator_development_events governed_evaluator_development_events_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_evaluator_development_events_guard BEFORE INSERT ON governed_evaluator_development_events FOR EACH ROW EXECUTE FUNCTION guard_governed_development_event();


--
-- Name: governed_imported_truth governed_imported_truth_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_imported_truth_append_only BEFORE DELETE OR UPDATE ON governed_imported_truth FOR EACH ROW EXECUTE FUNCTION guard_governed_evidence_append_only();


--
-- Name: governed_imported_truth governed_imported_truth_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_imported_truth_guard BEFORE INSERT ON governed_imported_truth FOR EACH ROW EXECUTE FUNCTION guard_governed_imported_truth();


--
-- Name: governed_input_identity_claims governed_input_identity_claims_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_input_identity_claims_append_only BEFORE DELETE OR UPDATE ON governed_input_identity_claims FOR EACH ROW EXECUTE FUNCTION guard_governed_input_identity_claim();


--
-- Name: governed_review_adjudications governed_review_adjudication_label_set_complete; Type: TRIGGER; Schema: current; Owner: -
--

CREATE CONSTRAINT TRIGGER governed_review_adjudication_label_set_complete AFTER INSERT ON governed_review_adjudications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_governed_adjudication_label_set_complete();


--
-- Name: governed_review_adjudication_labels governed_review_adjudication_labels_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_adjudication_labels_append_only BEFORE DELETE OR UPDATE ON governed_review_adjudication_labels FOR EACH ROW EXECUTE FUNCTION guard_governed_evidence_append_only();


--
-- Name: governed_review_adjudication_labels governed_review_adjudication_labels_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_adjudication_labels_guard BEFORE INSERT ON governed_review_adjudication_labels FOR EACH ROW EXECUTE FUNCTION guard_governed_adjudication_label();


--
-- Name: governed_review_adjudications governed_review_adjudications_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_adjudications_append_only BEFORE DELETE OR UPDATE ON governed_review_adjudications FOR EACH ROW EXECUTE FUNCTION guard_governed_evidence_append_only();


--
-- Name: governed_review_adjudications governed_review_adjudications_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_adjudications_guard BEFORE INSERT ON governed_review_adjudications FOR EACH ROW EXECUTE FUNCTION guard_governed_adjudication();


--
-- Name: governed_review_alignment_event_labels governed_review_alignment_event_labels_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_alignment_event_labels_append_only BEFORE DELETE OR UPDATE ON governed_review_alignment_event_labels FOR EACH ROW EXECUTE FUNCTION guard_governed_evidence_append_only();


--
-- Name: governed_review_alignment_event_labels governed_review_alignment_event_labels_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_alignment_event_labels_guard BEFORE INSERT ON governed_review_alignment_event_labels FOR EACH ROW EXECUTE FUNCTION guard_governed_alignment_event_label();


--
-- Name: governed_review_alignment_events governed_review_alignment_events_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_alignment_events_append_only BEFORE DELETE OR UPDATE ON governed_review_alignment_events FOR EACH ROW EXECUTE FUNCTION guard_governed_evidence_append_only();


--
-- Name: governed_review_alignment_events governed_review_alignment_events_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_alignment_events_guard BEFORE INSERT ON governed_review_alignment_events FOR EACH ROW EXECUTE FUNCTION guard_governed_alignment_event();


--
-- Name: governed_review_alignment_events governed_review_alignment_label_set_complete; Type: TRIGGER; Schema: current; Owner: -
--

CREATE CONSTRAINT TRIGGER governed_review_alignment_label_set_complete AFTER INSERT ON governed_review_alignment_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_governed_alignment_label_set_complete();


--
-- Name: governed_review_batch_events governed_review_batch_events_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_batch_events_append_only BEFORE DELETE OR UPDATE ON governed_review_batch_events FOR EACH ROW EXECUTE FUNCTION guard_governed_evidence_append_only();


--
-- Name: governed_review_batch_events governed_review_batch_events_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_batch_events_guard BEFORE INSERT ON governed_review_batch_events FOR EACH ROW EXECUTE FUNCTION guard_governed_review_batch_event();


--
-- Name: governed_review_batch_items governed_review_batch_items_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_batch_items_append_only BEFORE DELETE OR UPDATE ON governed_review_batch_items FOR EACH ROW EXECUTE FUNCTION guard_governed_evidence_append_only();


--
-- Name: governed_review_batch_items governed_review_batch_items_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_batch_items_guard BEFORE INSERT ON governed_review_batch_items FOR EACH ROW EXECUTE FUNCTION guard_governed_review_batch_item();


--
-- Name: governed_review_batches governed_review_batches_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_batches_append_only BEFORE DELETE OR UPDATE ON governed_review_batches FOR EACH ROW EXECUTE FUNCTION guard_governed_evidence_append_only();


--
-- Name: governed_review_batches governed_review_batches_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_batches_guard BEFORE INSERT ON governed_review_batches FOR EACH ROW EXECUTE FUNCTION guard_governed_review_batch();


--
-- Name: governed_review_capability_checks governed_review_capability_checks_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_capability_checks_append_only BEFORE DELETE OR UPDATE ON governed_review_capability_checks FOR EACH ROW EXECUTE FUNCTION guard_governed_evidence_append_only();


--
-- Name: governed_review_capability_checks governed_review_capability_checks_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_capability_checks_guard BEFORE INSERT ON governed_review_capability_checks FOR EACH ROW EXECUTE FUNCTION guard_governed_capability_check();


--
-- Name: governed_review_items governed_review_items_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_items_append_only BEFORE DELETE OR UPDATE ON governed_review_items FOR EACH ROW EXECUTE FUNCTION guard_governed_evidence_append_only();


--
-- Name: governed_review_items governed_review_items_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_items_guard BEFORE INSERT ON governed_review_items FOR EACH ROW EXECUTE FUNCTION guard_governed_review_item();


--
-- Name: governed_review_labels governed_review_labels_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_labels_append_only BEFORE DELETE OR UPDATE ON governed_review_labels FOR EACH ROW EXECUTE FUNCTION guard_governed_evidence_append_only();


--
-- Name: governed_review_labels governed_review_labels_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_labels_guard BEFORE INSERT ON governed_review_labels FOR EACH ROW EXECUTE FUNCTION guard_governed_review_label();


--
-- Name: governed_review_labels governed_review_labels_submission_complete; Type: TRIGGER; Schema: current; Owner: -
--

CREATE CONSTRAINT TRIGGER governed_review_labels_submission_complete AFTER INSERT ON governed_review_labels DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_governed_label_submission_complete();


--
-- Name: governed_review_task_events governed_review_task_events_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_task_events_append_only BEFORE DELETE OR UPDATE ON governed_review_task_events FOR EACH ROW EXECUTE FUNCTION guard_governed_evidence_append_only();


--
-- Name: governed_review_task_events governed_review_task_events_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_task_events_guard BEFORE INSERT ON governed_review_task_events FOR EACH ROW EXECUTE FUNCTION guard_governed_review_task_event();


--
-- Name: governed_review_tasks governed_review_tasks_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_tasks_append_only BEFORE DELETE OR UPDATE ON governed_review_tasks FOR EACH ROW EXECUTE FUNCTION guard_governed_evidence_append_only();


--
-- Name: governed_review_tasks governed_review_tasks_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_review_tasks_guard BEFORE INSERT ON governed_review_tasks FOR EACH ROW EXECUTE FUNCTION guard_governed_review_task();


--
-- Name: governed_reviewer_subjects governed_reviewer_subjects_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_reviewer_subjects_append_only BEFORE DELETE OR UPDATE ON governed_reviewer_subjects FOR EACH ROW EXECUTE FUNCTION guard_governed_subject_append_only();


--
-- Name: governed_reviewer_subjects governed_reviewer_subjects_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_reviewer_subjects_guard BEFORE INSERT ON governed_reviewer_subjects FOR EACH ROW EXECUTE FUNCTION guard_governed_reviewer_subject();


--
-- Name: governed_sealed_intake_populations governed_sealed_intake_populations_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_sealed_intake_populations_append_only BEFORE DELETE OR UPDATE ON governed_sealed_intake_populations FOR EACH ROW EXECUTE FUNCTION guard_governed_evidence_append_only();


--
-- Name: governed_sealed_intake_populations governed_sealed_intake_populations_complete; Type: TRIGGER; Schema: current; Owner: -
--

CREATE CONSTRAINT TRIGGER governed_sealed_intake_populations_complete AFTER INSERT ON governed_sealed_intake_populations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_governed_sealed_population_complete();


--
-- Name: governed_sealed_intake_populations governed_sealed_intake_populations_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER governed_sealed_intake_populations_guard BEFORE INSERT ON governed_sealed_intake_populations FOR EACH ROW EXECUTE FUNCTION guard_governed_sealed_intake_population();


--
-- Name: import_jobs import_jobs_skill_version_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER import_jobs_skill_version_guard BEFORE INSERT OR UPDATE OF project_id, skill_version_id, status ON import_jobs FOR EACH ROW EXECUTE FUNCTION ensure_import_job_skill_version_binding();


--
-- Name: regression_runs regression_runs_activated_evidence_immutable; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER regression_runs_activated_evidence_immutable BEFORE DELETE OR UPDATE ON regression_runs FOR EACH ROW EXECUTE FUNCTION guard_activated_regression_run_immutable_v1();


--
-- Name: regression_runs regression_runs_criterion_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER regression_runs_criterion_guard BEFORE INSERT OR UPDATE OF criterion_version_id, skill_version_id, project_id ON regression_runs FOR EACH ROW EXECUTE FUNCTION ensure_regression_run_criterion_binding();


--
-- Name: regression_runs regression_runs_revision_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER regression_runs_revision_guard BEFORE INSERT OR UPDATE OF dataset_revision_id ON regression_runs FOR EACH ROW EXECUTE FUNCTION guard_regression_run_revision_binding();


--
-- Name: review_instruction_versions review_instruction_versions_append_only; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER review_instruction_versions_append_only BEFORE DELETE OR UPDATE ON review_instruction_versions FOR EACH ROW EXECUTE FUNCTION guard_governed_evidence_append_only();


--
-- Name: review_instruction_versions review_instruction_versions_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER review_instruction_versions_guard BEFORE INSERT ON review_instruction_versions FOR EACH ROW EXECUTE FUNCTION guard_review_instruction_version();


--
-- Name: review_queue_items review_queue_items_criterion_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER review_queue_items_criterion_guard BEFORE INSERT OR UPDATE OF queue_id, case_id, criterion_version_id ON review_queue_items FOR EACH ROW EXECUTE FUNCTION ensure_review_queue_item_criterion_binding();


--
-- Name: run_comparisons run_comparisons_revision_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER run_comparisons_revision_guard BEFORE INSERT OR UPDATE ON run_comparisons FOR EACH ROW EXECUTE FUNCTION guard_run_comparison_revision();


--
-- Name: skill_versions skill_versions_analysis_promotion_lifecycle_complete; Type: TRIGGER; Schema: current; Owner: -
--

CREATE CONSTRAINT TRIGGER skill_versions_analysis_promotion_lifecycle_complete AFTER INSERT ON skill_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_analysis_promotion_evaluator_complete_v1();


--
-- Name: skill_versions skill_versions_criterion_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER skill_versions_criterion_guard BEFORE INSERT OR UPDATE OF criterion_version_id, skill_id, project_id ON skill_versions FOR EACH ROW EXECUTE FUNCTION ensure_skill_version_criterion_binding();


--
-- Name: skill_versions skill_versions_developer_identity_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER skill_versions_developer_identity_guard BEFORE INSERT OR UPDATE OF created_by_user_id, created_by_subject_id, developer_identity_status ON skill_versions FOR EACH ROW EXECUTE FUNCTION guard_skill_version_developer_identity();


--
-- Name: skill_versions skill_versions_development_event_append; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER skill_versions_development_event_append AFTER INSERT ON skill_versions FOR EACH ROW EXECUTE FUNCTION append_skill_version_development_event();


--
-- Name: skill_versions skill_versions_revision_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER skill_versions_revision_guard BEFORE INSERT OR UPDATE OF regression_dataset_revision_id ON skill_versions FOR EACH ROW EXECUTE FUNCTION guard_skill_version_revision_binding();


--
-- Name: skills skills_analysis_promotion_lifecycle_complete; Type: TRIGGER; Schema: current; Owner: -
--

CREATE CONSTRAINT TRIGGER skills_analysis_promotion_lifecycle_complete AFTER INSERT ON skills DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_analysis_promotion_evaluator_complete_v1();


--
-- Name: skills skills_criterion_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER skills_criterion_guard BEFORE INSERT OR UPDATE OF criterion_id, project_id ON skills FOR EACH ROW EXECUTE FUNCTION ensure_skill_criterion_binding();


--
-- Name: verdicts verdicts_human_criterion_guard; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER verdicts_human_criterion_guard BEFORE INSERT OR UPDATE OF project_id, case_id, skill_version_id, source ON verdicts FOR EACH ROW EXECUTE FUNCTION ensure_human_verdict_criterion_binding();


--
-- Name: binary_calibration_revocation_events zzz_binary_calibration_revocation_lifecycle_event; Type: TRIGGER; Schema: current; Owner: -
--

CREATE TRIGGER zzz_binary_calibration_revocation_lifecycle_event AFTER INSERT ON binary_calibration_revocation_events FOR EACH ROW EXECUTE FUNCTION append_evaluator_needs_review_on_revocation_v1();


--
-- Name: account account_user_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY account
    ADD CONSTRAINT account_user_id_fkey FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;


--
-- Name: agent_setup_pairings agent_setup_pairings_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY agent_setup_pairings
    ADD CONSTRAINT agent_setup_pairings_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES "user"(id) ON DELETE CASCADE;


--
-- Name: agent_setup_pairings agent_setup_pairings_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY agent_setup_pairings
    ADD CONSTRAINT agent_setup_pairings_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: analysis_criterion_promotion_supports analysis_criterion_promotion_supports_assignment_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotion_supports
    ADD CONSTRAINT analysis_criterion_promotion_supports_assignment_fkey FOREIGN KEY (assignment_event_id, project_id, study_id, study_item_id, observation_event_id, assignment_event_digest) REFERENCES analysis_observation_assignment_events(id, project_id, study_id, study_item_id, observation_event_id, event_digest);


--
-- Name: analysis_criterion_promotion_supports analysis_criterion_promotion_supports_author_subject_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotion_supports
    ADD CONSTRAINT analysis_criterion_promotion_supports_author_subject_fkey FOREIGN KEY (observation_author_subject_id, project_id) REFERENCES governed_reviewer_subjects(id, project_id);


--
-- Name: analysis_criterion_promotion_supports analysis_criterion_promotion_supports_closure_item_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotion_supports
    ADD CONSTRAINT analysis_criterion_promotion_supports_closure_item_fkey FOREIGN KEY (closure_item_id, project_id, study_id, closure_id, closure_item_digest) REFERENCES analysis_study_closure_items(id, project_id, study_id, closure_id, content_digest);


--
-- Name: analysis_criterion_promotion_supports analysis_criterion_promotion_supports_exposure_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotion_supports
    ADD CONSTRAINT analysis_criterion_promotion_supports_exposure_fkey FOREIGN KEY (example_selection_exposure_event_id, project_id) REFERENCES dataset_exposure_events(id, project_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: analysis_criterion_promotion_supports analysis_criterion_promotion_supports_item_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotion_supports
    ADD CONSTRAINT analysis_criterion_promotion_supports_item_fkey FOREIGN KEY (study_item_id, project_id, study_id) REFERENCES analysis_study_items(id, project_id, study_id);


--
-- Name: analysis_criterion_promotion_supports analysis_criterion_promotion_supports_observation_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotion_supports
    ADD CONSTRAINT analysis_criterion_promotion_supports_observation_fkey FOREIGN KEY (observation_event_id, project_id, study_id, study_item_id, observation_event_digest) REFERENCES analysis_study_item_events(id, project_id, study_id, study_item_id, event_digest);


--
-- Name: analysis_criterion_promotion_supports analysis_criterion_promotion_supports_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotion_supports
    ADD CONSTRAINT analysis_criterion_promotion_supports_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: analysis_criterion_promotion_supports analysis_criterion_promotion_supports_promotion_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotion_supports
    ADD CONSTRAINT analysis_criterion_promotion_supports_promotion_fkey FOREIGN KEY (promotion_id, project_id) REFERENCES analysis_criterion_promotions(id, project_id);


--
-- Name: analysis_criterion_promotion_supports analysis_criterion_promotion_supports_revision_item_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotion_supports
    ADD CONSTRAINT analysis_criterion_promotion_supports_revision_item_fkey FOREIGN KEY (source_dataset_revision_item_id, project_id) REFERENCES dataset_revision_items(id, project_id);


--
-- Name: analysis_criterion_promotions analysis_criterion_promotions_closure_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotions
    ADD CONSTRAINT analysis_criterion_promotions_closure_fkey FOREIGN KEY (study_closure_id, project_id, study_id, study_closure_digest) REFERENCES analysis_study_closures(id, project_id, study_id, closure_digest);


--
-- Name: analysis_criterion_promotions analysis_criterion_promotions_code_entry_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotions
    ADD CONSTRAINT analysis_criterion_promotions_code_entry_fkey FOREIGN KEY (code_entry_id, project_id, taxonomy_id, taxonomy_revision_id, code_id, code_entry_digest) REFERENCES analysis_failure_taxonomy_revision_codes(id, project_id, taxonomy_id, taxonomy_revision_id, code_id, entry_digest);


--
-- Name: analysis_criterion_promotions analysis_criterion_promotions_criterion_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotions
    ADD CONSTRAINT analysis_criterion_promotions_criterion_fkey FOREIGN KEY (criterion_id, project_id) REFERENCES criteria(id, project_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: analysis_criterion_promotions analysis_criterion_promotions_criterion_version_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotions
    ADD CONSTRAINT analysis_criterion_promotions_criterion_version_fkey FOREIGN KEY (criterion_version_id, project_id, criterion_id, criterion_digest) REFERENCES criterion_versions(id, project_id, criterion_id, criterion_digest) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: analysis_criterion_promotions analysis_criterion_promotions_exposure_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotions
    ADD CONSTRAINT analysis_criterion_promotions_exposure_fkey FOREIGN KEY (criterion_authoring_exposure_event_id, project_id) REFERENCES dataset_exposure_events(id, project_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: analysis_criterion_promotions analysis_criterion_promotions_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotions
    ADD CONSTRAINT analysis_criterion_promotions_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: analysis_criterion_promotions analysis_criterion_promotions_revision_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotions
    ADD CONSTRAINT analysis_criterion_promotions_revision_fkey FOREIGN KEY (source_dataset_revision_id, project_id) REFERENCES dataset_revisions(id, project_id);


--
-- Name: analysis_criterion_promotions analysis_criterion_promotions_study_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotions
    ADD CONSTRAINT analysis_criterion_promotions_study_fkey FOREIGN KEY (study_id, project_id, population_id, draw_id, source_dataset_revision_id) REFERENCES analysis_studies(id, project_id, population_id, draw_id, dataset_revision_id);


--
-- Name: analysis_criterion_promotions analysis_criterion_promotions_subject_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotions
    ADD CONSTRAINT analysis_criterion_promotions_subject_fkey FOREIGN KEY (promoted_by_subject_id, project_id) REFERENCES governed_reviewer_subjects(id, project_id);


--
-- Name: analysis_criterion_promotions analysis_criterion_promotions_taxonomy_revision_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_criterion_promotions
    ADD CONSTRAINT analysis_criterion_promotions_taxonomy_revision_fkey FOREIGN KEY (taxonomy_revision_id, project_id, taxonomy_id, taxonomy_revision_digest) REFERENCES analysis_failure_taxonomy_revisions(id, project_id, taxonomy_id, revision_digest);


--
-- Name: analysis_failure_codes analysis_failure_codes_created_revision_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_codes
    ADD CONSTRAINT analysis_failure_codes_created_revision_fkey FOREIGN KEY (created_in_revision_id, project_id) REFERENCES analysis_failure_taxonomy_revisions(id, project_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: analysis_failure_codes analysis_failure_codes_creator_subject_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_codes
    ADD CONSTRAINT analysis_failure_codes_creator_subject_fkey FOREIGN KEY (created_by_subject_id, project_id) REFERENCES governed_reviewer_subjects(id, project_id);


--
-- Name: analysis_failure_codes analysis_failure_codes_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_codes
    ADD CONSTRAINT analysis_failure_codes_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: analysis_failure_codes analysis_failure_codes_taxonomy_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_codes
    ADD CONSTRAINT analysis_failure_codes_taxonomy_fkey FOREIGN KEY (taxonomy_id, project_id) REFERENCES analysis_failure_taxonomies(id, project_id);


--
-- Name: analysis_failure_taxonomies analysis_failure_taxonomies_creator_subject_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_taxonomies
    ADD CONSTRAINT analysis_failure_taxonomies_creator_subject_fkey FOREIGN KEY (created_by_subject_id, project_id) REFERENCES governed_reviewer_subjects(id, project_id);


--
-- Name: analysis_failure_taxonomies analysis_failure_taxonomies_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_taxonomies
    ADD CONSTRAINT analysis_failure_taxonomies_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: analysis_failure_taxonomy_revision_codes analysis_failure_taxonomy_revision_codes_code_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_taxonomy_revision_codes
    ADD CONSTRAINT analysis_failure_taxonomy_revision_codes_code_fkey FOREIGN KEY (code_id, project_id) REFERENCES analysis_failure_codes(id, project_id);


--
-- Name: analysis_failure_taxonomy_revision_codes analysis_failure_taxonomy_revision_codes_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_taxonomy_revision_codes
    ADD CONSTRAINT analysis_failure_taxonomy_revision_codes_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: analysis_failure_taxonomy_revision_codes analysis_failure_taxonomy_revision_codes_revision_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_taxonomy_revision_codes
    ADD CONSTRAINT analysis_failure_taxonomy_revision_codes_revision_fkey FOREIGN KEY (taxonomy_revision_id, project_id) REFERENCES analysis_failure_taxonomy_revisions(id, project_id);


--
-- Name: analysis_failure_taxonomy_revision_codes analysis_failure_taxonomy_revision_codes_taxonomy_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_taxonomy_revision_codes
    ADD CONSTRAINT analysis_failure_taxonomy_revision_codes_taxonomy_fkey FOREIGN KEY (taxonomy_id, project_id) REFERENCES analysis_failure_taxonomies(id, project_id);


--
-- Name: analysis_failure_taxonomy_revisions analysis_failure_taxonomy_revisions_creator_subject_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_taxonomy_revisions
    ADD CONSTRAINT analysis_failure_taxonomy_revisions_creator_subject_fkey FOREIGN KEY (created_by_subject_id, project_id) REFERENCES governed_reviewer_subjects(id, project_id);


--
-- Name: analysis_failure_taxonomy_revisions analysis_failure_taxonomy_revisions_predecessor_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_taxonomy_revisions
    ADD CONSTRAINT analysis_failure_taxonomy_revisions_predecessor_fkey FOREIGN KEY (predecessor_revision_id, project_id, taxonomy_id, predecessor_revision_digest) REFERENCES analysis_failure_taxonomy_revisions(id, project_id, taxonomy_id, revision_digest);


--
-- Name: analysis_failure_taxonomy_revisions analysis_failure_taxonomy_revisions_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_taxonomy_revisions
    ADD CONSTRAINT analysis_failure_taxonomy_revisions_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: analysis_failure_taxonomy_revisions analysis_failure_taxonomy_revisions_taxonomy_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_failure_taxonomy_revisions
    ADD CONSTRAINT analysis_failure_taxonomy_revisions_taxonomy_fkey FOREIGN KEY (taxonomy_id, project_id) REFERENCES analysis_failure_taxonomies(id, project_id);


--
-- Name: analysis_observation_assignment_events analysis_observation_assignment_events_actor_subject_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_observation_assignment_events
    ADD CONSTRAINT analysis_observation_assignment_events_actor_subject_fkey FOREIGN KEY (actor_subject_id, project_id) REFERENCES governed_reviewer_subjects(id, project_id);


--
-- Name: analysis_observation_assignment_events analysis_observation_assignment_events_code_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_observation_assignment_events
    ADD CONSTRAINT analysis_observation_assignment_events_code_fkey FOREIGN KEY (code_id, project_id) REFERENCES analysis_failure_codes(id, project_id);


--
-- Name: analysis_observation_assignment_events analysis_observation_assignment_events_item_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_observation_assignment_events
    ADD CONSTRAINT analysis_observation_assignment_events_item_fkey FOREIGN KEY (study_item_id, project_id) REFERENCES analysis_study_items(id, project_id);


--
-- Name: analysis_observation_assignment_events analysis_observation_assignment_events_observation_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_observation_assignment_events
    ADD CONSTRAINT analysis_observation_assignment_events_observation_fkey FOREIGN KEY (observation_event_id, project_id) REFERENCES analysis_study_item_events(id, project_id);


--
-- Name: analysis_observation_assignment_events analysis_observation_assignment_events_predecessor_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_observation_assignment_events
    ADD CONSTRAINT analysis_observation_assignment_events_predecessor_fkey FOREIGN KEY (predecessor_event_id, project_id, observation_event_id, predecessor_event_digest) REFERENCES analysis_observation_assignment_events(id, project_id, observation_event_id, event_digest);


--
-- Name: analysis_observation_assignment_events analysis_observation_assignment_events_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_observation_assignment_events
    ADD CONSTRAINT analysis_observation_assignment_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: analysis_observation_assignment_events analysis_observation_assignment_events_revision_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_observation_assignment_events
    ADD CONSTRAINT analysis_observation_assignment_events_revision_fkey FOREIGN KEY (taxonomy_revision_id, project_id) REFERENCES analysis_failure_taxonomy_revisions(id, project_id);


--
-- Name: analysis_observation_assignment_events analysis_observation_assignment_events_study_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_observation_assignment_events
    ADD CONSTRAINT analysis_observation_assignment_events_study_fkey FOREIGN KEY (study_id, project_id) REFERENCES analysis_studies(id, project_id);


--
-- Name: analysis_observation_assignment_events analysis_observation_assignment_events_taxonomy_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_observation_assignment_events
    ADD CONSTRAINT analysis_observation_assignment_events_taxonomy_fkey FOREIGN KEY (taxonomy_id, project_id) REFERENCES analysis_failure_taxonomies(id, project_id);


--
-- Name: analysis_population_draw_items analysis_population_draw_items_draw_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_draw_items
    ADD CONSTRAINT analysis_population_draw_items_draw_fkey FOREIGN KEY (draw_id, project_id, population_id) REFERENCES analysis_population_draws(id, project_id, population_id);


--
-- Name: analysis_population_draw_items analysis_population_draw_items_member_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_draw_items
    ADD CONSTRAINT analysis_population_draw_items_member_fkey FOREIGN KEY (member_id, project_id, population_id) REFERENCES analysis_population_members(id, project_id, population_id);


--
-- Name: analysis_population_draw_items analysis_population_draw_items_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_draw_items
    ADD CONSTRAINT analysis_population_draw_items_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: analysis_population_draw_items analysis_population_draw_items_revision_item_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_draw_items
    ADD CONSTRAINT analysis_population_draw_items_revision_item_fkey FOREIGN KEY (revision_item_id, project_id) REFERENCES dataset_revision_items(id, project_id);


--
-- Name: analysis_population_draws analysis_population_draws_executor_subject_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_draws
    ADD CONSTRAINT analysis_population_draws_executor_subject_fkey FOREIGN KEY (executed_by_subject_id, project_id) REFERENCES governed_reviewer_subjects(id, project_id);


--
-- Name: analysis_population_draws analysis_population_draws_population_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_draws
    ADD CONSTRAINT analysis_population_draws_population_fkey FOREIGN KEY (population_id, project_id) REFERENCES analysis_populations(id, project_id);


--
-- Name: analysis_population_draws analysis_population_draws_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_draws
    ADD CONSTRAINT analysis_population_draws_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: analysis_population_draws analysis_population_draws_revision_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_draws
    ADD CONSTRAINT analysis_population_draws_revision_fkey FOREIGN KEY (dataset_revision_id, project_id) REFERENCES dataset_revisions(id, project_id);


--
-- Name: analysis_population_exclusions analysis_population_exclusions_population_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_exclusions
    ADD CONSTRAINT analysis_population_exclusions_population_fkey FOREIGN KEY (population_id, project_id) REFERENCES analysis_populations(id, project_id);


--
-- Name: analysis_population_exclusions analysis_population_exclusions_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_exclusions
    ADD CONSTRAINT analysis_population_exclusions_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: analysis_population_members analysis_population_members_population_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_members
    ADD CONSTRAINT analysis_population_members_population_fkey FOREIGN KEY (population_id, project_id) REFERENCES analysis_populations(id, project_id);


--
-- Name: analysis_population_members analysis_population_members_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_members
    ADD CONSTRAINT analysis_population_members_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: analysis_population_members analysis_population_members_revision_item_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_members
    ADD CONSTRAINT analysis_population_members_revision_item_fkey FOREIGN KEY (revision_item_id, project_id) REFERENCES dataset_revision_items(id, project_id);


--
-- Name: analysis_population_requests analysis_population_requests_population_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_requests
    ADD CONSTRAINT analysis_population_requests_population_fkey FOREIGN KEY (population_id, project_id) REFERENCES analysis_populations(id, project_id);


--
-- Name: analysis_population_requests analysis_population_requests_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_population_requests
    ADD CONSTRAINT analysis_population_requests_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: analysis_populations analysis_populations_creator_subject_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_populations
    ADD CONSTRAINT analysis_populations_creator_subject_fkey FOREIGN KEY (created_by_subject_id, project_id) REFERENCES governed_reviewer_subjects(id, project_id);


--
-- Name: analysis_populations analysis_populations_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_populations
    ADD CONSTRAINT analysis_populations_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: analysis_populations analysis_populations_revision_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_populations
    ADD CONSTRAINT analysis_populations_revision_fkey FOREIGN KEY (dataset_revision_id, project_id) REFERENCES dataset_revisions(id, project_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: analysis_studies analysis_studies_creator_subject_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_studies
    ADD CONSTRAINT analysis_studies_creator_subject_fkey FOREIGN KEY (created_by_subject_id, project_id) REFERENCES governed_reviewer_subjects(id, project_id);


--
-- Name: analysis_studies analysis_studies_draw_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_studies
    ADD CONSTRAINT analysis_studies_draw_fkey FOREIGN KEY (draw_id, project_id, population_id) REFERENCES analysis_population_draws(id, project_id, population_id);


--
-- Name: analysis_studies analysis_studies_population_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_studies
    ADD CONSTRAINT analysis_studies_population_fkey FOREIGN KEY (population_id, project_id) REFERENCES analysis_populations(id, project_id);


--
-- Name: analysis_studies analysis_studies_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_studies
    ADD CONSTRAINT analysis_studies_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: analysis_studies analysis_studies_revision_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_studies
    ADD CONSTRAINT analysis_studies_revision_fkey FOREIGN KEY (dataset_revision_id, project_id) REFERENCES dataset_revisions(id, project_id);


--
-- Name: analysis_study_closure_items analysis_study_closure_items_closure_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_closure_items
    ADD CONSTRAINT analysis_study_closure_items_closure_fkey FOREIGN KEY (closure_id, project_id) REFERENCES analysis_study_closures(id, project_id);


--
-- Name: analysis_study_closure_items analysis_study_closure_items_completion_event_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_closure_items
    ADD CONSTRAINT analysis_study_closure_items_completion_event_fkey FOREIGN KEY (completion_event_id, project_id, study_id, study_item_id, completion_event_digest) REFERENCES analysis_study_item_events(id, project_id, study_id, study_item_id, event_digest);


--
-- Name: analysis_study_closure_items analysis_study_closure_items_current_event_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_closure_items
    ADD CONSTRAINT analysis_study_closure_items_current_event_fkey FOREIGN KEY (current_event_id, project_id, study_id, study_item_id, current_event_digest) REFERENCES analysis_study_item_events(id, project_id, study_id, study_item_id, event_digest);


--
-- Name: analysis_study_closure_items analysis_study_closure_items_item_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_closure_items
    ADD CONSTRAINT analysis_study_closure_items_item_fkey FOREIGN KEY (study_item_id, project_id, study_id) REFERENCES analysis_study_items(id, project_id, study_id);


--
-- Name: analysis_study_closure_items analysis_study_closure_items_no_failure_event_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_closure_items
    ADD CONSTRAINT analysis_study_closure_items_no_failure_event_fkey FOREIGN KEY (active_no_failure_event_id, project_id, study_id, study_item_id, active_no_failure_event_digest) REFERENCES analysis_study_item_events(id, project_id, study_id, study_item_id, event_digest);


--
-- Name: analysis_study_closure_items analysis_study_closure_items_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_closure_items
    ADD CONSTRAINT analysis_study_closure_items_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: analysis_study_closure_items analysis_study_closure_items_study_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_closure_items
    ADD CONSTRAINT analysis_study_closure_items_study_fkey FOREIGN KEY (study_id, project_id) REFERENCES analysis_studies(id, project_id);


--
-- Name: analysis_study_closures analysis_study_closures_close_actor_subject_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_closures
    ADD CONSTRAINT analysis_study_closures_close_actor_subject_fkey FOREIGN KEY (close_actor_subject_id, project_id) REFERENCES governed_reviewer_subjects(id, project_id);


--
-- Name: analysis_study_closures analysis_study_closures_population_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_closures
    ADD CONSTRAINT analysis_study_closures_population_fkey FOREIGN KEY (drawn_from_population_id, project_id) REFERENCES analysis_populations(id, project_id);


--
-- Name: analysis_study_closures analysis_study_closures_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_closures
    ADD CONSTRAINT analysis_study_closures_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: analysis_study_closures analysis_study_closures_representative_population_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_closures
    ADD CONSTRAINT analysis_study_closures_representative_population_fkey FOREIGN KEY (representative_of_population_id, project_id) REFERENCES analysis_populations(id, project_id);


--
-- Name: analysis_study_closures analysis_study_closures_study_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_closures
    ADD CONSTRAINT analysis_study_closures_study_fkey FOREIGN KEY (study_id, project_id, population_id, draw_id, dataset_revision_id) REFERENCES analysis_studies(id, project_id, population_id, draw_id, dataset_revision_id);


--
-- Name: analysis_study_deadline_retry_state analysis_study_deadline_retry_state_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_deadline_retry_state
    ADD CONSTRAINT analysis_study_deadline_retry_state_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: analysis_study_deadline_retry_state analysis_study_deadline_retry_state_project_id_study_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_deadline_retry_state
    ADD CONSTRAINT analysis_study_deadline_retry_state_project_id_study_id_fkey FOREIGN KEY (project_id, study_id) REFERENCES analysis_studies(project_id, id) ON DELETE CASCADE;


--
-- Name: analysis_study_events analysis_study_events_actor_subject_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_events
    ADD CONSTRAINT analysis_study_events_actor_subject_fkey FOREIGN KEY (actor_subject_id, project_id) REFERENCES governed_reviewer_subjects(id, project_id);


--
-- Name: analysis_study_events analysis_study_events_closure_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_events
    ADD CONSTRAINT analysis_study_events_closure_fkey FOREIGN KEY (closure_id, project_id, study_id, closure_digest) REFERENCES analysis_study_closures(id, project_id, study_id, closure_digest) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: analysis_study_events analysis_study_events_predecessor_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_events
    ADD CONSTRAINT analysis_study_events_predecessor_fkey FOREIGN KEY (predecessor_event_id, project_id, study_id, predecessor_event_digest) REFERENCES analysis_study_events(id, project_id, study_id, event_digest);


--
-- Name: analysis_study_events analysis_study_events_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_events
    ADD CONSTRAINT analysis_study_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: analysis_study_events analysis_study_events_study_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_events
    ADD CONSTRAINT analysis_study_events_study_fkey FOREIGN KEY (study_id, project_id) REFERENCES analysis_studies(id, project_id);


--
-- Name: analysis_study_item_events analysis_study_item_events_actor_subject_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_item_events
    ADD CONSTRAINT analysis_study_item_events_actor_subject_fkey FOREIGN KEY (actor_subject_id, project_id) REFERENCES governed_reviewer_subjects(id, project_id);


--
-- Name: analysis_study_item_events analysis_study_item_events_item_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_item_events
    ADD CONSTRAINT analysis_study_item_events_item_fkey FOREIGN KEY (study_item_id, project_id) REFERENCES analysis_study_items(id, project_id);


--
-- Name: analysis_study_item_events analysis_study_item_events_predecessor_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_item_events
    ADD CONSTRAINT analysis_study_item_events_predecessor_fkey FOREIGN KEY (predecessor_event_id, project_id, study_id, study_item_id, predecessor_event_digest) REFERENCES analysis_study_item_events(id, project_id, study_id, study_item_id, event_digest);


--
-- Name: analysis_study_item_events analysis_study_item_events_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_item_events
    ADD CONSTRAINT analysis_study_item_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: analysis_study_item_events analysis_study_item_events_study_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_item_events
    ADD CONSTRAINT analysis_study_item_events_study_fkey FOREIGN KEY (study_id, project_id) REFERENCES analysis_studies(id, project_id);


--
-- Name: analysis_study_item_events analysis_study_item_events_target_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_item_events
    ADD CONSTRAINT analysis_study_item_events_target_fkey FOREIGN KEY (target_event_id, project_id, study_id, study_item_id, target_event_digest) REFERENCES analysis_study_item_events(id, project_id, study_id, study_item_id, event_digest);


--
-- Name: analysis_study_item_views analysis_study_item_views_exposure_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_item_views
    ADD CONSTRAINT analysis_study_item_views_exposure_fkey FOREIGN KEY (dataset_exposure_event_id, project_id) REFERENCES dataset_exposure_events(id, project_id);


--
-- Name: analysis_study_item_views analysis_study_item_views_item_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_item_views
    ADD CONSTRAINT analysis_study_item_views_item_fkey FOREIGN KEY (study_item_id, project_id, study_id) REFERENCES analysis_study_items(id, project_id, study_id);


--
-- Name: analysis_study_item_views analysis_study_item_views_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_item_views
    ADD CONSTRAINT analysis_study_item_views_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: analysis_study_item_views analysis_study_item_views_study_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_item_views
    ADD CONSTRAINT analysis_study_item_views_study_fkey FOREIGN KEY (study_id, project_id) REFERENCES analysis_studies(id, project_id);


--
-- Name: analysis_study_item_views analysis_study_item_views_subject_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_item_views
    ADD CONSTRAINT analysis_study_item_views_subject_fkey FOREIGN KEY (viewer_subject_id, project_id) REFERENCES governed_reviewer_subjects(id, project_id);


--
-- Name: analysis_study_items analysis_study_items_draw_item_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_items
    ADD CONSTRAINT analysis_study_items_draw_item_fkey FOREIGN KEY (draw_item_id, project_id) REFERENCES analysis_population_draw_items(id, project_id);


--
-- Name: analysis_study_items analysis_study_items_member_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_items
    ADD CONSTRAINT analysis_study_items_member_fkey FOREIGN KEY (member_id, project_id) REFERENCES analysis_population_members(id, project_id);


--
-- Name: analysis_study_items analysis_study_items_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_items
    ADD CONSTRAINT analysis_study_items_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: analysis_study_items analysis_study_items_revision_item_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_items
    ADD CONSTRAINT analysis_study_items_revision_item_fkey FOREIGN KEY (revision_item_id, project_id) REFERENCES dataset_revision_items(id, project_id);


--
-- Name: analysis_study_items analysis_study_items_study_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY analysis_study_items
    ADD CONSTRAINT analysis_study_items_study_fkey FOREIGN KEY (study_id, project_id) REFERENCES analysis_studies(id, project_id);


--
-- Name: api_keys api_keys_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY api_keys
    ADD CONSTRAINT api_keys_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES "user"(id) ON DELETE SET NULL;


--
-- Name: api_keys api_keys_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY api_keys
    ADD CONSTRAINT api_keys_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: assessment_receipt_artifacts assessment_receipt_artifacts_eval_run_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY assessment_receipt_artifacts
    ADD CONSTRAINT assessment_receipt_artifacts_eval_run_id_fkey FOREIGN KEY (eval_run_id) REFERENCES eval_runs(id) ON DELETE CASCADE;


--
-- Name: assessment_receipt_artifacts assessment_receipt_artifacts_predecessor_artifact_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY assessment_receipt_artifacts
    ADD CONSTRAINT assessment_receipt_artifacts_predecessor_artifact_id_fkey FOREIGN KEY (predecessor_artifact_id) REFERENCES assessment_receipt_artifacts(id) ON DELETE CASCADE;


--
-- Name: assessment_receipt_artifacts assessment_receipt_artifacts_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY assessment_receipt_artifacts
    ADD CONSTRAINT assessment_receipt_artifacts_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: assessment_receipt_comparisons assessment_receipt_comparisons_artifact_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY assessment_receipt_comparisons
    ADD CONSTRAINT assessment_receipt_comparisons_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES assessment_receipt_artifacts(id) ON DELETE CASCADE;


--
-- Name: assessment_receipt_comparisons assessment_receipt_comparisons_eval_run_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY assessment_receipt_comparisons
    ADD CONSTRAINT assessment_receipt_comparisons_eval_run_id_fkey FOREIGN KEY (eval_run_id) REFERENCES eval_runs(id) ON DELETE CASCADE;


--
-- Name: assessment_receipt_comparisons assessment_receipt_comparisons_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY assessment_receipt_comparisons
    ADD CONSTRAINT assessment_receipt_comparisons_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: audit_logs audit_logs_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY audit_logs
    ADD CONSTRAINT audit_logs_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;


--
-- Name: binary_calibration_artifacts binary_calibration_artifacts_predecessor_artifact_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_artifacts
    ADD CONSTRAINT binary_calibration_artifacts_predecessor_artifact_id_fkey FOREIGN KEY (predecessor_artifact_id) REFERENCES binary_calibration_artifacts(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_artifacts binary_calibration_artifacts_private_ledger_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_artifacts
    ADD CONSTRAINT binary_calibration_artifacts_private_ledger_id_fkey FOREIGN KEY (private_ledger_id) REFERENCES binary_calibration_private_ledgers(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_artifacts binary_calibration_artifacts_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_artifacts
    ADD CONSTRAINT binary_calibration_artifacts_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_artifacts binary_calibration_artifacts_run_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_artifacts
    ADD CONSTRAINT binary_calibration_artifacts_run_id_fkey FOREIGN KEY (run_id) REFERENCES binary_calibration_runs(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_attempts binary_calibration_attempts_dataset_revision_item_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_attempts
    ADD CONSTRAINT binary_calibration_attempts_dataset_revision_item_id_fkey FOREIGN KEY (dataset_revision_item_id) REFERENCES dataset_revision_items(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_attempts binary_calibration_attempts_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_attempts
    ADD CONSTRAINT binary_calibration_attempts_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_attempts binary_calibration_attempts_run_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_attempts
    ADD CONSTRAINT binary_calibration_attempts_run_id_fkey FOREIGN KEY (run_id) REFERENCES binary_calibration_runs(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_exposure_checks binary_calibration_exposure_checks_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_exposure_checks
    ADD CONSTRAINT binary_calibration_exposure_checks_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_exposure_checks binary_calibration_exposure_checks_run_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_exposure_checks
    ADD CONSTRAINT binary_calibration_exposure_checks_run_id_fkey FOREIGN KEY (run_id) REFERENCES binary_calibration_runs(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_private_ledgers binary_calibration_private_ledger_artifact_fk; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_private_ledgers
    ADD CONSTRAINT binary_calibration_private_ledger_artifact_fk FOREIGN KEY (artifact_id) REFERENCES binary_calibration_artifacts(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: binary_calibration_private_ledgers binary_calibration_private_ledgers_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_private_ledgers
    ADD CONSTRAINT binary_calibration_private_ledgers_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_private_ledgers binary_calibration_private_ledgers_run_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_private_ledgers
    ADD CONSTRAINT binary_calibration_private_ledgers_run_id_fkey FOREIGN KEY (run_id) REFERENCES binary_calibration_runs(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_revision_leases binary_calibration_revision_leases_dataset_revision_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_revision_leases
    ADD CONSTRAINT binary_calibration_revision_leases_dataset_revision_id_fkey FOREIGN KEY (dataset_revision_id) REFERENCES dataset_revisions(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_revision_leases binary_calibration_revision_leases_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_revision_leases
    ADD CONSTRAINT binary_calibration_revision_leases_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_revision_leases binary_calibration_revision_leases_run_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_revision_leases
    ADD CONSTRAINT binary_calibration_revision_leases_run_id_fkey FOREIGN KEY (run_id) REFERENCES binary_calibration_runs(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_revocation_events binary_calibration_revocation_events_artifact_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_revocation_events
    ADD CONSTRAINT binary_calibration_revocation_events_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES binary_calibration_artifacts(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_revocation_events binary_calibration_revocation_events_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_revocation_events
    ADD CONSTRAINT binary_calibration_revocation_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_revocation_events binary_calibration_revocation_events_run_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_revocation_events
    ADD CONSTRAINT binary_calibration_revocation_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES binary_calibration_runs(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_runs binary_calibration_runs_criterion_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_runs
    ADD CONSTRAINT binary_calibration_runs_criterion_id_fkey FOREIGN KEY (criterion_id) REFERENCES criteria(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_runs binary_calibration_runs_criterion_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_runs
    ADD CONSTRAINT binary_calibration_runs_criterion_version_id_fkey FOREIGN KEY (criterion_version_id) REFERENCES criterion_versions(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_runs binary_calibration_runs_dataset_revision_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_runs
    ADD CONSTRAINT binary_calibration_runs_dataset_revision_id_fkey FOREIGN KEY (dataset_revision_id) REFERENCES dataset_revisions(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_runs binary_calibration_runs_governed_review_batch_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_runs
    ADD CONSTRAINT binary_calibration_runs_governed_review_batch_id_fkey FOREIGN KEY (governed_review_batch_id) REFERENCES governed_review_batches(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_runs binary_calibration_runs_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_runs
    ADD CONSTRAINT binary_calibration_runs_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_runs binary_calibration_runs_review_instruction_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_runs
    ADD CONSTRAINT binary_calibration_runs_review_instruction_version_id_fkey FOREIGN KEY (review_instruction_version_id) REFERENCES review_instruction_versions(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_runs binary_calibration_runs_skill_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_runs
    ADD CONSTRAINT binary_calibration_runs_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_runs binary_calibration_runs_skill_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_runs
    ADD CONSTRAINT binary_calibration_runs_skill_version_id_fkey FOREIGN KEY (skill_version_id) REFERENCES skill_versions(id) ON DELETE CASCADE;


--
-- Name: binary_calibration_runs binary_calibration_runs_suite_manifest_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY binary_calibration_runs
    ADD CONSTRAINT binary_calibration_runs_suite_manifest_id_fkey FOREIGN KEY (suite_manifest_id) REFERENCES evaluator_suite_manifests(id) ON DELETE CASCADE;


--
-- Name: case_input_identity_records case_input_identity_records_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY case_input_identity_records
    ADD CONSTRAINT case_input_identity_records_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: cases cases_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY cases
    ADD CONSTRAINT cases_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: cases cases_raw_trace_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY cases
    ADD CONSTRAINT cases_raw_trace_id_fkey FOREIGN KEY (raw_trace_id) REFERENCES raw_traces(id);


--
-- Name: cases cases_raw_trace_project_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY cases
    ADD CONSTRAINT cases_raw_trace_project_fkey FOREIGN KEY (raw_trace_id, project_id) REFERENCES raw_traces(id, project_id);


--
-- Name: criteria criteria_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY criteria
    ADD CONSTRAINT criteria_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: criterion_regression_revisions criterion_regression_revisions_criterion_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY criterion_regression_revisions
    ADD CONSTRAINT criterion_regression_revisions_criterion_version_id_fkey FOREIGN KEY (criterion_version_id) REFERENCES criterion_versions(id) ON DELETE CASCADE;


--
-- Name: criterion_regression_revisions criterion_regression_revisions_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY criterion_regression_revisions
    ADD CONSTRAINT criterion_regression_revisions_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: criterion_regression_revisions criterion_regression_revisions_revision_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY criterion_regression_revisions
    ADD CONSTRAINT criterion_regression_revisions_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES dataset_revisions(id) ON DELETE CASCADE;


--
-- Name: criterion_versions criterion_versions_criterion_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY criterion_versions
    ADD CONSTRAINT criterion_versions_criterion_id_fkey FOREIGN KEY (criterion_id) REFERENCES criteria(id) ON DELETE CASCADE;


--
-- Name: criterion_versions criterion_versions_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY criterion_versions
    ADD CONSTRAINT criterion_versions_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: dataset_exposure_events dataset_exposure_events_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY dataset_exposure_events
    ADD CONSTRAINT dataset_exposure_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: dataset_exposure_events dataset_exposure_events_revision_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY dataset_exposure_events
    ADD CONSTRAINT dataset_exposure_events_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES dataset_revisions(id) ON DELETE CASCADE;


--
-- Name: dataset_exposure_events dataset_exposure_events_revision_item_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY dataset_exposure_events
    ADD CONSTRAINT dataset_exposure_events_revision_item_id_fkey FOREIGN KEY (revision_item_id) REFERENCES dataset_revision_items(id) ON DELETE CASCADE;


--
-- Name: dataset_items dataset_items_case_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY dataset_items
    ADD CONSTRAINT dataset_items_case_id_fkey FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE;


--
-- Name: dataset_items dataset_items_dataset_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY dataset_items
    ADD CONSTRAINT dataset_items_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE;


--
-- Name: dataset_items dataset_items_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY dataset_items
    ADD CONSTRAINT dataset_items_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: dataset_revision_items dataset_revision_items_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY dataset_revision_items
    ADD CONSTRAINT dataset_revision_items_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: dataset_revision_items dataset_revision_items_revision_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY dataset_revision_items
    ADD CONSTRAINT dataset_revision_items_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES dataset_revisions(id) ON DELETE CASCADE;


--
-- Name: dataset_revisions dataset_revisions_analysis_population_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY dataset_revisions
    ADD CONSTRAINT dataset_revisions_analysis_population_fkey FOREIGN KEY (analysis_population_id, project_id) REFERENCES analysis_populations(id, project_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: dataset_revisions dataset_revisions_criterion_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY dataset_revisions
    ADD CONSTRAINT dataset_revisions_criterion_version_id_fkey FOREIGN KEY (criterion_version_id) REFERENCES criterion_versions(id) ON DELETE CASCADE;


--
-- Name: dataset_revisions dataset_revisions_parent_revision_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY dataset_revisions
    ADD CONSTRAINT dataset_revisions_parent_revision_id_fkey FOREIGN KEY (parent_revision_id) REFERENCES dataset_revisions(id) ON DELETE CASCADE;


--
-- Name: dataset_revisions dataset_revisions_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY dataset_revisions
    ADD CONSTRAINT dataset_revisions_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: datasets datasets_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY datasets
    ADD CONSTRAINT datasets_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES "user"(id) ON DELETE SET NULL;


--
-- Name: datasets datasets_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY datasets
    ADD CONSTRAINT datasets_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: eval_run_items eval_run_items_case_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY eval_run_items
    ADD CONSTRAINT eval_run_items_case_id_fkey FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE;


--
-- Name: eval_run_items eval_run_items_dataset_item_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY eval_run_items
    ADD CONSTRAINT eval_run_items_dataset_item_id_fkey FOREIGN KEY (dataset_item_id) REFERENCES dataset_items(id) ON DELETE SET NULL;


--
-- Name: eval_run_items eval_run_items_dataset_revision_item_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY eval_run_items
    ADD CONSTRAINT eval_run_items_dataset_revision_item_id_fkey FOREIGN KEY (dataset_revision_item_id) REFERENCES dataset_revision_items(id) ON DELETE SET NULL;


--
-- Name: eval_run_items eval_run_items_eval_run_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY eval_run_items
    ADD CONSTRAINT eval_run_items_eval_run_id_fkey FOREIGN KEY (eval_run_id) REFERENCES eval_runs(id) ON DELETE CASCADE;


--
-- Name: eval_run_items eval_run_items_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY eval_run_items
    ADD CONSTRAINT eval_run_items_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: eval_run_items eval_run_items_verdict_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY eval_run_items
    ADD CONSTRAINT eval_run_items_verdict_id_fkey FOREIGN KEY (verdict_id) REFERENCES verdicts(id) ON DELETE SET NULL;


--
-- Name: eval_runs eval_runs_dataset_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY eval_runs
    ADD CONSTRAINT eval_runs_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE SET NULL;


--
-- Name: eval_runs eval_runs_dataset_revision_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY eval_runs
    ADD CONSTRAINT eval_runs_dataset_revision_id_fkey FOREIGN KEY (dataset_revision_id) REFERENCES dataset_revisions(id) ON DELETE SET NULL;


--
-- Name: eval_runs eval_runs_convergence_case_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY eval_runs
    ADD CONSTRAINT eval_runs_convergence_case_id_fkey FOREIGN KEY (convergence_case_id) REFERENCES cases(id) ON DELETE CASCADE;


--
-- Name: eval_runs eval_runs_ingestion_case_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY eval_runs
    ADD CONSTRAINT eval_runs_ingestion_case_id_fkey FOREIGN KEY (ingestion_case_id) REFERENCES cases(id) ON DELETE CASCADE;


--
-- Name: eval_runs eval_runs_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY eval_runs
    ADD CONSTRAINT eval_runs_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: eval_runs eval_runs_skill_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY eval_runs
    ADD CONSTRAINT eval_runs_skill_version_id_fkey FOREIGN KEY (skill_version_id) REFERENCES skill_versions(id) ON DELETE CASCADE;


--
-- Name: eval_runs eval_runs_source_trace_test_fk; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY eval_runs
    ADD CONSTRAINT eval_runs_source_trace_test_fk FOREIGN KEY (source_trace_test_id, project_id) REFERENCES trace_tests(id, project_id);


--
-- Name: eval_runs eval_runs_source_trace_test_validation_fk; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY eval_runs
    ADD CONSTRAINT eval_runs_source_trace_test_validation_fk FOREIGN KEY (project_id, source_trace_test_id, source_trace_test_validation_revision, source_trace_test_validation_id) REFERENCES trace_test_validations(project_id, trace_test_id, revision, id);


--
-- Name: evaluator_execution_authorizations evaluator_execution_authorizations_calibration_artifact_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_execution_authorizations
    ADD CONSTRAINT evaluator_execution_authorizations_calibration_artifact_id_fkey FOREIGN KEY (calibration_artifact_id) REFERENCES binary_calibration_artifacts(id) ON DELETE RESTRICT;


--
-- Name: evaluator_execution_authorizations evaluator_execution_authorizations_lifecycle_event_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_execution_authorizations
    ADD CONSTRAINT evaluator_execution_authorizations_lifecycle_event_id_fkey FOREIGN KEY (lifecycle_event_id) REFERENCES evaluator_lifecycle_events(id) ON DELETE RESTRICT;


--
-- Name: evaluator_execution_authorizations evaluator_execution_authorizations_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_execution_authorizations
    ADD CONSTRAINT evaluator_execution_authorizations_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: evaluator_execution_authorizations evaluator_execution_authorizations_skill_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_execution_authorizations
    ADD CONSTRAINT evaluator_execution_authorizations_skill_version_id_fkey FOREIGN KEY (skill_version_id) REFERENCES skill_versions(id) ON DELETE CASCADE;


--
-- Name: evaluator_lifecycle_events evaluator_lifecycle_events_actor_subject_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycle_events
    ADD CONSTRAINT evaluator_lifecycle_events_actor_subject_id_fkey FOREIGN KEY (actor_subject_id) REFERENCES governed_reviewer_subjects(id) ON DELETE RESTRICT;


--
-- Name: evaluator_lifecycle_events evaluator_lifecycle_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycle_events
    ADD CONSTRAINT evaluator_lifecycle_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES "user"(id) ON DELETE SET NULL;


--
-- Name: evaluator_lifecycle_events evaluator_lifecycle_events_calibration_artifact_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycle_events
    ADD CONSTRAINT evaluator_lifecycle_events_calibration_artifact_id_fkey FOREIGN KEY (calibration_artifact_id) REFERENCES binary_calibration_artifacts(id) ON DELETE RESTRICT;


--
-- Name: evaluator_lifecycle_events evaluator_lifecycle_events_criterion_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycle_events
    ADD CONSTRAINT evaluator_lifecycle_events_criterion_id_fkey FOREIGN KEY (criterion_id) REFERENCES criteria(id) ON DELETE CASCADE;


--
-- Name: evaluator_lifecycle_events evaluator_lifecycle_events_lifecycle_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycle_events
    ADD CONSTRAINT evaluator_lifecycle_events_lifecycle_id_fkey FOREIGN KEY (lifecycle_id) REFERENCES evaluator_lifecycles(id) ON DELETE CASCADE;


--
-- Name: evaluator_lifecycle_events evaluator_lifecycle_events_predecessor_event_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycle_events
    ADD CONSTRAINT evaluator_lifecycle_events_predecessor_event_id_fkey FOREIGN KEY (predecessor_event_id) REFERENCES evaluator_lifecycle_events(id) ON DELETE CASCADE;


--
-- Name: evaluator_lifecycle_events evaluator_lifecycle_events_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycle_events
    ADD CONSTRAINT evaluator_lifecycle_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: evaluator_lifecycle_events evaluator_lifecycle_events_regression_dataset_revision_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycle_events
    ADD CONSTRAINT evaluator_lifecycle_events_regression_dataset_revision_id_fkey FOREIGN KEY (regression_dataset_revision_id) REFERENCES dataset_revisions(id) ON DELETE RESTRICT;


--
-- Name: evaluator_lifecycle_events evaluator_lifecycle_events_regression_run_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycle_events
    ADD CONSTRAINT evaluator_lifecycle_events_regression_run_id_fkey FOREIGN KEY (regression_run_id) REFERENCES regression_runs(id) ON DELETE RESTRICT;


--
-- Name: evaluator_lifecycle_events evaluator_lifecycle_events_replaced_skill_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycle_events
    ADD CONSTRAINT evaluator_lifecycle_events_replaced_skill_version_id_fkey FOREIGN KEY (replaced_skill_version_id) REFERENCES skill_versions(id) ON DELETE RESTRICT;


--
-- Name: evaluator_lifecycle_events evaluator_lifecycle_events_skill_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycle_events
    ADD CONSTRAINT evaluator_lifecycle_events_skill_version_id_fkey FOREIGN KEY (skill_version_id) REFERENCES skill_versions(id) ON DELETE CASCADE;


--
-- Name: evaluator_lifecycles evaluator_lifecycles_created_by_subject_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycles
    ADD CONSTRAINT evaluator_lifecycles_created_by_subject_id_fkey FOREIGN KEY (created_by_subject_id) REFERENCES governed_reviewer_subjects(id) ON DELETE CASCADE;


--
-- Name: evaluator_lifecycles evaluator_lifecycles_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycles
    ADD CONSTRAINT evaluator_lifecycles_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES "user"(id) ON DELETE RESTRICT;


--
-- Name: evaluator_lifecycles evaluator_lifecycles_criterion_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycles
    ADD CONSTRAINT evaluator_lifecycles_criterion_id_fkey FOREIGN KEY (criterion_id) REFERENCES criteria(id) ON DELETE CASCADE;


--
-- Name: evaluator_lifecycles evaluator_lifecycles_criterion_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycles
    ADD CONSTRAINT evaluator_lifecycles_criterion_version_id_fkey FOREIGN KEY (criterion_version_id) REFERENCES criterion_versions(id) ON DELETE CASCADE;


--
-- Name: evaluator_lifecycles evaluator_lifecycles_developer_exposure_event_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycles
    ADD CONSTRAINT evaluator_lifecycles_developer_exposure_event_id_fkey FOREIGN KEY (developer_exposure_event_id) REFERENCES dataset_exposure_events(id) ON DELETE CASCADE;


--
-- Name: evaluator_lifecycles evaluator_lifecycles_governed_batch_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycles
    ADD CONSTRAINT evaluator_lifecycles_governed_batch_id_fkey FOREIGN KEY (governed_batch_id) REFERENCES governed_review_batches(id) ON DELETE CASCADE;


--
-- Name: evaluator_lifecycles evaluator_lifecycles_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycles
    ADD CONSTRAINT evaluator_lifecycles_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: evaluator_lifecycles evaluator_lifecycles_promotion_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycles
    ADD CONSTRAINT evaluator_lifecycles_promotion_id_fkey FOREIGN KEY (promotion_id) REFERENCES analysis_criterion_promotions(id) ON DELETE CASCADE;


--
-- Name: evaluator_lifecycles evaluator_lifecycles_regression_dataset_revision_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycles
    ADD CONSTRAINT evaluator_lifecycles_regression_dataset_revision_id_fkey FOREIGN KEY (regression_dataset_revision_id) REFERENCES dataset_revisions(id) ON DELETE CASCADE;


--
-- Name: evaluator_lifecycles evaluator_lifecycles_skill_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycles
    ADD CONSTRAINT evaluator_lifecycles_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE;


--
-- Name: evaluator_lifecycles evaluator_lifecycles_skill_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycles
    ADD CONSTRAINT evaluator_lifecycles_skill_version_id_fkey FOREIGN KEY (skill_version_id) REFERENCES skill_versions(id) ON DELETE CASCADE;


--
-- Name: evaluator_lifecycles evaluator_lifecycles_truth_dataset_revision_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_lifecycles
    ADD CONSTRAINT evaluator_lifecycles_truth_dataset_revision_id_fkey FOREIGN KEY (truth_dataset_revision_id) REFERENCES dataset_revisions(id) ON DELETE CASCADE;


--
-- Name: evaluator_suite_manifest_members evaluator_suite_manifest_members_criterion_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_suite_manifest_members
    ADD CONSTRAINT evaluator_suite_manifest_members_criterion_id_fkey FOREIGN KEY (criterion_id) REFERENCES criteria(id) ON DELETE CASCADE;


--
-- Name: evaluator_suite_manifest_members evaluator_suite_manifest_members_criterion_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_suite_manifest_members
    ADD CONSTRAINT evaluator_suite_manifest_members_criterion_version_id_fkey FOREIGN KEY (criterion_version_id) REFERENCES criterion_versions(id) ON DELETE CASCADE;


--
-- Name: evaluator_suite_manifest_members evaluator_suite_manifest_members_manifest_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_suite_manifest_members
    ADD CONSTRAINT evaluator_suite_manifest_members_manifest_id_fkey FOREIGN KEY (manifest_id) REFERENCES evaluator_suite_manifests(id) ON DELETE CASCADE;


--
-- Name: evaluator_suite_manifest_members evaluator_suite_manifest_members_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_suite_manifest_members
    ADD CONSTRAINT evaluator_suite_manifest_members_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: evaluator_suite_manifest_members evaluator_suite_manifest_members_skill_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_suite_manifest_members
    ADD CONSTRAINT evaluator_suite_manifest_members_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE;


--
-- Name: evaluator_suite_manifest_members evaluator_suite_manifest_members_skill_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_suite_manifest_members
    ADD CONSTRAINT evaluator_suite_manifest_members_skill_version_id_fkey FOREIGN KEY (skill_version_id) REFERENCES skill_versions(id) ON DELETE CASCADE;


--
-- Name: evaluator_suite_manifest_members evaluator_suite_manifest_members_suite_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_suite_manifest_members
    ADD CONSTRAINT evaluator_suite_manifest_members_suite_id_fkey FOREIGN KEY (suite_id) REFERENCES evaluator_suites(id) ON DELETE CASCADE;


--
-- Name: evaluator_suite_manifests evaluator_suite_manifests_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_suite_manifests
    ADD CONSTRAINT evaluator_suite_manifests_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: evaluator_suite_manifests evaluator_suite_manifests_suite_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_suite_manifests
    ADD CONSTRAINT evaluator_suite_manifests_suite_id_fkey FOREIGN KEY (suite_id) REFERENCES evaluator_suites(id) ON DELETE CASCADE;


--
-- Name: evaluator_suites evaluator_suites_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY evaluator_suites
    ADD CONSTRAINT evaluator_suites_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: feedback_sync_jobs feedback_sync_jobs_judge_run_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY feedback_sync_jobs
    ADD CONSTRAINT feedback_sync_jobs_judge_run_id_fkey FOREIGN KEY (judge_run_id) REFERENCES judge_runs(id) ON DELETE CASCADE;


--
-- Name: feedback_sync_jobs feedback_sync_jobs_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY feedback_sync_jobs
    ADD CONSTRAINT feedback_sync_jobs_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: gate_check_items gate_check_items_candidate_case_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY gate_check_items
    ADD CONSTRAINT gate_check_items_candidate_case_id_fkey FOREIGN KEY (candidate_case_id) REFERENCES cases(id) ON DELETE CASCADE;


--
-- Name: gate_check_items gate_check_items_gate_check_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY gate_check_items
    ADD CONSTRAINT gate_check_items_gate_check_id_fkey FOREIGN KEY (gate_check_id) REFERENCES gate_checks(id) ON DELETE CASCADE;


--
-- Name: gate_check_items gate_check_items_golden_case_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY gate_check_items
    ADD CONSTRAINT gate_check_items_golden_case_id_fkey FOREIGN KEY (golden_case_id) REFERENCES cases(id) ON DELETE CASCADE;


--
-- Name: gate_check_items gate_check_items_golden_entry_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY gate_check_items
    ADD CONSTRAINT gate_check_items_golden_entry_id_fkey FOREIGN KEY (golden_entry_id) REFERENCES golden_set_entries(id) ON DELETE CASCADE;


--
-- Name: gate_check_items gate_check_items_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY gate_check_items
    ADD CONSTRAINT gate_check_items_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: gate_checks gate_checks_eval_run_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY gate_checks
    ADD CONSTRAINT gate_checks_eval_run_id_fkey FOREIGN KEY (eval_run_id) REFERENCES eval_runs(id) ON DELETE CASCADE;


--
-- Name: gate_checks gate_checks_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY gate_checks
    ADD CONSTRAINT gate_checks_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: gate_checks gate_checks_skill_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY gate_checks
    ADD CONSTRAINT gate_checks_skill_version_id_fkey FOREIGN KEY (skill_version_id) REFERENCES skill_versions(id) ON DELETE CASCADE;


--
-- Name: golden_set_entries golden_set_entries_case_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY golden_set_entries
    ADD CONSTRAINT golden_set_entries_case_id_fkey FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE;


--
-- Name: golden_set_entries golden_set_entries_criterion_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY golden_set_entries
    ADD CONSTRAINT golden_set_entries_criterion_version_id_fkey FOREIGN KEY (criterion_version_id) REFERENCES criterion_versions(id) ON DELETE CASCADE;


--
-- Name: golden_set_entries golden_set_entries_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY golden_set_entries
    ADD CONSTRAINT golden_set_entries_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: golden_set_entries golden_set_entries_source_skill_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY golden_set_entries
    ADD CONSTRAINT golden_set_entries_source_skill_version_id_fkey FOREIGN KEY (source_skill_version_id) REFERENCES skill_versions(id);


--
-- Name: governed_dataset_truth_link_labels governed_dataset_truth_link_labels_label_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_dataset_truth_link_labels
    ADD CONSTRAINT governed_dataset_truth_link_labels_label_id_fkey FOREIGN KEY (label_id) REFERENCES governed_review_labels(id) ON DELETE CASCADE;


--
-- Name: governed_dataset_truth_link_labels governed_dataset_truth_link_labels_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_dataset_truth_link_labels
    ADD CONSTRAINT governed_dataset_truth_link_labels_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: governed_dataset_truth_link_labels governed_dataset_truth_link_labels_truth_link_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_dataset_truth_link_labels
    ADD CONSTRAINT governed_dataset_truth_link_labels_truth_link_id_fkey FOREIGN KEY (truth_link_id) REFERENCES governed_dataset_truth_links(id) ON DELETE CASCADE;


--
-- Name: governed_dataset_truth_links governed_dataset_truth_links_adjudication_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_dataset_truth_links
    ADD CONSTRAINT governed_dataset_truth_links_adjudication_id_fkey FOREIGN KEY (adjudication_id) REFERENCES governed_review_adjudications(id) ON DELETE CASCADE;


--
-- Name: governed_dataset_truth_links governed_dataset_truth_links_batch_item_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_dataset_truth_links
    ADD CONSTRAINT governed_dataset_truth_links_batch_item_id_fkey FOREIGN KEY (batch_item_id) REFERENCES governed_review_batch_items(id) ON DELETE CASCADE;


--
-- Name: governed_dataset_truth_links governed_dataset_truth_links_criterion_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_dataset_truth_links
    ADD CONSTRAINT governed_dataset_truth_links_criterion_version_id_fkey FOREIGN KEY (criterion_version_id) REFERENCES criterion_versions(id) ON DELETE CASCADE;


--
-- Name: governed_dataset_truth_links governed_dataset_truth_links_dataset_revision_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_dataset_truth_links
    ADD CONSTRAINT governed_dataset_truth_links_dataset_revision_id_fkey FOREIGN KEY (dataset_revision_id) REFERENCES dataset_revisions(id) ON DELETE CASCADE;


--
-- Name: governed_dataset_truth_links governed_dataset_truth_links_dataset_revision_item_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_dataset_truth_links
    ADD CONSTRAINT governed_dataset_truth_links_dataset_revision_item_id_fkey FOREIGN KEY (dataset_revision_item_id) REFERENCES dataset_revision_items(id) ON DELETE CASCADE;


--
-- Name: governed_dataset_truth_links governed_dataset_truth_links_imported_truth_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_dataset_truth_links
    ADD CONSTRAINT governed_dataset_truth_links_imported_truth_id_fkey FOREIGN KEY (imported_truth_id) REFERENCES governed_imported_truth(id) ON DELETE CASCADE;


--
-- Name: governed_dataset_truth_links governed_dataset_truth_links_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_dataset_truth_links
    ADD CONSTRAINT governed_dataset_truth_links_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: governed_evaluator_development_events governed_evaluator_development_events_criterion_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_evaluator_development_events
    ADD CONSTRAINT governed_evaluator_development_events_criterion_version_id_fkey FOREIGN KEY (criterion_version_id) REFERENCES criterion_versions(id) ON DELETE CASCADE;


--
-- Name: governed_evaluator_development_events governed_evaluator_development_events_developer_subject_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_evaluator_development_events
    ADD CONSTRAINT governed_evaluator_development_events_developer_subject_id_fkey FOREIGN KEY (developer_subject_id) REFERENCES governed_reviewer_subjects(id) ON DELETE CASCADE;


--
-- Name: governed_evaluator_development_events governed_evaluator_development_events_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_evaluator_development_events
    ADD CONSTRAINT governed_evaluator_development_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: governed_evaluator_development_events governed_evaluator_development_events_skill_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_evaluator_development_events
    ADD CONSTRAINT governed_evaluator_development_events_skill_version_id_fkey FOREIGN KEY (skill_version_id) REFERENCES skill_versions(id) ON DELETE CASCADE;


--
-- Name: governed_imported_truth governed_imported_truth_criterion_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_imported_truth
    ADD CONSTRAINT governed_imported_truth_criterion_version_id_fkey FOREIGN KEY (criterion_version_id) REFERENCES criterion_versions(id) ON DELETE CASCADE;


--
-- Name: governed_imported_truth governed_imported_truth_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_imported_truth
    ADD CONSTRAINT governed_imported_truth_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: governed_input_identity_claims governed_input_identity_claims_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_input_identity_claims
    ADD CONSTRAINT governed_input_identity_claims_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: governed_review_adjudication_labels governed_review_adjudication_labels_adjudication_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_adjudication_labels
    ADD CONSTRAINT governed_review_adjudication_labels_adjudication_id_fkey FOREIGN KEY (adjudication_id) REFERENCES governed_review_adjudications(id) ON DELETE CASCADE;


--
-- Name: governed_review_adjudication_labels governed_review_adjudication_labels_label_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_adjudication_labels
    ADD CONSTRAINT governed_review_adjudication_labels_label_id_fkey FOREIGN KEY (label_id) REFERENCES governed_review_labels(id) ON DELETE CASCADE;


--
-- Name: governed_review_adjudication_labels governed_review_adjudication_labels_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_adjudication_labels
    ADD CONSTRAINT governed_review_adjudication_labels_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: governed_review_adjudications governed_review_adjudications_adjudicator_subject_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_adjudications
    ADD CONSTRAINT governed_review_adjudications_adjudicator_subject_id_fkey FOREIGN KEY (adjudicator_subject_id) REFERENCES governed_reviewer_subjects(id) ON DELETE CASCADE;


--
-- Name: governed_review_adjudications governed_review_adjudications_batch_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_adjudications
    ADD CONSTRAINT governed_review_adjudications_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES governed_review_batches(id) ON DELETE CASCADE;


--
-- Name: governed_review_adjudications governed_review_adjudications_batch_item_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_adjudications
    ADD CONSTRAINT governed_review_adjudications_batch_item_id_fkey FOREIGN KEY (batch_item_id) REFERENCES governed_review_batch_items(id) ON DELETE CASCADE;


--
-- Name: governed_review_adjudications governed_review_adjudications_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_adjudications
    ADD CONSTRAINT governed_review_adjudications_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: governed_review_adjudications governed_review_adjudications_supersedes_adjudication_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_adjudications
    ADD CONSTRAINT governed_review_adjudications_supersedes_adjudication_id_fkey FOREIGN KEY (supersedes_adjudication_id) REFERENCES governed_review_adjudications(id) ON DELETE CASCADE;


--
-- Name: governed_review_alignment_events governed_review_alignment_eve_proposed_instruction_version_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_alignment_events
    ADD CONSTRAINT governed_review_alignment_eve_proposed_instruction_version_fkey FOREIGN KEY (proposed_instruction_version_id) REFERENCES review_instruction_versions(id) ON DELETE CASCADE;


--
-- Name: governed_review_alignment_event_labels governed_review_alignment_event_labels_alignment_event_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_alignment_event_labels
    ADD CONSTRAINT governed_review_alignment_event_labels_alignment_event_id_fkey FOREIGN KEY (alignment_event_id) REFERENCES governed_review_alignment_events(id) ON DELETE CASCADE;


--
-- Name: governed_review_alignment_event_labels governed_review_alignment_event_labels_label_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_alignment_event_labels
    ADD CONSTRAINT governed_review_alignment_event_labels_label_id_fkey FOREIGN KEY (label_id) REFERENCES governed_review_labels(id) ON DELETE CASCADE;


--
-- Name: governed_review_alignment_event_labels governed_review_alignment_event_labels_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_alignment_event_labels
    ADD CONSTRAINT governed_review_alignment_event_labels_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: governed_review_alignment_events governed_review_alignment_events_actor_subject_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_alignment_events
    ADD CONSTRAINT governed_review_alignment_events_actor_subject_id_fkey FOREIGN KEY (actor_subject_id) REFERENCES governed_reviewer_subjects(id) ON DELETE CASCADE;


--
-- Name: governed_review_alignment_events governed_review_alignment_events_batch_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_alignment_events
    ADD CONSTRAINT governed_review_alignment_events_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES governed_review_batches(id) ON DELETE CASCADE;


--
-- Name: governed_review_alignment_events governed_review_alignment_events_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_alignment_events
    ADD CONSTRAINT governed_review_alignment_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: governed_review_batch_events governed_review_batch_events_actor_subject_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_batch_events
    ADD CONSTRAINT governed_review_batch_events_actor_subject_id_fkey FOREIGN KEY (actor_subject_id) REFERENCES governed_reviewer_subjects(id) ON DELETE CASCADE;


--
-- Name: governed_review_batch_events governed_review_batch_events_batch_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_batch_events
    ADD CONSTRAINT governed_review_batch_events_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES governed_review_batches(id) ON DELETE CASCADE;


--
-- Name: governed_review_batch_events governed_review_batch_events_dataset_revision_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_batch_events
    ADD CONSTRAINT governed_review_batch_events_dataset_revision_id_fkey FOREIGN KEY (dataset_revision_id) REFERENCES dataset_revisions(id) ON DELETE CASCADE;


--
-- Name: governed_review_batch_events governed_review_batch_events_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_batch_events
    ADD CONSTRAINT governed_review_batch_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: governed_review_batch_items governed_review_batch_items_batch_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_batch_items
    ADD CONSTRAINT governed_review_batch_items_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES governed_review_batches(id) ON DELETE CASCADE;


--
-- Name: governed_review_batch_items governed_review_batch_items_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_batch_items
    ADD CONSTRAINT governed_review_batch_items_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: governed_review_batch_items governed_review_batch_items_review_item_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_batch_items
    ADD CONSTRAINT governed_review_batch_items_review_item_id_fkey FOREIGN KEY (review_item_id) REFERENCES governed_review_items(id) ON DELETE CASCADE;


--
-- Name: governed_review_batches governed_review_batches_criterion_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_batches
    ADD CONSTRAINT governed_review_batches_criterion_version_id_fkey FOREIGN KEY (criterion_version_id) REFERENCES criterion_versions(id) ON DELETE CASCADE;


--
-- Name: governed_review_batches governed_review_batches_instruction_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_batches
    ADD CONSTRAINT governed_review_batches_instruction_version_id_fkey FOREIGN KEY (instruction_version_id) REFERENCES review_instruction_versions(id) ON DELETE CASCADE;


--
-- Name: governed_review_batches governed_review_batches_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_batches
    ADD CONSTRAINT governed_review_batches_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: governed_review_capability_checks governed_review_capability_checks_batch_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_capability_checks
    ADD CONSTRAINT governed_review_capability_checks_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES governed_review_batches(id) ON DELETE CASCADE;


--
-- Name: governed_review_capability_checks governed_review_capability_checks_criterion_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_capability_checks
    ADD CONSTRAINT governed_review_capability_checks_criterion_version_id_fkey FOREIGN KEY (criterion_version_id) REFERENCES criterion_versions(id) ON DELETE CASCADE;


--
-- Name: governed_review_capability_checks governed_review_capability_checks_evaluator_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_capability_checks
    ADD CONSTRAINT governed_review_capability_checks_evaluator_version_id_fkey FOREIGN KEY (evaluator_version_id) REFERENCES skill_versions(id) ON DELETE CASCADE;


--
-- Name: governed_review_capability_checks governed_review_capability_checks_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_capability_checks
    ADD CONSTRAINT governed_review_capability_checks_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: governed_review_capability_checks governed_review_capability_checks_subject_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_capability_checks
    ADD CONSTRAINT governed_review_capability_checks_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES governed_reviewer_subjects(id) ON DELETE CASCADE;


--
-- Name: governed_review_items governed_review_items_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_items
    ADD CONSTRAINT governed_review_items_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: governed_review_items governed_review_items_sealed_intake_population_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_items
    ADD CONSTRAINT governed_review_items_sealed_intake_population_id_fkey FOREIGN KEY (sealed_intake_population_id) REFERENCES governed_sealed_intake_populations(id) ON DELETE CASCADE;


--
-- Name: governed_review_labels governed_review_labels_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_labels
    ADD CONSTRAINT governed_review_labels_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: governed_review_labels governed_review_labels_replaces_label_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_labels
    ADD CONSTRAINT governed_review_labels_replaces_label_id_fkey FOREIGN KEY (replaces_label_id) REFERENCES governed_review_labels(id) ON DELETE CASCADE;


--
-- Name: governed_review_labels governed_review_labels_reviewer_subject_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_labels
    ADD CONSTRAINT governed_review_labels_reviewer_subject_id_fkey FOREIGN KEY (reviewer_subject_id) REFERENCES governed_reviewer_subjects(id) ON DELETE CASCADE;


--
-- Name: governed_review_labels governed_review_labels_task_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_labels
    ADD CONSTRAINT governed_review_labels_task_id_fkey FOREIGN KEY (task_id) REFERENCES governed_review_tasks(id) ON DELETE CASCADE;


--
-- Name: governed_review_task_events governed_review_task_events_actor_subject_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_task_events
    ADD CONSTRAINT governed_review_task_events_actor_subject_id_fkey FOREIGN KEY (actor_subject_id) REFERENCES governed_reviewer_subjects(id) ON DELETE CASCADE;


--
-- Name: governed_review_task_events governed_review_task_events_label_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_task_events
    ADD CONSTRAINT governed_review_task_events_label_id_fkey FOREIGN KEY (label_id) REFERENCES governed_review_labels(id) ON DELETE CASCADE;


--
-- Name: governed_review_task_events governed_review_task_events_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_task_events
    ADD CONSTRAINT governed_review_task_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: governed_review_task_events governed_review_task_events_task_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_task_events
    ADD CONSTRAINT governed_review_task_events_task_id_fkey FOREIGN KEY (task_id) REFERENCES governed_review_tasks(id) ON DELETE CASCADE;


--
-- Name: governed_review_tasks governed_review_tasks_batch_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_tasks
    ADD CONSTRAINT governed_review_tasks_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES governed_review_batches(id) ON DELETE CASCADE;


--
-- Name: governed_review_tasks governed_review_tasks_batch_item_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_tasks
    ADD CONSTRAINT governed_review_tasks_batch_item_id_fkey FOREIGN KEY (batch_item_id) REFERENCES governed_review_batch_items(id) ON DELETE CASCADE;


--
-- Name: governed_review_tasks governed_review_tasks_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_tasks
    ADD CONSTRAINT governed_review_tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: governed_review_tasks governed_review_tasks_reviewer_subject_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_review_tasks
    ADD CONSTRAINT governed_review_tasks_reviewer_subject_id_fkey FOREIGN KEY (reviewer_subject_id) REFERENCES governed_reviewer_subjects(id) ON DELETE CASCADE;


--
-- Name: governed_reviewer_subjects governed_reviewer_subjects_account_user_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_reviewer_subjects
    ADD CONSTRAINT governed_reviewer_subjects_account_user_id_fkey FOREIGN KEY (account_user_id) REFERENCES "user"(id) ON DELETE SET NULL;


--
-- Name: governed_reviewer_subjects governed_reviewer_subjects_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_reviewer_subjects
    ADD CONSTRAINT governed_reviewer_subjects_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: governed_sealed_intake_populations governed_sealed_intake_populations_custodian_subject_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_sealed_intake_populations
    ADD CONSTRAINT governed_sealed_intake_populations_custodian_subject_id_fkey FOREIGN KEY (custodian_subject_id) REFERENCES governed_reviewer_subjects(id) ON DELETE CASCADE;


--
-- Name: governed_sealed_intake_populations governed_sealed_intake_populations_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY governed_sealed_intake_populations
    ADD CONSTRAINT governed_sealed_intake_populations_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: import_jobs import_jobs_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY import_jobs
    ADD CONSTRAINT import_jobs_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES "user"(id) ON DELETE SET NULL;


--
-- Name: import_jobs import_jobs_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY import_jobs
    ADD CONSTRAINT import_jobs_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: import_jobs import_jobs_skill_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY import_jobs
    ADD CONSTRAINT import_jobs_skill_version_id_fkey FOREIGN KEY (skill_version_id) REFERENCES skill_versions(id);


--
-- Name: import_jobs import_jobs_source_integration_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY import_jobs
    ADD CONSTRAINT import_jobs_source_integration_id_fkey FOREIGN KEY (source_integration_id) REFERENCES integrations(id) ON DELETE SET NULL;


--
-- Name: integrations integrations_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY integrations
    ADD CONSTRAINT integrations_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: invitations invitations_organization_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY invitations
    ADD CONSTRAINT invitations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;


--
-- Name: invitations invitations_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY invitations
    ADD CONSTRAINT invitations_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: judge_provider_keys judge_provider_keys_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY judge_provider_keys
    ADD CONSTRAINT judge_provider_keys_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: judge_runs judge_runs_case_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY judge_runs
    ADD CONSTRAINT judge_runs_case_id_fkey FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE;


--
-- Name: judge_runs judge_runs_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY judge_runs
    ADD CONSTRAINT judge_runs_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: judge_runs judge_runs_skill_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY judge_runs
    ADD CONSTRAINT judge_runs_skill_version_id_fkey FOREIGN KEY (skill_version_id) REFERENCES skill_versions(id) ON DELETE CASCADE;


--
-- Name: organization_members organization_members_organization_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY organization_members
    ADD CONSTRAINT organization_members_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;


--
-- Name: project_members project_members_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY project_members
    ADD CONSTRAINT project_members_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: projects projects_organization_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY projects
    ADD CONSTRAINT projects_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;


--
-- Name: raw_traces raw_traces_import_job_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY raw_traces
    ADD CONSTRAINT raw_traces_import_job_id_fkey FOREIGN KEY (import_job_id) REFERENCES import_jobs(id);


--
-- Name: raw_traces raw_traces_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY raw_traces
    ADD CONSTRAINT raw_traces_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: raw_traces raw_traces_source_integration_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY raw_traces
    ADD CONSTRAINT raw_traces_source_integration_id_fkey FOREIGN KEY (source_integration_id) REFERENCES integrations(id);


--
-- Name: regression_runs regression_runs_criterion_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY regression_runs
    ADD CONSTRAINT regression_runs_criterion_version_id_fkey FOREIGN KEY (criterion_version_id) REFERENCES criterion_versions(id) ON DELETE CASCADE;


--
-- Name: regression_runs regression_runs_dataset_revision_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY regression_runs
    ADD CONSTRAINT regression_runs_dataset_revision_id_fkey FOREIGN KEY (dataset_revision_id) REFERENCES dataset_revisions(id) ON DELETE RESTRICT;


--
-- Name: regression_runs regression_runs_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY regression_runs
    ADD CONSTRAINT regression_runs_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: regression_runs regression_runs_skill_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY regression_runs
    ADD CONSTRAINT regression_runs_skill_version_id_fkey FOREIGN KEY (skill_version_id) REFERENCES skill_versions(id) ON DELETE CASCADE;


--
-- Name: review_instruction_versions review_instruction_versions_criterion_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY review_instruction_versions
    ADD CONSTRAINT review_instruction_versions_criterion_version_id_fkey FOREIGN KEY (criterion_version_id) REFERENCES criterion_versions(id) ON DELETE CASCADE;


--
-- Name: review_instruction_versions review_instruction_versions_predecessor_instruction_versio_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY review_instruction_versions
    ADD CONSTRAINT review_instruction_versions_predecessor_instruction_versio_fkey FOREIGN KEY (predecessor_instruction_version_id) REFERENCES review_instruction_versions(id) ON DELETE CASCADE;


--
-- Name: review_instruction_versions review_instruction_versions_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY review_instruction_versions
    ADD CONSTRAINT review_instruction_versions_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: review_queue_items review_queue_items_assigned_to_user_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY review_queue_items
    ADD CONSTRAINT review_queue_items_assigned_to_user_id_fkey FOREIGN KEY (assigned_to_user_id) REFERENCES "user"(id) ON DELETE SET NULL;


--
-- Name: review_queue_items review_queue_items_case_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY review_queue_items
    ADD CONSTRAINT review_queue_items_case_id_fkey FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE;


--
-- Name: review_queue_items review_queue_items_criterion_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY review_queue_items
    ADD CONSTRAINT review_queue_items_criterion_version_id_fkey FOREIGN KEY (criterion_version_id) REFERENCES criterion_versions(id) ON DELETE CASCADE;


--
-- Name: review_queue_items review_queue_items_queue_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY review_queue_items
    ADD CONSTRAINT review_queue_items_queue_id_fkey FOREIGN KEY (queue_id) REFERENCES review_queues(id) ON DELETE CASCADE;


--
-- Name: review_queues review_queues_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY review_queues
    ADD CONSTRAINT review_queues_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES "user"(id) ON DELETE SET NULL;


--
-- Name: review_queues review_queues_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY review_queues
    ADD CONSTRAINT review_queues_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: run_comparisons run_comparisons_dataset_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY run_comparisons
    ADD CONSTRAINT run_comparisons_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE;


--
-- Name: run_comparisons run_comparisons_dataset_revision_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY run_comparisons
    ADD CONSTRAINT run_comparisons_dataset_revision_id_fkey FOREIGN KEY (dataset_revision_id) REFERENCES dataset_revisions(id) ON DELETE SET NULL;


--
-- Name: run_comparisons run_comparisons_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY run_comparisons
    ADD CONSTRAINT run_comparisons_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: run_comparisons run_comparisons_run_a_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY run_comparisons
    ADD CONSTRAINT run_comparisons_run_a_id_fkey FOREIGN KEY (run_a_id) REFERENCES eval_runs(id) ON DELETE CASCADE;


--
-- Name: run_comparisons run_comparisons_run_b_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY run_comparisons
    ADD CONSTRAINT run_comparisons_run_b_id_fkey FOREIGN KEY (run_b_id) REFERENCES eval_runs(id) ON DELETE CASCADE;


--
-- Name: run_comparisons run_comparisons_version_a_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY run_comparisons
    ADD CONSTRAINT run_comparisons_version_a_id_fkey FOREIGN KEY (version_a_id) REFERENCES skill_versions(id) ON DELETE CASCADE;


--
-- Name: run_comparisons run_comparisons_version_b_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY run_comparisons
    ADD CONSTRAINT run_comparisons_version_b_id_fkey FOREIGN KEY (version_b_id) REFERENCES skill_versions(id) ON DELETE CASCADE;


--
-- Name: session session_user_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY session
    ADD CONSTRAINT session_user_id_fkey FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;


--
-- Name: skill_versions skill_versions_created_by_subject_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY skill_versions
    ADD CONSTRAINT skill_versions_created_by_subject_id_fkey FOREIGN KEY (created_by_subject_id) REFERENCES governed_reviewer_subjects(id) ON DELETE CASCADE;


--
-- Name: skill_versions skill_versions_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY skill_versions
    ADD CONSTRAINT skill_versions_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES "user"(id) ON DELETE SET NULL;


--
-- Name: skill_versions skill_versions_criterion_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY skill_versions
    ADD CONSTRAINT skill_versions_criterion_version_id_fkey FOREIGN KEY (criterion_version_id) REFERENCES criterion_versions(id) ON DELETE CASCADE;


--
-- Name: skill_versions skill_versions_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY skill_versions
    ADD CONSTRAINT skill_versions_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: skill_versions skill_versions_regression_dataset_revision_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY skill_versions
    ADD CONSTRAINT skill_versions_regression_dataset_revision_id_fkey FOREIGN KEY (regression_dataset_revision_id) REFERENCES dataset_revisions(id) ON DELETE RESTRICT;


--
-- Name: skill_versions skill_versions_skill_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY skill_versions
    ADD CONSTRAINT skill_versions_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE;


--
-- Name: skills skills_criterion_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY skills
    ADD CONSTRAINT skills_criterion_id_fkey FOREIGN KEY (criterion_id) REFERENCES criteria(id) ON DELETE CASCADE;


--
-- Name: skills skills_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY skills
    ADD CONSTRAINT skills_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: trace_test_revisions trace_test_revisions_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY trace_test_revisions
    ADD CONSTRAINT trace_test_revisions_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES "user"(id) ON DELETE SET NULL;


--
-- Name: trace_test_revisions trace_test_revisions_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY trace_test_revisions
    ADD CONSTRAINT trace_test_revisions_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: trace_test_revisions trace_test_revisions_reviewed_by_user_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY trace_test_revisions
    ADD CONSTRAINT trace_test_revisions_reviewed_by_user_id_fkey FOREIGN KEY (reviewed_by_user_id) REFERENCES "user"(id) ON DELETE SET NULL;


--
-- Name: trace_test_revisions trace_test_revisions_trace_test_id_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY trace_test_revisions
    ADD CONSTRAINT trace_test_revisions_trace_test_id_project_id_fkey FOREIGN KEY (trace_test_id, project_id) REFERENCES trace_tests(id, project_id) ON DELETE CASCADE;


--
-- Name: trace_test_revisions trace_test_revisions_validation_fk; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY trace_test_revisions
    ADD CONSTRAINT trace_test_revisions_validation_fk FOREIGN KEY (validation_id, trace_test_id, validated_revision) REFERENCES trace_test_validations(id, trace_test_id, revision) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: trace_test_validations trace_test_validations_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY trace_test_validations
    ADD CONSTRAINT trace_test_validations_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: trace_test_validations trace_test_validations_recorded_by_user_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY trace_test_validations
    ADD CONSTRAINT trace_test_validations_recorded_by_user_id_fkey FOREIGN KEY (recorded_by_user_id) REFERENCES "user"(id) ON DELETE SET NULL;


--
-- Name: trace_test_validations trace_test_validations_trace_test_id_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY trace_test_validations
    ADD CONSTRAINT trace_test_validations_trace_test_id_project_id_fkey FOREIGN KEY (trace_test_id, project_id) REFERENCES trace_tests(id, project_id) ON DELETE CASCADE;


--
-- Name: trace_test_validations trace_test_validations_trace_test_id_revision_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY trace_test_validations
    ADD CONSTRAINT trace_test_validations_trace_test_id_revision_fkey FOREIGN KEY (trace_test_id, revision) REFERENCES trace_test_revisions(trace_test_id, revision) ON DELETE CASCADE;


--
-- Name: trace_tests trace_tests_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY trace_tests
    ADD CONSTRAINT trace_tests_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES "user"(id) ON DELETE SET NULL;


--
-- Name: trace_tests trace_tests_current_revision_fk; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY trace_tests
    ADD CONSTRAINT trace_tests_current_revision_fk FOREIGN KEY (id, current_revision) REFERENCES trace_test_revisions(trace_test_id, revision) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: trace_tests trace_tests_enabled_revision_fk; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY trace_tests
    ADD CONSTRAINT trace_tests_enabled_revision_fk FOREIGN KEY (id, enabled_revision) REFERENCES trace_test_revisions(trace_test_id, revision) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: trace_tests trace_tests_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY trace_tests
    ADD CONSTRAINT trace_tests_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: trace_tests trace_tests_source_case_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY trace_tests
    ADD CONSTRAINT trace_tests_source_case_id_fkey FOREIGN KEY (source_case_id) REFERENCES cases(id) ON DELETE SET NULL;


--
-- Name: verdicts verdicts_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY verdicts
    ADD CONSTRAINT verdicts_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES "user"(id) ON DELETE SET NULL;


--
-- Name: verdicts verdicts_case_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY verdicts
    ADD CONSTRAINT verdicts_case_id_fkey FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE;


--
-- Name: verdicts verdicts_project_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY verdicts
    ADD CONSTRAINT verdicts_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;


--
-- Name: verdicts verdicts_skill_version_id_fkey; Type: FK CONSTRAINT; Schema: current; Owner: -
--

ALTER TABLE ONLY verdicts
    ADD CONSTRAINT verdicts_skill_version_id_fkey FOREIGN KEY (skill_version_id) REFERENCES skill_versions(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--
