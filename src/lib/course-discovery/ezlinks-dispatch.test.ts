// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeExistingAdapterRecipe, inspectExistingAdapter } from "./existing-adapter-executor";
import { existingAdapterMetadataSchema, type ExistingAdapterRecipe } from "./existing-adapter-schema";
import { executeAccessRecipe, recipeTimeToInstant, venueProofMatches } from "./executor";
import { hashAccessRecipe, parseAccessRecipe, type AccessExecutionInput, type AccessExecutionResult } from "./recipe";
import type { EzLinksMetadata } from "./ezlinks-source";

const fixed = vi.hoisted(() => ({ inspect: vi.fn(), execute: vi.fn(), ameliaInspect: vi.fn(), ameliaExecute: vi.fn(),
  acuityRead: vi.fn(), acuityExecute: vi.fn() }));

vi.mock("./ezlinks-executor", () => ({ inspectEzLinks: fixed.inspect, executeEzLinks: fixed.execute }));
vi.mock("./amelia-executor", () => ({ inspectAmelia: fixed.ameliaInspect, executeAmelia: fixed.ameliaExecute }));
vi.mock("@/lib/simulators/providers/acuity", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/simulators/providers/acuity")>(),
  readAcuityPublicConfiguration: fixed.acuityRead, fetchAcuitySimulatorAvailability: fixed.acuityExecute,
}));

const metadata: EzLinksMetadata = { family: "EZLINKS", browserTransport: "NATIVE_CHROME", tenant: "public-course",
  sponsorId: 1234, courseIds: [11, 22], catalogHash: "b".repeat(64), clients: [
    { path: "/assets/index-DsLbHQvf.js", sha256: "4e2bb6ea29fa910e04620c1551d737aecaff9df23bf6be99f9da6d72e9b1addb" },
    { path: "/assets/index-CvL6jQuU.js", sha256: "6547b7841afb6945817f5c354437875bd5f1fb59031ed511cf16d30bca72262f" },
  ] };
const recipe: ExistingAdapterRecipe = { schemaVersion: 1, engine: "EXISTING_ADAPTER",
  target: { courseId: "outdoor-course", kind: "OUTDOOR" },
  source: { officialUrl: "https://official.example.org/", bookingUrl: "https://public-course.ezlinksgolf.com/search",
    venueName: "Offline Public Golf", venueAddress: "100 Main Road, Example, NY 12345, USA",
    providerFamily: "EZLINKS", timeZone: "America/New_York" }, adapter: metadata };
const input: AccessExecutionInput = { date: "2030-10-23", timeZone: "America/New_York", players: 2,
  startTime: "10:00", endTime: "12:00" };
const now = () => new Date("2030-10-23T14:30:00.000Z");
const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error("GENERIC_FETCH_FORBIDDEN"); });
const requestLease = vi.fn<<T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T }>>(async () => {
  throw new Error("UNEXPECTED_GENERIC_LEASE");
});
const deps = { fetch, requestLease, now, venueMatches: venueProofMatches };
const directDeps = { ...deps, recipeHash: "a".repeat(64), toInstant: recipeTimeToInstant };
const verified = { venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true };
const unverified = { venueVerified: false, dateVerified: false, capacityVerified: false, durationVerified: false, completeVerified: false };

function slots(request: AccessExecutionInput): AccessExecutionResult["slots"] {
  return ["09:45", "10:00", "10:30", "10:45", "12:00", "12:30", "10:50"].map((time, index) => ({
    sourceId: `ezlinks-offline-${request.date}-${index}`, resourceId: "ezlinks-course:11", availableSpots: index === 6 ? 1 : 4,
    startsAt: recipeTimeToInstant(`${request.date}T${time}:00`, request).toISOString(), bookingUrl: recipe.source.bookingUrl,
  }));
}

function expectNoGenericReader() {
  expect(fetch).not.toHaveBeenCalled(); expect(requestLease).not.toHaveBeenCalled();
  expect(fixed.ameliaInspect).not.toHaveBeenCalled(); expect(fixed.ameliaExecute).not.toHaveBeenCalled();
  expect(fixed.acuityRead).not.toHaveBeenCalled(); expect(fixed.acuityExecute).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  fetch.mockImplementation(async () => { throw new Error("GENERIC_FETCH_FORBIDDEN"); });
  requestLease.mockImplementation(async () => { throw new Error("UNEXPECTED_GENERIC_LEASE"); });
  fixed.inspect.mockResolvedValue(structuredClone(metadata));
  fixed.execute.mockImplementation(async (_source, _metadata, _target, request: AccessExecutionInput) => slots(request));
  fixed.ameliaInspect.mockRejectedValue(new Error("AMELIA_FALLBACK_FORBIDDEN"));
  fixed.ameliaExecute.mockRejectedValue(new Error("AMELIA_FALLBACK_FORBIDDEN"));
  fixed.acuityRead.mockRejectedValue(new Error("ACUITY_FALLBACK_FORBIDDEN"));
  fixed.acuityExecute.mockRejectedValue(new Error("ACUITY_FALLBACK_FORBIDDEN"));
});

describe("typed EZLinks central dispatch", () => {
  it.each(["/", "/search", "/index.html"])("inspects only the exact observed public document %s through the typed native reader", async path => {
    const source = { ...recipe.source, bookingUrl: `https://public-course.ezlinksgolf.com${path}` };
    expect(await inspectExistingAdapter(source, deps)).toEqual({ adapter: metadata });
    expect(fixed.inspect).toHaveBeenCalledExactlyOnceWith(source, deps);
    expect(fixed.execute).not.toHaveBeenCalled(); expectNoGenericReader();
  });

  it.each(["/api/search/init", "/search?date=2030-10-23", "/account", "/other-public-page"])(
    "does not reinterpret the known EZLinks namespace %s as self-hosted Amelia", async path => {
      const source = { ...recipe.source, officialUrl: "https://public-course.ezlinksgolf.com/",
        bookingUrl: `https://public-course.ezlinksgolf.com${path}` };
      await expect(inspectExistingAdapter(source, deps)).rejects.toThrow();
      expect(fixed.inspect).not.toHaveBeenCalled(); expectNoGenericReader();
    });

  it("does not reinterpret a private EZLinks tenant as another reader", async () => {
    await expect(inspectExistingAdapter({ ...recipe.source, officialUrl: "https://admin.ezlinksgolf.com/",
      bookingUrl: "https://admin.ezlinksgolf.com/search" }, deps)).rejects.toThrow();
    expect(fixed.inspect).not.toHaveBeenCalled(); expectNoGenericReader();
  });

  it("preserves a failed typed inspection without probing a fallback", async () => {
    fixed.inspect.mockRejectedValueOnce(new Error("ADAPTER_IDENTITY_MISMATCH"));
    await expect(inspectExistingAdapter(recipe.source, deps)).rejects.toThrow("ADAPTER_IDENTITY_MISMATCH");
    expect(fixed.inspect).toHaveBeenCalledOnce(); expectNoGenericReader();
  });

  it("passes the same data-only recipe and each changed input to a fresh typed execution", async () => {
    const parsed = parseAccessRecipe(recipe), changed = { ...input, date: "2030-10-24", players: 3 };
    const baseline = await executeAccessRecipe(parsed, input, deps);
    const edited = await executeAccessRecipe(parsed, changed, deps);
    expect(baseline).toMatchObject({ status: "AVAILABLE", complete: true, sourceUrl: recipe.source.bookingUrl,
      evidence: { recipeHash: hashAccessRecipe(parsed), ...verified } });
    // Strict future start, inclusive start/exclusive end, and actual party capacity.
    expect(baseline.slots.map(slot => slot.startsAt)).toEqual(["2030-10-23T14:45:00.000Z"]);
    expect(edited.slots.map(slot => slot.startsAt)).toEqual([
      "2030-10-24T14:00:00.000Z", "2030-10-24T14:30:00.000Z", "2030-10-24T14:45:00.000Z",
    ]);
    expect(edited).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { recipeHash: hashAccessRecipe(parsed), ...verified } });
    expect(fixed.execute).toHaveBeenCalledTimes(2);
    for (const [index, request] of [input, changed].entries()) {
      expect(fixed.execute.mock.calls[index]).toEqual([parsed.source, metadata, { courseId: recipe.target.courseId }, request,
        expect.objectContaining({ fetch, requestLease, now, recipeHash: hashAccessRecipe(parsed),
          venueMatches: venueProofMatches, toInstant: recipeTimeToInstant })]);
    }
    expect(fixed.inspect).not.toHaveBeenCalled(); expectNoGenericReader();
    expect([...baseline.slots, ...edited.slots].every(slot => slot.bookingUrl === recipe.source.bookingUrl &&
      slot.holes === undefined && slot.endsAt === undefined && slot.productId === undefined)).toBe(true);
  });

  it("allows EMPTY only after a complete typed read actually returns no matching slots", async () => {
    fixed.execute.mockResolvedValueOnce([]);
    expect(await executeExistingAdapterRecipe(recipe, input, directDeps)).toMatchObject({ status: "EMPTY", complete: true,
      slots: [], evidence: verified });
    expect(fixed.execute).toHaveBeenCalledOnce(); expectNoGenericReader();
  });

  it.each([
    ["EZLINKS_CONFIGURATION_UNVERIFIED", "INCOMPLETE"], ["EZLINKS_AVAILABILITY_INVALID", "INCOMPLETE"],
    ["EZLINKS_READ_TIMEOUT", "INCOMPLETE"], ["ACCESS_REQUIRED", "ACCESS_REQUIRED"],
    ["PROVIDER_THROTTLED", "FAILED"],
  ])("keeps typed failure %s as %s with no false empty proof", async (reason, status) => {
    fixed.execute.mockRejectedValueOnce(new Error(reason));
    const result = await executeExistingAdapterRecipe(recipe, input, directDeps);
    expect(result).toMatchObject({ status, complete: false, slots: [], evidence: { ...unverified, reason } });
    expect(result.status).not.toBe("EMPTY"); expect(fixed.execute).toHaveBeenCalledOnce(); expectNoGenericReader();
  });

  it("does not project arbitrary provider error prose into result evidence", async () => {
    const privateError = "A response contained confidential-token-value at /private?credential=value";
    fixed.execute.mockRejectedValueOnce(new Error(privateError));
    const result = await executeExistingAdapterRecipe(recipe, input, directDeps);
    expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "ADAPTER_READ_FAILED", ...unverified } });
    expect(JSON.stringify(result)).not.toContain(privateError); expect(JSON.stringify(result)).not.toContain("confidential-token-value");
    expectNoGenericReader();
  });

  it.each([
    { label: "simulator target", candidate: { ...recipe, target: { courseId: "simulator", offeringId: "rental", kind: "SIMULATOR" as const } }, request: input },
    { label: "outdoor duration", candidate: recipe, request: { ...input, durationMinutes: 60 } },
    { label: "mismatched timezone", candidate: recipe, request: { ...input, timeZone: "America/Chicago" } },
    { label: "mismatched family", candidate: { ...recipe, source: { ...recipe.source, providerFamily: "ACUITY" } }, request: input },
    { label: "mismatched tenant", candidate: { ...recipe, source: { ...recipe.source, bookingUrl: "https://another-course.ezlinksgolf.com/search" } }, request: input },
    { label: "unrecognized source path", candidate: { ...recipe, source: { ...recipe.source, bookingUrl: "https://public-course.ezlinksgolf.com/other" } }, request: input },
    { label: "missing official identity", candidate: { ...recipe, source: { ...recipe.source, officialUrl: "" } }, request: input },
    { label: "missing address context", candidate: { ...recipe, source: { ...recipe.source, venueAddress: undefined } }, request: input },
  ])("rejects $label before typed or generic execution", async ({ candidate, request }) => {
    expect(await executeExistingAdapterRecipe(candidate, request, directDeps)).toMatchObject({ status: "INCOMPLETE", complete: false,
      slots: [], evidence: unverified });
    expect(fixed.execute).not.toHaveBeenCalled(); expectNoGenericReader();
  });

  it("keeps EZLinks metadata native-only, data-only and outdoor in the serialized recipe", () => {
    expect(parseAccessRecipe(recipe)).toEqual(recipe);
    for (const extra of [{ browserTransport: "PINNED_HTTP" }, { fetch: "arbitrary expression" }, { headers: { authorization: "value" } },
      { courseIds: [11, 11] }, { courseIds: [22, 11] }])
      expect(existingAdapterMetadataSchema.safeParse({ ...metadata, ...extra }).success).toBe(false);
    expect(() => parseAccessRecipe({ ...recipe, target: { ...recipe.target, kind: "SIMULATOR", offeringId: "rental" } })).toThrow();
    expect(() => parseAccessRecipe({ ...recipe, source: { ...recipe.source, venueAddress: undefined } })).toThrow();
    expect(fixed.execute).not.toHaveBeenCalled(); expectNoGenericReader();
  });
});
