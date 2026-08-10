import {
  getCoursePhotoMetadataCacheKey,
  readCourseRuntimeCache,
  writeCourseRuntimeCache
} from "@/lib/places/course-runtime-cache";

export type CoursePhotoAttribution = {
  displayName?: string;
  uri?: string;
  photoUri?: string;
};

export type GooglePlacePhoto = {
  photoReference: string;
  authorAttributions: CoursePhotoAttribution[];
};

const photoReferencePattern = /^places\/[^/]+\/photos\/[^/]+$/;

export async function readCachedGooglePlacePhoto(
  googlePlaceId: string
): Promise<GooglePlacePhoto | null> {
  const normalizedPlaceId = googlePlaceId.trim();
  if (!normalizedPlaceId) {
    return null;
  }

  return normalizeGooglePlacePhoto(
    await readCourseRuntimeCache(getCoursePhotoMetadataCacheKey(normalizedPlaceId))
  );
}

export async function cacheGooglePlacePhoto(
  googlePlaceId: string,
  photo: unknown
): Promise<GooglePlacePhoto | null> {
  const normalizedPlaceId = googlePlaceId.trim();
  const normalizedPhoto = normalizeGooglePlacePhoto(photo);
  if (!normalizedPlaceId || !normalizedPhoto) {
    return null;
  }

  await writeCourseRuntimeCache(
    getCoursePhotoMetadataCacheKey(normalizedPlaceId),
    normalizedPhoto,
    "course-photo-metadata"
  );
  return normalizedPhoto;
}

export async function cacheCourseCandidatePhotos(courses: readonly unknown[]) {
  await Promise.all(
    courses.map(async (course) => {
      if (!course || typeof course !== "object") {
        return;
      }

      const candidate = course as Record<string, unknown>;
      if (typeof candidate.googlePlaceId !== "string") {
        return;
      }

      await cacheGooglePlacePhoto(candidate.googlePlaceId, {
        photoReference: candidate.photoReference,
        authorAttributions: candidate.photoAttributions
      });
    })
  );
}

function normalizeGooglePlacePhoto(value: unknown): GooglePlacePhoto | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const photo = value as Record<string, unknown>;
  if (
    typeof photo.photoReference !== "string" ||
    !photoReferencePattern.test(photo.photoReference)
  ) {
    return null;
  }

  return {
    photoReference: photo.photoReference,
    authorAttributions: Array.isArray(photo.authorAttributions)
      ? photo.authorAttributions.flatMap(normalizeAttribution)
      : []
  };
}

function normalizeAttribution(value: unknown): CoursePhotoAttribution[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const attribution = value as Record<string, unknown>;
  const displayName = normalizeOptionalString(attribution.displayName);
  const uri = normalizeOptionalString(attribution.uri);
  const photoUri = normalizeOptionalString(attribution.photoUri);
  if (!displayName && !uri && !photoUri) {
    return [];
  }

  return [
    {
      ...(displayName ? { displayName } : {}),
      ...(uri ? { uri } : {}),
      ...(photoUri ? { photoUri } : {})
    }
  ];
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
