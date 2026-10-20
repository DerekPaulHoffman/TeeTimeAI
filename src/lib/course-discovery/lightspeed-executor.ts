import { createHash } from "node:crypto";
import { z } from "zod";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { isSafeRecipeUrl, type AccessExecutionInput, type AccessExecutionResult } from "./recipe";
import { requestFamilyForUrl } from "./request-family";
import { lightspeedCatalogSchema, lightspeedDocumentText, lightspeedMetadata, lightspeedMetadataSchema, lightspeedProps,
  parseLightspeedSource, verifyLightspeedDocumentUrl, verifyLightspeedOfficialPage, type LightspeedMetadata } from "./lightspeed-source";

type Source = { officialUrl: string; bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string };
type Deps = { fetch?: typeof fetch; deadlineAt?: Date;
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }> };
const id = z.string().uuid();
const slotSchema = z.object({ time: z.string().datetime({ offset: true }), employmentIds: z.array(id).max(40), locationIds: z.array(id).min(1).max(40) });
const timePropsSchema = z.object({ companyId: id, variationId: id, duration: z.string().regex(/^\d{1,3}$/u),
  timeZone: z.string().min(3).max(80), hasSession: z.literal(false), service: lightspeedCatalogSchema.shape.services.element,
  slots: z.array(slotSchema).max(500) });

function createReader(source: Source, deps: Deps) {
  const context = parseLightspeedSource(source.bookingUrl);
  if (!context || !isSafeRecipeUrl(source.officialUrl)) throw new Error("INVALID_ADAPTER_SOURCE");
  const cancellation = new AbortController();
  const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(Math.max(1, Math.min(90_000, (deps.deadlineAt?.getTime() ?? Date.now() + 90_000) - Date.now())))]);
  const queue = createSimulatorBrowserRequestQueue(deps.requestLease ?? runWithProviderRequestLease, signal);
  const allowed = new Set([context.url, source.officialUrl]);
  let count = 0, bytes = 0;
  const read = async (url: string) => {
    if (!allowed.has(url) || ++count > 44) throw new Error("UNSCOPED_ADAPTER_REQUEST");
    const parseUrl = (value: string) => {
      if (!isSafeRecipeUrl(value) || value !== url) throw new Error("UNSCOPED_ADAPTER_REQUEST");
      const target = new URL(value);
      return target;
    };
    const transport = deps.fetch ?? createAddressPinnedPublicFetchTransport({ parseUrl, maxResponseBytes: 2_000_000,
      timeoutMs: 15_000, redirectLimit: 0 });
    return queue.run(requestFamilyForUrl(url), async () => {
      const response = await transport(url, { method: "GET", signal, credentials: "omit", redirect: "manual", cache: "no-store",
        headers: { accept: "text/html", "user-agent": "TeeTimeSpot/1.0 (+https://teetimespot.com)" } });
      if (response.status === 429) throw new Error("PROVIDER_THROTTLED");
      if (response.status !== 200 || response.redirected || response.url && parseUrl(response.url).href !== new URL(response.url).href)
        throw new Error("ADAPTER_TRANSPORT_FAILED");
      if (!/^text\/html(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) throw new Error("ADAPTER_RESPONSE_INVALID");
      const buffer = await response.arrayBuffer(); bytes += buffer.byteLength;
      if (buffer.byteLength > 2_000_000 || bytes > 12_000_000) throw new Error("ADAPTER_RESPONSE_LIMIT");
      return Buffer.from(buffer).toString("utf8");
    });
  };
  const configuration = async () => {
    verifyLightspeedOfficialPage(source, await read(source.officialUrl));
    const html = await read(context.url); verifyLightspeedDocumentUrl(html, context.url);
    const parsed = lightspeedCatalogSchema.safeParse(lightspeedProps(html, ["companyId", "facilityId", "services"]));
    if (!parsed.success || parsed.data.companyId !== context.companyId) throw new Error("ADAPTER_CONFIGURATION_UNVERIFIED");
    return { metadata: lightspeedMetadata(parsed.data), catalog: parsed.data };
  };
  return { configuration, read, allow: (url: string) => allowed.add(url), close: () => { cancellation.abort(); queue.dispose(); } };
}

export async function inspectLightspeed(source: Source, deps: Deps): Promise<LightspeedMetadata> {
  const reader = createReader(source, deps);
  try { return (await reader.configuration()).metadata; } finally { reader.close(); }
}

/** Public client evidence (2026-10-20): service component lists availableDurations
 * and matches variation.duration, not variation.bookable. Resource component
 * chooses the matching variation, and time component renders slots directly,
 * adding requested duration to each UTC start. No schedule subtraction is used.
 * Inspected component SHA256: 28d2fd7a...a8ddf / 90bbbee8...49fb4 /
 * 025201dd...a023b; complete hashes and captures are in the development receipt. */
export async function executeLightspeed(source: Source, metadata: LightspeedMetadata, target: { courseId: string; offeringId: string },
  input: AccessExecutionInput, deps: Deps): Promise<AccessExecutionResult["slots"]> {
  const reader = createReader(source, deps);
  try {
    const configuration = await reader.configuration();
    if (JSON.stringify(configuration.metadata) !== JSON.stringify(lightspeedMetadataSchema.parse(metadata)) || !input.durationMinutes)
      throw new Error("ADAPTER_CONFIGURATION_CHANGED");
    const results: AccessExecutionResult["slots"] = [], keys = new Set<string>(); let productsRead = 0;
    for (const service of metadata.services) {
      const variation = service.durations.find(value => value.minutes === input.durationMinutes);
      if (!variation) continue; // Public catalog proves this service does not sell the requested duration.
      productsRead++;
      for (const locationId of service.locationIds) {
        const url = new URL(`${source.bookingUrl.replace(/\/$/u, "")}/time`);
        for (const [key, value] of Object.entries({ facilityId: metadata.facilityId, serviceId: service.id, duration: String(input.durationMinutes),
          variationId: variation.variationId, locationId, date: input.date })) url.searchParams.set(key, value);
        reader.allow(url.href);
        const html = await reader.read(url.href); verifyLightspeedDocumentUrl(html, url.href);
        const parsed = timePropsSchema.safeParse(lightspeedProps(html, ["companyId", "variationId", "duration", "slots", "service", "timeZone"]));
        if (!parsed.success) throw new Error("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
        const data = parsed.data;
        if (data.companyId !== metadata.companyId || data.variationId !== variation.variationId || Number(data.duration) !== input.durationMinutes ||
            data.timeZone !== input.timeZone || input.timeZone !== source.timeZone ||
            JSON.stringify(lightspeedMetadata({ companyId: metadata.companyId, facilityId: metadata.facilityId, services: [data.service] }).services[0]) !== JSON.stringify(service))
          throw new Error("ADAPTER_RESOURCE_MISMATCH");
        if (!data.slots.length && !/There are no available time slots/iu.test(lightspeedDocumentText(html))) throw new Error("ADAPTER_EMPTY_UNVERIFIED");
        for (const slot of data.slots) {
          const startsAt = new Date(slot.time), endsAt = new Date(startsAt.getTime() + input.durationMinutes * 60_000);
          const local = new Intl.DateTimeFormat("en-CA", { timeZone: input.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(startsAt);
          if (local !== input.date || slot.employmentIds.length || slot.locationIds.length !== 1 || slot.locationIds[0] !== locationId)
            throw new Error("ADAPTER_SLOT_MISMATCH");
          const resourceId = `lightspeed-location:${locationId}`, productId = `lightspeed-service:${service.id}`;
          const sourceId = createHash("sha256").update([target.courseId, target.offeringId, resourceId, productId, startsAt.toISOString(), endsAt.toISOString()].join("\n")).digest("hex");
          if (keys.has(sourceId)) throw new Error("ADAPTER_DUPLICATE_SLOT"); keys.add(sourceId);
          results.push({ sourceId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), availableSpots: 1, capacity: null,
            resourceId, productId, bookingUrl: source.bookingUrl });
          if (results.length > 500) throw new Error("ADAPTER_RESPONSE_LIMIT");
        }
      }
    }
    if (!productsRead) throw new Error("ADAPTER_DURATION_UNSUPPORTED");
    return results;
  } finally { reader.close(); }
}
