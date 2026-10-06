import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";
import { getSimulatorOfferingSourceFingerprint } from "./source-fingerprint";

type Offering = Parameters<typeof getSimulatorOfferingSourceFingerprint>[0] & {
  automationEligibility: string;
  monitoringState: string;
  monitoringVerifiedAt: Date | null;
  lastFailureAt: Date | null;
  observationToken: string | null;
};

type Probe = { outcome: string; observedAt: Date; rawSummary: unknown };

export type SimulatorDashboardStatusKind = "ENDED" | "PAUSED" | "STOPPED" | "UNAVAILABLE" |
  "BOOKING_NOT_OPEN" | "AVAILABLE" | "NO_MATCH" | "ADDING_SUPPORT" | "RETRYING" | "PENDING";

/** The alert header shares the venue's verified state instead of inferring health from the search lifecycle. */
export function getSimulatorAlertSummary(statuses: { kind: SimulatorDashboardStatusKind; label: string }[]) {
  if (statuses.length === 1) return statuses[0].label;
  if (!statuses.length) return "Simulator checks pending";
  if (statuses.every(status => status.kind === "NO_MATCH")) return "Checked · No matching sessions";
  if (statuses.every(status => status.kind === "BOOKING_NOT_OPEN")) return "Public booking windows have not opened yet";
  if (statuses.some(status => status.kind === "UNAVAILABLE")) return "Some simulator alerts unavailable";
  if (statuses.some(status => status.kind === "ADDING_SUPPORT")) return "Adding simulator alert support";
  if (statuses.some(status => status.kind === "RETRYING")) return "Availability checks will retry";
  return "Simulator checks pending";
}

/** Probes passed here have already been scoped to the saved search's current generation. */
export function getSimulatorDashboardStatus(input: {
  offering: Offering | null;
  probe?: Probe;
  currentMatchCount: number;
  alertStatus: string;
  windowEnded: boolean;
  website: string | null;
  now?: Date;
}) {
  const { offering, probe, currentMatchCount, alertStatus, windowEnded, website } = input;
  const now = input.now ?? new Date();
  const summary = probe?.rawSummary && typeof probe.rawSummary === "object" && !Array.isArray(probe.rawSummary)
    ? probe.rawSummary as Record<string, unknown> : null;
  const verifiedRental = Boolean(offering?.kind === "SIMULATOR" && offering.active && offering.publicAccessStatus === "PUBLIC" &&
    offering.verifiedAt && offering.verifiedAt <= now && offering.evidenceUrl);
  const providerObservedAt = typeof summary?.providerObservedAt === "string" ? new Date(summary.providerObservedAt) : null;
  const current = verifiedRental && offering && offering.monitoringState === "HEALTHY" &&
    offering.automationEligibility === "ALLOWED" && offering.monitoringVerifiedAt && !offering.observationToken &&
    offering.monitoringVerifiedAt <= now && now.getTime() - offering.monitoringVerifiedAt.getTime() <= 30 * 60_000 &&
    (!offering.lastFailureAt || offering.lastFailureAt < offering.monitoringVerifiedAt) &&
    probe && ["MATCH_FOUND", "NO_MATCH"].includes(probe.outcome) && providerObservedAt && providerObservedAt <= now &&
    now.getTime() - providerObservedAt.getTime() <= 30 * 60_000 &&
    summary?.sourceFingerprint === getSimulatorOfferingSourceFingerprint(offering);
  const currentProbe = Boolean(probe && probe.observedAt <= now && summary?.mode === "SIMULATOR" &&
    offering && summary.sourceFingerprint === getSimulatorOfferingSourceFingerprint(offering));
  const identityFinal = offering && (!offering.active || ["NOT_PUBLIC", "MEMBERS_ONLY"].includes(offering.publicAccessStatus) ||
    offering.monitoringState === "FINAL_IDENTITY") || currentProbe && probe?.outcome === "IDENTITY_FINAL";
  const officialSiteOnly = offering && (offering.monitoringState === "FINAL_TECHNICAL" ||
    offering.automationEligibility === "BLOCKED") || currentProbe && probe?.outcome === "MANUAL_DIRECT";
  const opensAt = typeof summary?.opensAt === "string" ? new Date(summary.opensAt) : null;
  const bookingNotOpen = currentProbe && verifiedRental && summary?.bookingNotOpen === true && opensAt && opensAt > now;
  const kind: SimulatorDashboardStatusKind = windowEnded ? "ENDED"
    : alertStatus === "PAUSED" ? "PAUSED"
    : alertStatus !== "ACTIVE" ? "STOPPED"
    : identityFinal || officialSiteOnly ? "UNAVAILABLE"
    : bookingNotOpen ? "BOOKING_NOT_OPEN"
    : current && currentMatchCount > 0 ? "AVAILABLE"
    : current && probe?.outcome === "NO_MATCH" ? "NO_MATCH"
    : currentProbe && probe?.outcome === "NEEDS_ADAPTER" ? "ADDING_SUPPORT"
    : (currentProbe && probe?.outcome === "FETCH_FAILED") || offering?.monitoringState === "DEGRADED_RETRYING" ? "RETRYING"
    : "PENDING";
  const label = kind === "ENDED" ? "Search window ended"
    : kind === "PAUSED" ? "Notifications paused"
    : kind === "STOPPED" ? "Checks stopped"
    : kind === "UNAVAILABLE" && identityFinal ? "Public simulator rentals aren’t available here. Check the official site for options."
    : kind === "UNAVAILABLE" ? "Simulator alerts aren’t available here. Check the official site for rental options."
    : kind === "BOOKING_NOT_OPEN" ? "The public booking window has not opened yet."
    : kind === "AVAILABLE" ? "Matching simulator sessions available"
    : kind === "NO_MATCH" ? "Checked · No matching sessions"
    : kind === "ADDING_SUPPORT" ? "Adding alert support"
    : kind === "RETRYING" ? "Availability check will retry"
    : "Simulator check pending";
  const safeBookingUrl = getSafeCustomerBookingUrl(offering?.bookingUrl);
  return {
    kind,
    label,
    officialUrl: safeBookingUrl ?? getSafeCustomerBookingUrl(website) ?? null,
    officialLinkLabel: verifiedRental && safeBookingUrl && !identityFinal && !officialSiteOnly ? "Official booking page" : "Official site",
  };
}
