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
  const label = windowEnded ? "Search window ended"
    : alertStatus === "PAUSED" ? "Notifications paused"
    : alertStatus !== "ACTIVE" ? "Checks stopped"
    : identityFinal ? "Public simulator rentals aren’t available here. Check the official site for options."
    : officialSiteOnly ? "Simulator alerts aren’t available here. Check the official site for rental options."
    : bookingNotOpen ? "The public booking window has not opened yet."
    : current && currentMatchCount > 0 ? "Matching simulator sessions available"
    : current && probe?.outcome === "NO_MATCH" ? "Checked · No matching sessions"
    : currentProbe && probe?.outcome === "NEEDS_ADAPTER" ? "Adding alert support"
    : (currentProbe && probe?.outcome === "FETCH_FAILED") || offering?.monitoringState === "DEGRADED_RETRYING"
      ? "Availability check will retry"
      : "Simulator check pending";
  const safeBookingUrl = getSafeCustomerBookingUrl(offering?.bookingUrl);
  return {
    label,
    officialUrl: safeBookingUrl ?? getSafeCustomerBookingUrl(website) ?? null,
    officialLinkLabel: verifiedRental && safeBookingUrl && !identityFinal && !officialSiteOnly ? "Official booking page" : "Official site",
  };
}
