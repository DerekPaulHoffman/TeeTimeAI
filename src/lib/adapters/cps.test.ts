import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchCpsSlots, isCpsMetadata } from "./cps";

describe("isCpsMetadata", () => {
  it("recognizes reusable CPS metadata", () => {
    expect(
      isCpsMetadata({
        provider: "CPS",
        siteName: "traditionoaklane",
        bookingBaseUrl: "https://traditionoaklane.cps.golf/",
        courseIds: [1, 2]
      })
    ).toBe(true);
  });
});

describe("fetchCpsSlots", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a transaction and maps CPS tee times", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input.toString();

      if (url.endsWith("/onlineresweb/Home/Configuration")) {
        return jsonResponse({
          clientId: "onlineresweb",
          authorityBaseUrl: "https://traditionoaklane.cps.golf/identityapi",
          onlineApi:
            "https://traditionoaklane.cps.golf/onlineres/onlineapi/api/v1/onlinereservation",
          websiteId: "00000000-0000-0000-0000-000000000000",
          siteName: "traditionoaklane"
        });
      }

      if (url.endsWith("/identityapi/myconnect/token/short")) {
        return jsonResponse({ access_token: "token" });
      }

      if (url.endsWith("/RegisterTransactionId")) {
        return jsonResponse(true);
      }

      if (url.includes("/TeeTimes?")) {
        const teeTimesUrl = new URL(url);
        expect(teeTimesUrl.searchParams.get("courseIds")).toBe("1,2");
        expect(teeTimesUrl.searchParams.get("teeOffTimeMin")).toBe("0");
        expect(teeTimesUrl.searchParams.get("teeOffTimeMax")).toBe("23");
        expect(teeTimesUrl.searchParams.get("isChangeTeeOffTime")).toBe("true");
        expect(teeTimesUrl.searchParams.get("teeSheetSearchView")).toBe("5");

        if (teeTimesUrl.searchParams.get("holes") === "18") {
          return jsonResponse({
            transactionId: "tx",
            content: {
              messageKey: "NO_TEETIMES",
              messageDetail: "No tee times available,please try different criteria."
            }
          });
        }

        expect(teeTimesUrl.searchParams.get("holes")).toBe("9");
        return jsonResponse({
          transactionId: "tx",
          content: [
            {
              teeSheetId: 123,
              startTime: "2026-07-10T09:20:00",
              availableParticipantNo: [1, 2, 3, 4],
              holes: 9,
              teeSheetPrice: 89
            }
          ]
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const slots = await fetchCpsSlots({
      courseId: "course-1",
      date: new Date("2026-07-10T12:00:00-04:00"),
      players: 4,
      metadata: {
        provider: "CPS",
        siteName: "traditionoaklane",
        bookingBaseUrl: "https://traditionoaklane.cps.golf/",
        courseIds: [1, 2]
      }
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://traditionoaklane.cps.golf/onlineres/onlineapi/api/v1/onlinereservation/RegisterTransactionId",
      expect.objectContaining({ method: "POST" })
    );
    expect(slots).toEqual([
      expect.objectContaining({
        courseId: "course-1",
        sourceId: "cps-traditionoaklane-123",
        startsAt: "2026-07-10T09:20",
        availableSpots: 4,
        bookingUrl: "https://traditionoaklane.cps.golf/?date=2026-07-10",
        priceCents: 8900,
        holes: 9
      })
    ]);
  });
});

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}
