import { describe, expect, it } from "vitest";

import {
  buildContentScopedEmailIdempotencyKey,
  getAutomationWorkerHealthIdempotencyKey,
  getRenderedTeeTimeAlertMatchIds,
  getMatchAlertSubject,
  getSearchStatusEmailSubject,
  normalizeEmailEnvValue,
  renderAlertHtml,
  renderAutomationWorkerHealthHtml,
  sendAutomationWorkerHealthEmail,
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

    expect(html).toContain("9:00 AM");
    expect(html).toContain("Sat 6:00 AM for you");
    expect(html).toContain("course local time");
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

    expect(html).toContain("9/18 holes");
  });

  it("shows the reusable course strip and Course Guide in instant alerts", () => {
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
          factLine:
            "Public · 4.1 rating (observed Jul 20, 2026) · 1.3 mi · 18H verified layout · $85–$98 last observed Jul 22, 2026",
          courseGuideUrl: "/courses/tashua-knolls-golf-course"
        }
      ]
    });

    expect(html).toContain("Public · 4.1 rating");
    expect(html).toContain("1.3 mi");
    expect(html).toContain("$85–$98 last observed Jul 22, 2026");
    expect(html).toContain(
      'href="https://teetimespot.com/courses/tashua-knolls-golf-course"'
    );
    expect(html).toContain("Course Guide");
  });

  it("keeps separate times and renders both stop-alert controls", () => {
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

  it("shows a dense tee sheet as bounded individual time pills", () => {
    const matches = Array.from({ length: 54 }, (_, index) => ({
      courseName: "Blue Rock Golf Course",
      courseTimeZone: "America/New_York",
      startsAt: new Date(Date.parse("2026-08-15T13:00:00.000Z") + index * 10 * 60 * 1000),
      availableSpots: 4,
      bookingUrl: "https://example.com/blue-rock",
      priceCents: 7200,
      holes: 18,
      isNew: index >= 12 && index < 20
    }));

    const html = renderAlertHtml({
      to: "player@example.com",
      searchId: "search-1",
      matches
    });

    expect(getMatchAlertSubject(matches)).toBe(
      "New tee time windows opened at Blue Rock Golf Course"
    );
    expect(html).not.toContain("9:00 AM EDT");
    expect(html.match(/6 time slots available/g)).toBeNull();
    expect(html.match(/>NEW<\/span>/g)).toHaveLength(8);
    expect(html).toContain("38 more tee times are available on the official booking page");
    expect(html).toContain("9:00 AM");
    expect(html).toContain("12:10 PM");
    expect(html).toContain("background:#eaf3ee");
    expect(html).toContain("border:1px solid #c8e6d2");
  });

  it("returns only the exact match IDs rendered within each course pill cap", () => {
    const matches = Array.from({ length: 17 }, (_, index) => ({
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
      matches.slice(0, 16).map((match) => match.matchId)
    );
  });

  it("keeps a later new opening when older times fill the pill cap", () => {
    const older = Array.from({ length: 16 }, (_, index) => ({
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
    expect(rendered).not.toContain("old-16");
  });
});

describe("email alert delivery helpers", () => {
  it("uses manual-review copy for human-only and mixed consolidated updates", () => {
    const humanCourse = {
      courseId: "human-course",
      courseName: "Course awaiting review",
      outcome: "NEEDS_ADAPTER" as const,
      availableMatches: 0,
      supportStatus: "NEEDS_HUMAN_REVIEW" as const,
      automationPlaybookExhausted: true
    };

    expect(
      getSearchStatusEmailSubject({
        kind: "status-update",
        courses: [humanCourse]
      })
    ).toBe("Manual review needed; your alert remains active");
    expect(
      getSearchStatusEmailSubject({
        kind: "status-update",
        courses: [
          {
            courseId: "final-course",
            courseName: "Phone booking course",
            outcome: "MANUAL_DIRECT",
            availableMatches: 0
          },
          humanCourse
        ]
      })
    ).toBe("Manual review needed; your alert remains active");
  });

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

  it("fails retryably for match and setup emails when production configuration is missing", async () => {
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

  it("dry-runs setup status reports for reserved recipients", async () => {
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

  it("enables idempotent monitoring transition status deliveries", async () => {
    await withMissingProductionEmailConfiguration(async () => {
      for (const kind of ["outage", "recovery", "status-update"] as const) {
        const result = await sendSearchStatusEmail({
          searchId: "search-1",
          to: "demo@teetimeai.local",
          kind,
          targetDate: "2026-08-12",
          startTime: "08:00",
          endTime: "11:00",
          players: 2,
          checkedAt: new Date("2026-08-10T14:30:00.000Z"),
          courses: [
            {
              courseId: "course-1",
              courseName: "Pine Oaks",
              outcome:
                kind === "outage"
                  ? "FETCH_FAILED"
                  : kind === "status-update"
                    ? "MANUAL_DIRECT"
                    : "NO_MATCH",
              availableMatches: 0,
              bookingUrl: "https://course.example/tee-times"
            }
          ],
          stableIdempotencyKey: `status-${kind}`
        });
        expect(result).toEqual({ id: "dry-run", deliveryStatus: "dry_run" });
      }
    });
  });

  it("returns not configured for worker health email without operator email env", async () => {
    await withMissingProductionEmailConfiguration(async () => {
      await expect(
        sendAutomationWorkerHealthEmail({
          workerKey: "course-support-responder",
          event: "overdue",
          expectedAt: new Date("2026-07-27T12:00:00.000Z"),
          observedAt: new Date("2026-07-27T12:10:00.000Z")
        })
      ).resolves.toEqual({ deliveryStatus: "not_configured" });
    });
  });

  it("uses stable episode-scoped worker health idempotency", () => {
    const input = {
      workerKey: "course-support-responder",
      event: "overdue" as const,
      expectedAt: new Date("2026-08-10T12:00:00.000Z"),
      observedAt: new Date("2026-08-10T12:21:00.000Z")
    };
    const key = getAutomationWorkerHealthIdempotencyKey(input);

    expect(
      getAutomationWorkerHealthIdempotencyKey({
        ...input,
        observedAt: new Date("2026-08-10T12:25:00.000Z")
      })
    ).toBe(key);
    expect(
      getAutomationWorkerHealthIdempotencyKey({
        ...input,
        event: "recovered"
      })
    ).not.toBe(key);
    expect(key).not.toContain(input.workerKey);
  });

  it("dry-runs worker health email only for a reserved operator recipient", async () => {
    const original = {
      resendApiKey: process.env.RESEND_API_KEY,
      alertEmailFrom: process.env.ALERT_EMAIL_FROM,
      operatorAlertEmail: process.env.OPERATOR_ALERT_EMAIL
    };
    process.env.RESEND_API_KEY = "re_test_placeholder";
    process.env.ALERT_EMAIL_FROM = "alerts@teetimespot.test";
    process.env.OPERATOR_ALERT_EMAIL = "operator@example.com";
    try {
      await expect(
        sendAutomationWorkerHealthEmail({
          workerKey: "course-support-responder",
          event: "overdue",
          expectedAt: new Date("2026-08-10T12:00:00.000Z"),
          observedAt: new Date("2026-08-10T12:21:00.000Z")
        })
      ).resolves.toEqual({ id: "dry-run", deliveryStatus: "dry_run" });
    } finally {
      restoreEnvironment("RESEND_API_KEY", original.resendApiKey);
      restoreEnvironment("ALERT_EMAIL_FROM", original.alertEmailFrom);
      restoreEnvironment("OPERATOR_ALERT_EMAIL", original.operatorAlertEmail);
    }
  });

  it("renders privacy-safe overdue and recovery operator messages", () => {
    const overdue = renderAutomationWorkerHealthHtml({
      workerKey: "reader-<primary>",
      event: "overdue",
      expectedAt: new Date("2026-08-10T12:00:00.000Z"),
      observedAt: new Date("2026-08-10T12:21:00.000Z")
    });
    const recovered = renderAutomationWorkerHealthHtml({
      workerKey: "course-support-responder",
      event: "recovered",
      expectedAt: new Date("2026-08-10T12:00:00.000Z"),
      observedAt: new Date("2026-08-10T12:22:00.000Z")
    });

    expect(overdue).toContain("21 minutes overdue");
    expect(overdue).toContain("reader-&lt;primary&gt;");
    expect(recovered).toContain("reported healthy activity again");
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
