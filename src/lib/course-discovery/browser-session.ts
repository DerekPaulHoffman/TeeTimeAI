import { collectNativeOfficialPublicMetadata } from "./public-document-metadata";
import { observedPublicBookingIntermediary } from "./public-booking-intermediary";
import { createHash, randomUUID } from "node:crypto";
import { chargeDelegatedReadBudget, delegatedProxyAllocation, settleDelegatedProxyBudget, type DelegatedReadBudget } from "./teeitup-delegated-booking-context";
import { createDelegationDiagnostic, rememberTeeItUpDelegationFailure, getTeeItUpDelegationDiagnostic } from "./teeitup-delegated-booking-diagnostic";
import { describePublicUrlRejection, safePublicUrlRejectionDiagnostic } from "../../../scripts/automation/course-discovery-diagnostics.mjs";
import type { Browser, Locator } from "@playwright/test";
import { z } from "zod";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { createPassfactoryPublicReadPolicy, isIncidentalBrowserRequest, isNonEvidenceBrowserResource } from "@/lib/automation/passfactory-public-read-policy";
import { interactiveControlKind, isAnonymousBrowserReadPost } from "@/lib/automation/simulator-interactive-browser";
import { addVerifiedMindbodyReadHeaders, isMindbodyClassicPublicBootstrapPost } from "@/lib/automation/mindbody-public-read-policy";
import { isRexAnonymousPlaceholderRead, isRexNamespace, isRexPublicBrowserReadPost, rexProjectedPublicReadRejection, rexPublicBrowserReadRejection } from "@/lib/automation/rex-public-read-policy";
import { createUSchedulePublicReadPolicy } from "@/lib/automation/uschedule-public-read-policy";
import { isUSchedulePublicHost, uschedulePublicTenant } from "@/lib/simulators/providers/public-configuration";
import { isMemberSportsPublicTeeSheetPost } from "@/lib/automation/membersports-public-read-policy";
import { sanitizeResponderText } from "@/lib/automation/course-support-responder-policy";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { accessExecutionInputSchema, type AccessExecutionInput, isActiveBrowserAccessChallenge, isSafeBrowserAssetUrl, isSafeBrowserBootstrapReadUrl, isSafeBrowserAvailabilityReadUrl, isSafeRecipeUrl, recipeSelectorSchema } from "./recipe";
import { continueNativeBrowserRead, createNativePublicBrowserProxy, isObservedNativeRedirect, isObservedNativeRedirectTarget, nativeReadPreflightMethod } from "./native-public-browser";
import { installNativeRedirectRouting, isNativeReadSupersededFailure, authorizePublicClientReadHeaders, isCurrentPublicClientReadHeaders, nativePublicClientPreflightMethod, nativeMindbodyBootstrapSource, nativeMindbodyControllerForm,
  publicClientReadHeaderProofFailure, attestedNativeDocumentRedirects, type NativeDocumentRedirect, type NativeFirstFatal, type NativeReadRoute, type NativeRequestDiagnostic } from "./native-redirect-routing";
import { publicHeaderFailureDiagnostic } from "./public-header-diagnostic";
export { publicHeaderFailureDiagnostic } from "./public-header-diagnostic";
import { requestFamilyForUrl } from "./request-family";
import { canonicalPublicReadUrl } from "./public-request-url";
import { inspectExistingAdapter } from "./existing-adapter-executor";
import { getFixedAdapterReadDiagnostic } from "./fixed-adapter-read-diagnostic";
import { getCpsPostalContactDiagnostic } from "./cps-postal-conflict-proof";
import { getMindbodyAppointmentDiagnostic } from "./mindbody-appointment-reader";
import { isPublicCalendarApply } from "./public-calendar-apply";
import { isObservedPublicCalendarDay, observedPublicCalendarDays } from "./public-calendar-day";
import { PUBLIC_BROWSER_REQUEST_LIMIT, MINDBODY_APPOINTMENT_REQUEST_LIMIT, assertPublicBrowserRequestBudget, PUBLIC_BROWSER_TOTAL_BYTES, publicBrowserResponseLimit } from "./browser-resource-limits";
import { observedPublicDropdowns, selectPublicDropdown, type PublicDropdownProof } from "./public-dropdown-control";
import { observedPublicMenuButtons, selectPublicMenuButton, type PublicMenuButtonProof } from "./public-duration-button";
import { venueProofMatches } from "./executor";
import type { ExistingAdapterMetadata } from "./existing-adapter-schema";
import { publicResponseSchema, type PublicResponseSchema } from "./public-response-schema";
import type { OfficialIdentityPage } from "./teeitup-official-identity";
import { createTeeItUpOfficialBookingScope, observedTeeItUpOfficialBookingChain, type TeeItUpSourceRequestToken } from "./teeitup-official-booking-context";
import { discoveryNavigationFailureKind, safeOfficialSourceDiagnostic, type OfficialSourceDiagnostic, type NavigationFailureKind } from "./official-source-diagnostics";
import { inspectPublicRentalProduct } from "./public-product-control";
import { createPublicCatalogTileScope, inspectPublicCatalogTile, openPublicCatalogTile } from "./public-catalog-tile";
import { canonicalCpsPublicUrl, cpsPublicEntryUrl, cpsSessionKey, createCpsPublicSessionScope } from "./cps-public-navigation";
import { observedPublicDateChoices, isPublicDateChoice } from "./public-date-choice";
import { inspectPublicDatePickerInput, openPublicDatePickerInput, type PublicDatePickerInputProof } from "./public-date-picker-input";
import { isPublicAvailabilityNavigation } from "./public-navigation-control";
import { observedPublicFrameSources } from "./public-frame-source";
import { launchPublicReadBrowser } from "./public-browser-launch";
import { createPublicBookingParentScope, readPublicBookingParentIdentity } from "./public-booking-parent";
import { readVisiblePublicCourseContactBlocks } from "./public-course-contact-blocks";
import { discoveryTrustedContextSchema, type DiscoveryTrustedContext } from "./trusted-context";
import { createEzLinksPublicReadPolicy, type EzLinksDocumentToken } from "./ezlinks-public-read-policy";
import { createMindbodyAppointmentNativeCapture } from "./mindbody-appointment-native-capture";
import { parseMindbodyAppointmentSource, validateMindbodyAppointmentSource } from "./mindbody-appointment-grid";
import { inspectPublicRentalService, openPublicRentalService, selectPublicRentalService, inspectPublicServiceContinuation,
  continuePublicRentalService, type PublicRentalServiceProof, type PublicRentalServiceSelection, type PublicServiceContinuationMode } from "./public-service-control";

const identifier = z.union([z.string().max(128), z.number().int()]);
export const discoveryBrowserActionSchema = z.discriminatedUnion("action", [
  z.object({ id: identifier, action: z.literal("open"), url: z.string().max(2048) }).strict(),
  z.object({ id: identifier, action: z.literal("inspect_adapter"), url: z.string().max(2048) }).strict(),
  z.object({ id: identifier, action: z.literal("inspect"), selector: recipeSelectorSchema }).strict(),
  z.object({ id: identifier, action: z.literal("observe") }).strict(),
  z.object({ id: identifier, action: z.literal("click"), target: z.string().uuid() }).strict(),
  z.object({ id: identifier, action: z.literal("select"), target: z.string().uuid(), option: z.string().max(200) }).strict(),
  z.object({ id: identifier, action: z.literal("fill"), target: z.string().uuid(), text: z.string().max(120) }).strict(),
  z.object({ id: identifier, action: z.literal("scroll"), direction: z.enum(["up", "down"]) }).strict(),
  z.object({ id: identifier, action: z.literal("finish") }).strict(),
]);
export type DiscoveryBrowserAction = z.infer<typeof discoveryBrowserActionSchema>;
type ObservedControl = { tag: string; role: string; name: string; label: string; href?: string; calendar: boolean;
  sensitiveForm: boolean; inForm: boolean; hasDownload: boolean; inputType: string; hasPopup: string; selector: string; options?: Array<{ value: string; label: string }>;
  currentValue?: string; product?: { selector: string; durationMinutes: number }; choiceValue?: string; choiceContext?: string; disabledChoice?: boolean;
  formSafeAnchor?: boolean; readOnlyFormDisplay?: boolean; documentNavigationOnly?: boolean; datePicker?: PublicDatePickerInputProof;
  service?: PublicRentalServiceProof; serviceContinuation?: PublicServiceContinuationMode; serviceMenuOption?: boolean; catalogTile?: boolean };
type EzLinksDocumentWitness = { url: string; settled: boolean; status?: number; token?: EzLinksDocumentToken;
  observedAt?: number;
  init?: unknown; initAt?: number; initVersion: number; pendingInit: number; initAttempted: boolean;
  readContractAssets: Map<string, { complete: boolean; sha256?: string }>; readContractFailed: boolean; readContractVersion: number };
type EzLinksControllerRead = { nonce: string; document: EzLinksDocumentWitness; token: EzLinksDocumentToken; version: number;
  contractVersion?: number; url: string; method: "GET" | "POST"; body?: string; seen: boolean; complete: boolean; result?: unknown; error?: Error };
const ezLinksReadHeader = "x-tts-public-read";
export type EzLinksReadContract = { kind: "EZLINKS_UNPAGED_SEARCH_V1"; assets: Array<{ path: string; sha256: string }> };
// Reviewed unpaged loadData/search semantics. These are not fetch targets or
// model-supplied hashes: only this document's already admitted Script reads can
// provide the fully decoded bytes for the exact two public assets.
const ezLinksReadContractAssets = [
  { path: "/assets/index-DsLbHQvf.js", sha256: "4e2bb6ea29fa910e04620c1551d737aecaff9df23bf6be99f9da6d72e9b1addb" },
  { path: "/assets/index-CvL6jQuU.js", sha256: "6547b7841afb6945817f5c354437875bd5f1fb59031ed511cf16d30bca72262f" },
] as const;

export function discoveryPublicChoiceKind(control: Pick<ObservedControl, "tag" | "name" | "href" | "calendar" | "sensitiveForm" | "choiceValue" | "choiceContext" | "disabledChoice">) {
  if (control.sensitiveForm || control.disabledChoice || control.href || /\b(?:checkout|reserve|book|pay|confirm|cancel)\b|\d{1,2}:\d{2}/iu.test(control.name)) return null;
  if (["td", "th"].includes(control.tag) && control.calendar && /^(?:\d{1,2}|[<>‹›«»])$/u.test(control.name.trim())) return "calendar" as const;
  if (["a", "button", "div", "span"].includes(control.tag) && control.choiceValue && control.choiceValue.length <= 40 &&
      /players?|holes?|duration|time.?of.?day|morning|midday|evening/iu.test(control.choiceContext ?? "") &&
      /^(?:\d{1,3}(?:\s+(?:holes?|players?|guests?|minutes?|hours?))?|any|all|both|morning|midday|evening|anytime)$/iu.test(control.name.trim())) return "option" as const;
  return null;
}

/** Public navigation labels are distinct from selecting or reserving a time. */
export function discoveryPublicAnchorKind(control: Pick<ObservedControl, "tag" | "name" | "label" | "href" | "sensitiveForm">) {
  if (control.tag !== "a" || !control.href || !isSafeRecipeUrl(control.href) || control.sensitiveForm) return null;
  const text = `${control.name} ${control.label}`;
  if (!/\b(?:book|reserve|reservations?|tee\s*times?|availability)\b/iu.test(text) ||
      /\b(?:login|log in|sign in|sign up|register|checkout|pay|payment|purchase|confirm|cancel|delete|send|subscribe|password|email|phone)\b/iu.test(text) ||
      /\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/iu.test(text)) return null;
  if (!isPublicAvailabilityNavigation(control.href, text.trim())) return null;
  return "link" as const;
}
/** A printed registration invitation may share a public availability entry.
 * This admits only its exact known GET document, never its handler or a form. */
export function discoveryPublicAvailabilityEntryNavigation(control: Pick<ObservedControl, "tag" | "name" | "label" | "href" | "sensitiveForm" | "inForm" | "hasDownload">) {
  if (control.tag !== "a" || control.inForm !== false || control.sensitiveForm !== false || control.hasDownload !== false ||
      !control.href || !isSafeRecipeUrl(control.href) || !uschedulePublicTenant(control.href)) return false;
  const normalize = (value: string) => value.trim().replace(/\s+/gu, " ").toLowerCase();
  const name = normalize(control.name), label = normalize(control.label);
  return name.length <= 160 && (!label || label === name) &&
    /^(?:click here to )?(?:check|view) availability\s*[,;]?\s*(?:and |& )?register\s*(?:and|&)\s*book(?: now)?[.!]?$/iu.test(name);
}

/** ForeUP's official login bookmark shares a documented public tee-sheet
 * bootstrap. Inspect that public base without entering the login route. */
export function normalizeDiscoveryNavigationUrl(value: string) {
  const cps = cpsPublicEntryUrl(value);
  if (cps) return cps;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "foreupsoftware.com" &&
        /^\/index\.php\/booking\/\d+(?:\/\d+)?\/?$/u.test(url.pathname) && /^#\/login\/?$/iu.test(url.hash)) {
      url.hash = "";
      if (isSafeRecipeUrl(url.href)) return url.href;
    }
  } catch { /* Normal URL validation below rejects invalid source links. */ }
  return value;
}

/** Fragments select a client-side view of the same HTTP document. Keep every
 * other URL byte exact so a later route/query cannot borrow an earlier status. */
export function sameDiscoveryMainDocument(observedUrl: string, currentUrl: string) {
  return Boolean(observedUrl && currentUrl) && observedUrl.split("#", 1)[0] === currentUrl.split("#", 1)[0];
}

export type DiscoveryBrowserSnapshot = {
  url: string; text: string; controls: Array<{ target: string; selector: string; kind: string; name: string; label: string; href?: string; options?: Array<{ value: string; label: string }>; currentValue?: string; filterPurpose?: "DURATION" | "PLAYERS"; readOnly?: true; product?: { selector: string; durationMinutes: number } }>;
  responses: Array<{ url: string; status: number; method: string; body?: unknown; bodyOmitted?: true; schemaEvidence?: PublicResponseSchema; schemaEvidenceOmitted?: true }>;
  requests: Array<{ url: string; method: string; resourceType: string; status?: number; blockedReason?: string; body?: unknown; readPurpose?: "PUBLIC_BOOTSTRAP" | "PUBLIC_AVAILABILITY";
    urlRejection?: ReturnType<typeof safePublicUrlRejectionDiagnostic>; publicHeaderDiagnostic?: ReturnType<typeof publicHeaderFailureDiagnostic> }>;
  /** Controller-to-worker only; stripped before any model/tool response. */
  completedPublicAssetRequests?: Array<{ url: string; method: "GET"; resourceType: "script" | "stylesheet"; status: number }>;
  completedPublicAssetRequestsOverflow?: boolean;
  /** Controller-only current native HTTP lineage; stripped from model input. */
  nativeDocumentRedirects?: NativeDocumentRedirect[];
  requestFailures?: Array<{ reason: string; resourceType: string; method?: string; url?: string;
    urlRejection?: ReturnType<typeof safePublicUrlRejectionDiagnostic>; publicHeaderDiagnostic?: ReturnType<typeof publicHeaderFailureDiagnostic> }>;
  nativeFirstFatal?: NativeFirstFatal;
  nativeRejectedRequests?: NativeRequestDiagnostic[];
  officialSourceDiagnostic?: OfficialSourceDiagnostic;
  navigationFailureKind?: NavigationFailureKind;
  capabilityDiagnostics?: Array<{ code: "SUBFRAME_UNSUPPORTED"; resourceType: string; url?: string }>;
  frames: Array<{ url: string; source?: "OFFICIAL_IFRAME_SRC" }>;
  elements: Array<{ selector: string; tag: string; text: string; attributes: Record<string, string> }>;
  loading: boolean; blockedRequests: number; requestCount: number; interceptCount: number; responseBytes: number; startupMs: number;
  navigationStatus?: number; navigationElapsedMs?: number; initialContentWaitMs?: number; pendingRequestCount?: number;
  browserTransport: "PINNED_HTTP" | "NATIVE_CHROME";
  accessRequirementObserved?: boolean;
  adapter?: ExistingAdapterMetadata;
  structure?: { selected: string; ancestors: Array<{ selector: string; matches: number; tag: string; text: string;
    attributes: Record<string, string>; href?: string; target?: string; children: Array<{ selector: string; tag: string; text: string; href?: string; target?: string }> }> };
};
export type DiscoveryBrowserSessionDependencies = {
  delegatedReadBudget?: DelegatedReadBudget;
  /** Private fixed delegated-source reader; never an action/recipe field. */
  captureDelegatedDocument?: true;
  /** Private fixed CPS source capture; never a model/browser action field. */
  collectPublicCourseContacts?: true;
  fetch?: typeof fetch;
  launchBrowser?: () => Promise<Browser>;
  requestLease?: typeof runWithProviderRequestLease;
  browserTransport?: "PINNED_HTTP" | "NATIVE_CHROME";
  /** Fixed controller reader only. Never accepted from actions or recipes. */
  fixedReaderProfile?: "MINDBODY_APPOINTMENTS";
  localCapabilities?: readonly string[];
  onRequestFailure?: (failure: { url: string; resourceType: string; reason: string }) => void;
  inspectAdapter?: typeof inspectExistingAdapter;
};
export function discoveryBrowserRequestLimit(input: { initialUrls: string[]; timeZone?: string; venueName?: string; venueAddress?: string; venueOfficialUrl?: string;
  requestedInput?: AccessExecutionInput }, deps: Pick<DiscoveryBrowserSessionDependencies, "fixedReaderProfile" | "browserTransport" | "localCapabilities">) {
  if (deps.fixedReaderProfile === undefined) return PUBLIC_BROWSER_REQUEST_LIMIT;
  if (deps.fixedReaderProfile !== "MINDBODY_APPOINTMENTS" || deps.browserTransport !== "NATIVE_CHROME" ||
      !deps.localCapabilities?.includes("LOCAL_CHROME") || input.initialUrls.length !== 1 || !parseMindbodyAppointmentSource(input.initialUrls[0]))
    throw new Error("INVALID_FIXED_READER_PROFILE");
  const requested = accessExecutionInputSchema.safeParse(input.requestedInput);
  if (!requested.success || !requested.data.durationMinutes || requested.data.timeZone !== input.timeZone) throw new Error("INVALID_FIXED_READER_PROFILE");
  try { validateMindbodyAppointmentSource({ bookingUrl: input.initialUrls[0], officialUrl: input.venueOfficialUrl ?? "", venueName: input.venueName ?? "",
    venueAddress: input.venueAddress ?? "", timeZone: input.timeZone ?? "" }); } catch { throw new Error("INVALID_FIXED_READER_PROFILE"); }
  return MINDBODY_APPOINTMENT_REQUEST_LIMIT;
}
const sensitive = /password|secret|token|cookie|session|credential|authorization|api.?key|email|phone|contact|card|customer|user|person|attendee/iu;
/** URL metadata may contain a site's public API key; it is not model input. */
export function redactDiscoveryRequestUrl(value: string) {
  value = canonicalCpsPublicUrl(value);
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys()) if (/^(?:key|api[-_]?key|access[-_]?token|token|secret|password|credential|authorization|email|phone)$/iu.test(key)) url.searchParams.set(key, "REDACTED");
    return url.href;
  } catch { return ""; }
}
/** Diagnostic paths are public and session-free; query values are never needed
 * to distinguish a policy rejection from a transport failure. */
export function redactDiscoveryFailureUrl(value: string, resourceType: string) {
  try {
    const url = new URL(canonicalCpsPublicUrl(value));
    url.search = ""; url.hash = "";
    return isSafeRecipeUrl(url.href) || isSafeBrowserAssetUrl(url.href, resourceType, "GET") ? url.href : undefined;
  } catch { return undefined; }
}
/** Project public calendar data only; never return response headers or raw bodies. */
export function redactDiscoveryJson(value: unknown, depth = 0): unknown {
  if (depth > 7) return "[depth limit]";
  if (typeof value === "string") return sanitizeResponderText(value).slice(0, 600);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactDiscoveryJson(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 80)
    .map(([key, item]) => [key.slice(0, 80), sensitive.test(key) ? "[redacted]" : redactDiscoveryJson(item, depth + 1)]));
  return null;
}

/** Scoped, disposable discovery browser. The model receives data and opaque
 * control IDs; it never receives browser/CDP access or a JavaScript evaluator. */
export async function createCourseDiscoveryBrowserSession(input: {
  deadlineAt: Date; initialUrls: string[]; timeZone?: string; venueName?: string; venueAddress?: string; venueOfficialUrl?: string;
  /** Trusted constructor context, never a browser action or model proof. */
  requestedInput?: AccessExecutionInput;
  trustedContext?: DiscoveryTrustedContext;
}, deps: DiscoveryBrowserSessionDependencies = {}) {
  const startupStartedAt = Date.now();
  const requestedInput = input.requestedInput === undefined ? undefined : accessExecutionInputSchema.parse(input.requestedInput);
  const trustedContext = input.trustedContext === undefined ? undefined : discoveryTrustedContextSchema.parse(input.trustedContext);
  if (requestedInput && requestedInput.timeZone !== (input.timeZone ?? "UTC")) throw new Error("REQUEST_CONTEXT_TIME_ZONE_MISMATCH");
  const initialUrls = input.initialUrls.map(normalizeDiscoveryNavigationUrl);
  if (!initialUrls.length || initialUrls.length > 16 || !initialUrls.every(isSafeRecipeUrl)) throw new Error("INVALID_INITIAL_URLS");
  const requestLimit = discoveryBrowserRequestLimit({ ...input, initialUrls }, deps);
  try { new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone ?? "UTC" }); } catch { throw new Error("INVALID_TIME_ZONE"); }
  const remaining = input.deadlineAt.getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 20 * 60_000) throw new Error("INVALID_DEADLINE");
  const cancellation = new AbortController();
  const deadline = AbortSignal.any([AbortSignal.timeout(remaining), cancellation.signal]);
  const allowedNavigation = new Set(initialUrls.map(value => new URL(value).href));
  // Redirects and successful ancillary reads never become new chain roots.
  // Only exact explicit inputs and actually observed safe public links do.
  const observedNavigationRoots = new Set(allowedNavigation);
  const cpsScope = createCpsPublicSessionScope(initialUrls);
  const bookingParents = createPublicBookingParentScope({ officialUrl: input.venueOfficialUrl, venueName: input.venueName, venueAddress: input.venueAddress });
  const publicIntermediaries = new Map<string, { pageUrl: string; documentStartedAt: number }>();
  const teeBookingScope = createTeeItUpOfficialBookingScope({ officialUrl: input.venueOfficialUrl, venueName: input.venueName ?? "",
    venueAddress: input.venueAddress, timeZone: input.timeZone ?? "UTC" }, deadline);
  let teeDocumentToken: TeeItUpSourceRequestToken | undefined;
  type OfficialDocumentProof = { kind: "VERIFIED_OFFICIAL_DOCUMENT"; officialUrl: string; documentUrl: string };
  let officialIdentityPage: (OfficialIdentityPage & { observedAt: number; documentStartedAt: number; officialDocumentProof: OfficialDocumentProof }) | undefined;
  let lastOfficialIdentityReadDiagnostic: { captureAgeMs: number | null; gates: Record<string, boolean> } | undefined;
  let teeItUpDelegation: ReturnType<typeof getTeeItUpDelegationDiagnostic>;
  let adapterRead: ReturnType<typeof getFixedAdapterReadDiagnostic>;
  let officialIdentityDocument: { url: string; html: string; officialDocumentProof: OfficialDocumentProof } | undefined;
  let delegatedIdentityDocument: { url: string; html: string } | undefined;
  let delegatedIdentityPage: (OfficialIdentityPage & { observedAt: number; documentStartedAt: number }) | undefined;
  let nativeDocumentRedirects: { url: string; request: object } | undefined;
  let officialSourceDiagnostic: OfficialSourceDiagnostic | undefined, navigationFailureKind: NavigationFailureKind | undefined;
  let cpsPostalContact: ReturnType<typeof getCpsPostalContactDiagnostic>;
  let mindbodyAppointment: ReturnType<typeof getMindbodyAppointmentDiagnostic>;
  const officialDiagnostics = () => safeOfficialSourceDiagnostic({ ...teeBookingScope.diagnostics(page.url()), ...officialSourceDiagnostic,
    rawOfficialCaptured: Boolean(officialIdentityDocument), currentOfficialDocument: Boolean(officialIdentityDocument && sameDiscoveryMainDocument(officialIdentityDocument.url, page.url())),
    officialProvenance: officialIdentityDocument?.officialDocumentProof.kind === "VERIFIED_OFFICIAL_DOCUMENT",
    renderedHeadingsPresent: Boolean(officialIdentityPage?.visibleEvidence?.headings.length), renderedAddressesPresent: Boolean(officialIdentityPage?.visibleEvidence?.addressTexts.length),
    renderedLinksPresent: Boolean(officialIdentityPage?.visibleEvidence?.linkUrls.length) });
  function discardStaleOfficialIdentity(currentUrl: string) {
    if (officialIdentityPage && input.venueOfficialUrl &&
        [new URL(input.venueOfficialUrl).origin, new URL(officialIdentityPage.url).origin].includes(new URL(currentUrl).origin) &&
        !sameDiscoveryMainDocument(officialIdentityPage.url, currentUrl)) officialIdentityPage = undefined;
  }
  const navigationOrigins = new Set(initialUrls.map(value => new URL(value).origin));
  const passfactory = createPassfactoryPublicReadPolicy();
  const catalogTiles = createPublicCatalogTileScope();
  const uschedule = createUSchedulePublicReadPolicy();
  const ezlinks = createEzLinksPublicReadPolicy();
  initialUrls.forEach(value => passfactory.observeWidgetUrl(value));
  const readPost = (url: URL, headers: Headers, body: string) =>
    ezlinks.handles(url) ? ezlinks.allows(url, headers, body) :
      isAnonymousBrowserReadPost(url, headers, body) || passfactory.allows(url, headers, body) || uschedule.allows(url, headers, body);
  const queue = createSimulatorBrowserRequestQueue(deps.requestLease ?? runWithProviderRequestLease, deadline);
  if (deps.delegatedReadBudget && deps.browserTransport !== "NATIVE_CHROME") throw new Error("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
  const nativeProxy = deps.browserTransport === "NATIVE_CHROME" ? await createNativePublicBrowserProxy({ signal: deadline,
    ...(deps.delegatedReadBudget ? delegatedProxyAllocation(deps.delegatedReadBudget) : {}) }) : undefined;
  let browser: Browser;
  try {
    browser = deps.launchBrowser ? await deps.launchBrowser() : await launchPublicReadBrowser({
      headless: !(nativeProxy && process.platform === "win32"), ...(process.platform === "win32" ? { channel: "chrome" } : {}), timeout: Math.min(15_000, remaining),
      ...(nativeProxy ? { args: ["--disable-quic", "--proxy-bypass-list=<-loopback>"] } : {}),
    });
  } catch (error) { await nativeProxy?.close(); queue.dispose(); throw error; }
  const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, timezoneId: input.timeZone ?? "UTC", locale: "en-US",
    ...(nativeProxy ? { proxy: { server: nativeProxy.server, bypass: "<-loopback>" } } : {}) });
  await context.routeWebSocket("**/*", route => { route.close(); });
  const page = await context.newPage();
  let redirectRouting: Awaited<ReturnType<typeof installNativeRedirectRouting>> | undefined;
  const startupMs = Date.now() - startupStartedAt;
  page.setDefaultTimeout(Math.min(10_000, remaining));
  const responses: DiscoveryBrowserSnapshot["responses"] = [];
  const observedRequests: DiscoveryBrowserSnapshot["requests"] = [];
  const completedPublicAssets = new Map<string, NonNullable<DiscoveryBrowserSnapshot["completedPublicAssetRequests"]>[number]>();
  const deliveredPublicAssets = new Set<string>();
  let completedPublicAssetRequestsOverflow = false;
  const recordCompletedPublicAsset = (url: string, resourceType: string, status: number) => {
    if (completedPublicAssetRequestsOverflow || !["script", "stylesheet"].includes(resourceType) ||
        status < 200 || status >= 300 || !isSafeBrowserAssetUrl(url, resourceType, "GET")) return;
    const key = JSON.stringify([url, resourceType]);
    if (completedPublicAssets.has(key)) return;
    const value = { url, method: "GET" as const, resourceType: resourceType as "script" | "stylesheet", status };
    if (completedPublicAssets.size >= 128 || Buffer.byteLength(JSON.stringify([...completedPublicAssets.values(), value]), "utf8") > 64_000) {
      completedPublicAssetRequestsOverflow = true; return;
    }
    completedPublicAssets.set(key, value);
  };
  const requestFailures: NonNullable<DiscoveryBrowserSnapshot["requestFailures"]> = [];
  const capabilityDiagnostics: NonNullable<DiscoveryBrowserSnapshot["capabilityDiagnostics"]> = [];
  const recordSubframe = ({ url, resourceType }: { url: string; resourceType: string }) => {
    const safeUrl = redactDiscoveryFailureUrl(canonicalCpsPublicUrl(url), resourceType);
    capabilityDiagnostics.push({ code: "SUBFRAME_UNSUPPORTED", resourceType, ...(safeUrl ? { url: safeUrl } : {}) });
    if (capabilityDiagnostics.length > 12) capabilityDiagnostics.shift();
  };
  const pendingRequestMetadata = new Set<DiscoveryBrowserSnapshot["requests"][number]>();
  let requestMetadataBytes = 0;
  const recordRequest = (metadata: DiscoveryBrowserSnapshot["requests"][number], priority = false) => {
    if ((!isSafeRecipeUrl(metadata.url) && !isSafeBrowserAssetUrl(metadata.url, metadata.resourceType, metadata.method) &&
        !isSafeBrowserBootstrapReadUrl(metadata.url, metadata.resourceType, metadata.method) &&
        !isSafeBrowserAvailabilityReadUrl(metadata.url, metadata.resourceType, metadata.method)) || observedRequests.includes(metadata)) return;
    const size = JSON.stringify(metadata).length + 120;
    if (priority) {
      while (observedRequests.length && (observedRequests.length >= 80 || requestMetadataBytes + size > 10_000)) {
        const index = observedRequests.findIndex(row => !["xhr", "fetch", "document"].includes(row.resourceType) && !row.blockedReason);
        if (index < 0) break;
        observedRequests.splice(index, 1);
        requestMetadataBytes = observedRequests.reduce((total, row) => total + JSON.stringify(row).length + 120, 0);
      }
    }
    if (observedRequests.length < 80 && requestMetadataBytes + size <= 10_000) {
      observedRequests.push(metadata); requestMetadataBytes += size;
    }
  };
  const controls = new Map<string, { locator: Locator; signature: string; kind: string; href?: string; documentNavigationOnly?: boolean; calendarDay?: string; dropdown?: PublicDropdownProof; menuButton?: PublicMenuButtonProof; catalogTile?: boolean;
    service?: boolean; serviceContinuation?: PublicServiceContinuationMode; datePicker?: PublicDatePickerInputProof }>();
  let serviceSelection: PublicRentalServiceSelection | undefined;
  const observedElements = new Map<string, { locator: Locator; signature: string }>();
  let closed = false, requestCount = 0, interceptCount = 0, responseBytes = 0, blockedRequests = 0, pendingRequests = 0, actions = 0, observations = 0;
  const admittedRequestCounts: Record<string, number> = Object.create(null);
  // Native CDP owns every guarded read and its response capture. Its pending
  // work may outlive handleRoute; pinned HTTP uses the local handler count.
  const pendingReadCount = () => Math.max(pendingRequests, redirectRouting?.pendingReads ?? 0);
  let terminalFailure: string | undefined;
  const sharedInterceptAllowed = () => {
    try { if (deps.delegatedReadBudget) chargeDelegatedReadBudget(deps.delegatedReadBudget, "intercepts"); return true; }
    catch { terminalFailure = "PUBLIC_READ_REQUEST_LIMIT"; return false; }
  };
  let navigation: { url: string; status: number } | undefined;
  let navigationStartedAt: number | undefined;
  let ezDocument: EzLinksDocumentWitness | undefined, ezControllerRead: EzLinksControllerRead | undefined;
  let ezConfigurationRead: { document: EzLinksDocumentWitness; token: EzLinksDocumentToken; version: number } | undefined;
  let ezReadContractRead: { document: EzLinksDocumentWitness; token: EzLinksDocumentToken; version: number } | undefined;
  const ezReadNonces = new Set<string>();
  const modelSafe = <T>(value: T): T => {
    if (!ezReadNonces.size) return value;
    let json = JSON.stringify(value);
    for (const nonce of ezReadNonces) json = json.replaceAll(nonce, "[private-read-id]");
    const safe = JSON.parse(json) as T;
    // Private completed metadata is never model input and must retain its
    // exact observed URL through this public-response nonce sanitizer.
    if (value && typeof value === "object" && safe && typeof safe === "object") {
      for (const key of ["completedPublicAssetRequests", "completedPublicAssetRequestsOverflow", "nativeDocumentRedirects"] as const)
        if (Object.hasOwn(value, key)) Object.assign(safe, { [key]: (value as Record<string, unknown>)[key] });
    }
    return safe;
  };
  const clearEzDocument = () => {
    if (ezControllerRead) ezControllerRead.error = new Error("EZLINKS_DOCUMENT_CHANGED");
    ezControllerRead = undefined; ezConfigurationRead = undefined; ezReadContractRead = undefined; ezDocument = undefined;
    ezlinks.observeDocument("", 0);
  };
  const assertEzReadContract = (witness: EzLinksDocumentWitness | undefined, version: number | undefined) => {
    if (version !== undefined && (!witness || witness !== ezDocument || witness.token !== ezlinks.currentDocument() ||
        witness.readContractFailed || witness.readContractVersion !== version)) throw new Error("EZLINKS_READ_CONTRACT_UNVERIFIED");
  };
  const completedEzReadAssets = (witness: EzLinksDocumentWitness) => !witness.readContractFailed && ezLinksReadContractAssets.every(asset => {
    const read = witness.readContractAssets.get(asset.path);
    return read?.complete && read.sha256 === asset.sha256;
  });
  let closing: Promise<void> | undefined, cleanupFailed = false;
  const close = () => closing ??= (async () => {
    closed = true; completedPublicAssets.clear(); deliveredPublicAssets.clear(); teeBookingScope.close(); clearEzDocument();
    try { await redirectRouting?.close(); } catch { cleanupFailed = true; }
    cancellation.abort("BROWSER_CLOSED"); queue.dispose();
    // Preserve the existing context -> browser -> proxy teardown order while
    // ensuring one failed close cannot prevent the remaining drains.
    try { await context.close(); } catch { cleanupFailed = true; }
    try { await browser.close(); } catch { cleanupFailed = true; }
    try { await nativeProxy?.close(); } catch { cleanupFailed = true; }
    if (deps.delegatedReadBudget && nativeProxy) {
      try { settleDelegatedProxyBudget(deps.delegatedReadBudget, nativeProxy.stats()); } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) throw new Error("DISCOVERY_BROWSER_CLEANUP_FAILED");
  })();
  const abort = () => { void close().catch(() => {}); };
  deadline.addEventListener("abort", abort, { once: true });
  page.on("popup", popup => { void popup.close(); });
  context.on("page", opened => { if (opened !== page) void opened.close(); });
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) { teeBookingScope.checkCurrentDocument(frame.url()); catalogTiles.checkDocument(frame.url()); } });
  const waitEz = async (ready: () => boolean, code: string, durationMs = 5_000) => {
    const until = Math.min(Date.now() + durationMs, input.deadlineAt.getTime());
    for (;;) {
      deadline.throwIfAborted();
      if (terminalFailure) throw new Error(terminalFailure);
      if (closed) throw new Error("BROWSER_CLOSED");
      if (ready()) return;
      if (Date.now() >= until) throw new Error(code);
      await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, until - Date.now()))));
    }
  };
  const mindbodySources = initialUrls.filter(value => parseMindbodyAppointmentSource(value));
  const mindbodyCapture = createMindbodyAppointmentNativeCapture({ page, native: Boolean(nativeProxy), requestedInput,
    ...(mindbodySources.length === 1 && input.venueOfficialUrl && input.venueName && input.venueAddress && input.timeZone ? { source: {
      officialUrl: input.venueOfficialUrl, bookingUrl: mindbodySources[0], venueName: input.venueName, venueAddress: input.venueAddress, timeZone: input.timeZone } } : {}),
    deadlineAt: input.deadlineAt.getTime(), pendingReads: pendingReadCount,
    assertActive: () => { deadline.throwIfAborted(); if (closed) throw new Error("BROWSER_CLOSED"); if (terminalFailure) throw new Error(terminalFailure); } });
  // Dispose private provider HTML/tokens even when the ordinary session closes
  // before a fixed reader is entered. Neither is returned by snapshots.
  deadline.addEventListener("abort", () => mindbodyCapture.close(), { once: true });
  const handleRoute = async (route: NativeReadRoute) => {
    const request = route.request();
    const transportUrl = canonicalPublicReadUrl(request.url(), request.method());
    const requestUrl = canonicalCpsPublicUrl(transportUrl);
    // Denied media/telemetry never spends the public-read budget. A separate
    // hard interception cap still bounds hostile pages that emit rejected work.
    if (++interceptCount > 1024 || !sharedInterceptAllowed()) { await route.abort().catch(() => {}); void close().catch(() => {}); return; }
    if (isIncidentalBrowserRequest(request.url()) || isNonEvidenceBrowserResource(request.url(), request.resourceType())) { await route.abort(); return; }
    pendingRequests++;
    const metadata: DiscoveryBrowserSnapshot["requests"][number] = {
      url: redactDiscoveryRequestUrl(requestUrl), method: request.method(), resourceType: request.resourceType(),
    };
    recordRequest(metadata, ["xhr", "fetch", "document"].includes(metadata.resourceType));
    pendingRequestMetadata.add(metadata);
    let ezWitness: EzLinksDocumentWitness | undefined, ezToken: EzLinksDocumentToken | undefined, ezCall: EzLinksControllerRead | undefined;
    let ezAsset: typeof ezLinksReadContractAssets[number] | undefined, ezAssetRead: { complete: boolean; sha256?: string } | undefined;
    let ezInitRequest = false;
    let teeRequestToken: TeeItUpSourceRequestToken | undefined;
    let mindbodyDocumentVersion: number | undefined;
    let catalogDocument: ReturnType<typeof catalogTiles.beginDocument>;
    let catalogRead: ReturnType<typeof catalogTiles.beginRead>;
    try {
      deadline.throwIfAborted();
      if (new URL(requestUrl).pathname.toLowerCase() === "/asp/appt_req.asp") throw new Error("MINDBODY_APPOINTMENT_TRANSACTION_DENIED");
      if (request.frame().page() !== page) throw new Error("UNSUPPORTED_BROWSER_PAGE");
      redirectRouting?.prepare(request.frame());
      if (!cpsScope.authorize(transportUrl, request.redirectedFrom()?.url())) throw new Error("UNOBSERVED_CPS_SESSION");
      if (cpsSessionKey(transportUrl) && !nativeProxy) throw new Error("CPS_NATIVE_BROWSER_REQUIRED");
      const method = request.method(), requestHeaders = request.headers();
      const publicHeaderProof = nativeProxy && (method === "OPTIONS" || Object.keys(requestHeaders).some(key => /^(?:authorization|x-api-key)$/iu.test(key)))
        ? await authorizePublicClientReadHeaders(request) : null;
      const ordinaryPreflightMethod = nativeProxy && method === "OPTIONS" ? nativeReadPreflightMethod(requestHeaders) : null;
      const preflight = nativeProxy && method === "OPTIONS" && (ordinaryPreflightMethod ||
        publicHeaderProof && nativePublicClientPreflightMethod(request, publicHeaderProof));
      // The native router separately correlates the browser's GET preflight
      // with its initiating root-frame data read. Validate only that read's
      // purpose here; wire method and diagnostic resource kind stay original.
      const bootstrapMethod = preflight === "GET" ? "GET" : method;
      const bootstrapKind = preflight === "GET" ? "fetch" : request.resourceType();
      const bootstrapRead = isSafeBrowserBootstrapReadUrl(requestUrl, bootstrapKind, bootstrapMethod);
      const availabilityRead = isSafeBrowserAvailabilityReadUrl(requestUrl, preflight ? "fetch" : request.resourceType(), preflight || method);
      if (bootstrapRead) metadata.readPurpose = "PUBLIC_BOOTSTRAP";
      else if (availabilityRead) metadata.readPurpose = "PUBLIC_AVAILABILITY";
      const parent = request.redirectedFrom();
      if (parent && isSafeBrowserBootstrapReadUrl(parent.url(), parent.resourceType(), parent.method())) throw new Error("UNSAFE_REDIRECT");
      if (!isSafeRecipeUrl(requestUrl) && !isSafeBrowserAssetUrl(requestUrl, request.resourceType(), method) && !bootstrapRead &&
          !availabilityRead) {
        metadata.urlRejection = describePublicUrlRejection(request.url(), requestUrl, request.method(), request.resourceType(), "BROWSER_REQUEST_URL",
          { recipe: isSafeRecipeUrl, asset: isSafeBrowserAssetUrl });
        throw new Error("UNSAFE_URL");
      }
      const url = new URL(requestUrl);
      if (request.frame() === page.mainFrame() && ["xhr", "fetch"].includes(request.resourceType()))
        catalogRead = catalogTiles.beginRead(requestUrl, request.method(), request.postData(), request.frame().url());
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        delegatedIdentityDocument = undefined; delegatedIdentityPage = undefined;
        nativeDocumentRedirects = undefined;
        mindbodyCapture.assertNavigation(url.href, method);
        mindbodyDocumentVersion = mindbodyCapture.beginDocument();
        catalogDocument = catalogTiles.beginDocument(requestUrl);
        officialSourceDiagnostic = undefined;
        teeRequestToken = nativeProxy ? teeBookingScope.beginMainDocument(request, { url: request.url(), method: request.method(), parent: request.redirectedFrom() ?? undefined }) : undefined;
        teeDocumentToken = teeRequestToken;
        const priorOfficial = bookingParents.authorizeParent(request.url());
        bookingParents.beginDocument(request.url());
        if (priorOfficial?.kind === "VERIFIED_OFFICIAL_DOCUMENT" || input.venueOfficialUrl && url.origin === new URL(input.venueOfficialUrl).origin ||
            officialIdentityDocument && sameDiscoveryMainDocument(officialIdentityDocument.url, url.href)) {
          officialIdentityDocument = undefined; officialIdentityPage = undefined;
        }
        if (nativeProxy && request.redirectedFrom()) {
          if (!cpsSessionKey(transportUrl) && !isObservedNativeRedirect(request, observedNavigationRoots)) throw new Error("UNSAFE_REDIRECT");
          allowedNavigation.add(url.href);
        }
        if (!allowedNavigation.has(url.href) && !navigationOrigins.has(url.origin)) throw new Error("UNOBSERVED_NAVIGATION");
        clearEzDocument();
        if (ezlinks.handles(url)) ezDocument = { url: url.href, settled: false, initVersion: 0, pendingInit: 0, initAttempted: false,
          readContractAssets: new Map(), readContractFailed: false, readContractVersion: 0 };
      }
      // Capture the exact initiating document, not whatever document happens
      // to be current after an init/response acknowledgement resumes JS.
      ezWitness = ezDocument;
      if (ezWitness && request.frame() === page.mainFrame() && request.resourceType() === "script" && url.origin === new URL(ezWitness.url).origin) {
        ezAsset = ezLinksReadContractAssets.find(asset => url.href === new URL(asset.path, ezWitness!.url).href);
        if (ezAsset) {
          ezAssetRead = { complete: false };
          ezWitness.readContractAssets.set(ezAsset.path, ezAssetRead); ezWitness.readContractVersion++;
        }
      }
      ezInitRequest = Boolean(ezWitness && url.origin === new URL(ezWitness.url).origin && url.pathname === "/api/search/init" && method === "GET");
      if (ezInitRequest) {
        ezWitness!.initAttempted = true;
        ezWitness!.pendingInit++;
        await waitEz(() => ezWitness !== ezDocument || ezWitness!.settled, "EZLINKS_CONFIGURATION_UNAVAILABLE");
        if (ezWitness !== ezDocument || !ezWitness?.token) throw new Error("EZLINKS_DOCUMENT_CHANGED");
      }
      if (ezWitness && method === "POST" && ezlinks.handles(url) && ezWitness.pendingInit > 0)
        await waitEz(() => ezWitness !== ezDocument || ezWitness!.init !== undefined || ezWitness!.pendingInit === 0, "EZLINKS_CONFIGURATION_UNAVAILABLE");
      ezToken = ezWitness?.token;
      // Public widgets may select a resource with history.replaceState before
      // issuing its read. Bind only the URL actually observed in this frame.
      const frameUrl = request.frame().url();
      if (isSafeRecipeUrl(frameUrl)) passfactory.observeWidgetUrl(frameUrl);
      const headers = new Headers();
      const body = request.postData() ?? undefined;
      const mindbodySource = nativeProxy ? nativeMindbodyBootstrapSource(request) : null;
      const mindbodyForm = nativeProxy ? nativeMindbodyControllerForm(request) : null;
      const assertMindbodyBootstrapRead = () => {
        if (mindbodySource && (nativeMindbodyBootstrapSource(request) !== mindbodySource || method !== "POST" || !body ||
            !isMindbodyClassicPublicBootstrapPost(url, new Headers(requestHeaders), body, mindbodySource.sourceUrl)))
          throw new Error("MINDBODY_BOOTSTRAP_READ_REJECTED");
        if (mindbodyForm && (nativeMindbodyControllerForm(request) !== mindbodyForm || method !== "POST" || !body ||
            !mindbodyForm.matches(body, requestHeaders["content-type"] ?? ""))) throw new Error("MINDBODY_PUBLIC_FORM_REJECTED");
      };
      // The source document intentionally retired during the native ownership
      // transfer. Only its immutable, privately attested successor metadata
      // can bind this independently checked public bootstrap schema.
      assertMindbodyBootstrapRead();
      if (nativeProxy && isRexNamespace(url) && method === "POST" &&
          !isRexPublicBrowserReadPost(url, method, requestHeaders, body ?? "", frameUrl))
        throw new Error(rexPublicBrowserReadRejection(url, method, requestHeaders, body ?? "", frameUrl));
      const rexPlaceholder = nativeProxy && isRexAnonymousPlaceholderRead(url, method, requestHeaders, body ?? "", frameUrl);
      if (nativeProxy && !rexPlaceholder && !publicHeaderProof && Object.keys(requestHeaders).some(key => /^(?:authorization|proxy-authorization|x-api-key)$/iu.test(key))) {
        metadata.publicHeaderDiagnostic = publicHeaderFailureDiagnostic("HEADER_PROOF_MISSING", method, requestHeaders, ordinaryPreflightMethod);
        throw new Error("CREDENTIAL_HEADERS");
      }
      if (ezlinks.handles(url) && Object.keys(requestHeaders).some(key =>
        !(nativeProxy && key.toLowerCase() === "cookie") && /authorization|cookie|token|api.?key|secret|credential|next-action|csrf|session/iu.test(key)))
        throw new Error("CREDENTIAL_HEADERS");
      for (const key of ["accept", "content-type", "origin"]) if (requestHeaders[key]) headers.set(key, requestHeaders[key]);
      const controllerNonce = requestHeaders[ezLinksReadHeader];
      if (controllerNonce !== undefined) {
        ezCall = ezControllerRead;
        if (!ezCall || ezCall.seen || controllerNonce !== ezCall.nonce || ezCall.document !== ezWitness || ezWitness !== ezDocument ||
            ezCall.token !== ezToken || ezCall.version !== ezWitness?.initVersion || ezCall.url !== url.href || ezCall.method !== method || ezCall.body !== body)
          throw new Error("EZLINKS_PUBLIC_READ_REJECTED");
        ezCall.seen = true;
        assertEzReadContract(ezWitness, ezCall.contractVersion);
      }
      if (!addVerifiedMindbodyReadHeaders(url, method, requestHeaders, headers, body ?? "")) throw new Error("UNSAFE_METHOD");
      if (!uschedule.addReadHeaders(url, method, requestHeaders, headers, body ?? "")) throw new Error("UNSAFE_METHOD");
      if (!["GET", "HEAD"].includes(method) && !preflight && !(method === "POST" && body && (readPost(url, headers, body) ||
          nativeProxy && mindbodySource ||
          nativeProxy && mindbodyForm ||
          nativeProxy && publicHeaderProof && isMemberSportsPublicTeeSheetPost(url, headers, body, frameUrl))))
        throw new Error(!nativeProxy && method === "POST" && isRexNamespace(url) ? rexProjectedPublicReadRejection(url, headers, body ?? "", frameUrl) : "UNSAFE_METHOD");
      if (method === "POST" && body) {
        try {
          const projected = redactDiscoveryJson(JSON.parse(body));
          const bodySize = JSON.stringify(projected).length + 16;
          if (bodySize <= 8192 && observedRequests.includes(metadata) && requestMetadataBytes + bodySize <= 10_000) {
            metadata.body = projected; requestMetadataBytes += bodySize;
          }
        } catch { /* Non-JSON public reads remain opaque; never return raw text. */ }
      }
      assertPublicBrowserRequestBudget(requestCount, requestLimit);
      if (deps.delegatedReadBudget) chargeDelegatedReadBudget(deps.delegatedReadBudget, "requests");
      if (responseBytes >= PUBLIC_BROWSER_TOTAL_BYTES) throw new Error("PUBLIC_READ_BYTE_LIMIT");
      requestCount++;
      admittedRequestCounts[request.resourceType()] = (admittedRequestCounts[request.resourceType()] ?? 0) + 1;
      const responseLimit = publicBrowserResponseLimit(request.resourceType());
      const reply = await queue.run(requestFamilyForUrl(url.href), async () => {
        assertMindbodyBootstrapRead();
        // A same-document script read can retire the completion contract while
        // this exact POST waits for the shared provider lease.
        assertEzReadContract(ezWitness, ezCall?.contractVersion);
        if (publicHeaderProof && !isCurrentPublicClientReadHeaders(publicHeaderProof)) {
          metadata.publicHeaderDiagnostic = publicHeaderFailureDiagnostic("HEADER_PROOF_REVOKED_AFTER_QUEUE", method, requestHeaders, ordinaryPreflightMethod,
            publicClientReadHeaderProofFailure(publicHeaderProof));
          throw new Error("CREDENTIAL_HEADERS");
        }
        if (nativeProxy) {
          nativeProxy.allowHostConnections(url.hostname);
          const response = await continueNativeBrowserRead(route, deadline, responseLimit, async () => {
            await nativeProxy.cancelHostConnections(url.hostname);
          }, transportUrl);
          return { status: response.status, headers: response.headers, buffer: response.body };
        }
        const transport = deps.fetch ?? createAddressPinnedPublicFetchTransport({
          parseUrl: value => {
            if (!isSafeRecipeUrl(value) && !isSafeBrowserAssetUrl(value, request.resourceType(), method) &&
                !isSafeBrowserBootstrapReadUrl(value, request.resourceType(), method) && !isSafeBrowserAvailabilityReadUrl(value, request.resourceType(), method)) {
              metadata.urlRejection = describePublicUrlRejection(value, value, method, request.resourceType(), "PINNED_TRANSPORT_URL",
                { recipe: isSafeRecipeUrl, asset: isSafeBrowserAssetUrl });
              throw new Error("UNSAFE_URL");
            }
            return new URL(value);
          },
          maxResponseBytes: responseLimit, timeoutMs: 15_000, redirectLimit: 0, authorizeReadPost: readPost,
        });
        const response = await transport(url, { method, headers, body, credentials: "omit", redirect: "manual", signal: deadline });
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > responseLimit) throw new Error("BODY_LIMIT");
        return { status: response.status, headers: Object.fromEntries(response.headers), buffer };
      }, request.signal);
      if (request.signal?.aborted) {
        // A fully captured old response still spends the cumulative byte
        // budget, but a retired document cannot publish evidence/authority.
        responseBytes += reply.buffer.length;
        if (responseBytes > PUBLIC_BROWSER_TOTAL_BYTES) throw new Error("PUBLIC_READ_BYTE_LIMIT");
        return;
      }
      metadata.status = reply.status;
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        if (mindbodyDocumentVersion !== undefined) mindbodyCapture.completeDocument(mindbodyDocumentVersion, url.href,
          reply.status, reply.headers["content-type"] ?? "", reply.buffer);
        catalogTiles.completeDocument(catalogDocument, reply.status, reply.headers["content-type"] ?? "");
        if (teeRequestToken) teeBookingScope.completeMainDocument(teeRequestToken, { status: reply.status,
          location: reply.headers.location, contentType: reply.headers["content-type"] });
        navigation = { url: request.url(), status: reply.status };
        // Only actual main-document response/redirect metadata can establish
        // parent provenance; model navigation arguments and XHRs cannot.
        bookingParents.observeDocument({ url: request.url(), status: reply.status, redirectedFrom: request.redirectedFrom()?.url(),
          ...(nativeProxy ? { nativeRequest: request } : {}) });
        if (nativeProxy && input.venueOfficialUrl && attestedNativeDocumentRedirects(request, new Set([input.venueOfficialUrl])))
          nativeDocumentRedirects = { url: request.url(), request };
        if (ezWitness === ezDocument && ezWitness) {
          ezWitness.status = reply.status; ezWitness.settled = true; ezWitness.observedAt = Date.now();
          ezWitness.token = /^text\/html(?:;|$)/iu.test(reply.headers["content-type"] ?? "") ? ezlinks.observeDocument(url, reply.status) : undefined;
        }
      }
      // Retain only the bounded, successfully read official document. Its raw
      // semantic markup is reproducible on warm reads; page.content() contains
      // transient browser mutations and must not define the saved witness.
      const officialDocumentProof = bookingParents.authorizeParent(url.href);
      if (deps.captureDelegatedDocument && nativeProxy && request.method() === "GET" && request.isNavigationRequest() && request.frame() === page.mainFrame() &&
          reply.status === 200 && reply.buffer.length <= 600_000 && /^text\/html(?:;|$)/iu.test(reply.headers["content-type"] ?? ""))
        delegatedIdentityDocument = { url: url.href, html: reply.buffer.toString("utf8") };
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && officialDocumentProof?.kind === "VERIFIED_OFFICIAL_DOCUMENT" &&
          reply.status === 200 &&
          reply.buffer.length <= 600_000 && /^text\/html(?:;|$)/iu.test(reply.headers["content-type"] ?? ""))
        officialIdentityDocument = { url: url.href, html: reply.buffer.toString("utf8"), officialDocumentProof };
      if (["GET", "HEAD"].includes(method) && request.isNavigationRequest() && request.resourceType() === "document" &&
          reply.status >= 200 && reply.status < 400 && isSafeRecipeUrl(url.href)) allowedNavigation.add(url.href);
      responseBytes += reply.buffer.length;
      if (deps.delegatedReadBudget) chargeDelegatedReadBudget(deps.delegatedReadBudget, "bytes", reply.buffer.length);
      if (isUSchedulePublicHost(url.hostname) && method === "GET" && /^text\/html(?:;|$)/iu.test(reply.headers["content-type"] ?? ""))
        uschedule.observeResponse(url.href, method, reply.status, reply.headers["content-type"] ?? "", reply.buffer.toString("utf8"));
      if (responseBytes > PUBLIC_BROWSER_TOTAL_BYTES) { cancellation.abort("PUBLIC_READ_BYTE_LIMIT"); throw new Error("PUBLIC_READ_BYTE_LIMIT"); }
      catalogTiles.completeRead(catalogRead, reply.status, reply.headers["content-type"] ?? "", reply.buffer);
      if (ezAsset && ezAssetRead && ezWitness === ezDocument) {
        // Chrome can start a script after the HTML response ACK but before the
        // main handler publishes its token. Wait only after queue.run released
        // the provider lease, and bind to the initiating document object.
        await waitEz(() => ezWitness !== ezDocument || ezWitness!.settled, "EZLINKS_READ_CONTRACT_UNVERIFIED");
        if (ezWitness !== ezDocument || !ezWitness?.token || ezWitness.token !== ezlinks.currentDocument())
          throw new Error("EZLINKS_READ_CONTRACT_UNVERIFIED");
        const directCompleteScript = nativeProxy && request.frame() === page.mainFrame() && method === "GET" && !request.redirectedFrom() && transportUrl === url.href &&
          reply.status === 200 && /^(?:text|application)\/(?:javascript|ecmascript)(?:\s*;|$)/iu.test(reply.headers["content-type"] ?? "");
        const digest = directCompleteScript ? createHash("sha256").update(reply.buffer).digest("hex") : undefined;
        ezAssetRead.complete = true; ezWitness.readContractVersion++;
        if (digest !== ezAsset.sha256) ezWitness.readContractFailed = true;
        else ezAssetRead.sha256 = digest;
      }
      if (ezInitRequest || ezCall) {
        if (ezWitness !== ezDocument || !ezToken || ezToken !== ezlinks.currentDocument()) throw new Error("EZLINKS_DOCUMENT_CHANGED");
        const json = reply.status === 200 && /^application\/json(?:\s*;\s*charset\s*=\s*utf-?8)?$/iu.test(reply.headers["content-type"] ?? "") && reply.buffer.length <= 600_000;
        let raw: unknown;
        try { if (json) raw = JSON.parse(reply.buffer.toString("utf8")); } catch { /* Invalid JSON is never controller proof. */ }
        if (ezInitRequest) {
          ezWitness!.init = undefined; ezWitness!.initVersion++;
          const valid = ezlinks.observeResponse(url, method, reply.status, reply.headers["content-type"] ?? "", raw, ezToken);
          if (valid && json && raw !== undefined) { ezWitness!.init = raw; ezWitness!.initAt = Date.now(); }
          if (ezControllerRead && ezControllerRead !== ezCall) ezControllerRead.error = new Error("EZLINKS_DOCUMENT_CHANGED");
        }
        if (ezCall) {
          if (ezCall !== ezControllerRead || ezCall.document !== ezDocument || ezCall.token !== ezToken ||
              (!ezInitRequest && ezCall.version !== ezWitness!.initVersion)) throw new Error("EZLINKS_DOCUMENT_CHANGED");
          if (!json || raw === undefined || ezInitRequest && ezWitness!.init === undefined) throw new Error("EZLINKS_PUBLIC_READ_FAILED");
          assertEzReadContract(ezWitness, ezCall.contractVersion);
          ezCall.result = raw; ezCall.complete = true;
        }
      }
      const responseHeaders: Record<string, string> = {};
      for (const key of ["content-type", "access-control-allow-origin"]) { const value = reply.headers[key]; if (value) responseHeaders[key] = value; }
      const redirect = reply.headers.location;
      if (redirect) {
        // These exact public setup contracts are direct GETs. A Location must
        // not promote ancillary data into navigation or inventory authority.
        if (bootstrapRead) throw new Error("UNSAFE_REDIRECT");
        // Chromium skips Playwright's route handler for redirected requests.
        // Pinned HTTP must not release a Location into an unpinned browser read.
        if (!nativeProxy) throw new Error("PINNED_REDIRECT_UNSUPPORTED");
        const nextTransport = new URL(redirect, transportUrl);
        // A native CPS landing may mint a new anonymous session in Location.
        // Admit only this context's proved same-course redirect; persist and
        // expose its canonical URL, never the transport's session segment.
        if (!cpsScope.authorize(nextTransport.href, transportUrl) || cpsSessionKey(nextTransport.href) && !nativeProxy)
          throw new Error("UNSAFE_REDIRECT");
        const next = new URL(canonicalCpsPublicUrl(nextTransport.href));
        const sameHost = next.hostname.replace(/^www\./u, "") === url.hostname.replace(/^www\./u, "");
        const observedDocumentRedirect = request.isNavigationRequest() && request.frame() === page.mainFrame() &&
          isObservedNativeRedirectTarget(request, nextTransport.href, observedNavigationRoots);
        // Only the controller's exact anonymous bootstrap POST can attest its
        // released 302/303 to a same-origin bodyless GET. Other POSTs still fail.
        if (method === "POST" && !(nativeProxy && mindbodySource && observedDocumentRedirect) ||
            !isSafeRecipeUrl(next.href) || !sameHost && !observedDocumentRedirect) throw new Error("UNSAFE_REDIRECT");
        responseHeaders.location = next.href;
        allowedNavigation.add(next.href);
      }
      // Setup responses let the public page initialize, but never supply
      // model-visible inventory bodies, schemas, or availability authority.
      if (!bootstrapRead && responses.length < 12 && /application\/(?:[a-z0-9.+-]*\+)?json/iu.test(responseHeaders["content-type"] ?? "") && ["xhr", "fetch"].includes(request.resourceType())) {
        if (ezlinks.handles(url) && url.pathname === "/api/search/search") {
          // r01 is the provider's IDToken, not durable slot identity. The
          // controller keeps raw listing JSON privately; model snapshots get
          // neither its values nor schema examples that could repeat them.
          responses.push({ url: redactDiscoveryRequestUrl(url.href), status: reply.status, method, bodyOmitted: true, schemaEvidenceOmitted: true });
        } else {
        try {
          const original: unknown = JSON.parse(reply.buffer.toString("utf8"));
          const projected = redactDiscoveryJson(original);
          const schemaEvidence = publicResponseSchema(original);
          const schemaBytes = responses.reduce((total, response) => total + (response.schemaEvidence ? JSON.stringify(response.schemaEvidence).length : 0), 0);
          responses.push({ url: redactDiscoveryRequestUrl(url.href), status: reply.status, method,
            ...(JSON.stringify(projected).length < 28_000 ? { body: projected } : { bodyOmitted: true as const }),
            ...(schemaBytes + JSON.stringify(schemaEvidence).length <= 24_000 ? { schemaEvidence } : { schemaEvidenceOmitted: true as const }) });
        } catch { /* Invalid JSON is not evidence. */ }
        }
      }
      if (!nativeProxy) await route.fulfill({ status: reply.status, headers: responseHeaders, body: reply.buffer });
      if (!closed && !request.signal?.aborted && method === "GET" && !request.redirectedFrom() && !redirect)
        recordCompletedPublicAsset(url.href, request.resourceType(), reply.status);
    } catch (error) {
      if (teeRequestToken) teeBookingScope.invalidate();
      if (ezAssetRead && ezWitness === ezDocument && ezWitness) {
        ezAssetRead.complete = true; ezWitness.readContractFailed = true; ezWitness.readContractVersion++;
      }
      if (ezCall && ezCall === ezControllerRead) ezCall.error = new Error(isNativeReadSupersededFailure(error) ? "EZLINKS_DOCUMENT_CHANGED" :
        error instanceof Error && error.message === "EZLINKS_READ_CONTRACT_UNVERIFIED" ? error.message : "EZLINKS_PUBLIC_READ_FAILED");
      if (isNativeReadSupersededFailure(error)) return;
      blockedRequests++;
      metadata.blockedReason = error instanceof Error && /^[A-Z_]{1,80}$/u.test(error.message) ? error.message : "REQUEST_FAILED";
      const failureUrl = redactDiscoveryFailureUrl(requestUrl, request.resourceType());
      if (metadata.urlRejection) metadata.url = failureUrl ?? "";
      requestFailures.push({ reason: metadata.blockedReason, resourceType: request.resourceType(), method: request.method(),
        ...(failureUrl ? { url: failureUrl } : {}), ...(metadata.urlRejection ? { urlRejection: safePublicUrlRejectionDiagnostic(metadata.urlRejection) } : {}),
        ...(metadata.publicHeaderDiagnostic ? { publicHeaderDiagnostic: { ...metadata.publicHeaderDiagnostic } } : {}) });
      if (requestFailures.length > 12) requestFailures.shift();
      deps.onRequestFailure?.({ url: metadata.url, resourceType: metadata.resourceType, reason: metadata.blockedReason });
      recordRequest(metadata, true);
      await route.abort().catch(() => {});
    }
    finally { if (ezInitRequest && ezWitness) ezWitness.pendingInit--; pendingRequests--; pendingRequestMetadata.delete(metadata); }
  };
  await context.route("**/*", async route => {
    if (route.request().frame() !== page.mainFrame()) {
      if (++interceptCount > 1024 || !sharedInterceptAllowed()) { await route.abort().catch(() => {}); void close().catch(() => {}); return; }
      recordSubframe({ url: route.request().url(), resourceType: route.request().resourceType() });
      await route.abort().catch(() => {});
      return;
    }
    try {
      if (nativeProxy) {
        if (!redirectRouting) throw new Error("NATIVE_REDIRECT_UNAVAILABLE");
        // The sole CDP request handler already owns policy, leases and source
        // evidence. Release only Playwright's independent pause here.
        await redirectRouting.releasePlaywrightRoute(route);
      } else await handleRoute(route);
    }
    catch (error) {
      blockedRequests++;
      const reason = error instanceof Error && /^[A-Z_]{1,80}$/u.test(error.message) ? error.message : "NATIVE_REDIRECT_ROUTING_FAILED";
      terminalFailure = reason;
      requestFailures.push({ reason, resourceType: route.request().resourceType() });
      if (requestFailures.length > 12) requestFailures.shift();
      await route.abort().catch(() => {});
      void close().catch(() => {});
    }
  });
  if (nativeProxy) {
    try {
      redirectRouting = await installNativeRedirectRouting(page, handleRoute, {
        signal: deadline, maxRequests: 1024,
        controllerFormIntent: (sourceUrl, targetUrl) => mindbodyCapture.formIntent(sourceUrl, targetUrl),
        onSubframeBlocked: recordSubframe,
        onRequestRejected: request => {
          blockedRequests++;
          const resourceType = request.resourceType ?? "other";
          requestFailures.push({ reason: request.code, resourceType, ...(request.url ? { url: request.url } : {}) });
          if (requestFailures.length > 12) requestFailures.shift();
          deps.onRequestFailure?.({ reason: request.code, resourceType, url: request.url ?? "" });
        },
        onFailure: reason => {
          if (closed) return;
          teeBookingScope.invalidate();
          catalogTiles.beginDocument("about:blank");
          terminalFailure = reason;
          blockedRequests++;
          // A controller-wide failure is not proof that a document caused it.
          // The first-fatal/rejection projections retain actual request kinds.
          requestFailures.push({ reason, resourceType: redirectRouting?.firstFatal?.resourceType ?? "other" });
          if (requestFailures.length > 12) requestFailures.shift();
        },
      });
    } catch (error) { await close(); throw error; }
  }

  const observeControl = (locator: Locator): Promise<ObservedControl> => locator.evaluate(element => {
    const node = element as HTMLElement;
    const field = element as HTMLInputElement;
    // Object methods remain self-contained when tsx preserves function names.
    // Assigned nested arrow functions would capture its module-only __name helper.
    const selectors = {
      quote(value: string) { return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"'); },
      for(target: Element): string {
        if (target.id && document.querySelectorAll(`[id="${this.quote(target.id)}"]`).length === 1) return `[id="${this.quote(target.id)}"]`;
        const path: string[] = [];
        let current: Element | null = target;
        while (current && current.tagName !== "BODY" && path.length < 12) {
          const tag = current.tagName.toLowerCase();
          const siblings = current.parentElement ? Array.from(current.parentElement.children).filter(child => child.tagName === current!.tagName) : [current];
          path.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
          const candidate = path.join(" > ");
          if (document.querySelectorAll(candidate).length === 1 && document.querySelector(candidate) === target) return candidate;
          current = current.parentElement;
        }
        return `body > ${path.join(" > ")}`;
      },
    };
    let label = [node.getAttribute("aria-label"), ...Array.from(field.labels ?? []).map(item => item.textContent),
      node.getAttribute("aria-labelledby")?.split(/\s/u).map(id => document.getElementById(id)?.textContent).join(" ")].filter(Boolean).join(" ");
    if (!label) {
      let parent = node.parentElement;
      for (let depth = 0; parent && depth < 3 && !["BODY", "FORM"].includes(parent.tagName); depth++, parent = parent.parentElement) {
        const fields = parent.querySelectorAll('input:not([type=hidden]):not([aria-hidden=true]),select,[role=combobox],[aria-haspopup=listbox]');
        if (fields.length !== 1 || fields[0] !== node) continue;
        const labels = parent.querySelectorAll(':scope > label,:scope > .label,:scope > .field-label,:scope > [data-field-label],:scope > fieldset > legend');
        const directText = Array.from(parent.childNodes).filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join(" ").trim();
        if (labels.length === 1) label = labels[0].textContent ?? "";
        else if (directText.length > 0 && directText.length < 200) label = directText;
        if (label) break;
      }
    }
    let choiceContext: string | undefined;
    if (node.hasAttribute("data-value")) {
      let parent = node.parentElement;
      for (let depth = 0; parent && depth < 3 && !["BODY", "FORM"].includes(parent.tagName); depth++, parent = parent.parentElement) {
        const context = `${parent.id} ${parent.className} ${parent.innerText}`.replace(/\s+/gu, " ").trim();
        if (context.length <= 300 && /players?|holes?|duration|time.?of.?day|morning|midday|evening/iu.test(context)) { choiceContext = context; break; }
      }
      if (!label && choiceContext) label = choiceContext;
    }
    const name = (node.innerText || node.getAttribute("aria-label") || node.querySelector("img")?.getAttribute("alt") || node.getAttribute("title") || "").trim().slice(0, 160);
    const form = node.closest("form");
    const sensitiveForm = Boolean(form?.querySelector('input[type=password],input[type=email],input[type=tel],[autocomplete^="cc-"]'));
    const pageWrapperForm = Boolean(form && form.parentElement === document.body && form.querySelector("h1") && form.querySelector('footer,[role="contentinfo"]'));
    const independentDisplay = !node.closest('input,textarea,select,button,[contenteditable],[role="button"],[role="combobox"]') &&
      !node.querySelector('input,textarea,select,button,[contenteditable]');
    return { tag: node.tagName.toLowerCase(), role: node.getAttribute("role") ?? "", name,
      label: label.trim().slice(0, 200), href: node instanceof HTMLAnchorElement ? node.href : undefined,
      calendar: Boolean(node.closest('[role="grid"],[role="dialog"],[class*="calendar"],[class*="datepicker"]')),
      sensitiveForm, inForm: Boolean(form), hasDownload: node.hasAttribute("download"),
      ...(sensitiveForm && pageWrapperForm && node.tagName === "A" && independentDisplay && !node.hasAttribute("download") ? { formSafeAnchor: true } : {}),
      ...(sensitiveForm && pageWrapperForm && independentDisplay && /^(?:H[1-3]|ADDRESS|P|DIV|SPAN|LI|TD|TH|TIME)$/u.test(node.tagName) && name &&
        !/\b(?:login|log in|sign in|sign up|register|password|email|phone|subscribe|submit|checkout|payment|purchase|confirm|cancel|delete|send)\b/iu.test(name)
        ? { readOnlyFormDisplay: true } : {}),
      inputType: field.type ?? "", hasPopup: node.getAttribute("aria-haspopup") ?? "", selector: selectors.for(node),
      choiceValue: node.getAttribute("data-value") ?? undefined, choiceContext,
      disabledChoice: node.getAttribute("aria-disabled") === "true" || node.classList.contains("disabled"),
      ...(!sensitiveForm && (node.tagName === "SELECT" || node.tagName === "INPUT" && ["date", "number"].includes(field.type)) ? { currentValue: field.value.slice(0, 200) } : {}),
      ...(node.tagName === "SELECT" && !sensitiveForm ? { options: Array.from((node as HTMLSelectElement).options).slice(0, 100).map(item => ({ value: item.value.slice(0, 200), label: (item.textContent ?? "").trim().slice(0, 200) })) } : {}) };
  }, undefined, { timeout: 1000 }).then(async control => {
    const datePicker = !control.sensitiveForm && control.tag === "input" ? await inspectPublicDatePickerInput(locator) : undefined;
    const product = !control.sensitiveForm && ["a", "button"].includes(control.tag) ? await inspectPublicRentalProduct(locator) : undefined;
    const catalogTile = !control.sensitiveForm && control.tag === "article" ? await inspectPublicCatalogTile(locator, catalogTiles) : undefined;
    const service = !control.sensitiveForm && (control.tag === "select" || control.role === "combobox") ? await inspectPublicRentalService(locator) : undefined;
    let serviceContinuation: PublicServiceContinuationMode | undefined;
    if (!control.sensitiveForm && serviceSelection && control.tag === "button") {
      const mode = /^Skip packages and continue with (?:the )?selected service\b/iu.test(control.name) ? "SKIP_PACKAGES" : "SERVICE";
      if (await inspectPublicServiceContinuation(locator, serviceSelection, mode)) serviceContinuation = mode;
    }
    const serviceMenuOption = control.role === "option" && await locator.evaluate(element => {
      const menu = element.closest('[role="listbox"]');
      if (!menu?.id) return false;
      return Array.from(document.querySelectorAll('[role="combobox"]')).some(trigger => trigger.getAttribute("aria-controls") === menu.id &&
        /^(?:Select\s+)?(?:Service|Activity|Product):?$/iu.test(trigger.getAttribute("aria-label") ?? ""));
    }, undefined, { timeout: 1000 });
    const href = control.href ? normalizeDiscoveryNavigationUrl(control.href) : undefined;
    const documentNavigationOnly = discoveryPublicAvailabilityEntryNavigation({ ...control, href }) || Boolean(control.formSafeAnchor && href && !new URL(href).hash &&
      discoveryPublicAnchorKind({ ...control, href, sensitiveForm: false }));
    return { ...control, ...(datePicker ? { datePicker, name: datePicker.label, label: datePicker.label, currentValue: datePicker.currentValue } : {}),
      ...(catalogTile ? { name: catalogTile.name, label: catalogTile.name, catalogTile: true } : {}), ...(documentNavigationOnly ? { documentNavigationOnly: true } : {}), ...(product ? { product } : {}), ...(service ? { service } : {}),
      ...(serviceContinuation ? { serviceContinuation } : {}), ...(serviceMenuOption ? { serviceMenuOption: true } : {}),
      ...(href ? { href } : {}) };
  });
  const publicControlKind = (control: ObservedControl, blockedAccess: boolean) => {
    if (!recipeSelectorSchema.safeParse(control.selector).success || blockedAccess || control.serviceMenuOption) return null;
    // The generic link fallback must retain the same transaction-parameter
    // exclusion as a labelled public availability link.
    if (control.href && !control.documentNavigationOnly && !isPublicAvailabilityNavigation(control.href, (control.name || control.label).trim())) return null;
    if (control.documentNavigationOnly) return "link";
    if (control.datePicker) return "calendar";
    const kind = control.catalogTile || control.service ? "filter" : control.serviceContinuation ? "service-continuation" : control.product ? "product" : discoveryPublicAnchorKind(control) ?? discoveryPublicChoiceKind(control) ?? interactiveControlKind(control) ?? (control.tag === "select" && !control.sensitiveForm ? "filter" : null);
    if (!kind || /\b(?:book|reserve|checkout|confirm|purchase|pay)\b/iu.test(control.name) && !["link", "product"].includes(kind) ||
      control.href && !isSafeRecipeUrl(control.href)) return null;
    return kind;
  };
  const isRenderedControl = (locator: Locator) => locator.evaluate(element => {
    if (!(element instanceof HTMLElement) || element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
    const bounds = element.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return false;
    let node: HTMLElement | null = element, depth = 0;
    for (; node && depth < 32; node = node.parentElement, depth++) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    return !node;
  }, undefined, { timeout: 1000 });
  const controlCandidates = async () => {
    const matches = page.locator('a[href],a[data-value],button,select,input,td,th,[role="combobox"],[role="option"],[role="gridcell"],[role="button"],article.package-card-v2.package-card-v2--package');
    const indexes = await matches.evaluateAll(nodes => {
      const visible: Array<{ index: number; priority: boolean }> = [];
      // Bound the DOM scan, not the unfiltered prefix of potential controls.
      // Navigation labels only affect ordering; full safety classification is
      // still required before registration or returning an action target.
      for (let index = 0; index < Math.min(nodes.length, 3000); index++) {
        const element = nodes[index];
        if (!(element instanceof HTMLElement) || element.closest('[hidden],[inert],[aria-hidden="true"]')) continue;
        const bounds = element.getBoundingClientRect();
        if (!bounds.width || !bounds.height) continue;
        let node: HTMLElement | null = element, rendered = true, depth = 0;
        for (; node && depth < 32; node = node.parentElement, depth++) {
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') { rendered = false; break; }
        }
        if (!rendered || node) continue;
        // Avoid thousands of cross-process reads for plain decorative buttons.
        // This only removes shapes the full classifier cannot admit. Named,
        // labelled, popup, calendar and product candidates still go through the
        // unchanged per-control validation before any action is exposed.
        if (element.tagName === 'BUTTON' && !element.getAttribute('aria-label') && !element.getAttribute('aria-labelledby') &&
            !element.getAttribute('title') && !element.getAttribute('aria-haspopup') && !element.hasAttribute('data-value') &&
            element.getAttribute('role') !== 'option' && !element.closest('[role="grid"],[role="dialog"],[class*="calendar"],[class*="datepicker"]')) {
          const name = (element.innerText || element.querySelector('img')?.getAttribute('alt') || '').trim();
          const candidateName = /\b(?:date|day|month|calendar|duration|length|party|players?|people|guests?|bay|resource|simulator|location|activity|availability|available|search|view times|next|previous|back|continue|apply)\b/iu.test(name);
          const productName = /^(?:book|select)$/iu.test(name) || /\b(?:hours?|hrs?|hr|minutes?|mins?|min)\b.*(?:\$|USD)|\d\s*h\s*(?:\$|USD)/iu.test(name);
          if (!candidateName && !productName) continue;
        }
        visible.push({ index, priority: element.tagName === 'A' && /\b(?:book|reserve|reservations?|tee\s*times?|availability)\b/iu.test(`${element.innerText} ${element.getAttribute('aria-label') ?? ''}`) });
      }
      return visible.sort((left, right) => Number(right.priority) - Number(left.priority) || left.index - right.index).map(value => value.index);
    });
    return indexes.map(index => matches.nth(index));
  };
  const registerControl = (locator: Locator, control: ObservedControl, kind: string, extra: { date?: string; dropdown?: PublicDropdownProof; menuButton?: PublicMenuButtonProof } = {}) => {
    if (control.href && !isSafeRecipeUrl(control.href)) throw new Error("UNSAFE_NAVIGATION");
    if (control.href) { allowedNavigation.add(control.href); observedNavigationRoots.add(control.href); passfactory.observeWidgetUrl(control.href); cpsScope.observeEntry(control.href); }
    const target = randomUUID();
    controls.set(target, { locator, signature: JSON.stringify(control), kind, href: control.href, ...(control.documentNavigationOnly ? { documentNavigationOnly: true } : {}),
      ...(control.catalogTile ? { catalogTile: true } : {}),
      ...(control.datePicker ? { datePicker: control.datePicker } : {}),
      ...(extra.date ? { calendarDay: extra.date } : {}), ...(extra.dropdown ? { dropdown: extra.dropdown } : {}),
      ...(extra.menuButton ? { menuButton: extra.menuButton } : {}),
      ...(control.service ? { service: true } : {}), ...(control.serviceContinuation ? { serviceContinuation: control.serviceContinuation } : {}) });
    observedElements.set(control.selector, { locator, signature: JSON.stringify(control) });
    return { target, selector: control.selector, kind, name: sanitizeResponderText(control.name), label: sanitizeResponderText(extra.menuButton?.label ?? extra.dropdown?.label ?? control.label),
      ...(control.href ? { href: control.href } : {}), ...(control.currentValue === undefined ? {} : { currentValue: sanitizeResponderText(control.currentValue) }),
      ...(control.datePicker ? { readOnly: true as const } : {}),
      ...(extra.menuButton ? { filterPurpose: extra.menuButton.purpose, currentValue: String(extra.menuButton.purpose === "DURATION" ? extra.menuButton.minutes : extra.menuButton.players) } : {}),
      ...(control.product ? { product: control.product } : {}),
      ...(control.service ? { options: control.service.options.map(option => ({ value: sanitizeResponderText(option.label), label: sanitizeResponderText(option.label) })) } : {}),
      ...(control.options && !control.service ? { options: control.options.map(option => ({ value: sanitizeResponderText(option.value), label: sanitizeResponderText(option.label) })) } : {}) };
  };
  const waitForInitialContent = async () => {
    const startedAt = Date.now();
    // A blank shell is not a settled page. Keep the original navigation clock
    // across observe calls; a slow request cannot create a fresh waiting budget.
    while (navigationStartedAt !== undefined && pendingReadCount() > 0 && Date.now() < Math.min(navigationStartedAt + 30_000, input.deadlineAt.getTime())) {
      deadline.throwIfAborted();
      const text = sanitizeResponderText(await page.locator("body").innerText()).slice(0, 16_000);
      if (text.replace(/[^\p{L}\p{N}]/gu, "").length >= 40 || isActiveBrowserAccessChallenge(text, await page.title())) break;
      let usableControl = false;
      for (const node of await controlCandidates()) {
        if (!await node.isVisible() || !await node.isEnabled()) continue;
        const control = await observeControl(node);
        if (/[\p{L}\p{N}]{2}/u.test(`${control.name} ${control.label}`) && publicControlKind(control, false)) {
          usableControl = true; break;
        }
      }
      if (usableControl) break;
      await page.waitForTimeout(Math.min(250, Math.max(1, navigationStartedAt + 30_000 - Date.now()), Math.max(1, input.deadlineAt.getTime() - Date.now())));
    }
    return Date.now() - startedAt;
  };
  const snapshotOnce = async (settleInitialContent = false, officialIdentityOnly = false): Promise<DiscoveryBrowserSnapshot> => {
    deadline.throwIfAborted();
    if (closed) throw new Error("BROWSER_CLOSED");
    if (!officialIdentityOnly) { controls.clear(); observedElements.clear(); }
    await page.waitForTimeout(Math.min(300, Math.max(1, input.deadlineAt.getTime() - Date.now())));
    const initialContentWaitMs = settleInitialContent ? await waitForInitialContent() : 0;
    // A public app may change its route without making a document request.
    // Only its actually observed URL on an already admitted origin is reusable.
    const actualCurrentUrl = page.url();
    const documentStartedAt = await page.evaluate(() => performance.timeOrigin);
    const currentUrl = normalizeDiscoveryNavigationUrl(actualCurrentUrl);
    if (!officialIdentityOnly && isSafeRecipeUrl(currentUrl) && navigationOrigins.has(new URL(currentUrl).origin)) {
      allowedNavigation.add(currentUrl);
      passfactory.observeWidgetUrl(currentUrl);
    }
    const text = sanitizeResponderText(await page.locator("body").innerText({ timeout: 1000 })).slice(0, 16_000);
    const blockedAccess = isActiveBrowserAccessChallenge(text, await page.title());
    discardStaleOfficialIdentity(currentUrl);
    const identityDocument = officialIdentityDocument && sameDiscoveryMainDocument(officialIdentityDocument.url, currentUrl) ? officialIdentityDocument :
      deps.captureDelegatedDocument && delegatedIdentityDocument && sameDiscoveryMainDocument(delegatedIdentityDocument.url, currentUrl) ? delegatedIdentityDocument : undefined;
    if (!blockedAccess && identityDocument) {
        const visibleEvidence = await page.evaluate(collectNativeOfficialPublicMetadata, input.venueName ?? "");
        const publicContactBlocks = deps.collectPublicCourseContacts && input.venueName ? await readVisiblePublicCourseContactBlocks(page, input.venueName) : [];
        const captured = { ...identityDocument, visibleEvidence: { ...visibleEvidence,
          addressTexts: [...visibleEvidence.addressTexts,...publicContactBlocks.map(block=>`${block.street}, ${block.locality}, ${block.region} ${block.postalCode}`)],
          ...(publicContactBlocks.length ? { publicContactBlocks } : {}) }, observedAt: Date.now(), documentStartedAt,
          browserTransport: deps.browserTransport ?? "PINNED_HTTP" };
        if (identityDocument === officialIdentityDocument) officialIdentityPage = captured as typeof officialIdentityPage;
        if (deps.captureDelegatedDocument) delegatedIdentityPage = captured;
    }
    if (officialIdentityOnly) {
      // The private reader needs this fresh identity capture, not the public
      // control/calendar inventory that can consume its five-second lifetime.
      const finalDocumentStartedAt = await page.evaluate(() => performance.timeOrigin);
      if (page.url() !== actualCurrentUrl || documentStartedAt !== finalDocumentStartedAt)
        throw new Error("DISCOVERY_SNAPSHOT_CHANGED");
      return { url: currentUrl, text, controls: [], elements: [], frames: [], responses: [], requests: [],
        officialSourceDiagnostic: officialDiagnostics(), loading: pendingReadCount() > 0,
        blockedRequests, requestCount, interceptCount, responseBytes, startupMs, pendingRequestCount: pendingReadCount(),
        ...(redirectRouting?.firstFatal ? { nativeFirstFatal: redirectRouting.firstFatal } : {}),
        ...(navigation && sameDiscoveryMainDocument(navigation.url, actualCurrentUrl) ? { navigationStatus: navigation.status } : {}),
        browserTransport: deps.browserTransport ?? "PINNED_HTTP", accessRequirementObserved: blockedAccess };
    }
    const visible: DiscoveryBrowserSnapshot["controls"] = [];
    const candidates: Array<{ locator: Locator; date?: string; dropdown?: PublicDropdownProof; menuButton?: PublicMenuButtonProof }> = (await controlCandidates()).map(locator => ({ locator }));
    const dayCandidates = blockedAccess ? [] : [...await observedPublicCalendarDays(page), ...await observedPublicDateChoices(page)];
    const dropdowns = blockedAccess ? [] : (await observedPublicDropdowns(page)).map(value => ({ locator: value.locator, dropdown: value.proof }));
    const menuButtons = blockedAccess ? [] : (await observedPublicMenuButtons(page)).map(value => ({ locator: value.locator, menuButton: value.proof }));
    const seenControls = new Set<string>();
    for (const { locator, date, dropdown, menuButton } of [...dayCandidates, ...dropdowns, ...menuButtons, ...candidates] as typeof candidates) {
      if (!await isRenderedControl(locator) || !await locator.isEnabled({ timeout: 1000 })) continue;
      const control = await observeControl(locator);
      if (seenControls.has(control.selector)) continue;
      seenControls.add(control.selector);
      // Native public selects remain discoverable when the widget omitted an
      // accessible name, without admitting sensitive forms or arbitrary fields.
      const kind = ((date || dropdown || menuButton) && !blockedAccess && recipeSelectorSchema.safeParse(control.selector).success
        ? dropdown || menuButton ? "filter" : "calendar" : publicControlKind(control, blockedAccess)) ??
        (!blockedAccess && /^(?:Apply|Apply dates)$/iu.test(control.name) && await isPublicCalendarApply(locator) ? "calendar" : null);
      if (!kind) continue;
      if (control.href && !isSafeRecipeUrl(control.href)) continue;
      visible.push(registerControl(locator, control, kind, { date, dropdown, menuButton }));
      if (visible.length >= 180) break;
    }
    const elements: DiscoveryBrowserSnapshot["elements"] = [];
    const allElements = page.locator("body *");
    const displayIndexes = await allElements.evaluateAll(nodes => {
      const dates: number[] = [], times: number[] = [], resources: number[] = [], durations: number[] = [];
      for (let index = 0; index < Math.min(nodes.length, 3000); index++) {
        const node = nodes[index];
        if (node.closest("script,style,noscript,input,textarea,select,option")) continue;
        const ownText = Array.from(node.childNodes).filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent ?? "").join(" ").trim();
        const label = node.getAttribute("aria-label") ?? "";
        const text = `${ownText} ${label}`;
        if (text.length < 250 && dates.length < 24 && /\b(?:\d{4}-\d{2}-\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})\b/iu.test(text)) dates.push(index);
        // Read public display leaves independently of generated CSS classes.
        // These entries grant inspection only, never click authority.
        if (!ownText || ownText.length > 160 || node.children.length ||
          /\b(?:login|sign in|sign up|password|email|phone|checkout|payment|purchase|reserve|confirm|submit|contact)\b/iu.test(ownText)) continue;
        if (times.length < 48 && /^(?:(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*[ap]\.?m\.?)?|(?:[1-9]|1[0-2])\s*[ap]\.?m\.?)$/iu.test(ownText)) times.push(index);
        else if (resources.length < 24 && /\b(?:golf|sims?|simulators?|bays?|rentals?|rooms?|courses?)\b/iu.test(ownText) &&
          !/\b(?:lessons?|coaching|classes?|leagues?|members?)\b/iu.test(ownText)) resources.push(index);
        else if (durations.length < 16 && /^(?:\d+(?:\.\d+)?\s*(?:minutes?|mins?|min|hours?|hrs?|hr|h)\s*(?:[-–]\s*)?)+$/iu.test(ownText)) durations.push(index);
      }
      return [...dates, ...times, ...resources, ...durations];
    });
    const nodes = [...displayIndexes.map(index => allElements.nth(index)), ...await page.locator('h1,h2,h3,label,time,[datetime],[data-date],[data-time],[data-capacity],[aria-live],select,input[type=date],input[type=number],td,li,[class*="slot"],[class*="time"],[class*="card"]').all()];
    const seenElements = new Set<string>();
    for (const node of nodes.slice(0, 180)) {
      if (!await node.isVisible()) continue;
      const control = await observeControl(node);
      if (!recipeSelectorSchema.safeParse(control.selector).success || control.sensitiveForm && !control.readOnlyFormDisplay && !control.documentNavigationOnly || seenElements.has(control.selector)) continue;
      seenElements.add(control.selector);
      observedElements.set(control.selector, { locator: node, signature: JSON.stringify(control) });
      const attributes = await node.evaluate(element => Object.fromEntries(Array.from(element.attributes)
        .filter(attribute => ["id", "class", "role", "datetime", "aria-label", "aria-selected", "aria-current", "value"].includes(attribute.name) || /^data-(?:date|time|timestamp|capacity|value|duration|resource|product|loaded|complete)$/u.test(attribute.name))
        .map(attribute => [attribute.name, attribute.value.slice(0, 200)])), undefined, { timeout: 1000 });
      elements.push({ selector: control.selector, tag: control.tag, text: sanitizeResponderText(control.name).slice(0, 250), attributes });
    }
    const bookingParentIdentity = !blockedAccess && bookingParents.needsIdentity(currentUrl) ? await readPublicBookingParentIdentity(page) : undefined;
    const parentProof = bookingParents.authorizeParent(currentUrl, bookingParentIdentity);
    const publicFrameSources = !blockedAccess && input.venueOfficialUrl && navigation?.status === 200
      ? await observedPublicFrameSources(page, input.venueOfficialUrl, navigation.url, parentProof) : [];
    // This is an exact literal public document edge, not a visible control or
    // a click capability. Rebuild from current DOM + captured official bytes.
    const intermediary = !blockedAccess && !terminalFailure && !redirectRouting?.firstFatal && nativeProxy &&
      navigation?.status === 200 && officialIdentityDocument?.url === actualCurrentUrl && parentProof?.kind === "VERIFIED_OFFICIAL_DOCUMENT"
      ? await observedPublicBookingIntermediary(page, officialIdentityDocument.html, parentProof) : null;
    if (intermediary && (publicIntermediaries.has(intermediary) || publicIntermediaries.size < 2)) {
      publicIntermediaries.set(intermediary, { pageUrl: actualCurrentUrl, documentStartedAt });
      allowedNavigation.add(intermediary); observedNavigationRoots.add(intermediary);
      bookingParents.observeOfficialLink(currentUrl, intermediary, "Public tee time availability");
      visible.push({ target: randomUUID(), selector: "a[href]", kind: "public-document-link", name: "Public booking document link", label: "", href: intermediary, readOnly: true });
    }
    const frames: DiscoveryBrowserSnapshot["frames"] = publicFrameSources.map(url => ({ url, source: "OFFICIAL_IFRAME_SRC" }));
    for (const frame of page.frames()) {
      const url = normalizeDiscoveryNavigationUrl(frame.url());
      if (frames.length >= 10) break;
      if (frame !== page.mainFrame() && isSafeRecipeUrl(url) && !frames.some(value => value.url === url)) frames.push({ url });
    }
    // A client navigation can replace the DOM while its old locator inventory
    // is being read. Never return controls and text from different documents.
    const finalDocumentStartedAt = await page.evaluate(() => performance.timeOrigin);
    if (page.url() !== actualCurrentUrl || documentStartedAt !== finalDocumentStartedAt)
      throw new Error("DISCOVERY_SNAPSHOT_CHANGED");
    teeBookingScope.observeRenderedSnapshot(teeDocumentToken, { url: actualCurrentUrl, timeOrigin: documentStartedAt,
      ...(officialIdentityPage && officialIdentityPage.url === actualCurrentUrl ? { officialPage: officialIdentityPage, verifiedOfficial: officialIdentityPage.officialDocumentProof } : {}),
      frames: publicFrameSources, blocked: Boolean(blockedAccess || terminalFailure || redirectRouting?.firstFatal) });
    for (const control of visible) if (control.kind === "link" && control.href)
      bookingParents.observeOfficialLink(currentUrl, control.href, `${control.name} ${control.label}`.trim());
    for (const url of publicFrameSources) {
      allowedNavigation.add(url); observedNavigationRoots.add(url); passfactory.observeWidgetUrl(url); cpsScope.observeEntry(url);
    }
    // Frame presence is descriptive only. A blocked or unread frame cannot
    // grant a navigation URL or authorize a provider's embedded resource.
    const requests = observedRequests.map(request => ({ ...request }));
    const pendingMetadata = observedRequests.filter(request => pendingRequestMetadata.has(request));
    observedRequests.splice(0, observedRequests.length, ...pendingMetadata);
    requestMetadataBytes = pendingMetadata.reduce((total, request) => total + JSON.stringify(request).length + 120, 0);
    const currentNativeRedirects = nativeDocumentRedirects && nativeDocumentRedirects.url === actualCurrentUrl && input.venueOfficialUrl
      ? attestedNativeDocumentRedirects(nativeDocumentRedirects.request, new Set([input.venueOfficialUrl])) : undefined;
    return { url: currentUrl, text, controls: visible, elements, frames, responses: responses.splice(0), requests, requestFailures: requestFailures.map(failure => ({ ...failure })),
      ...(currentNativeRedirects ? { nativeDocumentRedirects: currentNativeRedirects } : {}),
      ...(redirectRouting?.firstFatal ? { nativeFirstFatal: redirectRouting.firstFatal } : {}),
      ...(redirectRouting?.rejectedRequests?.length ? { nativeRejectedRequests: redirectRouting.rejectedRequests } : {}),
      officialSourceDiagnostic: officialDiagnostics(), ...(navigationFailureKind ? { navigationFailureKind } : {}),
      ...(capabilityDiagnostics.length ? { capabilityDiagnostics: capabilityDiagnostics.map(value => ({ ...value })) } : {}), loading: pendingReadCount() > 0,
      blockedRequests, requestCount, interceptCount, responseBytes, startupMs, initialContentWaitMs, pendingRequestCount: pendingReadCount(),
      ...(navigationStartedAt === undefined ? {} : { navigationElapsedMs: Date.now() - navigationStartedAt }),
      ...(navigation && sameDiscoveryMainDocument(navigation.url, actualCurrentUrl) ? { navigationStatus: navigation.status } : {}),
      browserTransport: deps.browserTransport ?? "PINNED_HTTP", accessRequirementObserved: blockedAccess };
  };
  const snapshot = async (settleInitialContent = false, officialIdentityOnly = false): Promise<DiscoveryBrowserSnapshot> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await snapshotOnce(settleInitialContent, officialIdentityOnly);
        // A committed page can be readable while resources are pending. That
        // does not permit a concurrent fatal guard or closed session to pass.
        if (terminalFailure) throw new Error(terminalFailure);
        deadline.throwIfAborted();
        if (closed) throw new Error("BROWSER_CLOSED");
        if (officialIdentityOnly) return result;
        const safe = modelSafe(result);
        const entries = [...completedPublicAssets].filter(([key]) => !deliveredPublicAssets.has(key));
        // Snapshot retries and later inspect/adapter work cannot acknowledge
        // this channel. Only the final successful execute return may do so.
        return { ...safe, completedPublicAssetRequests: entries.map(([, value]) => ({ ...value })), completedPublicAssetRequestsOverflow };
      }
      catch (error) {
        const message = error instanceof Error ? error.message : "";
        const replaced = /DISCOVERY_SNAPSHOT_CHANGED|Execution context was destroyed|Cannot find context|Frame (?:was )?detached|locator\.(?:evaluate|isEnabled|innerText): Timeout/iu.test(message);
        if (attempt >= 1 || !replaced || closed || deadline.aborted) throw error;
        // Retry only the read. The public click/filter is never replayed, and
        // the original session deadline and action counters remain unchanged.
        await page.waitForTimeout(Math.min(150, Math.max(1, input.deadlineAt.getTime() - Date.now())));
      }
    }
  };
  const currentEzDocument = async () => {
    deadline.throwIfAborted();
    if (terminalFailure) throw new Error(terminalFailure);
    if (closed) throw new Error("BROWSER_CLOSED");
    if (!nativeProxy) throw new Error("EZLINKS_NATIVE_BROWSER_REQUIRED");
    const witness = ezDocument;
    if (!witness || !witness.settled) throw new Error("EZLINKS_DOCUMENT_CHANGED");
    const rootSearchRoute = () => {
      try {
        const original = new URL(witness.url), current = new URL(page.mainFrame().url());
        return witness === ezDocument && witness.status === 200 && witness.token !== undefined && witness.token === ezlinks.currentDocument() &&
          witness.observedAt !== undefined && Date.now() >= witness.observedAt && Date.now() - witness.observedAt <= 300_000 &&
          original.protocol === "https:" && current.origin === original.origin && original.pathname === "/" && current.pathname === "/search" &&
          !original.username && !original.password && !original.port && !original.search && !original.hash &&
          !current.username && !current.password && !current.port && !current.search && !current.hash;
      } catch { return false; }
    };
    const currentLocation = async () => {
      if (sameDiscoveryMainDocument(witness.url, page.mainFrame().url())) return undefined;
      if (!rootSearchRoute()) throw new Error("EZLINKS_DOCUMENT_CHANGED");
      // The pinned html5-mode router sends its default root state to /search.
      // This private alias cannot rewrite source URLs or authorize navigation;
      // the exact native document/token and both completed code hashes remain
      // required. Any wait is outside provider capacity and the original clock.
      await waitEz(() => witness !== ezDocument || witness.readContractFailed || completedEzReadAssets(witness), "EZLINKS_READ_CONTRACT_UNVERIFIED");
      if (!rootSearchRoute() || !completedEzReadAssets(witness)) throw new Error("EZLINKS_READ_CONTRACT_UNVERIFIED");
      return witness.readContractVersion;
    };
    const aliasVersion = await currentLocation();
    const visible = await page.locator("body").evaluate(element => (element as HTMLElement).innerText.slice(0, 100_000), undefined,
      { timeout: Math.min(1000, Math.max(1, input.deadlineAt.getTime() - Date.now())) });
    if ([401, 403].includes(witness.status ?? 0) || isActiveBrowserAccessChallenge(visible, await page.title()))
      throw new Error("ACCESS_REQUIRED");
    if (witness !== ezDocument || !witness.token || witness.token !== ezlinks.currentDocument()) throw new Error("EZLINKS_DOCUMENT_CHANGED");
    const finalAliasVersion = await currentLocation();
    if (aliasVersion !== undefined && aliasVersion !== finalAliasVersion) throw new Error("EZLINKS_DOCUMENT_CHANGED");
    return witness;
  };
  const fixedEzRead = async (witness: EzLinksDocumentWitness, method: "GET" | "POST", body?: string, version = witness.initVersion) => {
    if (ezControllerRead) throw new Error("EZLINKS_PUBLIC_READ_BUSY");
    if (witness !== await currentEzDocument() || !witness.token || witness.initVersion !== version) throw new Error("EZLINKS_DOCUMENT_CHANGED");
    const contract = method === "POST" ? ezReadContractRead : undefined;
    if (contract && (contract.document !== witness || contract.token !== witness.token)) throw new Error("EZLINKS_READ_CONTRACT_UNVERIFIED");
    assertEzReadContract(witness, contract?.version);
    const url = new URL(method === "GET" ? "/api/search/init" : "/api/search/search", witness.url);
    if (method === "POST" && !ezlinks.allows(url, new Headers({ "content-type": "application/json", origin: url.origin }), body ?? ""))
      throw new Error("EZLINKS_PUBLIC_READ_REJECTED");
    if (ezReadNonces.size >= 192) throw new Error("PUBLIC_READ_REQUEST_LIMIT");
    const call: EzLinksControllerRead = { nonce: randomUUID(), document: witness, token: witness.token, version: witness.initVersion,
      url: url.href, method, body, seen: false, complete: false, ...(contract ? { contractVersion: contract.version } : {}) };
    ezControllerRead = call;
    ezReadNonces.add(call.nonce);
    try {
      // Implementation-owned fixed fetch only. Its return value/body is never
      // evidence: only the correlated, fully guarded native response resolves
      // this call. An overridden fetch cannot fabricate a captured response.
      const started = page.evaluate(async ({ url, method, body, nonce, header }) => {
        const headers: Record<string, string> = { [header]: nonce };
        if (method === "POST") headers["content-type"] = "application/json";
        const response = await fetch(url, { method, headers, ...(body === undefined ? {} : { body }), credentials: "same-origin", redirect: "error" });
        await response.arrayBuffer();
      }, { url: url.href, method, body, nonce: call.nonce, header: ezLinksReadHeader });
      void started.catch(() => { if (!call.complete) call.error ??= new Error("EZLINKS_PUBLIC_READ_FAILED"); });
      await waitEz(() => {
        if (call.error) throw call.error;
        if (ezControllerRead !== call || ezDocument !== witness || ezlinks.currentDocument() !== call.token) throw new Error("EZLINKS_DOCUMENT_CHANGED");
        assertEzReadContract(witness, call.contractVersion);
        return call.complete;
      }, "EZLINKS_READ_TIMEOUT");
      assertEzReadContract(witness, call.contractVersion);
      return structuredClone(call.result);
    } finally { if (ezControllerRead === call) ezControllerRead = undefined; }
  };
  const readEzLinksConfiguration = async () => {
    const witness = await currentEzDocument();
    if (witness.init === undefined) {
      // Wait outside provider capacity for the site's actual automatic init.
      // A failed observed init is not retried as an access-wall workaround.
      await waitEz(() => witness !== ezDocument || witness.init !== undefined || witness.initAttempted,
        "EZLINKS_CONFIGURATION_UNAVAILABLE", 500).catch(error => {
        if (!(error instanceof Error) || error.message !== "EZLINKS_CONFIGURATION_UNAVAILABLE" || witness.initAttempted) throw error;
      });
      if (witness.pendingInit > 0)
        await waitEz(() => witness !== ezDocument || witness.init !== undefined || witness.pendingInit === 0, "EZLINKS_CONFIGURATION_UNAVAILABLE");
      if (witness !== ezDocument) throw new Error("EZLINKS_DOCUMENT_CHANGED");
      if (witness.init === undefined) {
        if (witness.initAttempted) throw new Error("EZLINKS_CONFIGURATION_UNAVAILABLE");
        await fixedEzRead(witness, "GET");
      }
    }
    if (witness !== await currentEzDocument() || witness.init === undefined || !witness.initAt || Date.now() - witness.initAt > 300_000)
      throw new Error("EZLINKS_CONFIGURATION_UNAVAILABLE");
    ezConfigurationRead = { document: witness, token: witness.token!, version: witness.initVersion };
    return structuredClone(witness.init);
  };
  const readEzLinksReadContract = async (): Promise<EzLinksReadContract> => {
    const witness = await currentEzDocument();
    const complete = () => completedEzReadAssets(witness);
    await waitEz(() => witness !== ezDocument || witness.readContractFailed || complete(), "EZLINKS_READ_CONTRACT_UNVERIFIED");
    const version = witness.readContractVersion;
    if (witness !== ezDocument || witness.readContractFailed || !complete()) throw new Error("EZLINKS_READ_CONTRACT_UNVERIFIED");
    if (witness !== await currentEzDocument() || witness.readContractVersion !== version || witness.readContractFailed || !complete())
      throw new Error("EZLINKS_READ_CONTRACT_UNVERIFIED");
    ezReadContractRead = { document: witness, token: witness.token!, version };
    return { kind: "EZLINKS_UNPAGED_SEARCH_V1", assets: ezLinksReadContractAssets.map(asset => ({ ...asset })) };
  };
  return {
    // Controller-only methods; intentionally absent from action/tool schemas.
    async readDelegatedSourceDocument(): Promise<OfficialIdentityPage> {
      const diagnostic = createDelegationDiagnostic("NATIVE_DOCUMENT_READ");
      try {
      if (!deps.captureDelegatedDocument || deps.browserTransport !== "NATIVE_CHROME") throw new Error("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
      const current = await snapshot(false, true), origin = await page.evaluate(() => performance.timeOrigin), captured = delegatedIdentityPage;
      deadline.throwIfAborted();
      Object.assign(diagnostic.gates, { hopSessionOpen: !terminalFailure && !closed, hopNoAccess: !current.accessRequirementObserved,
        hopNoFatal: !current.nativeFirstFatal, hopStatus200: current.navigationStatus === 200, hopCaptured: Boolean(captured),
        hopUrlMatches: Boolean(captured && captured.url === current.url && page.url() === captured.url),
        hopCaptureFresh: Boolean(captured && Date.now() - captured.observedAt <= 5000), hopTimeOriginMatches: captured?.documentStartedAt === origin,
        hopRawClosed: Boolean(captured && /<html(?:\s|>)/iu.test(captured.html) && /<body(?:\s|>)/iu.test(captured.html) && /<\/body\s*>/iu.test(captured.html) && /<\/html\s*>/iu.test(captured.html)),
        hopNativeTransport: captured?.browserTransport === "NATIVE_CHROME" });
      if (terminalFailure || closed || current.accessRequirementObserved || current.nativeFirstFatal || current.navigationStatus !== 200 ||
          !captured || captured.browserTransport !== "NATIVE_CHROME" || captured.url !== current.url || page.url() !== captured.url ||
          captured.documentStartedAt !== origin || Date.now() - captured.observedAt > 5000 || !captured.visibleEvidence ||
          !/<html(?:\s|>)/iu.test(captured.html) || !/<body(?:\s|>)/iu.test(captured.html) || !/<\/body\s*>/iu.test(captured.html) || !/<\/html\s*>/iu.test(captured.html))
        throw new Error("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
      return structuredClone({ url: captured.url, html: captured.html, visibleEvidence: captured.visibleEvidence, browserTransport: captured.browserTransport });
      } catch (error) { rememberTeeItUpDelegationFailure(error, diagnostic); throw error; }
    },
    async readOfficialIdentityPage(): Promise<OfficialIdentityPage> {
      lastOfficialIdentityReadDiagnostic = undefined;
      const current = await snapshot(false, true);
      // Fresh raw/current-document and rendered capture own this witness.
      // Unrelated admitted resources may still be pending; network idle is
      // neither identity proof nor a prerequisite for this one-page read.
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      deadline.throwIfAborted();
      const captureAgeMs = officialIdentityPage ? Date.now() - officialIdentityPage.observedAt : null;
      // Controller-only failure facts. These never grant source/proof authority.
      lastOfficialIdentityReadDiagnostic = { captureAgeMs, gates: {
        noTerminalFailure: !terminalFailure, sessionOpen: !closed,
        noAccessRequirement: !current.accessRequirementObserved, noNativeFatal: !current.nativeFirstFatal,
        status200: current.navigationStatus === 200, snapshotNative: current.browserTransport === "NATIVE_CHROME",
        capturedPagePresent: Boolean(officialIdentityPage), captureUrlMatches: officialIdentityPage?.url === current.url,
        captureFreshWithin5s: captureAgeMs !== null && captureAgeMs <= 5000,
        capturedNative: officialIdentityPage?.browserTransport === "NATIVE_CHROME",
        capturedTimeOriginMatches: officialIdentityPage?.documentStartedAt === timeOrigin,
        officialDocumentVerified: officialIdentityPage?.officialDocumentProof.kind === "VERIFIED_OFFICIAL_DOCUMENT",
        visibleAddressesPresent: Boolean(officialIdentityPage?.visibleEvidence?.addressTexts.length),
        visibleLinksPresent: Boolean(officialIdentityPage?.visibleEvidence?.linkUrls.length),
        currentMainDocumentMatches: Boolean(officialIdentityPage && sameDiscoveryMainDocument(officialIdentityPage.url, page.url())),
      } };
      if (terminalFailure || closed || current.accessRequirementObserved || current.nativeFirstFatal || current.navigationStatus !== 200 ||
          current.browserTransport !== "NATIVE_CHROME" ||
          !officialIdentityPage || officialIdentityPage.url !== current.url || captureAgeMs! > 5000 ||
          officialIdentityPage.browserTransport !== "NATIVE_CHROME" || officialIdentityPage.documentStartedAt !== timeOrigin ||
          officialIdentityPage.officialDocumentProof.kind !== "VERIFIED_OFFICIAL_DOCUMENT" ||
          !officialIdentityPage.visibleEvidence?.addressTexts.length || !officialIdentityPage.visibleEvidence.linkUrls.length ||
          !sameDiscoveryMainDocument(officialIdentityPage.url, page.url())) throw new Error("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");
      return structuredClone({ url: officialIdentityPage.url, html: officialIdentityPage.html,
        visibleEvidence: officialIdentityPage.visibleEvidence, browserTransport: officialIdentityPage.browserTransport });
    },
    readEzLinksConfiguration,
    readEzLinksReadContract,
    async readMindbodyPublicCatalog() { return mindbodyCapture.readCatalog(); },
    async readMindbodyPublicGrid() { return mindbodyCapture.readGrid(); },
    async readEzLinksAvailability(body: unknown) {
      const witness = await currentEzDocument(), binding = ezConfigurationRead;
      if (!binding || binding.document !== witness || binding.token !== witness.token || binding.version !== witness.initVersion)
        throw new Error("EZLINKS_DOCUMENT_CHANGED");
      let serialized: string;
      try { serialized = JSON.stringify(body); } catch { throw new Error("EZLINKS_PUBLIC_READ_REJECTED"); }
      if (typeof serialized !== "string" || Buffer.byteLength(serialized) > 2048) throw new Error("EZLINKS_PUBLIC_READ_REJECTED");
      return fixedEzRead(witness, "POST", serialized, binding.version);
    },
    diagnostics() {
      // Available even when navigation throws or the page has already closed.
      // This contains transport facts only, never page text or response bodies.
      return { loading: pendingReadCount() > 0, pendingRequestCount: pendingReadCount(), cleanupFailed,
        ...(teeItUpDelegation ? { teeItUpDelegation: structuredClone(teeItUpDelegation) } : {}),
        ...(adapterRead ? { adapterRead: { ...adapterRead } } : {}),
        ...(lastOfficialIdentityReadDiagnostic ? { officialIdentityReadDiagnostic: {
          captureAgeMs: lastOfficialIdentityReadDiagnostic.captureAgeMs, gates: { ...lastOfficialIdentityReadDiagnostic.gates },
        } } : {}),
        admittedRequestCounts: { ...admittedRequestCounts }, requestLimit,
        ...(cpsPostalContact ? { cpsPostalContact: structuredClone(cpsPostalContact) } : {}),
        ...(mindbodyAppointment ? { mindbodyAppointment: structuredClone(mindbodyAppointment) } : {}),
        mindbodyCapture: mindbodyCapture.diagnostics(),
        officialSourceDiagnostic: officialDiagnostics(), ...(navigationFailureKind ? { navigationFailureKind } : {}),
        ...(redirectRouting?.firstFatal ? { nativeFirstFatal: redirectRouting.firstFatal } : {}),
        ...(redirectRouting?.rejectedRequests?.length ? { nativeRejectedRequests: redirectRouting.rejectedRequests } : {}),
        requests: observedRequests.map(request => ({ url: request.url, method: request.method, resourceType: request.resourceType,
          ...(request.readPurpose ? { readPurpose: request.readPurpose } : {}),
          ...(request.status === undefined ? {} : { status: request.status }),
          ...(request.blockedReason ? { blockedReason: request.blockedReason } : {}),
          ...(request.publicHeaderDiagnostic ? { publicHeaderDiagnostic: { ...request.publicHeaderDiagnostic } } : {}) })),
        capabilityDiagnostics: capabilityDiagnostics.map(value => ({ ...value })),
        requestFailures: requestFailures.map(failure => ({ ...failure,
          ...(failure.publicHeaderDiagnostic ? { publicHeaderDiagnostic: { ...failure.publicHeaderDiagnostic } } : {}) })) };
    },
    async execute(value: unknown): Promise<DiscoveryBrowserSnapshot> {
      const executeAction = async (): Promise<DiscoveryBrowserSnapshot> => {
      const action = discoveryBrowserActionSchema.parse(value);
      let documentNavigation = false, navigationAttempted = false;
      navigationFailureKind = undefined;
      try {
      if (terminalFailure) throw new Error(terminalFailure);
      deadline.throwIfAborted();
      if (closed || action.action !== "observe" && ++actions > 40) throw new Error("BROWSER_ACTION_LIMIT");
      if (action.action === "observe") {
        if (++observations > 120) throw new Error("BROWSER_OBSERVATION_LIMIT");
        await page.waitForTimeout(Math.min(700, Math.max(1, input.deadlineAt.getTime() - Date.now())));
      }
      if (action.action === "finish") { const result = await snapshot(); await close(); return result; }
      if (action.action === "inspect") {
        const known = observedElements.get(action.selector);
        if (!known || !await isRenderedControl(known.locator) || JSON.stringify(await observeControl(known.locator)) !== known.signature)
          throw new Error("STALE_OR_UNKNOWN_ELEMENT");
        const structure: NonNullable<DiscoveryBrowserSnapshot["structure"]> = { selected: action.selector, ancestors: [] };
        const returnedNodes: Array<{ locator: Locator; selector: string; signature: string }> = [];
        let node = known.locator;
        for (let depth = 0; depth < 4; depth++) {
          const control = await observeControl(node);
          if (control.sensitiveForm && !control.readOnlyFormDisplay && !control.documentNavigationOnly || !recipeSelectorSchema.safeParse(control.selector).success) break;
          const attributes = await node.evaluate(element => Object.fromEntries(Array.from(element.attributes)
            .filter(attribute => ["id", "class", "role"].includes(attribute.name)).map(attribute => [attribute.name, attribute.value.slice(0, 100)])));
          const children: Array<{ selector: string; tag: string; text: string }> = [];
          const returnedChildren: typeof returnedNodes = [];
          for (const child of (await node.locator(":scope > *").all()).slice(0, 12)) {
            if (children.length >= 6 || !await child.isVisible()) continue;
            const observed = await observeControl(child);
            if (observed.sensitiveForm && !observed.readOnlyFormDisplay && !observed.documentNavigationOnly || !recipeSelectorSchema.safeParse(observed.selector).success) continue;
            children.push({ selector: observed.selector, tag: observed.tag, text: sanitizeResponderText(observed.name).slice(0, 80) });
            returnedChildren.push({ locator: child, selector: observed.selector, signature: JSON.stringify(observed) });
          }
          const selector = control.tag === "body" ? "body" : control.selector;
          const entry = { selector, matches: await page.locator(selector).count(), tag: control.tag,
            text: sanitizeResponderText(control.name).slice(0, 160), attributes, children };
          if (JSON.stringify({ ...structure, ancestors: [...structure.ancestors, entry] }).length > 6000) break;
          structure.ancestors.push(entry);
          returnedNodes.push(...returnedChildren);
          returnedNodes.push({ locator: node, selector, signature: JSON.stringify(control) });
          if (control.tag === "body") break;
          node = node.locator("..");
        }
        const result = await snapshot();
        for (const returned of returnedNodes) {
          if (!await isRenderedControl(returned.locator)) continue;
          const current = await observeControl(returned.locator);
          if (JSON.stringify(current) !== returned.signature) continue;
          observedElements.set(returned.selector, { locator: returned.locator, signature: returned.signature });
          // Inspection can find a real public link beyond the bounded control
          // inventory. Admit only that exact, unique, currently rendered link;
          // selectors still never grant click or unrestricted URL authority.
          if (current.tag !== "a" || !current.href || result.accessRequirementObserved ||
              publicControlKind(current, false) !== "link" || !await returned.locator.isEnabled() ||
              await page.locator(current.selector).count() !== 1) continue;
          let admitted = result.controls.find(control => control.selector === current.selector);
          if (!admitted) {
            if (result.controls.length >= 180) controls.delete(result.controls.pop()!.target);
            admitted = registerControl(returned.locator, current, "link");
            result.controls.push(admitted);
          }
          bookingParents.observeOfficialLink(result.url, current.href, `${current.name} ${current.label}`.trim());
          for (const entry of structure.ancestors) for (const item of [entry, ...entry.children]) {
            if (item.selector !== current.selector) continue;
            const before = { href: item.href, target: item.target };
            item.href = admitted.href; item.target = admitted.target;
            if (JSON.stringify(structure).length > 6000) { item.href = before.href; item.target = before.target; }
          }
        }
        return modelSafe({ ...result, structure });
      }
      if (action.action === "inspect_adapter") {
        teeItUpDelegation = undefined;
        adapterRead = undefined;
        officialSourceDiagnostic = undefined;
        cpsPostalContact = undefined;
        mindbodyAppointment = undefined;
        if (!isSafeRecipeUrl(action.url) || !allowedNavigation.has(new URL(action.url).href)) throw new Error("UNOBSERVED_NAVIGATION");
        if (!input.venueName || input.venueName.length > 200) throw new Error("MISSING_VENUE_IDENTITY");
        discardStaleOfficialIdentity(normalizeDiscoveryNavigationUrl(page.url()));
        teeBookingScope.checkCurrentDocument(page.url(), await page.evaluate(() => performance.timeOrigin));
        const officialBookingSourceToken = teeBookingScope.tokenFor(action.url, page.url());
        let result: Awaited<ReturnType<typeof inspectExistingAdapter>>;
        try {
          result = await (deps.inspectAdapter ?? inspectExistingAdapter)({ officialUrl: input.venueOfficialUrl, bookingUrl: action.url, venueName: input.venueName, venueAddress: input.venueAddress, timeZone: input.timeZone ?? "UTC" },
          { venueMatches: venueProofMatches, requestLease: deps.requestLease ?? runWithProviderRequestLease, deadlineAt: input.deadlineAt,
            ...(deps.browserTransport === "NATIVE_CHROME" ? { localCapabilities: ["LOCAL_CHROME"] as const } : {}),
            ...(requestedInput === undefined ? {} : { requestedInput: structuredClone(requestedInput) }),
            ...(trustedContext === undefined ? {} : { trustedContext: structuredClone(trustedContext) }),
            onOfficialSourceDiagnostic: value => { officialSourceDiagnostic = safeOfficialSourceDiagnostic(value); },
            ...(officialIdentityPage && Date.now() - officialIdentityPage.observedAt <= 5 * 60_000 ? { officialIdentityPage } : {}),
            ...(officialBookingSourceToken ? { officialBookingSourceToken } : {}) });
        } catch (error) {
          // Preserve the same failure and only controller-owned closed facts.
          // Nested reader pages and their private request material stay private.
          try { cpsPostalContact = getCpsPostalContactDiagnostic(error); } catch { /* Diagnostics cannot replace the primary failure. */ }
          try { mindbodyAppointment = getMindbodyAppointmentDiagnostic(error); } catch { /* Diagnostics cannot replace the primary failure. */ }
          try { teeItUpDelegation = getTeeItUpDelegationDiagnostic(error); } catch { /* Diagnostics cannot replace the primary failure. */ }
          try { adapterRead = getFixedAdapterReadDiagnostic(error); } catch { /* Diagnostics cannot replace the primary failure. */ }
          throw error;
        }
        const inspectedSnapshot = await snapshot();
        if (result.adapter.family === "TEEITUP" && result.adapter.officialBookingSourceProof) {
          if (!officialBookingSourceToken) throw new Error("OFFICIAL_BOOKING_SOURCE_UNVERIFIED");
          observedTeeItUpOfficialBookingChain(officialBookingSourceToken);
        }
        return { ...inspectedSnapshot, adapter: result.adapter };
      }
      if (action.action === "open") {
        serviceSelection = undefined;
        if (!isSafeRecipeUrl(action.url) || !allowedNavigation.has(new URL(action.url).href)) throw new Error("UNOBSERVED_NAVIGATION");
        const intermediary = publicIntermediaries.get(action.url);
        if (intermediary && (page.url() !== intermediary.pageUrl || !officialIdentityDocument || officialIdentityDocument.url !== intermediary.pageUrl ||
            await page.evaluate(() => performance.timeOrigin) !== intermediary.documentStartedAt ||
            await observedPublicBookingIntermediary(page, officialIdentityDocument.html, bookingParents.authorizeParent(page.url())) !== action.url))
          throw new Error("UNOBSERVED_NAVIGATION");
        navigationOrigins.add(new URL(action.url).origin); passfactory.observeWidgetUrl(action.url);
        await redirectRouting?.beginDocumentNavigation(page.mainFrame());
        responses.length = 0;
        navigationStartedAt = Date.now();
        navigationAttempted = true;
        await page.goto(action.url, { waitUntil: "commit", timeout: Math.min(30_000, Math.max(1, input.deadlineAt.getTime() - Date.now())) });
      } else if (page.url() === "about:blank") throw new Error("OPEN_A_SOURCE_FIRST");
      else if (action.action === "scroll") await page.mouse.wheel(0, action.direction === "down" ? 600 : -600);
      else if (["click", "select", "fill"].includes(action.action) && "target" in action) {
        const known = controls.get(action.target);
        if (!known || !await isRenderedControl(known.locator) || !await known.locator.isEnabled() || JSON.stringify(await observeControl(known.locator)) !== known.signature) throw new Error("STALE_OR_UNKNOWN_CONTROL");
        if (known.calendarDay && !await isObservedPublicCalendarDay(known.locator, known.calendarDay) &&
          !await isPublicDateChoice(known.locator, known.calendarDay)) throw new Error("STALE_OR_UNKNOWN_CONTROL");
        if (action.action === "select") {
          if (known.kind !== "filter") throw new Error("UNSAFE_CONTROL");
          if (known.service) { serviceSelection = undefined; serviceSelection = await selectPublicRentalService(known.locator, action.option); }
          else if (known.menuButton) { serviceSelection = undefined; await selectPublicMenuButton(known.locator, action.option, known.menuButton.purpose); }
          else if (known.dropdown) { serviceSelection = undefined; await selectPublicDropdown(known.locator, { value: action.option, purpose: known.dropdown.purpose, simulator: true }); }
          else {
            serviceSelection = undefined;
            const observed = await observeControl(known.locator);
            const option = observed.options?.find(item => item.value === action.option || item.label === action.option);
            if (!option) throw new Error("UNOBSERVED_OPTION");
            await known.locator.selectOption(option.value);
          }
        } else if (action.action === "fill") {
          serviceSelection = undefined;
          if (known.kind !== "field" || !/^[\d\s/:.T-]{1,120}$/u.test(action.text)) throw new Error("UNSAFE_CONTROL");
          await known.locator.fill(action.text); await known.locator.dispatchEvent("change");
        } else {
          if (known.datePicker) {
            await openPublicDatePickerInput(known.locator, known.datePicker);
            return snapshot();
          }
          if (known.catalogTile) {
            await openPublicCatalogTile(known.locator, catalogTiles);
            return snapshot();
          }
          if (known.service) {
            await openPublicRentalService(known.locator);
            return snapshot();
          }
          if (known.serviceContinuation) {
            await continuePublicRentalService(known.locator, serviceSelection, known.serviceContinuation);
            return snapshot();
          }
          serviceSelection = undefined;
          if (known.kind === "field" || known.kind === "filter" && (known.menuButton || (await observeControl(known.locator)).tag === "select")) throw new Error("USE_TYPED_CONTROL_ACTION");
          if (known.href) {
            if (!isSafeRecipeUrl(known.href)) throw new Error("UNSAFE_NAVIGATION");
            allowedNavigation.add(known.href); observedNavigationRoots.add(known.href); navigationOrigins.add(new URL(known.href).origin); navigationStartedAt = Date.now();
            const target = await known.locator.getAttribute("target");
            const rawHref = await known.locator.evaluate(element => (element as HTMLAnchorElement).href, undefined, { timeout: 1000 });
            const canonicalBootstrap = rawHref !== known.href && normalizeDiscoveryNavigationUrl(rawHref) === known.href;
            const ordinaryDocumentLink = !new URL(known.href).hash && !await known.locator.getAttribute("onclick");
            if (known.documentNavigationOnly || canonicalBootstrap || ordinaryDocumentLink || target && !["_self", "_top", "_parent"].includes(target.toLowerCase())) {
              await redirectRouting?.beginDocumentNavigation(page.mainFrame());
              responses.length = 0;
              navigationStartedAt = Date.now();
              navigationAttempted = true;
              await page.goto(known.href, { waitUntil: "commit" });
              documentNavigation = true;
            }
            else await known.locator.click();
          } else await known.locator.click();
        }
      }
      return snapshot(action.action === "open" || action.action === "observe" || documentNavigation, deps.captureDelegatedDocument === true);
      } catch (error) {
        if (navigationAttempted) navigationFailureKind = discoveryNavigationFailureKind(error);
        if (terminalFailure) throw new Error(terminalFailure);
        throw error;
      }
      };
      const result = await executeAction();
      // A failed action may have built a snapshot before post-snapshot work
      // threw. Acknowledge only exact rows actually returned by this action;
      // concurrently completed assets remain available to the next snapshot.
      if (!closed) for (const asset of result.completedPublicAssetRequests ?? [])
        deliveredPublicAssets.add(JSON.stringify([asset.url, asset.resourceType]));
      return result;
    },
    async close() { deadline.removeEventListener("abort", abort); await close(); },
  };
}
