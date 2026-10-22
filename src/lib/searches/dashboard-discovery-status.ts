import type { CourseDiscoveryJob, Prisma } from "@prisma/client";
import { getDiscoverySourceFingerprint } from "@/lib/course-discovery/service";

export type DashboardDiscoveryStatus = {
  state: "TERMINAL_FAILURE";
  completedAt: Date;
};

type FingerprintCourse = Parameters<typeof getDiscoverySourceFingerprint>[0];
type FingerprintOffering = NonNullable<Parameters<typeof getDiscoverySourceFingerprint>[1]>;
type DiscoveryJob = Pick<CourseDiscoveryJob,
  "targetKey" | "courseId" | "offeringId" | "sourceFingerprint" | "baseRecipeId" | "status" | "request" | "createdAt" | "completedAt">;
type Search = {
  id: string;
  status: string;
  mode: string;
  alertGeneration: number;
  date: Date;
  startTime: string;
  endTime: string;
  players: number;
  durationMinutes: number | null;
};
type Preference = {
  course: FingerprintCourse;
  offering: FingerprintOffering | null;
};
type Probe = { outcome: string; observedAt: Date };

export const dashboardDiscoveryJobSelect = {
  targetKey: true, courseId: true, offeringId: true,
  sourceFingerprint: true, baseRecipeId: true, status: true,
  request: true, createdAt: true, completedAt: true,
} satisfies Prisma.CourseDiscoveryJobSelect;

function exactRecord(value: unknown, expected: Record<string, unknown>) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, item]) => record[key] === item);
}

/** The caller supplies only the newest job for this exact owned request/target. */
export function getDashboardDiscoveryStatus(search: Search, preference: Preference,
  job: DiscoveryJob | null, latestProbe?: Probe, now = new Date()): DashboardDiscoveryStatus | null {
  if (search.status !== "ACTIVE" || !job || !["FAILED", "TIMED_OUT"].includes(job.status) ||
      !["OUTDOOR", "SIMULATOR"].includes(search.mode) ||
      !Number.isInteger(search.alertGeneration) || search.alertGeneration < 0 ||
      !(search.date instanceof Date) || !Number.isFinite(search.date.getTime()) ||
      !(job.completedAt instanceof Date) || !Number.isFinite(job.completedAt.getTime()) || job.completedAt > now ||
      !(job.createdAt instanceof Date) || !Number.isFinite(job.createdAt.getTime()) || job.completedAt < job.createdAt) return null;
  const { course, offering } = preference;
  if (search.mode === "SIMULATOR" ? !offering || !offering.active || offering.courseId !== course.id || offering.kind !== "SIMULATOR" || offering.publicAccessStatus === "NOT_PUBLIC"
    : Boolean(offering) || course.isPublic === false) return null;
  const targetKey = offering ? `offering:${offering.id}` : `course:${course.id}`;
  if (job.targetKey !== targetKey || job.courseId !== course.id || job.offeringId !== (offering?.id ?? null) ||
      job.baseRecipeId !== (offering ? offering.activeAccessRecipeId : course.activeAccessRecipeId) ||
      job.sourceFingerprint !== getDiscoverySourceFingerprint(course, offering)) return null;
  const request = job.request && typeof job.request === "object" && !Array.isArray(job.request)
    ? job.request as Record<string, unknown> : null;
  if (!request || !exactRecord(request.demand, { searchId: search.id, alertGeneration: search.alertGeneration }) ||
      !exactRecord(request.target, { courseId: course.id, ...(offering ? { offeringId: offering.id } : {}), kind: search.mode }) ||
      !exactRecord(request.input, { date: search.date.toISOString().slice(0, 10), timeZone: course.timeZone,
        players: search.players, startTime: search.startTime, endTime: search.endTime,
        ...(search.durationMinutes ? { durationMinutes: search.durationMinutes } : {}) }) ||
      !exactRecord(request.identity, { name: course.name, officialUrl: course.website,
        bookingUrl: offering ? offering.bookingUrl : course.detectedBookingUrl, timeZone: course.timeZone,
        providerFamily: offering ? offering.providerFamilyKey : course.providerFamilyKey,
        ...(course.address ? { address: course.address } : {}) })) return null;
  // Only already generation-fenced successful probes can supersede this failure.
  if (latestProbe && ["MATCH_FOUND", "NO_MATCH"].includes(latestProbe.outcome) &&
      latestProbe.observedAt instanceof Date && latestProbe.observedAt >= job.completedAt && latestProbe.observedAt <= now) return null;
  return { state: "TERMINAL_FAILURE", completedAt: job.completedAt };
}
