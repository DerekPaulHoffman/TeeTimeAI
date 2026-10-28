import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isForeupMetadata } from "@/lib/adapters/foreup";
import { loadSharedFacilityCourses } from "./shared-facility-store";
import { readSharedFacilityScope } from "./shared-facility-scope";
import { isPhysicalCourseName, normalizeFacilityCourseName, type DetectedFacility } from "./shared-facility-detection";

const object = (value: unknown): Prisma.JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as Prisma.JsonObject : {};
function foreupFacility(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "foreupsoftware.com" && !url.username && !url.password && !url.port && !url.search
      ? /^\/index\.php\/booking\/(?:index\/)?([1-9]\d*)(?:\/[1-9]\d*)?\/?$/u.exec(url.pathname)?.[1] : undefined;
  } catch { return undefined; }
}
class ConflictingFacility extends Error {}
function sameOfficialSite(expected: string, observed: string) {
  const original = new URL(expected), current = new URL(observed);
  return ["http:", "https:"].includes(original.protocol) && current.protocol === "https:" &&
    !original.username && !original.password && !current.username && !current.password && !original.port && !current.port &&
    original.hostname.replace(/^www\./u, "") === current.hostname.replace(/^www\./u, "");
}

/** Called only with fresh, fixed-parser observations. Writes reusable course
 * knowledge, never preferences, searches, recipients, recipes or monitoring
 * success. All network work has already finished outside this transaction. */
export async function detectAndSaveFacilityCourses(courseId: string, detection: DetectedFacility) {
  try {
    const age = Date.now() - Date.parse(detection.observedAt);
    if (!Number.isFinite(age) || age < -5000 || age > 300_000 || !detection.courses.length || detection.courses.length > 10 ||
        new Set(detection.courses.map(row => row.key)).size !== detection.courses.length ||
        new Set(detection.courses.map(row => normalizeFacilityCourseName(row.name))).size !== detection.courses.length ||
        detection.courses.some(row => !isPhysicalCourseName(row.name))) return undefined;
    const result = await prisma.$transaction(async tx => {
      const root = await tx.course.findUnique({ where: { id: courseId } });
      if (!root || root.isPublic !== true || root.monitoringMode === "LOCAL_READER_ONLY") return null;
      const primary = detection.courses.find(row => row.key === detection.primaryKey);
      if (!primary || normalizeFacilityCourseName(primary.name) !== normalizeFacilityCourseName(root.name)) return null;
      const oldScope = readSharedFacilityScope(root.bookingMetadata, root.id);
      // Checking a child must not turn it into a second competing root.
      if (oldScope && oldScope.rootCourseId !== root.id) return { id: root.id, bookingMetadata: root.bookingMetadata };
      if (detection.method === "FOREUP_PUBLIC_CATALOG") {
        if (root.providerFamilyKey !== "FOREUP" || !isForeupMetadata(root.bookingMetadata) ||
            !foreupFacility(detection.sourceUrl) || foreupFacility(detection.sourceUrl) !== foreupFacility(root.bookingMetadata.bookingBaseUrl) ||
            primary.foreup?.scheduleId !== root.bookingMetadata.scheduleId ||
            root.bookingMetadata.bookingClassId !== undefined && primary.foreup.bookingClassId !== root.bookingMetadata.bookingClassId ||
            detection.courses.some(row => !row.foreup || row.publicAccess !== "PUBLIC" || String(row.foreup.scheduleId) !== row.key ||
              foreupFacility(row.url) !== foreupFacility(detection.sourceUrl))) return null;
      } else {
        if (!root.website || !sameOfficialSite(root.website, detection.sourceUrl) || detection.courses.some(row =>
          row.publicAccess !== "PENDING" || row.foreup || !sameOfficialSite(root.website!, row.url) ||
          row.latitude === undefined || row.longitude === undefined || Math.abs(row.latitude - root.latitude) > 0.02 || Math.abs(row.longitude - root.longitude) > 0.02)) return null;
      }
      if (detection.courses.length === 1 && !oldScope?.detectionMethod) return null;
      const members = [];
      for (const row of detection.courses) {
        if (row.key === detection.primaryKey) { members.push(root); continue; }
        const id = `public-course-${createHash("sha256").update(`${root.id}|${row.foreup ? row.foreup.scheduleId : `OFFICIAL|${row.key}`}`).digest("hex").slice(0, 24)}`;
        const existing = await tx.course.findMany({ where: { OR: [{ id }, ...(row.foreup ? [{
          providerFamilyKey: "FOREUP", latitude: { gte: root.latitude - 0.02, lte: root.latitude + 0.02 },
          longitude: { gte: root.longitude - 0.02, lte: root.longitude + 0.02 },
          bookingMetadata: { path: ["scheduleId"], equals: row.foreup.scheduleId },
        }] : [{ website: row.url, name: row.name }])] } });
        const matches = existing.filter(course => course.id === id || (row.foreup ? isForeupMetadata(course.bookingMetadata) &&
          foreupFacility(course.bookingMetadata.bookingBaseUrl) === foreupFacility(detection.sourceUrl) : course.website === row.url &&
          Math.abs(course.latitude - root.latitude) <= 0.02 && Math.abs(course.longitude - root.longitude) <= 0.02));
        if (matches.length > 1) throw new ConflictingFacility();
        const saved = matches[0];
        const savedScope = saved && readSharedFacilityScope(saved.bookingMetadata, saved.id);
        if (saved && (saved.isPublic === false || normalizeFacilityCourseName(saved.name) !== normalizeFacilityCourseName(row.name) ||
            savedScope && savedScope.rootCourseId !== root.id || row.foreup && (!isForeupMetadata(saved.bookingMetadata) ||
              saved.bookingMetadata.scheduleId !== row.foreup.scheduleId || foreupFacility(saved.bookingMetadata.bookingBaseUrl) !== foreupFacility(detection.sourceUrl)))) throw new ConflictingFacility();
        members.push(saved ?? await tx.course.create({ data: {
          id, name: row.name, address: root.address, city: root.city, stateCode: root.stateCode, stateName: root.stateName,
          county: root.county, countryCode: root.countryCode, latitude: row.latitude ?? root.latitude, longitude: row.longitude ?? root.longitude,
          timeZone: root.timeZone, website: row.foreup ? root.website : row.url, phone: root.phone,
          isPublic: row.publicAccess === "PUBLIC" ? true : null,
          ...(row.foreup ? { detectedPlatform: "FOREUP", providerFamilyKey: "FOREUP", detectedBookingUrl: row.url,
            bookingMethod: "PUBLIC_ONLINE", bookingAccessMode: "PUBLIC_SIGNED_OUT", automationEligibility: "ALLOWED", bookingMetadata: row.foreup } :
            { bookingMetadata: { officialFacilitySource: detection.sourceUrl }, automationEligibility: "UNKNOWN" }),
          // No copied layouts, rates, windows, health, access recipes or matches.
        } }));
      }
      const courseIds = [root.id, ...members.filter(row => row.id !== root.id).map(row => row.id)].sort((a, b) => a === root.id ? -1 : b === root.id ? 1 : a.localeCompare(b));
      if (oldScope && !oldScope.detectionMethod && oldScope.courseIds.some(id => !courseIds.includes(id))) throw new ConflictingFacility();
      const scope = courseIds.length > 1 ? { rootCourseId: root.id, courseIds, sourceBookingUrl: detection.sourceUrl,
        verifiedAt: detection.observedAt, detectionMethod: detection.method } : null;
      const sameGroup = oldScope && scope && JSON.stringify(oldScope.courseIds) === JSON.stringify(scope.courseIds) && oldScope.sourceBookingUrl === scope.sourceBookingUrl;
      if (sameGroup && Date.now() - Date.parse(oldScope.verifiedAt ?? "") < 86400_000 && members.every(member => {
        const matching = detection.courses.find(row => normalizeFacilityCourseName(row.name) === normalizeFacilityCourseName(member.name));
        return JSON.stringify(readSharedFacilityScope(member.bookingMetadata, member.id)) === JSON.stringify(oldScope) &&
          (!matching?.foreup || isForeupMetadata(member.bookingMetadata) && member.bookingMetadata.bookingClassId === matching.foreup.bookingClassId);
      })) return { id: root.id, bookingMetadata: root.bookingMetadata };
      const metadata = { ...object(root.bookingMetadata) };
      if (scope) metadata.sharedFacility = scope; else delete metadata.sharedFacility;
      const updated = await tx.course.updateMany({ where: { id: root.id, updatedAt: root.updatedAt }, data: { bookingMetadata: metadata } });
      if (updated.count !== 1) throw new ConflictingFacility();
      const oldMembers = oldScope ? await tx.course.findMany({ where: { id: { in: oldScope.courseIds.filter(id => id !== root.id) } } }) : [];
      for (const member of [...new Map([...oldMembers, ...members.filter(row => row.id !== root.id)].map(row => [row.id, row])).values()]) {
        const previous = readSharedFacilityScope(member.bookingMetadata, member.id);
        if (previous && previous.rootCourseId !== root.id) throw new ConflictingFacility();
        const data = { ...object(member.bookingMetadata) };
        const observed = detection.courses.find(row => normalizeFacilityCourseName(row.name) === normalizeFacilityCourseName(member.name));
        if (observed?.foreup) Object.assign(data, observed.foreup);
        if (scope && courseIds.includes(member.id)) data.sharedFacility = scope; else delete data.sharedFacility;
        const changed = await tx.course.updateMany({ where: { id: member.id, updatedAt: member.updatedAt }, data: { bookingMetadata: data } });
        if (changed.count !== 1) throw new ConflictingFacility();
      }
      return { id: root.id, bookingMetadata: metadata };
    });
    return result ? await loadSharedFacilityCourses(result) : undefined;
  } catch {
    // Optional knowledge enrichment cannot turn a successful availability read
    // into a failure. Conflicting groups remain unchanged; next check retries.
    return undefined;
  }
}
