import { beforeEach, describe, expect, it, vi } from "vitest";

const adapterMocks = vi.hoisted(() => ({
  fetchCpsTeeSheet: vi.fn(),
  fetchChelseaTeeSheet: vi.fn(),
  fetchChronogolfSlots: vi.fn(),
  fetchClubCaddieTeeSheet: vi.fn(),
  fetchForeupTeeSheet: vi.fn(),
  fetchGolfBackTeeSheet: vi.fn(),
  fetchGolfNowTeeSheet: vi.fn(),
  fetchGolfWithAccessTeeSheet: vi.fn(),
  fetchTeeItUpTeeSheet: vi.fn(),
  fetchTeesnapTeeSheet: vi.fn(),
  fetchWebTracTeeSheet: vi.fn(),
  fetchWhooshTeeSheet: vi.fn(),
  isCpsMetadata: vi.fn(),
  isChelseaMetadata: vi.fn(),
  isChronogolfMetadata: vi.fn(),
  isClubCaddieMetadata: vi.fn(),
  isForeupMetadata: vi.fn(),
  isGolfBackMetadata: vi.fn(),
  isGolfNowMetadata: vi.fn(),
  isGolfWithAccessMetadata: vi.fn(),
  isTeeItUpMetadata: vi.fn(),
  isTeesnapMetadata: vi.fn(),
  isWebTracMetadata: vi.fn(),
  isWhooshMetadata: vi.fn()
}));

const capabilityMocks = vi.hoisted(() => ({
  resolveProviderCapability: vi.fn()
}));

vi.mock("@/lib/adapters/cps", () => ({
  fetchCpsTeeSheet: adapterMocks.fetchCpsTeeSheet,
  isCpsMetadata: adapterMocks.isCpsMetadata
}));
vi.mock("@/lib/adapters/chelsea", () => ({
  fetchChelseaTeeSheet: adapterMocks.fetchChelseaTeeSheet,
  isChelseaMetadata: adapterMocks.isChelseaMetadata
}));
vi.mock("@/lib/adapters/chronogolf", () => ({
  fetchChronogolfSlots: adapterMocks.fetchChronogolfSlots,
  isChronogolfMetadata: adapterMocks.isChronogolfMetadata
}));
vi.mock("@/lib/adapters/clubcaddie", () => ({
  fetchClubCaddieTeeSheet: adapterMocks.fetchClubCaddieTeeSheet,
  isClubCaddieMetadata: adapterMocks.isClubCaddieMetadata
}));
vi.mock("@/lib/adapters/foreup", () => ({
  fetchForeupTeeSheet: adapterMocks.fetchForeupTeeSheet,
  isForeupMetadata: adapterMocks.isForeupMetadata
}));
vi.mock("@/lib/adapters/golfback", () => ({
  fetchGolfBackTeeSheet: adapterMocks.fetchGolfBackTeeSheet,
  isGolfBackMetadata: adapterMocks.isGolfBackMetadata
}));
vi.mock("@/lib/adapters/golfnow", () => ({
  fetchGolfNowTeeSheet: adapterMocks.fetchGolfNowTeeSheet,
  isGolfNowMetadata: adapterMocks.isGolfNowMetadata
}));
vi.mock("@/lib/adapters/golf-with-access", () => ({
  fetchGolfWithAccessTeeSheet: adapterMocks.fetchGolfWithAccessTeeSheet,
  isGolfWithAccessMetadata: adapterMocks.isGolfWithAccessMetadata
}));
vi.mock("@/lib/adapters/teeitup", () => ({
  fetchTeeItUpTeeSheet: adapterMocks.fetchTeeItUpTeeSheet,
  isTeeItUpMetadata: adapterMocks.isTeeItUpMetadata
}));
vi.mock("@/lib/adapters/teesnap", () => ({
  fetchTeesnapTeeSheet: adapterMocks.fetchTeesnapTeeSheet,
  isTeesnapMetadata: adapterMocks.isTeesnapMetadata
}));
vi.mock("@/lib/adapters/webtrac", () => ({
  fetchWebTracTeeSheet: adapterMocks.fetchWebTracTeeSheet,
  isWebTracMetadata: adapterMocks.isWebTracMetadata
}));
vi.mock("@/lib/adapters/whoosh", () => ({
  fetchWhooshTeeSheet: adapterMocks.fetchWhooshTeeSheet,
  isWhooshMetadata: adapterMocks.isWhooshMetadata
}));
vi.mock("@/lib/automation/provider-capabilities", () => capabilityMocks);

import {
  fetchCourseTeeSheet,
  type AutomationCourseProviderRead
} from "./course-provider-read";

const date = new Date("2026-07-24T00:00:00.000Z");
const metadata = { provider: "TEST", facilityId: "facility-1" };
const providerResult = {
  slots: [],
  targetDateStatus: "UNKNOWN" as const,
  bookingWindowEvidence: null
};

function buildCourse(
  providerFamilyKey: string,
  overrides: Partial<AutomationCourseProviderRead> = {}
): AutomationCourseProviderRead {
  return {
    id: "course-1",
    timeZone: "America/New_York",
    website: "https://course.example",
    detectedBookingUrl: "https://booking.example",
    providerFamilyKey,
    detectedPlatform: "CUSTOM",
    bookingMetadata: metadata,
    bookingWindowEvidenceUrl: null,
    ...overrides
  };
}

describe("fetchCourseTeeSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capabilityMocks.resolveProviderCapability.mockImplementation((course) => ({
      providerFamilyKey: course.providerFamilyKey
    }));
    adapterMocks.isCpsMetadata.mockReturnValue(true);
    adapterMocks.isChelseaMetadata.mockReturnValue(true);
    adapterMocks.isChronogolfMetadata.mockReturnValue(true);
    adapterMocks.isClubCaddieMetadata.mockReturnValue(true);
    adapterMocks.isForeupMetadata.mockReturnValue(true);
    adapterMocks.isGolfBackMetadata.mockReturnValue(true);
    adapterMocks.isGolfNowMetadata.mockReturnValue(true);
    adapterMocks.isGolfWithAccessMetadata.mockReturnValue(true);
    adapterMocks.isTeeItUpMetadata.mockReturnValue(true);
    adapterMocks.isTeesnapMetadata.mockReturnValue(true);
    adapterMocks.isWebTracMetadata.mockReturnValue(true);
    adapterMocks.isWhooshMetadata.mockReturnValue(true);
    adapterMocks.fetchCpsTeeSheet.mockResolvedValue(providerResult);
    adapterMocks.fetchChelseaTeeSheet.mockResolvedValue(providerResult);
    adapterMocks.fetchChronogolfSlots.mockResolvedValue([]);
    adapterMocks.fetchClubCaddieTeeSheet.mockResolvedValue(providerResult);
    adapterMocks.fetchForeupTeeSheet.mockResolvedValue(providerResult);
    adapterMocks.fetchGolfBackTeeSheet.mockResolvedValue(providerResult);
    adapterMocks.fetchGolfNowTeeSheet.mockResolvedValue(providerResult);
    adapterMocks.fetchGolfWithAccessTeeSheet.mockResolvedValue(providerResult);
    adapterMocks.fetchTeeItUpTeeSheet.mockResolvedValue(providerResult);
    adapterMocks.fetchTeesnapTeeSheet.mockResolvedValue(providerResult);
    adapterMocks.fetchWebTracTeeSheet.mockResolvedValue(providerResult);
    adapterMocks.fetchWhooshTeeSheet.mockResolvedValue(providerResult);
  });

  it("delegates to every supported provider with the original input shape", async () => {
    const evidenceUrl = "https://course.example/booking-policy";
    const foreupCourse = buildCourse("FOREUP", {
      bookingWindowEvidenceUrl: evidenceUrl
    });
    await expect(fetchCourseTeeSheet(foreupCourse, date, 3, true)).resolves.toBe(
      providerResult
    );
    expect(adapterMocks.fetchForeupTeeSheet).toHaveBeenCalledWith({
      courseId: "course-1",
      date,
      players: 3,
      metadata: { ...metadata, bookingWindowEvidenceUrl: evidenceUrl },
      discoverBookingWindow: true
    });

    await expect(
      fetchCourseTeeSheet(buildCourse("TEEITUP"), date, 3, true)
    ).resolves.toBe(providerResult);
    expect(adapterMocks.fetchTeeItUpTeeSheet).toHaveBeenCalledWith({
      courseId: "course-1",
      date,
      metadata
    });

    await expect(
      fetchCourseTeeSheet(buildCourse("CHRONOGOLF"), date, 3, true)
    ).resolves.toEqual({
      slots: [],
      targetDateStatus: "UNKNOWN",
      bookingWindowEvidence: null
    });
    expect(adapterMocks.fetchChronogolfSlots).toHaveBeenCalledWith({
      courseId: "course-1",
      date,
      players: 3,
      metadata
    });

    await expect(fetchCourseTeeSheet(buildCourse("CPS"), date, 3, true)).resolves.toBe(
      providerResult
    );
    expect(adapterMocks.fetchCpsTeeSheet).toHaveBeenCalledWith({
      courseId: "course-1",
      date,
      players: 3,
      timeZone: "America/New_York",
      metadata,
      discoverBookingWindow: true
    });

    await expect(
      fetchCourseTeeSheet(buildCourse("CHELSEA"), date, 3, true)
    ).resolves.toBe(providerResult);
    expect(adapterMocks.fetchChelseaTeeSheet).toHaveBeenCalledWith({
      courseId: "course-1",
      date,
      players: 3,
      timeZone: "America/New_York",
      metadata
    });

    await expect(
      fetchCourseTeeSheet(buildCourse("GOLFBACK"), date, 3, true)
    ).resolves.toBe(providerResult);
    expect(adapterMocks.fetchGolfBackTeeSheet).toHaveBeenCalledWith({
      courseId: "course-1",
      date,
      players: 3,
      timeZone: "America/New_York",
      metadata,
      discoverBookingWindow: true
    });

    await expect(
      fetchCourseTeeSheet(buildCourse("GOLFNOW"), date, 3, true)
    ).resolves.toBe(providerResult);
    expect(adapterMocks.fetchGolfNowTeeSheet).toHaveBeenCalledWith({
      courseId: "course-1",
      date,
      players: 3,
      metadata
    });

    await expect(
      fetchCourseTeeSheet(buildCourse("GOLF_WITH_ACCESS"), date, 3, true)
    ).resolves.toBe(providerResult);
    expect(adapterMocks.fetchGolfWithAccessTeeSheet).toHaveBeenCalledWith({
      courseId: "course-1",
      date,
      players: 3,
      metadata
    });

    await expect(
      fetchCourseTeeSheet(buildCourse("WEBTRAC"), date, 3, true)
    ).resolves.toBe(providerResult);
    expect(adapterMocks.fetchWebTracTeeSheet).toHaveBeenCalledWith({
      courseId: "course-1",
      date,
      players: 3,
      metadata,
      discoverBookingWindow: true
    });

    await expect(
      fetchCourseTeeSheet(buildCourse("CLUB_CADDIE"), date, 3, true)
    ).resolves.toBe(providerResult);
    expect(adapterMocks.fetchClubCaddieTeeSheet).toHaveBeenCalledWith({
      courseId: "course-1",
      date,
      players: 3,
      metadata
    });

    await expect(
      fetchCourseTeeSheet(buildCourse("TEESNAP"), date, 3, true)
    ).resolves.toBe(providerResult);
    expect(adapterMocks.fetchTeesnapTeeSheet).toHaveBeenCalledWith({
      courseId: "course-1",
      date,
      players: 3,
      metadata,
      discoverBookingWindow: true
    });

    await expect(
      fetchCourseTeeSheet(buildCourse("WHOOSH"), date, 3, true)
    ).resolves.toBe(providerResult);
    expect(adapterMocks.fetchWhooshTeeSheet).toHaveBeenCalledWith({
      courseId: "course-1",
      date,
      players: 3,
      timeZone: "America/New_York",
      metadata,
      discoverBookingWindow: true
    });
  });

  it("maps Chronogolf slots to the shared result contract", async () => {
    const slots = [{ sourceId: "slot-1" }];
    adapterMocks.fetchChronogolfSlots.mockResolvedValue(slots);

    await expect(
      fetchCourseTeeSheet(buildCourse("CHRONOGOLF"), date, 2, false)
    ).resolves.toEqual({
      slots,
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null
    });
  });

  it("fails closed when provider metadata is invalid or the family is unsupported", async () => {
    adapterMocks.isCpsMetadata.mockReturnValue(false);

    await expect(
      fetchCourseTeeSheet(buildCourse("CPS"), date, 2, false)
    ).resolves.toEqual({
      slots: [],
      targetDateStatus: "UNKNOWN",
      bookingWindowEvidence: null
    });
    expect(adapterMocks.fetchCpsTeeSheet).not.toHaveBeenCalled();

    adapterMocks.isGolfNowMetadata.mockReturnValue(false);
    await expect(
      fetchCourseTeeSheet(buildCourse("GOLFNOW"), date, 2, false)
    ).resolves.toEqual({
      slots: [],
      targetDateStatus: "UNKNOWN",
      bookingWindowEvidence: null
    });
    expect(adapterMocks.fetchGolfNowTeeSheet).not.toHaveBeenCalled();
  });
});
