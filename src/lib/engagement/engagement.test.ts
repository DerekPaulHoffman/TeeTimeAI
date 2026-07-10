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
  it("accepts supported first-party event names with useful context", () => {
    const input = websiteEventInputSchema.parse({
      name: "feedback_opened",
      page: "https://teetimespot.com/",
      metadata: {
        source: "floating-widget",
        variant: "footer"
      }
    });

    expect(input).toEqual({
      name: "feedback_opened",
      page: "https://teetimespot.com/",
      metadata: {
        source: "floating-widget",
        variant: "footer"
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
    expect(input.metadata).toEqual({
      responseStatus: 400,
      selectedCourseCount: 5,
      players: 2
    });
  });
});

describe("websiteFeedbackInputSchema", () => {
  it("normalizes feedback text and contact email", () => {
    const input = websiteFeedbackInputSchema.parse({
      sentiment: "broken",
      message: "  The course search button did not respond.  ",
      page: "https://teetimespot.com/#start",
      contactEmail: "GOLFER@example.com"
    });

    expect(input).toEqual({
      sentiment: "broken",
      message: "The course search button did not respond.",
      page: "https://teetimespot.com/#start",
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

  it("stores website analytics events without requiring personal data", async () => {
    mockedPrisma.websiteEvent.create.mockResolvedValue({ id: "event-1" } as never);

    await createWebsiteEvent({
      name: "search_submitted",
      page: "/",
      metadata: {
        selectedCourseCount: 3
      }
    });

    expect(mockedPrisma.websiteEvent.create).toHaveBeenCalledWith({
      data: {
        name: "search_submitted",
        page: "/",
        metadata: {
          selectedCourseCount: 3
        }
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
        contactEmail: "player@example.com"
      }
    });
  });
});
