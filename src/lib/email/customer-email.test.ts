import { describe, expect, it } from "vitest";

import { renderCustomerEmail, type CustomerEmailRenderInput, type CustomerEmailVariant } from "./customer-email";

const outdoorInput: Omit<CustomerEmailRenderInput, "variant"> = {
  heading: "Your Tee Time Spot alert", intro: "You book direct.", preheader: "Latest matching tee times.",
  summary: { targetDate: "2026-10-10", startTime: "08:00", endTime: "12:00", players: 4, requestedLayoutHoles: 18 },
  availabilityCourses: [{ courseName: "Example Public Golf", rank: 1,
    courseAddress: "1 Main St, Monroe, CT 06468, USA", courseTimeZone: "America/New_York",
    bookingUrl: "https://booking.example/public?day=2026-10-10", times: [
      { startsAt: new Date("2026-10-10T13:00:00Z"), availableSpots: 4, priceCents: 8500, holes: 18, bookableHoleCounts: [9, 18], isNew: true },
      { startsAt: new Date("2026-10-10T14:00:00Z"), availableSpots: 2, priceCents: 9500, holes: 18, isNew: false }
    ] }],
  monitoringCourses: [{ courseName: "Second Public Golf", rank: 2, badgeLabel: "MONITORING",
    detail: "We are checking for matching tee times.", tone: "monitored", bookingUrl: "https://booking.example/second" }],
  checkedAt: new Date("2026-10-06T16:00:00Z"), userTimeZone: "America/Los_Angeles",
  stopUrls: { booked: "https://teetimespot.com/alerts/stop?token=booked", cancelled: "https://teetimespot.com/alerts/stop?token=cancelled" },
  assetBaseUrl: "https://assets.example.com"
};

function simulatorInput(): CustomerEmailRenderInput {
  return {
    ...outdoorInput, mode: "SIMULATOR", variant: "instant", heading: "Simulator time opened",
    intro: "A session matches your alert. You book direct.", preheader: "A simulator session opened.",
    summary: { ...outdoorInput.summary, durationMinutes: 60 },
    availabilityCourses: [{ ...outdoorInput.availabilityCourses[0], courseName: "Example Indoor Golf",
      courseGuideUrl: "/courses/outdoor-guide", times: [{ ...outdoorInput.availabilityCourses[0].times[0],
        endsAt: new Date("2026-10-10T14:00:00Z") }] }],
    monitoringCourses: [{ ...outdoorInput.monitoringCourses![0], courseName: "Second Indoor Golf",
      detail: "We are checking for a complete session.", courseGuideUrl: "/courses/outdoor-guide" }]
  };
}

describe("shared customer email rendering", () => {
  it("does not label unclassified availability as previously shared or mutate caller ordering", () => {
    const input: CustomerEmailRenderInput = { ...outdoorInput, variant: "instant",
      availabilityCourses: [
        { ...outdoorInput.availabilityCourses[0], rank: 2, courseName: "Second course", times: [
          { startsAt: "2026-10-10T15:00:00Z", availableSpots: 4 }
        ] },
        { ...outdoorInput.availabilityCourses[0], rank: 1, courseName: "First course", times: [
          { startsAt: "2026-10-10T14:00:00Z", availableSpots: 4, isNew: true },
          { startsAt: "2026-10-10T13:00:00Z", availableSpots: 4, isNew: false }
        ] }
      ] };
    const before = structuredClone(input);
    const html = renderCustomerEmail(input);
    expect(input).toEqual(before);
    expect(html.indexOf("First course")).toBeLessThan(html.indexOf("Second course"));
    expect(html.indexOf("New since your last email")).toBeLessThan(html.indexOf("Still available · previously shared"));
    expect(html.slice(html.indexOf("Second course"))).toContain("Also available");
    expect(html.slice(html.indexOf("Second course"))).not.toContain("previously shared");
    expect(html.match(/data-new-match="true"/g)).toHaveLength(1);
  });

  it.each<CustomerEmailVariant>(["setup", "morning", "instant", "outage", "recovery"])(
    "renders the selected design and preserves bounded actions for %s", (variant) => {
      const html = renderCustomerEmail({ ...outdoorInput, variant });
      expect(html).toContain('class="email-card"');
      expect(html).not.toMatch(/PRIORITY|just opened/i);
      expect(html).toContain("New since your last email");
      expect(html).toContain("Still available · previously shared");
      expect(html).toContain('href="https://teetimespot.com/alerts/stop?token=booked"');
      expect(html).toContain('href="https://teetimespot.com/alerts/stop?token=cancelled"');
    }
  );

  it("shows the simulator search ending at midnight without calling it noon", () => {
    const input = simulatorInput();
    input.summary = { ...input.summary, startTime: "18:00", endTime: "24:00" };
    const html = renderCustomerEmail(input);
    expect(html).toContain("6:00 PM &ndash; Midnight venue local");
    expect(html).not.toContain("6:00 PM &ndash; 12:00 PM");
  });

  it("uses the existing branded shell, ranked cards, summary and stop controls for simulator sessions", () => {
    const html = renderCustomerEmail(simulatorInput());
    expect(html).toContain('class="email-card"');
    expect(html).toContain("Tee Time Spot");
    expect(html).toContain("#f4efe5");
    expect(html).toContain("#14231d");
    expect(html).toContain("#e28a2f");
    expect(html).toContain("NEW SIMULATOR ALERT");
    expect(html).not.toContain("PRIORITY");
    expect(html).toContain("indoor-golf-simulator-hero.webp");
    expect(html).toContain("SESSION");
    expect(html).toContain("60 minutes");
    expect(html).toContain("BOOKING");
    expect(html).toContain("One simulator bay");
    expect(html).toContain("Open official booking page");
    expect(html).toContain("What we're watching for you");
    expect(html).toContain("exact date, time window, and session length");
    expect(html).toContain("Check your dashboard for the latest status.");
    expect(html).not.toContain("morning status update per day");
    expect(html).toContain("venue local time");
    expect(html).toContain("I booked &mdash; stop these results");
    expect(html).toContain('href="https://teetimespot.com/alerts/stop?token=booked"');
    expect(html).toContain('href="https://teetimespot.com/alerts/stop?token=cancelled"');
    expect(html).toContain("Unsubscribe");
    expect(html).toContain("first come, first served");
    expect(html).not.toContain("GOLFERS");
    expect(html).not.toContain("COURSE LAYOUT");
    expect(html).not.toContain("player count");
    expect(html).not.toContain("9/18 holes");
    expect(html).not.toContain("$85");
    expect(html).not.toContain("Book this tee time");
    expect(html).not.toContain("Course Guide");
    expect(html).not.toContain("course-card-");
  });

  it("shows full venue-local and recipient-local ranges and does not repeat the recipient's zone when it matches", () => {
    const input = simulatorInput();
    const html = renderCustomerEmail(input);
    expect(html).toContain("9:00 AM – 10:00 AM EDT");
    expect(html).toContain("Sat 6:00 AM – 7:00 AM PDT for you");
    expect(renderCustomerEmail({ ...input, userTimeZone: "America/New_York" })).not.toContain("EDT for you");
  });

  it("keeps midnight and daylight-saving transitions legible in complete session ranges", () => {
    const input = simulatorInput();
    const renderRange = (startsAt: string, endsAt: string) => renderCustomerEmail({
      ...input, availabilityCourses: [{ ...input.availabilityCourses[0], times: [{ startsAt, endsAt, availableSpots: 1 }] }]
    });
    expect(renderRange("2026-10-11T03:30:00Z", "2026-10-11T04:30:00Z"))
      .toContain("Sat 11:30 PM – Sun 12:30 AM EDT");
    expect(renderRange("2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"))
      .toContain("1:30 AM EDT – 1:30 AM EST");
  });

  it("uses the requested session duration only when an endpoint is absent, and rejects invalid explicit endpoints", () => {
    const input = simulatorInput();
    const withoutEnd = { startsAt: "2026-10-10T09:00:00", availableSpots: 1 };
    expect(renderCustomerEmail({ ...input, summary: { ...input.summary, durationMinutes: 90 },
      availabilityCourses: [{ ...input.availabilityCourses[0], times: [withoutEnd] }] }))
      .toContain("9:00 AM – 10:30 AM EDT");
    expect(renderCustomerEmail({ ...input, summary: { ...input.summary, durationMinutes: 90 },
      availabilityCourses: [{ ...input.availabilityCourses[0], times: [{ ...withoutEnd, endsAt: null }] }] }))
      .toContain("9:00 AM – 10:30 AM EDT");
    for (const endsAt of ["invalid", "2026-10-10T09:00:00", "2026-10-10T08:00:00"]) {
      expect(renderCustomerEmail({ ...input, availabilityCourses: [{ ...input.availabilityCourses[0],
        times: [{ ...withoutEnd, endsAt }] }] })).not.toContain("AVAILABLE NOW");
    }
  });

  it("escapes simulator names and links and preserves cancel-only controls without a false booked action", () => {
    const input = simulatorInput();
    const html = renderCustomerEmail({ ...input,
      stopUrls: { cancelled: "https://teetimespot.com/alerts/stop?token=cancel&source=email" },
      availabilityCourses: [{ ...input.availabilityCourses[0], courseName: '<script>alert("x")</script>',
        bookingUrl: 'https://booking.example/public?q=<bad>&bay="A"' }] });
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("https://booking.example/public?q=&lt;bad&gt;&amp;bay=&quot;A&quot;");
    expect(html).toContain("token=cancel&amp;source=email");
    expect(html).toContain("Cancel this alert");
    expect(html).toContain("Unsubscribe");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("I booked");
  });

  it("uses session wording for results beyond the shared pill limit", () => {
    const input = simulatorInput();
    const html = renderCustomerEmail({ ...input, availabilityCourses: [{ ...input.availabilityCourses[0],
      times: Array.from({ length: 18 }, (_, index) => ({
        startsAt: new Date(Date.parse("2026-10-10T13:00:00Z") + index * 30 * 60_000),
        endsAt: new Date(Date.parse("2026-10-10T14:00:00Z") + index * 30 * 60_000), availableSpots: 1
      })) }] });
    expect(html).toContain("2 more session times are available on the official booking page");
    expect(html).not.toContain("more tee time");
  });
});
