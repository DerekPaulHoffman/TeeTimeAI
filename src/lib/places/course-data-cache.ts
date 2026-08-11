export const courseDataSuccessCacheHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "Vercel-CDN-Cache-Control": "no-store"
} as const;

export const coursePhotoSuccessCacheHeaders = {
  "Cache-Control": "public, max-age=31536000, stale-while-revalidate=31536000",
  "Vercel-CDN-Cache-Control":
    "max-age=31536000, stale-while-revalidate=31536000, stale-if-error=31536000"
} as const;

export const coursePhotoFallbackCacheHeaders = {
  "Cache-Control": "public, max-age=300, stale-while-revalidate=900",
  "Vercel-CDN-Cache-Control": "max-age=900, stale-while-revalidate=3600"
} as const;
