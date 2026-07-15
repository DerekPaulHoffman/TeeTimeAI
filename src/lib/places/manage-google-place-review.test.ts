import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { resolveCourseSupportIncident } from "@/lib/automation/support-incidents";

import {
  executeGooglePlaceReviewCommand,
  parseGooglePlaceReviewCommand
} from "../../../scripts/automation/manage-google-place-review";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    googlePlaceReview: {
      upsert: vi.fn(),
      updateMany: vi.fn()
    },
    course: {
      findUnique: vi.fn(),
      update: vi.fn()
    },
    $disconnect: vi.fn()
  }
}));
vi.mock("@/lib/automation/support-incidents", () => ({
  resolveCourseSupportIncident: vi.fn()
}));

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedResolveCourseSupportIncident = vi.mocked(resolveCourseSupportIncident);

describe("Google Place review operator command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("parses a verified public review and normalizes its values", () => {
    const command = parseGooglePlaceReviewCommand([
      "upsert",
      "--place-id",
      "public-place",
      "--access-override",
      "VERIFIED_PUBLIC",
      "--name",
      "Public Golf Course",
      "--classification",
      "PUBLIC_GOLF_COURSE",
      "--evidence-url",
      "https://example.com/golf",
      "--reviewed-at",
      "2026-07-14",
      "--latitude",
      "41.25",
      "--longitude",
      "-73.05"
    ]);

    expect(command).toMatchObject({
      action: "upsert",
      apply: false,
      review: {
        googlePlaceId: "public-place",
        accessOverride: "VERIFIED_PUBLIC",
        evidenceUrl: "https://example.com/golf",
        latitude: 41.25,
        longitude: -73.05,
        active: true
      }
    });
  });

  it.each([
    {
      label: "non-http evidence URLs",
      args: baseArgs().with("--evidence-url", "ftp://example.com/golf")
    },
    {
      label: "invalid calendar dates",
      args: baseArgs().with("--reviewed-at", "2026-02-30")
    },
    {
      label: "unpaired coordinates",
      args: [...baseArgs(), "--latitude", "41"]
    },
    {
      label: "blank coordinates",
      args: [...baseArgs(), "--latitude", " ", "--longitude", " "]
    },
    {
      label: "verified public reviews without coordinates",
      args: [...baseArgs(), "--access-override", "VERIFIED_PUBLIC"]
    },
    {
      label: "alias retention without a canonical place",
      args: [...baseArgs(), "--retain-when-canonical-absent"]
    }
  ])("rejects $label", ({ args }) => {
    expect(() => parseGooglePlaceReviewCommand([...args])).toThrow();
  });

  it("is a dry run unless --apply is explicit", async () => {
    const command = parseGooglePlaceReviewCommand([...baseArgs()]);

    await expect(executeGooglePlaceReviewCommand(command)).resolves.toMatchObject({
      mode: "dry-run",
      action: "upsert"
    });
    expect(mockedPrisma.googlePlaceReview.upsert).not.toHaveBeenCalled();
  });

  it("applies a validated upsert", async () => {
    mockedPrisma.googlePlaceReview.upsert.mockResolvedValue({} as never);
    const command = parseGooglePlaceReviewCommand([...baseArgs(), "--apply"]);

    await expect(executeGooglePlaceReviewCommand(command)).resolves.toEqual({
      mode: "applied",
      action: "upsert",
      googlePlaceId: "place-1"
    });
    expect(mockedPrisma.googlePlaceReview.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { googlePlaceId: "place-1" },
        create: expect.objectContaining({ active: true })
      })
    );
  });

  it("reconciles a verified non-course review into persisted course and incident state", async () => {
    mockedPrisma.googlePlaceReview.upsert.mockResolvedValue({} as never);
    mockedPrisma.course.findUnique.mockResolvedValue({
      id: "harmony-course",
      name: "The Harmony Golf Club"
    } as never);
    mockedPrisma.course.update.mockResolvedValue({} as never);
    mockedResolveCourseSupportIncident.mockResolvedValue(null);
    const command = parseGooglePlaceReviewCommand([
      "upsert",
      "--place-id",
      "ChIJV_YX1RG11okRxSmNMNmBRrY",
      "--access-override",
      "VERIFIED_NON_COURSE",
      "--name",
      "The Harmony Golf Club",
      "--classification",
      "INDOOR_SIMULATOR",
      "--evidence-url",
      "https://theharmonygolfclub.com/",
      "--reviewed-at",
      "2026-07-15",
      "--apply"
    ]);

    await expect(executeGooglePlaceReviewCommand(command)).resolves.toEqual({
      mode: "applied",
      action: "upsert",
      googlePlaceId: "ChIJV_YX1RG11okRxSmNMNmBRrY",
      reconciledCourseIds: ["harmony-course"]
    });
    expect(mockedPrisma.course.update).toHaveBeenCalledWith({
      where: { id: "harmony-course" },
      data: expect.objectContaining({
        isPublic: false,
        automationEligibility: "BLOCKED",
        automationReason: "OTHER",
        intelligenceConfidence: 1
      })
    });
    expect(mockedResolveCourseSupportIncident).toHaveBeenCalledWith({
      courseId: "harmony-course",
      resolution: "DIRECT_BOOKING_CLASSIFIED",
      message: "The Harmony Golf Club was verified as a non-course listing (INDOOR_SIMULATOR)."
    });
  });

  it("reconciles a verified private review into persisted course and incident state", async () => {
    mockedPrisma.googlePlaceReview.upsert.mockResolvedValue({} as never);
    mockedPrisma.course.findUnique.mockResolvedValue({
      id: "approach-course",
      name: "The Approach presented by the Eiras Family"
    } as never);
    mockedPrisma.course.update.mockResolvedValue({} as never);
    mockedResolveCourseSupportIncident.mockResolvedValue(null);
    const command = parseGooglePlaceReviewCommand([
      "upsert",
      "--place-id",
      "ChIJAfI2SQDL5YgRBhnU_dStib0",
      "--access-override",
      "VERIFIED_PRIVATE",
      "--name",
      "The Approach presented by the Eiras Family",
      "--classification",
      "PRIVATE_MEMBER_AMENITY",
      "--evidence-url",
      "https://www.deerwoodclub.com/membership",
      "--reviewed-at",
      "2026-07-15",
      "--apply"
    ]);

    await expect(executeGooglePlaceReviewCommand(command)).resolves.toEqual({
      mode: "applied",
      action: "upsert",
      googlePlaceId: "ChIJAfI2SQDL5YgRBhnU_dStib0",
      reconciledCourseIds: ["approach-course"]
    });
    expect(mockedPrisma.course.update).toHaveBeenCalledWith({
      where: { id: "approach-course" },
      data: expect.objectContaining({
        isPublic: false,
        automationEligibility: "BLOCKED",
        automationReason: "OTHER",
        policyNotes:
          "Verified private course listing Google Place review: PRIVATE_MEMBER_AMENITY. Evidence: https://www.deerwoodclub.com/membership",
        intelligenceConfidence: 1
      })
    });
    expect(mockedResolveCourseSupportIncident).toHaveBeenCalledWith({
      courseId: "approach-course",
      resolution: "DIRECT_BOOKING_CLASSIFIED",
      message:
        "The Approach presented by the Eiras Family was verified as a private course listing (PRIVATE_MEMBER_AMENITY)."
    });
  });

  it("deactivates an existing review only when applied", async () => {
    mockedPrisma.googlePlaceReview.updateMany.mockResolvedValue({ count: 1 });
    const command = parseGooglePlaceReviewCommand([
      "upsert",
      "--place-id",
      "place-1",
      "--inactive",
      "--apply"
    ]);

    await expect(executeGooglePlaceReviewCommand(command)).resolves.toEqual({
      mode: "applied",
      action: "deactivate",
      googlePlaceId: "place-1"
    });
    expect(mockedPrisma.googlePlaceReview.updateMany).toHaveBeenCalledWith({
      where: { googlePlaceId: "place-1" },
      data: { active: false }
    });
  });
});

function baseArgs() {
  const args = [
    "upsert",
    "--place-id",
    "place-1",
    "--name",
    "Example Golf Course",
    "--classification",
    "PUBLIC_GOLF_COURSE",
    "--evidence-url",
    "https://example.com/golf",
    "--reviewed-at",
    "2026-07-14"
  ];

  return Object.assign(args, {
    with(option: string, value: string) {
      const copy = [...args];
      const optionIndex = copy.indexOf(option);
      copy[optionIndex + 1] = value;
      return copy;
    }
  });
}
