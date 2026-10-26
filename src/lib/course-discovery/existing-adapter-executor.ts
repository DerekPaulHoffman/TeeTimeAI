import { fetchForeupTeeSheet } from "@/lib/adapters/foreup";
import { uscheduleReadGate } from "@/lib/simulators/providers/uschedule-read-diagnostic";
import { fetchTeeItUpTeeSheet } from "@/lib/adapters/teeitup";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { createUSchedulePublicSession } from "@/lib/automation/uschedule-public-session";
import { fetchUScheduleRecipeAvailability, inspectUScheduleRecipeConfiguration } from "@/lib/simulators/providers/uschedule";
import { uschedulePublicTenant } from "@/lib/simulators/providers/public-configuration";
import { hasCompleteForeupPublicScheduleScope, parseForeupPublicConfiguration, readForeupPublicConfiguration } from "@/lib/automation/foreup-public-configuration";
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
import { parseEzLinksSource } from "./ezlinks-source";
import { isEzLinksProviderUrl } from "./ezlinks-public-read-policy";
import { executeEzLinks, inspectEzLinks } from "./ezlinks-executor";
import { parseRexSource } from "./rex-source";
import { executeRex, inspectRex } from "./rex-executor";
import { parseCpsSource } from "./cps-source";
import { executeCps, inspectCps } from "./cps-executor";
import { deriveUScheduleOfficialLocation, parseUScheduleLocationSource } from "@/lib/simulators/providers/uschedule-location-source";
import { executeUSchedulePublicLocation, inspectUSchedulePublicLocation } from "./uschedule-location-executor";
import { deriveUSchedulePublicRentalParty, isUSchedulePublicRentalPartyAbsent } from "./uschedule-public-rental-party";
import { isFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
import { observedTeeItUpOfficialBookingChain, type TeeItUpOfficialBookingToken } from "./teeitup-official-booking-context";
import { bindTeeItUpOfficialBookingFacility, type TeeItUpOfficialBookingSourceProof, type TeeItUpObservedSourceChain } from "./teeitup-official-booking-source";
import { readTeeItUpOfficialBookingChain } from "./teeitup-official-booking-reader";
import type { OfficialSourceDiagnostic, UScheduleConfigurationGate } from "./official-source-diagnostics";
import { bindTeeItUpPostalConflictProof, type TeeItUpPostalConflictProof } from "./teeitup-postal-conflict-proof";
import type { NativeOfficialPageReader } from "./native-official-page-reader";
import { readTeeItUpDelegatedBookingChain, type DelegatedReaderDependencies } from "./teeitup-delegated-booking-reader";
import { currentNativeDelegatedChain, type NativeDelegatedChainToken } from "./teeitup-delegated-booking-context";
import { bindDelegatedFacility, type TeeItUpDelegatedBookingProof } from "./teeitup-delegated-booking-source";
import { fixedAdapterTransportCode, rememberFixedAdapterReadFailure, getFixedAdapterReadDiagnostic, type FixedAdapterReadDiagnostic } from "./fixed-adapter-read-diagnostic";
import { bindForeupOfficialRouteConfiguration, deriveForeupOfficialRouteContact, foreupOwnershipDigest, type ForeupOfficialRouteOwnershipProof } from "./foreup-official-route-ownership";
import { parseTeeItUpBookingConfiguration, type TeeItUpBookingConfiguration } from "./teeitup-booking-configuration";
import { bindTeeItUpStreetTypeOmittedProof, isTeeItUpStreetTypeOmissionCandidate, type TeeItUpStreetTypeOmittedProof } from "./teeitup-street-type-omitted-proof";
import { parseMindbodyAppointmentSource } from "./mindbody-appointment-grid";
import { executeMindbodyAppointments, inspectMindbodyAppointments, getMindbodyAppointmentDiagnostic,
  type MindbodyAppointmentDiagnostic, type MindbodyAppointmentReaderDeps } from "./mindbody-appointment-reader";

type Dependencies = {
  fetch?: typeof fetch;
  now?: () => Date;
  deadlineAt?: Date;
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }>;
  venueMatches: (expected: string, observed: unknown) => boolean;
  officialIdentityPage?: OfficialIdentityPage;
  /** Canonical controller request, unavailable to model action arguments. */
  requestedInput?: AccessExecutionInput;
  trustedContext?: { canonicalCoursePhone?: string };
  localCapabilities?: readonly "LOCAL_CHROME"[];
  readNativeOfficialPage?: NativeOfficialPageReader;
  /** Controller test seam, never recipe metadata or model input. */
  createMindbodySession?: MindbodyAppointmentReaderDeps["createSession"];
  officialBookingSourceToken?: TeeItUpOfficialBookingToken;
  /** Opaque controller-only source witness; never accepted from recipe JSON. */
  nativeDelegatedChainToken?: NativeDelegatedChainToken;
  readDelegatedDocument?: DelegatedReaderDependencies["readDelegatedDocument"];
  readDelegatedRoot?: DelegatedReaderDependencies["readDelegatedRoot"];
  onOfficialSourceDiagnostic?: (value: OfficialSourceDiagnostic) => void;
};
type Source = Pick<ExistingAdapterRecipe["source"], "bookingUrl" | "venueName" | "venueAddress" | "timeZone"> & { officialUrl?: string };
const publicId = /^[1-9]\d{0,9}$/u;
const foreupPath = /^\/index\.php\/booking\/(?:([1-9]\d{0,9})(?:\/([1-9]\d{0,9}))?|index\/([1-9]\d{0,9}))\/?$/u;

class FixedAdapterFailure extends Error {}
function fail(code: string): never { throw new FixedAdapterFailure(code); }
function familyForSource(source: Source) {
  if (!isSafeRecipeUrl(source.bookingUrl)) return fail("INVALID_ADAPTER_SOURCE");
  const url = new URL(source.bookingUrl);
  if (url.hostname === "foreupsoftware.com" && !url.search && foreupPath.test(url.pathname)) return "FOREUP" as const;
  if (isAcuityPublicBookingUrl(source.bookingUrl)) return "ACUITY" as const;
  if (parseTeeItUpRecipeSource(source.bookingUrl)) return "TEEITUP" as const;
  if (uschedulePublicTenant(source.bookingUrl) || parseUScheduleLocationSource(source.bookingUrl)?.locationId) return "USCHEDULE" as const;
  return fail("UNSUPPORTED_ADAPTER_SOURCE");
}
function dateParameter(date: string) { const [year, month, day] = date.split("-"); return `${month}-${day}-${year}`; }
function exactKeys(url: URL, required: string[], optional: string[] = []) {
  const keys = [...url.searchParams.keys()];
  return new Set(keys).size === keys.length && required.every(key => keys.includes(key)) && keys.every(key => required.includes(key) || optional.includes(key));
}

function simulatorErrorDiagnostic(error: unknown, uschedule = false): AccessExecutionDiagnostic | undefined {
  if (!(error instanceof SimulatorAvailabilityError)) return;
  const diagnostic = accessExecutionDiagnosticSchema.safeParse({ code: "SIMULATOR_PROVIDER_ERROR", simulatorError: {
    code: error.code, retryable: error.retryable === true,
    ...(uschedule && uscheduleReadGate(error) ? { uscheduleGate: uscheduleReadGate(error) } : {}),
    ...(Number.isInteger(error.httpStatus) && error.httpStatus! >= 100 && error.httpStatus! <= 599 ? { httpStatus: error.httpStatus } : {}),
  } });
  return diagnostic.success ? diagnostic.data : undefined;
}

function mindbodyReplayDiagnostic(error: unknown): AccessExecutionDiagnostic | undefined {
  const captured = getMindbodyAppointmentDiagnostic(error);
  if (!captured) return;
  const fields: (keyof MindbodyAppointmentDiagnostic)[] = ["stage", "elapsedMs", "pendingReads", "rawBytes", "renderedBytes", "nativeDocumentCurrent",
    "rawBodyClosed", "rawHtmlClosed", "renderedBodyClosed", "renderedHtmlClosed", "timeOriginFinite", "timeOriginChangedFromPrior", "timeOriginMatchesAccepted", "readyState"];
  const diagnostic = accessExecutionDiagnosticSchema.safeParse({ code: "MINDBODY_NATIVE_CAPTURE_FAILURE",
    mindbodyReplay: Object.fromEntries(fields.filter(key => Object.hasOwn(captured, key)).map(key => [key, captured[key]])) });
  return diagnostic.success ? diagnostic.data : undefined;
}

/** One fixed GET-only transport for existing public readers; model-supplied
 * routes, headers, bodies and provider mutex names never enter this contract. */
function reader(source: Source, deps: Dependencies, adapter?: ExistingAdapterMetadata, input?: AccessExecutionInput,
  readBudget = { requests: 0, dataBytes: 0, bookingConfigurationRequested: false }) {
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
  const savedPostalProof = adapter?.family === "TEEITUP" ? adapter.officialPostalConflictProof : undefined;
  const savedDelegatedProof = adapter?.family === "TEEITUP" ? adapter.officialDelegatedBookingProof : undefined;
  const savedOmittedProof = adapter?.family === "TEEITUP" ? adapter.officialStreetTypeOmittedProof : undefined;
  if (savedOmittedProof && !deps.localCapabilities?.includes("LOCAL_CHROME")) fail("LOCAL_CHROME_REQUIRED");
  if (savedDelegatedProof && !deps.localCapabilities?.includes("LOCAL_CHROME")) fail("LOCAL_CHROME_REQUIRED");
  if (savedPostalProof?.warmTransport === "NATIVE_CHROME" &&
      (!deps.localCapabilities?.includes("LOCAL_CHROME") || !deps.readNativeOfficialPage)) fail("LOCAL_CHROME_REQUIRED");
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
  let officialBookingSourceProof: TeeItUpOfficialBookingSourceProof | undefined;
  let officialPostalConflictProof: TeeItUpPostalConflictProof | undefined;
  let officialDelegatedBookingProof: TeeItUpDelegatedBookingProof | undefined;
  let publicBookingConfiguration: TeeItUpBookingConfiguration | undefined;
  let officialStreetTypeOmittedProof: TeeItUpStreetTypeOmittedProof | undefined;
  let omissionOfficialPage: OfficialIdentityPage | undefined;
  const apiAlias = () => publicBookingConfiguration?.apiAlias ?? teeitup?.alias;
  let delegatedToken = deps.nativeDelegatedChainToken;
  let preparingDelegation: Promise<void> | undefined;
  const prepareDelegation = async () => {
    if (savedDelegatedProof) {
      preparingDelegation ??= readTeeItUpDelegatedBookingChain(source, { ...deps, deadlineAt: new Date(deadline) }).then(value => { delegatedToken = value; });
      await preparingDelegation;
    }
    if (delegatedToken) currentNativeDelegatedChain(delegatedToken);
  };
  let postalOfficialPage: OfficialIdentityPage | undefined;
  let freshBookingChain: TeeItUpObservedSourceChain | undefined;
  let preparingBookingChain: Promise<void> | undefined;
  const initialBookingToken = !adapter && family === "TEEITUP" ? deps.officialBookingSourceToken : undefined;
  const savedBookingProof = adapter?.family === "TEEITUP" ? adapter.officialBookingSourceProof : undefined;
  function validateInitialBookingToken() {
    if (initialBookingToken) observedTeeItUpOfficialBookingChain(initialBookingToken);
  }
  async function prepareBookingChain() {
    if (!savedBookingProof && !initialBookingToken) return;
    preparingBookingChain ??= (async () => {
      const expected = savedBookingProof ?? observedTeeItUpOfficialBookingChain(initialBookingToken!);
      freshBookingChain = await readTeeItUpOfficialBookingChain(source, expected, { fetch: deps.fetch, signal, requestLease: deps.requestLease });
      validateInitialBookingToken();
    })();
    await preparingBookingChain;
    validateInitialBookingToken();
  }
  let availabilityWasArray = false;
  const parseUrl = (value: string) => {
    if (!isSafeRecipeUrl(value)) return fail("UNSCOPED_ADAPTER_REQUEST");
    const url = new URL(value);
    if (url.href === booking.href) return url;
    if (adapter?.family === "TEEITUP" && adapter.officialIdentityProof && url.href === adapter.officialIdentityProof.officialPageUrl &&
        source.officialUrl && url.origin === new URL(source.officialUrl).origin) return url;
    if (savedPostalProof && url.href === savedPostalProof.officialSourceProof.officialPageUrl &&
        source.officialUrl && savedPostalProof.officialUrl === source.officialUrl && url.origin === new URL(source.officialUrl).origin) return url;
    if (teeitup && url.origin === "https://phx-api-be-east-1b.kenna.io") {
      if (url.pathname === `/alias/${apiAlias()}/facilities` && !url.search) return url;
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
        url.searchParams.get("timezone") === input.timeZone && (!url.searchParams.has("maxDays") || url.searchParams.get("maxDays") === "1") &&
        (url.searchParams.get("calendarId") === "any" || acuity.resources.some(row => row.id === url.searchParams.get("calendarId"))) &&
        acuity.rentals.some(row => row.id === url.searchParams.get("appointmentTypeId") && row.durationMinutes === input.durationMinutes) &&
        (!adapter || adapter.family === "ACUITY" && adapter.rentalProductIds.includes(url.searchParams.get("appointmentTypeId") ?? ""))) return url;
    return fail("UNSCOPED_ADAPTER_REQUEST");
  };
  const transport = deps.fetch ?? createAddressPinnedPublicFetchTransport({ parseUrl, maxResponseBytes: 600_000, timeoutMs: 15_000, redirectLimit: 0 });
  const read: typeof fetch = async (value, init) => {
    if (++readBudget.requests > (savedBookingProof || initialBookingToken ? readBudget.bookingConfigurationRequested ? 6 : 2 : 6)) fail("ADAPTER_REQUEST_LIMIT");
    const raw = value instanceof Request ? value.url : String(value);
    const method = (init?.method ?? (value instanceof Request ? value.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (value instanceof Request ? value.headers : undefined));
    if (method !== "GET" || init?.body || value instanceof Request && value.body ||
        ["authorization", "proxy-authorization", "cookie", "x-api-key"].some(key => headers.has(key))) fail("UNSAFE_ADAPTER_REQUEST");
    const url = parseUrl(raw);
    if (teeitup && url.hostname === "phx-api-be-east-1b.kenna.io" &&
        (headers.get("x-be-alias") !== apiAlias() || headers.get("origin") !== teeitup.origin || headers.get("referer") !== `${teeitup.origin}/`))
      fail("UNSAFE_ADAPTER_REQUEST");
    // This independent source refresh runs before acquiring a data lease.
    // No nested queue/lease can deadlock on the same provider family.
    if (teeitup) await prepareBookingChain();
    if (teeitup) await prepareDelegation();
    return queue.run(requestFamilyForUrl(url.href), async () => {
      const readStartedAt = Date.now();
      const directoryRead = Boolean(teeitup && url.origin === "https://phx-api-be-east-1b.kenna.io" && url.pathname === `/alias/${apiAlias()}/facilities`);
      let readDiagnostic: FixedAdapterReadDiagnostic = { stage: "TRANSPORT", role: "TEEITUP_DIRECTORY", httpStatus: null,
        responseRedirected: null, responseUrlMatches: null, elapsedMs: 0, responseBytes: null, transportCode: "NONE" };
      try {
      signal.throwIfAborted();
      validateInitialBookingToken();
      const response = await transport(url, { ...init, method: "GET", headers, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
        credentials: "omit", redirect: "manual", cache: "no-store" });
      readDiagnostic = { ...readDiagnostic, stage: "RESPONSE_HEADERS", httpStatus: response.status,
        responseRedirected: response.redirected, responseUrlMatches: response.url ? response.url === url.href : null };
      if (response.status === 429) failHttp("PROVIDER_THROTTLED", response.status);
      if ([401, 403].includes(response.status)) failHttp("ACCESS_REQUIRED", response.status);
      if (!response.ok) failHttp("ADAPTER_TRANSPORT_FAILED", response.status);
      if (response.redirected || response.url && response.url !== url.href) fail("ADAPTER_TRANSPORT_FAILED");
      const bytes = await response.arrayBuffer();
      readDiagnostic = { ...readDiagnostic, stage: "RESPONSE_BODY", responseBytes: bytes.byteLength <= 600_000 ? bytes.byteLength : null };
      if (bytes.byteLength > 600_000) fail("ADAPTER_RESPONSE_LIMIT");
      readBudget.dataBytes += bytes.byteLength;
      if ((savedBookingProof || initialBookingToken) && readBudget.dataBytes > 1_200_000) fail("ADAPTER_RESPONSE_LIMIT");
      const text = Buffer.from(bytes).toString("utf8");
      if (adapter?.family === "TEEITUP" && adapter.officialIdentityProof && url.href === adapter.officialIdentityProof.officialPageUrl) {
        if (!/^text\/html(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) fail("OFFICIAL_IDENTITY_UNVERIFIED");
        const current = deriveTeeItUpOfficialIdentityProof(source, { url: url.href, html: text });
        if (JSON.stringify(current) !== JSON.stringify(adapter.officialIdentityProof)) fail("OFFICIAL_IDENTITY_CHANGED");
        officialIdentityProof = current;
      }
      if (savedPostalProof && url.href === savedPostalProof.officialSourceProof.officialPageUrl) {
        if (!/^text\/html(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) fail("OFFICIAL_POSTAL_CONFLICT_UNVERIFIED");
        postalOfficialPage = { url: url.href, html: text };
      }
      if (teeitup && url.pathname === `/alias/${apiAlias()}/facilities`) {
        if (omissionOfficialPage) {
          if (!publicBookingConfiguration) fail("ADAPTER_CONFIGURATION_UNVERIFIED");
          officialStreetTypeOmittedProof = bindTeeItUpStreetTypeOmittedProof(source, omissionOfficialPage, JSON.parse(text),
            publicBookingConfiguration!, deps.trustedContext?.canonicalCoursePhone);
          if (savedOmittedProof && JSON.stringify(officialStreetTypeOmittedProof) !== JSON.stringify(savedOmittedProof)) fail("OFFICIAL_STREET_TYPE_OMITTED_CHANGED");
          officialIdentityProof = undefined; officialBookingSourceProof = undefined; officialPostalConflictProof = undefined; officialDelegatedBookingProof = undefined;
          teeitupFacilities = resolveTeeItUpRecipeFacilities(source, JSON.parse(text), undefined, "OUTDOOR", undefined, undefined, undefined,
            officialStreetTypeOmittedProof, publicBookingConfiguration);
        } else {
        if (delegatedToken) {
          officialDelegatedBookingProof = bindDelegatedFacility(source, currentNativeDelegatedChain(delegatedToken), JSON.parse(text));
          if (savedDelegatedProof && JSON.stringify(officialDelegatedBookingProof) !== JSON.stringify(savedDelegatedProof)) fail("OFFICIAL_DELEGATED_SOURCE_CHANGED");
        }
        if (adapter?.family === "TEEITUP" && adapter.officialIdentityProof && !officialIdentityProof) fail("OFFICIAL_IDENTITY_UNVERIFIED");
        const offeringKind = adapter?.family === "TEEITUP" ? adapter.offeringKind ?? "OUTDOOR" : "AUTO";
        if (savedBookingProof) {
          if (!freshBookingChain) fail("OFFICIAL_BOOKING_SOURCE_UNVERIFIED");
          officialBookingSourceProof = bindTeeItUpOfficialBookingFacility(source, freshBookingChain, JSON.parse(text));
          if (JSON.stringify(officialBookingSourceProof) !== JSON.stringify(savedBookingProof)) fail("OFFICIAL_BOOKING_SOURCE_CHANGED");
        }
        if (savedPostalProof) {
          if (!postalOfficialPage) fail("OFFICIAL_POSTAL_CONFLICT_UNVERIFIED");
          officialPostalConflictProof = bindTeeItUpPostalConflictProof(source, postalOfficialPage, JSON.parse(text));
          if (JSON.stringify(officialPostalConflictProof) !== JSON.stringify(savedPostalProof)) fail("OFFICIAL_POSTAL_CONFLICT_CHANGED");
        }
        try { teeitupFacilities = resolveTeeItUpRecipeFacilities(source, JSON.parse(text), officialIdentityProof, offeringKind, officialBookingSourceProof, officialPostalConflictProof, officialDelegatedBookingProof); }
        catch (error) {
          if (adapter || !(error instanceof Error) || error.message !== "ADAPTER_IDENTITY_MISMATCH") throw error;
          if (freshBookingChain) {
            officialBookingSourceProof = bindTeeItUpOfficialBookingFacility(source, freshBookingChain, JSON.parse(text));
            teeitupFacilities = resolveTeeItUpRecipeFacilities(source, JSON.parse(text), undefined, "OUTDOOR", officialBookingSourceProof);
          } else {
            if (!deps.officialIdentityPage) throw error;
            try {
              officialIdentityProof = deriveTeeItUpOfficialIdentityProof(source, deps.officialIdentityPage, { requireVisibleEvidence: true });
              teeitupFacilities = resolveTeeItUpRecipeFacilities(source, JSON.parse(text), officialIdentityProof);
            } catch {
              officialPostalConflictProof = bindTeeItUpPostalConflictProof(source, deps.officialIdentityPage, JSON.parse(text), { requireVisibleEvidence: true });
              officialIdentityProof = undefined;
              teeitupFacilities = resolveTeeItUpRecipeFacilities(source, JSON.parse(text), undefined, "OUTDOOR", undefined, officialPostalConflictProof);
            }
          }
        }
        }
        validateInitialBookingToken();
        if (adapter && (adapter.family !== "TEEITUP" || adapter.alias !== teeitup.alias ||
            JSON.stringify(adapter.facilityIds) !== JSON.stringify(teeitupFacilities.map(row => row.id)) ||
            (adapter.offeringKind === "SIMULATOR") !== teeitupFacilities.every(row => row.isSimulator === true))) fail("ADAPTER_CONFIGURATION_CHANGED");
        if (publicBookingConfiguration && teeitupFacilities.some(row => !publicBookingConfiguration!.facilityIds.includes(row.id))) fail("ADAPTER_CONFIGURATION_CHANGED");
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
      } catch (error) {
        if (directoryRead) rememberFixedAdapterReadFailure(error, { ...readDiagnostic,
          elapsedMs: Math.max(0, Math.min(120_000, Date.now() - readStartedAt)),
          transportCode: readDiagnostic.stage === "TRANSPORT" ? fixedAdapterTransportCode(error) : "NONE" });
        throw error;
      }
    });
  };
  return { read, family, teeitup, apiAlias, directoryUrl: () => `https://phx-api-be-east-1b.kenna.io/alias/${apiAlias()}/facilities`,
    publicBookingConfiguration: () => publicBookingConfiguration ? structuredClone(publicBookingConfiguration) : undefined,
    async refreshStreetTypeOmittedSource() {
      if (!deps.localCapabilities?.includes("LOCAL_CHROME") || !source.officialUrl || !isTeeItUpStreetTypeOmissionCandidate(source.venueAddress ?? ""))
        fail("LOCAL_CHROME_REQUIRED");
      // No provider data lease is held here. The fixed reader retains its
      // original native/current/raw/visible and capture-age checks.
      const loaded = await import("./native-official-page-reader");
      const native = typeof loaded.readNativeOfficialIdentityPage === "function" ? loaded :
        (loaded as unknown as { default: typeof loaded }).default;
      const requestLease: typeof runWithProviderRequestLease | undefined = deps.requestLease ? async (family, work) => {
        const reply = await deps.requestLease!(family, work);
        return reply.acquired ? { acquired: true, value: await reply.value } : { acquired: false };
      } : undefined;
      const factory: NativeOfficialPageReader = deps.readNativeOfficialPage ?? ((s, url, end) =>
        native.readNativeOfficialIdentityPage(s, url, end, { requestLease }));
      omissionOfficialPage = await factory(source, source.officialUrl!, new Date(deadline));
      if (!isFreshNativeOfficialIdentityPage(omissionOfficialPage, source.officialUrl!)) fail("OFFICIAL_STREET_TYPE_OMITTED_UNVERIFIED");
    },
    async preparePublicBookingConfiguration() {
      if (!teeitup) fail("ADAPTER_SOURCE_MISMATCH");
      readBudget.bookingConfigurationRequested = true;
      const response = await read(source.bookingUrl, { headers: { accept: "text/html,application/xhtml+xml;q=0.9" } });
      if (!/^text\/html(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) fail("ADAPTER_CONFIGURATION_UNVERIFIED");
      const fresh = parseTeeItUpBookingConfiguration(await response.text(), source.venueName, teeitup.selectedIds);
      const saved = adapter?.family === "TEEITUP" ? adapter.publicBookingConfiguration : undefined;
      if (saved && JSON.stringify(saved) !== JSON.stringify(fresh) || teeitup.selectedIds?.some(id => !fresh.facilityIds.includes(id))) fail("ADAPTER_CONFIGURATION_CHANGED");
      publicBookingConfiguration = fresh;
    },
    teeitupFacilities: () => teeitupFacilities, officialIdentityProof: () => officialIdentityProof,
    async refreshPostalSource() {
      if (!savedPostalProof) return;
      const url = savedPostalProof.officialSourceProof.officialPageUrl;
      if (savedPostalProof.warmTransport === "NATIVE_CHROME") {
        postalOfficialPage = await deps.readNativeOfficialPage!(source, url, new Date(deadline));
        if (postalOfficialPage.url !== url || postalOfficialPage.browserTransport !== "NATIVE_CHROME" || !postalOfficialPage.visibleEvidence)
          fail("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");
      } else await read(url);
    },
    officialBookingSourceProof: () => { validateInitialBookingToken(); return officialBookingSourceProof; },
    officialDelegatedBookingProof: () => officialDelegatedBookingProof,
    officialPostalConflictProof: () => officialPostalConflictProof,
    officialStreetTypeOmittedProof: () => officialStreetTypeOmittedProof,
    teeitupSimulatorSlots: () => teeitupSimulatorSlots,
    dispose: () => queue.dispose(), availabilityWasArray: () => availabilityWasArray, failureReason: () => fixedReadFailure };
}

async function inspectForeupConfiguration(source: Source, deps: Dependencies, fetchImpl: typeof fetch, expected?: ForeupOfficialRouteOwnershipProof, warm = false) {
  const coverageFailure = warm ? "FOREUP_PUBLIC_SCHEDULE_COVERAGE_UNVERIFIED" : "ADAPTER_CONFIGURATION_UNVERIFIED";
  if (expected && !deps.localCapabilities?.includes("LOCAL_CHROME")) fail("LOCAL_CHROME_REQUIRED");
  if (expected && (!source.officialUrl || !source.venueAddress || expected.officialUrl !== source.officialUrl || expected.bookingUrl !== source.bookingUrl ||
      expected.venueName !== source.venueName || expected.canonicalAddress !== source.venueAddress || expected.timeZone !== source.timeZone ||
      expected.publicCoursePhone !== deps.trustedContext?.canonicalCoursePhone)) fail("FOREUP_OFFICIAL_ROUTE_UNVERIFIED");
  let proof: ForeupOfficialRouteOwnershipProof | undefined;
  const config = await readForeupPublicConfiguration({ bookingUrl: source.bookingUrl, courseName: source.venueName,
    fetchImpl, rethrowError: () => true, parseDocument: async html => {
      if (!expected) {
        const legacy = parseForeupPublicConfiguration({ bookingUrl: source.bookingUrl, courseName: source.venueName, html });
        if (legacy) {
          const path = foreupPath.exec(new URL(source.bookingUrl).pathname)!;
          if (!hasCompleteForeupPublicScheduleScope({ html, facilityId: Number(path[1] ?? path[3]), scheduleId: legacy.scheduleId })) fail(coverageFailure);
          return legacy;
        }
      }
      if (!deps.localCapabilities?.includes("LOCAL_CHROME") || !source.officialUrl || !source.venueAddress || !deps.trustedContext?.canonicalCoursePhone)
        return null;
      const end = new Date(Math.min(deps.deadlineAt?.getTime() ?? Infinity, Date.now() + 90_000));
      const loaded = await import("./native-official-page-reader");
      const native = typeof loaded.readNativeOfficialIdentityPage === "function" ? loaded : (loaded as unknown as { default: typeof loaded }).default;
      const requestLease: typeof runWithProviderRequestLease | undefined = deps.requestLease ? async (family, work) => {
        const reply = await deps.requestLease!(family, work); return reply.acquired ? { acquired: true, value: await reply.value } : { acquired: false };
      } : undefined;
      const read: NativeOfficialPageReader = deps.readNativeOfficialPage ?? ((s, url, deadline) => native.readNativeOfficialIdentityPage(s, url, deadline, { requestLease, collectPublicCourseContacts: true }));
      const page = await read(source, source.officialUrl!, end);
      const contact = deriveForeupOfficialRouteContact(source, page, deps.trustedContext?.canonicalCoursePhone);
      let derived: ReturnType<typeof bindForeupOfficialRouteConfiguration>;
      try { derived = bindForeupOfficialRouteConfiguration(contact, html); }
      catch (error) {
        if (error instanceof Error && error.message === "FOREUP_PUBLIC_SCHEDULE_COVERAGE_UNVERIFIED") fail(coverageFailure);
        throw error;
      }
      if (expected && foreupOwnershipDigest(derived.proof) !== foreupOwnershipDigest(expected)) fail("ADAPTER_CONFIGURATION_CHANGED");
      proof = derived.proof; return derived.config;
    } });
  return { config, proof };
}

/** For a controller-observed provider URL only. Reads typed public configuration
 * and returns bounded IDs; availability and activation remain separate proofs. */
export async function inspectExistingAdapter(source: Source, deps: Dependencies): Promise<{ adapter: ExistingAdapterMetadata }> {
  if (parseMindbodyAppointmentSource(source.bookingUrl)) {
    if (!source.officialUrl || !source.venueAddress) fail("ADAPTER_IDENTITY_MISSING");
    if (!deps.localCapabilities?.includes("LOCAL_CHROME")) fail("LOCAL_CHROME_REQUIRED");
    if (!deps.requestedInput) fail("MINDBODY_REQUEST_CONTEXT_REQUIRED");
    const input = accessExecutionInputSchema.parse(deps.requestedInput);
    if (input.timeZone !== source.timeZone || !input.durationMinutes) fail("ADAPTER_TARGET_MISMATCH");
    const adapter = await inspectMindbodyAppointments({ ...source, officialUrl: source.officialUrl, venueAddress: source.venueAddress }, input,
      { ...deps, ...(deps.createMindbodySession ? { createSession: deps.createMindbodySession } : {}) });
    if (adapter.durationMinutes !== input.durationMinutes || adapter.capacity < input.players || adapter.timeZone !== input.timeZone)
      fail("ADAPTER_TARGET_MISMATCH");
    return { adapter: existingAdapterMetadataSchema.parse(adapter) };
  }
  // A different Mindbody URL cannot fall through to a self-hosted plugin.
  try { if (/(?:^|\.)mindbodyonline\.com$/u.test(new URL(source.bookingUrl).hostname)) fail("UNSUPPORTED_ADAPTER_SOURCE"); }
  catch (error) { if (error instanceof FixedAdapterFailure) throw error; }
  if (parseRexSource(source.bookingUrl)) {
    if (!source.officialUrl || !source.venueAddress) fail("ADAPTER_IDENTITY_MISSING");
    return { adapter: await inspectRex({ ...source, officialUrl: source.officialUrl, venueAddress: source.venueAddress }, deps) };
  }
  if (parseCpsSource(source.bookingUrl)) {
    if (!source.officialUrl || !source.venueAddress) fail("ADAPTER_IDENTITY_MISSING");
    return { adapter: await inspectCps({ ...source, officialUrl: source.officialUrl, venueAddress: source.venueAddress }, deps) };
  }
  if (isEzLinksProviderUrl(source.bookingUrl)) {
    if (!parseEzLinksSource(source.bookingUrl)) fail("UNSUPPORTED_ADAPTER_SOURCE");
    if (!source.officialUrl || !source.venueAddress) fail("ADAPTER_IDENTITY_MISSING");
    return { adapter: await inspectEzLinks({ ...source, officialUrl: source.officialUrl }, deps) };
  }
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
    let location = false;
    let locationDiagnostic: OfficialSourceDiagnostic | undefined;
    const diagnostic = (value: OfficialSourceDiagnostic) => { try { deps.onOfficialSourceDiagnostic?.(value); } catch { /* Diagnostic sinks cannot change reader behavior. */ } };
    if (deps.officialIdentityPage) {
      try { deriveUScheduleOfficialLocation(source, deps.officialIdentityPage, true, value => { locationDiagnostic = value; diagnostic(value); }, deps.trustedContext); location = true; }
      catch { diagnostic({ ...locationDiagnostic, stage: locationDiagnostic?.stage ?? "LOCATION_DERIVATION_REJECTED", derivationRejected: true, legacyFallback: true }); }
    }
    if (location) return { adapter: existingAdapterMetadataSchema.parse(await inspectUSchedulePublicLocation(source, deps)) };
    if (parseUScheduleLocationSource(source.bookingUrl)?.locationId) fail("USCHEDULE_PUBLIC_LOCATION_UNVERIFIED");
    if (!deps.officialIdentityPage) diagnostic({ stage: "LEGACY_FALLBACK", derivationRejected: true, legacyFallback: true });
    const session = createUSchedulePublicSession(source.bookingUrl, deps);
    try {
      const response = await session.read(source.bookingUrl);
      let configurationGate: UScheduleConfigurationGate | undefined;
      const config = inspectUScheduleRecipeConfiguration(await response.text(), source.bookingUrl, gate => { configurationGate = gate; });
      if (!config) {
        diagnostic({ stage: "INSPECTOR_REJECTED", ...(configurationGate ? { uscheduleConfigurationGate: configurationGate } : {}) });
        fail("ADAPTER_CONFIGURATION_UNVERIFIED");
      }
      const normalized = source.venueName.normalize("NFKC").toLowerCase().replace(/&/gu, "and").replace(/[^a-z0-9]/gu, "");
      if (normalized.length < 8 || normalized !== config.tenant.replace(/-/gu, "")) fail("ADAPTER_IDENTITY_MISMATCH");
      let publicRentalPartyProof;
      if (deps.officialIdentityPage) {
        try { publicRentalPartyProof = deriveUSchedulePublicRentalParty(source, deps.officialIdentityPage); }
        catch (error) {
          // An unstated limit stays unknown. A published but unverified limit
          // must never be downgraded to absence by the optional proof path.
          if (!isUSchedulePublicRentalPartyAbsent(error)) throw error;
        }
      }
      if (publicRentalPartyProof && (deps.requestedInput?.players ?? 1) > publicRentalPartyProof.maxPartySize)
        fail("USCHEDULE_PUBLIC_PARTY_UNVERIFIED");
      return { adapter: existingAdapterMetadataSchema.parse({ family: "USCHEDULE", tenant: config.tenant,
        serviceId: config.selected.serviceId, serviceName: config.selected.serviceName,
        ...(publicRentalPartyProof ? { publicRentalPartyProof } : {}) }) };
    } finally { session.dispose(); }
  }
  const inspectDeadline = new Date(Math.min(deps.deadlineAt?.getTime() ?? Infinity, Date.now() + 120000));
  const readBudget = { requests: 0, dataBytes: 0, bookingConfigurationRequested: false };
  let session = reader(source, deps, undefined, undefined, readBudget);
  try {
    if (session.teeitup) {
      const readDirectory = () => session.read(session.directoryUrl(), { headers: {
        accept: "application/json", "x-be-alias": session.apiAlias()!, origin: session.teeitup!.origin, referer: `${session.teeitup!.origin}/`,
      } });
      try {
        try { await readDirectory(); }
        catch (error) {
          const diagnostic = getFixedAdapterReadDiagnostic(error);
          if (diagnostic?.role !== "TEEITUP_DIRECTORY" || diagnostic.httpStatus !== 404 || diagnostic.stage !== "RESPONSE_HEADERS") throw error;
          await session.preparePublicBookingConfiguration();
          await readDirectory();
        }
      }
      catch (error) {
        if (isTeeItUpStreetTypeOmissionCandidate(source.venueAddress ?? "") && deps.localCapabilities?.includes("LOCAL_CHROME") &&
            error instanceof Error && ["OFFICIAL_POSTAL_SOURCE_UNVERIFIED", "OFFICIAL_IDENTITY_UNVERIFIED", "ADAPTER_IDENTITY_MISMATCH"].includes(error.message)) {
          const initialDirectoryDiagnostic = getFixedAdapterReadDiagnostic(error);
          try {
            if (!session.publicBookingConfiguration()) await session.preparePublicBookingConfiguration();
            await session.refreshStreetTypeOmittedSource();
            await readDirectory();
          } catch (omissionError) {
            if (initialDirectoryDiagnostic && !getFixedAdapterReadDiagnostic(omissionError)) rememberFixedAdapterReadFailure(omissionError, initialDirectoryDiagnostic);
            throw omissionError;
          }
        } else {
        if (!deps.localCapabilities?.includes("LOCAL_CHROME") || deps.nativeDelegatedChainToken || !source.officialUrl ||
            !(error instanceof Error) || !["OFFICIAL_POSTAL_SOURCE_UNVERIFIED", "OFFICIAL_IDENTITY_UNVERIFIED", "ADAPTER_IDENTITY_MISMATCH"].includes(error.message)) throw error;
        // Earn the chain in a separate fixed native reader after the failed
        // provider lease has drained. No lease is held across nested reads.
        session.dispose();
        const initialDirectoryDiagnostic = getFixedAdapterReadDiagnostic(error);
        try {
          const token = await readTeeItUpDelegatedBookingChain(source, { ...deps, deadlineAt: inspectDeadline });
          const configuration = session.publicBookingConfiguration();
          session = reader(source, { ...deps, nativeDelegatedChainToken: token, deadlineAt: inspectDeadline }, undefined, undefined, readBudget);
          if (configuration) await session.preparePublicBookingConfiguration();
          await readDirectory();
        } catch (fallbackError) {
          // This projection belongs to this invocation's original directory
          // read; retaining it never replaces the later primary exception.
          if (initialDirectoryDiagnostic) rememberFixedAdapterReadFailure(fallbackError, initialDirectoryDiagnostic);
          throw fallbackError;
        }
        }
      }
      return { adapter: existingAdapterMetadataSchema.parse({ family: "TEEITUP", alias: session.teeitup!.alias,
        facilityIds: session.teeitupFacilities()!.map(row => row.id),
        ...(session.publicBookingConfiguration() ? { publicBookingConfiguration: session.publicBookingConfiguration() } : {}),
        ...(session.teeitupFacilities()!.every(row => row.isSimulator === true) ? { offeringKind: "SIMULATOR" } : {}),
        ...(session.officialIdentityProof() ? { officialIdentityProof: session.officialIdentityProof() } : {}),
        ...(session.officialBookingSourceProof() ? { officialBookingSourceProof: session.officialBookingSourceProof() } : {}),
        ...(session.officialDelegatedBookingProof() ? { officialDelegatedBookingProof: session.officialDelegatedBookingProof() } : {}),
        ...(session.officialPostalConflictProof() ? { officialPostalConflictProof: session.officialPostalConflictProof() } : {}),
        ...(session.officialStreetTypeOmittedProof() ? { officialStreetTypeOmittedProof: session.officialStreetTypeOmittedProof() } : {}) }) };
    }
    if (session.family === "FOREUP") {
      const { config, proof } = await inspectForeupConfiguration(source, deps, session.read);
      if (!config) fail("ADAPTER_CONFIGURATION_UNVERIFIED");
      const path = foreupPath.exec(new URL(source.bookingUrl).pathname)!;
      return { adapter: existingAdapterMetadataSchema.parse({ family: "FOREUP", facilityId: Number(path[1] ?? path[3]),
        scheduleId: config.scheduleId, bookingClassId: config.bookingClassId, ...(proof ? { officialRouteOwnershipProof: proof } : {}) }) };
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
    const simulator = ["ACUITY", "USCHEDULE", "WHOOSH", "LIGHTSPEED", "AMELIA", "GOLFVX", "REX", "MINDBODY"].includes(adapter.family) || adapter.family === "TEEITUP" && adapter.offeringKind === "SIMULATOR";
    if (input.timeZone !== recipe.source.timeZone || recipe.source.providerFamily.toUpperCase() !== adapter.family ||
        (recipe.target.kind === "SIMULATOR") !== simulator || simulator && (!recipe.target.offeringId || !input.durationMinutes) ||
        adapter.family === "TEEITUP" && adapter.offeringKind === "SIMULATOR" && (adapter.facilityIds.length !== 1 || adapter.officialIdentityProof || adapter.officialBookingSourceProof || adapter.officialPostalConflictProof || adapter.officialDelegatedBookingProof || adapter.officialStreetTypeOmittedProof)) fail("ADAPTER_TARGET_MISMATCH");
    if (adapter.family === "EZLINKS" && (!recipe.source.officialUrl || !recipe.source.venueAddress ||
        parseEzLinksSource(recipe.source.bookingUrl)?.tenant !== adapter.tenant || input.durationMinutes !== undefined))
      fail("ADAPTER_TARGET_MISMATCH");
    if (["REX", "CPS"].includes(adapter.family) && (!recipe.source.officialUrl || !recipe.source.venueAddress ||
        adapter.family === "CPS" && input.durationMinutes !== undefined)) fail("ADAPTER_TARGET_MISMATCH");
    if (adapter.family === "MINDBODY") {
      if (!recipe.source.officialUrl || !recipe.source.venueAddress || parseMindbodyAppointmentSource(recipe.source.bookingUrl)?.studioId !== adapter.studioId ||
          adapter.timeZone !== input.timeZone || adapter.durationMinutes !== input.durationMinutes || input.players > adapter.capacity) fail("ADAPTER_TARGET_MISMATCH");
      if (!deps.localCapabilities?.includes("LOCAL_CHROME")) fail("LOCAL_CHROME_REQUIRED");
    }
    if (!["USCHEDULE", "WHOOSH", "LIGHTSPEED", "AMELIA", "CHRONOGOLF", "GOLFVX", "EZLINKS", "REX", "CPS", "MINDBODY"].includes(adapter.family)) session = reader(recipe.source, deps, adapter, input);
    const start = deps.toInstant(`${input.date}T${input.startTime}:00`, input);
    const next = new Date(`${input.date}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    const end = deps.toInstant(`${input.endTime === "24:00" ? next.toISOString().slice(0, 10) : input.date}T${input.endTime === "24:00" ? "00:00" : input.endTime}:00`, input);
    const now = clock();
    if (end <= now) fail("INVALID_REQUEST_DATE_OR_ZONE");
    if (adapter.family === "MINDBODY") {
      const slots = await executeMindbodyAppointments({ ...recipe.source, venueAddress: recipe.source.venueAddress! }, adapter, recipe.target, input,
        { ...deps, ...(deps.createMindbodySession ? { createSession: deps.createMindbodySession } : {}) });
      return result(slots.filter(slot => new Date(slot.startsAt) > now && new Date(slot.startsAt) >= start && new Date(slot.endsAt!) <= end));
    }
    if (adapter.family === "REX") {
      const slots = await executeRex(recipe.source, adapter, { courseId: recipe.target.courseId, offeringId: recipe.target.offeringId! }, input, deps);
      return result(slots.filter(slot => new Date(slot.startsAt) > now && new Date(slot.startsAt) >= start && new Date(slot.endsAt!) <= end));
    }
    if (adapter.family === "CPS") {
      const slots = await executeCps(recipe.source, adapter, { courseId: recipe.target.courseId }, input, deps);
      return result(slots.filter(slot => new Date(slot.startsAt) > now && new Date(slot.startsAt) >= start && new Date(slot.startsAt) < end && slot.availableSpots >= input.players));
    }
    if (adapter.family === "EZLINKS") {
      const slots = await executeEzLinks(recipe.source, adapter, { courseId: recipe.target.courseId }, input, deps);
      return result(slots.filter(slot => new Date(slot.startsAt) > now && new Date(slot.startsAt) >= start && new Date(slot.startsAt) < end && slot.availableSpots >= input.players));
    }
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
      if (adapter.publicLocationProof) {
        const available = await executeUSchedulePublicLocation(recipe.source, { ...adapter, publicLocationProof: adapter.publicLocationProof },
          { courseId: recipe.target.courseId, offeringId: recipe.target.offeringId! }, input, deps);
        return result(available.slots.filter(slot => slot.startsAt > now && slot.startsAt >= start && slot.endsAt <= end).map(slot => ({
          sourceId: slot.sourceId, startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString(), availableSpots: 1,
          capacity: slot.maxPartySize, bookingUrl: recipe.source.bookingUrl, resourceId: slot.resourceId, productId: slot.productId,
        })));
      }
      const normalized = recipe.source.venueName.normalize("NFKC").toLowerCase().replace(/&/gu, "and").replace(/[^a-z0-9]/gu, "");
      if (uschedulePublicTenant(recipe.source.bookingUrl) !== adapter.tenant || normalized.length < 8 || normalized !== adapter.tenant.replace(/-/gu, "")) fail("ADAPTER_IDENTITY_MISMATCH");
      let capacity: number | null = null;
      if (adapter.publicRentalPartyProof) {
        const proof = adapter.publicRentalPartyProof;
        if (!deps.localCapabilities?.includes("LOCAL_CHROME") || !deps.readNativeOfficialPage || !recipe.source.officialUrl ||
            proof.officialPageUrl !== recipe.source.officialUrl || proof.bookingUrl !== recipe.source.bookingUrl || proof.venueName !== recipe.source.venueName)
          fail("USCHEDULE_PUBLIC_PARTY_UNVERIFIED");
        const deadline = new Date(Math.min(deps.deadlineAt?.getTime() ?? Infinity, Date.now() + 90_000));
        const fresh = await deps.readNativeOfficialPage(recipe.source, proof.officialPageUrl, deadline);
        if (!isFreshNativeOfficialIdentityPage(fresh, recipe.source.officialUrl) ||
            JSON.stringify(deriveUSchedulePublicRentalParty(recipe.source, fresh)) !== JSON.stringify(proof)) fail("USCHEDULE_PUBLIC_PARTY_UNVERIFIED");
        capacity = proof.maxPartySize;
      }
      if (capacity !== null && input.players > capacity) fail("USCHEDULE_PUBLIC_PARTY_UNVERIFIED");
      uscheduleSession = createUSchedulePublicSession(recipe.source.bookingUrl, { ...deps, requestedPlayers: input.players });
      const available = await fetchUScheduleRecipeAvailability({ date: input.date, durationMinutes: input.durationMinutes!, partySize: 1, requestedPlayers: input.players,
        timeZone: input.timeZone, offering: { id: recipe.target.offeringId!, courseId: recipe.target.courseId, bookingUrl: recipe.source.bookingUrl,
          providerFamilyKey: "USCHEDULE", active: true, publicAccessStatus: "PUBLIC", providerMetadata: { tenant: adapter.tenant, serviceId: adapter.serviceId },
          maxPartySize: null, supportedDurationsMinutes: [input.durationMinutes!] } }, adapter, uscheduleSession.read);
      // The fresh service/site upper limit does not establish per-suite
      // capacity. Enforce both known limits while retaining one bay/null capacity.
      if (available.publicPartyLimit != null && input.players > available.publicPartyLimit) fail("USCHEDULE_PUBLIC_PARTY_UNVERIFIED");
      return result(available.slots.filter(slot => slot.startsAt > now && slot.startsAt >= start && slot.endsAt <= end).map(slot => ({
        sourceId: slot.sourceId, startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString(), availableSpots: 1,
        capacity, bookingUrl: recipe.source.bookingUrl, resourceId: slot.resourceId, productId: slot.productId,
      })));
    }
    if (adapter.family === "FOREUP") {
      const path = foreupPath.exec(new URL(recipe.source.bookingUrl).pathname);
      if (!path || Number(path[1] ?? path[3]) !== adapter.facilityId) fail("ADAPTER_SOURCE_MISMATCH");
      // The observed entry may default to another sheet within this facility.
      // Re-resolve the canonical venue and public class from that same current
      // document before using any saved schedule/class for availability.
      const { config } = await inspectForeupConfiguration(recipe.source, deps, session!.read, adapter.officialRouteOwnershipProof, true);
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
      if (adapter.publicBookingConfiguration) await session!.preparePublicBookingConfiguration();
      if (adapter.officialStreetTypeOmittedProof) await session!.refreshStreetTypeOmittedSource();
      if (adapter.officialIdentityProof) await session!.read(adapter.officialIdentityProof.officialPageUrl);
      if (adapter.officialPostalConflictProof) await session!.refreshPostalSource();
      if (adapter.offeringKind === "SIMULATOR") {
        const origin = new URL(recipe.source.bookingUrl).origin;
        const headers = { accept: "application/json", "x-be-alias": session!.apiAlias()!, origin, referer: `${origin}/` };
        await session!.read(session!.directoryUrl(), { headers });
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
        metadata: { aliases: [adapter.alias], bookingBaseUrl, facilityIds: adapter.facilityIds } }, session!.read, session!.publicBookingConfiguration()?.apiAlias);
      if (!session!.availabilityWasArray()) fail("ADAPTER_EMPTY_UNPROVEN");
      return result(available.slots.map(slot => ({ ...slot, time: deps.toInstant(slot.startsAt, input) })).filter(slot =>
        slot.time > now && slot.time >= start && slot.time < end && slot.availableSpots >= input.players).map(slot => ({
        sourceId: slot.sourceId, startsAt: slot.time.toISOString(), availableSpots: slot.availableSpots,
        bookingUrl: teeItUpRecipeBookingUrl(recipe.source.bookingUrl, input.date, Number(/^teeitup-(\d+)-/u.exec(slot.sourceId)?.[1])),
        resourceId: `teeitup-facility:${/^teeitup-(\d+)-/u.exec(slot.sourceId)?.[1]}`,
        ...(slot.holes === 9 || slot.holes === 18 ? { holes: slot.holes as 9 | 18 } : {}),
      })));
    }
    if (adapter.family !== "ACUITY") fail("UNSUPPORTED_ADAPTER_SOURCE");
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
    const diagnostic = recipe.adapter.family === "MINDBODY" ? mindbodyReplayDiagnostic(error) : simulatorErrorDiagnostic(error, recipe.adapter.family === "USCHEDULE");
    const message = session?.failureReason() ?? uscheduleSession?.failureReason() ?? diagnostic?.simulatorError?.code ??
      (error instanceof FixedAdapterFailure || recipe.adapter.family !== "ACUITY" && error instanceof Error ? error.message : "");
    return result([], /^[A-Z_]{1,80}$/u.test(message) ? message : "ADAPTER_READ_FAILED", diagnostic);
  } finally { session?.dispose(); uscheduleSession?.dispose(); }
}
