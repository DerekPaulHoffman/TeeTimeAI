export async function geocodeLocation(query: string) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return {
      latitude: 41.242,
      longitude: -73.209,
      demo: true
    };
  }

  const params = new URLSearchParams({
    address: query,
    key: apiKey
  });
  const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);

  if (!response.ok) {
    throw new Error(`Google geocoding failed with ${response.status}`);
  }

  const json = (await response.json()) as {
    status: string;
    results?: Array<{
      geometry?: { location?: { lat?: number; lng?: number } };
    }>;
  };

  const location = json.results?.[0]?.geometry?.location;
  if (json.status !== "OK" || location?.lat === undefined || location.lng === undefined) {
    throw new Error("No matching location found.");
  }

  return {
    latitude: location.lat,
    longitude: location.lng,
    demo: false
  };
}
