alter table raw_traces
  add column source_trace_version text;

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

create index raw_traces_source_version_lookup
  on raw_traces (project_id, source_trace_id, source_trace_version);
