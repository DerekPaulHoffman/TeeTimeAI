import type { GitDeploymentProof } from "@/lib/deployments/wait-for-git-deployment";
import { getSimulatorBookingOpening } from "@/lib/simulators/booking-window";
import { assertSimulatorSupportDeployment, type SimulatorSupportClaim } from "./simulator-support-policy";

export const SIMULATOR_ENGINEERING_VERIFICATION_LEASE_MS = 120_000;
export const SIMULATOR_ENGINEERING_VERIFICATION_DEADLINE_MS = 90_000;
export const SIMULATOR_ENGINEERING_VERIFICATION_MAX_READS = 2;
export const SIMULATOR_ENGINEERING_VERIFICATION_FAILURE_CODES = ["NORMAL_CUSTOMER_CHECK_REQUIRED", "RUNTIME_NOT_CURRENT", "PUBLIC_RENTAL_NOT_READY",
  "BOOKING_NOT_OPEN", "READ_IN_FLIGHT", "REPAIR_REQUIRED", "RESERVATION_STALE", "EVIDENCE_INVALID", "EVIDENCE_LIMIT", "WRITER_BUSY", "PROVIDER_BUSY",
  "OWNERSHIP_OR_SOURCE_CHANGED", "VERIFICATION_FAILED"] as const;
export type SimulatorEngineeringVerificationFailureCode = typeof SIMULATOR_ENGINEERING_VERIFICATION_FAILURE_CODES[number];
const safeFailures: Record<string, SimulatorEngineeringVerificationFailureCode> = {
  SIMULATOR_ENGINEERING_CUSTOMER_CHECK_REQUIRED: "NORMAL_CUSTOMER_CHECK_REQUIRED",
  SIMULATOR_ENGINEERING_RUNTIME_NOT_CURRENT: "RUNTIME_NOT_CURRENT",
  SIMULATOR_ENGINEERING_PUBLIC_RENTAL_NOT_READY: "PUBLIC_RENTAL_NOT_READY",
  SIMULATOR_ENGINEERING_BOOKING_NOT_OPEN: "BOOKING_NOT_OPEN",
  SIMULATOR_ENGINEERING_VERIFICATION_READ_IN_FLIGHT: "READ_IN_FLIGHT",
  SIMULATOR_ENGINEERING_VERIFICATION_REPAIR_REQUIRED: "REPAIR_REQUIRED",
  SIMULATOR_ENGINEERING_RESERVATION_STALE: "RESERVATION_STALE",
  SIMULATOR_ENGINEERING_EVIDENCE_INVALID: "EVIDENCE_INVALID",
  SIMULATOR_ENGINEERING_EVIDENCE_LIMIT: "EVIDENCE_LIMIT",
  SIMULATOR_ENGINEERING_WRITER_BUSY: "WRITER_BUSY",
  SIMULATOR_ENGINEERING_PROVIDER_BUSY: "PROVIDER_BUSY",
  "Simulator support owner, revision or lease is stale.": "OWNERSHIP_OR_SOURCE_CHANGED",
  "Simulator source demand changed; preserve ownership and stop.": "OWNERSHIP_OR_SOURCE_CHANGED",
  "Simulator offering source changed; an explicit owner adoption is required.": "OWNERSHIP_OR_SOURCE_CHANGED",
};
/** A closed operator diagnostic; unknown errors do not masquerade as an authority change. */
export function classifySimulatorEngineeringVerificationFailure(error: unknown): SimulatorEngineeringVerificationFailureCode {
  return error instanceof Error && Object.hasOwn(safeFailures, error.message) ? safeFailures[error.message] : "VERIFICATION_FAILED";
}

export type SimulatorEngineeringVerificationReservation = {
  requestId: string;
  revision: number;
  requestedDate: string;
  startedAt: string;
  expiresAt: string;
};
export type SimulatorEngineeringVerificationObservation = SimulatorEngineeringVerificationReservation & {
  completedAt: string;
  outcome: "MATCH_FOUND" | "NO_MATCH" | "FETCH_FAILED" | "NEEDS_ADAPTER";
  complete: boolean;
  providerObservedAt: string | null;
  slotCount: number;
  failureCode: string | null;
};
export type SimulatorEngineeringVerificationState = {
  schemaVersion: 1;
  sourceFingerprint: string;
  runtimeVersion: string;
  deploymentId: string;
  startedAt: string;
  readsUsed: number;
  inFlight: SimulatorEngineeringVerificationReservation | null;
  observations: SimulatorEngineeringVerificationObservation[];
};

const date = (value: unknown): value is string => typeof value === "string" && value.length >= 20 && value.length <= 32 && Number.isFinite(Date.parse(value));
const boundedId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const day = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const reservationKeys = ["requestId", "revision", "requestedDate", "startedAt", "expiresAt"];
const observationKeys = [...reservationKeys, "completedAt", "outcome", "complete", "providerObservedAt", "slotCount", "failureCode"];
function exactKeys(value: object, keys: string[]) { return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)); }
function reservation(value: unknown, observation = false): value is SimulatorEngineeringVerificationReservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as SimulatorEngineeringVerificationReservation;
  return exactKeys(row, observation ? observationKeys : reservationKeys) && boundedId(row.requestId) && Number.isSafeInteger(row.revision) && row.revision > 0 && day(row.requestedDate) &&
    date(row.startedAt) && date(row.expiresAt) && Date.parse(row.expiresAt) > Date.parse(row.startedAt) &&
    Date.parse(row.expiresAt) - Date.parse(row.startedAt) <= SIMULATOR_ENGINEERING_VERIFICATION_LEASE_MS;
}

/** Malformed or unbounded legacy evidence is unknown, never a successful read. */
export function readSimulatorEngineeringVerificationState(value: unknown): SimulatorEngineeringVerificationState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const state = value as SimulatorEngineeringVerificationState;
  if (!exactKeys(state, ["schemaVersion", "sourceFingerprint", "runtimeVersion", "deploymentId", "startedAt", "readsUsed", "inFlight", "observations"]) ||
      state.schemaVersion !== 1 || !/^[a-f0-9]{64}$/u.test(state.sourceFingerprint) ||
      !/^[a-f0-9]{40}$/u.test(state.runtimeVersion) || !boundedId(state.deploymentId) || !date(state.startedAt) ||
      !Number.isSafeInteger(state.readsUsed) || state.readsUsed < 0 || state.readsUsed > SIMULATOR_ENGINEERING_VERIFICATION_MAX_READS ||
      !Array.isArray(state.observations) || state.observations.length > state.readsUsed ||
      state.inFlight !== null && !reservation(state.inFlight)) return undefined;
  const ids = new Set<string>();
  for (const row of state.observations) {
    if (!reservation(row, true) || !date(row.completedAt) || Date.parse(row.completedAt) < Date.parse(row.startedAt) ||
        !["MATCH_FOUND", "NO_MATCH", "FETCH_FAILED", "NEEDS_ADAPTER"].includes(row.outcome) ||
        typeof row.complete !== "boolean" || row.providerObservedAt !== null && !date(row.providerObservedAt) ||
        !Number.isSafeInteger(row.slotCount) || row.slotCount < 0 || row.slotCount > 65_536 ||
        row.failureCode !== null && !/^[A-Z_]{1,64}$/u.test(row.failureCode) || ids.has(row.requestId)) return undefined;
    ids.add(row.requestId);
  }
  if (state.inFlight && ids.has(state.inFlight.requestId) || state.observations.length + Number(Boolean(state.inFlight)) !== state.readsUsed) return undefined;
  return state;
}

export function assertSimulatorEngineeringRuntime(input: { runtimeVersion: string; deploymentId: string; deploymentUrl: string;
  environment: string; host: string }, proof: GitDeploymentProof, now: Date) {
  assertSimulatorSupportDeployment(proof, input.runtimeVersion, now);
  if (input.environment !== "production" || !["teetimespot.com", "www.teetimespot.com"].includes(input.host) ||
      input.deploymentId !== proof.deploymentId || input.deploymentUrl !== proof.deploymentUrl) {
    throw new Error("SIMULATOR_ENGINEERING_RUNTIME_NOT_CURRENT");
  }
}

/** Choose a venue-local date inside its known booking window, independently of any ended alert. */
export function deriveSimulatorEngineeringVerificationDate(now: Date, timeZone: string, offering: {
  bookingWindowDaysAhead: number | null; bookingReleaseTimeLocal: string | null; verifiedAt: Date | null; evidenceUrl: string | null;
}) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now).map(part => [part.type, part.value]));
  const next = new Date(`${parts.year}-${parts.month}-${parts.day}T12:00:00Z`);
  if (offering.bookingWindowDaysAhead !== 0) next.setUTCDate(next.getUTCDate() + 1);
  const requestedDate = next.toISOString().slice(0, 10);
  const opening = getSimulatorBookingOpening(requestedDate, offering, timeZone);
  if (opening && opening > now) throw new Error("SIMULATOR_ENGINEERING_BOOKING_NOT_OPEN");
  return requestedDate;
}

export function evaluateSimulatorEngineeringVerification(input: { now: Date; claim: SimulatorSupportClaim;
  sourceFingerprint: string; state: SimulatorEngineeringVerificationState }) {
  const { now, claim, state } = input;
  let releaseReady = false;
  try {
    if (claim.releaseSha && claim.deployment) {
      assertSimulatorSupportDeployment(claim.deployment, claim.releaseSha, now);
      releaseReady = state.runtimeVersion === claim.releaseSha && state.deploymentId === claim.deployment.deploymentId &&
        state.sourceFingerprint === claim.sourceFingerprint && state.sourceFingerprint === input.sourceFingerprint &&
        Date.parse(state.startedAt) >= Math.max(Date.parse(claim.claimedAt), Date.parse(claim.deployment.deployedAt)) &&
        Date.parse(state.startedAt) <= now.getTime();
    }
  } catch { /* A stale or unrelated release cannot establish monitoring. */ }
  const qualifies = (row: SimulatorEngineeringVerificationObservation) => releaseReady && row.complete === true &&
    ["MATCH_FOUND", "NO_MATCH"].includes(row.outcome) && row.failureCode === null &&
    (row.outcome === "MATCH_FOUND" ? row.slotCount > 0 : row.slotCount === 0) && row.providerObservedAt !== null &&
    Date.parse(row.providerObservedAt) >= Math.max(Date.parse(row.startedAt), Date.parse(state.startedAt), now.getTime() - 30 * 60_000) &&
    Date.parse(row.providerObservedAt) <= Date.parse(row.completedAt) && Date.parse(row.completedAt) <= now.getTime() &&
    Date.parse(row.completedAt) < Date.parse(row.expiresAt);
  const ids: string[] = [];
  const providerTimes = new Set<number>();
  let newerStartedAt = Infinity;
  for (const row of [...state.observations].reverse()) {
    if (!qualifies(row) || providerTimes.has(Date.parse(row.providerObservedAt!)) || Date.parse(row.completedAt) > newerStartedAt) break;
    providerTimes.add(Date.parse(row.providerObservedAt!));
    newerStartedAt = Date.parse(row.startedAt);
    ids.push(row.requestId);
  }
  const latest = state.observations.at(-1);
  const expiredReservation = Boolean(state.inFlight && Date.parse(state.inFlight.expiresAt) <= now.getTime());
  return { releaseReady, freshSuccessfulChecks: ids.length, firstCheckReady: Boolean(latest && qualifies(latest)),
    failedObservation: expiredReservation || Boolean(latest && !qualifies(latest)), inFlight: Boolean(state.inFlight) && !expiredReservation,
    expiredReservation, qualifyingObservationIds: ids,
    latestObservation: latest ?? null };
}
