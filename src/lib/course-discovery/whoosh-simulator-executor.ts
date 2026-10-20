import { createHash } from "node:crypto";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import type { AccessExecutionInput, AccessExecutionResult } from "./recipe";
import { requestFamilyForUrl } from "./request-family";
import { parseWhooshSimulatorSource, whooshAvailabilitySchema, whooshBuckets, whooshFacilitySchema, whooshSimulatorMetadataSchema, type WhooshSimulatorMetadata } from "./whoosh-simulator-source";

const endpoint = "https://api.app.whoosh.io/private/api";
/** Derived from the signed-out public client observed 2026-10-20, SHA256
 * f61fb013194a94009a508d523e3f07304e8ee21975c34bb21cb86e3935886dba. Its AgendaTime
 * projection uses availableTimes directly and seriesLength * 15 for duration.
 * Session/profile, booking/rates and event fields are intentionally absent. */
export const WHOOSH_SIMULATOR_CONFIGURATION_QUERY = `query TeeTimeSpotSimulatorConfiguration($facilitySlug:String!) {
  facility(slug:$facilitySlug) {
    id name slug type department{type} durations
    publicBookingPermissionSet{isFacilityVisible isFacilityBookable}
    club{id name slug supportsPublic timeZone}
    courses(first:100){pageInfo{hasNextPage hasPreviousPage} edges{node{id name}}}
    courseBuckets(first:100){pageInfo{hasNextPage hasPreviousPage} edges{node{id name courses{id}}}}
  }
}`;
export const WHOOSH_SIMULATOR_AVAILABILITY_QUERY = `query TeeTimeSpotSimulatorAvailability($facilityId:ID!,$date:Date!,$duration:Int!,$courseBucketIds:[ID!],$groupSize:Int) {
  node(id:$facilityId) {
    __typename
    ... on Facility {
      id club{id slug supportsPublic}
      courses(first:100){pageInfo{hasNextPage hasPreviousPage} edges{node{id name}}}
      courseBuckets(first:100){pageInfo{hasNextPage hasPreviousPage} edges{node{id name courses{id}}}}
      agendas(first:2,dateGte:$date,dateLte:$date) { pageInfo{hasNextPage hasPreviousPage} edges { node {
        id date facility{id durations}
        availableTimes(minDuration:$duration,maxDuration:$duration,playerCount:$groupSize,courseBucketIds:$courseBucketIds) {time dateTime capacity(bookingType:STANDARD) courseBucket{id name} seriesLength}
        blockingRestrictions:bookingRules(type:[RESTRICTION],bookingType:[STANDARD],isBlocking:true,memberVisibility:[RESTRICTION_ONLY,SLOTS_AND_RESTRICTION]){edges{node{id}}}
      } } }
    }
  }
}`;
type Source = { bookingUrl: string; venueName: string; timeZone: string };
type Deps = { fetch?: typeof fetch; deadlineAt?: Date; venueMatches: (expected: string, observed: unknown) => boolean;
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }> };
function createReader(source: Source, deps: Deps) {
  const context = parseWhooshSimulatorSource(source.bookingUrl);
  if (!context) throw new Error("INVALID_ADAPTER_SOURCE");
  const cancellation = new AbortController();
  const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(Math.max(1, Math.min(90_000, (deps.deadlineAt?.getTime() ?? Date.now() + 90_000) - Date.now())))]);
  const queue = createSimulatorBrowserRequestQueue(deps.requestLease ?? runWithProviderRequestLease, signal);
  let count = 0, bytes = 0;
  const read = async (query: string, variables: Record<string, unknown>) => {
    if (++count > 2 || ![WHOOSH_SIMULATOR_CONFIGURATION_QUERY, WHOOSH_SIMULATOR_AVAILABILITY_QUERY].includes(query)) throw new Error("UNSAFE_ADAPTER_REQUEST");
    const body = JSON.stringify({ query, variables });
    const transport = deps.fetch ?? createAddressPinnedPublicFetchTransport({ parseUrl: value => {
      if (value !== endpoint) throw new Error("UNSCOPED_ADAPTER_REQUEST"); return new URL(value);
    }, maxResponseBytes: 2_000_000, timeoutMs: 15_000, redirectLimit: 0,
    authorizeReadPost: (url, headers, value) => url.href === endpoint && value === body && headers.get("x-whoosh-member-club-slug") === context.clubSlug });
    return queue.run(requestFamilyForUrl(endpoint), async () => {
      const response = await transport(endpoint, { method: "POST", signal, credentials: "omit", redirect: "manual", cache: "no-store",
        headers: { accept: "application/json", "content-type": "application/json", "x-whoosh-member-club-slug": context.clubSlug }, body });
      if (response.status === 429) throw new Error("PROVIDER_THROTTLED");
      if (!response.ok || response.redirected || response.url && response.url !== endpoint) throw new Error("ADAPTER_TRANSPORT_FAILED");
      if (!/^application\/json(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) throw new Error("ADAPTER_RESPONSE_INVALID");
      const data = await response.arrayBuffer(); bytes += data.byteLength;
      if (data.byteLength > 2_000_000 || bytes > 4_000_000) throw new Error("ADAPTER_RESPONSE_LIMIT");
      const parsed = JSON.parse(Buffer.from(data).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || parsed.errors !== undefined || !parsed.data || typeof parsed.data !== "object") throw new Error("ADAPTER_GRAPHQL_ERROR");
      return parsed.data;
    });
  };
  const configuration = async () => {
    const data = await read(WHOOSH_SIMULATOR_CONFIGURATION_QUERY, { facilitySlug: context.facilitySlug });
    const parsed = whooshFacilitySchema.safeParse(data.facility);
    if (!parsed.success) throw new Error("ADAPTER_CONFIGURATION_UNVERIFIED");
    const facility = parsed.data;
    if (facility.slug !== context.facilitySlug || facility.club.slug !== context.clubSlug || facility.club.timeZone !== source.timeZone ||
        (!deps.venueMatches(source.venueName, facility.name) && !deps.venueMatches(source.venueName, facility.club.name)) ||
        new Set(facility.durations).size !== facility.durations.length) throw new Error("ADAPTER_IDENTITY_MISMATCH");
    const metadata = whooshSimulatorMetadataSchema.parse({ family: "WHOOSH", ...context, facilityId: facility.id, clubId: facility.club.id, courseBuckets: whooshBuckets(facility) });
    return { metadata, facility };
  };
  return { read, configuration, close: () => { cancellation.abort(); queue.dispose(); } };
}
export async function inspectWhooshSimulator(source: Source, deps: Deps) {
  const reader = createReader(source, deps);
  try { return (await reader.configuration()).metadata; } finally { reader.close(); }
}
export async function executeWhooshSimulator(source: Source, metadata: WhooshSimulatorMetadata, target: { courseId: string; offeringId: string }, input: AccessExecutionInput,
  deps: Deps & { toInstant: (value: unknown, input: AccessExecutionInput) => Date }): Promise<AccessExecutionResult["slots"]> {
  const reader = createReader(source, deps);
  try {
    const configuration = await reader.configuration();
    if (JSON.stringify(configuration.metadata) !== JSON.stringify(metadata) || !input.durationMinutes || !configuration.facility.durations.includes(input.durationMinutes))
      throw new Error("ADAPTER_CONFIGURATION_CHANGED");
    const data = await reader.read(WHOOSH_SIMULATOR_AVAILABILITY_QUERY, { facilityId: metadata.facilityId, date: input.date, duration: input.durationMinutes,
      groupSize: 1, courseBucketIds: metadata.courseBuckets.map(bucket => bucket.id) });
    const parsed = whooshAvailabilitySchema.safeParse(data.node);
    if (!parsed.success) throw new Error("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
    const facility = parsed.data;
    if (facility.id !== metadata.facilityId || facility.club.id !== metadata.clubId || facility.club.slug !== metadata.clubSlug ||
        JSON.stringify(whooshBuckets(facility)) !== JSON.stringify(metadata.courseBuckets)) throw new Error("ADAPTER_RESOURCE_MISMATCH");
    const agenda = facility.agendas.edges[0].node;
    if (agenda.date !== input.date || agenda.facility.id !== metadata.facilityId || !agenda.facility.durations.includes(input.durationMinutes)) throw new Error("ADAPTER_DATE_MISMATCH");
    if (agenda.blockingRestrictions.edges.length) throw new Error("ADAPTER_BLOCKING_RESTRICTION");
    const keys = new Set<string>();
    return agenda.availableTimes.map(row => {
      const bucket = metadata.courseBuckets.find(bucket => bucket.id === row.courseBucket.id && bucket.name === row.courseBucket.name);
      if (!bucket || row.seriesLength * 15 < input.durationMinutes! || row.dateTime.slice(0, 10) !== input.date || row.dateTime.slice(11) !== row.time)
        throw new Error("ADAPTER_SLOT_MISMATCH");
      const startsAt = deps.toInstant(row.dateTime.replace(" ", "T"), input), endsAt = new Date(startsAt.getTime() + input.durationMinutes! * 60_000);
      const local = new Intl.DateTimeFormat("en-CA", { timeZone: input.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(startsAt);
      if (local !== input.date) throw new Error("ADAPTER_DATE_MISMATCH");
      const resourceId = `whoosh-bucket:${bucket.id}`, productId = metadata.facilityId;
      const sourceId = createHash("sha256").update([target.courseId, target.offeringId, resourceId, startsAt.toISOString(), endsAt.toISOString()].join("\n")).digest("hex");
      if (keys.has(sourceId)) throw new Error("ADAPTER_DUPLICATE_SLOT"); keys.add(sourceId);
      // Provider capacity is a scheduling quantity, not a proven golfer limit.
      return { sourceId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), availableSpots: 1, capacity: null,
        resourceId, productId, bookingUrl: source.bookingUrl };
    });
  } finally { reader.close(); }
}
