import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  invalidateReviewDerivedIdentityFinal,
  recordCourseMonitoringFinalClassification,
} from "@/lib/automation/course-monitoring";

import {
  executeGooglePlaceReviewCommand,
  parseGooglePlaceReviewCommand,
  runGooglePlaceReviewCli,
} from "../../../scripts/automation/manage-google-place-review";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    googlePlaceReview: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    course: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
    $disconnect: vi.fn(),
  },
}));
vi.mock("@/lib/automation/course-monitoring", () => ({
  invalidateReviewDerivedIdentityFinal: vi.fn(),
  recordCourseMonitoringFinalClassification: vi.fn(),
}));

const mockedPrisma = vi.mocked(prisma, { deep: true });
const mockedRecordCourseMonitoringFinalClassification = vi.mocked(
  recordCourseMonitoringFinalClassification,
);
const mockedInvalidateReviewDerivedIdentityFinal = vi.mocked(
  invalidateReviewDerivedIdentityFinal,
);

describe("Google Place review operator command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(
      (async (
        operation: (transaction: typeof prisma) => Promise<unknown>,
      ) => operation(prisma)) as never,
    );
    mockedPrisma.googlePlaceReview.findUnique.mockResolvedValue(null);
    mockedPrisma.googlePlaceReview.create.mockResolvedValue({} as never);
    mockedPrisma.googlePlaceReview.updateMany.mockResolvedValue({ count: 1 });
    mockedInvalidateReviewDerivedIdentityFinal.mockImplementation(
      async (input) => {
        await input.onReviewAccepted(prisma as never);
        return {
          reviewAccepted: true,
          finalInvalidated: true,
          reason: "automatic_revalidation_queued",
          searchesQueued: 1,
        } as never;
      },
    );
  });

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
      "-73.05",
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
        active: true,
      },
    });
  });

  it.each([
    {
      label: "non-http evidence URLs",
      args: baseArgs().with("--evidence-url", "ftp://example.com/golf"),
    },
    {
      label: "invalid calendar dates",
      args: baseArgs().with("--reviewed-at", "2026-02-30"),
    },
    {
      label: "unpaired coordinates",
      args: [...baseArgs(), "--latitude", "41"],
    },
    {
      label: "blank coordinates",
      args: [...baseArgs(), "--latitude", " ", "--longitude", " "],
    },
    {
      label: "verified public reviews without coordinates",
      args: [...baseArgs(), "--access-override", "VERIFIED_PUBLIC"],
    },
    {
      label: "alias retention without a canonical place",
      args: [...baseArgs(), "--retain-when-canonical-absent"],
    },
  ])("rejects $label", ({ args }) => {
    expect(() => parseGooglePlaceReviewCommand([...args])).toThrow();
  });

  it("is a dry run unless --apply is explicit", async () => {
    const command = parseGooglePlaceReviewCommand([...baseArgs()]);

    await expect(
      executeGooglePlaceReviewCommand(command),
    ).resolves.toMatchObject({
      mode: "dry-run",
      action: "upsert",
    });
    expect(mockedPrisma.googlePlaceReview.create).not.toHaveBeenCalled();
    expect(mockedPrisma.googlePlaceReview.updateMany).not.toHaveBeenCalled();
  });

  it("applies a validated upsert", async () => {
    const command = parseGooglePlaceReviewCommand([...baseArgs(), "--apply"]);

    await expect(executeGooglePlaceReviewCommand(command)).resolves.toEqual({
      mode: "applied",
      action: "upsert",
      googlePlaceId: "place-1",
    });
    expect(mockedPrisma.$transaction).toHaveBeenCalledOnce();
    expect(mockedPrisma.googlePlaceReview.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        googlePlaceId: "place-1",
        active: true,
      }),
    });
  });

  it("reconciles a verified non-course review into persisted course and incident state", async () => {
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        id: "harmony-course",
        name: "The Harmony Golf Club",
      } as never)
      .mockResolvedValueOnce({
        googlePlaceId: "ChIJV_YX1RG11okRxSmNMNmBRrY",
      } as never);
    mockAcceptedFinalClassification();
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
      "--apply",
    ]);

    await expect(executeGooglePlaceReviewCommand(command)).resolves.toEqual({
      mode: "applied",
      action: "upsert",
      googlePlaceId: "ChIJV_YX1RG11okRxSmNMNmBRrY",
      reconciledCourseIds: ["harmony-course"],
    });
    expect(mockedPrisma.course.update).not.toHaveBeenCalled();
    expect(
      mockedRecordCourseMonitoringFinalClassification,
    ).toHaveBeenCalledWith({
      courseId: "harmony-course",
      state: "FINAL_IDENTITY",
      outcome: "IDENTITY_FINAL",
      evidence: {
        kind: "COURSE_INTELLIGENCE",
        observedAt: new Date("2026-07-15T00:00:00.000Z"),
      },
      source: "MAINTENANCE",
      message:
        "The Harmony Golf Club was verified as a non-course listing (INDOOR_SIMULATOR).",
      evidenceUrl: "https://theharmonygolfclub.com/",
      courseIntelligenceUpdate: {
        isPublic: false,
        automationEligibility: "BLOCKED",
        automationReason: "OTHER",
        policyNotes:
          "Verified non-course listing Google Place review: INDOOR_SIMULATOR. Evidence: https://theharmonygolfclub.com/",
        intelligenceVerifiedAt: new Date("2026-07-15T00:00:00.000Z"),
        intelligenceConfidence: 1,
      },
      onSourceAccepted: expect.any(Function),
    });
    expect(mockedPrisma.googlePlaceReview.create).toHaveBeenCalledOnce();
    expect(mockedPrisma.googlePlaceReview.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        googlePlaceId: "ChIJV_YX1RG11okRxSmNMNmBRrY",
        accessOverride: "VERIFIED_NON_COURSE",
        classification: "INDOOR_SIMULATOR",
        reviewedAt: new Date("2026-07-15T00:00:00.000Z"),
      }),
    });
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("reconciles a verified private review into persisted course and incident state", async () => {
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        id: "approach-course",
        name: "The Approach presented by the Eiras Family",
      } as never)
      .mockResolvedValueOnce({
        googlePlaceId: "ChIJAfI2SQDL5YgRBhnU_dStib0",
      } as never);
    mockAcceptedFinalClassification();
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
      "--apply",
    ]);

    await expect(executeGooglePlaceReviewCommand(command)).resolves.toEqual({
      mode: "applied",
      action: "upsert",
      googlePlaceId: "ChIJAfI2SQDL5YgRBhnU_dStib0",
      reconciledCourseIds: ["approach-course"],
    });
    expect(mockedPrisma.course.update).not.toHaveBeenCalled();
    expect(
      mockedRecordCourseMonitoringFinalClassification,
    ).toHaveBeenCalledWith({
      courseId: "approach-course",
      state: "FINAL_IDENTITY",
      outcome: "IDENTITY_FINAL",
      evidence: {
        kind: "COURSE_INTELLIGENCE",
        observedAt: new Date("2026-07-15T00:00:00.000Z"),
      },
      source: "MAINTENANCE",
      message:
        "The Approach presented by the Eiras Family was verified as a private course listing (PRIVATE_MEMBER_AMENITY).",
      evidenceUrl: "https://www.deerwoodclub.com/membership",
      courseIntelligenceUpdate: {
        isPublic: false,
        automationEligibility: "BLOCKED",
        automationReason: "OTHER",
        policyNotes:
          "Verified private course listing Google Place review: PRIVATE_MEMBER_AMENITY. Evidence: https://www.deerwoodclub.com/membership",
        intelligenceVerifiedAt: new Date("2026-07-15T00:00:00.000Z"),
        intelligenceConfidence: 1,
      },
      onSourceAccepted: expect.any(Function),
    });
    expect(mockedPrisma.googlePlaceReview.create).toHaveBeenCalledOnce();
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("rolls back the review write and reports not reconciled when newer course evidence rejects the final", async () => {
    mockedPrisma.course.findUnique.mockResolvedValue({
      id: "course-with-newer-evidence",
      name: "Reviewed Course",
    } as never);
    mockedRecordCourseMonitoringFinalClassification.mockResolvedValue({
      sourceEvidenceAccepted: false,
    } as never);
    const command = parseGooglePlaceReviewCommand([
      "upsert",
      "--place-id",
      "reviewed-place",
      "--access-override",
      "VERIFIED_PRIVATE",
      "--name",
      "Reviewed Course",
      "--classification",
      "PRIVATE_MEMBERSHIP",
      "--evidence-url",
      "https://example.com/membership",
      "--reviewed-at",
      "2026-07-15",
      "--apply",
    ]);

    await expect(executeGooglePlaceReviewCommand(command)).resolves.toEqual({
      mode: "not-reconciled",
      action: "upsert",
      googlePlaceId: "reviewed-place",
      reason: "course_final_source_rejected",
    });
    expect(mockedPrisma.course.update).not.toHaveBeenCalled();
    expect(mockedPrisma.googlePlaceReview.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.googlePlaceReview.create).not.toHaveBeenCalled();
    expect(mockedPrisma.googlePlaceReview.updateMany).not.toHaveBeenCalled();
  });

  it("rejects the accepted final atomically when the course no longer maps to the reviewed place", async () => {
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        id: "remapped-course",
        name: "Remapped Course",
      } as never)
      .mockResolvedValueOnce({ googlePlaceId: "replacement-place" } as never);
    mockAcceptedFinalClassification();
    const command = privateReviewCommand();

    await expect(executeGooglePlaceReviewCommand(command)).resolves.toEqual({
      mode: "not-reconciled",
      action: "upsert",
      googlePlaceId: "reviewed-place",
      reason: "course_mapping_changed",
    });
    expect(mockedPrisma.googlePlaceReview.findUnique).not.toHaveBeenCalled();
    expect(mockedPrisma.googlePlaceReview.create).not.toHaveBeenCalled();
    expect(mockedPrisma.googlePlaceReview.updateMany).not.toHaveBeenCalled();
  });

  it("rejects the accepted final atomically when a newer review already exists", async () => {
    mockMappedCourseForPrivateReview();
    mockedPrisma.googlePlaceReview.findUnique.mockResolvedValue(
      persistedReview({
        reviewedAt: new Date("2026-07-16T00:00:00.000Z"),
        updatedAt: new Date("2026-07-16T01:00:00.000Z"),
      }) as never,
    );
    mockAcceptedFinalClassification();

    await expect(
      executeGooglePlaceReviewCommand(privateReviewCommand()),
    ).resolves.toEqual({
      mode: "not-reconciled",
      action: "upsert",
      googlePlaceId: "reviewed-place",
      reason: "review_version_conflict",
    });
    expect(mockedPrisma.googlePlaceReview.create).not.toHaveBeenCalled();
    expect(mockedPrisma.googlePlaceReview.updateMany).not.toHaveBeenCalled();
  });

  it("rejects the whole final when a public or deactivate write changes the exact review snapshot before update", async () => {
    mockMappedCourseForPrivateReview();
    const existing = persistedReview({
      reviewedAt: new Date("2026-07-14T00:00:00.000Z"),
      updatedAt: new Date("2026-07-14T01:00:00.000Z"),
    });
    mockedPrisma.googlePlaceReview.findUnique.mockResolvedValue(
      existing as never,
    );
    mockedPrisma.googlePlaceReview.updateMany.mockResolvedValue({ count: 0 });
    mockAcceptedFinalClassification();

    await expect(
      executeGooglePlaceReviewCommand(privateReviewCommand()),
    ).resolves.toEqual({
      mode: "not-reconciled",
      action: "upsert",
      googlePlaceId: "reviewed-place",
      reason: "review_version_conflict",
    });
    expect(mockedPrisma.googlePlaceReview.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: existing.id,
        googlePlaceId: existing.googlePlaceId,
        accessOverride: "VERIFIED_PUBLIC",
        active: true,
        reviewedAt: existing.reviewedAt,
        updatedAt: existing.updatedAt,
      }),
      data: expect.objectContaining({
        accessOverride: "VERIFIED_PRIVATE",
        reviewedAt: new Date("2026-07-15T00:00:00.000Z"),
      }),
    });
    expect(mockedPrisma.googlePlaceReview.create).not.toHaveBeenCalled();
  });

  it("atomically advances an older exact review version with the accepted final", async () => {
    mockMappedCourseForPrivateReview();
    const existing = persistedReview({
      reviewedAt: new Date("2026-07-14T00:00:00.000Z"),
      updatedAt: new Date("2026-07-14T01:00:00.000Z"),
    });
    mockedPrisma.googlePlaceReview.findUnique.mockResolvedValue(
      existing as never,
    );
    mockAcceptedFinalClassification();

    await expect(
      executeGooglePlaceReviewCommand(privateReviewCommand()),
    ).resolves.toEqual({
      mode: "applied",
      action: "upsert",
      googlePlaceId: "reviewed-place",
      reconciledCourseIds: ["reviewed-course"],
    });
    expect(mockedPrisma.googlePlaceReview.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: existing.id,
        reviewedAt: existing.reviewedAt,
        updatedAt: existing.updatedAt,
      }),
      data: expect.objectContaining({
        accessOverride: "VERIFIED_PRIVATE",
        classification: "PRIVATE_MEMBERSHIP",
        reviewedAt: new Date("2026-07-15T00:00:00.000Z"),
      }),
    });
  });

  it("deactivates an existing review only when applied", async () => {
    const existing = persistedReview({
      googlePlaceId: "place-1",
      active: true,
      accessOverride: "VERIFIED_PUBLIC",
    });
    mockedPrisma.googlePlaceReview.findUnique.mockResolvedValue(
      existing as never,
    );
    mockedPrisma.googlePlaceReview.updateMany.mockResolvedValue({ count: 1 });
    const command = parseGooglePlaceReviewCommand([
      "upsert",
      "--place-id",
      "place-1",
      "--inactive",
      "--apply",
    ]);

    await expect(executeGooglePlaceReviewCommand(command)).resolves.toEqual({
      mode: "applied",
      action: "deactivate",
      googlePlaceId: "place-1",
    });
    expect(mockedPrisma.googlePlaceReview.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: existing.id,
        googlePlaceId: "place-1",
        updatedAt: existing.updatedAt,
      }),
      data: { active: false },
    });
  });

  it("atomically invalidates an exact review-derived identity final when a newer verified-public review is accepted", async () => {
    const existing = persistedReview({
      accessOverride: "VERIFIED_PRIVATE",
      classification: "PRIVATE_MEMBERSHIP",
      evidenceUrl: "https://example.com/membership",
      reviewedAt: new Date("2026-07-14T00:00:00.000Z"),
    });
    mockedPrisma.googlePlaceReview.findUnique
      .mockResolvedValueOnce(existing as never)
      .mockResolvedValueOnce(existing as never);
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({ id: "reviewed-course" } as never)
      .mockResolvedValueOnce({ googlePlaceId: "reviewed-place" } as never);

    await expect(
      executeGooglePlaceReviewCommand(publicReviewCommand()),
    ).resolves.toEqual({
      mode: "applied",
      action: "upsert",
      googlePlaceId: "reviewed-place",
      reconciledCourseIds: ["reviewed-course"],
    });
    expect(mockedInvalidateReviewDerivedIdentityFinal).toHaveBeenCalledWith({
      courseId: "reviewed-course",
      expectedReview: {
        observedAt: existing.reviewedAt,
        policyNotes:
          "Verified private course listing Google Place review: PRIVATE_MEMBERSHIP. Evidence: https://example.com/membership",
      },
      correction: {
        kind: "VERIFIED_PUBLIC",
        observedAt: new Date("2026-07-15T00:00:00.000Z"),
        policyNotes:
          "Verified public course listing Google Place review: PUBLIC_GOLF_COURSE. Evidence: https://example.com/public",
      },
      onReviewAccepted: expect.any(Function),
    });
    expect(mockedPrisma.googlePlaceReview.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: existing.id,
        reviewedAt: existing.reviewedAt,
        updatedAt: existing.updatedAt,
      }),
      data: expect.objectContaining({
        accessOverride: "VERIFIED_PUBLIC",
        reviewedAt: new Date("2026-07-15T00:00:00.000Z"),
      }),
    });
  });

  it("atomically invalidates an exact review-derived identity final when its review is deactivated", async () => {
    const existing = persistedReview({
      googlePlaceId: "reviewed-place",
      accessOverride: "VERIFIED_NON_COURSE",
      classification: "INDOOR_SIMULATOR",
      evidenceUrl: "https://example.com/simulator",
    });
    mockedPrisma.googlePlaceReview.findUnique.mockResolvedValue(
      existing as never,
    );
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({ id: "reviewed-course" } as never)
      .mockResolvedValueOnce({ googlePlaceId: "reviewed-place" } as never);

    await expect(
      executeGooglePlaceReviewCommand(deactivateReviewCommand()),
    ).resolves.toEqual({
      mode: "applied",
      action: "deactivate",
      googlePlaceId: "reviewed-place",
      reconciledCourseIds: ["reviewed-course"],
    });
    expect(mockedInvalidateReviewDerivedIdentityFinal).toHaveBeenCalledWith({
      courseId: "reviewed-course",
      expectedReview: {
        observedAt: existing.reviewedAt,
        policyNotes:
          "Verified non-course listing Google Place review: INDOOR_SIMULATOR. Evidence: https://example.com/simulator",
      },
      correction: { kind: "DEACTIVATED" },
      onReviewAccepted: expect.any(Function),
    });
    expect(mockedPrisma.googlePlaceReview.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: existing.id,
        active: true,
        updatedAt: existing.updatedAt,
      }),
      data: { active: false },
    });
  });

  it("prints a bounded not-reconciled result and returns a failing CLI exit code", async () => {
    mockMappedCourseForPrivateReview();
    mockedRecordCourseMonitoringFinalClassification.mockResolvedValue({
      sourceEvidenceAccepted: false,
    } as never);
    const output = vi.fn();

    await expect(
      runGooglePlaceReviewCli(
        privateReviewArgs(),
        output,
      ),
    ).resolves.toBe(1);
    expect(output).toHaveBeenCalledOnce();
    expect(JSON.parse(output.mock.calls[0][0])).toEqual({
      mode: "not-reconciled",
      action: "upsert",
      googlePlaceId: "reviewed-place",
      reason: "course_final_source_rejected",
    });
  });
});

function mockAcceptedFinalClassification() {
  mockedRecordCourseMonitoringFinalClassification.mockImplementation(
    async (input) => {
      expect(mockedPrisma.googlePlaceReview.create).not.toHaveBeenCalled();
      expect(mockedPrisma.googlePlaceReview.updateMany).not.toHaveBeenCalled();
      await input.onSourceAccepted?.(
        prisma as never,
        input.evidence.observedAt,
      );
      return { sourceEvidenceAccepted: true } as never;
    },
  );
}

function mockMappedCourseForPrivateReview() {
  mockedPrisma.course.findUnique
    .mockResolvedValueOnce({
      id: "reviewed-course",
      name: "Reviewed Course",
    } as never)
    .mockResolvedValueOnce({ googlePlaceId: "reviewed-place" } as never);
}

function privateReviewCommand() {
  return parseGooglePlaceReviewCommand(privateReviewArgs());
}

function privateReviewArgs() {
  return [
    "upsert",
    "--place-id",
    "reviewed-place",
    "--access-override",
    "VERIFIED_PRIVATE",
    "--name",
    "Reviewed Course",
    "--classification",
    "PRIVATE_MEMBERSHIP",
    "--evidence-url",
    "https://example.com/membership",
    "--reviewed-at",
    "2026-07-15",
    "--apply",
  ];
}

function publicReviewCommand() {
  return parseGooglePlaceReviewCommand([
    "upsert",
    "--place-id",
    "reviewed-place",
    "--access-override",
    "VERIFIED_PUBLIC",
    "--name",
    "Reviewed Course",
    "--classification",
    "PUBLIC_GOLF_COURSE",
    "--evidence-url",
    "https://example.com/public",
    "--reviewed-at",
    "2026-07-15",
    "--latitude",
    "41",
    "--longitude",
    "-73",
    "--apply",
  ]);
}

function deactivateReviewCommand() {
  return parseGooglePlaceReviewCommand([
    "upsert",
    "--place-id",
    "reviewed-place",
    "--inactive",
    "--apply",
  ]);
}

function persistedReview(
  overrides: Partial<ReturnType<typeof persistedReviewDefaults>> = {},
) {
  return { ...persistedReviewDefaults(), ...overrides };
}

function persistedReviewDefaults() {
  return {
    id: "review-row",
    googlePlaceId: "reviewed-place",
    accessOverride: "VERIFIED_PUBLIC" as const,
    name: "Reviewed Course",
    classification: "PUBLIC_GOLF_COURSE",
    evidenceUrl: "https://example.com/golf",
    reviewedAt: new Date("2026-07-13T00:00:00.000Z"),
    active: true,
    canonicalPlaceId: null,
    canonicalName: null,
    canonicalAddress: null,
    canonicalWebsiteUrl: null,
    canonicalPhone: null,
    latitude: 41,
    longitude: -73,
    retainWhenCanonicalAbsent: false,
    updatedAt: new Date("2026-07-13T01:00:00.000Z"),
  };
}

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
    "2026-07-14",
  ];

  return Object.assign(args, {
    with(option: string, value: string) {
      const copy = [...args];
      const optionIndex = copy.indexOf(option);
      copy[optionIndex + 1] = value;
      return copy;
    },
  });
}
