// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(), updateMany: vi.fn(), apiKey: vi.fn(), fetchPlaces: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { course: { findUnique: mocks.findUnique, updateMany: mocks.updateMany } } }));
vi.mock("@/lib/places/google", () => ({ getGooglePlacesApiKey: mocks.apiKey }));
vi.mock("@/lib/places/google-places-request", () => ({ fetchGooglePlacesJsonWithRetry: mocks.fetchPlaces }));
import { refreshMissingDiscoverySource } from "./sources";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.findUnique.mockResolvedValue({ website: null, googlePlaceId: "ExactPublicPlace" });
  mocks.apiKey.mockReturnValue("mock-only-key");
  mocks.fetchPlaces.mockResolvedValue({ response: { ok: true }, json: { id: "ExactPublicPlace", websiteUri: "http://golf.example.com/" } });
});

describe("missing discovery source identity", () => {
  it("accepts safe HTTP from exact Places identity while persisting its raw bytes under the original null CAS", async () => {
    await refreshMissingDiscoverySource("course1");
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { id: "course1", googlePlaceId: "ExactPublicPlace", website: null },
      data: { website: "http://golf.example.com/" } });
    expect(mocks.fetchPlaces).toHaveBeenCalledWith("https://places.googleapis.com/v1/places/ExactPublicPlace",
      { headers: { "X-Goog-Api-Key": "mock-only-key", "X-Goog-FieldMask": "id,websiteUri" } });
  });

  it("preserves the exact safe HTTPS website bytes", async () => {
    const websiteUri = "https://Golf.Example.com/Public?course=2";
    mocks.fetchPlaces.mockResolvedValue({ response: { ok: true }, json: { id: "ExactPublicPlace", websiteUri } });
    await refreshMissingDiscoverySource("course1");
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { id: "course1", googlePlaceId: "ExactPublicPlace", website: null }, data: { website: websiteUri } });
  });

  it.each(["http://127.0.0.1/", "http://private.internal/", "http://user:secret@golf.example.com/", "http://golf.example.com:80/",
    "http://golf.example.com/account", "http://golf.example.com/times?token=secret", "http://golf.example.com/session/private-id"])(
    "does not persist an unsafe HTTP website %s", async websiteUri => {
      mocks.fetchPlaces.mockResolvedValue({ response: { ok: true }, json: { id: "ExactPublicPlace", websiteUri } });
      await refreshMissingDiscoverySource("course1");
      expect(mocks.updateMany).not.toHaveBeenCalled();
    });

  it.each([
    { response: { ok: false }, json: { id: "ExactPublicPlace", websiteUri: "http://golf.example.com/" } },
    { response: { ok: true }, json: { id: "AnotherPlace", websiteUri: "http://golf.example.com/" } },
    { response: { ok: true }, json: { id: "ExactPublicPlace" } },
  ])("keeps unsuccessful or mismatched provider evidence from changing identity", async value => {
    mocks.fetchPlaces.mockResolvedValue(value);
    await refreshMissingDiscoverySource("course1");
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it.each([null, { website: "http://already.example.com/", googlePlaceId: "ExactPublicPlace" }, { website: null, googlePlaceId: null }])(
    "does not fetch over existing identity or absent source records", async course => {
      mocks.findUnique.mockResolvedValue(course);
      await refreshMissingDiscoverySource("course1");
      expect(mocks.fetchPlaces).not.toHaveBeenCalled();
      expect(mocks.updateMany).not.toHaveBeenCalled();
    });

  it("does not fetch without provider configuration", async () => {
    mocks.apiKey.mockReturnValue(null);
    await refreshMissingDiscoverySource("course1");
    expect(mocks.fetchPlaces).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("preserves a provider exception without writing a guessed website", async () => {
    const failure = new Error("mock provider unavailable");
    mocks.fetchPlaces.mockRejectedValue(failure);
    await expect(refreshMissingDiscoverySource("course1")).rejects.toBe(failure);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});
