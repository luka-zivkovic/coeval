alter table raw_traces
  add column source_trace_version text,
  add column source_remote_project_id text,
  add column source_trace_cutover_version text,
  add column source_trace_cutover_matched boolean;

alter table raw_traces
  add constraint raw_traces_source_trace_version_shape
  check (
    source_trace_version is null
    or (
      source_trace_version = btrim(source_trace_version)
      and length(source_trace_version) > 0
      and length(source_trace_version) <= 200
    )
  );

alter table raw_traces
  add constraint raw_traces_source_remote_project_id_shape
  check (
    source_remote_project_id is null
    or (
      source_remote_project_id = btrim(source_remote_project_id)
      and length(source_remote_project_id) > 0
      and length(source_remote_project_id) <= 500
    )
  ),
  add constraint raw_traces_source_trace_cutover_shape
  check (
    (source_trace_cutover_version is null and source_trace_cutover_matched is null)
    or (
      source_trace_cutover_version = btrim(source_trace_cutover_version)
      and length(source_trace_cutover_version) > 0
      and length(source_trace_cutover_version) <= 200
      and source_trace_cutover_matched is not null
    )
  );

create index raw_traces_source_version_lookup
  on raw_traces (
    project_id,
    source_remote_project_id,
    source_trace_id,
    source_trace_version
  );

-- The superseded Ironside importer persisted a timestamp-window cursor whose
-- opaque value is not accepted by evaluator/v1. Reset it explicitly rather
-- than allowing every scheduled job to retry a deterministic HTTP 400. Keep
-- the prior state as non-authoritative operational history. The first native
-- snapshot for each legacy trace is content-compared transactionally: an
-- equal snapshot reuses the existing case without inventing exact historical
-- provenance; a changed snapshot creates a new versioned case.
update integrations
set poll_enabled = false,
    config = jsonb_set(
      jsonb_set(config, '{sync}', '{"cursor":null}'::jsonb, true),
      '{nativeUpgrade}',
      jsonb_build_object(
        'kind', 'legacy-reconciliation-v1',
        'legacySync', coalesce(config -> 'sync', '{}'::jsonb),
        'cutoverPolicy', 'content-match-first-native-version',
        'requiresRevalidation', true,
        'previousPollEnabled', poll_enabled
      ),
      true
    )
where provider = 'ironside'
  and (
    config ->> 'protocolVersion' is null
    or config ->> 'protocolVersion' <> 'ironside/evaluator/v1'
    or (config -> 'sync') ? 'watermark'
    or (config -> 'sync') ? 'windowTo'
  );
