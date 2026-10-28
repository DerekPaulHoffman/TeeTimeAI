import { z } from "zod";

// Persisted provider knowledge. Each member remains an ordinary Course with
// its own preferences, probes, matches and scheduler. Keep validation out of
// the client-only selection helpers so the cards do not import Zod.
const scopeSchema = z.object({
  rootCourseId: z.string().min(1).max(100),
  courseIds: z.array(z.string().min(1).max(100)).min(2).max(10),
  sourceBookingUrl: z.url().optional(),
  verifiedAt: z.iso.datetime().optional(),
  detectionMethod: z.enum(["FOREUP_PUBLIC_CATALOG", "OFFICIAL_CONTAINS_PLACE"]).optional(),
}).strict().refine(value => new Set(value.courseIds).size === value.courseIds.length && value.courseIds.includes(value.rootCourseId));

export function readSharedFacilityScope(metadata: unknown, courseId: string) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const parsed = scopeSchema.safeParse((metadata as Record<string, unknown>).sharedFacility);
  return parsed.success && parsed.data.courseIds.includes(courseId) ? parsed.data : null;
}
