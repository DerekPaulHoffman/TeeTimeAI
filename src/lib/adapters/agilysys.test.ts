import { describe, expect, it, vi } from "vitest";

import {
  fetchAgilysysTeeSheet,
  getAgilysysBookingIdentity,
  isAgilysysMetadata,
  normalizeAgilysysBookingUrl,
  type AgilysysMetadata
} from "./agilysys";

const metadata: AgilysysMetadata = {
  provider: "AGILYSYS",
  tenantId: 553,
  propertyId: "biltmorehotel",
  courseId: 560,
  playerTypeId: 2281,
  bookingBaseUrl:
    "https://book.onagilysys.com/onecart/golf/courses/553/biltmorehotel"
};

function jsonResponse(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init
  });
}

describe("Agilysys metadata", () => {
  it("normalizes the exact public course landing without retaining search state", () => {
    expect(
      normalizeAgilysysBookingUrl(
        `${metadata.bookingBaseUrl}?date=2026-07-23&id=560`
      )
    ).toBe(metadata.bookingBaseUrl);
    expect(getAgilysysBookingIdentity(metadata.bookingBaseUrl)).toEqual({
      tenantId: 553,
      propertyId: "biltmorehotel"
    });
    expect(isAgilysysMetadata(metadata)).toBe(true);
  });

  it.each([
    "http://book.onagilysys.com/onecart/golf/courses/553/biltmorehotel",
    "https://user:pass@book.onagilysys.com/onecart/golf/courses/553/biltmorehotel",
    "https://evil.example/onecart/golf/courses/553/biltmorehotel",
    "https://book.onagilysys.com/onecart/golf/courses/553/biltmorehotel?next=https://evil.example",
    "https://book.onagilysys.com/onecart/golf/courses/553/biltmorehotel#checkout",
    "https://book.onagilysys.com/onecart/golf/courses/553/../other"
  ])("rejects an unsafe landing: %s", (value) => {
    expect(normalizeAgilysysBookingUrl(value)).toBeNull();
  });

  it("requires metadata to match the public landing identity", () => {
    expect(isAgilysysMetadata({ ...metadata, tenantId: 554 })).toBe(false);
    expect(isAgilysysMetadata({ ...metadata, propertyId: "other" })).toBe(false);
    expect(isAgilysysMetadata({ ...metadata, courseId: 0 })).toBe(false);
    expect(isAgilysysMetadata({ ...metadata, playerTypeId: 0 })).toBe(false);
    expect(isAgilysysMetadata({ ...metadata, courseIds: [560, 561] })).toBe(true);
    for (const courseIds of [[], [561], [560, 560], [560, -1], [560, 561, 562, 563, 564]]) {
      expect(isAgilysysMetadata({ ...metadata, courseIds })).toBe(false);
    }
  });
});

describe("fetchAgilysysTeeSheet", () => {
  it("reads a bounded club's verified courses with one anonymous bootstrap and distinct identities", async () => {
    const sheet = { success: true, availableTeeSlots: [{ slots: [{
      scheduleDateTime: "2026-07-23T09:15:00", availability: 4, teeTimeId: 123,
      rateType: [{ name: "Public Guest", isPrivate: false, holeType: 18,
        rates: { greenFee: 120, cartFee: 0, otherFee: 0 } }]
    }] }] };
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ success: true, token: "t".repeat(64) }))
      .mockResolvedValueOnce(jsonResponse(sheet)).mockResolvedValueOnce(jsonResponse(sheet));
    const result = await fetchAgilysysTeeSheet({ courseId: "club", date: new Date("2026-07-23T00:00:00Z"),
      players: 3, metadata: { ...metadata, courseIds: [560, 561] } }, fetchImpl as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.get("courseId")).toBe("560");
    expect(new URL(fetchImpl.mock.calls[2][0]).searchParams.get("courseId")).toBe("561");
    expect(result.slots.map(slot => slot.sourceId)).toEqual(["agilysys-553-560-123", "agilysys-553-561-123"]);
    expect(result.slots.map(slot => new URL(slot.bookingUrl).searchParams.get("id"))).toEqual(["560", "561"]);
  });

  it("rejects conditional resort/package rates even when the source marks them non-private", async () => {
    const rate = (name: string, holeType = 18) => ({ name, isPrivate: false, holeType,
      rates: { greenFee: 10, cartFee: 0, otherFee: 0 } });
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ success: true, token: "t".repeat(64) }))
      .mockResolvedValueOnce(jsonResponse({ success: true, availableTeeSlots: [{ slots: [{
        scheduleDateTime: "2026-07-23T09:15:00", availability: 4,
        rateType: [rate("Resort Guest"), rate("MVC Guest"), rate("Bring Your Swing Package", 9),
          rate("Member"), rate("Resident"), { ...rate("Public Guest"), isPrivate: undefined },
          { ...rate("Non-Resident Public"), rates: { greenFee: 100, cartFee: 0, otherFee: 0 } }]
      }] }] }));
    const result = await fetchAgilysysTeeSheet({ courseId: "club", date: new Date("2026-07-23T00:00:00Z"),
      players: 3, metadata }, fetchImpl as typeof fetch);
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0]).toMatchObject({ priceCents: 10000, bookableHoleCounts: [18],
      priceOptions: [{ holes: 18, priceCents: 10000 }] });
  });

  it("does not hide a failed scoped course behind another course's successful response", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ success: true, token: "t".repeat(64) }))
      .mockResolvedValueOnce(jsonResponse({ success: true, availableTeeSlots: [] }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 503 }));
    await expect(fetchAgilysysTeeSheet({ courseId: "club", date: new Date("2026-07-23T00:00:00Z"), players: 2,
      metadata: { ...metadata, courseIds: [560, 561] } }, fetchImpl as typeof fetch)).rejects.toThrow(/503/u);
  });
  it("uses the public session only for a bounded signed-out availability read", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, token: "t".repeat(64) }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        availableTeeSlots: [{
          slots: [{
            scheduleDateTime: "2026-07-23T09:15:00",
            availability: 3,
            teeTimeId: 5359318,
            rateType: [
              {
                id: 1,
                name: "Coral Gables Riding",
                holeType: 18,
                isPrivate: false,
                rates: { greenFee: 85, cartFee: 37, otherFee: 0 }
              },
              {
                id: 2,
                name: "Visitor Riding",
                holeType: 18,
                isPrivate: false,
                rates: { greenFee: 123, cartFee: 37, otherFee: 0 }
              },
              {
                id: 3,
                name: "Member",
                holeType: 9,
                isPrivate: true,
                rates: { greenFee: 10, cartFee: 0, otherFee: 0 }
              }
            ]
          }]
        }]
      }));

    const result = await fetchAgilysysTeeSheet(
      { courseId: "biltmore", date: new Date("2026-07-23T00:00:00Z"), players: 2, metadata },
      fetchImpl as typeof fetch
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://book.onagilysys.com/wbe-admin-service/generatetoken/v2/tenants/553/propertyId/biltmorehotel/appName/NA"
    );
    expect(fetchImpl.mock.calls[1][0]).toContain(
      "/wbe-golf-service/golf/tenants/553/propertyId/biltmorehotel/getAvailableTeeSlots?"
    );
    expect(fetchImpl.mock.calls[1][0]).toContain("courseId=560");
    expect(fetchImpl.mock.calls[1][0]).toContain("playerTypeId=2281");
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({ redirect: "error" });
    expect(fetchImpl.mock.calls[1][1].headers.authorization).toBe(
      `Bearer ${"t".repeat(64)}`
    );
    expect(result).toEqual({
      slots: [{
        courseId: "biltmore",
        sourceId: "agilysys-553-560-5359318",
        startsAt: "2026-07-23T09:15:00",
        availableSpots: 3,
        bookingUrl:
          "https://book.onagilysys.com/onecart/golf/courses/553/biltmorehotel?date=2026-07-23&id=560",
        priceCents: 16000,
        holes: 18,
        bookableHoleCounts: [18],
        priceOptions: [{ holes: 18, priceCents: 16000 }],
        evidenceUrl: expect.stringContaining("getAvailableTeeSlots")
      }],
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null
    });
  });

  it("filters slots that cannot fit the requested party", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, token: "t".repeat(64) }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        availableTeeSlots: [{
          slots: [{
            scheduleDateTime: "2026-07-23T09:15:00",
            availability: 1,
            rateType: [{
              id: 2,
              name: "Visitor",
              holeType: 18,
              isPrivate: false,
              rates: { greenFee: 123, cartFee: 37, otherFee: 0 }
            }]
          }]
        }]
      }));

    await expect(fetchAgilysysTeeSheet(
      { courseId: "biltmore", date: new Date("2026-07-23T00:00:00Z"), players: 2, metadata },
      fetchImpl as typeof fetch
    )).resolves.toMatchObject({ slots: [], targetDateStatus: "UNKNOWN" });
  });

  it("fails closed for invalid public-session and tee-sheet responses", async () => {
    const badTokenFetch = vi.fn().mockResolvedValue(
      jsonResponse({ success: true, token: "short" })
    );
    await expect(fetchAgilysysTeeSheet(
      { courseId: "biltmore", date: new Date("2026-07-23T00:00:00Z"), players: 1, metadata },
      badTokenFetch as typeof fetch
    )).rejects.toThrow("public session returned an invalid response");

    const badSlotsFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, token: "t".repeat(64) }))
      .mockResolvedValueOnce(jsonResponse({ success: false }));
    await expect(fetchAgilysysTeeSheet(
      { courseId: "biltmore", date: new Date("2026-07-23T00:00:00Z"), players: 1, metadata },
      badSlotsFetch as typeof fetch
    )).rejects.toThrow("tee times returned an invalid response");
  });
});
