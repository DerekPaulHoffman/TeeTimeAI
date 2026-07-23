import { describe, expect, it } from "vitest";

import {
  analyzePublicResponse,
  buildShareableReport,
  extractTeeTimeSlots,
  redactUrl
} from "./parser.js";

describe("public tee-time response reader", () => {
  it("classifies a provider 403200 body as a managed challenge", () => {
    expect(
      analyzePublicResponse({
        method: "GET",
        url: "https://course.example/config",
        status: 403,
        mimeType: "text/html",
        headers: [],
        body: "<html><title>Just a moment...</title><script>code=403200</script></html>"
      })
    ).toMatchObject({
      kind: "challenge",
      status: 403,
      detail: expect.stringContaining("provider code 403200")
    });
  });

  it("classifies an explicit challenge response header", () => {
    expect(
      analyzePublicResponse({
        method: "GET",
        url: "https://course.example/availability",
        status: 200,
        mimeType: "text/html",
        headers: [{ name: "cf-mitigated", value: "challenge" }],
        body: ""
      })
    ).toMatchObject({
      kind: "challenge"
    });
  });

  it("does not classify ordinary JSON containing CAPTCHA labels as a challenge", () => {
    expect(
      analyzePublicResponse({
        method: "GET",
        url: "https://course.example/assets/translations.json",
        status: 200,
        mimeType: "application/json",
        headers: [],
        body: JSON.stringify({
          labels: {
            recaptcha: "Verification is available when required"
          }
        })
      })
    ).toMatchObject({
      kind: "json"
    });
  });

  it("parses CPS-shaped slots without depending on a tenant hostname", () => {
    const result = analyzePublicResponse({
      method: "GET",
      url: "https://any-tenant.example/api/TeeTimes?transactionId=temporary-value",
      status: 200,
      mimeType: "application/json",
      headers: [],
      body: JSON.stringify({
        transactionId: "not-retained",
        content: [
          {
            teeSheetId: 81,
            startTime: "2026-07-24T08:00:00",
            courseId: 1,
            startingTee: 8,
            teeSuffix: "A",
            availableParticipantNo: [1, 2],
            holes: 18,
            teeSheetPrice: 25
          },
          {
            teeSheetId: 82,
            startTime: "2026-07-24T08:10:00",
            courseId: 1,
            startingTee: 12,
            teeSuffix: " ",
            availableParticipantNo: [1, 2, 3],
            holes: 9,
            teeSheetPrice: 18
          }
        ]
      })
    });

    expect(result).toMatchObject({
      kind: "tee_times",
      slots: [
        {
          time: "2026-07-24T08:00:00",
          course: 1,
          startingTee: "8A",
          holes: 18,
          available: 2,
          price: 25
        },
        {
          time: "2026-07-24T08:10:00",
          course: 1,
          startingTee: "12",
          holes: 9,
          available: 3,
          price: 18
        }
      ]
    });
    expect(result.url).toContain("transactionId=%5Bredacted%5D");
  });

  it("parses a different provider's availability shape", () => {
    expect(
      extractTeeTimeSlots({
        results: [
          {
            slot_id: "slot-1",
            tee_time: "08:40 AM",
            facility_name: "Example Municipal",
            max_players: 4,
            display_price: 42
          }
        ]
      })
    ).toEqual([
      {
        time: "08:40 AM",
        course: "Example Municipal",
        available: 4,
        price: 42
      }
    ]);
  });

  it("parses public TenFore booking-time rows", () => {
    expect(
      extractTeeTimeSlots({
        successful: true,
        data: [
          {
            id: 6692125,
            date: "2026-07-24",
            time: "07:00:00",
            spots: 2,
            maxHoles: 18,
            fullPrice18: 57.81,
            fullPrice9: 34.34
          }
        ]
      })
    ).toEqual([
      {
        time: "2026-07-24T07:00:00",
        holes: 18,
        available: 2,
        price: 57.81
      }
    ]);
  });

  it("does not mistake booking-window release rules for tee-time inventory", () => {
    expect(
      extractTeeTimeSlots({
        bookingRuleByCourses: [
          {
            courseId: 1,
            daysInAdvance: 7,
            releaseTimeLocal: "20:00"
          }
        ]
      })
    ).toEqual([]);
  });

  it("ignores authentication response bodies", () => {
    expect(
      analyzePublicResponse({
        method: "POST",
        url: "https://course.example/oauth/token",
        status: 200,
        mimeType: "application/json",
        headers: [],
        body: JSON.stringify({
          access_token: "secret",
          tee_time: "08:00 AM",
          available: true
        })
      })
    ).toMatchObject({
      kind: "ignored"
    });
  });

  it("redacts sensitive query values from copied reports", () => {
    const redacted = redactUrl(
      "https://course.example/TeeTimes?date=2026-07-24&transactionId=abc&api_key=def"
    );
    expect(redacted).toContain("date=2026-07-24");
    expect(redacted).not.toContain("abc");
    expect(redacted).not.toContain("def");

    const report = buildShareableReport(
      [
        {
          kind: "tee_times",
          method: "GET",
          status: 200,
          url: redacted,
          title: "Readable",
          detail: "Public JSON",
          slots: []
        }
      ],
      "https://course.example/?session=private"
    );
    expect(report.inspectedUrl).not.toContain("private");
  });
});
