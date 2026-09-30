// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { findCatalogueRecoveryPlaces, searchRecoveryCoursePlaces } from "@/lib/course-recovery/places";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  lease: vi.fn(async (_family: string, worker: () => Promise<unknown>): Promise<{ acquired: boolean; value?: unknown }> => ({ acquired: true, value: await worker() })),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { course: { findMany: mocks.findMany } } }));
vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: mocks.lease }));
vi.mock("@/lib/places/google", () => ({ getGooglePlacesApiKey: () => "synthetic-key" }));

const input = { name: "Aster Dunes Golf Course", town: "Hollowford CT", latitude: 41.3, longitude: -72.8 };
const rawPlace = (id = "unfamiliar-aster") => ({
  id, displayName: { text: input.name }, formattedAddress: "12 Dune Road, Hollowford, CT 06400", location: { latitude: 41.3, longitude: -72.8 },
  primaryType: "sports_club", types: ["sports_club", "golf_course"], businessStatus: "OPERATIONAL", websiteUri: "https://asterdunes.example.com/",
  addressComponents: [{ longText: "Hollowford", types: ["locality"] }, { longText: "Connecticut", shortText: "CT", types: ["administrative_area_level_1"] }],
});

describe("bounded alternate recovery Places reads", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

  it("uses at most two broad text queries with eight candidates and no photo fields or type restriction", async () => {
    const fetchImpl = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => Response.json({ places: [rawPlace()] }));
    const results = await searchRecoveryCoursePlaces(input, { apiKey: "synthetic-key", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstInit = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(firstInit.body));
    expect(body).toMatchObject({ pageSize: 8, textQuery: `${input.name} ${input.town}`, locationBias: { circle: { center: { latitude: 41.3, longitude: -72.8 } } } });
    expect(body).not.toHaveProperty("strictTypeFiltering");
    expect(body).not.toHaveProperty("includedType");
    expect(new Headers(firstInit.headers).get("X-Goog-FieldMask")).not.toMatch(/photo|rating/iu);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ primaryType: "sports_club", candidate: { city: "Hollowford", stateCode: "CT", publicAccessStatus: "UNVERIFIED" } });
  });

  it("caps the combined candidate set even when a provider sends extra results", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ places: Array.from({ length: 40 }, (_, index) => rawPlace(`candidate-${index}`)) }));
    expect(await searchRecoveryCoursePlaces(input, { apiKey: "synthetic-key", fetchImpl })).toHaveLength(8);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns empty evidence without inventing an identity", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ places: [] }));
    expect(await searchRecoveryCoursePlaces(input, { apiKey: "synthetic-key", fetchImpl })).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([429, 500, 503])("throws failed HTTP %i evidence for automatic retry", async status => {
    const fetchImpl = vi.fn(async () => new Response("temporary failure", { status }));
    await expect(searchRecoveryCoursePlaces(input, { apiKey: "synthetic-key", fetchImpl })).rejects.toThrow(`(${status})`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects responses above the fixed byte budget", async () => {
    const fetchImpl = vi.fn(async () => new Response("x".repeat(256_001)));
    await expect(searchRecoveryCoursePlaces(input, { apiKey: "synthetic-key", fetchImpl })).rejects.toThrow("byte limit");
  });

  it("drops malformed candidates rather than treating them as playable courses", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ places: [{ ...rawPlace(), location: { latitude: 99, longitude: -72 } }, { displayName: { text: "Incomplete Course" } }] }));
    expect(await searchRecoveryCoursePlaces(input, { apiKey: "synthetic-key", fetchImpl })).toEqual([]);
  });

  it("takes the global and actual Google-host lease around default request and body read", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ places: [rawPlace()] })); vi.stubGlobal("fetch", fetchImpl);
    expect(await searchRecoveryCoursePlaces(input)).toHaveLength(1);
    expect(mocks.lease).toHaveBeenCalledTimes(2);
    expect(mocks.lease).toHaveBeenCalledWith("places.googleapis.com", expect.any(Function));
  });

  it("defers default I/O when global provider capacity cannot be acquired", async () => {
    mocks.lease.mockResolvedValueOnce({ acquired: false });
    const fetchImpl = vi.fn(); vi.stubGlobal("fetch", fetchImpl);
    await expect(searchRecoveryCoursePlaces(input)).rejects.toThrow("provider capacity");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retains catalogue private/null snapshots and caps the name read without writing", async () => {
    mocks.findMany.mockResolvedValue([{
      id: "existing", googlePlaceId: null, name: input.name, address: "12 Dune Road, Hollowford, CT 06400", city: "Hollowford",
      stateCode: "CT", stateName: "Connecticut", county: null, countryCode: "US", latitude: 41.3, longitude: -72.8,
      timeZone: "America/New_York", website: "https://asterdunes.example.com/", phone: null, isPublic: false,
      detectedBookingUrl: null, bookingMethod: "UNKNOWN",
    }]);
    expect(await findCatalogueRecoveryPlaces(input)).toMatchObject([{ isPublic: false, candidate: { courseId: "existing", googlePlaceId: "manual-existing", publicAccessStatus: "UNVERIFIED" } }]);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 8 }));
  });
});
