import { z } from "zod";
import { normalizePublicCoursePhone } from "./teeitup-postal-conflict-proof";

/** Private controller context. Never include this in a model identity or tool. */
export const discoveryTrustedContextSchema = z.object({
  canonicalCoursePhone: z.string().regex(/^\+1[2-9]\d{2}[2-9]\d{6}$/u).optional(),
}).strict();
export type DiscoveryTrustedContext = z.infer<typeof discoveryTrustedContextSchema>;

export function deriveCourseTrustedContext(course: { phone?: unknown }): DiscoveryTrustedContext {
  const canonicalCoursePhone = normalizePublicCoursePhone(course.phone);
  return canonicalCoursePhone ? { canonicalCoursePhone } : {};
}

export function isCurrentTrustedContext(value: unknown, current: DiscoveryTrustedContext) {
  const parsed = discoveryTrustedContextSchema.safeParse(value);
  return parsed.success && parsed.data.canonicalCoursePhone === current.canonicalCoursePhone;
}
