import { describe, expect, it } from "vitest";

import {
  buildContentScopedEmailIdempotencyKey,
  getRenderedTeeTimeAlertMatchIds,
  getMatchAlertSubject,
  normalizeEmailEnvValue,
  renderAlertHtml,
  renderCourseSupportOperatorHtml,
  renderCourseSupportOperatorSummaryHtml,
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

  it("shows all bookable hole counts in instant alerts", () => {
    const html = renderAlertHtml({
      to: "player@example.com",
      searchId: "search-1",
      matches: [
        {
          courseName: "Tashua Knolls Golf Course",
          courseTimeZone: "America/New_York",
          startsAt: new Date("2026-07-18T20:20:00.000Z"),
          availableSpots: 4,
          bookingUrl: "https://example.com/book",
          bookableHoleCounts: [9, 18]
        }
      ]
    });

    expect(html).toContain("9H/18H");
  });

  it("keeps separate hourly windows and renders both stop-alert controls", () => {
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
    expect(html).toContain("I booked &mdash; stop these results");
    expect(html).toContain("Cancel this alert");
  });

  it("summarizes a dense tee sheet into hourly windows with a bounded list", () => {
    const matches = Array.from({ length: 54 }, (_, index) => ({
      courseName: "Blue Rock Golf Course",
      courseTimeZone: "America/New_York",
      startsAt: new Date(Date.parse("2026-08-15T13:00:00.000Z") + index * 10 * 60 * 1000),
      availableSpots: 4,
      bookingUrl: "https://example.com/blue-rock",
      priceCents: 7200,
      holes: 18,
      isNew: index >= 12
    }));

    const html = renderAlertHtml({
      to: "player@example.com",
      searchId: "search-1",
      matches
    });

    expect(getMatchAlertSubject(matches)).toBe(
      "New tee time windows opened at Blue Rock Golf Course"
    );
    expect(html).not.toContain("9:00 AM EDT – 9:50 AM EDT");
    expect(html.match(/6 time slots available/g)).toBeNull();
    expect(html.match(/>NEW<\/span>/g)).toHaveLength(8);
    expect(html).toContain("36 more time windows are available on the official booking page");
    expect(html).toContain("12:00 PM EDT");
  });

  it("returns only the exact match IDs rendered within each course row cap", () => {
    const matches = Array.from({ length: 9 }, (_, index) => ({
      matchId: `match-${index + 1}`,
      courseId: "course-1",
      courseName: "Blue Rock Golf Course",
      courseTimeZone: "America/New_York",
      startsAt: new Date(Date.parse("2026-08-15T11:00:00.000Z") + index * 20 * 60 * 1000),
      availableSpots: 4,
      bookingUrl: "https://example.com/blue-rock",
      isNew: true
    }));

    expect(getRenderedTeeTimeAlertMatchIds(matches)).toEqual(
      matches.slice(0, 8).map((match) => match.matchId)
    );
  });

  it("keeps a later new opening when eight older hourly windows fill the row cap", () => {
    const older = Array.from({ length: 8 }, (_, index) => ({
      matchId: `old-${index + 1}`,
      courseId: "course-1",
      courseName: "Blue Rock Golf Course",
      courseTimeZone: "America/New_York",
      startsAt: new Date(Date.parse("2026-08-15T11:00:00.000Z") + index * 60 * 60 * 1000),
      availableSpots: 4,
      bookingUrl: "https://example.com/blue-rock",
      isNew: false
    }));
    const opening = {
      ...older[0],
      matchId: "new-opening",
      startsAt: new Date("2026-08-15T20:00:00.000Z"),
      isNew: true
    };

    const rendered = getRenderedTeeTimeAlertMatchIds([...older, opening]);

    expect(rendered).toContain("new-opening");
    expect(rendered).not.toContain("old-8");
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

describe("renderCourseSupportOperatorSummaryHtml", () => {
  it("groups concrete external blockers into one provider summary", () => {
    const html = renderCourseSupportOperatorSummaryHtml({
      incidents: [
        {
          incidentId: "incident-1",
          cycle: 1,
          courseId: "highlands",
          courseName: "Dennis Highlands",
          platform: "TEEITUP",
          bookingUrl: "https://dennis.book.teeitup.golf/",
          affectedSearchCount: 1,
          kind: "NEEDS_ADAPTER",
          firstSeenAt: new Date("2026-07-13T20:00:00.000Z")
        },
        {
          incidentId: "incident-2",
          cycle: 1,
          courseId: "pines",
          courseName: "Dennis Pines",
          platform: "TEEITUP",
          bookingUrl: "https://dennis.book.teeitup.golf/",
          affectedSearchCount: 1,
          kind: "NEEDS_ADAPTER",
          firstSeenAt: new Date("2026-07-13T20:00:00.000Z")
        }
      ]
    });

    expect(html).toContain("TEEITUP &middot; 2 courses");
    expect(html).toContain("Dennis Highlands");
    expect(html).toContain("Dennis Pines");
    expect(html).toContain("autonomous remediation run");
    expect(html).toContain("could not continue without the specific external action");
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
    await withMissingProductionEmailConfiguration(async () => {
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
  });

  it("fails retryably for real recipients when production email configuration is missing", async () => {
    await withMissingProductionEmailConfiguration(async () => {
      const expectedError = {
        name: "EmailDeliveryConfigurationError",
        code: "EMAIL_DELIVERY_NOT_CONFIGURED",
        retryable: true
      };

      await expect(
        sendTeeTimeAlert({
          to: "player@resend.dev",
          searchId: "search-1",
          matches: [
            {
              courseName: "Tashua Knolls",
              startsAt: new Date("2026-07-09T14:30:00.000Z"),
              availableSpots: 4,
              bookingUrl: "https://example.com/book"
            }
          ]
        })
      ).rejects.toMatchObject(expectedError);

      await expect(
        sendSearchStatusEmail({
          searchId: "search-1",
          to: "player@resend.dev",
          kind: "setup",
          targetDate: "2026-07-11",
          startTime: "07:30",
          endTime: "09:00",
          players: 1,
          checkedAt: new Date("2026-07-10T12:00:00.000Z"),
          courses: []
        })
      ).rejects.toMatchObject(expectedError);
    });
  });

  it("dry-runs setup status reports for reserved test recipients", async () => {
    await withMissingProductionEmailConfiguration(async () => {
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
});

async function withMissingProductionEmailConfiguration(worker: () => Promise<void>) {
  const original = {
    vercelEnvironment: process.env.VERCEL_ENV,
    resendApiKey: process.env.RESEND_API_KEY,
    alertEmailFrom: process.env.ALERT_EMAIL_FROM
  };
  process.env.VERCEL_ENV = "production";
  delete process.env.RESEND_API_KEY;
  delete process.env.ALERT_EMAIL_FROM;

  try {
    await worker();
  } finally {
    restoreEnvironment("VERCEL_ENV", original.vercelEnvironment);
    restoreEnvironment("RESEND_API_KEY", original.resendApiKey);
    restoreEnvironment("ALERT_EMAIL_FROM", original.alertEmailFrom);
  }
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
