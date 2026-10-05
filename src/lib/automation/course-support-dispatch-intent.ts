import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import { isSearchWindowActive } from "./date-boundary";
import { getSyntheticMultiCycleExpiresAt, syntheticTestWindowSchema } from "./synthetic-test-window";

export const COURSE_DISPATCH_SOURCE_SELECT = {
  id: true,
  mode: true,
  userId: true,
  user: { select: { id: true, clerkUserId: true, email: true, pendingEmail: true } },
  alertEmail: true,
  additionalEmails: true,
  date: true,
  startTime: true,
  endTime: true,
  userTimeZone: true,
  players: true,
  requestedLayoutHoles: true,
  cadenceMinutes: true,
  trafficClass: true,
  syntheticMultiCycle: true,
  syntheticTestWindow: true,
  createdAt: true,
  status: true,
  scheduleVersion: true,
  alertGeneration: true,
  preferences: {
    orderBy: [{ rank: "asc" }, { courseId: "asc" }],
    select: { courseId: true, rank: true },
  },
} as const satisfies Prisma.TeeSearchSelect;

export type CourseDispatchSource = Prisma.TeeSearchGetPayload<{
  select: typeof COURSE_DISPATCH_SOURCE_SELECT;
}>;

export type CourseDispatchSourceRef = {
  id: string;
  scheduleVersion: number;
  alertGeneration: number;
  intentDigest?: string;
};

function normalizeEmail(email: string | null) {
  return email?.trim().toLowerCase() || null;
}

function canonicalSyntheticWindow(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = syntheticTestWindowSchema.safeParse(value);
  if (!parsed.success) throw new Error("Course dispatch source window is invalid.");
  return {
    schemaVersion: parsed.data.schemaVersion,
    alertGeneration: parsed.data.alertGeneration,
    activatedAt: parsed.data.activatedAt,
    expiresAt: parsed.data.expiresAt,
  };
}

export function createCourseDispatchIntentDigest(search: CourseDispatchSource) {
  const intent = {
    schemaVersion: 1,
    owner: {
      userId: search.userId,
      accountId: search.user.id,
      clerkUserId: search.user.clerkUserId,
      accountEmail: normalizeEmail(search.user.email),
      pendingEmail: normalizeEmail(search.user.pendingEmail),
    },
    alertEmail: normalizeEmail(search.alertEmail),
    additionalEmails: [...new Set(search.additionalEmails.map(normalizeEmail).filter(
      (email): email is string => email !== null,
    ))].sort(),
    date: search.date.toISOString().slice(0, 10),
    startTime: search.startTime,
    endTime: search.endTime,
    userTimeZone: search.userTimeZone,
    players: search.players,
    requestedLayoutHoles: search.requestedLayoutHoles,
    cadenceMinutes: search.cadenceMinutes,
    rankedCourses: [...search.preferences]
      .sort((a, b) => a.rank - b.rank || a.courseId.localeCompare(b.courseId))
      .map(({ rank, courseId }) => ({ rank, courseId })),
    trafficClass: search.trafficClass,
    syntheticMultiCycle: search.syntheticMultiCycle,
    createdAt: search.createdAt.toISOString(),
    syntheticTestWindow: canonicalSyntheticWindow(search.syntheticTestWindow),
  };
  return createHash("sha256").update(JSON.stringify(intent)).digest("hex");
}

export function isCurrentCourseDispatchSource(input: {
  ref: CourseDispatchSourceRef;
  search: CourseDispatchSource;
  trafficClass: "REAL" | "SYNTHETIC";
  courseTimeZone: string;
  now: Date;
}) {
  const { ref, search, trafficClass, courseTimeZone, now } = input;
  if (search.mode === "SIMULATOR" || search.id !== ref.id || search.status !== "ACTIVE" ||
      search.alertGeneration !== ref.alertGeneration ||
      search.scheduleVersion < ref.scheduleVersion ||
      (trafficClass === "REAL" && ["TEST", "AUTOMATION"].includes(search.trafficClass)) ||
      (trafficClass === "SYNTHETIC" && search.trafficClass !== "TEST")) return false;
  if (ref.intentDigest) {
    if (!/^[a-f0-9]{64}$/i.test(ref.intentDigest) ||
        createCourseDispatchIntentDigest(search) !== ref.intentDigest) return false;
  } else if (search.scheduleVersion !== ref.scheduleVersion) {
    // Existing v1 assignments have no intent proof; retain their exact schedule fence.
    return false;
  }
  if (!isSearchWindowActive({
    date: search.date,
    endTime: search.endTime,
    courseTimeZones: [courseTimeZone],
    fallbackTimeZone: search.userTimeZone,
    now,
  })) return false;
  const expiry = getSyntheticMultiCycleExpiresAt(search, now);
  return !(["TEST", "AUTOMATION"].includes(search.trafficClass) &&
    !(search.trafficClass === "TEST" && search.syntheticMultiCycle && expiry && expiry > now));
}
