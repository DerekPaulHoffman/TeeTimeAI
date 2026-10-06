import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { isSearchWindowActive } from "./date-boundary";
import { createCourseDispatchIntentDigest, COURSE_DISPATCH_SOURCE_SELECT, type CourseDispatchSourceRef } from "./course-support-dispatch-intent";
import { getSyntheticMultiCycleExpiresAt } from "./synthetic-test-window";
import type { GitDeploymentProof } from "@/lib/deployments/wait-for-git-deployment";

export const SIMULATOR_SUPPORT_LEASE_MS = 15 * 60_000;
export const SIMULATOR_SUPPORT_SOURCE_SELECT = {
  ...COURSE_DISPATCH_SOURCE_SELECT,
  durationMinutes: true,
  checkStatus: true,
  checkLeaseExpiresAt: true,
  remediationDispatchKey: true,
  remediationDispatchVersion: true,
  preferences: { orderBy: [{ rank: "asc" }, { courseId: "asc" }], select: { courseId: true, offeringId: true, rank: true } },
} as const satisfies Prisma.TeeSearchSelect;
export type SimulatorSupportSource = Prisma.TeeSearchGetPayload<{ select: typeof SIMULATOR_SUPPORT_SOURCE_SELECT }>;
export type SimulatorSupportClaim = {
  token: string;
  revision: number;
  phase: "CLAIMED" | "IMPLEMENTING" | "VERIFYING";
  claimedAt: string;
  leaseExpiresAt: string;
  sourceFingerprint: string;
  originalSourceFingerprint: string;
  offeringRevision: number;
  plannedPaths: string[];
  releaseSha: string | null;
  branch: string;
  deployment: GitDeploymentProof | null;
  recheckQueuedAt: string | null;
  verificationCycle: number;
};

export function createSimulatorSupportIntentDigest(search: SimulatorSupportSource) {
  return createHash("sha256").update(JSON.stringify({
    outdoorCompatibleDigest: createCourseDispatchIntentDigest(search),
    mode: search.mode,
    durationMinutes: search.durationMinutes,
    offerings: search.preferences.map(({ courseId, offeringId, rank }) => ({ courseId, offeringId, rank })),
  })).digest("hex");
}

export function isCurrentSimulatorSupportSource(input: {
  search: SimulatorSupportSource;
  ref: CourseDispatchSourceRef;
  offeringId: string;
  trafficClass: "REAL" | "SYNTHETIC";
  timeZone: string;
  now: Date;
}) {
  const { search, ref, offeringId, trafficClass, timeZone, now } = input;
  if (search.mode !== "SIMULATOR" || search.status !== "ACTIVE" || search.id !== ref.id ||
      search.alertGeneration !== ref.alertGeneration || search.scheduleVersion < ref.scheduleVersion ||
      !search.durationMinutes || !search.preferences.some(preference => preference.offeringId === offeringId) ||
      (trafficClass === "REAL" && ["TEST", "AUTOMATION"].includes(search.trafficClass)) ||
      (trafficClass === "SYNTHETIC" && !["TEST", "AUTOMATION"].includes(search.trafficClass)) ||
      !ref.intentDigest || ref.intentDigest !== createSimulatorSupportIntentDigest(search) ||
      !isSearchWindowActive({ date: search.date, endTime: search.endTime, courseTimeZones: [timeZone], fallbackTimeZone: search.userTimeZone, now })) return false;
  const expiry = getSyntheticMultiCycleExpiresAt(search, now);
  return trafficClass === "REAL" || Boolean(search.syntheticMultiCycle && expiry && expiry > now);
}

export function isValidSimulatorSupportClaim(value: unknown): value is SimulatorSupportClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claim = value as SimulatorSupportClaim;
  return typeof claim.token === "string" && claim.token.length > 0 &&
    Number.isSafeInteger(claim.revision) && claim.revision >= 1 &&
    ["CLAIMED", "IMPLEMENTING", "VERIFYING"].includes(claim.phase) &&
    Number.isFinite(Date.parse(claim.claimedAt)) && Number.isFinite(Date.parse(claim.leaseExpiresAt)) &&
    /^[a-f0-9]{64}$/i.test(claim.sourceFingerprint) && /^[a-f0-9]{64}$/i.test(claim.originalSourceFingerprint) &&
    Number.isSafeInteger(claim.offeringRevision) && claim.offeringRevision >= 0 &&
    Array.isArray(claim.plannedPaths) && claim.plannedPaths.every(path => typeof path === "string" && path.length > 0) &&
    typeof claim.branch === "string" && claim.branch !== "main" && claim.branch.length > 0 &&
    (claim.releaseSha === null || /^[a-f0-9]{40}$/i.test(claim.releaseSha)) &&
    Number.isSafeInteger(claim.verificationCycle) && claim.verificationCycle >= 0 && claim.verificationCycle <= 2 &&
    (claim.recheckQueuedAt === null || Number.isFinite(Date.parse(claim.recheckQueuedAt)));
}

export function validateSimulatorSupportPath(path: string) {
  const normalized = path.replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/") || normalized.includes("..") || normalized.includes(":") ||
      /(^|\/)\.env|(^|\/)\.vercel|(^|\/)node_modules|(^|\/)\.git/i.test(normalized)) throw new Error("Simulator support path is invalid.");
  return normalized;
}

export function assertSimulatorSupportDeployment(proof: GitDeploymentProof, releaseSha: string, now: Date) {
  if (proof.source !== "git" || proof.state !== "READY" || proof.branch !== "main" ||
      proof.commitSha !== releaseSha || !proof.deploymentId ||
      !/^https:\/\/[a-z0-9.-]+\.vercel\.app$/i.test(proof.deploymentUrl) ||
      !["teetimespot.com", "www.teetimespot.com"].every(alias => proof.aliases.includes(alias)) ||
      !Number.isFinite(Date.parse(proof.deployedAt)) || new Date(proof.deployedAt) > now) throw new Error("Simulator support requires the exact Ready Git production release and both live aliases.");
}
