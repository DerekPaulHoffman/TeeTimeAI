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
