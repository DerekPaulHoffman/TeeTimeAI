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
/** Durable engineering authority is independent from an ended alert's scheduler. */
export type SimulatorEngineeringAuthority = {
  schemaVersion: 1;
  originRunId: string;
  originAssignmentRef: string;
  originSourceFingerprint: string;
  lineageRunId: string;
  lineageAssignmentRef: string;
  sourceFingerprint: string;
};

export function isValidSimulatorEngineeringAuthority(value: unknown): value is SimulatorEngineeringAuthority {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const authority = value as SimulatorEngineeringAuthority;
  const keys = ["schemaVersion", "originRunId", "originAssignmentRef", "originSourceFingerprint", "lineageRunId", "lineageAssignmentRef", "sourceFingerprint"];
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)) &&
    authority.schemaVersion === 1 && [authority.originRunId, authority.originAssignmentRef, authority.lineageRunId, authority.lineageAssignmentRef]
      .every(id => typeof id === "string" && id.length > 0 && id.length <= 160) &&
    [authority.originSourceFingerprint, authority.sourceFingerprint].every(fingerprint => typeof fingerprint === "string" && /^[a-f0-9]{64}$/i.test(fingerprint));
}
export type SimulatorSupportClaim = {
  token: string;
  revision: number;
  phase: "CLAIMED" | "WAITING_IMPLEMENTATION" | "IMPLEMENTING" | "VERIFYING";
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
  pendingImplementation?: { version: 1; path: string; requestedAt: string; sourceFingerprint: string; offeringRevision: number } | null;
};

/** A recorded deployment finishes the code-writing stage. The claim and its
 * paths remain available to the original owner for verification and history. */
export function simulatorSupportReservesImplementation(claim?: SimulatorSupportClaim | null) {
  if (!claim?.plannedPaths.length) return false;
  if (claim.phase !== "VERIFYING" || !claim.releaseSha || !claim.deployment) return true;
  try { assertSimulatorSupportDeployment(claim.deployment, claim.releaseSha, new Date()); }
  catch { return true; }
  return false;
}

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
      (trafficClass === "SYNTHETIC" && !search.durationMinutes) ||
      !search.preferences.some(preference => preference.offeringId === offeringId) ||
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
    ["CLAIMED", "WAITING_IMPLEMENTATION", "IMPLEMENTING", "VERIFYING"].includes(claim.phase) &&
    Number.isFinite(Date.parse(claim.claimedAt)) && Number.isFinite(Date.parse(claim.leaseExpiresAt)) &&
    /^[a-f0-9]{64}$/i.test(claim.sourceFingerprint) && /^[a-f0-9]{64}$/i.test(claim.originalSourceFingerprint) &&
    Number.isSafeInteger(claim.offeringRevision) && claim.offeringRevision >= 0 &&
    Array.isArray(claim.plannedPaths) && claim.plannedPaths.every(path => typeof path === "string" && path.length > 0) &&
    typeof claim.branch === "string" && claim.branch !== "main" && claim.branch.length > 0 &&
    (claim.releaseSha === null || /^[a-f0-9]{40}$/i.test(claim.releaseSha)) &&
    Number.isSafeInteger(claim.verificationCycle) && claim.verificationCycle >= 0 && claim.verificationCycle <= 2 &&
    (claim.recheckQueuedAt === null || Number.isFinite(Date.parse(claim.recheckQueuedAt))) &&
    (claim.phase === "WAITING_IMPLEMENTATION" ? isValidSimulatorImplementationWait(claim) : claim.pendingImplementation == null);
}

/** A deferred request preserves intent, never grants a code path or provider read. */
export function isValidSimulatorImplementationWait(claim: Pick<SimulatorSupportClaim,
  "phase" | "pendingImplementation" | "sourceFingerprint" | "offeringRevision" | "plannedPaths" |
  "releaseSha" | "deployment" | "recheckQueuedAt" | "verificationCycle" | "claimedAt" | "leaseExpiresAt">) {
  const pending = claim.pendingImplementation;
  if (claim.phase !== "WAITING_IMPLEMENTATION" || !pending || typeof pending !== "object" || Array.isArray(pending) ||
      Object.keys(pending).length !== 5 || pending.version !== 1 || pending.sourceFingerprint !== claim.sourceFingerprint ||
      !/^[a-f0-9]{64}$/u.test(claim.sourceFingerprint) || !Number.isSafeInteger(claim.offeringRevision) || claim.offeringRevision < 0 ||
      !Number.isFinite(Date.parse(claim.claimedAt)) || !Number.isFinite(Date.parse(claim.leaseExpiresAt)) ||
      pending.offeringRevision !== claim.offeringRevision || !Array.isArray(claim.plannedPaths) || claim.plannedPaths.length || claim.releaseSha !== null ||
      claim.deployment !== null || claim.recheckQueuedAt !== null || claim.verificationCycle !== 0 ||
      !Number.isFinite(Date.parse(pending.requestedAt)) || Date.parse(pending.requestedAt) < Date.parse(claim.claimedAt) ||
      Date.parse(pending.requestedAt) > Date.parse(claim.leaseExpiresAt)) return false;
  try { return typeof pending.path === "string" && pending.path === validateSimulatorSupportPath(pending.path); }
  catch { return false; }
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
