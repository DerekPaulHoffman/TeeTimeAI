import { createHash } from "node:crypto";
import { z } from "zod";

const key = z.string().regex(/^[A-Za-z_]{1,48}$/u).refine(value => !["__proto__", "prototype", "constructor"].includes(value));
const path = z.array(z.union([key, z.literal(0)])).max(4);
const count = z.union([z.number().int().min(0).max(500), z.literal("OVER_LIMIT")]);
/** Private structural input, never a response body or a provider contract.
 * Scalar values are absent. Unrepresentable field names are omitted. */
export const cpsAvailabilityStructureSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("CPS_AVAILABILITY_CONTENT_STRUCTURE"),
  observedAt: z.string().datetime().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value),
  truncated: z.boolean(),
  nodes: z.array(z.object({ path, type: z.enum(["OBJECT", "ARRAY", "NULL", "STRING", "NUMBER", "BOOLEAN", "OTHER"]),
    count: count.optional() }).strict().refine(node => ["OBJECT", "ARRAY"].includes(node.type) === (node.count !== undefined))).min(1).max(96),
}).strict().refine(value => value.nodes[0].path.length === 0 && value.nodes[0].type === "OBJECT" &&
  value.nodes.every((node, index) => !index || node.path.length > 0 && value.nodes.slice(0, index).some(parent =>
    parent.path.length === node.path.length - 1 && JSON.stringify(parent.path) === JSON.stringify(node.path.slice(0, -1)) &&
    (typeof node.path.at(-1) === "number" ? parent.type === "ARRAY" && parent.count !== 0 : parent.type === "OBJECT"))) &&
  new Set(value.nodes.map(node => JSON.stringify(node.path))).size === value.nodes.length &&
  Buffer.byteLength(JSON.stringify(value), "utf8") <= 16000);
export type CpsAvailabilityStructure = z.infer<typeof cpsAvailabilityStructureSchema>;
export function parseCpsAvailabilityStructure(value: unknown) {
  const parsed = cpsAvailabilityStructureSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function captureCpsAvailabilityStructure(content: unknown, observedAt = new Date().toISOString()) {
  if (!content || typeof content !== "object" || Array.isArray(content)) return undefined;
  const nodes: CpsAvailabilityStructure["nodes"] = [];
  let truncated = false;
  const bounded = (n: number) => n > 500 ? "OVER_LIMIT" as const : n;
  function visit(value: unknown, at: (string | 0)[]) {
    if (nodes.length >= 96) { truncated = true; return; }
    const type = value === null ? "NULL" : Array.isArray(value) ? "ARRAY" : typeof value === "object" ? "OBJECT" :
      typeof value === "string" ? "STRING" : typeof value === "number" ? "NUMBER" : typeof value === "boolean" ? "BOOLEAN" : "OTHER";
    const keys = type === "OBJECT" ? Object.keys(value as object) : [];
    nodes.push({ path: at, type, ...(["OBJECT", "ARRAY"].includes(type) ? { count: bounded(type === "ARRAY" ? (value as unknown[]).length : keys.length) } : {}) });
    if (at.length >= 4) { if (keys.length || type === "ARRAY" && (value as unknown[]).length) truncated = true; return; }
    if (type === "ARRAY") {
      const array = value as unknown[];
      if (array.length > 1) truncated = true;
      if (array.length) visit(array[0], [...at, 0]);
    } else if (type === "OBJECT") {
      if (keys.length > 24) truncated = true;
      for (const name of keys.slice(0, 24)) {
        if (!key.safeParse(name).success) { truncated = true; continue; }
        visit((value as Record<string, unknown>)[name], [...at, name]);
      }
    }
  }
  visit(content, []);
  return parseCpsAvailabilityStructure({ schemaVersion: 1, kind: "CPS_AVAILABILITY_CONTENT_STRUCTURE", observedAt, truncated, nodes });
}

const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object"
  ? `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Caller separately validates the current reciprocal original owner/source. */
export function readPrivateCpsAvailabilityStructure(job: {
  id: string; sourceFingerprint: string; request: unknown; checkpoint: unknown; attempts: number;
  firstPickedUpAt: Date; deadlineAt: Date; completedAt: Date;
}, now: Date) {
  const failure = object(object(job.checkpoint).stagehandFailure);
  if (failure.schemaVersion !== 1 || failure.kind !== "OWN_STAGEHAND_FAILURE_DIAGNOSTIC" || failure.jobId !== job.id ||
      failure.sourceFingerprint !== job.sourceFingerprint || failure.requestSha256 !== hash(job.request) ||
      failure.firstPickedUpAt !== job.firstPickedUpAt.toISOString() || failure.deadlineAt !== job.deadlineAt.toISOString() ||
      job.deadlineAt.getTime() - job.firstPickedUpAt.getTime() !== 900000 || !Array.isArray(failure.entries) ||
      !failure.entries.length || failure.entries.length > 2 || Buffer.byteLength(JSON.stringify(failure), "utf8") > 32000) return undefined;
  const entries = failure.entries.map(object);
  if (!entries.every((entry, index) => [1, 2].includes(entry.attempt as number) && (entry.attempt as number) <= job.attempts &&
      (!index || (entries[index - 1].attempt as number) < (entry.attempt as number)))) return undefined;
  const end = Math.min(job.deadlineAt.getTime(), job.completedAt.getTime(), now.getTime());
  for (const entry of [...entries].reverse()) {
    if (entry.privateCpsAvailabilityStructure === undefined) continue;
    const evidence = parseCpsAvailabilityStructure(entry.privateCpsAvailabilityStructure);
    const at = typeof entry.observedAt === "string" ? Date.parse(entry.observedAt) : NaN;
    if (!evidence || entry.phase !== "REPLAY" || entry.code !== "DISCOVERY_REPLAY_INCOMPLETE" ||
        entry.replayFailureCode !== "CPS_AVAILABILITY_INCOMPLETE" || entry.privateCpsAvailabilityStructureSha256 !== hash(evidence) ||
        !Number.isFinite(at) || at < job.firstPickedUpAt.getTime() || at > end ||
        Date.parse(evidence.observedAt) < job.firstPickedUpAt.getTime() || Date.parse(evidence.observedAt) > at) return undefined;
    return evidence;
  }
  return undefined;
}
