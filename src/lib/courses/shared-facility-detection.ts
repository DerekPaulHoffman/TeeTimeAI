/** Server-produced observations, never accepted from a public request body. */
export type DetectedFacility = {
  method: "FOREUP_PUBLIC_CATALOG" | "OFFICIAL_CONTAINS_PLACE";
  sourceUrl: string;
  observedAt: string;
  primaryKey: string;
  courses: Array<{
    key: string;
    name: string;
    url: string;
    latitude?: number;
    longitude?: number;
    publicAccess: "PUBLIC" | "PENDING";
    foreup?: { scheduleId: number; bookingClassId: number; bookingBaseUrl: string };
  }>;
};

export const normalizeFacilityCourseName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
export const isPhysicalCourseName = (value: string) => value.length >= 3 && value.length <= 200 &&
  !/[\u0000-\u001f\u007f<>]/u.test(value) &&
  !/\b(?:members?|league|tournament|outing|event|lesson|practice|range|simulator|footgolf|miniature|front nine|back nine|front 9|back 9|rate|rental)\b/iu.test(value) &&
  !/^(?:(?:9|18)[ -]?holes?|public|online|tee times|tee sheet)$/iu.test(value.trim());

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);
const golfCourse = (value: RecordValue) => [value["@type"]].flat().some(type => type === "GolfCourse" || type === "https://schema.org/GolfCourse");

/** Only an explicit official containsPlace relationship qualifies. A chain's
 * directory, same hostname, nearby coordinates, or rate labels do not. Access
 * and physical hole counts are deliberately NOT inherited from the parent. */
export function detectOfficialSharedFacility(input: { html: string; sourceUrl: string; courseName: string }): DetectedFacility | null {
  if (input.html.length > 1_500_000) return null;
  let source: URL;
  try { source = new URL(input.sourceUrl); } catch { return null; }
  if (source.protocol !== "https:" || source.username || source.password || source.port) return null;
  const nodes: RecordValue[] = [];
  function visit(value: unknown, depth = 0) {
    if (depth > 6 || nodes.length > 500) return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 50)) visit(item, depth + 1); }
    else if (record(value)) { nodes.push(value); for (const item of Object.values(value)) visit(item, depth + 1); }
  }
  const scripts = [...input.html.matchAll(/<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/giu)];
  if (scripts.length > 30) return null;
  for (const script of scripts) { try { visit(JSON.parse(script[1])); } catch { /* Malformed unrelated markup is not evidence. */ } }
  if (nodes.length > 500) return null;
  const resolve = (value: unknown): RecordValue | null => {
    if (!record(value)) return null;
    if (golfCourse(value)) return value;
    const matches = nodes.filter(node => node["@id"] === value["@id"] && golfCourse(node));
    return value["@id"] && matches.length === 1 ? matches[0] : null;
  };
  const groups: DetectedFacility[] = [];
  for (const parent of nodes) {
    if (!Array.isArray(parent.containsPlace) || parent.containsPlace.length < 2 || parent.containsPlace.length > 10) continue;
    const courses: DetectedFacility["courses"] = [];
    for (const value of parent.containsPlace) {
      const child = resolve(value);
      if (!child || typeof child.name !== "string" || !isPhysicalCourseName(child.name) || !record(child.geo)) break;
      const latitude = Number(child.geo.latitude), longitude = Number(child.geo.longitude);
      if (child.geo.latitude === undefined || child.geo.longitude === undefined || !Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) break;
      try {
        const address = child.url ?? child["@id"];
        if (typeof address !== "string" || !address.trim()) break;
        const url = new URL(address, source);
        if (url.origin !== source.origin || url.username || url.password || url.search || url.hash ||
            /\b(?:login|checkout|reserve|members|payment)\b/iu.test(url.pathname)) break;
        courses.push({ key: url.href, name: child.name.trim(), url: url.href, latitude, longitude, publicAccess: "PENDING" });
      } catch { break; }
    }
    if (courses.length !== parent.containsPlace.length || new Set(courses.map(row => row.key)).size !== courses.length ||
        new Set(courses.map(row => normalizeFacilityCourseName(row.name))).size !== courses.length) continue;
    const primary = courses.filter(row => normalizeFacilityCourseName(row.name) === normalizeFacilityCourseName(input.courseName));
    if (primary.length !== 1 || courses.some(row => Math.abs(row.latitude! - primary[0].latitude!) > 0.02 || Math.abs(row.longitude! - primary[0].longitude!) > 0.02)) continue;
    groups.push({ method: "OFFICIAL_CONTAINS_PLACE", sourceUrl: source.href, observedAt: new Date().toISOString(), primaryKey: primary[0].key, courses });
  }
  return groups.length === 1 ? groups[0] : null;
}
