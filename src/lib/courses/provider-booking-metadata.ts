/** Display membership cannot change how this physical course is read. Keep
 * every provider/access field in source fingerprints, including unknown ones. */
export function providerBookingMetadata(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "sharedFacility")) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "sharedFacility"));
}
