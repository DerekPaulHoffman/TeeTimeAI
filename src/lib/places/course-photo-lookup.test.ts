import { describe, expect, it, vi } from "vitest";
import { createCoursePhotoLookup } from "./course-photo-lookup";
import type { GooglePlacePhoto } from "./course-photo-metadata";

const photo: GooglePlacePhoto = { photoReference: "places/example/photos/one", authorAttributions: [] };
function fixture(load = vi.fn(async (id: string): Promise<{ status: number; photo?: GooglePlacePhoto }> => { void id; return { status: 200 }; })) {
  let clock = 1_000_000;
  const shared = new Map<string, unknown>();
  const readPhoto = vi.fn(async (id: string): Promise<GooglePlacePhoto | null> => { void id; return null; });
  const cachePhoto = vi.fn(async (_id: string, value: unknown) => value as GooglePlacePhoto);
  const readCache = vi.fn(async (key: string) => shared.get(key) ?? null);
  const writeCache = vi.fn(async (key: string, value: unknown) => { shared.set(key, value); });
  const create = () => createCoursePhotoLookup({ load, readPhoto, cachePhoto, readCache, writeCache, now: () => clock });
  return { lookup: create(), create, load, shared, readPhoto, cachePhoto, readCache, writeCache, advance: (ms: number) => { clock += ms; } };
}

describe("decorative photo quota protection", () => {
  it("briefly remembers no-photo results across repeated calls and other instances, then expires", async () => {
    const f = fixture();
    expect(await f.lookup("venue")).toBeNull();
    expect(await f.lookup("venue")).toBeNull();
    expect(await f.create()("venue")).toBeNull();
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.writeCache).toHaveBeenCalledWith("photo-metadata-negative-v1:venue", expect.any(Object), "course-photo-metadata", { ttlSeconds: 900 });
    f.advance(900_001);
    await f.lookup("venue");
    expect(f.load).toHaveBeenCalledTimes(2);
  });

  it("shares a photo-only 429 cooldown while retaining cached photos and allowing expiry", async () => {
    const f = fixture(vi.fn(async () => ({ status: 429 })));
    await f.lookup("first");
    await f.create()("second");
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.writeCache).toHaveBeenCalledWith("photo-metadata-throttle-v1", expect.any(Object), "course-photo-metadata", { ttlSeconds: 300 });
    f.readPhoto.mockResolvedValueOnce(photo);
    expect(await f.lookup("cached")).toEqual(photo);
    expect(f.load).toHaveBeenCalledTimes(1);
    f.advance(300_001);
    await f.lookup("second");
    expect(f.load).toHaveBeenCalledTimes(2);
  });

  it("retains bounded local misses and throttle protection when shared cache fails", async () => {
    const f = fixture(vi.fn(async () => ({ status: 429 })));
    f.readCache.mockRejectedValue(new Error("cache down"));
    f.writeCache.mockRejectedValue(new Error("cache down"));
    await f.lookup("first"); await f.lookup("first"); await f.lookup("second");
    expect(f.load).toHaveBeenCalledTimes(1);
    f.advance(300_001);
    await f.lookup("second");
    expect(f.load).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent requests for one place and caps distinct in-flight provider reads", async () => {
    const releases: Array<() => void> = [];
    const load = vi.fn((id: string) => { void id; return new Promise<{ status: number }>(resolve => { releases.push(() => resolve({ status: 200 })); }); });
    const f = fixture(load);
    const same = Array.from({ length: 20 }, () => f.lookup("same"));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    releases.splice(0).forEach(release => release()); await Promise.all(same);
    const distinct = Array.from({ length: 10 }, (_, n) => f.lookup(`different${n}`));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(5));
    releases.splice(0).forEach(release => release()); await Promise.all(distinct);
    expect(load).toHaveBeenCalledTimes(5);
  });

  it("keeps positive photos usable when cache writes fail, without year-long failure entries", async () => {
    const f = fixture(vi.fn(async () => ({ status: 200, photo })));
    f.cachePhoto.mockRejectedValue(new Error("cache down"));
    expect(await f.lookup("positive")).toEqual(photo);
    expect(await f.lookup("positive")).toEqual(photo);
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.writeCache).not.toHaveBeenCalled();
    f.advance(300_001); await f.lookup("positive");
    expect(f.load).toHaveBeenCalledTimes(2);
  });

  it("retries unavailable metadata after a short miss lifetime and rejects malformed photos", async () => {
    const f = fixture(vi.fn(async () => { throw new Error("network down"); }));
    await f.lookup("unavailable"); await f.lookup("unavailable");
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.writeCache).toHaveBeenCalledWith(expect.any(String), expect.any(Object), "course-photo-metadata", { ttlSeconds: 60 });
    f.advance(60_001); await f.lookup("unavailable"); expect(f.load).toHaveBeenCalledTimes(2);
    const malformed = fixture(vi.fn(async () => ({ status: 200, photo: { ...photo, photoReference: "https://unsafe.example/image" } })));
    expect(await malformed.lookup("malformed")).toBeNull();
    expect(malformed.cachePhoto).not.toHaveBeenCalled();
  });
});
