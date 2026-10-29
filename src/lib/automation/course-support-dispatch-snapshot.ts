import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";

// Observation clocks, occurrence counts and scheduling timestamps are not
// authority. Due-time/request checks still run independently at locked claim.
export const COURSE_DISPATCH_INCIDENT_SNAPSHOT_SELECT = {
  id: true, courseId: true, cycle: true, status: true, kind: true,
  providerFamilyKey: true, failureClass: true, failureFingerprint: true,
  humanReviewReason: true, engineeringOnly: true, attemptLedger: true,
  confirmedAt: true, escalatedAt: true, lastAttemptAt: true,
  attemptCount: true, activeBatchId: true,
} satisfies Prisma.CourseSupportIncidentSelect;

type Incident = Prisma.CourseSupportIncidentGetPayload<{ select: typeof COURSE_DISPATCH_INCIDENT_SNAPSHOT_SELECT }>;
function stable(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  if (value === undefined) throw new Error("Course dispatch material snapshot is incomplete.");
  return JSON.stringify(value);
}

export function createCourseDispatchIncidentFingerprint(incident: Incident, providerSnapshotFingerprint: string) {
  if (!/^[a-f0-9]{64}$/u.test(providerSnapshotFingerprint)) return undefined;
  const material = Object.fromEntries(Object.keys(COURSE_DISPATCH_INCIDENT_SNAPSHOT_SELECT).map(key => [key, incident[key as keyof Incident]]));
  // Incomplete legacy/mock readers cannot issue new semantic proof. They retain
  // the stricter timestamp contract; an existing semantic proof never matches.
  try { return createHash("sha256").update(stable({ version: 1, material, providerSnapshotFingerprint })).digest("hex"); }
  catch { return undefined; }
}

export function isCourseDispatchIncidentSnapshotCurrent(
  target: { updatedAt: string; incidentFingerprint?: string },
  incident: Incident & { updatedAt: Date },
  providerSnapshotFingerprint: string,
) {
  // Never reinterpret historical assignments that lack the new proof.
  if (target.incidentFingerprint === undefined) return incident.updatedAt.toISOString() === target.updatedAt;
  try { return target.incidentFingerprint === createCourseDispatchIncidentFingerprint(incident, providerSnapshotFingerprint); }
  catch { return false; }
}
