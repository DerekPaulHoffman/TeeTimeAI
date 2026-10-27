import { renderCustomerEmail } from "@/lib/email/customer-email";
import { CUSTOMER_EMAIL_STATES, getCustomerStatusCopy } from "@/lib/email/customer-status-copy";

export const emailPreviewStates = [
  { value: "mixed", label: "Full sample email" },
  ...CUSTOMER_EMAIL_STATES.map(value => ({ value, label: getCustomerStatusCopy(value).heading }))
];

/** Fixed samples only: no customer lookup, database write, or email transport. */
export function renderEmailStatePreview(value: string | undefined, simulator: boolean) {
  const state = CUSTOMER_EMAIL_STATES.find(option => option === value);
  if (!state) return null;
  const copy = getCustomerStatusCopy(state, {
    simulator,
    facts: state === "window" ? "Sample booking release: Wed, Nov 11 at 7:00 AM EST."
      : state === "outside" ? "The closest visible time is before your requested window."
      : undefined
  });
  const directIdentity = state === "invalid" || state === "identity";
  return renderCustomerEmail({
    mode: simulator ? "SIMULATOR" : undefined,
    variant: "setup",
    heading: simulator ? "Your simulator alert update" : "Your tee-time alert update",
    intro: "This is a sample update. Each venue has its own latest status and next step.",
    preheader: copy.heading,
    summary: { targetDate: "2026-11-14", startTime: "09:00", endTime: "14:00", players: 2, durationMinutes: 60 },
    availabilityCourses: [],
    monitoringCourses: [{
      courseName: simulator ? "Example Indoor Golf" : "Example Public Golf",
      courseAddress: "Maplewood, CT", rank: 1, state,
      facts: copy.detail, badgeLabel: copy.badgeLabel, detail: copy.detail, tone: copy.tone,
      bookingUrl: directIdentity ? undefined : "https://example.com/booking",
      bookingLinkLabel: "View official site"
    }],
    checkedAt: new Date("2026-11-10T12:00:00Z"),
    userTimeZone: "America/New_York",
    assetBaseUrl: "",
    showCadenceNote: false,
    stopUrls: { booked: "/alerts/stop?token=preview-booked", cancelled: "/alerts/stop?token=preview-cancelled" }
  });
}
