type CourseMapTarget = {
  address?: null | string;
  googlePlaceId?: null | string;
  latitude: number;
  longitude: number;
  name: string;
};

export function getGoogleMapsSearchUrl(course: CourseMapTarget) {
  const params = new URLSearchParams({
    api: "1",
    query: getGoogleMapsQuery(course)
  });
  const placeId = getGoogleMapsPlaceId(course.googlePlaceId);

  if (placeId) {
    params.set("query_place_id", placeId);
  }

  return `https://www.google.com/maps/search/?${params.toString()}`;
}

export function getGoogleMapsEmbedUrl(center: Pick<CourseMapTarget, "latitude" | "longitude">) {
  const params = new URLSearchParams({
    output: "embed",
    q: `${center.latitude},${center.longitude}`,
    z: "10"
  });

  return `https://www.google.com/maps?${params.toString()}`;
}

function getGoogleMapsQuery(course: CourseMapTarget) {
  if (course.address) {
    return `${course.name}, ${course.address}`;
  }

  return `${course.latitude},${course.longitude}`;
}

function getGoogleMapsPlaceId(placeId?: null | string) {
  if (!placeId || placeId.startsWith("demo-") || placeId.startsWith("manual-")) {
    return null;
  }

  return placeId.replace(/^places\//, "");
}
