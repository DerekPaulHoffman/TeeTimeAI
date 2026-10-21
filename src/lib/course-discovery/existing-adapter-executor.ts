import { fetchForeupTeeSheet } from "@/lib/adapters/foreup";
import { fetchTeeItUpTeeSheet } from "@/lib/adapters/teeitup";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { createUSchedulePublicSession } from "@/lib/automation/uschedule-public-session";
import { fetchUScheduleRecipeAvailability, inspectUScheduleRecipeConfiguration } from "@/lib/simulators/providers/uschedule";
import { uschedulePublicTenant } from "@/lib/simulators/providers/public-configuration";
import { readForeupPublicConfiguration } from "@/lib/automation/foreup-public-configuration";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { fetchAcuitySimulatorAvailability, parseAcuityPublicConfigurationIdentity, readAcuityPublicConfiguration } from "@/lib/simulators/providers/acuity";
import { isAcuityPublicBookingUrl } from "@/lib/simulators/providers/acuity";
import type { AcuityPublicConfiguration } from "@/lib/simulators/providers/public-configuration";
import { SimulatorAvailabilityError } from "@/lib/simulators/providers/types";
import { existingAdapterMetadataSchema, type ExistingAdapterMetadata, type ExistingAdapterRecipe } from "./existing-adapter-schema";
import { accessExecutionDiagnosticSchema, accessExecutionInputSchema, accessExecutionResultSchema, isSafeRecipeUrl, type AccessExecutionDiagnostic, type AccessExecutionInput, type AccessExecutionResult } from "./recipe";
import { requestFamilyForUrl } from "./request-family";
import { assertTeeItUpRecipeAvailability, parseTeeItUpRecipeSource, resolveTeeItUpRecipeFacilities, teeItUpRecipeBookingUrl, type TeeItUpRecipeFacility } from "./teeitup-recipe-source";
import { parseWhooshSimulatorSource } from "./whoosh-simulator-source";
import { executeWhooshSimulator, inspectWhooshSimulator } from "./whoosh-simulator-executor";
import { deriveTeeItUpOfficialIdentityProof, type OfficialIdentityPage, type TeeItUpOfficialIdentityProof } from "./teeitup-official-identity";
import { parseTeeItUpSimulatorAvailability } from "./teeitup-simulator";
import { parseLightspeedSource } from "./lightspeed-source";
import { executeLightspeed, inspectLightspeed } from "./lightspeed-executor";
import { executeAmelia, inspectAmelia } from "./amelia-executor";
import { parseChronogolfSource } from "./chronogolf-source";
import { executeChronogolf, inspectChronogolf } from "./chronogolf-executor";
import { parseGolfVxSource } from "./golfvx-source";
import { executeGolfVx, inspectGolfVx } from "./golfvx-executor";

type Dependencies = {
  fetch?: typeof fetch;
  now?: () => Date;
  deadlineAt?: Date;
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }>;
  venueMatches: (expected: string, observed: unknown) => boolean;
  officialIdentityPage?: OfficialIdentityPage;
};
type Source = Pick<ExistingAdapterRecipe["source"], "bookingUrl" | "venueName" | "venueAddress" | "timeZone"> & { officialUrl?: string };
const publicId = /^[1-9]\d{0,9}$/u;
const foreupPath = /^\/index\.php\/booking\/([1-9]\d{0,9})(?:\/([1-9]\d{0,9}))?\/?$/u;

class FixedAdapterFailure extends Error {}
function fail(code: string): never { throw new FixedAdapterFailure(code); }
function familyForSource(source: Source) {
  if (!isSafeRecipeUrl(source.bookingUrl)) return fail("INVALID_ADAPTER_SOURCE");
  const url = new URL(source.bookingUrl);
  if (url.hostname === "foreupsoftware.com" && !url.search && foreupPath.test(url.pathname)) return "FOREUP" as const;
  if (isAcuityPublicBookingUrl(source.bookingUrl)) return "ACUITY" as const;
  if (parseTeeItUpRecipeSource(source.bookingUrl)) return "TEEITUP" as const;
  if (uschedulePublicTenant(source.bookingUrl)) return "USCHEDULE" as const;
  return fail("UNSUPPORTED_ADAPTER_SOURCE");
}
function dateParameter(date: string) { const [year, month, day] = date.split("-"); return `${month}-${day}-${year}`; }
function exactKeys(url: URL, required: string[], optional: string[] = []) {
  const keys = [...url.searchParams.keys()];
  return new Set(keys).size === keys.length && required.every(key => keys.includes(key)) && keys.every(key => required.includes(key) || optional.includes(key));
}

function simulatorErrorDiagnostic(error: unknown): AccessExecutionDiagnostic | undefined {
  if (!(error instanceof SimulatorAvailabilityError)) return;
  const diagnostic = accessExecutionDiagnosticSchema.safeParse({ code: "SIMULATOR_PROVIDER_ERROR", simulatorError: {
    code: error.code, retryable: error.retryable === true,
    ...(Number.isInteger(error.httpStatus) && error.httpStatus! >= 100 && error.httpStatus! <= 599 ? { httpStatus: error.httpStatus } : {}),
  } });
  return diagnostic.success ? diagnostic.data : undefined;
}

/** One fixed GET-only transport for existing public readers; model-supplied
 * routes, headers, bodies and provider mutex names never enter this contract. */
function reader(source: Source, deps: Dependencies, adapter?: ExistingAdapterMetadata, input?: AccessExecutionInput) {
  const family = familyForSource(source);
  let fixedReadFailure: string | undefined;
  // Keep controller-owned validation separate from provider prose even when a
  // provider reader catches an injected fetch failure.
  function fail(code: string): never {
    fixedReadFailure = code;
    if (family === "ACUITY") throw new SimulatorAvailabilityError("INVALID_SOURCE", code);
    throw new Error(code);
  }
  function failHttp(code: string, status: number): never {
    fixedReadFailure = code;
    if (family === "ACUITY") throw new SimulatorAvailabilityError("HTTP_ERROR", code, status === 429 || status >= 500, status);
    throw new Error(code);
  }
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
  let teeitupSimulatorSlots: AccessExecutionResult["slots"] | undefined;
  let officialIdentityProof: TeeItUpOfficialIdentityProof | undefined;
  let availabilityWasArray = false;
  let requests = 0;
  const parseUrl = (value: string) => {
    if (!isSafeRecipeUrl(value)) return fail("UNSCOPED_ADAPTER_REQUEST");
    const url = new URL(value);
    if (url.href === booking.href) return url;
    if (adapter?.family === "TEEITUP" && adapter.officialIdentityProof && url.href === adapter.officialIdentityProof.officialPageUrl &&
        source.officialUrl && url.origin === new URL(source.officialUrl).origin) return url;
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
      if (response.status === 429) failHttp("PROVIDER_THROTTLED", response.status);
      if ([401, 403].includes(response.status)) failHttp("ACCESS_REQUIRED", response.status);
      if (!response.ok) failHttp("ADAPTER_TRANSPORT_FAILED", response.status);
      if (response.redirected || response.url && response.url !== url.href) fail("ADAPTER_TRANSPORT_FAILED");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 600_000) fail("ADAPTER_RESPONSE_LIMIT");
      const text = Buffer.from(bytes).toString("utf8");
      if (adapter?.family === "TEEITUP" && adapter.officialIdentityProof && url.href === adapter.officialIdentityProof.officialPageUrl) {
        if (!/^text\/html(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) fail("OFFICIAL_IDENTITY_UNVERIFIED");
        const current = deriveTeeItUpOfficialIdentityProof(source, { url: url.href, html: text });
        if (JSON.stringify(current) !== JSON.stringify(adapter.officialIdentityProof)) fail("OFFICIAL_IDENTITY_CHANGED");
        officialIdentityProof = current;
      }
      if (teeitup && url.pathname === `/alias/${teeitup.alias}/facilities`) {
        if (adapter?.family === "TEEITUP" && adapter.officialIdentityProof && !officialIdentityProof) fail("OFFICIAL_IDENTITY_UNVERIFIED");
        const offeringKind = adapter?.family === "TEEITUP" ? adapter.offeringKind ?? "OUTDOOR" : "AUTO";
        try { teeitupFacilities = resolveTeeItUpRecipeFacilities(source, JSON.parse(text), officialIdentityProof, offeringKind); }
        catch (error) {
          if (adapter || !deps.officialIdentityPage || !(error instanceof Error) || error.message !== "ADAPTER_IDENTITY_MISMATCH") throw error;
          officialIdentityProof = deriveTeeItUpOfficialIdentityProof(source, deps.officialIdentityPage, { requireVisibleEvidence: true });
          teeitupFacilities = resolveTeeItUpRecipeFacilities(source, JSON.parse(text), officialIdentityProof);
        }
        if (adapter && (adapter.family !== "TEEITUP" || adapter.alias !== teeitup.alias ||
            JSON.stringify(adapter.facilityIds) !== JSON.stringify(teeitupFacilities.map(row => row.id)) ||
            (adapter.offeringKind === "SIMULATOR") !== teeitupFacilities.every(row => row.isSimulator === true))) fail("ADAPTER_CONFIGURATION_CHANGED");
      }
      if (teeitup && input && url.pathname === "/v2/tee-times") {
        if (adapter?.family === "TEEITUP" && adapter.offeringKind === "SIMULATOR")
          teeitupSimulatorSlots = parseTeeItUpSimulatorAvailability(JSON.parse(text), teeitupFacilities!, input, source.bookingUrl);
        else assertTeeItUpRecipeAvailability(JSON.parse(text), teeitupFacilities!, input);
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
  return { read, family, teeitup, teeitupFacilities: () => teeitupFacilities, officialIdentityProof: () => officialIdentityProof,
    teeitupSimulatorSlots: () => teeitupSimulatorSlots,
    dispose: () => queue.dispose(), availabilityWasArray: () => availabilityWasArray, failureReason: () => fixedReadFailure };
}

/** For a controller-observed provider URL only. Reads typed public configuration
 * and returns bounded IDs; availability and activation remain separate proofs. */
export async function inspectExistingAdapter(source: Source, deps: Dependencies): Promise<{ adapter: ExistingAdapterMetadata }> {
  if (parseGolfVxSource(source.bookingUrl)) {
    if (!source.officialUrl) fail("ADAPTER_IDENTITY_MISSING");
    return { adapter: await inspectGolfVx({ ...source, officialUrl: source.officialUrl }, deps) };
  }
  if (parseChronogolfSource(source.bookingUrl)) {
    if (!source.officialUrl) fail("ADAPTER_IDENTITY_MISSING");
    return { adapter: await inspectChronogolf({ ...source, officialUrl: source.officialUrl }, deps) };
  }
  if (parseLightspeedSource(source.bookingUrl)) {
    if (!source.officialUrl) fail("ADAPTER_IDENTITY_MISSING");
    return { adapter: await inspectLightspeed({ ...source, officialUrl: source.officialUrl }, deps) };
  }
  if (parseWhooshSimulatorSource(source.bookingUrl)) return { adapter: await inspectWhooshSimulator(source, deps) };
  let family: ReturnType<typeof familyForSource>;
  try { family = familyForSource(source); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== "UNSUPPORTED_ADAPTER_SOURCE") throw error;
    if (!source.officialUrl || !isSafeRecipeUrl(source.officialUrl) ||
        new URL(source.bookingUrl).origin !== new URL(source.officialUrl).origin) throw error;
    // The observed self-hosted page must prove its venue and Amelia bootstrap
    // before the fixed inspector can admit any plugin API request.
    return { adapter: await inspectAmelia({ ...source, officialUrl: source.officialUrl }, deps) };
  }
  if (family === "USCHEDULE") {
    const session = createUSchedulePublicSession(source.bookingUrl, deps);
    try {
      const response = await session.read(source.bookingUrl);
      const config = inspectUScheduleRecipeConfiguration(await response.text(), source.bookingUrl);
      const normalized = source.venueName.normalize("NFKC").toLowerCase().replace(/&/gu, "and").replace(/[^a-z0-9]/gu, "");
      if (!config || normalized.length < 8 || normalized !== config.tenant.replace(/-/gu, "")) fail("ADAPTER_IDENTITY_MISMATCH");
      return { adapter: existingAdapterMetadataSchema.parse({ family: "USCHEDULE", tenant: config.tenant,
        serviceId: config.selected.serviceId, serviceName: config.selected.serviceName }) };
    } finally { session.dispose(); }
  }
  const session = reader(source, deps);
  try {
    if (session.teeitup) {
      await session.read(`https://phx-api-be-east-1b.kenna.io/alias/${session.teeitup.alias}/facilities`, { headers: {
        accept: "application/json", "x-be-alias": session.teeitup.alias, origin: session.teeitup.origin, referer: `${session.teeitup.origin}/`,
      } });
      return { adapter: existingAdapterMetadataSchema.parse({ family: "TEEITUP", alias: session.teeitup.alias,
        facilityIds: session.teeitupFacilities()!.map(row => row.id),
        ...(session.teeitupFacilities()!.every(row => row.isSimulator === true) ? { offeringKind: "SIMULATOR" } : {}),
        ...(session.officialIdentityProof() ? { officialIdentityProof: session.officialIdentityProof() } : {}) }) };
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
  const result = (slots: AccessExecutionResult["slots"], reason?: string, diagnostic?: AccessExecutionDiagnostic): AccessExecutionResult => accessExecutionResultSchema.parse({
    status: reason ? reason === "ACCESS_REQUIRED" ? "ACCESS_REQUIRED" : reason === "PROVIDER_THROTTLED" ? "FAILED" : "INCOMPLETE" : slots.length ? "AVAILABLE" : "EMPTY",
    complete: !reason, observedAt: clock().toISOString(), sourceUrl: recipe.source.bookingUrl, slots,
    evidence: { recipeHash: deps.recipeHash, venueVerified: !reason, dateVerified: !reason, capacityVerified: !reason,
      durationVerified: !reason, completeVerified: !reason, ...(reason ? { reason } : {}), ...(diagnostic ? { diagnostic } : {}) },
  });
  let session: ReturnType<typeof reader> | undefined;
  let uscheduleSession: ReturnType<typeof createUSchedulePublicSession> | undefined;
  try {
    const adapter = existingAdapterMetadataSchema.parse(recipe.adapter);
    const simulator = ["ACUITY", "USCHEDULE", "WHOOSH", "LIGHTSPEED", "AMELIA", "GOLFVX"].includes(adapter.family) || adapter.family === "TEEITUP" && adapter.offeringKind === "SIMULATOR";
    if (input.timeZone !== recipe.source.timeZone || recipe.source.providerFamily.toUpperCase() !== adapter.family ||
        (recipe.target.kind === "SIMULATOR") !== simulator || simulator && (!recipe.target.offeringId || !input.durationMinutes) ||
        adapter.family === "TEEITUP" && adapter.offeringKind === "SIMULATOR" && (adapter.facilityIds.length !== 1 || adapter.officialIdentityProof)) fail("ADAPTER_TARGET_MISMATCH");
    if (!["USCHEDULE", "WHOOSH", "LIGHTSPEED", "AMELIA", "CHRONOGOLF", "GOLFVX"].includes(adapter.family)) session = reader(recipe.source, deps, adapter, input);
    const start = deps.toInstant(`${input.date}T${input.startTime}:00`, input);
    const next = new Date(`${input.date}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    const end = deps.toInstant(`${input.endTime === "24:00" ? next.toISOString().slice(0, 10) : input.date}T${input.endTime === "24:00" ? "00:00" : input.endTime}:00`, input);
    const now = clock();
    if (end <= now) fail("INVALID_REQUEST_DATE_OR_ZONE");
    if (adapter.family === "GOLFVX") {
      const slots = await executeGolfVx(recipe.source, adapter, { courseId: recipe.target.courseId, offeringId: recipe.target.offeringId! }, input, deps);
      return result(slots.filter(slot => new Date(slot.startsAt) > now && new Date(slot.startsAt) >= start && new Date(slot.endsAt!) <= end));
    }
    if (adapter.family === "WHOOSH") {
      const slots = await executeWhooshSimulator(recipe.source, adapter, { courseId: recipe.target.courseId, offeringId: recipe.target.offeringId! }, input, deps);
      return result(slots.filter(slot => new Date(slot.startsAt) > now && new Date(slot.startsAt) >= start && new Date(slot.endsAt!) <= end));
    }
    if (adapter.family === "LIGHTSPEED") {
      const slots = await executeLightspeed(recipe.source, adapter, { courseId: recipe.target.courseId, offeringId: recipe.target.offeringId! }, input, deps);
      return result(slots.filter(slot => new Date(slot.startsAt) > now && new Date(slot.startsAt) >= start && new Date(slot.endsAt!) <= end));
    }
    if (adapter.family === "AMELIA") {
      const slots = await executeAmelia(recipe.source, adapter, { courseId: recipe.target.courseId, offeringId: recipe.target.offeringId! }, input, deps);
      return result(slots.filter(slot => new Date(slot.startsAt) > now && new Date(slot.startsAt) >= start && new Date(slot.endsAt!) <= end));
    }
    if (adapter.family === "CHRONOGOLF") {
      const slots = await executeChronogolf(recipe.source, adapter, { courseId: recipe.target.courseId }, input, deps);
      return result(slots.filter(slot => new Date(slot.startsAt) > now && new Date(slot.startsAt) >= start && new Date(slot.startsAt) < end));
    }
    if (adapter.family === "USCHEDULE") {
      const normalized = recipe.source.venueName.normalize("NFKC").toLowerCase().replace(/&/gu, "and").replace(/[^a-z0-9]/gu, "");
      if (uschedulePublicTenant(recipe.source.bookingUrl) !== adapter.tenant || normalized.length < 8 || normalized !== adapter.tenant.replace(/-/gu, "")) fail("ADAPTER_IDENTITY_MISMATCH");
      uscheduleSession = createUSchedulePublicSession(recipe.source.bookingUrl, deps);
      const available = await fetchUScheduleRecipeAvailability({ date: input.date, durationMinutes: input.durationMinutes!, partySize: 1,
        timeZone: input.timeZone, offering: { id: recipe.target.offeringId!, courseId: recipe.target.courseId, bookingUrl: recipe.source.bookingUrl,
          providerFamilyKey: "USCHEDULE", active: true, publicAccessStatus: "PUBLIC", providerMetadata: { tenant: adapter.tenant, serviceId: adapter.serviceId },
          maxPartySize: null, supportedDurationsMinutes: [input.durationMinutes!] } }, adapter, uscheduleSession.read);
      return result(available.slots.filter(slot => slot.startsAt > now && slot.startsAt >= start && slot.endsAt <= end).map(slot => ({
        sourceId: slot.sourceId, startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString(), availableSpots: 1,
        capacity: null, bookingUrl: recipe.source.bookingUrl, resourceId: slot.resourceId, productId: slot.productId,
      })));
    }
    if (adapter.family === "FOREUP") {
      const path = foreupPath.exec(new URL(recipe.source.bookingUrl).pathname);
      if (!path || Number(path[1]) !== adapter.facilityId || path[2] && Number(path[2]) !== adapter.scheduleId) fail("ADAPTER_SOURCE_MISMATCH");
      const config = await readForeupPublicConfiguration({ bookingUrl: recipe.source.bookingUrl, courseName: recipe.source.venueName,
        fetchImpl: session!.read, rethrowError: () => true });
      if (!config || config.scheduleId !== adapter.scheduleId || config.bookingClassId !== adapter.bookingClassId) fail("ADAPTER_CONFIGURATION_CHANGED");
      const available = await fetchForeupTeeSheet({ courseId: recipe.target.courseId, date: new Date(`${input.date}T00:00:00Z`), players: input.players,
        metadata: { scheduleId: adapter.scheduleId, bookingClassId: adapter.bookingClassId, bookingBaseUrl: recipe.source.bookingUrl }, fetchImpl: session!.read });
      if (!session!.availabilityWasArray()) fail("ADAPTER_EMPTY_UNPROVEN");
      const slots = available.slots.map(slot => ({ ...slot, time: deps.toInstant(slot.startsAt, input) })).filter(slot =>
        slot.time > now && slot.time >= start && slot.time < end && slot.availableSpots >= input.players).map(slot => ({
        sourceId: slot.sourceId, startsAt: slot.time.toISOString(), availableSpots: slot.availableSpots, bookingUrl: recipe.source.bookingUrl,
        ...(slot.holes === 9 || slot.holes === 18 ? { holes: slot.holes as 9 | 18 } : {}),
      }));
      return result(slots);
    }
    if (adapter.family === "TEEITUP") {
      if (adapter.officialIdentityProof) await session!.read(adapter.officialIdentityProof.officialPageUrl);
      if (adapter.offeringKind === "SIMULATOR") {
        const origin = new URL(recipe.source.bookingUrl).origin;
        const headers = { accept: "application/json", "x-be-alias": adapter.alias, origin, referer: `${origin}/` };
        await session!.read(`https://phx-api-be-east-1b.kenna.io/alias/${adapter.alias}/facilities`, { headers });
        const url = new URL("https://phx-api-be-east-1b.kenna.io/v2/tee-times");
        url.searchParams.set("date", input.date); url.searchParams.set("facilityIds", adapter.facilityIds.join(",")); url.searchParams.set("returnPromotedRates", "true");
        await session!.read(url, { headers });
        const slots = session!.teeitupSimulatorSlots();
        if (!slots || !session!.availabilityWasArray()) fail("ADAPTER_EMPTY_UNPROVEN");
        return result(slots.filter(slot => new Date(slot.startsAt) > now && new Date(slot.startsAt) >= start && new Date(slot.endsAt!) <= end));
      }
      const origin = new URL(recipe.source.bookingUrl).origin;
      const bookingBaseUrl = adapter.facilityIds.length === 1 ? `${origin}/?course=${adapter.facilityIds[0]}` : `${origin}/`;
      const available = await fetchTeeItUpTeeSheet({ courseId: recipe.target.courseId, date: new Date(`${input.date}T00:00:00Z`), players: input.players, timeZone: input.timeZone,
        metadata: { aliases: [adapter.alias], bookingBaseUrl, facilityIds: adapter.facilityIds } }, session!.read);
      if (!session!.availabilityWasArray()) fail("ADAPTER_EMPTY_UNPROVEN");
      return result(available.slots.map(slot => ({ ...slot, time: deps.toInstant(slot.startsAt, input) })).filter(slot =>
        slot.time > now && slot.time >= start && slot.time < end && slot.availableSpots >= input.players).map(slot => ({
        sourceId: slot.sourceId, startsAt: slot.time.toISOString(), availableSpots: slot.availableSpots,
        bookingUrl: teeItUpRecipeBookingUrl(recipe.source.bookingUrl, input.date, Number(/^teeitup-(\d+)-/u.exec(slot.sourceId)?.[1])),
        resourceId: `teeitup-facility:${/^teeitup-(\d+)-/u.exec(slot.sourceId)?.[1]}`,
        ...(slot.holes === 9 || slot.holes === 18 ? { holes: slot.holes as 9 | 18 } : {}),
      })));
    }
    const observed = await readAcuityPublicConfiguration({ bookingUrl: recipe.source.bookingUrl, fetchImpl: session!.read });
    if (!observed) fail("ADAPTER_CONFIGURATION_UNVERIFIED");
    const available = await fetchAcuitySimulatorAvailability({ date: input.date, durationMinutes: input.durationMinutes!, partySize: 1,
      timeZone: input.timeZone, offering: { id: recipe.target.offeringId!, courseId: recipe.target.courseId, bookingUrl: recipe.source.bookingUrl,
        providerFamilyKey: "ACUITY", providerMetadata: { ownerKey: adapter.ownerKey, rentalProductIds: adapter.rentalProductIds },
        maxPartySize: observed.configuration.maxPartySize, supportedDurationsMinutes: [] } }, session!.read);
    return result(available.slots.filter(slot => slot.startsAt > now && slot.startsAt >= start && slot.endsAt <= end).map(slot => ({
      sourceId: slot.sourceId, startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString(), availableSpots: 1,
      capacity: slot.maxPartySize, bookingUrl: recipe.source.bookingUrl, resourceId: slot.resourceId, productId: slot.productId,
    })));
  } catch (error) {
    const diagnostic = simulatorErrorDiagnostic(error);
    const message = session?.failureReason() ?? uscheduleSession?.failureReason() ?? diagnostic?.simulatorError?.code ??
      (error instanceof FixedAdapterFailure || recipe.adapter.family !== "ACUITY" && error instanceof Error ? error.message : "");
    return result([], /^[A-Z_]{1,80}$/u.test(message) ? message : "ADAPTER_READ_FAILED", diagnostic);
  } finally { session?.dispose(); uscheduleSession?.dispose(); }
}
