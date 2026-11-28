import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGolfGeekTeeSheet, isGolfGeekMetadata } from "./golf-geek";

const courseId = "092c858d-68a5-4206-91e0-132f3bd0bb61";
const slotId = "4835d095-00c9-41a5-9e66-89a9832d45d5";
const publicRateId = "a5d82602-d63a-4187-b5c6-f52c14e5a743";
const metadata = {
  provider: "GOLF_GEEK" as const, courseId,
  bookingBaseUrl: "https://booking.gatewaynational.com/",
  officialWebsite: "https://www.gatewaynational.com/", bookingWindowDaysAhead: 14
};
const scopedSlot = { id: slotId, date: "2026-09-24", startTime: "07:54", freeSlots: 3,
  allowedSlots: [1, 2, 3], rates: [{ id: publicRateId, name: "Public", price: 85.95 }] };
const input = { courseId: "saved-course", date: new Date("2026-09-24T00:00:00Z"), players: 2, metadata };

describe("Golf Geek public tee sheet", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requires a clean course-bound booking origin", () => {
    expect(isGolfGeekMetadata(metadata)).toBe(true);
    expect(isGolfGeekMetadata({ ...metadata, bookingBaseUrl: "https://booking.othercourse.com/" })).toBe(false);
    expect(isGolfGeekMetadata({ ...metadata, bookingBaseUrl: "https://booking.gatewaynational.com/checkout" })).toBe(false);
    expect(isGolfGeekMetadata({ ...metadata, courseId: "invalid" })).toBe(false);
  });

  it("reads signed-out slots and links only the public rate without requesting a booking page", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: slotId, date: "2026-09-24", startTime: "07:54", freeSlots: 3,
        allowedSlots: [1, 2, 3],
        rates: [{ id: "e48eff26-cc53-42f6-92cd-e2ae8bffa5ce", name: "Annual Passholder", price: 0 },
          { id: publicRateId, name: "Public", price: 85.95 }] },
      { id: "02ae095f-886f-43bc-8ad7-c598905b1be4", date: "2026-09-24",
        startTime: "08:30", freeSlots: 3, allowedSlots: [1],
        rates: [{ id: publicRateId, name: "Public", price: 90.95 }] }
    ] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);
    const result = await fetchGolfGeekTeeSheet({
      courseId: "saved-course", date: new Date("2026-09-24T00:00:00Z"),
      players: 2, metadata, discoverBookingWindow: true
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      `https://xq8v7un6ad.execute-api.us-east-1.amazonaws.com/prod/course/${courseId}/tee-times?cached=false&date=2026-09-24`
    );
    expect(result.targetDateStatus).toBe("OPEN");
    expect(result.slots).toEqual([{
      courseId: "saved-course", sourceId: `golf-geek-${slotId}`,
      startsAt: "2026-09-24T07:54", availableSpots: 3,
      bookingUrl: `https://booking.gatewaynational.com/booking/2026-09-24/07:54/${publicRateId}/details/`,
      priceCents: 8595,
      evidenceUrl: `https://xq8v7un6ad.execute-api.us-east-1.amazonaws.com/prod/course/${courseId}/tee-times?cached=false&date=2026-09-24`
    }]);
    expect(result.bookingWindowEvidence).toMatchObject({ daysAhead: 14 });
  });

  it.each([[], [
    { ...scopedSlot, freeSlots: 0, rates: undefined },
    { ...scopedSlot, allowedSlots: [1] },
    { ...scopedSlot, rates: [{ name: "Annual Passholder" }] },
  ]].map(data => ({ data })))("recognizes an empty or explicitly filtered public tee sheet %#", async payload => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload)));
    await expect(fetchGolfGeekTeeSheet(input)).resolves.toMatchObject({ slots: [], targetDateStatus: "OPEN" });
  });

  it.each([
    {}, { data: null }, { data: [null] },
    { data: [{ ...scopedSlot, date: "2026-09-25" }] },
    { data: [{ ...scopedSlot, startTime: "24:10" }] },
    { data: [{ ...scopedSlot, courseId: slotId }] },
    { data: [{ ...scopedSlot, freeSlots: 0 }, { ...scopedSlot, rates: [{ name: "Public", price: 85.95 }] }] },
  ])("rejects an incomplete or unscoped public tee sheet %#", async payload => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload)));
    await expect(fetchGolfGeekTeeSheet(input)).rejects.toThrow("unexpected tee-time schema");
  });
});
