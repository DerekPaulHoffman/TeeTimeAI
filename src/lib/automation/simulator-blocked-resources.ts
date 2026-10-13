import { z } from "zod";

const resource = z.enum(["DOCUMENT", "SCRIPT", "STYLESHEET", "XHR", "FETCH", "OTHER"]);
const method = z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OTHER"]);
const reason = z.enum(["RESOURCE_KIND_NOT_ALLOWED", "METHOD_NOT_ALLOWED", "SENSITIVE_HEADERS",
  "CHALLENGE_RESOURCE", "UNSCOPED_DESTINATION", "UNSAFE_URL", "REQUEST_BUDGET", "TERMINAL_MAIN_DOCUMENT"]);
const relation = z.enum(["SAME_SITE", "DECLARED_ASSET", "OTHER_ORIGIN", "UNKNOWN"]);
const headerKind = z.enum(["COOKIE", "AUTHORIZATION", "API_KEY", "TOKEN", "OTHER_CREDENTIAL"]);
export type SimulatorCredentialHeaderKind = z.infer<typeof headerKind>;
export function simulatorCredentialHeaderKind(name: string): SimulatorCredentialHeaderKind | undefined {
  if (name.toLowerCase() === "cookie") return "COOKIE";
  if (/authorization/iu.test(name)) return "AUTHORIZATION";
  if (/api.?key/iu.test(name)) return "API_KEY";
  if (/token/iu.test(name)) return "TOKEN";
  if (/cookie|secret|credential/iu.test(name)) return "OTHER_CREDENTIAL";
  return undefined;
}
const fieldKind = z.enum(["ACTION", "OPERATION", "ROUTE", "PARAMETERS", "DATE", "TIME", "DURATION", "RESOURCE", "COUNT", "CONTACT", "AUTH", "FORM", "OTHER"]);
const operationHint = z.enum(["READ", "WRITE", "AVAILABILITY", "BOOKING", "FORM"]);
export const blockedRequestBodyShapeSchema = z.object({
  format: z.enum(["JSON", "FORM", "EMPTY", "OTHER", "OVERSIZED"]),
  fieldKinds: z.array(fieldKind).max(13).refine(values => new Set(values).size === values.length),
  operationHints: z.array(operationHint).max(5).refine(values => new Set(values).size === values.length),
  truncated: z.literal(true).optional(),
}).strict().refine(value => ["JSON", "FORM"].includes(value.format) ||
  value.fieldKinds.length === 0 && value.operationHints.length === 0 && value.truncated === undefined);
type BodyShape = z.infer<typeof blockedRequestBodyShapeSchema>;

/** Labels and closed hints only. A read-shaped name is not proof of server semantics. */
export function summarizeBlockedRequestBody(body: string | null, contentType: string): BodyShape {
  const empty = (format: BodyShape["format"]): BodyShape => ({ format, fieldKinds: [], operationHints: [] });
  if (!body) return empty("EMPTY");
  if (Buffer.byteLength(body, "utf8") > 16_384) return empty("OVERSIZED");
  let entries: [string, unknown][], format: "JSON" | "FORM";
  try {
    if (/^application\/json(?:;|$)/iu.test(contentType)) {
      const value: unknown = JSON.parse(body);
      if (!value || typeof value !== "object" || Array.isArray(value)) return empty("OTHER");
      entries = Object.entries(value); format = "JSON";
    } else if (/^application\/x-www-form-urlencoded(?:;|$)/iu.test(contentType)) {
      entries = [...new URLSearchParams(body)]; format = "FORM";
    } else if (/^multipart\/form-data(?:;|$)/iu.test(contentType)) {
      const boundary = contentType.match(/(?:^|;)\s*boundary=(?:"([^"\r\n]{1,70})"|([^;\s\r\n]{1,70}))/iu);
      const value = boundary?.[1] ?? boundary?.[2];
      if (!value) return empty("OTHER");
      entries = body.split(`--${value}`).slice(1).flatMap(part => {
        const split = part.indexOf("\r\n\r\n");
        if (split < 0) return [];
        const header = part.slice(0, split), name = header.match(/content-disposition:\s*form-data;[^\r\n]*\bname="([^"\r\n]{1,64})"/iu)?.[1];
        if (!name) return [];
        return [[name, /\bfilename=/iu.test(header) ? undefined : part.slice(split + 4).replace(/\r\n$/u, "")]] as [string, unknown][];
      });
      format = "FORM";
    } else return empty("OTHER");
  } catch { return empty("OTHER"); }
  const fields = new Set<BodyShape["fieldKinds"][number]>(), hints = new Set<BodyShape["operationHints"][number]>();
  let truncated = entries.length > 32;
  for (const [key, value] of entries.slice(0, 32)) {
    const name = key.toLowerCase().replace(/[^a-z]/gu, "");
    const kind = /^(action|operation|method|route|routename)$/u.test(name)
      ? name === "action" ? "ACTION" : name.startsWith("route") ? "ROUTE" : "OPERATION"
      : /token|nonce|secret|password|signature|credential|apikey/u.test(name) ? "AUTH"
        : /email|phone|address|name|contact/u.test(name) ? "CONTACT"
          : /form/u.test(name) ? "FORM" : /^(params|parameters|data|args|fields)$/u.test(name) ? "PARAMETERS"
            : /date|day/u.test(name) ? "DATE" : /duration|length/u.test(name) ? "DURATION"
              : /time/u.test(name) ? "TIME" : /resource|service|bay|room|court/u.test(name) ? "RESOURCE"
                : /count|players|quantity/u.test(name) ? "COUNT" : "OTHER";
    fields.add(kind);
    if (!["ACTION", "OPERATION", "ROUTE"].includes(kind) || typeof value !== "string") continue;
    if (value.length > 512) { truncated = true; continue; }
    const tokens = value.toLowerCase().split(/[^a-z]+/u);
    if (tokens.some(token => ["get", "list", "load", "fetch", "read", "search", "find", "retrieve"].includes(token))) hints.add("READ");
    if (tokens.some(token => ["create", "save", "submit", "send", "update", "delete", "reserve", "pay", "purchase", "checkout"].includes(token))) hints.add("WRITE");
    if (tokens.some(token => ["availability", "available", "slots", "times", "calendar"].includes(token))) hints.add("AVAILABILITY");
    if (tokens.some(token => ["booking", "bookings", "appointment", "appointments"].includes(token))) hints.add("BOOKING");
    if (tokens.some(token => ["form", "forms", "contact", "newsletter"].includes(token))) hints.add("FORM");
  }
  return { format, fieldKinds: [...fields].sort(), operationHints: [...hints].sort(), ...(truncated ? { truncated: true as const } : {}) };
}
const words = new Set(["api", "booking", "changefield", "availability", "calendar", "times", "public", "schedule", "slots", ":value"]);
const pathShape = z.string().max(120).refine(value => value === "/" || value.startsWith("/") && (() => {
  const parts = value.slice(1).split("/");
  return parts.length <= 9 && parts.every((part, index) => words.has(part) || part === ":more" && index === 8);
})());

export const blockedResourceDiagnosticsSchema = z.array(z.object({
  state: z.literal("NOT_EXECUTED"), resourceKind: resource, method, reason, originRelation: relation,
  pathShape, count: z.number().int().min(1).max(32),
  headerKinds: z.array(headerKind).min(1).max(5).refine(values => new Set(values).size === values.length).optional(),
  bodyShape: blockedRequestBodyShapeSchema.optional(),
}).strict().refine(entry => !entry.headerKinds || entry.reason === "SENSITIVE_HEADERS")
  .refine(entry => !entry.bodyShape || ["XHR", "FETCH"].includes(entry.resourceKind) && !["GET", "HEAD"].includes(entry.method)))
  .min(1).max(8).refine(entries => entries.reduce((sum, entry) => sum + entry.count, 0) <= 32 &&
  new Set(entries.map(entry => [entry.resourceKind, entry.method, entry.reason, entry.originRelation, entry.pathShape,
    entry.headerKinds?.join(","), JSON.stringify(entry.bodyShape)].join("|"))).size === entries.length);

export type SimulatorBlockedResourceDiagnostic = z.infer<typeof blockedResourceDiagnosticsSchema>[number];

/** Closed facts only: no URL, host, query, header name/value or payload is retained. */
export function createBlockedResourceDiagnostics() {
  const entries: SimulatorBlockedResourceDiagnostic[] = [];
  let truncated = false, unresolvedActiveResource = false;
  return {
    record(input: { url: string; kind: string; method: string; reason: SimulatorBlockedResourceDiagnostic["reason"];
      originRelation: SimulatorBlockedResourceDiagnostic["originRelation"]; headerKinds?: SimulatorCredentialHeaderKind[]; bodyShape?: BodyShape }) {
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
        reason: input.reason, originRelation: input.originRelation, pathShape: shape,
        ...(input.headerKinds?.length ? { headerKinds: [...new Set(input.headerKinds)].sort() } : {}),
        ...(input.bodyShape ? { bodyShape: input.bodyShape } : {}) };
      const existing = entries.find(row => Object.entries(entry).every(([key, value]) =>
        JSON.stringify(row[key as keyof typeof row]) === JSON.stringify(value)) && JSON.stringify(row.headerKinds) === JSON.stringify(entry.headerKinds) &&
        JSON.stringify(row.bodyShape) === JSON.stringify(entry.bodyShape));
      if (entries.reduce((sum, row) => sum + row.count, 0) >= 32 || !existing && entries.length >= 8) { truncated = true; return; }
      if (existing) existing.count += 1;
      else entries.push({ ...entry, count: 1 });
    },
    hasUnresolvedActiveResource: () => unresolvedActiveResource,
    fields: () => entries.length ? { blockedResourceDiagnostics: entries,
      ...(truncated ? { blockedResourceDiagnosticsTruncated: true as const } : {}) } : {},
  };
}
