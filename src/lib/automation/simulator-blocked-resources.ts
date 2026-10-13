import { z } from "zod";

const resource = z.enum(["DOCUMENT", "SCRIPT", "STYLESHEET", "XHR", "FETCH", "OTHER"]);
const method = z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OTHER"]);
const reason = z.enum(["RESOURCE_KIND_NOT_ALLOWED", "METHOD_NOT_ALLOWED", "SENSITIVE_HEADERS",
  "CHALLENGE_RESOURCE", "UNSCOPED_DESTINATION", "UNSAFE_URL", "REQUEST_BUDGET", "TERMINAL_MAIN_DOCUMENT"]);
const relation = z.enum(["SAME_SITE", "DECLARED_ASSET", "OTHER_ORIGIN", "UNKNOWN"]);
const words = new Set(["api", "booking", "changefield", "availability", "calendar", "times", "public", "schedule", "slots", ":value"]);
const pathShape = z.string().max(120).refine(value => value === "/" || value.startsWith("/") && (() => {
  const parts = value.slice(1).split("/");
  return parts.length <= 9 && parts.every((part, index) => words.has(part) || part === ":more" && index === 8);
})());

export const blockedResourceDiagnosticsSchema = z.array(z.object({
  state: z.literal("NOT_EXECUTED"), resourceKind: resource, method, reason, originRelation: relation,
  pathShape, count: z.number().int().min(1).max(32),
}).strict()).min(1).max(8).refine(entries => entries.reduce((sum, entry) => sum + entry.count, 0) <= 32 &&
  new Set(entries.map(entry => [entry.resourceKind, entry.method, entry.reason, entry.originRelation, entry.pathShape].join("|"))).size === entries.length);

export type SimulatorBlockedResourceDiagnostic = z.infer<typeof blockedResourceDiagnosticsSchema>[number];

/** Closed facts only: no URL, host, query, header name/value or payload is retained. */
export function createBlockedResourceDiagnostics() {
  const entries: SimulatorBlockedResourceDiagnostic[] = [];
  let truncated = false, unresolvedActiveResource = false;
  return {
    record(input: { url: string; kind: string; method: string; reason: SimulatorBlockedResourceDiagnostic["reason"];
      originRelation: SimulatorBlockedResourceDiagnostic["originRelation"] }) {
      const resourceKind = resource.safeParse(input.kind.toUpperCase()).data ?? "OTHER";
      const safeMethod = method.safeParse(input.method).data ?? "OTHER";
      if (["SCRIPT", "XHR", "FETCH"].includes(resourceKind)) unresolvedActiveResource = true;
      let shape = "/";
      try {
        const parts = new URL(input.url).pathname.split("/").filter(Boolean);
        shape += [...parts.slice(0, 8).map(part => words.has(part.toLowerCase()) ? part.toLowerCase() : ":value"),
          ...(parts.length > 8 ? [":more"] : [])].join("/");
      } catch { /* Invalid destinations never expose raw text. */ }
      const entry = { state: "NOT_EXECUTED" as const, resourceKind, method: safeMethod,
        reason: input.reason, originRelation: input.originRelation, pathShape: shape };
      const existing = entries.find(row => Object.entries(entry).every(([key, value]) => row[key as keyof typeof row] === value));
      if (entries.reduce((sum, row) => sum + row.count, 0) >= 32 || !existing && entries.length >= 8) { truncated = true; return; }
      if (existing) existing.count += 1;
      else entries.push({ ...entry, count: 1 });
    },
    hasUnresolvedActiveResource: () => unresolvedActiveResource,
    fields: () => entries.length ? { blockedResourceDiagnostics: entries,
      ...(truncated ? { blockedResourceDiagnosticsTruncated: true as const } : {}) } : {},
  };
}
