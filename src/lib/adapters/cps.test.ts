import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchCpsSlots,
  fetchCpsTeeSheet,
  isCpsMetadata
} from "./cps";

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
            isSuccess: true,
            content: {
              messageKey: "NO_TEETIMES",
              messageTemplate: "No tee times available",
              messageAppearance:
                "Appears on the tee sheet when there are no tee times available on a selected day",
              messageDetail:
                "No tee times available,please try different criteria.",
              messageType: "Attention"
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

  it("retries a nested Undici availability timeout without repeating the transaction", async () => {
    const teeTimeSignals: Array<AbortSignal | null | undefined> = [];
    const teeTimeUrls: string[] = [];
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
        teeTimeUrls.push(url);
        teeTimeSignals.push(init?.signal);
        const holes = new URL(url).searchParams.get("holes");
        if (holes === "18" && teeTimeUrls.length === 1) {
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            json: vi.fn().mockRejectedValue(
              nestedFetchError(
                new AggregateError([
                  Object.assign(new Error("CPS response body timed out"), {
                    code: "UND_ERR_BODY_TIMEOUT"
                  })
                ])
              )
            )
          } as unknown as Response;
        }
        if (holes === "18") {
          return jsonResponse({
            transactionId: "tx",
            content: [
              {
                teeSheetId: 901,
                startTime: "2026-07-18T08:40:00",
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

    const slots = await fetchCpsSlots({
      courseId: "tradition-oak-lane",
      date: new Date("2026-07-18T00:00:00.000Z"),
      players: 4,
      timeZone: "America/New_York",
      metadata: {
        provider: "CPS",
        siteName: "traditionoaklane",
        bookingBaseUrl: "https://traditionoaklane.cps.golf/",
        courseIds: [1],
        holes: [18, 9]
      }
    });

    expect(teeTimeUrls.map((url) => new URL(url).searchParams.get("holes"))).toEqual([
      "18",
      "18",
      "9"
    ]);
    expect(teeTimeUrls[1]).toBe(teeTimeUrls[0]);
    expect(teeTimeSignals[0]).toBeInstanceOf(AbortSignal);
    expect(teeTimeSignals[1]).toBeInstanceOf(AbortSignal);
    expect(teeTimeSignals[1]).not.toBe(teeTimeSignals[0]);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        input.toString().endsWith("/RegisterTransactionId")
      )
    ).toHaveLength(2);
    expect(slots).toEqual([
      expect.objectContaining({
        sourceId: "cps-traditionoaklane-901",
        availableSpots: 4,
        holes: 18
      })
    ]);
  });

  it("retries an AbortError from an idempotent CPS read", async () => {
    let configurationAttempts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input.toString();

      if (url.endsWith("/onlineresweb/Home/Configuration")) {
        configurationAttempts += 1;
        if (configurationAttempts === 1) {
          throw new DOMException("The CPS configuration read was aborted", "AbortError");
        }
        return jsonResponse(cpsConfiguration());
      }

      if (url.endsWith("/identityapi/myconnect/token/short")) {
        return jsonResponse({ access_token: "token" });
      }

      if (url.endsWith("/RegisterTransactionId")) {
        return jsonResponse(true);
      }

      if (url.includes("/TeeTimes?")) {
        return jsonResponse({ transactionId: "tx", content: [] });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(fetchCpsSlots(cpsInput({ holes: [18] }))).resolves.toEqual([]);
    expect(configurationAttempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it.each([
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "ETIMEDOUT"
  ])("retries the exact nested timeout code %s", async (code) => {
    let configurationAttempts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input.toString();
      if (url.endsWith("/onlineresweb/Home/Configuration")) {
        configurationAttempts += 1;
        if (configurationAttempts === 1) {
          throw nestedFetchError(
            Object.assign(new Error("nested provider failure"), { code })
          );
        }
        return jsonResponse(cpsConfiguration());
      }
      if (url.endsWith("/identityapi/myconnect/token/short")) {
        return jsonResponse({ access_token: "token" });
      }
      if (url.endsWith("/RegisterTransactionId")) {
        return jsonResponse(true);
      }
      if (url.includes("/TeeTimes?")) {
        return jsonResponse({ transactionId: "tx", content: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(fetchCpsSlots(cpsInput({ holes: [18] }))).resolves.toEqual([]);
    expect(configurationAttempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("fails closed when 18-hole coverage succeeds but the 9-hole retry is exhausted", async () => {
    const teeTimeUrls: string[] = [];
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
        teeTimeUrls.push(url);
        if (new URL(url).searchParams.get("holes") === "18") {
          return jsonResponse({
            transactionId: "tx",
            content: [
              {
                teeSheetId: 902,
                startTime: "2026-07-18T08:40:00",
                availableParticipantNo: [1, 2, 3, 4],
                holes: 18
              }
            ]
          });
        }
        throw cpsTimeoutError();
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    const error = await fetchCpsTeeSheet({
      courseId: "tradition-oak-lane",
      date: new Date("2026-07-18T00:00:00.000Z"),
      players: 4,
      metadata: {
        provider: "CPS",
        siteName: "traditionoaklane",
        bookingBaseUrl: "https://traditionoaklane.cps.golf/",
        courseIds: [1],
        holes: [18, 9]
      }
    }).catch((caught) => caught);

    expect(error).toEqual(expect.objectContaining({ name: "TimeoutError" }));
    expect(teeTimeUrls).toHaveLength(3);
    expect(
      teeTimeUrls.map((url) => new URL(url).searchParams.get("holes"))
    ).toEqual(["18", "9", "9"]);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        input.toString().endsWith("/RegisterTransactionId")
      )
    ).toHaveLength(2);
  });

  it("accepts the exact bounded CPS no-tee-times sentinel as empty coverage", async () => {
    const teeTimeUrls: string[] = [];
    mockPersistedCpsFetch((url) => {
      teeTimeUrls.push(url.toString());
      return jsonResponse({
        transactionId: "tx",
        isSuccess: true,
        content: {
          messageKey: "NO_TEETIMES",
          messageTemplate: "No tee times available",
          messageAppearance:
            "Appears on the tee sheet when there are no tee times available on a selected day",
          messageDetail: "No tee times available,please try different criteria.",
          messageType: "Attention"
        }
      });
    });

    await expect(
      fetchCpsTeeSheet(persistedCpsInput({ holes: [18, 9] }))
    ).resolves.toEqual({
      slots: [],
      targetDateStatus: "UNKNOWN",
      bookingWindowEvidence: null
    });
    expect(
      teeTimeUrls.map((url) => new URL(url).searchParams.get("holes"))
    ).toEqual(["18", "9"]);
  });

  it.each([
    {
      name: "a false success flag",
      payload: cpsNoTeeTimesResponse({ envelope: { isSuccess: false } })
    },
    {
      name: "a missing success flag",
      payload: cpsNoTeeTimesResponse({ envelope: { isSuccess: undefined } })
    },
    {
      name: "an extra top-level error",
      payload: cpsNoTeeTimesResponse({ envelope: { error: "UPSTREAM_FAILURE" } })
    },
    {
      name: "an invalid transaction identifier",
      payload: cpsNoTeeTimesResponse({ envelope: { transactionId: null } })
    },
    {
      name: "a different message template",
      payload: cpsNoTeeTimesResponse({
        content: { messageTemplate: "Inventory unavailable" }
      })
    },
    {
      name: "a different message appearance",
      payload: cpsNoTeeTimesResponse({
        content: { messageAppearance: "Hidden provider error" }
      })
    },
    {
      name: "a different message type",
      payload: cpsNoTeeTimesResponse({ content: { messageType: "Error" } })
    },
    {
      name: "a missing detail",
      payload: cpsNoTeeTimesResponse({ content: { messageDetail: undefined } })
    },
    {
      name: "a contradictory availability count",
      payload: cpsNoTeeTimesResponse({ content: { availableCount: 4 } })
    }
  ])("rejects a no-tee-times envelope with $name", async ({ payload }) => {
    mockPersistedCpsFetch(() => jsonResponse(payload));

    await expect(
      fetchCpsTeeSheet(persistedCpsInput({ holes: [18] }))
    ).rejects.toThrow("CPS tee times returned an invalid response schema");
  });

  it("rejects a near-miss 18-hole CPS sentinel instead of reporting no match", async () => {
    const teeTimeUrls: string[] = [];
    const fetchMock = mockPersistedCpsFetch((url) => {
      teeTimeUrls.push(url.toString());
      return jsonResponse({
        transactionId: "tx",
        content: { messageKey: "NO_TEE_TIMES" }
      });
    });

    await expect(
      fetchCpsTeeSheet(persistedCpsInput({ holes: [18] }))
    ).rejects.toThrow("CPS tee times returned an invalid response schema");
    expect(
      teeTimeUrls.map((url) => new URL(url).searchParams.get("holes"))
    ).toEqual(["18"]);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        input.toString().endsWith("/RegisterTransactionId")
      )
    ).toHaveLength(1);
  });

  it.each([
    {
      name: "an extra field",
      content: {
        messageKey: "NO_TEETIMES",
        messageDetail: "No tee times available.",
        slots: []
      }
    },
    {
      name: "a non-string detail",
      content: { messageKey: "NO_TEETIMES", messageDetail: null }
    },
    {
      name: "an oversized detail",
      content: { messageKey: "NO_TEETIMES", messageDetail: "x".repeat(513) }
    },
    {
      name: "different detail text",
      content: {
        messageKey: "NO_TEETIMES",
        messageDetail: "No inventory was returned."
      }
    },
    {
      name: "nested metadata",
      content: {
        messageKey: "NO_TEETIMES",
        messageDetail: "No tee times available,please try different criteria.",
        metadata: { retryable: false }
      }
    },
    {
      name: "too many metadata fields",
      content: {
        messageKey: "NO_TEETIMES",
        messageDetail: "No tee times available,please try different criteria.",
        first: true,
        second: false,
        third: 1,
        fourth: 2
      }
    },
    {
      name: "oversized string metadata",
      content: {
        messageKey: "NO_TEETIMES",
        messageDetail: "No tee times available,please try different criteria.",
        metadata: "x".repeat(129)
      }
    }
  ])("rejects a malformed CPS no-tee-times sentinel with $name", async ({ content }) => {
    mockPersistedCpsFetch(() =>
      jsonResponse({ transactionId: "tx", isSuccess: true, content })
    );

    await expect(
      fetchCpsTeeSheet(persistedCpsInput({ holes: [18] }))
    ).rejects.toThrow("CPS tee times returned an invalid response schema");
  });

  it("records only bounded structural diagnostics for an invalid CPS response", async () => {
    const secretDetail =
      "https://private.example/booking?token=provider-secret-value";
    const secretMessageKey = "PROVIDER_SECRET_ABC123";
    mockPersistedCpsFetch(() =>
      jsonResponse({
        transactionId: "private-transaction-value",
        PROVIDER_SECRET_FIELD_ABC123: "provider-secret-value",
        content: {
          messageKey: secretMessageKey,
          messageDetail: secretDetail,
          PROVIDER_SECRET_PROPERTY_ABC123: "provider-secret-value"
        }
      })
    );

    const outcome = await fetchCpsTeeSheet(
      persistedCpsInput({ holes: [18] })
    ).catch((caught: unknown) => caught);
    if (!(outcome instanceof Error)) {
      throw new Error("Expected the malformed CPS response to fail");
    }

    expect(outcome.message).toContain(
      "topLevel=object;topKeys=content,transactionId,+1;content=object"
    );
    expect(outcome.message).toContain(
      `messageKey=string:length=${secretMessageKey.length}`
    );
    expect(outcome.message).toContain(
      `messageDetail=string:length=${secretDetail.length}`
    );
    expect(outcome.message).not.toContain(secretDetail);
    expect(outcome.message).not.toContain(secretMessageKey);
    expect(outcome.message).not.toContain("PROVIDER_SECRET_FIELD_ABC123");
    expect(outcome.message).not.toContain("PROVIDER_SECRET_PROPERTY_ABC123");
    expect(outcome.message).not.toContain("private-transaction-value");
    expect(outcome.message).not.toContain("provider-secret-value");
    expect(outcome.message.length).toBeLessThan(400);
  });

  it("records only the allowlisted no-tee-times protocol code", async () => {
    mockPersistedCpsFetch(() =>
      jsonResponse({
        transactionId: "tx",
        content: {
          messageKey: "NO_TEETIMES",
          messageDetail: null
        }
      })
    );

    const outcome = await fetchCpsTeeSheet(
      persistedCpsInput({ holes: [18] })
    ).catch((caught: unknown) => caught);
    if (!(outcome instanceof Error)) {
      throw new Error("Expected the invalid CPS response to fail");
    }

    expect(outcome.message).toContain("messageKey=NO_TEETIMES");
    expect(outcome.message).toContain("messageDetail=null");
  });

  it("rejects the whole CPS result when 18 holes succeed but 9 holes return invalid schema", async () => {
    const teeTimeUrls: string[] = [];
    mockPersistedCpsFetch((url) => {
      teeTimeUrls.push(url.toString());
      if (url.searchParams.get("holes") === "18") {
        return jsonResponse({
          transactionId: "tx",
          content: [
            {
              teeSheetId: 903,
              startTime: "2026-07-18T09:10:00",
              availableParticipantNo: [1, 2, 3, 4],
              holes: 18
            }
          ]
        });
      }
      return jsonResponse({ transactionId: "tx", unexpected: true });
    });

    const outcome = await fetchCpsTeeSheet(
      persistedCpsInput({ holes: [18, 9] })
    ).catch((error) => error);

    expect(outcome).toEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          "CPS tee times returned an invalid response schema"
        )
      })
    );
    expect(outcome).not.toEqual(
      expect.objectContaining({
        slots: expect.arrayContaining([
          expect.objectContaining({ sourceId: "cps-traditionoaklane-903" })
        ])
      })
    );
    expect(
      teeTimeUrls.map((url) => new URL(url).searchParams.get("holes"))
    ).toEqual(["18", "9"]);
  });

  it("rejects invalid payloads on the default both-hole CPS path", async () => {
    const teeTimeUrls: string[] = [];
    mockPersistedCpsFetch((url) => {
      teeTimeUrls.push(url.toString());
      return jsonResponse({ transactionId: "tx", content: null });
    });

    await expect(fetchCpsTeeSheet(persistedCpsInput())).rejects.toThrow(
      "CPS tee times returned an invalid response schema"
    );
    expect(
      teeTimeUrls.map((url) => new URL(url).searchParams.get("holes"))
    ).toEqual(["18"]);
  });

  it("does not retry a nested non-timeout fetch failure", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(
      nestedFetchError(
        Object.assign(new Error("socket reset"), { code: "ECONNRESET" })
      )
    );

    await expect(fetchCpsSlots(cpsInput())).rejects.toMatchObject({
      name: "TypeError",
      message: "fetch failed"
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retries one timed-out short-lived CPS token request", async () => {
    let tokenAttempts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input.toString();
      if (url.endsWith("/identityapi/myconnect/token/short")) {
        tokenAttempts += 1;
        if (tokenAttempts === 1) {
          throw cpsTimeoutError();
        }
        return jsonResponse({ access_token: "token" });
      }
      if (url.endsWith("/RegisterTransactionId")) {
        return jsonResponse(true);
      }
      if (url.includes("/TeeTimes?")) {
        return jsonResponse({ transactionId: "tx", content: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(fetchCpsSlots(persistedCpsInput())).resolves.toEqual([]);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        input.toString().endsWith("/identityapi/myconnect/token/short")
      )
    ).toHaveLength(2);
  });

  it("retries one transient CPS token 503 and then continues", async () => {
    let tokenAttempts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input.toString();
      if (url.endsWith("/identityapi/myconnect/token/short")) {
        tokenAttempts += 1;
        return tokenAttempts === 1
          ? new Response("Unavailable", { status: 503 })
          : jsonResponse({ access_token: "token" });
      }
      if (url.endsWith("/RegisterTransactionId")) {
        return jsonResponse(true);
      }
      if (url.includes("/TeeTimes?")) {
        return jsonResponse({ transactionId: "tx", content: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(fetchCpsSlots(persistedCpsInput())).resolves.toEqual([]);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        input.toString().endsWith("/identityapi/myconnect/token/short")
      )
    ).toHaveLength(2);
  });

  it("recovers exhausted transient CPS token failures through a published API key", async () => {
    let tokenAttempts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input.toString();
      if (url.endsWith("/identityapi/myconnect/token/short")) {
        tokenAttempts += 1;
        return new Response("Unavailable", { status: 503 });
      }
      if (url.endsWith("/onlineresweb/Home/Configuration")) {
        expect(init?.redirect).toBe("manual");
        const configuration = cpsConfiguration();
        return jsonResponse({
          ...configuration,
          authorityBaseUrl: `${configuration.authorityBaseUrl}/`,
          onlineApi: `${configuration.onlineApi}/`,
          apiKey: " provider-published-key "
        });
      }
      if (url.includes("/GetAllOptions/traditionoaklane?")) {
        const headers = init?.headers as Record<string, string>;
        expect(headers["x-apikey"]).toBe("provider-published-key");
        expect(headers.authorization).toBeUndefined();
        return jsonResponse({
          webSiteId: "published-website-id",
          reservationOptions: { terminalId: 3 }
        });
      }
      if (url.includes("/TeeTimes?")) {
        const headers = init?.headers as Record<string, string>;
        expect(headers["x-apikey"]).toBe("provider-published-key");
        expect(headers["x-websiteid"]).toBe("published-website-id");
        expect(headers.authorization).toBeUndefined();
        expect(new URL(url).searchParams.get("holes")).toBe("0");
        return jsonResponse([]);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(fetchCpsSlots(persistedCpsInput())).resolves.toEqual([]);
    expect(tokenAttempts).toBe(2);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        input.toString().endsWith("/onlineresweb/Home/Configuration")
      )
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        input.toString().endsWith("/RegisterTransactionId")
      )
    ).toBe(false);
  });

  it("preserves the exhausted token error when recovered API-key setup fails", async () => {
    let tokenAttempts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input.toString();
      if (url.endsWith("/identityapi/myconnect/token/short")) {
        tokenAttempts += 1;
        return new Response("Token unavailable", {
          status: tokenAttempts === 1 ? 503 : 504
        });
      }
      if (url.endsWith("/onlineresweb/Home/Configuration")) {
        return jsonResponse({
          ...cpsConfiguration(),
          apiKey: "provider-published-key"
        });
      }
      if (url.includes("/GetAllOptions/traditionoaklane?")) {
        return new Response("Options unavailable", { status: 500 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(fetchCpsSlots(persistedCpsInput())).rejects.toThrow(
      "CPS token returned 504"
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(
      fetchMock.mock.calls.some(([input]) => input.toString().includes("/TeeTimes?"))
    ).toBe(false);
  });

  it("rejects a redirected published-key configuration without following it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input, init) => {
        const url = input.toString();
        if (url.endsWith("/identityapi/myconnect/token/short")) {
          return new Response("Token unavailable", { status: 503 });
        }
        if (url.endsWith("/onlineresweb/Home/Configuration")) {
          expect(init?.redirect).toBe("manual");
          return new Response(null, {
            status: 302,
            headers: { location: "https://other-tenant.cps.golf/configuration" }
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }
    );

    await expect(fetchCpsSlots(persistedCpsInput())).rejects.toThrow(
      "CPS token returned 503"
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["HTTP", "http://traditionoaklane.cps.golf/"],
    ["an IP literal", "https://127.0.0.1/"],
    ["a private hostname", "https://provider.internal/"],
    ["a trailing-dot private hostname", "https://localhost./"],
    ["a cross-host tenant", "https://other-tenant.cps.golf/"],
    ["credentials", "https://user:pass@traditionoaklane.cps.golf/"],
    ["empty userinfo", "https://@traditionoaklane.cps.golf/"],
    ["an explicit default port", "https://traditionoaklane.cps.golf:443/"],
    ["an explicit non-default port", "https://traditionoaklane.cps.golf:444/"]
  ])(
    "rejects %s in the published-key configuration source before fetching it",
    async (_description, bookingBaseUrl) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = input.toString();
        if (url.endsWith("/identityapi/myconnect/token/short")) {
          return new Response("Token unavailable", { status: 503 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      await expect(
        fetchCpsSlots(persistedCpsInput({ bookingBaseUrl }))
      ).rejects.toThrow("CPS token returned 503");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  );

  it.each([
    ["client id", { clientId: "other-client" }],
    ["website id", { websiteId: "other-website" }],
    ["site name", { siteName: "other-tenant" }],
    [
      "authority host",
      { authorityBaseUrl: "https://other-tenant.cps.golf/identityapi" }
    ],
    [
      "online API host",
      {
        onlineApi:
          "https://other-tenant.cps.golf/onlineres/onlineapi/api/v1/onlinereservation"
      }
    ],
    [
      "credentialed authority URL",
      {
        authorityBaseUrl:
          "https://user:pass@traditionoaklane.cps.golf/identityapi"
      }
    ],
    [
      "ported online API URL",
      {
        onlineApi:
          "https://traditionoaklane.cps.golf:443/onlineres/onlineapi/api/v1/onlinereservation"
      }
    ],
    [
      "HTTP authority URL",
      { authorityBaseUrl: "http://traditionoaklane.cps.golf/identityapi" }
    ],
    [
      "IP online API URL",
      { onlineApi: "https://127.0.0.1/onlineres/onlineapi/api/v1/onlinereservation" }
    ]
  ])(
    "rejects a published-key configuration with a mismatched or unsafe %s",
    async (_description, configurationOverrides) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = input.toString();
        if (url.endsWith("/identityapi/myconnect/token/short")) {
          return new Response("Token unavailable", { status: 503 });
        }
        if (url.endsWith("/onlineresweb/Home/Configuration")) {
          return jsonResponse({
            ...cpsConfiguration(),
            apiKey: "provider-published-key",
            ...configurationOverrides
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      await expect(fetchCpsSlots(persistedCpsInput())).rejects.toThrow(
        "CPS token returned 503"
      );
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }
  );

  it("preserves the original token error when the published-key fallback is non-OK", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input.toString();
      return url.endsWith("/identityapi/myconnect/token/short")
        ? new Response("Token unavailable", { status: 503 })
        : new Response("Configuration unavailable", { status: 500 });
    });

    await expect(fetchCpsSlots(persistedCpsInput())).rejects.toThrow(
      "CPS token returned 503"
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["has no published API key", () => jsonResponse(cpsConfiguration())],
    ["has an invalid configuration shape", () => jsonResponse({ apiKey: "published-key" })],
    ["times out", () => Promise.reject(cpsTimeoutError())]
  ])(
    "preserves the original token error when the published-key fallback %s",
    async (_description, fallbackResponse) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = input.toString();
        if (url.endsWith("/identityapi/myconnect/token/short")) {
          return new Response("Token unavailable", { status: 503 });
        }
        if (url.endsWith("/onlineresweb/Home/Configuration")) {
          return fallbackResponse();
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      await expect(fetchCpsSlots(persistedCpsInput())).rejects.toThrow(
        "CPS token returned 503"
      );
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }
  );

  it("preserves the original timeout error when published-key recovery is unusable", async () => {
    let tokenAttempts = 0;
    const originalTimeout = cpsTimeoutError();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input.toString();
      if (url.endsWith("/identityapi/myconnect/token/short")) {
        tokenAttempts += 1;
        throw originalTimeout;
      }
      if (url.endsWith("/onlineresweb/Home/Configuration")) {
        return jsonResponse(cpsConfiguration());
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(fetchCpsSlots(persistedCpsInput())).rejects.toBe(originalTimeout);
    expect(tokenAttempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([401, 429])("does not retry a CPS token HTTP %s response", async (status) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Rejected", { status })
    );

    await expect(fetchCpsSlots(persistedCpsInput())).rejects.toThrow(
      `CPS token returned ${status}`
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        input.toString().endsWith("/onlineresweb/Home/Configuration")
      )
    ).toBe(false);
  });

  it("does not retry a CPS token response with no access token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({})
    );

    await expect(fetchCpsSlots(persistedCpsInput())).rejects.toThrow(
      "CPS token response did not include an access token"
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        input.toString().endsWith("/onlineresweb/Home/Configuration")
      )
    ).toBe(false);
  });

  it("does not use published-key fallback for an invalid CPS token JSON schema", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    await expect(fetchCpsSlots(persistedCpsInput())).rejects.toBeInstanceOf(
      SyntaxError
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps a timed-out CPS transaction registration POST single-attempt", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input.toString();
      if (url.endsWith("/onlineresweb/Home/Configuration")) {
        return jsonResponse(cpsConfiguration());
      }
      if (url.endsWith("/identityapi/myconnect/token/short")) {
        return jsonResponse({ access_token: "token" });
      }
      if (url.endsWith("/RegisterTransactionId")) {
        throw cpsTimeoutError();
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(fetchCpsSlots(persistedCpsInput())).rejects.toMatchObject({
      name: "TimeoutError"
    });
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        input.toString().endsWith("/RegisterTransactionId")
      )
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.some(([input]) => input.toString().includes("/TeeTimes?"))
    ).toBe(false);
  });

  it("does not retry a non-timeout CPS HTTP failure", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unavailable", { status: 503 })
    );

    await expect(
      fetchCpsSlots({
        courseId: "provider-unavailable",
        date: new Date("2026-07-18T00:00:00.000Z"),
        players: 2,
        metadata: {
          provider: "CPS",
          siteName: "provider-unavailable",
          bookingBaseUrl: "https://provider-unavailable.cps.golf/",
          courseIds: [1]
        }
      })
    ).rejects.toThrow("CPS configuration returned 503");
    expect(fetchMock).toHaveBeenCalledOnce();
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
    let completedHoleSearches = 0;
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
        expect(completedHoleSearches).toBe(2);
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
        completedHoleSearches += 1;
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

  it.each([401, 403])(
    "preserves the CPS configuration HTTP %i failure without fetching policy text",
    async (status) => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input) => {
          const url = input.toString();
          if (url.endsWith("/onlineresweb/Home/Configuration")) {
            return new Response("Access denied", { status });
          }
          throw new Error(`Unexpected fetch: ${url}`);
        });

      await expect(
        fetchCpsSlots({
          courseId: "access-failed",
          date: new Date("2026-07-18T00:00:00.000Z"),
          players: 2,
          metadata: {
            provider: "CPS",
            siteName: "access-failed",
            bookingBaseUrl: "https://access-failed.cps.golf/",
            courseIds: [1]
          }
        })
      ).rejects.toThrow(`CPS configuration returned ${status}`);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0].toString()).toBe(
        "https://access-failed.cps.golf/onlineresweb/Home/Configuration"
      );
    }
  );
});

function cpsNoTeeTimesResponse(input?: {
  envelope?: Record<string, unknown>;
  content?: Record<string, unknown>;
}) {
  return {
    transactionId: "tx",
    isSuccess: true,
    content: {
      messageKey: "NO_TEETIMES",
      messageTemplate: "No tee times available",
      messageAppearance:
        "Appears on the tee sheet when there are no tee times available on a selected day",
      messageDetail: "No tee times available,please try different criteria.",
      messageType: "Attention",
      ...input?.content
    },
    ...input?.envelope
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}

function cpsTimeoutError() {
  return new DOMException("The CPS provider read timed out", "TimeoutError");
}

function nestedFetchError(cause: unknown) {
  const error = new TypeError("fetch failed") as TypeError & { cause: unknown };
  error.cause = cause;
  return error;
}

function cpsConfiguration() {
  return {
    clientId: "onlineresweb",
    authorityBaseUrl: "https://traditionoaklane.cps.golf/identityapi",
    onlineApi:
      "https://traditionoaklane.cps.golf/onlineres/onlineapi/api/v1/onlinereservation",
    websiteId: "00000000-0000-0000-0000-000000000000",
    siteName: "traditionoaklane"
  };
}

function cpsInput(
  metadataOverrides: Partial<Parameters<typeof fetchCpsSlots>[0]["metadata"]> = {}
): Parameters<typeof fetchCpsSlots>[0] {
  return {
    courseId: "tradition-oak-lane",
    date: new Date("2026-07-18T00:00:00.000Z"),
    players: 4,
    timeZone: "America/New_York",
    metadata: {
      provider: "CPS",
      siteName: "traditionoaklane",
      bookingBaseUrl: "https://traditionoaklane.cps.golf/",
      courseIds: [1],
      holes: [18, 9],
      ...metadataOverrides
    }
  };
}

function persistedCpsInput(
  metadataOverrides: Partial<Parameters<typeof fetchCpsSlots>[0]["metadata"]> = {}
): Parameters<typeof fetchCpsSlots>[0] {
  const configuration = cpsConfiguration();
  return cpsInput({
    clientId: configuration.clientId,
    onlineApi: configuration.onlineApi,
    authorityBaseUrl: configuration.authorityBaseUrl,
    websiteId: configuration.websiteId,
    ...metadataOverrides
  });
}

function mockPersistedCpsFetch(
  teeTimesResponse: (url: URL) => Response | Promise<Response>
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input.toString();
    if (url.endsWith("/identityapi/myconnect/token/short")) {
      return jsonResponse({ access_token: "token" });
    }
    if (url.endsWith("/RegisterTransactionId")) {
      return jsonResponse(true);
    }
    if (url.includes("/TeeTimes?")) {
      return teeTimesResponse(new URL(url));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}
