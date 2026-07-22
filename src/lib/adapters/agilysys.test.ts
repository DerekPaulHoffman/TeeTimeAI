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
  });
});

describe("fetchAgilysysTeeSheet", () => {
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
