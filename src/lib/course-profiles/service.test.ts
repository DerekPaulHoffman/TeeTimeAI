import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const monitoringMocks = vi.hoisted(() => ({
  revalidateCourseMonitoringForProviderEvidenceChangeInTransaction: vi.fn(),
  runSerializedCourseMonitoringWrite: vi.fn()
}));

const providerObservationMocks = vi.hoisted(() => ({
  beginCourseProviderObservation: vi.fn(),
  markCourseProviderObservationUnreconciled: vi.fn(),
  releaseCourseProviderObservation: vi.fn(),
  renewCourseProviderObservationInTransaction: vi.fn(),
  startCourseProviderObservationHeartbeat: vi.fn()
}));

vi.mock("@/lib/automation/course-monitoring", () => monitoringMocks);
vi.mock(
  "@/lib/automation/provider-execution-marker",
  () => providerObservationMocks
);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    course: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    courseProfile: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn()
    },
    courseProfileSlugAlias: { create: vi.fn(), findUnique: vi.fn() },
    courseProfileSource: { createMany: vi.fn(), deleteMany: vi.fn() }
  }
}));

import { prisma } from "@/lib/prisma";
import {
  applyCourseProfileDraft,
  createCourseProfilePublicFetchTransport,
  createCourseProfileSlugAlias,
  ensurePendingCourseProfile,
  getCourseProfileResearchPacket,
  getPublishedCourseProfile,
  getRelatedSupportedCourses,
  listPublishedDirectCourseProfiles,
  listCourseProfileLocationEnrichmentQueue,
  listCourseProfileQueue,
  queuePendingCourseProfiles
} from "./service";

const mockedPrisma = vi.mocked(prisma, { deep: true });
const providerObservedAt = new Date("2026-08-18T12:00:00.000Z");

describe("course profile service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    monitoringMocks.runSerializedCourseMonitoringWrite.mockImplementation(
      async (_courseId, worker) => worker(mockedPrisma as never)
    );
    monitoringMocks.revalidateCourseMonitoringForProviderEvidenceChangeInTransaction.mockResolvedValue({
      outcome: "IMMATERIAL",
      changedFields: [],
      searchesQueued: 0
    });
    providerObservationMocks.beginCourseProviderObservation.mockResolvedValue({
      courseId: "course-profile",
      leaseToken: "course-profile-observation",
      observationStartedAt: providerObservedAt,
      leaseExpiresAt: new Date(providerObservedAt.getTime() + 20 * 60_000),
      ttlMs: 20 * 60_000,
      supersededUnresolvedObservationStartedAt: null
    });
    providerObservationMocks.markCourseProviderObservationUnreconciled.mockResolvedValue(
      true
    );
    providerObservationMocks.releaseCourseProviderObservation.mockResolvedValue(
      undefined
    );
    providerObservationMocks.renewCourseProviderObservationInTransaction.mockResolvedValue(
      true
    );
    providerObservationMocks.startCourseProviderObservationHeartbeat.mockReturnValue({
      assertOwned: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined)
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the official website without opening an evidence-only account sign-in URL", async () => {
    const officialWebsite = "https://golf-course.example/about";
    const accountSignInUrl = "https://booking.example/sign-in";
    mockedPrisma.course.findUnique.mockResolvedValue({
      id: "account-course",
      website: officialWebsite,
      detectedBookingUrl: accountSignInUrl,
      profile: null
    } as never);
    const fetchMock = vi.fn(async () =>
      new Response("<html><body>Official public golf course</body></html>", {
        status: 200
      })
    );
    const packet = await getCourseProfileResearchPacket(
      "account-course",
      fetchMock as typeof fetch
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(officialWebsite);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ redirect: "manual" })
    );
    expect(packet.course.detectedBookingUrl).toBe(accountSignInUrl);
    expect(packet.sourcePages).toEqual([
      expect.objectContaining({
        url: officialWebsite,
        status: 200,
        text: "Official public golf course"
      })
    ]);
  });

  it("does not follow an otherwise safe research URL when it redirects to sign-in", async () => {
    const officialWebsite = "https://golf-course.example/book";
    const accountSignInUrl = "https://booking.example/sign-in";
    mockedPrisma.course.findUnique.mockResolvedValue({
      id: "redirect-course",
      website: officialWebsite,
      detectedBookingUrl: null,
      profile: null
    } as never);
    const loginDestinationHandler = vi.fn(() =>
      new Response("<html><body>Sign in</body></html>", { status: 200 })
    );
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const requestedUrl = String(input);
      if (requestedUrl === accountSignInUrl) {
        return loginDestinationHandler();
      }
      return new Response(null, {
        status: 302,
        headers: { location: accountSignInUrl }
      });
    });
    const packet = await getCourseProfileResearchPacket(
      "redirect-course",
      fetchMock as typeof fetch
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loginDestinationHandler).not.toHaveBeenCalled();
    expect(packet.sourcePages).toEqual([
      {
        url: officialWebsite,
        status: 302,
        text: null
      }
    ]);
  });

  it("creates a stable suffixed slug when the readable slug already exists", async () => {
    mockedPrisma.course.findUnique.mockResolvedValue({
      id: "course-ABC123",
      name: "Example Golf Course",
      city: "Fairfield",
      stateCode: "CT",
      profile: null
    } as never);
    mockedPrisma.courseProfile.findUnique.mockResolvedValue({ id: "existing-profile" } as never);
    mockedPrisma.courseProfile.create.mockResolvedValue({ id: "new-profile" } as never);

    await ensurePendingCourseProfile("course-ABC123");

    expect(mockedPrisma.courseProfile.create).toHaveBeenCalledWith({
      data: {
        courseId: "course-ABC123",
        canonicalSlug: "example-golf-course-fairfield-ct-abc123"
      }
    });
  });

  it("keeps a public stale profile and its aliases visible while refresh is queued", async () => {
    mockedPrisma.courseProfile.findFirst.mockResolvedValue({
      status: "STALE",
      canonicalSlug: "current-course-fairfield-ct",
      course: { isPublic: true }
    } as never);

    expect(await getPublishedCourseProfile("current-course-fairfield-ct")).toMatchObject({
      redirectSlug: null,
      profile: { status: "STALE" }
    });
    expect(mockedPrisma.courseProfile.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        canonicalSlug: "current-course-fairfield-ct",
        status: { in: ["PUBLISHED", "STALE"] },
        course: { isPublic: true }
      }
    }));

    mockedPrisma.courseProfile.findFirst.mockResolvedValue(null);
    mockedPrisma.courseProfileSlugAlias.findUnique.mockResolvedValue({
      courseProfile: {
        status: "STALE",
        canonicalSlug: "current-course-fairfield-ct",
        course: { isPublic: true }
      }
    } as never);

    expect(await getPublishedCourseProfile("old-course-fairfield-ct")).toMatchObject({
      redirectSlug: "current-course-fairfield-ct"
    });
  });

  it("hides a stale profile after the course is no longer public", async () => {
    mockedPrisma.courseProfile.findFirst.mockResolvedValue(null);

    mockedPrisma.courseProfileSlugAlias.findUnique.mockResolvedValue({
      courseProfile: {
        status: "STALE",
        canonicalSlug: "current-course-fairfield-ct",
        course: { isPublic: false }
      }
    } as never);
    expect(await getPublishedCourseProfile("old-course-fairfield-ct")).toBeNull();
  });

  it("creates a collision-checked redirect alias only with an explicit apply", async () => {
    mockedPrisma.courseProfile.findUnique
      .mockResolvedValueOnce({ id: "profile-1", canonicalSlug: "current-course-url" } as never)
      .mockResolvedValueOnce(null);
    mockedPrisma.courseProfileSlugAlias.findUnique.mockResolvedValue(null);
    mockedPrisma.courseProfileSlugAlias.create.mockResolvedValue({ id: "alias-1" } as never);

    expect(await createCourseProfileSlugAlias("course-1", "retired-course-url", true)).toEqual({
      mode: "applied",
      valid: true,
      errors: [],
      slug: "retired-course-url"
    });
    expect(mockedPrisma.courseProfileSlugAlias.create).toHaveBeenCalledWith({
      data: { courseProfileId: "profile-1", slug: "retired-course-url" }
    });
  });

  it("allows a clearly blocked public course to publish an honest limitation page", async () => {
    mockedPrisma.course.findUnique.mockResolvedValue({
      id: "blocked-course",
      name: "Phone Only Golf Course",
      isPublic: true,
      automationEligibility: "BLOCKED",
      profile: null
    } as never);
    mockedPrisma.courseProfile.findUnique.mockResolvedValue(null);

    expect(await applyCourseProfileDraft(validDraft("blocked-course"))).toMatchObject({
      mode: "dry-run",
      valid: true,
      canonicalSlug: "phone-only-golf-course-example-ct"
    });
  });

  it("lists public Course Guides without automatic alert support separately", async () => {
    mockedPrisma.courseProfile.findMany.mockResolvedValue([]);

    await listPublishedDirectCourseProfiles();

    expect(mockedPrisma.courseProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: ["PUBLISHED", "STALE"] },
          course: {
            isPublic: true,
            automationEligibility: { not: "ALLOWED" }
          }
        }
      })
    );
  });

  it("keeps an existing canonical slug immutable when location copy changes", async () => {
    mockedPrisma.course.findUnique.mockResolvedValue({
      id: "existing-course",
      name: "Existing Golf Course",
      isPublic: true,
      automationEligibility: "ALLOWED",
      profile: { canonicalSlug: "original-course-url", contentVersion: 2 }
    } as never);

    expect(await applyCourseProfileDraft(validDraft("existing-course"))).toMatchObject({
      mode: "dry-run",
      valid: true,
      canonicalSlug: "original-course-url"
    });
  });

  it("publishes an official website change through serialized monitoring revalidation", async () => {
    const current = {
      id: "course-website",
      name: "Website Golf Course",
      address: "1 Fairway Drive, Example, CT 06000",
      city: "Example",
      stateCode: "CT",
      website: "https://old.example.com/course",
      timeZone: "America/New_York",
      detectedBookingUrl: "https://booking.example.com/course",
      detectedPlatform: "UNKNOWN",
      providerFamilyKey: "SOURCE_MISSING",
      bookingMethod: "PUBLIC_ONLINE",
      bookingWindowDaysAhead: null,
      bookingWindowEvidenceUrl: null,
      bookingReleaseTimeLocal: null,
      bookingWindowSource: null,
      bookingWindowConfidence: null,
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      monitoringMode: "AUTOMATIC",
      bookingAccessMode: "PUBLIC_SIGNED_OUT",
      isPublic: true,
      intelligenceConfidence: 1,
      bookingMetadata: null,
      layoutHoleCounts: [],
      updatedAt: new Date("2026-08-17T12:00:00.000Z")
    };
    const applied = {
      ...current,
      website: "https://example.com/course",
      updatedAt: new Date("2026-08-18T12:00:00.000Z")
    };
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        id: current.id,
        name: current.name,
        address: current.address,
        city: current.city,
        stateCode: current.stateCode,
        isPublic: true,
        automationEligibility: "ALLOWED",
        layoutHoleCounts: current.layoutHoleCounts,
        updatedAt: current.updatedAt,
        profile: null
      } as never)
      .mockResolvedValueOnce(current as never);
    mockedPrisma.courseProfile.findUnique.mockResolvedValue(null);
    mockedPrisma.course.update.mockResolvedValue(applied as never);
    mockedPrisma.courseProfile.upsert.mockResolvedValue({
      id: "profile-website",
      canonicalSlug: "website-golf-course-example-ct"
    } as never);
    const fetchMock = vi.fn(async () =>
      new Response(
        "<html><title>Website Golf Course</title><body><h1>Website Golf Course</h1><p>Example, Connecticut</p></body></html>",
        { status: 200 }
      )
    );
    monitoringMocks.revalidateCourseMonitoringForProviderEvidenceChangeInTransaction.mockResolvedValueOnce(
      {
        outcome: "NOT_ACTIONABLE",
        changedFields: ["website"],
        searchesQueued: 0
      }
    );

    await expect(
      applyCourseProfileDraft(
        {
          ...validDraft(current.id),
          officialWebsiteUrl: applied.website
        },
        true,
        fetchMock as typeof fetch
      )
    ).resolves.toMatchObject({
      mode: "applied",
      valid: true,
      courseId: current.id
    });

    expect(monitoringMocks.runSerializedCourseMonitoringWrite).toHaveBeenCalledWith(
      current.id,
      expect.any(Function)
    );
    expect(mockedPrisma.course.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: current.id, updatedAt: current.updatedAt },
        data: expect.objectContaining({ website: applied.website })
      })
    );
    expect(
      monitoringMocks.revalidateCourseMonitoringForProviderEvidenceChangeInTransaction
    ).toHaveBeenCalledWith(
      mockedPrisma,
      expect.objectContaining({
        courseId: current.id,
        before: current,
        after: applied,
        source: "OPERATOR_CLI",
        now: providerObservedAt
      })
    );
    expect(
      providerObservationMocks.markCourseProviderObservationUnreconciled
    ).toHaveBeenCalledWith(
      expect.objectContaining({ observationStartedAt: providerObservedAt })
    );
  });

  it("rejects an unrelated public page as the selected course official website", async () => {
    const current = profileCourse({ id: "profile-unrelated-website" });
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      id: current.id,
      name: current.name,
      address: current.address,
      city: current.city,
      stateCode: current.stateCode,
      isPublic: true,
      automationEligibility: "ALLOWED",
      layoutHoleCounts: current.layoutHoleCounts,
      updatedAt: current.updatedAt,
      profile: null
    } as never);
    mockedPrisma.courseProfile.findUnique.mockResolvedValue(null);
    const fetchMock = vi.fn(async () =>
      new Response(
        "<html><title>Different Golf Course</title><body><h1>Different Golf Course</h1><p>Example, Connecticut</p></body></html>",
        { status: 200 }
      )
    );

    const applyPromise = applyCourseProfileDraft(
      {
        ...validDraft(current.id),
        officialWebsiteUrl: "https://example.com/course"
      },
      true,
      fetchMock as typeof fetch
    );

    await expect(applyPromise).rejects.toThrow(
      "Fresh official website evidence does not corroborate the selected course identity and locality."
    );
    await expect(applyPromise).rejects.not.toThrow("example.com");
    expect(mockedPrisma.course.update).not.toHaveBeenCalled();
    expect(
      providerObservationMocks.markCourseProviderObservationUnreconciled
    ).toHaveBeenCalledOnce();
  });

  it("rejects an exact-name official page from a different locality", async () => {
    const current = profileCourse({ id: "profile-wrong-locality" });
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      id: current.id,
      name: current.name,
      address: current.address,
      city: current.city,
      stateCode: current.stateCode,
      isPublic: true,
      automationEligibility: "ALLOWED",
      layoutHoleCounts: current.layoutHoleCounts,
      updatedAt: current.updatedAt,
      profile: null
    } as never);
    mockedPrisma.courseProfile.findUnique.mockResolvedValue(null);
    const fetchMock = vi.fn(async () =>
      new Response(
        "<html><title>Example Golf Course</title><body><h1>Example Golf Course</h1><p>Springfield, Massachusetts</p></body></html>",
        { status: 200 }
      )
    );

    await expect(
      applyCourseProfileDraft(
        {
          ...validDraft(current.id),
          officialWebsiteUrl: "https://example.com/course"
        },
        true,
        fetchMock as typeof fetch
      )
    ).rejects.toThrow(
      "Fresh official website evidence does not corroborate the selected course identity and locality."
    );

    expect(mockedPrisma.course.update).not.toHaveBeenCalled();
    expect(
      providerObservationMocks.markCourseProviderObservationUnreconciled
    ).toHaveBeenCalledOnce();
  });

  it("address-pins every profile source redirect and fails closed on private rebinding", async () => {
    const current = profileCourse({ id: "profile-private-rebinding" });
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      id: current.id,
      name: current.name,
      address: current.address,
      city: current.city,
      stateCode: current.stateCode,
      isPublic: true,
      automationEligibility: "ALLOWED",
      layoutHoleCounts: current.layoutHoleCounts,
      updatedAt: current.updatedAt,
      profile: null
    } as never);
    mockedPrisma.courseProfile.findUnique.mockResolvedValue(null);
    const resolveAddresses = vi.fn(async (hostname: string) =>
      hostname === "example.com"
        ? [{ address: "93.184.216.34", family: 4 as const }]
        : [{ address: "127.0.0.1", family: 4 as const }]
    );
    const requestPinned = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://redirect.example.com/course" }
      })
    );
    const publicFetch = createCourseProfilePublicFetchTransport({
      resolveAddresses,
      requestPinned
    });

    await expect(
      applyCourseProfileDraft(validDraft(current.id), true, publicFetch)
    ).rejects.toThrow(
      "Course profile source freshness verification failed for one or more public pages."
    );

    expect(resolveAddresses).toHaveBeenNthCalledWith(1, "example.com");
    expect(resolveAddresses).toHaveBeenNthCalledWith(
      2,
      "redirect.example.com"
    );
    expect(requestPinned).toHaveBeenCalledOnce();
    expect(mockedPrisma.course.update).not.toHaveBeenCalled();
    expect(
      providerObservationMocks.markCourseProviderObservationUnreconciled
    ).toHaveBeenCalledOnce();
  });

  it("defers S0 from the t1 profile-source read through pre-apply ownership and unresolved monitoring", async () => {
    const events: string[] = [];
    let markerPresent = false;
    const current = profileCourse({
      id: "profile-causal-course",
      website: "https://old.example.com/course"
    });
    const applied = {
      ...current,
      website: "https://example.com/course",
      updatedAt: new Date("2026-08-18T12:01:00.000Z")
    };
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        id: current.id,
        name: current.name,
        address: current.address,
        city: current.city,
        stateCode: current.stateCode,
        isPublic: true,
        automationEligibility: "ALLOWED",
        layoutHoleCounts: current.layoutHoleCounts,
        updatedAt: current.updatedAt,
        profile: null
      } as never)
      .mockResolvedValueOnce(current as never);
    mockedPrisma.course.update.mockImplementationOnce(async () => {
      events.push(markerPresent ? "s0-deferred-before-apply" : "s0-sent-stale");
      events.push("canonical-course-apply");
      return applied as never;
    });
    mockedPrisma.courseProfile.findUnique.mockResolvedValue(null);
    mockedPrisma.courseProfile.upsert.mockResolvedValue({
      id: "profile-causal",
      canonicalSlug: "profile-causal-course-example-ct"
    } as never);
    providerObservationMocks.beginCourseProviderObservation.mockImplementationOnce(
      async () => {
        markerPresent = true;
        events.push("marker-began");
        return providerObservationLease(current.id);
      }
    );
    providerObservationMocks.renewCourseProviderObservationInTransaction.mockImplementationOnce(
      async () => {
        events.push("pre-apply-ownership");
        return markerPresent;
      }
    );
    providerObservationMocks.markCourseProviderObservationUnreconciled.mockImplementationOnce(
      async () => {
        events.push("source-retained-unreconciled");
        return true;
      }
    );
    monitoringMocks.revalidateCourseMonitoringForProviderEvidenceChangeInTransaction.mockResolvedValueOnce(
      {
        outcome: "NOT_ACTIONABLE",
        changedFields: ["website"],
        searchesQueued: 0
      }
    );
    const fetchMock = vi.fn(async () => {
      expect(markerPresent).toBe(true);
      events.push("t1-provider-read");
      return new Response(
        "<html><title>Example Golf Course</title><body><h1>Example Golf Course</h1><p>Example, Connecticut</p></body></html>",
        { status: 200 }
      );
    });

    await applyCourseProfileDraft(
      {
        ...validDraft(current.id),
        officialWebsiteUrl: applied.website
      },
      true,
      fetchMock as typeof fetch
    );
    events.push(markerPresent ? "s0-deferred-after-apply" : "s0-sent-stale");

    expect(events).toEqual([
      "marker-began",
      "t1-provider-read",
      "pre-apply-ownership",
      "s0-deferred-before-apply",
      "canonical-course-apply",
      "source-retained-unreconciled",
      "s0-deferred-after-apply"
    ]);
  });

  it("does not publish fresh provider evidence after pre-apply marker ownership is lost", async () => {
    const current = profileCourse({ id: "profile-lost-ownership" });
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      id: current.id,
      name: current.name,
      address: current.address,
      city: current.city,
      stateCode: current.stateCode,
      isPublic: true,
      automationEligibility: "ALLOWED",
      layoutHoleCounts: current.layoutHoleCounts,
      updatedAt: current.updatedAt,
      profile: null
    } as never);
    mockedPrisma.courseProfile.findUnique.mockResolvedValue(null);
    providerObservationMocks.beginCourseProviderObservation.mockResolvedValueOnce(
      providerObservationLease(current.id)
    );
    providerObservationMocks.renewCourseProviderObservationInTransaction.mockResolvedValueOnce(
      false
    );
    const fetchMock = vi.fn(async () =>
      new Response("<html><body>Example Golf Course official page</body></html>", {
        status: 200
      })
    );

    await expect(
      applyCourseProfileDraft(
        validDraft(current.id),
        true,
        fetchMock as typeof fetch
      )
    ).rejects.toThrow(
      "Provider observation ownership expired before the course profile could be persisted."
    );

    expect(mockedPrisma.course.update).not.toHaveBeenCalled();
    expect(mockedPrisma.courseProfile.upsert).not.toHaveBeenCalled();
    expect(
      providerObservationMocks.markCourseProviderObservationUnreconciled
    ).toHaveBeenCalledOnce();
  });

  it("retains the provider source when fresh structured evidence no longer supports the draft", async () => {
    const current = profileCourse({ id: "profile-stale-layout" });
    mockedPrisma.course.findUnique.mockResolvedValueOnce({
      id: current.id,
      name: current.name,
      address: current.address,
      city: current.city,
      stateCode: current.stateCode,
      isPublic: true,
      automationEligibility: "ALLOWED",
      layoutHoleCounts: current.layoutHoleCounts,
      updatedAt: current.updatedAt,
      profile: null
    } as never);
    mockedPrisma.courseProfile.findUnique.mockResolvedValue(null);
    providerObservationMocks.beginCourseProviderObservation.mockResolvedValueOnce(
      providerObservationLease(current.id)
    );
    const fetchMock = vi.fn(async () =>
      new Response(
        "<html><body>Example Golf Course is now a nine-hole course.</body></html>",
        { status: 200 }
      )
    );
    const draft = validDraft(current.id);
    draft.sources[0]!.claimKeys.push("physical_layout");

    await expect(
      applyCourseProfileDraft(
        {
          ...draft,
          physicalLayout: {
            holeCounts: [18],
            evidenceUrl: draft.sources[0]!.url,
            verifiedAt: draft.profileVerifiedAt
          }
        },
        true,
        fetchMock as typeof fetch
      )
    ).rejects.toThrow(
      "Fresh physical-layout evidence no longer corroborates every requested hole count."
    );

    expect(mockedPrisma.course.update).not.toHaveBeenCalled();
    expect(
      providerObservationMocks.markCourseProviderObservationUnreconciled
    ).toHaveBeenCalledOnce();
  });

  it("retains a fresh provider source after a profile-only write", async () => {
    const events: string[] = [];
    const current = profileCourse({ id: "profile-copy-only" });
    const applied = {
      ...current,
      updatedAt: new Date("2026-08-18T12:01:00.000Z")
    };
    mockedPrisma.course.findUnique
      .mockResolvedValueOnce({
        id: current.id,
        name: current.name,
        address: current.address,
        city: current.city,
        stateCode: current.stateCode,
        isPublic: true,
        automationEligibility: "ALLOWED",
        layoutHoleCounts: current.layoutHoleCounts,
        updatedAt: current.updatedAt,
        profile: null
      } as never)
      .mockResolvedValueOnce(current as never);
    mockedPrisma.course.update.mockResolvedValueOnce(applied as never);
    mockedPrisma.courseProfile.findUnique.mockResolvedValue(null);
    mockedPrisma.courseProfile.upsert.mockImplementationOnce(async () => {
      events.push("profile-persisted");
      return {
        id: "profile-copy-only-row",
        canonicalSlug: "example-golf-course-example-ct"
      } as never;
    });
    mockedPrisma.courseProfileSource.createMany.mockImplementationOnce(async () => {
      events.push("fresh-sources-persisted");
      return { count: 1 };
    });
    providerObservationMocks.beginCourseProviderObservation.mockResolvedValueOnce(
      providerObservationLease(current.id)
    );
    providerObservationMocks.markCourseProviderObservationUnreconciled.mockImplementationOnce(
      async () => {
        events.push("source-retained-unreconciled");
        return true;
      }
    );
    const fetchMock = vi.fn(async () =>
      new Response("<html><body>Example Golf Course official page</body></html>", {
        status: 200
      })
    );

    await expect(
      applyCourseProfileDraft(
        validDraft(current.id),
        true,
        fetchMock as typeof fetch
      )
    ).resolves.toMatchObject({ mode: "applied", courseId: current.id });

    expect(events).toEqual([
      "profile-persisted",
      "fresh-sources-persisted",
      "source-retained-unreconciled"
    ]);
    expect(mockedPrisma.courseProfileSource.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          accessedAt: providerObservedAt,
          courseProfileId: "profile-copy-only-row"
        })
      ]
    });
    expect(
      providerObservationMocks.markCourseProviderObservationUnreconciled
    ).toHaveBeenCalledWith(
      expect.objectContaining({ observationStartedAt: providerObservedAt })
    );
  });

  it("never fails alert creation when post-response queueing cannot reach profile storage", async () => {
    mockedPrisma.course.findUnique.mockRejectedValue(new Error("profile storage unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(queuePendingCourseProfiles(["course-1"])).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      "Course profile queueing failed for 1 course",
      ["profile storage unavailable"]
    );
    warning.mockRestore();
  });

  it("keeps previously published content stale after a failed refresh", async () => {
    mockedPrisma.course.findUnique.mockResolvedValue({
      id: "course-1",
      name: "Existing Golf Course",
      city: "Fairfield",
      stateCode: "CT",
      profile: {
        canonicalSlug: "existing-golf-course-fairfield-ct",
        publishedAt: new Date("2026-07-01T12:00:00.000Z")
      }
    } as never);

    await applyCourseProfileDraft({ courseId: "course-1" }, true);

    expect(mockedPrisma.courseProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: "STALE",
          failureReason: expect.any(String)
        })
      })
    );
  });

  it("serves the oldest profile maintenance work first", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      queuedCourse("newer", "2026-07-22T12:00:00.000Z"),
      queuedCourse("older", "2026-07-20T12:00:00.000Z")
    ] as never);

    const queue = await listCourseProfileQueue(2);

    expect(queue.map((course) => course.id)).toEqual(["older", "newer"]);
    expect(mockedPrisma.course.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          city: { not: null },
          stateCode: { not: null }
        })
      })
    );
  });

  it("keeps courses with missing city or state in a separate enrichment queue", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      { ...queuedCourse("missing-location", "2026-07-19T12:00:00.000Z"), city: null, profile: undefined }
    ] as never);

    const queue = await listCourseProfileLocationEnrichmentQueue(3);

    expect(queue[0]?.id).toBe("missing-location");
    expect(mockedPrisma.course.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          profile: null,
          OR: [{ city: null }, { stateCode: null }]
        }),
        orderBy: { createdAt: "asc" }
      })
    );
  });

  it("prefers nearby supported profiles and falls back only within the same state", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      candidate("near", 41.01, -73.01, "CT"),
      candidate("same-state", 42, -73, "CT"),
      candidate("other-state", 42, -73, "MA")
    ] as never);

    const related = await getRelatedSupportedCourses({
      id: "origin",
      latitude: 41,
      longitude: -73,
      stateCode: "CT"
    });

    expect(related.map((course) => course.id)).toEqual(["near", "same-state"]);
    expect(mockedPrisma.course.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          profile: { status: { in: ["PUBLISHED", "STALE"] } }
        })
      })
    );
  });
});

function queuedCourse(id: string, createdAt: string) {
  const date = new Date(createdAt);
  return {
    id,
    createdAt: date,
    name: id,
    city: "Example",
    stateCode: "CT",
    county: "Fairfield",
    website: `https://${id}.example.com`,
    detectedBookingUrl: null,
    automationEligibility: "ALLOWED",
    profile: {
      status: "PENDING",
      createdAt: date,
      reviewDueAt: null,
      failureReason: null
    }
  };
}

function candidate(id: string, latitude: number, longitude: number, stateCode: string) {
  return {
    id,
    name: id,
    city: "Example",
    stateCode,
    latitude,
    longitude,
    profile: { canonicalSlug: `${id}-example-${stateCode.toLowerCase()}` }
  };
}

function validDraft(courseId: string) {
  return {
    courseId,
    location: {
      city: "Example",
      stateCode: "CT",
      stateName: "Connecticut",
      county: "Fairfield",
      countryCode: "US"
    },
    courseType: "DAILY_FEE",
    accessSummary: "A verified public course with daily access.",
    overview: "This public course provides a full golf round in Example, Connecticut.",
    courseCharacter: "The layout combines varied holes with an approachable public booking experience.",
    notableFacts: [],
    profileVerifiedAt: "2026-07-15T12:00:00.000Z",
    sources: [{
      url: "https://example.com/course",
      title: "Official course page",
      publisher: "Example Golf",
      sourceType: "OFFICIAL_COURSE",
      claimKeys: ["access", "course_type", "overview", "course_character"],
      evidenceSummary: "The official page supports public access, course type, overview, and layout character.",
      accessedAt: "2026-07-15T12:00:00.000Z"
    }]
  };
}

function profileCourse(
  overrides: Partial<ReturnType<typeof baseProfileCourse>> & { id: string }
) {
  return { ...baseProfileCourse(), ...overrides };
}

function baseProfileCourse() {
  return {
    id: "profile-course",
    name: "Example Golf Course",
    address: "1 Fairway Drive, Example, CT 06000",
    city: "Example",
    stateCode: "CT",
    website: "https://example.com/course",
    timeZone: "America/New_York",
    detectedBookingUrl: "https://booking.example.com/course",
    detectedPlatform: "UNKNOWN",
    providerFamilyKey: "SOURCE_MISSING",
    bookingMethod: "PUBLIC_ONLINE",
    bookingWindowDaysAhead: null,
    bookingWindowEvidenceUrl: null,
    bookingReleaseTimeLocal: null,
    bookingWindowSource: null,
    bookingWindowConfidence: null,
    automationEligibility: "ALLOWED",
    automationReason: "NONE",
    monitoringMode: "AUTOMATIC",
    bookingAccessMode: "PUBLIC_SIGNED_OUT",
    isPublic: true,
    intelligenceConfidence: 1,
    bookingMetadata: null,
    layoutHoleCounts: [],
    layoutHolesEvidenceUrl: null,
    layoutHolesVerifiedAt: null,
    par: null,
    parEvidenceUrl: null,
    parVerifiedAt: null,
    updatedAt: new Date("2026-08-17T12:00:00.000Z")
  };
}

function providerObservationLease(courseId: string) {
  return {
    courseId,
    leaseToken: `profile-observation-${courseId}`,
    observationStartedAt: providerObservedAt,
    leaseExpiresAt: new Date(providerObservedAt.getTime() + 20 * 60_000),
    ttlMs: 20 * 60_000,
    supersededUnresolvedObservationStartedAt: null
  };
}
