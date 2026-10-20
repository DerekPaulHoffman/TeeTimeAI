import { z } from "zod";

const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?$/u);
const id = (kind: string) => z.string().regex(new RegExp(`^${kind}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, "iu"));
export const whooshBucketSchema = z.object({ id: id("CourseBucket"), name: z.string().min(1).max(160),
  courseIds: z.array(id("Course")).min(1).max(40).refine(values => new Set(values).size === values.length) }).strict();
export const whooshSimulatorMetadataSchema = z.object({ family: z.literal("WHOOSH"), clubSlug: slug, facilitySlug: slug,
  clubId: id("Club"), facilityId: id("Facility"), courseBuckets: z.array(whooshBucketSchema).min(1).max(20)
    .refine(values => new Set(values.map(value => value.id)).size === values.length) }).strict();
export type WhooshSimulatorMetadata = z.infer<typeof whooshSimulatorMetadataSchema>;
export function parseWhooshSimulatorSource(value: string) {
  try {
    const url = new URL(value);
    const match = /^\/patron\/club\/([^/]+)\/agenda\/([^/]+)\/(?:today|\d{4}-\d{2}-\d{2})\/?$/u.exec(url.pathname);
    if (url.protocol !== "https:" || url.hostname !== "app.whoosh.io" || url.username || url.password || url.port || url.search || url.hash ||
      !match || !slug.safeParse(match[1]).success || !slug.safeParse(match[2]).success) return;
    return { clubSlug: match[1], facilitySlug: match[2] };
  } catch { return; }
}

const course = z.object({ id: id("Course"), name: z.string().min(1).max(160) });
const bucket = z.object({ id: id("CourseBucket"), name: z.string().min(1).max(160), courses: z.array(z.object({ id: id("Course") })).min(1).max(40) });
const pageInfo = z.object({ hasNextPage: z.literal(false), hasPreviousPage: z.literal(false) });
export const whooshFacilitySchema = z.object({ id: id("Facility"), name: z.string().min(2).max(200), slug,
  type: z.literal("SIMULATOR"), department: z.object({ type: z.literal("GOLF") }),
  durations: z.array(z.number().int().min(15).max(480)).min(1).max(32),
  publicBookingPermissionSet: z.object({ isFacilityVisible: z.literal(true), isFacilityBookable: z.literal(true) }),
  club: z.object({ id: id("Club"), slug, name: z.string().min(2).max(200), supportsPublic: z.literal(true), timeZone: z.string().min(3).max(80) }),
  courses: z.object({ pageInfo, edges: z.array(z.object({ node: course })).min(1).max(40) }),
  courseBuckets: z.object({ pageInfo, edges: z.array(z.object({ node: bucket })).min(1).max(20) }),
});
export const whooshAvailabilitySchema = z.object({ __typename: z.literal("Facility"), id: id("Facility"),
  club: z.object({ id: id("Club"), slug, supportsPublic: z.literal(true) }),
  courses: z.object({ pageInfo, edges: z.array(z.object({ node: course })).min(1).max(40) }),
  courseBuckets: z.object({ pageInfo, edges: z.array(z.object({ node: bucket })).min(1).max(20) }),
  agendas: z.object({ pageInfo, edges: z.array(z.object({ node: z.object({ id: id("Agenda"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    facility: z.object({ id: id("Facility"), durations: z.array(z.number().int().min(15).max(480)).min(1).max(32) }),
    availableTimes: z.array(z.object({ dateTime: z.string().regex(/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u),
      time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u), seriesLength: z.number().int().min(1).max(192),
      capacity: z.number().int().min(1).max(100).nullable(), courseBucket: z.object({ id: id("CourseBucket"), name: z.string().min(1).max(160) }) })).max(500),
    blockingRestrictions: z.object({ edges: z.array(z.unknown()).max(1000) }),
  }) })).length(1) }),
});
export function whooshBuckets(facility: z.infer<typeof whooshFacilitySchema> | z.infer<typeof whooshAvailabilitySchema>) {
  const courses = facility.courses.edges.map(edge => edge.node.id);
  const buckets = facility.courseBuckets.edges.map(({ node }) => ({ id: node.id, name: node.name, courseIds: node.courses.map(course => course.id).sort() })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const linked = buckets.flatMap(bucket => bucket.courseIds);
  if (new Set(courses).size !== courses.length || new Set(linked).size !== linked.length || linked.length !== courses.length || linked.some(id => !courses.includes(id)) ||
      new Set(buckets.map(bucket => bucket.id)).size !== buckets.length ||
      buckets.some(bucket => /\b(?:lessons?|coaching|fittings?|leagues?|membership|members?|multi[- ]?sport|baseball|soccer|tennis|hockey)\b/iu.test(bucket.name)))
    throw new Error("ADAPTER_RESOURCE_MISMATCH");
  return buckets;
}
