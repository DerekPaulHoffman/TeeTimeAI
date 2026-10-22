import { afterEach, describe, expect, it, vi } from "vitest";
import * as pinned from "@/lib/automation/address-pinned-public-fetch";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { executeRex, inspectRex, normalizeRexAvailability, type RexDependencies } from "./rex-executor";
import { parseRexConfiguration, type RexSource } from "./rex-source";
import type { AccessExecutionInput } from "./recipe";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const originalPinned = pinned.createAddressPinnedPublicFetchTransport;
const venueId = "11111111-2222-3333-4444-555555555555", packageId = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const source: RexSource = { officialUrl: "https://example-golf.test/", bookingUrl: "https://example.reservewithrex.com/package?venue=Example%20Golf%20Studio",
  venueName: "Example Golf Studio", venueAddress: "100 Example Dr Ste 2, Exampletown, CA 90001, USA", timeZone: "America/Los_Angeles" };
const target = { courseId: "course-1", offeringId: "offering-1" };
const now = new Date("2026-10-22T15:00:00Z");
const input: AccessExecutionInput = { date: "2026-10-23", timeZone: source.timeZone, players: 2, durationMinutes: 60, startTime: "10:00", endTime: "20:00" };
function fixture() {
  const directory = [{ id: venueId, name: source.venueName, address: "100 Example Drive Suite 2", timeZone: source.timeZone, closed: false, isComingSoon: false }];
  const catalog = { id: venueId, name: source.venueName, address: "100 Example Drive", address2: "Suite 2", city: "Exampletown", state: "CA", zipCode: "90001",
    timeZone: source.timeZone, closed: false, isComingSoon: false, timeSlotDuration: 30, timeSlotShifting: ["0", "0", "0", "0", "0", "0", "0"],
    packages: [{ id: packageId, name: "Golf Simulator", status: true, isHidden: false, contactOnly: false, isMemberOnlyPackage: false, numberOfLanes: 1,
      minGuests: 1, maxGuests: 8, method: "Per Lane", countLanesByGuest: false, flexibleByResource: false, allowAdditionalGuests: false,
      enableDurationChoice: true, duration: 1, durationInSlots: "2,3,4,5,6", isTimeSlotsInPackage: false, enableAssignDuration: false, fillToEndOfDay: false,
      shiftingForReservationStart: 0, preBufferTimeForReservation: 0, bufferTimeForReservation: 1, ageGroups: [], hasActivities: false }], timeSlots: [] as unknown[] };
  return { directory, catalog, metadata: parseRexConfiguration(directory, catalog, source).metadata };
}
function mockReader(change?: (path: string, body: Record<string, unknown> | undefined, fixture: ReturnType<typeof fixture>) => Response | undefined) {
  const data = fixture(), calls: Array<{ path: string; method: string; body?: Record<string, unknown>; headers: Headers }> = [];
  let active = 0;
  const events: string[] = [];
  const deps: RexDependencies = { now: () => now, requestLease: async (family, work) => {
    expect(family).toBe("example.reservewithrex.com"); expect(active).toBe(0); active++; events.push("lease-enter");
    try { return { acquired: true, value: await work() }; } finally { active--; events.push("lease-exit"); }
  }, fetch: vi.fn(async (url, init) => {
    expect(active).toBe(1); const path = new URL(String(url)).pathname, body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const headers = new Headers(init?.headers); expect(headers.has("cookie")).toBe(false); expect(headers.has("authorization")).toBe(false);
    expect(init?.redirect).toBe("manual"); expect(init?.credentials).toBe("omit");
    calls.push({ path, method: init?.method ?? "GET", body, headers });
    const response = change?.(path, body, data); if (response) return response;
    const value = path === "/api/venue" ? data.directory : path === "/api/venue/get" ? data.catalog : {
      ...data.catalog, timeSlots: [{ id: "20", time: 20 }, { id: "21", time: 21, isDisabled: true }, { id: "22", time: 22, is21plus: true }, { id: "38", time: 38 }],
    };
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  }) };
  return { ...data, deps, calls, events, active: () => active };
}
afterEach(() => vi.restoreAllMocks());

describe("fixed credentialless Rex public reads", () => {
  it("freshly inspects identity and normalizes a full 60-minute bay for two people", async () => {
    const mock = mockReader(); expect(await inspectRex(source, mock.deps)).toEqual(mock.metadata); expect(mock.calls).toHaveLength(2);
    mock.calls.length = 0;
    const slots = await executeRex(source, mock.metadata, target, input, mock.deps);
    expect(slots.map(slot => slot.startsAt)).toEqual(["2026-10-23T17:00:00.000Z", "2026-10-24T02:00:00.000Z"]);
    expect(slots[0]).toMatchObject({ endsAt: "2026-10-23T18:00:00.000Z", availableSpots: 1, capacity: 8, bookingUrl: source.bookingUrl });
    expect(mock.calls.map(call => call.path)).toEqual(["/api/venue", "/api/venue/get", "/api/venue/get-venue-with-package"]);
    expect(mock.calls[1].body).toMatchObject({ guests: 1, duration: 2, lanes: 1 });
    expect(mock.calls[2].body).toEqual({ venueId, packageId, date: input.date, guests: 2, duration: 2, lanes: 1, packagesTag: "", resourceIds: [], guestsWithAgeGroups: [], singlePackage: false });
    expect(mock.active()).toBe(0);
  });
  it("changed date, guests and duration bind fresh request and correctly local endpoints", async () => {
    const mock = mockReader(); const changed = { ...input, date: "2026-10-24", players: 3, durationMinutes: 90 };
    const slots = await executeRex(source, mock.metadata, target, changed, mock.deps);
    expect(mock.calls[2].body).toMatchObject({ date: "2026-10-24", guests: 3, duration: 3, lanes: 1 });
    expect(slots).toHaveLength(1); expect(slots[0]).toMatchObject({ startsAt: "2026-10-24T17:00:00.000Z", endsAt: "2026-10-24T18:30:00.000Z" });
  });
  it("slot identity never varies with price, recipe target, party size or duration", () => {
    const { directory, catalog } = fixture(), config = parseRexConfiguration(directory, catalog, source), body = { ...catalog, timeSlots: [{ id: "20", time: 20, rate: "45.00" }] };
    const first = normalizeRexAvailability(body, config, source, target, input, now);
    const second = normalizeRexAvailability({ ...body, price: "65.00" }, config, source, { courseId: "replacement", offeringId: "replacement" }, { ...input, players: 3, durationMinutes: 90 }, now);
    expect(first[0].sourceId).toBe(second[0].sourceId); expect(first[0].endsAt).not.toBe(second[0].endsAt);
  });
  it("accepts true empty only after complete fresh directory, catalog and dated listing", async () => {
    const mock = mockReader((path, _body, data) => path.endsWith("get-venue-with-package") ? new Response(JSON.stringify(data.catalog), { headers: { "content-type": "application/json" } }) : undefined);
    expect(await executeRex(source, mock.metadata, target, input, mock.deps)).toEqual([]); expect(mock.calls).toHaveLength(3);
  });
  it.each([401, 403, 429, 302, 500])("preserves transport failure %s without false empty", async status => {
    const mock = mockReader(path => path.endsWith("get-venue-with-package") ? new Response("failure", { status, headers: { "content-type": "text/html" } }) : undefined);
    await expect(executeRex(source, mock.metadata, target, input, mock.deps)).rejects.toThrow(status === 429 ? "PROVIDER_THROTTLED" : [401, 403].includes(status) ? "ACCESS_REQUIRED" : "ADAPTER_TRANSPORT_FAILED");
    expect(mock.active()).toBe(0);
  });
  it.each(["json", "schema", "pagination", "bad-slot", "content-type", "partial", "oversize"])("never converts %s failure into EMPTY", async mode => {
    const mock = mockReader((path, _body, data) => {
      if (!path.endsWith("get-venue-with-package")) return;
      const value = mode === "schema" ? { name: source.venueName } : mode === "pagination" ? { ...data.catalog, hasMore: true }
        : mode === "bad-slot" ? { ...data.catalog, timeSlots: [{ id: "20", time: 20 }, { id: "x", time: "21", isDisabled: true }] } : data.catalog;
      return new Response(mode === "json" ? "{" : JSON.stringify(value), { headers: { "content-type": mode === "content-type" ? "text/html" : "application/json",
        ...(mode === "oversize" ? { "content-length": "2000001" } : {}), ...(mode === "partial" ? { "content-range": "items 0-0/23" } : {}) } });
    });
    await expect(executeRex(source, mock.metadata, target, input, mock.deps)).rejects.toThrow();
  });
  it.each([{ players: 9 }, { durationMinutes: 45 }, { durationMinutes: 480 }, { timeZone: "America/New_York" }])("denies unsupported input before any dated availability %j", async changed => {
    const mock = mockReader(); await expect(executeRex(source, mock.metadata, target, { ...input, ...changed }, mock.deps)).rejects.toThrow();
    expect(mock.calls.some(call => call.path.endsWith("get-venue-with-package"))).toBe(false);
  });
  it("stale saved identity/catalog fails before listing", async () => {
    const mock = mockReader(); await expect(executeRex(source, { ...mock.metadata, catalogHash: "0".repeat(64) }, target, input, mock.deps)).rejects.toThrow("ADAPTER_CONFIGURATION_CHANGED");
    expect(mock.calls).toHaveLength(2);
  });
  it.each([{ date: "2026-03-08", index: 4 }, { date: "2026-11-01", index: 2 }])("rejects DST gaps and folds for local slot %j", ({ date, index }) => {
    const { directory, catalog } = fixture(), config = parseRexConfiguration(directory, catalog, source);
    expect(() => normalizeRexAvailability({ ...catalog, timeSlots: [{ id: String(index), time: index }] }, config, source, target,
      { ...input, date, startTime: "00:00", endTime: "06:00" }, new Date("2026-01-01T00:00:00Z"))).toThrow("AMBIGUOUS_OR_INVALID_LOCAL_TIME");
  });
  it("original deadline and cancellation fences prevent any successor read", async () => {
    const mock = mockReader(); await expect(executeRex(source, mock.metadata, target, input, { ...mock.deps, deadlineAt: new Date(Date.now() - 1) })).rejects.toThrow("DEADLINE_EXCEEDED");
    expect(mock.calls).toHaveLength(0);
    const abort = new AbortController(); abort.abort(new Error("CANCELLED"));
    await expect(executeRex(source, mock.metadata, target, input, { ...mock.deps, signal: abort.signal })).rejects.toThrow("CANCELLED"); expect(mock.calls).toHaveLength(0);
  });
  it("consumes the entire response while its provider lease is held", async () => {
    const mock: ReturnType<typeof mockReader> = mockReader((path, _body, data) => path === "/api/venue" ? new Response(new ReadableStream({ start(controller) {
      expect(mock.active()).toBe(1); mock.events.push("body-consumed"); controller.enqueue(new TextEncoder().encode(JSON.stringify(data.directory))); controller.close();
    } }), { headers: { "content-type": "application/json" } }) : undefined);
    await inspectRex(source, mock.deps); expect(mock.events.slice(0, 3)).toEqual(["lease-enter", "body-consumed", "lease-exit"]);
  });
  it("uses the real address-pinned POST authorization path and default lease without network", async () => {
    const data = fixture(), paths: string[] = [];
    vi.mocked(runWithProviderRequestLease).mockImplementation(async (_family, work) => ({ acquired: true, value: await work() }));
    const factory = vi.spyOn(pinned, "createAddressPinnedPublicFetchTransport").mockImplementation(policy => originalPinned(policy, {
      resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
      requestPinned: async request => {
        paths.push(request.url.pathname); expect(request.headers.has("authorization")).toBe(false); expect(request.headers.has("cookie")).toBe(false);
        if (request.method === "POST") { expect(request.headers.get("accept-encoding")).toBe("identity"); expect(JSON.parse(request.body!)).toMatchObject({ venueId, lanes: 1 }); }
        return new Response(JSON.stringify(request.url.pathname === "/api/venue" ? data.directory : { ...data.catalog, timeSlots: request.url.pathname.endsWith("get-venue-with-package") ? [{ id: "20", time: 20 }] : [] }), { headers: { "content-type": "application/json" } });
      },
    }));
    expect(await executeRex(source, data.metadata, target, input, { now: () => now })).toHaveLength(1);
    expect(factory).toHaveBeenCalledOnce(); expect(factory.mock.calls[0][0].authorizeReadPost).toBeTypeOf("function");
    expect(paths).toEqual(["/api/venue", "/api/venue/get", "/api/venue/get-venue-with-package"]); expect(runWithProviderRequestLease).toHaveBeenCalledTimes(3);
  });
});
