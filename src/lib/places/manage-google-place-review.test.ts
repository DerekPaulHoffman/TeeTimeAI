import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";

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
    $disconnect: vi.fn()
  }
}));

const mockedPrisma = vi.mocked(prisma, { deep: true });

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
