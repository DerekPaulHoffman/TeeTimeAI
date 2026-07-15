import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchCpsSlots, fetchCpsTeeSheet, isCpsMetadata } from "./cps";

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
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
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
        const headers = init?.headers as Record<string, string>;
        expect(headers["x-timezoneid"]).toBe("America/Denver");
        expect(headers["x-timezone-offset"]).toBe("360");
        const teeTimesUrl = new URL(url);
        expect(teeTimesUrl.searchParams.get("searchDate")).toBe("Sat Jul 11 2026");
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
              startTime: "2026-07-11T09:20:00",
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
      date: new Date("2026-07-11T00:00:00.000Z"),
      players: 4,
      timeZone: "America/Denver",
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
        startsAt: "2026-07-11T09:20",
        availableSpots: 4,
        bookingUrl: "https://traditionoaklane.cps.golf/?date=2026-07-11",
        priceCents: 8900,
        holes: 9
      })
    ]);
  });

  it("uses the provider-published public API key without a token or transaction", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input.toString();

      if (url.endsWith("/onlineresweb/Home/Configuration")) {
        return jsonResponse({
          clientId: "onlineresweb",
          authorityBaseUrl: "https://yarmouthpublic.cps.golf/identityapi",
          onlineApi:
            "https://yarmouthpublic.cps.golf/onlineres/onlineapi/api/v1/onlinereservation",
          websiteId: "00000000-0000-0000-0000-000000000000",
          siteName: "yarmouthpublic",
          apiKey: "provider-published-key",
          buildNumber: "25.2.5.56816\n"
        });
      }

      if (url.includes("/GetAllOptions/yarmouthpublic?")) {
        const headers = init?.headers as Record<string, string>;
        expect(headers["x-apikey"]).toBe("provider-published-key");
        expect(headers["x-websiteid"]).toBe("00000000-0000-0000-0000-000000000000");
        expect(new URL(url).searchParams.get("version")).toBe("25.2.5.56816");
        return jsonResponse({
          webSiteId: "2907d844-40d7-464a-bd26-08da5b6b6bfb",
          reservationOptions: { terminalId: 3 }
        });
      }

      if (url.includes("/TeeTimes?")) {
        const headers = init?.headers as Record<string, string>;
        expect(headers.authorization).toBeUndefined();
        expect(headers["x-apikey"]).toBe("provider-published-key");
        expect(headers["x-websiteid"]).toBe("2907d844-40d7-464a-bd26-08da5b6b6bfb");
        expect(headers["x-terminalid"]).toBe("3");
        const teeTimesUrl = new URL(url);
        expect(teeTimesUrl.searchParams.has("transactionId")).toBe(false);
        expect(teeTimesUrl.searchParams.get("holes")).toBe("0");
        expect(teeTimesUrl.searchParams.get("numberOfPlayer")).toBe("0");
        return jsonResponse([
          {
            teeSheetId: 456,
            startTime: "2026-07-18T16:36:00",
            availableParticipantNo: [1, 2, 3, 4],
            holes: 18,
            teeSheetPrice: 50
          }
        ]);
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const slots = await fetchCpsSlots({
      courseId: "bayberry",
      date: new Date("2026-07-18T00:00:00.000Z"),
      players: 4,
      timeZone: "America/New_York",
      metadata: {
        provider: "CPS",
        siteName: "yarmouthpublic",
        bookingBaseUrl: "https://yarmouthpublic.cps.golf/",
        courseIds: [2, 4],
        holes: [18, 9]
      }
    });

    expect(fetchMock.mock.calls.some(([input]) => input.toString().includes("token/short"))).toBe(
      false
    );
    expect(
      fetchMock.mock.calls.some(([input]) => input.toString().includes("RegisterTransactionId"))
    ).toBe(false);
    expect(slots).toEqual([
      expect.objectContaining({
        courseId: "bayberry",
        sourceId: "cps-yarmouthpublic-456",
        availableSpots: 4,
        priceCents: 5000,
        holes: 18
      })
    ]);
  });

  it("learns the public booking window from CPS booking-rule configuration", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input.toString();

      if (url.endsWith("/onlineresweb/Home/Configuration")) {
        return jsonResponse({
          clientId: "onlineresweb",
          authorityBaseUrl: "https://shennecossett.cps.golf/identityapi",
          onlineApi:
            "https://shennecossett.cps.golf/onlineres/onlineapi/api/v1/onlinereservation",
          websiteId: "00000000-0000-0000-0000-000000000000",
          siteName: "shennecossett",
          buildNumber: "26.1.2.26379768992\n"
        });
      }

      if (url.endsWith("/identityapi/myconnect/token/short")) {
        return jsonResponse({ access_token: "token" });
      }

      if (url.includes("/GetAllOptions/shennecossett?")) {
        const headers = init?.headers as Record<string, string>;
        expect(headers.authorization).toBe("Bearer token");
        expect(headers["x-websiteid"]).toBe("00000000-0000-0000-0000-000000000000");
        expect(new URL(url).searchParams.get("version")).toBe("26.1.2.26379768992");
        return jsonResponse({
          webSiteId: "ee8d09d9-2ab6-4349-c825-08dec0b787e5",
          reservationOptions: { terminalId: 3 }
        });
      }

      if (url.includes("/BookingRuleModels?")) {
        const headers = init?.headers as Record<string, string>;
        expect(headers["x-websiteid"]).toBe("ee8d09d9-2ab6-4349-c825-08dec0b787e5");
        expect(headers["x-terminalid"]).toBe("3");
        const bookingRuleUrl = new URL(url);
        expect(bookingRuleUrl.searchParams.get("classcode")).toBe("R");
        expect(bookingRuleUrl.searchParams.get("courseIds")).toBe("1,2");
        expect(bookingRuleUrl.searchParams.get("searchDate")).toBe("Wed Jul 22 2026");
        return jsonResponse({
          bookingRuleByClass: [
            {
              classCode: "R",
              bookingRuleByCourse: [
                {
                  courseId: 1,
                  daysInAdvance: 7,
                  daysInAdvanceWeekend: 7,
                  time: "2026-06-08T20:00:00"
                }
              ]
            }
          ],
          bookingRuleByCourses: [{ courseId: 1, daysInAdvance: 7 }],
          weekends: ["Friday", "Saturday", "Sunday"]
        });
      }

      if (url.endsWith("/RegisterTransactionId")) {
        return jsonResponse(true);
      }

      if (url.includes("/TeeTimes?")) {
        const teeTimesUrl = new URL(url);
        if (teeTimesUrl.searchParams.get("holes") === "18") {
          return jsonResponse({
            transactionId: "tx",
            content: [
              {
                teeSheetId: 789,
                startTime: "2026-07-22T08:00:00",
                availableParticipantNo: [1, 2, 3, 4],
                holes: 18
              }
            ]
          });
        }
        return jsonResponse({ transactionId: "tx", content: [] });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await fetchCpsTeeSheet({
      courseId: "shennecossett",
      date: new Date("2026-07-22T00:00:00.000Z"),
      players: 4,
      timeZone: "America/New_York",
      metadata: {
        provider: "CPS",
        siteName: "shennecossett",
        bookingBaseUrl: "https://shennecossett.cps.golf/",
        courseIds: [1, 2],
        holes: [18, 9]
      },
      discoverBookingWindow: true
    });

    expect(result.slots).toEqual([
      expect.objectContaining({
        sourceId: "cps-shennecossett-789",
        startsAt: "2026-07-22T08:00",
        availableSpots: 4
      })
    ]);
    expect(result.bookingWindowEvidence).toEqual({
      daysAhead: 7,
      releaseTimeLocal: "20:00",
      source: "PROVIDER_CONFIG",
      confidence: 1,
      evidenceUrl: expect.stringContaining("/BookingRuleModels?")
    });
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
