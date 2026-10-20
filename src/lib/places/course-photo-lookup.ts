import { cacheGooglePlacePhoto, normalizeGooglePlacePhoto, readCachedGooglePlacePhoto, type GooglePlacePhoto } from "./course-photo-metadata";
import { readCourseRuntimeCache, writeCourseRuntimeCache } from "./course-runtime-cache";

const NO_PHOTO_SECONDS = 15 * 60;
const UNAVAILABLE_SECONDS = 60;
const THROTTLED_SECONDS = 5 * 60;
const LOCAL_PHOTO_SECONDS = 5 * 60;
const MAX_LOCAL_ENTRIES = 256;
const MAX_PENDING = 64;
const MAX_PHOTO_REQUESTS = 4;
const THROTTLE_KEY = "photo-metadata-throttle-v1";
const negativeKey = (id: string) => `photo-metadata-negative-v1:${id}`;
type Until = { until: number };
type LocalValue = Until & { photo?: GooglePlacePhoto };
type Dependencies = {
  load: (id: string) => Promise<{ status: number; photo?: GooglePlacePhoto }>;
  readPhoto?: typeof readCachedGooglePlacePhoto;
  cachePhoto?: typeof cacheGooglePlacePhoto;
  readCache?: (key: string) => Promise<unknown>;
  writeCache?: typeof writeCourseRuntimeCache;
  now?: () => number;
};

/** Decorative metadata alone owns these short-lived misses and throttles.
 * They never authorize or suppress a place-identity confirmation. */
export function createCoursePhotoLookup(deps: Dependencies) {
  const now = deps.now ?? Date.now;
  const readPhoto = deps.readPhoto ?? readCachedGooglePlacePhoto;
  const cachePhoto = deps.cachePhoto ?? cacheGooglePlacePhoto;
  const readCache = deps.readCache ?? readCourseRuntimeCache;
  const writeCache = deps.writeCache ?? writeCourseRuntimeCache;
  const local = new Map<string, LocalValue>();
  const pending = new Map<string, Promise<GooglePlacePhoto | null>>();
  let throttledUntil = 0;
  let activeRequests = 0;
  const store = (id: string, value: LocalValue) => {
    local.delete(id); local.set(id, value);
    if (local.size > MAX_LOCAL_ENTRIES) local.delete(local.keys().next().value!);
  };
  const activeUntil = (value: unknown, maximumSeconds: number) => {
    const until = (value as Partial<Until> | null)?.until;
    return typeof until === "number" && Number.isFinite(until) && until > now() && until - now() <= maximumSeconds * 1000 ? until : 0;
  };
  const read = (key: string) => readCache(key).catch(() => null);
  const write = (key: string, until: number, seconds: number) =>
    writeCache(key, { until }, "course-photo-metadata", { ttlSeconds: seconds }).catch(() => {});

  async function lookup(id: string): Promise<GooglePlacePhoto | null> {
    const current = local.get(id);
    if (current && current.until <= now()) local.delete(id);
    if (current?.photo && current.until > now()) return current.photo;
    // Cached successful imagery remains available even during a global cooldown.
    const cached = await readPhoto(id).catch(() => null);
    if (cached) { store(id, { photo: cached, until: now() + LOCAL_PHOTO_SECONDS * 1000 }); return cached; }
    if (current && current.until > now() || throttledUntil > now()) return null;
    const [negative, throttle] = await Promise.all([read(negativeKey(id)), read(THROTTLE_KEY)]);
    throttledUntil = Math.max(throttledUntil, activeUntil(throttle, THROTTLED_SECONDS));
    const negativeUntil = activeUntil(negative, NO_PHOTO_SECONDS);
    if (negativeUntil) store(id, { until: negativeUntil });
    if (negativeUntil || throttledUntil > now() || activeRequests >= MAX_PHOTO_REQUESTS) return null;
    activeRequests++;
    try {
      const result = await deps.load(id);
      const photo = normalizeGooglePlacePhoto(result.photo);
      if (result.status === 200 && photo) {
        store(id, { photo, until: now() + LOCAL_PHOTO_SECONDS * 1000 });
        await cachePhoto(id, photo).catch(() => null);
        return photo;
      }
      const seconds = result.status === 200 ? NO_PHOTO_SECONDS : UNAVAILABLE_SECONDS;
      const until = now() + seconds * 1000;
      store(id, { until });
      if (result.status === 429) {
        throttledUntil = now() + THROTTLED_SECONDS * 1000;
        await write(THROTTLE_KEY, throttledUntil, THROTTLED_SECONDS);
      }
      await write(negativeKey(id), until, seconds);
      return null;
    } catch {
      const until = now() + UNAVAILABLE_SECONDS * 1000;
      store(id, { until });
      await write(negativeKey(id), until, UNAVAILABLE_SECONDS);
      return null;
    } finally { activeRequests--; }
  }
  return (placeId: string): Promise<GooglePlacePhoto | null> => {
    const id = placeId.trim();
    if (!id || id.length > 255) return Promise.resolve(null);
    const existing = pending.get(id);
    if (existing) return existing;
    if (pending.size >= MAX_PENDING) return Promise.resolve(null);
    const promise = lookup(id).finally(() => { pending.delete(id); });
    pending.set(id, promise);
    return promise;
  };
}
