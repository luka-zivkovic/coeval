import { z } from "zod";

// Cross-product trace deep links (CURRENT).
//
// Inbound: Ironside's trace viewer links to
//   /links/trace?source=ironside&project=<ironside project id>&trace=<traceId>&version=<traceVersion?>
// and Rubrist resolves that against the native integration's source identity
// `(remote project, traceId, traceVersion)` inside the signed-in user's
// project memberships. The shape is a shared contract with Ironside; change it
// only together with Ironside's link builder.
//
// Outbound: an imported Ironside case links back to Ironside's trace viewer.
// The viewer route pattern lives only in `ironsideTraceViewerUrl` below.

export const TRACE_LINK_SOURCES = ["ironside"] as const;
export const TraceLinkSourceSchema = z.enum(TRACE_LINK_SOURCES);
export type TraceLinkSource = z.infer<typeof TraceLinkSourceSchema>;

// Mirrors the raw_traces source-identity column bounds. Control characters
// are rejected so a crafted link cannot smuggle separators into lookups or UI.
const LinkIdentifierSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => value === value.trim(), { message: "must not have leading or trailing whitespace" })
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), { message: "must not contain control characters" });

export const TraceDeepLinkQuerySchema = z.object({
  source: TraceLinkSourceSchema,
  project: LinkIdentifierSchema,
  trace: LinkIdentifierSchema,
  // Ironside trace versions are ISO-8601 instants with an offset; the value is
  // matched exactly against the stored source identity, never normalized.
  version: z.iso.datetime({ offset: true }).max(200).optional()
}).strict();
export type TraceDeepLinkQuery = z.infer<typeof TraceDeepLinkQuerySchema>;

export type TraceDeepLinkParseResult =
  | { ok: true; query: TraceDeepLinkQuery }
  | { ok: false; code: "unsupported_source" | "invalid_link"; error: string };

const TRACE_LINK_PARAMS = ["source", "project", "trace", "version"] as const;

// Parses the raw URL query of a deep link. Unrelated parameters are ignored;
// each recognized parameter must appear at most once. An empty `version` is
// treated as omitted so a producer that always emits the key stays valid.
export function parseTraceDeepLink(params: URLSearchParams): TraceDeepLinkParseResult {
  const candidate: Record<string, string> = {};
  for (const key of TRACE_LINK_PARAMS) {
    const values = params.getAll(key);
    if (values.length > 1) {
      return { ok: false, code: "invalid_link", error: `The link repeats the "${key}" parameter.` };
    }
    const value = values[0];
    if (value === undefined || (key === "version" && value === "")) continue;
    candidate[key] = value;
  }
  if (candidate.source === undefined) {
    return { ok: false, code: "invalid_link", error: "The link is missing its source." };
  }
  if (!TraceLinkSourceSchema.safeParse(candidate.source).success) {
    return {
      ok: false,
      code: "unsupported_source",
      error: `Rubrist cannot open trace links from "${candidate.source.slice(0, 80)}". Supported sources: ${TRACE_LINK_SOURCES.join(", ")}.`
    };
  }
  const parsed = TraceDeepLinkQuerySchema.safeParse(candidate);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "link")))];
    return { ok: false, code: "invalid_link", error: `The link has an invalid or missing ${fields.join(", ")} parameter.` };
  }
  return { ok: true, query: parsed.data };
}

export function traceDeepLinkPath(query: TraceDeepLinkQuery): string {
  const params = new URLSearchParams({ source: query.source, project: query.project, trace: query.trace });
  if (query.version) params.set("version", query.version);
  return `/links/trace?${params.toString()}`;
}

export const TraceLinkMatchSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  caseId: z.string(),
  traceVersion: z.string().nullable(),
  importedAt: z.string(),
  // Number of imported versions of this trace in the project when the link
  // named no version; the newest imported version is the match.
  importedVersionCount: z.number().int().positive()
});
export type TraceLinkMatch = z.infer<typeof TraceLinkMatchSchema>;

export const TraceLinkConnectionSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  integrationId: z.string(),
  // The connection's polling evaluator binding; a link-page sync reuses it
  // and never picks an evaluator on the user's behalf.
  skillVersionId: z.string().nullable(),
  pollLimit: z.number().int().positive(),
  revalidationRequired: z.boolean(),
  pollEnabled: z.boolean()
});
export type TraceLinkConnection = z.infer<typeof TraceLinkConnectionSchema>;

export const TraceLinkResolutionSchema = z.object({
  source: TraceLinkSourceSchema,
  remoteProjectId: z.string(),
  traceId: z.string(),
  traceVersion: z.string().nullable(),
  // resolved: exactly one member project holds the trace; ambiguous: more
  // than one does and the user picks; not_imported: none does yet.
  status: z.enum(["resolved", "ambiguous", "not_imported"]),
  matches: z.array(TraceLinkMatchSchema),
  // When the link named a version that is not imported, other imported
  // versions of the same trace in member projects.
  otherVersions: z.array(TraceLinkMatchSchema),
  // Existing native connections to this remote project in member projects;
  // their sync action is the only import pathway a link may offer.
  connections: z.array(TraceLinkConnectionSchema)
});
export type TraceLinkResolution = z.infer<typeof TraceLinkResolutionSchema>;

export const CaseSourceLinkSchema = z.object({
  ironside: z.object({
    remoteProjectId: z.string(),
    traceId: z.string(),
    traceVersion: z.string().nullable(),
    // Null when no current connection to that remote project can supply a
    // base URL (for example after a disconnect).
    viewerUrl: z.string().nullable()
  }).nullable()
});
export type CaseSourceLink = z.infer<typeof CaseSourceLinkSchema>;

// The single place that knows Ironside's trace-viewer route. Ironside keeps
// `/projects/:projectId/traces/:traceId` as its stable viewer URL. The base is
// the integration's optional web URL, falling back to its API URL; anything
// other than http(s) yields no link.
export function ironsideTraceViewerUrl(baseUrl: string, remoteProjectId: string, traceId: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const base = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  return `${base}/projects/${encodeURIComponent(remoteProjectId)}/traces/${encodeURIComponent(traceId)}`;
}
