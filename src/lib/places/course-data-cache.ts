export const courseDataSuccessCacheHeaders = {
  "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
  "Vercel-CDN-Cache-Control":
    "max-age=86400, stale-while-revalidate=2592000, stale-if-error=2592000"
} as const;

export const coursePhotoSuccessCacheHeaders = {
  "Cache-Control": "public, max-age=604800, stale-while-revalidate=2592000",
  "Vercel-CDN-Cache-Control":
    "max-age=2592000, stale-while-revalidate=2592000, stale-if-error=2592000"
} as const;

export const coursePhotoFallbackCacheHeaders = {
  "Cache-Control": "public, max-age=300, stale-while-revalidate=900",
  "Vercel-CDN-Cache-Control": "max-age=900, stale-while-revalidate=3600"
} as const;
