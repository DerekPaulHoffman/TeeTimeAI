import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({ find: vi.fn(), configured: vi.fn(), enabled: vi.fn(), fetch: vi.fn(), lease: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { courseOffering: { findUnique: mocks.find } } }));
vi.mock("@/lib/env", () => ({ hasDatabaseConfig: mocks.configured }));
vi.mock("@/lib/simulators/config", () => ({ isSimulatorModeEnabled: mocks.enabled }));
vi.mock("@/lib/simulators/providers", () => ({ fetchSimulatorAvailability: mocks.fetch, RUNNABLE_SIMULATOR_PROVIDER_FAMILIES: ["USCHEDULE"] }));
vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: mocks.lease }));
vi.mock("@/lib/email/search-delivery-outbox", () => ({ getSafeOfficialBookingUrl: (url: string) => /^https:\/\/example.com\//.test(url) ? url : null }));
const request = (extra = "") => new NextRequest(`https://example.com/api/courses/check-sessions?offeringId=sim-1&date=2026-10-03&startTime=09:00&endTime=12:00${extra}`);
const offering = () => ({ id: "sim-1", courseId: "hybrid", kind: "SIMULATOR", active: true, publicAccessStatus: "PUBLIC",
  bookingUrl: "https://example.com/book", evidenceUrl: "https://example.com/rentals", verifiedAt: new Date("2026-10-01"),
  automationEligibility: "ALLOWED", monitoringState: "HEALTHY", monitoringMode: "SERVER", providerFamilyKey: "USCHEDULE",
  providerMetadata: { privateConfiguration: "never-public" }, maxPartySize: null, supportedDurationsMinutes: [60, 120],
  bookingWindowDaysAhead: null, bookingReleaseTimeLocal: null, observationToken: null, course: { timeZone: "America/New_York" } });
const slot = (duration = 60, start = "2026-10-03T14:00:00Z") => ({ offeringId: "sim-1", sourceId: "private-source", resourceId: "bay-1", productId: "rental",
  startsAt: new Date(start), endsAt: new Date(Date.parse(start) + duration * 60_000), maxPartySize: null, bookingUrl: "https://example.com/book" });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
  mocks.configured.mockReturnValue(true); mocks.enabled.mockReturnValue(true); mocks.find.mockResolvedValue(offering());
  mocks.lease.mockImplementation(async (_family, worker) => ({ acquired: true, value: await worker() }));
  mocks.fetch.mockImplementation(async ({ durationMinutes }) => ({ complete: true, observedAt: new Date(), slots: [slot(durationMinutes)] }));
});
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

it("reads offering-scoped public sessions for Any duration without outdoor identity or party-size predicates", async () => {
  const response = await GET(request("&players=4")); const data = await response.json();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(data.status).toBe("CHECKED"); expect(data.sessions).toHaveLength(2);
  expect(data.sessions[0]).toEqual({ startsAt: "2026-10-03T14:00:00.000Z", endsAt: "2026-10-03T15:00:00.000Z",
    bookingUrl: "https://example.com/book", confirmedAt: "2026-10-02T12:00:00.000Z" });
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(mocks.fetch).toHaveBeenCalledWith(expect.objectContaining({ partySize: 1, timeZone: "America/New_York", date: "2026-10-03" }), expect.any(Function));
  expect(mocks.lease).toHaveBeenCalledWith("example.com", expect.any(Function));
  for (const secret of ["private-source", "bay-1", "never-public", "hybrid"]) expect(JSON.stringify(data)).not.toContain(secret);
});
it("reads only the selected duration and keeps complete intervals inside the local window", async () => {
  mocks.fetch.mockResolvedValue({ complete: true, observedAt: new Date(), slots: [slot(120), slot(120, "2026-10-03T15:00:00Z")] });
  const data = await (await GET(request("&durationMinutes=120"))).json();
  expect(data.sessions).toHaveLength(1); expect(data.sessions[0].startsAt).toContain("14:00:00");
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  expect(mocks.fetch).toHaveBeenCalledWith(expect.objectContaining({ durationMinutes: 120 }), expect.any(Function));
});
it("never converts unsupported, disabled, private, unverified or incomplete reads into no sessions", async () => {
  for (const change of [{ active: false }, { kind: "OUTDOOR" }, { publicAccessStatus: "UNVERIFIED" }, { automationEligibility: "BLOCKED" },
    { verifiedAt: null }, { verifiedAt: new Date("2027-01-01") }, { evidenceUrl: null }, { providerFamilyKey: "UNKNOWN" },
    { monitoringState: "FINAL_TECHNICAL" }, { monitoringMode: "LOCAL_READER_ONLY" }, { bookingUrl: "javascript:alert(1)" }]) {
    mocks.find.mockResolvedValue({ ...offering(), ...change });
    expect((await (await GET(request())).json()).status).toBe("UNAVAILABLE");
  }
  expect(mocks.fetch).not.toHaveBeenCalled();
  mocks.find.mockResolvedValue(offering()); mocks.fetch.mockResolvedValue({ complete: false, observedAt: new Date(), slots: [] });
  expect((await (await GET(request())).json()).status).toBe("FAILED");
});
it("distinguishes a completed empty sheet, busy provider, unopened date and provider failure", async () => {
  mocks.fetch.mockResolvedValue({ complete: true, observedAt: new Date(), slots: [] });
  expect(await (await GET(request())).json()).toEqual({ status: "CHECKED", times: [], sessions: [] });
  mocks.lease.mockResolvedValue({ acquired: false }); expect((await (await GET(request())).json()).status).toBe("BUSY");
  mocks.find.mockResolvedValue({ ...offering(), bookingWindowDaysAhead: 0 }); expect((await (await GET(request())).json()).status).toBe("NOT_OPEN");
  mocks.find.mockResolvedValue(offering()); mocks.lease.mockRejectedValue(new Error("provider secret"));
  expect(await (await GET(request())).json()).toEqual({ status: "FAILED", times: [], sessions: [] });
});
it("rejects invalid intent before data access and reports unsupported duration honestly", async () => {
  for (const extra of ["&durationMinutes=0", "&durationMinutes=31", "&durationMinutes=null", "&endTime=08:00", "&startTime=24:00", "&date=2026-02-30"]) {
    expect((await GET(request(extra))).status).toBe(400);
  }
  expect(mocks.find).not.toHaveBeenCalled();
  expect((await (await GET(request("&durationMinutes=90"))).json()).status).toBe("UNSUPPORTED_DURATION");
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("fails the whole Any check if a later duration fails, without publishing partial availability", async () => {
  mocks.fetch.mockResolvedValueOnce({ complete: true, observedAt: new Date(), slots: [slot()] }).mockRejectedValueOnce(new Error("timeout"));
  expect(await (await GET(request())).json()).toEqual({ status: "FAILED", times: [], sessions: [] });
});
it("withdraws results when the offering source changes during the read", async () => {
  mocks.find.mockResolvedValueOnce(offering()).mockResolvedValueOnce({ ...offering(), bookingUrl: "https://example.com/new-source" });
  expect((await (await GET(request())).json()).status).toBe("UNAVAILABLE");
});
it("rejects cross-offering and unsafe link proof", async () => {
  for (const change of [{ offeringId: "other" }, { bookingUrl: "javascript:alert(1)" }, { resourceId: "" }]) {
    mocks.fetch.mockResolvedValue({ complete: true, observedAt: new Date(), slots: [{ ...slot(), ...change }] });
    expect((await (await GET(request("&durationMinutes=60"))).json()).status).toBe("FAILED");
  }
});
it("supports venue-local midnight, deduplicates equivalent bays, and hides expired starts", async () => {
  mocks.fetch.mockResolvedValue({ complete: true, observedAt: new Date(), slots: [slot(60, "2026-10-04T03:00:00Z"), slot(60, "2026-10-04T03:00:00Z")] });
  const response = await GET(request("&startTime=23:00&endTime=24:00&durationMinutes=60"));
  expect((await response.json()).sessions).toHaveLength(1);
  mocks.fetch.mockResolvedValue({ complete: true, observedAt: new Date(), slots: [slot(60, "2026-10-02T11:00:00Z")] });
  expect((await (await GET(request("&durationMinutes=60"))).json()).sessions).toHaveLength(0);
});
