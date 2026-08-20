import { describe, expect, it } from "vitest";

import {
  buildCourseSupportResponderAlert,
  buildOperatorDiscoverySummary,
  buildTopCourses,
  countEvents,
  filterOperatorWorkIncidents
} from "./overview";

describe("operator overview aggregation", () => {
  it("ranks courses by real saved selections and counts distinct owners", () => {
    const date = new Date("2026-07-28T00:00:00.000Z");
    const result = buildTopCourses([
      preference({
        courseId: "course-a",
        courseName: "Alpha Municipal",
        searchId: "search-1",
        userId: "user-1",
        date
      }),
      preference({
        courseId: "course-a",
        courseName: "Alpha Municipal",
        searchId: "search-2",
        userId: "user-1",
        date: new Date("2026-07-27T00:00:00.000Z")
      }),
      preference({
        courseId: "course-b",
        courseName: "Beta Golf",
        searchId: "search-3",
        userId: "user-2",
        date,
        status: "PAUSED"
      })
    ]);

    expect(result[0]).toMatchObject({
      id: "course-a",
      selectionCount: 2,
      ownerCount: 1,
      activeAlertCount: 2,
      nearestRequestedDate: new Date("2026-07-27T00:00:00.000Z")
    });
    expect(result[1]).toMatchObject({
      id: "course-b",
      selectionCount: 1,
      ownerCount: 1,
      activeAlertCount: 0,
      nearestRequestedDate: null
    });
  });

  it("counts only recognized funnel events", () => {
    expect(
      countEvents([
        { name: "page_viewed" },
        { name: "page_viewed" },
        { name: "search_submitted" },
        { name: "unknown_event" }
      ])
    ).toMatchObject({
      page_viewed: 2,
      search_submitted: 1,
      course_discovery_completed: 0
    });
  });

  it("elevates an overdue responder while investigations are waiting", () => {
    expect(
      buildCourseSupportResponderAlert({
        now: new Date("2026-08-17T14:10:00.000Z"),
        openIncidentCount: 65,
        worker: {
          desiredState: "ACTIVE",
          monitoringStartedAt: new Date("2026-08-16T12:00:00.000Z"),
          nextExpectedAt: new Date("2026-08-17T14:04:00.000Z"),
          graceSeconds: 300
        }
      })
    ).toEqual({
      status: "OVERDUE",
      title: "Course investigations are stalled",
      detail:
        "65 open course investigations are waiting because the responder missed its expected run."
    });
  });

  it("does not show a stall warning for a current responder or an empty queue", () => {
    expect(
      buildCourseSupportResponderAlert({
        now: new Date("2026-08-17T14:05:00.000Z"),
        openIncidentCount: 65,
        worker: {
          desiredState: "ACTIVE",
          monitoringStartedAt: new Date("2026-08-17T14:00:00.000Z"),
          nextExpectedAt: new Date("2026-08-17T14:04:00.000Z"),
          graceSeconds: 300
        }
      })
    ).toBeNull();
    expect(
      buildCourseSupportResponderAlert({
        now: new Date("2026-08-17T14:10:00.000Z"),
        openIncidentCount: 0
      })
    ).toBeNull();
  });

  it("keeps repeated on-cadence scheduled failures visible until a successful run", () => {
    const worker = {
      desiredState: "ACTIVE",
      lastOutcome: "inspect_failed",
      monitoringStartedAt: new Date("2026-08-17T14:00:00.000Z"),
      nextExpectedAt: new Date("2026-08-17T14:30:00.000Z"),
      graceSeconds: 180
    };

    expect(
      buildCourseSupportResponderAlert({
        now: new Date("2026-08-17T14:16:00.000Z"),
        openIncidentCount: 65,
        worker
      })
    ).toEqual({
      status: "FAILED",
      title: "Course investigation responder failed",
      detail:
        "65 open course investigations are waiting after the latest scheduled responder run failed."
    });
    expect(
      buildCourseSupportResponderAlert({
        now: new Date("2026-08-17T14:31:00.000Z"),
        openIncidentCount: 65,
        worker: {
          ...worker,
          nextExpectedAt: new Date("2026-08-17T14:45:00.000Z")
        }
      })
    ).toMatchObject({ status: "FAILED" });
    expect(
      buildCourseSupportResponderAlert({
        now: new Date("2026-08-17T14:29:00.000Z"),
        openIncidentCount: 65,
        worker: {
          ...worker,
          lastOutcome: "inspect_completed"
        }
      })
    ).toBeNull();
  });

  it("excludes courses waiting for material change from responder work metrics", () => {
    const incidents = [
      { id: "incident-active", courseId: "course-active" },
      { id: "incident-waiting", courseId: "course-waiting" }
    ];

    expect(
      filterOperatorWorkIncidents(incidents, [
        { id: "course-active", priorityGroup: "WATCH" },
        { id: "course-waiting", priorityGroup: "PARKED" }
      ])
    ).toEqual([{ id: "incident-active", courseId: "course-active" }]);
  });

  it("reduces discovery evidence to structured operator facts without returning its URL", () => {
    const summary = buildOperatorDiscoverySummary({
      status: "VERIFIED",
      detectedPlatform: "CUSTOM",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "BLOCKED",
      automationReason: "ACCOUNT_REQUIRED",
      bookingAccessMode: "ACCOUNT_SELF_SERVICE",
      bookingUrl: "https://booking.example/sign-in",
      confidence: 0.98,
      evidence: {
        finalUrl: "https://booking.example/sign-in",
        learnedFrom: "official-booking-cta-account-access"
      },
      createdAt: new Date("2026-08-17T14:00:00.000Z")
    });

    expect(summary).toEqual({
      status: "VERIFIED",
      detectedPlatform: "CUSTOM",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "BLOCKED",
      automationReason: "ACCOUNT_REQUIRED",
      bookingAccessMode: "ACCOUNT_SELF_SERVICE",
      bookingCandidateRecorded: true,
      officialLinkCorroborated: true,
      providerLandingFound: true,
      confidence: 0.98,
      observedAt: new Date("2026-08-17T14:00:00.000Z")
    });
    expect(summary).not.toHaveProperty("bookingUrl");
  });

  it("does not treat a credential-bearing discovery URL as corroborated or reached", () => {
    const summary = buildOperatorDiscoverySummary({
      status: "INSPECTED",
      detectedPlatform: "TEEITUP",
      bookingMethod: "UNKNOWN",
      automationEligibility: "NEEDS_REVIEW",
      automationReason: "NONE",
      bookingAccessMode: "UNKNOWN",
      bookingUrl: "https://golfer:secret@booking.example/tee-times",
      confidence: 0.7,
      evidence: {
        learnedFrom: "teeitup-target-scope-unconfirmed"
      },
      createdAt: new Date("2026-08-17T14:00:00.000Z")
    });

    expect(summary).toMatchObject({
      bookingCandidateRecorded: true,
      officialLinkCorroborated: false,
      providerLandingFound: false
    });
  });

  it("does not describe text-only account guidance as an official booking link", () => {
    const summary = buildOperatorDiscoverySummary({
      status: "VERIFIED",
      detectedPlatform: "CUSTOM",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "BLOCKED",
      automationReason: "ACCOUNT_REQUIRED",
      bookingAccessMode: "ACCOUNT_SELF_SERVICE",
      bookingUrl: "https://course.example/",
      confidence: 0.9,
      evidence: {
        finalUrl: "https://course.example/",
        learnedFrom: "official-self-service-account-access"
      },
      createdAt: new Date("2026-08-17T14:00:00.000Z")
    });

    expect(summary).toMatchObject({
      bookingCandidateRecorded: true,
      officialLinkCorroborated: false,
      providerLandingFound: true
    });
  });

  it("keeps an uncorroborated inspected provider signal as a candidate only", () => {
    const summary = buildOperatorDiscoverySummary({
      status: "INSPECTED",
      detectedPlatform: "TEEITUP",
      bookingMethod: "UNKNOWN",
      automationEligibility: "NEEDS_REVIEW",
      automationReason: "NONE",
      bookingAccessMode: "UNKNOWN",
      bookingUrl: "https://course.example/tee-times",
      confidence: 0.45,
      evidence: {
        finalUrl: "https://course.example/tee-times",
        learnedFrom: "teeitup-target-scope-unconfirmed",
        courseIdentityCorroboration: {
          kind: "OFFICIAL_COURSE_PROVIDER_LINK",
          officialWebsiteUrl: "https://course.example/",
          officialPageUrl: "https://course.example/tee-times",
          providerUrl: "https://city.book.teeitup.com/?course=287"
        }
      },
      createdAt: new Date("2026-08-17T14:00:00.000Z")
    });

    expect(summary).toMatchObject({
      bookingCandidateRecorded: true,
      officialLinkCorroborated: false,
      providerLandingFound: false
    });
    expect(summary).not.toHaveProperty("evidence");
  });

  it("derives corroboration only when the official-page proof matches the saved provider URL", () => {
    const bookingUrl = "https://city.book.teeitup.com/?course=287";
    const summary = buildOperatorDiscoverySummary({
      status: "LEARNED",
      detectedPlatform: "TEEITUP",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      bookingAccessMode: "PUBLIC_SIGNED_OUT",
      bookingUrl,
      confidence: 0.95,
      evidence: {
        finalUrl: bookingUrl,
        learnedFrom: "teeitup-public-facility",
        courseIdentityCorroboration: {
          kind: "OFFICIAL_COURSE_PROVIDER_LINK",
          officialWebsiteUrl: "https://course.example/",
          officialPageUrl: "https://course.example/tee-times",
          providerUrl: bookingUrl
        }
      },
      createdAt: new Date("2026-08-17T14:00:00.000Z")
    });

    expect(summary).toMatchObject({
      bookingCandidateRecorded: true,
      officialLinkCorroborated: true,
      providerLandingFound: true
    });
  });

  it("shows a uniquely corroborated unknown-provider CTA as an official non-runnable link", () => {
    const bookingUrl = "https://booking.vendor.example/tee-times/12/34/0";
    const summary = buildOperatorDiscoverySummary({
      status: "INSPECTED",
      detectedPlatform: "CUSTOM",
      bookingMethod: "UNKNOWN",
      automationEligibility: "UNKNOWN",
      automationReason: "NONE",
      bookingAccessMode: "UNKNOWN",
      bookingUrl,
      confidence: 0.7,
      evidence: {
        learnedFrom: "official-course-non-runnable-booking-link",
        courseIdentityCorroboration: {
          kind: "OFFICIAL_COURSE_NON_RUNNABLE_BOOKING_LINK",
          officialWebsiteUrl: "https://course.example/",
          officialPageUrl: "https://course.example/course-name",
          providerUrl: bookingUrl
        }
      },
      createdAt: new Date("2026-08-20T14:00:00.000Z")
    });

    expect(summary).toMatchObject({
      bookingCandidateRecorded: true,
      officialLinkCorroborated: true,
      providerLandingFound: false
    });
    expect(summary).not.toHaveProperty("evidence");
  });

  it("preserves an absolute latest failed discovery instead of reviving older proof", () => {
    const summary = buildOperatorDiscoverySummary({
      status: "FAILED",
      detectedPlatform: "TEEITUP",
      bookingMethod: "UNKNOWN",
      automationEligibility: "NEEDS_REVIEW",
      automationReason: "NONE",
      bookingAccessMode: "UNKNOWN",
      bookingUrl: "https://city.book.teeitup.com/?course=287",
      confidence: 0,
      evidence: {
        learnedFrom: "official-site-fetch-failed",
        courseIdentityCorroboration: {
          kind: "OFFICIAL_COURSE_PROVIDER_LINK",
          officialWebsiteUrl: "https://course.example/",
          officialPageUrl: "https://course.example/tee-times",
          providerUrl: "https://city.book.teeitup.com/?course=287"
        }
      },
      createdAt: new Date("2026-08-17T14:05:00.000Z")
    });

    expect(summary).toMatchObject({
      status: "FAILED",
      bookingCandidateRecorded: false,
      officialLinkCorroborated: false,
      providerLandingFound: false,
      observedAt: new Date("2026-08-17T14:05:00.000Z")
    });
  });
});

function preference(input: {
  courseId: string;
  courseName: string;
  searchId: string;
  userId: string;
  date: Date;
  status?: string;
}) {
  return {
    courseId: input.courseId,
    teeSearch: {
      id: input.searchId,
      userId: input.userId,
      status: input.status ?? "ACTIVE",
      date: input.date
    },
    course: {
      id: input.courseId,
      name: input.courseName,
      providerFamilyKey: "FOREUP",
      supportIncident: null
    }
  };
}
