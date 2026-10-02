import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
const mocks = vi.hoisted(() => ({ findMany: vi.fn(), configured: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { course: { findMany: mocks.findMany } } }));
vi.mock("@/lib/env", () => ({ hasDatabaseConfig: mocks.configured }));
const request = (params = "courseId=public-course&date=2026-10-02") => new NextRequest(`http://localhost/api/courses/known-times?${params}`);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-02T12:00:00Z")); mocks.configured.mockReturnValue(true); mocks.findMany.mockResolvedValue([]); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
describe("public known times", () => {
  it("publishes observed tee-sheet times without a matching saved alert or private probe metadata", async () => {
    mocks.findMany.mockResolvedValue([{ id: "public-course", timeZone: "America/New_York", matches: [], probes: [{ rawSummary: {
      teeSearchId: "private-search", publicAvailability: { date: "2026-10-02", confirmedAt: "2026-10-02T11:59:00Z", times: [{
        startsAt: "2026-10-02T15:00:00Z", availableSpots: 4, holes: 18, priceCents: null, bookingUrl: "https://example.com/booking",
      }] },
    } }] }]);
    const body = await (await GET(request())).json();
    expect(body.courses["public-course"]).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("private-search");
  });
  it("rejects invalid dates, missing courses, and oversized lists before querying", async () => {
    for (const params of ["date=2026-10-02", "courseId=x&date=2026-02-30", `${Array(61).fill("courseId=x").join("&")}&date=2026-10-02`]) {
      expect((await GET(request(params))).status).toBe(400);
    }
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
  it("fails closed when storage is unavailable", async () => {
    mocks.configured.mockReturnValue(false);
    expect((await GET(request())).status).toBe(503);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
  it("reads only requested public courses and omits private search details", async () => {
    mocks.findMany.mockResolvedValue([{ id: "public-course", timeZone: "America/New_York", matches: [{
      startsAt: new Date("2026-10-02T15:00:00Z"), availableSpots: 4, holes: 18, priceCents: null,
      bookingUrl: "https://example.com/booking", lastConfirmedAt: new Date("2026-10-02T11:59:00Z"),
      lastSeenAt: new Date("2026-10-02T11:59:00Z"), availabilityStatus: "AVAILABLE", teeSearchId: "private-search"
    }] }]);
    const response = await GET(request());
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.courses["public-course"]).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("private-search");
    expect(mocks.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["public-course"] }, isPublic: true });
  });
  it("hides truncated observation histories rather than guessing which slots remain available", async () => {
    mocks.findMany.mockResolvedValue([{ id: "public-course", timeZone: "America/New_York", matches: Array(500).fill({}) }]);
    expect(await (await GET(request())).json()).toEqual({ courses: { "public-course": [] } });
  });
});
