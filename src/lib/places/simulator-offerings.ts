import { createHash } from "node:crypto";

import { clearCourseMonitoringEvidence } from "@/lib/places/course-monitoring-evidence";
import type { CourseCandidate } from "@/lib/places/google";
import { prisma } from "@/lib/prisma";

export type SimulatorOfferingRecord = {
  id: string;
  courseId: string;
  active: boolean;
  publicAccessStatus: string;
  bookingUrl: string | null;
  evidenceUrl: string | null;
  verifiedAt: Date | null;
  updatedAt: Date;
  maxPartySize: number | null;
  supportedDurationsMinutes: number[];
  automationEligibility: string;
  monitoringState: string;
  monitoringVerifiedAt?: Date | null;
  observationToken?: string | null;
  lastFailureAt?: Date | null;
  course: {
    id: string;
    googlePlaceId: string | null;
    name: string;
    address: string | null;
    latitude: number;
    longitude: number;
    timeZone: string;
    website: string | null;
    phone: string | null;
  };
};

export type SimulatorOfferingIndex = {
  byPlaceId: ReadonlyMap<string, SimulatorOfferingRecord>;
  reviewVersion: string;
};

export function buildSimulatorOfferingIndex(rows: readonly SimulatorOfferingRecord[]): SimulatorOfferingIndex {
  // Monitoring heartbeats refresh independently on every cache read. Only rental
  // identity/capability facts should invalidate the expensive Places discovery.
  const versions = rows.map((row) => JSON.stringify([
    row.id, row.active, row.publicAccessStatus, row.bookingUrl, row.evidenceUrl, row.verifiedAt?.toISOString(),
    row.maxPartySize, [...row.supportedDurationsMinutes].sort((a, b) => a - b),
    row.course.googlePlaceId, row.course.name, row.course.address, row.course.latitude, row.course.longitude
  ])).sort();
  return {
    byPlaceId: new Map(rows.filter((row) => row.course.googlePlaceId).map((row) => [
      row.course.googlePlaceId as string, row
    ])),
    reviewVersion: versions.length ? createHash("sha256").update(versions.join("|")).digest("hex").slice(0, 24) : "none"
  };
}

export async function loadSimulatorOfferingIndex(): Promise<SimulatorOfferingIndex> {
  // Include inactive rows so disabling a rental also invalidates discovery caches.
  const rows = await prisma.courseOffering.findMany({
    where: { kind: "SIMULATOR" },
    select: {
      id: true, courseId: true, active: true, publicAccessStatus: true, bookingUrl: true, evidenceUrl: true,
      verifiedAt: true, updatedAt: true, maxPartySize: true, supportedDurationsMinutes: true,
      automationEligibility: true, monitoringState: true, monitoringVerifiedAt: true,
      observationToken: true, lastFailureAt: true,
      course: { select: {
      id: true, googlePlaceId: true, name: true, address: true,
      latitude: true, longitude: true, timeZone: true, website: true, phone: true
    } } }
  });
  return buildSimulatorOfferingIndex(rows);
}

export function hasVerifiedPublicSimulatorRental(offering: SimulatorOfferingRecord | undefined) {
  return Boolean(offering?.active && offering.publicAccessStatus === "PUBLIC" &&
    offering.verifiedAt && offering.verifiedAt.getTime() <= Date.now() && offering.evidenceUrl && offering.bookingUrl);
}

export function mapSimulatorCandidate(candidate: CourseCandidate, index: SimulatorOfferingIndex): CourseCandidate {
  const offering = index.byPlaceId.get(candidate.googlePlaceId);
  const result = clearCourseMonitoringEvidence(candidate);
  // Venue identity is shared. Outdoor inventory and its proof are never inherited.
  delete result.courseId;
  delete result.offeringId;
  delete result.par;
  delete result.parEvidenceUrl;
  delete result.parVerifiedAt;
  delete result.priceEstimate;
  delete result.bookableHoleCounts;
  delete result.bookableHoleCountsObservedAt;
  delete result.layoutHoleCounts;
  delete result.layoutHolesStatus;
  delete result.layoutHolesEvidenceUrl;
  delete result.layoutHolesVerifiedAt;
  delete result.supportedDurationsMinutes;
  delete result.maxPartySize;
  delete result.simulatorEvidenceUrl;
  delete result.simulatorVerifiedAt;
  const verified = hasVerifiedPublicSimulatorRental(offering);
  const now = Date.now();
  const checkedAt = offering?.monitoringVerifiedAt?.getTime();
  const ready = verified && offering?.automationEligibility === "ALLOWED" &&
    offering.monitoringState === "HEALTHY" && checkedAt !== undefined &&
    offering.observationToken == null &&
    (!offering.lastFailureAt || offering.lastFailureAt.getTime() < checkedAt) &&
    checkedAt <= now && now - checkedAt <= 30 * 60_000;
  const unavailable = offering?.automationEligibility === "BLOCKED" ||
    offering?.monitoringState === "FINAL_TECHNICAL" || offering?.monitoringState === "FINAL_IDENTITY";
  return {
    ...result,
    mode: "SIMULATOR",
    publicAccessStatus: verified ? "PUBLIC" : "UNVERIFIED",
    monitoringSupport: ready ? "AUTOMATIC" : unavailable ? "MANUAL_ONLY" : "UNCONFIRMED",
    monitoringReadiness: ready ? "READY" : unavailable ? "UNAVAILABLE" : "VERIFYING",
    ...(unavailable ? { alertSupport: "OFFICIAL_SITE_ONLY" as const } : {}),
    ...(offering?.active ? {
      courseId: offering.courseId,
      offeringId: offering.id,
      name: offering.course.name,
      ...(offering.bookingUrl ? { website: offering.bookingUrl } : {}),
      supportedDurationsMinutes: offering.supportedDurationsMinutes,
      ...(offering.maxPartySize ? { maxPartySize: offering.maxPartySize } : {}),
      ...(verified ? {
        simulatorEvidenceUrl: offering.evidenceUrl as string,
        simulatorVerifiedAt: (offering.verifiedAt as Date).toISOString()
      } : {}),
      ...(ready && offering.monitoringVerifiedAt ? {
        monitoringReadinessObservedAt: offering.monitoringVerifiedAt.toISOString()
      } : {})
    } : {})
  };
}

export function getPersistedSimulatorCandidates(index: SimulatorOfferingIndex): CourseCandidate[] {
  return [...index.byPlaceId.values()].filter((offering) => hasVerifiedPublicSimulatorRental(offering))
    .map((offering) => mapSimulatorCandidate({
      googlePlaceId: offering.course.googlePlaceId as string,
      name: offering.course.name,
      address: offering.course.address ?? undefined,
      latitude: offering.course.latitude,
      longitude: offering.course.longitude,
      timeZone: offering.course.timeZone,
      website: offering.course.website ?? undefined,
      phone: offering.course.phone ?? undefined
    }, index));
}
