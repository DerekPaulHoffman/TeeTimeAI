import { fetchForeupTeeSheet } from "@/lib/adapters/foreup";
import { fetchTeeItUpTeeSheet } from "@/lib/adapters/teeitup";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { readForeupPublicConfiguration } from "@/lib/automation/foreup-public-configuration";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { fetchAcuitySimulatorAvailability, parseAcuityPublicConfigurationIdentity, readAcuityPublicConfiguration } from "@/lib/simulators/providers/acuity";
import { isAcuityPublicBookingUrl } from "@/lib/simulators/providers/acuity";
import type { AcuityPublicConfiguration } from "@/lib/simulators/providers/public-configuration";
import { existingAdapterMetadataSchema, type ExistingAdapterMetadata, type ExistingAdapterRecipe } from "./existing-adapter-schema";
import { accessExecutionInputSchema, accessExecutionResultSchema, isSafeRecipeUrl, type AccessExecutionInput, type AccessExecutionResult } from "./recipe";
import { requestFamilyForUrl } from "./request-family";
import { assertTeeItUpRecipeAvailability, parseTeeItUpRecipeSource, resolveTeeItUpRecipeFacilities, teeItUpRecipeBookingUrl, type TeeItUpRecipeFacility } from "./teeitup-recipe-source";

type Dependencies = {
  fetch?: typeof fetch;
  now?: () => Date;
  deadlineAt?: Date;
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }>;
  venueMatches: (expected: string, observed: unknown) => boolean;
};
type Source = Pick<ExistingAdapterRecipe["source"], "bookingUrl" | "venueName" | "venueAddress" | "timeZone">;
const publicId = /^[1-9]\d{0,9}$/u;
const foreupPath = /^\/index\.php\/booking\/([1-9]\d{0,9})(?:\/([1-9]\d{0,9}))?\/?$/u;

function fail(code: string): never { throw new Error(code); }
function familyForSource(source: Source) {
  if (!isSafeRecipeUrl(source.bookingUrl)) return fail("INVALID_ADAPTER_SOURCE");
  const url = new URL(source.bookingUrl);
  if (url.hostname === "foreupsoftware.com" && !url.search && foreupPath.test(url.pathname)) return "FOREUP" as const;
  if (isAcuityPublicBookingUrl(source.bookingUrl)) return "ACUITY" as const;
  if (parseTeeItUpRecipeSource(source.bookingUrl)) return "TEEITUP" as const;
  return fail("UNSUPPORTED_ADAPTER_SOURCE");
}
function dateParameter(date: string) { const [year, month, day] = date.split("-"); return `${month}-${day}-${year}`; }
function exactKeys(url: URL, required: string[], optional: string[] = []) {
  const keys = [...url.searchParams.keys()];
  return new Set(keys).size === keys.length && required.every(key => keys.includes(key)) && keys.every(key => required.includes(key) || optional.includes(key));
}

/** One fixed GET-only transport for existing public readers; model-supplied
 * routes, headers, bodies and provider mutex names never enter this contract. */
function reader(source: Source, deps: Dependencies, adapter?: ExistingAdapterMetadata, input?: AccessExecutionInput) {
  const family = familyForSource(source);
  if (adapter && adapter.family !== family) fail("ADAPTER_SOURCE_MISMATCH");
  if (family === "TEEITUP" && !source.venueAddress) fail("ADAPTER_IDENTITY_MISSING");
  const clock = deps.now ?? (() => new Date());
  const deadline = Math.min(deps.deadlineAt?.getTime() ?? Infinity, clock().getTime() + 120_000);
  if (deadline <= clock().getTime()) fail("DEADLINE_EXCEEDED");
  const signal = AbortSignal.timeout(Math.max(1, deadline - clock().getTime()));
  const queue = createSimulatorBrowserRequestQueue(deps.requestLease ?? runWithProviderRequestLease, signal);
  const booking = new URL(source.bookingUrl); booking.hash = "";
  let acuity: AcuityPublicConfiguration | undefined;
  const teeitup = family === "TEEITUP" ? parseTeeItUpRecipeSource(source.bookingUrl)! : undefined;
  let teeitupFacilities: TeeItUpRecipeFacility[] | undefined;
  let availabilityWasArray = false;
  let transportFailure: string | undefined;
  let requests = 0;
  const parseUrl = (value: string) => {
    if (!isSafeRecipeUrl(value)) return fail("UNSCOPED_ADAPTER_REQUEST");
    const url = new URL(value);
    if (url.href === booking.href) return url;
    if (teeitup && url.origin === "https://phx-api-be-east-1b.kenna.io") {
      if (url.pathname === `/alias/${teeitup.alias}/facilities` && !url.search) return url;
      if (input && adapter?.family === "TEEITUP" && teeitupFacilities && url.pathname === "/v2/tee-times" &&
          exactKeys(url, ["date", "facilityIds", "returnPromotedRates"]) && url.searchParams.get("date") === input.date &&
          url.searchParams.get("returnPromotedRates") === "true" &&
          /^[1-9]\d*(?:,[1-9]\d*)*$/u.test(url.searchParams.get("facilityIds") ?? "") &&
          url.searchParams.get("facilityIds")!.split(",").map(Number).sort((a, b) => a - b).join(",") === teeitupFacilities.map(row => row.id).join(",")) return url;
    }
    if (family === "FOREUP" && url.origin === "https://foreupsoftware.com" && url.pathname === "/index.php/api/booking/times" &&
        exactKeys(url, ["time", "date", "holes", "players", "schedule_id", "booking_class"]) &&
        url.searchParams.get("time") === "all" && url.searchParams.get("holes") === "all" &&
        [dateParameter(new Date().toISOString().slice(0, 10)), ...(input ? [dateParameter(input.date)] : [])].includes(url.searchParams.get("date") ?? "") &&
        ["1", ...(input ? [String(input.players)] : [])].includes(url.searchParams.get("players") ?? "") &&
        publicId.test(url.searchParams.get("schedule_id") ?? "") && publicId.test(url.searchParams.get("booking_class") ?? "") &&
        (!adapter || adapter.family === "FOREUP" && url.searchParams.get("schedule_id") === String(adapter.scheduleId) &&
          url.searchParams.get("booking_class") === String(adapter.bookingClassId))) return url;
    if (family === "ACUITY" && acuity && input && [booking.origin, "https://app.acuityscheduling.com"].includes(url.origin) &&
        url.pathname === "/api/scheduling/v1/availability/times" &&
        exactKeys(url, ["owner", "calendarId", "appointmentTypeId", "startDate", "timezone"], ["maxDays"]) &&
        url.searchParams.get("owner") === acuity.ownerKey && url.searchParams.get("startDate") === input.date &&
        url.searchParams.get("timezone") === input.timeZone && (!url.searchParams.has("maxDays") || url.searchParams.get("maxDays") === "4") &&
        (url.searchParams.get("calendarId") === "any" || acuity.resources.some(row => row.id === url.searchParams.get("calendarId"))) &&
        acuity.rentals.some(row => row.id === url.searchParams.get("appointmentTypeId") && row.durationMinutes === input.durationMinutes) &&
        (!adapter || adapter.family === "ACUITY" && adapter.rentalProductIds.includes(url.searchParams.get("appointmentTypeId") ?? ""))) return url;
    return fail("UNSCOPED_ADAPTER_REQUEST");
  };
  const transport = deps.fetch ?? createAddressPinnedPublicFetchTransport({ parseUrl, maxResponseBytes: 600_000, timeoutMs: 15_000, redirectLimit: 0 });
  const read: typeof fetch = async (value, init) => {
    if (++requests > 6) fail("ADAPTER_REQUEST_LIMIT");
    const raw = value instanceof Request ? value.url : String(value);
    const method = (init?.method ?? (value instanceof Request ? value.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (value instanceof Request ? value.headers : undefined));
    if (method !== "GET" || init?.body || value instanceof Request && value.body ||
        ["authorization", "proxy-authorization", "cookie", "x-api-key"].some(key => headers.has(key))) fail("UNSAFE_ADAPTER_REQUEST");
    const url = parseUrl(raw);
    if (teeitup && url.hostname === "phx-api-be-east-1b.kenna.io" &&
        (headers.get("x-be-alias") !== teeitup.alias || headers.get("origin") !== teeitup.origin || headers.get("referer") !== `${teeitup.origin}/`))
      fail("UNSAFE_ADAPTER_REQUEST");
    return queue.run(requestFamilyForUrl(url.href), async () => {
      signal.throwIfAborted();
      const response = await transport(url, { ...init, method: "GET", headers, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
        credentials: "omit", redirect: "manual", cache: "no-store" });
      if (response.status === 429) { transportFailure = "PROVIDER_THROTTLED"; fail(transportFailure); }
      if ([401, 403].includes(response.status)) { transportFailure = "ACCESS_REQUIRED"; fail(transportFailure); }
      if (!response.ok || response.redirected || response.url && response.url !== url.href) fail("ADAPTER_TRANSPORT_FAILED");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 600_000) fail("ADAPTER_RESPONSE_LIMIT");
      const text = Buffer.from(bytes).toString("utf8");
      if (teeitup && url.pathname === `/alias/${teeitup.alias}/facilities`) {
        teeitupFacilities = resolveTeeItUpRecipeFacilities(source, JSON.parse(text));
        if (adapter && (adapter.family !== "TEEITUP" || adapter.alias !== teeitup.alias ||
            JSON.stringify(adapter.facilityIds) !== JSON.stringify(teeitupFacilities.map(row => row.id)))) fail("ADAPTER_CONFIGURATION_CHANGED");
      }
      if (teeitup && input && url.pathname === "/v2/tee-times") {
        assertTeeItUpRecipeAvailability(JSON.parse(text), teeitupFacilities!, input);
        availabilityWasArray = true;
      }
      if (family === "ACUITY" && url.href === booking.href) {
        const observed = parseAcuityPublicConfigurationIdentity(text, source.bookingUrl);
        if (!observed || !deps.venueMatches(source.venueName, observed.venueName) || observed.configuration.timeZone !== source.timeZone) fail("ADAPTER_IDENTITY_MISMATCH");
        acuity = observed.configuration;
        if (adapter && (adapter.family !== "ACUITY" || adapter.ownerKey !== acuity.ownerKey || adapter.businessId !== acuity.businessId ||
            !adapter.rentalProductIds.every(id => acuity!.rentals.some(row => row.id === id)))) fail("ADAPTER_CONFIGURATION_CHANGED");
      }
      if (family === "FOREUP" && input && url.pathname === "/index.php/api/booking/times" &&
          url.searchParams.get("date") === dateParameter(input.date) && url.searchParams.get("players") === String(input.players)) {
        const payload: unknown = JSON.parse(text);
        availabilityWasArray = Array.isArray(payload);
        if (availabilityWasArray && ((payload as unknown[]).length > 500 || (payload as unknown[]).some(row => {
          if (!row || typeof row !== "object" || Array.isArray(row)) return true;
          const slot = row as Record<string, unknown>;
          return typeof slot.time !== "string" || !slot.time.startsWith(`${input.date} `) && !slot.time.startsWith(`${input.date}T`) ||
            !Number.isInteger(slot.available_spots) || Number(slot.available_spots) < 0 || Number(slot.available_spots) > 100 ||
            adapter?.family === "FOREUP" && (slot.schedule_id !== undefined && Number(slot.schedule_id) !== adapter.scheduleId ||
              slot.booking_class_id !== undefined && Number(slot.booking_class_id) !== adapter.bookingClassId);
        }))) fail("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
      }
      return new Response(bytes, { status: response.status, headers: response.headers });
    });
  };
  return { read, family, teeitup, teeitupFacilities: () => teeitupFacilities, dispose: () => queue.dispose(), availabilityWasArray: () => availabilityWasArray, failureReason: () => transportFailure };
}

/** For a controller-observed provider URL only. Reads typed public configuration
 * and returns bounded IDs; availability and activation remain separate proofs. */
export async function inspectExistingAdapter(source: Source, deps: Dependencies): Promise<{ adapter: ExistingAdapterMetadata }> {
  const session = reader(source, deps);
  try {
    if (session.teeitup) {
      await session.read(`https://phx-api-be-east-1b.kenna.io/alias/${session.teeitup.alias}/facilities`, { headers: {
        accept: "application/json", "x-be-alias": session.teeitup.alias, origin: session.teeitup.origin, referer: `${session.teeitup.origin}/`,
      } });
      return { adapter: existingAdapterMetadataSchema.parse({ family: "TEEITUP", alias: session.teeitup.alias,
        facilityIds: session.teeitupFacilities()!.map(row => row.id) }) };
    }
    if (session.family === "FOREUP") {
      const config = await readForeupPublicConfiguration({ bookingUrl: source.bookingUrl, courseName: source.venueName,
        fetchImpl: session.read, rethrowError: () => true });
      if (!config) fail("ADAPTER_CONFIGURATION_UNVERIFIED");
      return { adapter: existingAdapterMetadataSchema.parse({ family: "FOREUP", facilityId: Number(foreupPath.exec(new URL(source.bookingUrl).pathname)![1]),
        scheduleId: config.scheduleId, bookingClassId: config.bookingClassId }) };
    }
    const observed = await readAcuityPublicConfiguration({ bookingUrl: source.bookingUrl, fetchImpl: session.read });
    if (!observed) fail("ADAPTER_CONFIGURATION_UNVERIFIED");
    return { adapter: existingAdapterMetadataSchema.parse({ family: "ACUITY", ownerKey: observed.configuration.ownerKey,
      businessId: observed.configuration.businessId, rentalProductIds: observed.configuration.rentals.map(row => row.id).sort() }) };
  } finally { session.dispose(); }
}

export async function executeExistingAdapterRecipe(recipe: ExistingAdapterRecipe, rawInput: AccessExecutionInput,
  deps: Dependencies & { recipeHash: string; toInstant: (value: unknown, input: AccessExecutionInput) => Date }): Promise<AccessExecutionResult> {
  const input = accessExecutionInputSchema.parse(rawInput), clock = deps.now ?? (() => new Date());
  const result = (slots: AccessExecutionResult["slots"], reason?: string): AccessExecutionResult => accessExecutionResultSchema.parse({
    status: reason ? reason === "ACCESS_REQUIRED" ? "ACCESS_REQUIRED" : reason === "PROVIDER_THROTTLED" ? "FAILED" : "INCOMPLETE" : slots.length ? "AVAILABLE" : "EMPTY",
    complete: !reason, observedAt: clock().toISOString(), sourceUrl: recipe.source.bookingUrl, slots,
    evidence: { recipeHash: deps.recipeHash, venueVerified: !reason, dateVerified: !reason, capacityVerified: !reason,
      durationVerified: !reason, completeVerified: !reason, ...(reason ? { reason } : {}) },
  });
  let session: ReturnType<typeof reader> | undefined;
  try {
    const adapter = existingAdapterMetadataSchema.parse(recipe.adapter);
    if (input.timeZone !== recipe.source.timeZone || recipe.source.providerFamily.toUpperCase() !== adapter.family ||
        (recipe.target.kind === "SIMULATOR") !== (adapter.family === "ACUITY") ||
        adapter.family === "ACUITY" && (!recipe.target.offeringId || !input.durationMinutes)) fail("ADAPTER_TARGET_MISMATCH");
    session = reader(recipe.source, deps, adapter, input);
    const start = deps.toInstant(`${input.date}T${input.startTime}:00`, input);
    const next = new Date(`${input.date}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    const end = deps.toInstant(`${input.endTime === "24:00" ? next.toISOString().slice(0, 10) : input.date}T${input.endTime === "24:00" ? "00:00" : input.endTime}:00`, input);
    const now = clock();
    if (end <= now) fail("INVALID_REQUEST_DATE_OR_ZONE");
    if (adapter.family === "FOREUP") {
      const path = foreupPath.exec(new URL(recipe.source.bookingUrl).pathname);
      if (!path || Number(path[1]) !== adapter.facilityId || path[2] && Number(path[2]) !== adapter.scheduleId) fail("ADAPTER_SOURCE_MISMATCH");
      const config = await readForeupPublicConfiguration({ bookingUrl: recipe.source.bookingUrl, courseName: recipe.source.venueName,
        fetchImpl: session.read, rethrowError: () => true });
      if (!config || config.scheduleId !== adapter.scheduleId || config.bookingClassId !== adapter.bookingClassId) fail("ADAPTER_CONFIGURATION_CHANGED");
      const available = await fetchForeupTeeSheet({ courseId: recipe.target.courseId, date: new Date(`${input.date}T00:00:00Z`), players: input.players,
        metadata: { scheduleId: adapter.scheduleId, bookingClassId: adapter.bookingClassId, bookingBaseUrl: recipe.source.bookingUrl }, fetchImpl: session.read });
      if (!session.availabilityWasArray()) fail("ADAPTER_EMPTY_UNPROVEN");
      const slots = available.slots.map(slot => ({ ...slot, time: deps.toInstant(slot.startsAt, input) })).filter(slot =>
        slot.time > now && slot.time >= start && slot.time < end && slot.availableSpots >= input.players).map(slot => ({
        sourceId: slot.sourceId, startsAt: slot.time.toISOString(), availableSpots: slot.availableSpots, bookingUrl: recipe.source.bookingUrl,
        ...(slot.holes === 9 || slot.holes === 18 ? { holes: slot.holes as 9 | 18 } : {}),
      }));
      return result(slots);
    }
    if (adapter.family === "TEEITUP") {
      const origin = new URL(recipe.source.bookingUrl).origin;
      const bookingBaseUrl = adapter.facilityIds.length === 1 ? `${origin}/?course=${adapter.facilityIds[0]}` : `${origin}/`;
      const available = await fetchTeeItUpTeeSheet({ courseId: recipe.target.courseId, date: new Date(`${input.date}T00:00:00Z`), players: input.players, timeZone: input.timeZone,
        metadata: { aliases: [adapter.alias], bookingBaseUrl, facilityIds: adapter.facilityIds } }, session.read);
      if (!session.availabilityWasArray()) fail("ADAPTER_EMPTY_UNPROVEN");
      return result(available.slots.map(slot => ({ ...slot, time: deps.toInstant(slot.startsAt, input) })).filter(slot =>
        slot.time > now && slot.time >= start && slot.time < end && slot.availableSpots >= input.players).map(slot => ({
        sourceId: slot.sourceId, startsAt: slot.time.toISOString(), availableSpots: slot.availableSpots,
        bookingUrl: teeItUpRecipeBookingUrl(recipe.source.bookingUrl, input.date, Number(/^teeitup-(\d+)-/u.exec(slot.sourceId)?.[1])),
        resourceId: `teeitup-facility:${/^teeitup-(\d+)-/u.exec(slot.sourceId)?.[1]}`,
        ...(slot.holes === 9 || slot.holes === 18 ? { holes: slot.holes as 9 | 18 } : {}),
      })));
    }
    const observed = await readAcuityPublicConfiguration({ bookingUrl: recipe.source.bookingUrl, fetchImpl: session.read });
    if (!observed) fail("ADAPTER_CONFIGURATION_UNVERIFIED");
    const available = await fetchAcuitySimulatorAvailability({ date: input.date, durationMinutes: input.durationMinutes!, partySize: 1,
      timeZone: input.timeZone, offering: { id: recipe.target.offeringId!, courseId: recipe.target.courseId, bookingUrl: recipe.source.bookingUrl,
        providerFamilyKey: "ACUITY", providerMetadata: { ownerKey: adapter.ownerKey, rentalProductIds: adapter.rentalProductIds },
        maxPartySize: observed.configuration.maxPartySize, supportedDurationsMinutes: [] } }, session.read);
    return result(available.slots.filter(slot => slot.startsAt > now && slot.startsAt >= start && slot.endsAt <= end).map(slot => ({
      sourceId: slot.sourceId, startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString(), availableSpots: 1,
      capacity: slot.maxPartySize, bookingUrl: recipe.source.bookingUrl, resourceId: slot.resourceId, productId: slot.productId,
    })));
  } catch (error) {
    const message = session?.failureReason() ?? (error instanceof Error ? error.message : "");
    return result([], /^[A-Z_]{1,80}$/u.test(message) ? message : "ADAPTER_READ_FAILED");
  } finally { session?.dispose(); }
}
