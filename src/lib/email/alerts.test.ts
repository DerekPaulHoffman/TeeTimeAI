import { describe, expect, it } from "vitest";

import {
  buildContentScopedEmailIdempotencyKey,
  normalizeEmailEnvValue,
  renderAlertHtml,
  renderCourseSupportOperatorHtml,
  sendSearchStatusEmail,
  sendTeeTimeAlert,
  shouldDryRunRecipient
} from "./alerts";

describe("renderAlertHtml", () => {
  it("shows course-local time and the recipient's time when the zones differ", () => {
    const html = renderAlertHtml({
      to: "player@example.com",
      searchId: "search-1",
      userTimeZone: "America/Los_Angeles",
      matches: [
        {
          courseName: "Tashua Knolls",
          courseTimeZone: "America/New_York",
          startsAt: new Date("2026-07-11T13:00:00.000Z"),
          availableSpots: 4,
          bookingUrl: "https://example.com/book"
        }
      ]
    });

    expect(html).toContain("9:00 AM EDT");
    expect(html).toContain("6:00 AM PDT for you");
    expect(html).toContain("course local time (America/New_York)");
  });

  it("escapes dynamic email fields", () => {
    const html = renderAlertHtml({
      to: "player@example.com",
      searchId: "search-1",
      matches: [
        {
          courseName: "<script>alert('x')</script>",
          startsAt: new Date("2026-07-09T14:30:00.000Z"),
          availableSpots: 4,
          bookingUrl: "https://example.com/book?x=<bad>"
        }
      ]
    });

    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(html).toContain("https://example.com/book?x=&lt;bad&gt;");
    expect(html).not.toContain("<script>");
  });

  it("keeps alerts limited to official first-come-first-served booking", () => {
    const html = renderAlertHtml({
      to: "player@example.com",
      searchId: "search-1",
      matches: [
        {
          courseName: "Tashua Knolls",
          startsAt: new Date("2026-07-09T14:30:00.000Z"),
          availableSpots: 4,
          bookingUrl: "https://example.com/book"
        }
      ]
    });

    expect(html).toContain("Book this tee time");
    expect(html).toContain("official booking page");
    expect(html).toMatch(/never books,\s+holds, or handles payment/);
    expect(html).toContain("first come");
  });

  it("lists every available time and renders both stop-alert controls", () => {
    const html = renderAlertHtml({
      to: "player@example.com",
      searchId: "search-1",
      matches: [
        {
          courseName: "Fairchild Wheeler Golf Course",
          startsAt: new Date("2026-07-11T07:40:00-04:00"),
          availableSpots: 4,
          bookingUrl: "https://example.com/fairchild",
          isNew: true
        },
        {
          courseName: "Fairchild Wheeler Golf Course",
          startsAt: new Date("2026-07-11T08:10:00-04:00"),
          availableSpots: 2,
          bookingUrl: "https://example.com/fairchild",
          isNew: false
        }
      ],
      stopUrls: {
        booked: "https://teetimespot.com/alerts/stop?token=booked",
        cancelled: "https://teetimespot.com/alerts/stop?token=cancelled"
      }
    });

    expect(html).toContain("7:40 AM");
    expect(html).toContain("8:10 AM");
    expect(html).toContain("4 spots");
    expect(html).toContain("2 spots");
    expect(html).toContain("I booked — stop these emails");
    expect(html).toContain("Cancel this alert");
  });
});

describe("renderCourseSupportOperatorHtml", () => {
  it("renders actionable incident evidence without exposing unsafe markup", () => {
    const html = renderCourseSupportOperatorHtml({
      event: "opened",
      incidentId: "incident-1",
      cycle: 1,
      courseId: "course-1",
      courseName: "Pequabuck <Golf Club>",
      platform: "CHRONOGOLF",
      bookingUrl: "https://www.chronogolf.com/club/3563",
      firstAffectedSearchId: "search-1",
      affectedSearchCount: 2,
      kind: "NEEDS_ADAPTER",
      message: "No supported adapter yet",
      nextAction: "Inspect the official public booking surface",
      firstSeenAt: new Date("2026-07-12T14:00:00.000Z")
    });

    expect(html).toContain("Pequabuck &lt;Golf Club&gt;");
    expect(html).toContain("Affected active searches when opened:</strong> 2");
    expect(html).toContain("Inspect the official public booking surface");
    expect(html).toContain("https://www.chronogolf.com/club/3563");
    expect(html).not.toContain("Pequabuck <Golf Club>");
  });
});

describe("email alert delivery helpers", () => {
  it("scopes Resend idempotency keys to the exact email content", () => {
    const email = {
      from: "alerts@teetimespot.com",
      to: "Player@ExampleGolf.com",
      subject: "A spot opened up",
      html: "<p>7:51 AM</p>"
    };
    const baseKey = "tee-time-match-batch-private-player@example.com";
    const key = buildContentScopedEmailIdempotencyKey(baseKey, email);

    expect(buildContentScopedEmailIdempotencyKey(baseKey, email)).toBe(key);
    expect(
      buildContentScopedEmailIdempotencyKey(baseKey, {
        ...email,
        html: "<p>8:01 AM</p>"
      })
    ).not.toBe(key);
    expect(key).not.toContain("Player");
    expect(key).not.toContain("example.com");
  });

  it("normalizes copied env values before they are used in Resend headers", () => {
    expect(normalizeEmailEnvValue("\uFEFFre_test_key\uFEFF\n")).toBe("re_test_key");
  });

  it("dry-runs reserved test recipients instead of calling Resend", () => {
    expect(shouldDryRunRecipient("demo@teetimeai.local")).toBe(true);
    expect(shouldDryRunRecipient("codex@example.com")).toBe(true);
    expect(shouldDryRunRecipient("player@example.invalid")).toBe(true);
    expect(shouldDryRunRecipient("player@resend.dev")).toBe(false);
  });

  it("returns a dry-run delivery result for local recipients", async () => {
    const result = await sendTeeTimeAlert({
      to: "demo@teetimeai.local",
      searchId: "search-1",
      matches: [
        {
          courseName: "Tashua Knolls",
          startsAt: new Date("2026-07-09T14:30:00.000Z"),
          availableSpots: 4,
          bookingUrl: "https://example.com/book"
        }
      ],
      idempotencyKey: "tee-time-match-test"
    });

    expect(result).toEqual({ id: "dry-run", deliveryStatus: "dry_run" });
  });

  it("dry-runs setup status reports for reserved test recipients", async () => {
    const result = await sendSearchStatusEmail({
      searchId: "search-1",
      to: "demo@teetimeai.local",
      kind: "setup",
      targetDate: "2026-07-11",
      startTime: "07:30",
      endTime: "09:00",
      players: 1,
      checkedAt: new Date("2026-07-10T12:00:00.000Z"),
      courses: [
        {
          courseId: "course-1",
          courseName: "Tashua Knolls",
          outcome: "NO_MATCH",
          availableMatches: 0,
          availability: { visibleSlotCount: 4, playerEligibleSlotCount: 4 }
        }
      ],
      idempotencyKey: "tee-search-status-test-setup"
    });

    expect(result).toEqual({ id: "dry-run", deliveryStatus: "dry_run" });
  });
});
