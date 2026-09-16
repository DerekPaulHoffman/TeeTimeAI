import { describe, expect, it } from "vitest";
import {
  assessOperatorNotificationHealth,
  buildOperatorNotificationSummary,
  isEligibleOperatorNotificationSearch,
  type OperatorNotificationHealthSearch,
} from "./content";

const now = new Date("2026-09-16T16:05:00Z");
const healthy = (): OperatorNotificationHealthSearch => ({
  status: "ACTIVE",
  checkStatus: "WAITING",
  createdAt: new Date("2026-09-16T16:00:00Z"),
  lastCheckedAt: new Date("2026-09-16T16:04:00Z"),
  nextCheckAt: new Date("2026-09-16T16:09:00Z"),
  checkLeaseExpiresAt: null,
  alertGeneration: 0,
  statusEmailSnapshot: null,
  preferences: [
    { courseId: "one", course: { name: "First Course" } },
    { courseId: "two", course: { name: "Second Course" } },
  ],
  probes: ["one", "two"].map((courseId) => ({
    courseId,
    outcome: "NO_MATCH",
    observedAt: new Date("2026-09-16T16:04:00Z"),
    rawSummary: {
      providerExecution: "RUNNABLE_PROVIDER_CHECK",
      providerObservedAt: "2026-09-16T16:04:00.000Z",
    },
  })),
  emailDeliveries: [],
});

describe("operator notification eligibility", () => {
  const search = {
    trafficClass: "PUBLIC",
    syntheticMultiCycle: false,
    user: { email: "golfer@realmail.com" },
    alertEmail: "recipient@realmail.com",
  };
  it("uses the authenticated account, even when the chosen recipient differs", () => {
    expect(
      isEligibleOperatorNotificationSearch(search, ["owner@realmail.com"]),
    ).toBe(true);
    expect(
      isEligibleOperatorNotificationSearch(
        { ...search, user: { email: " OWNER+golf@realmail.com " } },
        ["owner@realmail.com"],
      ),
    ).toBe(false);
    expect(
      isEligibleOperatorNotificationSearch(
        { ...search, alertEmail: "owner@realmail.com" },
        ["owner@realmail.com"],
      ),
    ).toBe(true);
  });
  it.each(["TEST", "AUTOMATION"])(
    "excludes %s, including multi-cycle tests",
    (trafficClass) => {
      expect(
        isEligibleOperatorNotificationSearch(
          { ...search, trafficClass, syntheticMultiCycle: true },
          [],
        ),
      ).toBe(false);
    },
  );
  it("excludes synthetic windows, reserved addresses, and historical stress aliases", () => {
    expect(
      isEligibleOperatorNotificationSearch(
        { ...search, syntheticTestWindow: {} },
        [],
      ),
    ).toBe(false);
    for (const email of [
      "golfer@example.com",
      "robot@fake.test",
      "owner+tts-stress-20260714-1@gmail.com",
    ]) {
      expect(
        isEligibleOperatorNotificationSearch(
          { ...search, user: { email } },
          [],
        ),
      ).toBe(false);
    }
    expect(
      isEligibleOperatorNotificationSearch(
        { ...search, alertEmail: "sample@example.net" },
        [],
      ),
    ).toBe(false);
    expect(
      isEligibleOperatorNotificationSearch(
        { ...search, trafficClass: "UNCLASSIFIED" },
        [],
      ),
    ).toBe(true);
  });
});

describe("five-minute operator status", () => {
  it("always reports healthy checks, including no matching availability", () => {
    expect(assessOperatorNotificationHealth(healthy(), now)).toMatchObject({
      attention: false,
      text: expect.stringContaining("2/2"),
    });
  });
  it("uses the newest observation, rather than resurrecting old failures", () => {
    const search = healthy();
    search.probes.unshift({
      courseId: "one",
      outcome: "FETCH_FAILED",
      observedAt: new Date("2026-09-16T16:01:00Z"),
    });
    expect(assessOperatorNotificationHealth(search, now).attention).toBe(false);
    search.probes.push({
      courseId: "two",
      outcome: "FETCH_FAILED",
      observedAt: now,
    });
    expect(assessOperatorNotificationHealth(search, now).text).toContain(
      "Second Course: fetch failed",
    );
  });
  it("does not trust observations from before an alert edit", () => {
    const search = healthy();
    search.alertGeneration = 1;
    search.statusEmailSnapshot = {
      kind: "ALERT_GENERATION_START",
      schemaVersion: 1,
      alertGeneration: 1,
      generationStartedAt: now.toISOString(),
    };
    expect(assessOperatorNotificationHealth(search, now).text).toContain(
      "current monitoring needs verification",
    );
  });
  it.each(["PAUSED", "CANCELLED", "COMPLETED"])(
    "reports %s instead of raising an active-alert alarm",
    (status) => {
      expect(
        assessOperatorNotificationHealth({ ...healthy(), status }, now),
      ).toMatchObject({
        attention: false,
        text: expect.stringContaining(status.toLowerCase()),
      });
    },
  );
  it("reports a removed alert", () =>
    expect(assessOperatorNotificationHealth(null, now).text).toContain(
      "removed",
    ));
  it("flags missing checks, failed schedules and delivery retries", () => {
    const search = healthy();
    search.checkStatus = "FAILED";
    search.lastCheckedAt = null;
    search.emailDeliveries = [
      { status: "PENDING", attemptCount: 1, nextAttemptAt: now },
    ];
    expect(assessOperatorNotificationHealth(search, now).text).toMatch(
      /search check failed.*no completed check.*email delivery needs review/,
    );
  });
  it("does not call a past booking release healthy without current provider evidence", () => {
    const search = healthy();
    search.probes[0].rawSummary = {
      bookingWindow: {
        releaseDate: "2026-09-15",
        evidenceUrl: "https://course.example/booking",
      },
    };
    expect(assessOperatorNotificationHealth(search, now).attention).toBe(true);
  });
  it("treats a future booking-window wake as healthy", () => {
    const search = {
      ...healthy(),
      nextCheckAt: new Date("2026-09-20T12:00:00Z"),
    };
    search.probes[0].rawSummary = {
      bookingWindow: {
        releaseDate: "2026-09-20",
        evidenceUrl: "https://course.example/booking",
      },
    };
    expect(assessOperatorNotificationHealth(search, now).attention).toBe(false);
  });
  it("does not mistake layout skips, stale reader evidence, or a newer failure for working monitoring", () => {
    const layout = healthy();
    layout.requestedLayoutHoles = 18;
    layout.preferences[0].course.layoutHoleCounts = [9];
    expect(assessOperatorNotificationHealth(layout, now).text).toContain(
      "requested course layout unavailable",
    );
    const stale = healthy();
    stale.probes[0].rawSummary = {
      providerExecution: "LOCAL_BROWSER_READER",
      providerObservedAt: "2026-09-16T15:59:00.000Z",
    };
    expect(assessOperatorNotificationHealth(stale, now).attention).toBe(true);
    const failed = healthy();
    failed.preferences[0].course.monitoringStatus = { lastFailureAt: now };
    expect(assessOperatorNotificationHealth(failed, now).attention).toBe(true);
  });
  it("flags expired leases and missing or overdue wake times", () => {
    expect(
      assessOperatorNotificationHealth(
        { ...healthy(), checkStatus: "CHECKING", checkLeaseExpiresAt: now },
        now,
      ).text,
    ).toContain("stalled");
    expect(
      assessOperatorNotificationHealth({ ...healthy(), nextCheckAt: null }, now)
        .attention,
    ).toBe(true);
  });
  it("renders the account, ranked courses, date, local window and party size", () => {
    const summary = buildOperatorNotificationSummary({
      user: { email: "golfer@realmail.com" },
      date: new Date("2026-09-20T00:00:00Z"),
      startTime: "08:00",
      endTime: "10:00",
      players: 4,
      preferences: [
        { rank: 2, course: { name: "Second\nCourse" } },
        { rank: 1, course: { name: "First Course" } },
      ],
    });
    expect(summary).toBe(
      "golfer@realmail.com | 2026-09-20 08:00-10:00 (course local) | 4 players | First Course, Second Course",
    );
  });
});
