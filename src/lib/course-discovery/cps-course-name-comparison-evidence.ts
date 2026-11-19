import { createHash } from "node:crypto";
import { z } from "zod";

const nameKey = z.string().max(240).regex(/^(?:[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*)?$/u)
  .refine(value => value === value.normalize("NFKC").toLowerCase());
/** Private failure inputs only. No URLs, provider IDs, raw documents, contact or
 * customer fields. These compared keys never supply identity/read authority. */
export const cpsCourseNameComparisonEvidenceSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("CPS_NAMED_COURSE_COMPARISON"),
  observedAt: z.string().datetime().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value),
  canonicalName: nameKey.refine(value => value.length > 0),
  officialNames: z.array(nameKey).min(2).max(120),
  providerNames: z.array(nameKey).min(2).max(40),
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value), "utf8") <= 4096);
export type CpsCourseNameComparisonEvidence = z.infer<typeof cpsCourseNameComparisonEvidenceSchema>;
export function parseCpsCourseNameComparisonEvidence(value: unknown) {
  const parsed = cpsCourseNameComparisonEvidenceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

// Same canonical representation as the native worker's checkpoint digests.
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

/** Read only persisted native inputs from this exact failed attempt. The caller
 * must separately establish reciprocal ownership and current source/runtime. */
export function readPrivateCourseNameComparison(job: {
  id: string; sourceFingerprint: string; request: unknown; checkpoint: unknown; attempts: number;
  firstPickedUpAt: Date; deadlineAt: Date; completedAt: Date;
}, now: Date) {
  const failure = object(object(job.checkpoint).stagehandFailure);
  if (failure.schemaVersion !== 1 || failure.kind !== "OWN_STAGEHAND_FAILURE_DIAGNOSTIC" || failure.jobId !== job.id ||
      failure.sourceFingerprint !== job.sourceFingerprint || failure.requestSha256 !== hash(job.request) ||
      failure.firstPickedUpAt !== job.firstPickedUpAt.toISOString() || failure.deadlineAt !== job.deadlineAt.toISOString() ||
      job.deadlineAt.getTime() - job.firstPickedUpAt.getTime() !== 900000 ||
      !Array.isArray(failure.entries) || !failure.entries.length || failure.entries.length > 2 ||
      Buffer.byteLength(JSON.stringify(failure), "utf8") > 32000) return undefined;
  const entries = failure.entries.map(object);
  if (!entries.every((entry, index) => [1, 2].includes(entry.attempt as number) && (entry.attempt as number) <= job.attempts &&
      (!index || (entries[index - 1].attempt as number) < (entry.attempt as number)))) return undefined;
  const end = Math.min(job.deadlineAt.getTime(), job.completedAt.getTime(), now.getTime());
  for (const entry of [...entries].reverse()) {
    if (entry.privateCourseNameComparison === undefined) continue;
    const evidence = parseCpsCourseNameComparisonEvidence(entry.privateCourseNameComparison);
    const diagnostic = object(entry.fixedInspectionDiagnostic);
    const at = typeof entry.observedAt === "string" ? Date.parse(entry.observedAt) : NaN;
    if (!evidence || entry.phase !== "FIXED_INSPECTION" || entry.code !== "ADAPTER_IDENTITY_MISMATCH" ||
        diagnostic.cpsCatalogIdentityFailureStage !== "NAMED_COURSE_NAMES" ||
        entry.fixedInspectionDiagnosticSha256 !== hash(diagnostic) || entry.privateCourseNameComparisonSha256 !== hash(evidence) ||
        !Number.isFinite(at) || at < job.firstPickedUpAt.getTime() || at > end ||
        Date.parse(evidence.observedAt) < job.firstPickedUpAt.getTime() || Date.parse(evidence.observedAt) > at) return undefined;
    return evidence;
  }
  return undefined;
}
