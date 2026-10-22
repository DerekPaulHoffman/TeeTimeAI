import { prisma } from "@/lib/prisma";
import { getGooglePlacesApiKey } from "@/lib/places/google";
import { fetchGooglePlacesJsonWithRetry } from "@/lib/places/google-places-request";
import { isSafeRecipeUrl } from "./recipe";
import { normalizeDiscoverySourceUrl } from "./source-url";

/** Resolve a missing website by exact place identity; never guess a domain. */
export async function refreshMissingDiscoverySource(courseId: string) {
  const course = await prisma.course.findUnique({ where: { id: courseId }, select: { website: true, googlePlaceId: true } });
  const apiKey = getGooglePlacesApiKey();
  if (!course || course.website || !course.googlePlaceId || !apiKey) return;
  const { response, json } = await fetchGooglePlacesJsonWithRetry<{ id?: string; websiteUri?: string }>(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(course.googlePlaceId)}`,
    { headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "id,websiteUri" } },
  );
  if (response.ok && json?.id === course.googlePlaceId && json.websiteUri && isSafeRecipeUrl(normalizeDiscoverySourceUrl(json.websiteUri))) {
    await prisma.course.updateMany({ where: { id: courseId, googlePlaceId: course.googlePlaceId, website: null }, data: { website: json.websiteUri } });
  }
}
