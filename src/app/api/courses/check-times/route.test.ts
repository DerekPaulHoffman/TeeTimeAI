import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET } from "./route";
const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), configured: vi.fn(), fetch: vi.fn(), lease: vi.fn(), runnable: vi.fn(), gate: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { course: { findUnique: mocks.findUnique } } }));
vi.mock("@/lib/env", () => ({ hasDatabaseConfig: mocks.configured }));
vi.mock("@/lib/automation/course-provider-read", () => ({ fetchCourseTeeSheet: mocks.fetch }));
vi.mock("@/lib/automation/provider-capabilities", () => ({ resolveProviderCapability: mocks.runnable }));
vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: mocks.lease }));
vi.mock("@/lib/automation/policy", () => ({ evaluateMonitoringGate: mocks.gate }));
vi.mock("@/lib/email/search-delivery-outbox", () => ({ getSafeOfficialBookingUrl: (url: string) => /^https:\/\/example.com\//.test(url) ? url : null }));
const request = (query = "courseId=course-1&date=2026-10-03&players=4") => new NextRequest(`https://example.com/api/courses/check-times?${query}`);
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
  mocks.configured.mockReturnValue(true); mocks.findUnique.mockResolvedValue({ id: "course-1", isPublic: true, timeZone: "America/New_York", providerFamilyKey: "FOREUP" });
  mocks.gate.mockReturnValue({ adapterAllowed: true }); mocks.runnable.mockReturnValue({ isRunnable: true, providerFamilyKey: "FOREUP" });
  mocks.lease.mockImplementation(async (_family, worker) => ({ acquired: true, value: await worker() }));
  mocks.fetch.mockResolvedValue({ slots: [], targetDateStatus: "OPEN" });
});
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
it("checks the requested course/date/party and returns normalized public times only", async () => {
  mocks.fetch.mockResolvedValue({ targetDateStatus: "OPEN", slots: [{ startsAt: "2026-10-03T09:15:00", availableSpots: 4, holes: 18, priceCents: 6100, bookingUrl: "https://example.com/book", sourceId: "private-source" }] });
  const response = await GET(request()); const data = await response.json();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(data.status).toBe("CHECKED"); expect(data.times[0].startsAt).toBe("2026-10-03T13:15:00.000Z");
  expect(JSON.stringify(data)).not.toContain("private-source");
  expect(mocks.fetch).toHaveBeenCalledWith(expect.objectContaining({ id: "course-1" }), new Date("2026-10-03T00:00:00Z"), 4, false);
});
it("does not fetch unknown, private, unsupported, or inaccessible courses", async () => {
  mocks.findUnique.mockResolvedValue(null); expect((await (await GET(request())).json()).status).toBe("UNAVAILABLE");
  mocks.findUnique.mockResolvedValue({ isPublic: false }); await GET(request());
  mocks.findUnique.mockResolvedValue({ isPublic: true }); mocks.gate.mockReturnValue({ adapterAllowed: false }); await GET(request());
  mocks.gate.mockReturnValue({ adapterAllowed: true }); mocks.runnable.mockReturnValue({ isRunnable: false }); await GET(request());
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("distinguishes checked empty sheets, closed dates, busy checks and failures", async () => {
  expect((await (await GET(request())).json()).status).toBe("CHECKED");
  mocks.fetch.mockResolvedValue({ slots: [], targetDateStatus: "NOT_OPEN" }); expect((await (await GET(request())).json()).status).toBe("NOT_OPEN");
  mocks.lease.mockResolvedValue({ acquired: false }); expect((await (await GET(request())).json()).status).toBe("BUSY");
  mocks.lease.mockRejectedValue(new Error("private provider detail")); expect(await (await GET(request())).json()).toEqual({ status: "FAILED", times: [] });
});
it("rejects invalid inputs before database/provider work", async () => {
  for (const query of ["date=2026-10-03&players=4", "courseId=c&date=2026-02-30&players=2", "courseId=c&date=2026-10-03&players=8"]) expect((await GET(request(query))).status).toBe(400);
  expect(mocks.findUnique).not.toHaveBeenCalled();
});
it("does not publish unsafe destinations or describe them as an empty successful sheet", async () => {
  mocks.fetch.mockResolvedValue({ targetDateStatus: "OPEN", slots: [{ startsAt: "2026-10-03T09:15:00", availableSpots: 4, bookingUrl: "javascript:alert(1)" }] });
  expect(await (await GET(request())).json()).toEqual({ status: "FAILED", times: [] });
});
