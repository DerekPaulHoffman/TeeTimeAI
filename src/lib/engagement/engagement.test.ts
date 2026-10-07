import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  createWebsiteEvent,
  submitWebsiteFeedback,
  websiteEventInputSchema,
  websiteFeedbackInputSchema
} from "./engagement";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    websiteEvent: {
      create: vi.fn()
    },
    websiteFeedback: {
      create: vi.fn()
    }
  }
}));

const mockedPrisma = vi.mocked(prisma, { deep: true });

describe("websiteEventInputSchema", () => {
  it("accepts supported events while removing URL parameters", () => {
    const input = websiteEventInputSchema.parse({
      name: "start_search_clicked",
      page: "https://teetimespot.com/?email=golfer@example.com#start",
      metadata: {
        label: "Browse courses"
      }
    });

    expect(input).toEqual({
      name: "start_search_clicked",
      page: "/",
      trafficClass: "UNCLASSIFIED",
      metadata: {
        label: "Browse courses"
      }
    });
  });

  it("accepts optional mode on search funnel events without changing older payloads", () => {
    const metadataByName = {
      start_search_clicked: { label: "Find a simulator" },
      course_discovery_completed: { radiusMiles: 15, resultCount: 2, demo: false },
      course_discovery_failed: { radiusMiles: 15, stage: "GEOCODE" },
      course_selection_started: { selectedCourseCount: 1, players: 2 },
      alert_sign_in_clicked: { selectedCourseCount: 1, players: 2 },
      search_submitted: { selectedCourseCount: 1, players: 2 },
      search_submission_failed: { selectedCourseCount: 1, players: 2, responseStatus: 503 }
    } as const;

    for (const [name, metadata] of Object.entries(metadataByName)) {
      for (const mode of ["OUTDOOR", "SIMULATOR"] as const) {
        expect(websiteEventInputSchema.parse({ name, metadata: { ...metadata, mode } })).toMatchObject({
          name,
          metadata: { ...metadata, mode }
        });
      }
      expect(websiteEventInputSchema.parse({ name, metadata })).toMatchObject({
        name,
        metadata
      });
      expect(() => websiteEventInputSchema.parse({ name, metadata: { ...metadata, mode: "INVALID" } })).toThrow();
    }
  });

  it("rejects mode on unrelated click events and private identifiers in funnel metadata", () => {
    for (const name of ["dashboard_opened", "email_preview_opened"] as const) {
      expect(() => websiteEventInputSchema.parse({
        name,
        metadata: { label: "Open", mode: "SIMULATOR" }
      })).toThrow(/unrecognized/i);
    }

    expect(() => websiteEventInputSchema.parse({
      name: "search_submitted",
      metadata: { selectedCourseCount: 1, players: 2, mode: "SIMULATOR", courseId: "private" }
    })).toThrow(/unrecognized/i);
  });

  it("rejects unsupported event names", () => {
    expect(() =>
      websiteEventInputSchema.parse({
        name: "raw_click_everywhere",
        page: "/"
      })
    ).toThrow(/invalid/i);
  });

  it("accepts privacy-safe search submission failure context", () => {
    const input = websiteEventInputSchema.parse({
      name: "search_submission_failed",
      page: "/search",
      metadata: {
        responseStatus: 400,
        selectedCourseCount: 5,
        players: 2
      }
    });

    expect(input.name).toBe("search_submission_failed");
    expect("metadata" in input ? input.metadata : undefined).toEqual({
      responseStatus: 400,
      selectedCourseCount: 5,
      players: 2
    });
  });

  it("accepts aggregate selection and sign-in funnel milestones without course identity", () => {
    for (const name of ["course_selection_started", "alert_sign_in_clicked"] as const) {
      expect(
        websiteEventInputSchema.parse({
          name,
          page: "/search",
          trafficClass: "PUBLIC",
          metadata: {
            selectedCourseCount: name === "course_selection_started" ? 1 : 3,
            players: 4,
            requestedLayoutHoles: null
          }
        })
      ).toMatchObject({
        name,
        page: "/search",
        trafficClass: "PUBLIC"
      });
    }

    expect(() =>
      websiteEventInputSchema.parse({
        name: "course_selection_started",
        metadata: {
          selectedCourseCount: 1,
          players: 4,
          courseId: "must-not-be-stored"
        }
      })
    ).toThrow(/unrecognized/i);
  });

  it("accepts aggregate course-discovery outcomes without location data", () => {
    expect(
      websiteEventInputSchema.parse({
        name: "course_discovery_completed",
        page: "/search",
        metadata: {
          radiusMiles: 30,
          resultCount: 1,
          demo: false
        }
      })
    ).toMatchObject({
      name: "course_discovery_completed",
      metadata: {
        radiusMiles: 30,
        resultCount: 1,
        demo: false
      }
    });

    expect(() =>
      websiteEventInputSchema.parse({
        name: "course_discovery_failed",
        metadata: {
          radiusMiles: 15,
          stage: "GEOCODE",
          location: "58401"
        }
      })
    ).toThrow(/unrecognized/i);
  });

  it("rejects metadata fields that are not allowlisted for the event", () => {
    expect(() =>
      websiteEventInputSchema.parse({
        name: "search_submitted",
        metadata: {
          selectedCourseCount: 2,
          players: 4,
          searchId: "must-not-be-stored"
        }
      })
    ).toThrow(/unrecognized/i);
  });

  it("accepts only an aggregate discovery source and rejects raw referrer data", () => {
    expect(
      websiteEventInputSchema.parse({
        name: "page_viewed",
        page: "/guides",
        discoverySource: "AI_CHATGPT"
      })
    ).toEqual({
      name: "page_viewed",
      page: "/guides",
      discoverySource: "AI_CHATGPT",
      trafficClass: "UNCLASSIFIED"
    });

    expect(() =>
      websiteEventInputSchema.parse({
        name: "page_viewed",
        discoverySource: "AI_CHATGPT",
        referrer: "https://chatgpt.com/c/private-prompt"
      })
    ).toThrow(/unrecognized/i);
  });
});

describe("websiteFeedbackInputSchema", () => {
  it("normalizes feedback text, email, and page path", () => {
    const input = websiteFeedbackInputSchema.parse({
      sentiment: "broken",
      message: "  The course search button did not respond.  ",
      page: "https://teetimespot.com/?email=golfer@example.com#start",
      contactEmail: "GOLFER@example.com"
    });

    expect(input).toEqual({
      sentiment: "broken",
      message: "The course search button did not respond.",
      page: "/",
      trafficClass: "UNCLASSIFIED",
      contactEmail: "golfer@example.com"
    });
  });

  it("requires details when something is reported broken", () => {
    expect(() =>
      websiteFeedbackInputSchema.parse({
        sentiment: "broken",
        message: "",
        page: "/dashboard"
      })
    ).toThrow(/what broke/i);
  });
});

describe("engagement persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores only allowlisted website analytics fields", async () => {
    mockedPrisma.websiteEvent.create.mockResolvedValue({ id: "event-1" } as never);

    await createWebsiteEvent({
      name: "search_submitted",
      page: "/search?email=golfer@example.com",
      metadata: {
        selectedCourseCount: 3,
        players: 4
      }
    });

    expect(mockedPrisma.websiteEvent.create).toHaveBeenCalledWith({
      data: {
        name: "search_submitted",
        page: "/search",
        metadata: {
          selectedCourseCount: 3,
          players: 4
        },
        trafficClass: "UNCLASSIFIED"
      }
    });
  });

  it("stores an aggregate discovery label inside event metadata", async () => {
    mockedPrisma.websiteEvent.create.mockResolvedValue({ id: "event-source" } as never);

    await createWebsiteEvent({
      name: "page_viewed",
      page: "/guides/public-golf-booking-windows",
      discoverySource: "AI_PERPLEXITY"
    });

    expect(mockedPrisma.websiteEvent.create).toHaveBeenCalledWith({
      data: {
        name: "page_viewed",
        page: "/guides/public-golf-booking-windows",
        metadata: {
          discoverySource: "AI_PERPLEXITY"
        },
        trafficClass: "UNCLASSIFIED"
      }
    });
  });

  it("stores feedback with normalized message and optional contact email", async () => {
    mockedPrisma.websiteFeedback.create.mockResolvedValue({ id: "feedback-1" } as never);

    await submitWebsiteFeedback({
      sentiment: "like",
      message: "  Clean setup flow. ",
      page: "/",
      contactEmail: "PLAYER@example.com"
    });

    expect(mockedPrisma.websiteFeedback.create).toHaveBeenCalledWith({
      data: {
        sentiment: "LIKE",
        message: "Clean setup flow.",
        page: "/",
        contactEmail: "player@example.com",
        trafficClass: "UNCLASSIFIED"
      }
    });
  });
});
