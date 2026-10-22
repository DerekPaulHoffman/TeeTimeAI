import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";
import { existingAdapterMetadataSchema } from "./existing-adapter-schema";
import { isServerDocumentSelector } from "./server-document-proof";
import { hasCpsSessionState } from "./cps-public-navigation";
import { expandRecipeTemplate, recipeLocalDateSchema as localDate, recipeTemplateSchema } from "./recipe-template";
import { isSafePublicBootstrapReadUrl } from "./public-bootstrap-read-url";
import { isSafePublicAvailabilityReadUrl } from "./public-availability-read-url";
export { expandRecipeTemplate, recipeTemplateSchema } from "./recipe-template";

const secret = /(?:password|secret|token|cookie|session|credential|authorization|api.?key|email|phone)/iu;
const forbiddenPath = /(?:^|\/)(?:login|signin|signup|auth|account|checkout|cart|payment|pay|purchase|orders?|confirm|admin)(?:\/|$)|(?:^|\/)(?:bookings?|reservations?|reserve)\/(?:create|submit|confirm|cancel|hold|reserve)(?:\/|$)/iu;
export function isSafeRecipeUrl(value: string) {
  try {
    const url = new URL(value);
    return Boolean(getSafeCustomerBookingUrl(value)) && !hasCpsSessionState(value) && !/[{}]/u.test(value) && url.protocol === "https:" && !url.username && !url.password && !url.port &&
      !isIP(url.hostname) && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(url.hostname) && !url.hostname.includes("..") && url.hostname.includes(".") && !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/iu.test(url.hostname) &&
      !forbiddenPath.test(decodeURIComponent(url.pathname)) &&
      [...url.searchParams].every(([key, item]) => !secret.test(key) && !/[\r\n]/u.test(item));
  } catch { return false; }
}
/** Anonymous metadata RPC permission is separate from source/navigation and
 * availability-response URLs. Actual transport bytes always remain unchanged. */
export function isSafeBrowserBootstrapReadUrl(value: string, resourceType: string, method: string) {
  return isSafePublicBootstrapReadUrl(value, resourceType, method, isSafeRecipeUrl);
}
/** A public inventory read is separate from customer/source navigation. */
export function isSafeBrowserAvailabilityReadUrl(value: string, resourceType: string, method: string) {
  return isSafePublicAvailabilityReadUrl(value, resourceType, method, isSafeRecipeUrl);
}
/** Browser scripts/styles are read-only resources, not customer booking URLs.
 * Build hashes in a static asset path or a conventional bundle cache key are
 * not credentials. This exception never admits a data request or source URL. */
export function isSafeBrowserAssetUrl(value: string, resourceType: string, method: string) {
  if (value.length > 2048 || method !== "GET" || !["script", "stylesheet"].includes(resourceType)) return false;
  if (isSafeRecipeUrl(value)) return true;
  try {
    const url = new URL(value), path = decodeURIComponent(url.pathname);
    // Public ASP.NET-style bundles can be extensionless. Admit only the
    // observed 44-character URL-safe version shape on its typed static route.
    // Keep the original path/host under the ordinary credential and URL guard.
    const bundlePath = resourceType === "script" ? /^\/bundles\/[a-z][a-z0-9_-]{0,79}$/iu : /^\/content\/css\/[a-z][a-z0-9_-]{0,79}$/iu;
    const bundleVersions = url.searchParams.getAll("v");
    if (url.pathname === path && bundlePath.test(path) && !url.hash && url.searchParams.size === 1 &&
        bundleVersions.length === 1 && /^[A-Za-z0-9_-]{44}$/u.test(bundleVersions[0])) {
      const publicBundle = new URL(url.href);
      publicBundle.searchParams.set("v", "public-build-version");
      return isSafeRecipeUrl(publicBundle.href);
    }
    const unchangedQueryAndHost = new URL(url.href);
    unchangedQueryAndHost.pathname = "/public-asset.js";
    // WordPress serves public .js/.css files with a truncated SHA build version.
    // Mask only one exact conventional hex version; every other query value,
    // hostname and credential check still goes through the ordinary URL guard.
    const versions = url.searchParams.getAll("ver");
    if (versions.length === 1 && /^(?:[a-f0-9]{20}|[a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(versions[0]))
      unchangedQueryAndHost.searchParams.set("ver", "public-build-version");
    return isSafeRecipeUrl(unchangedQueryAndHost.href) && !url.hash &&
      /\.(?:m?js|css)$/iu.test(path) && !path.split("/").includes("..") && !/[\r\n{}]/u.test(path) &&
      !forbiddenPath.test(path) &&
      !/(?:^|\/)(?:login|signin|signup|auth|account|sessions?|tokens?|credentials?|passwords?|secrets?|cookies?|authorization|api[-_]?keys?)(?:\/|$)/iu.test(path) &&
      [...url.searchParams].every(([key, item]) => !secret.test(key) && !/[\r\n]/u.test(item));
  } catch { return false; }
}
const safeUrl = z.string().max(2048).refine(isSafeRecipeUrl, "Expected a public HTTPS read URL");
const urlTemplate = recipeTemplateSchema.refine(value => isSafeRecipeUrl(value.replace(/\{\{[A-Za-z]+\}\}/gu, "x")));
const availabilityUrlTemplate = recipeTemplateSchema.refine(value => {
  if (isSafeRecipeUrl(value.replace(/\{\{[A-Za-z]+\}\}/gu, "x"))) return true;
  const samples: Record<string, string> = { date: "2030-01-02", dateCompact: "20300102", dateMdy: "01-02-2030", players: "2",
    durationMinutes: "60", startTime: "08:00", endTime: "18:00", timeZone: "America/New_York", year: "2030", month: "1", day: "2" };
  const sample = value.replace(/\{\{([A-Za-z]+)\}\}/gu, (_, key: string) => samples[key] ?? "");
  return ["GET", "POST"].some(method => isSafeBrowserAvailabilityReadUrl(sample, "fetch", method));
});
export const SERVER_DOCUMENT_SELECTOR_MESSAGE = "Server document selectors allow only tags, classes, IDs, descendant and child combinators; no pseudo-classes, attribute selectors, wildcards, lists or sibling combinators.";
export const recipeSelectorSchema = z.string().min(1).max(240).refine(value =>
  /^[a-zA-Z0-9_\-\s.#\[\]="'~^$*|:(),>+]+$/u.test(value) &&
  !/(?:script|iframe|password|secret|token|cookie|session|credential|authorization|api.?key|email|phone|:has\(|:visited)/iu.test(value),
"Expected a bounded public display selector").describe("Bounded CSS only: tags, classes, ids, attribute equality and descendant/child selectors. No :has(), scripts, iframes, visited links or sensitive credential/contact fields. Use a reusable calendar day base selector with SELECT_DATE text {{day}}, never a fixed nth-child for a requested day. SERVER_DOCUMENT proof and slot/collection readers use the stricter static grammar documented by availabilityResponse.");
const jsonPath = z.string().min(1).max(240).regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u).refine(value =>
  !value.split(".").some(part => ["__proto__", "prototype", "constructor"].includes(part) || secret.test(part)));
export const recipeFieldSchema = z.union([
  z.object({ path: jsonPath, format: z.enum(["INTEGER", "DURATION_MINUTES"]).optional() }).strict(),
  z.object({ selector: recipeSelectorSchema, attribute: z.enum(["datetime", "data-date", "data-time", "data-value", "data-capacity", "value", "selected-label", "aria-label"]).optional(), format: z.enum(["INTEGER", "DURATION_MINUTES"]).optional() }).strict(),
]);
const venueGreetingFieldSchema = z.object({ selector: recipeSelectorSchema, format: z.literal("VENUE_GREETING") }).strict()
  .describe("DOM venue proof only, visible text with no attribute/path: opt in only for an observed complete 'Welcome to <whole venue>.' with no extra copy, or 'Welcome to [the ]<whole venue>’s online tee time engine.' (ASCII 's also accepted) optionally followed by exactly 'You are guaranteed to receive the best online rates for <whole rate venue> when you book direct with us. We look forward to seeing [you ]on the golf course.' Full text is limited to 500 characters, each captured name to 200. Both the main name and rate name independently use the existing strict whole-venue matcher: Unicode compatibility forms, case, punctuation and spacing are ignored. A terminal Golf Club or Golf Course label may be omitted or interchanged only when the remaining whole-name cores match, contain at least 8 letters/digits, and are not generic golf/category words; for example, Example Ridge Golf Club matches Example Ridge. This does not allow arbitrary abbreviations, substring matches or another location, and never changes the canonical source identity. Arbitrary prose, other copy and hidden/attribute fallbacks reject. Raw/live text equality is checked before interpretation.");
const venueProofFieldSchema = z.union([recipeFieldSchema, venueGreetingFieldSchema]);
const browserJsonVenueSchema = z.object({ selector: recipeSelectorSchema,
  format: z.enum(["VENUE_GREETING", "VENUE_SELECT_TIME"]).optional() }).strict()
  .describe("Fresh visible whole-venue proof. VENUE_SELECT_TIME accepts only exact 'Select a time at <whole venue>'; no arbitrary prefix, substring or extra prose.");
// The new reader shape is text-only. Ordinary field schemas above retain
// their original formats, so the greeting cannot be used for slots or dates.
export type RecipeField = z.infer<typeof recipeFieldSchema> | (z.infer<typeof venueGreetingFieldSchema> & { attribute?: never }) |
  (z.infer<typeof browserJsonVenueSchema> & { attribute?: never });
const visibleDateText = z.object({ selector: recipeSelectorSchema }).strict();
export const recipeDatePartsSchema = z.object({ kind: z.literal("DATE_PARTS"), monthYear: visibleDateText, day: visibleDateText }).strict()
  .describe("DOM only: visible month name plus four-digit year, and one currently selected day. Selection must be marked by aria-selected, aria-current=date, data-selected, Mui-selected, active+day classes, or a BUTTON with both exact days and daySelected classes.");
export type RecipeDateParts = z.infer<typeof recipeDatePartsSchema>;
export const recipeResourceScopeSchema = z.object({
  selector: recipeSelectorSchema.refine(value => !/^(?:html|body|main|:root)(?:$|[\s>+.#[:])/iu.test(value.trim()), "Use resource cards, not the page root"),
  label: recipeFieldSchema,
  expectedLabel: z.string().trim().min(2).max(200).refine(value =>
    /(?:^|\W)(?:simulators?|rentals?|bays?|rooms?)(?:\W|\d|$)/iu.test(value) &&
    !/\b(?:members?[-\s]+only|lessons?|fittings?|leagues?|classes?|coaching)\b/iu.test(value) &&
    (!/\b(?:multi[-\s]?sport|baseball|soccer|hockey|tennis)\b/iu.test(value) || /\bgolf\b/iu.test(value)), "Use a public golf rental resource"),
}).strict().describe("SIMULATOR DOM only: reusable selector matching resource cards, a visible label reader relative to each card, and its exact observed public rental label. The executor chooses the unique matching card and reads slots and proof.empty only inside it; card order is not identity. Venue/date/duration/complete proof stays global.");
export const recipeRouteSchema = z.object({
  origin: safeUrl.refine(value => new URL(value).origin === value, "Use an exact origin"),
  path: z.string().min(1).max(300).regex(/^\/[A-Za-z0-9_./%\-]*(?:\*)?$/u).refine(value =>
    !value.includes("..") && value !== "/*" && !forbiddenPath.test(decodeURIComponent(value))),
  methods: z.array(z.enum(["GET", "HEAD", "POST"])).min(1).max(3),
  queryKeys: z.array(z.string().min(1).max(80).regex(/^[a-zA-Z0-9_\[\].-]+$/u).refine(value => !secret.test(value))).max(30).default([]),
}).strict();
const stepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("selectRentalService"), selector: recipeSelectorSchema, optionText: recipeTemplateSchema }).strict()
    .describe("Select one exact observed public golf/simulator rental service option within a labelled Service/Activity/Product selector. Supports native select or a public combobox with its exact aria-controls listbox. Lessons, events, memberships/packages, dated times and contact/transaction controls are forbidden. This supplies no duration/capacity proof; independently prove the requested full interval at the final inventory."),
  z.object({ action: z.literal("continueToAvailability"), selector: recipeSelectorSchema, mode: z.enum(["SERVICE", "SKIP_PACKAGES"]) }).strict()
    .describe("SIMULATOR only: after successful selectRentalService in this execution, advance the same public service-only widget using its exact Continue/Next button (SERVICE), or the explicit Skip packages and continue with the selected service button (SKIP_PACKAGES). Requires unchanged visible rental selection in the same document, no date/time/contact/payment inputs, no selected slot, no submit/href, and no package purchase. Never use generic Continue after calendar/availability or into customer details. Final fresh date-bound response and independent complete/date/duration/resource proof remain mandatory."),
  z.object({ action: z.literal("selectDateChoice"), selector: recipeSelectorSchema }).strict()
    .describe("Choose the requested date from explicit full date labels using a full or abbreviated English month, day and four-digit year with an optional correct weekday. Supports sibling date buttons and numeric buttons with an exact full aria-label inside a public role=grid calendar. Use one reusable selector for all choices; at least two distinct dates and one requested match are required. Times, products, forms and sensitive contexts are rejected. Final date-bound response and source-date proof are still required."),
  z.object({ action: z.literal("followLink"), selector: recipeSelectorSchema, text: recipeTemplateSchema }).strict()
    .describe("Follow an exact visible public navigation anchor using its current observed href and label (for example Next between service, resource, date and availability pages). The href must match permittedRoutes; selected time/slot, account, review, payment, sensitive forms and new-window targets are rejected. Never use this to choose an availability time."),
  z.object({ action: z.literal("selectDate"), monthYearSelector: recipeSelectorSchema,
    nextSelector: recipeSelectorSchema, previousSelector: recipeSelectorSchema, daySelector: recipeSelectorSchema }).strict()
    .describe("Choose the requested date using a visible full English month and four-digit year heading, safe calendar next/previous controls and a reusable numeric day selector. Moves at most twelve months, verifying each adjacent month before selecting the exact visible requested day. Final independent date proof is still required."),
  z.object({ action: z.literal("selectProduct"), selector: recipeSelectorSchema, productSelector: recipeSelectorSchema }).strict()
    .describe("Choose the requested whole-rental duration within one observed public product/resource card. Supports Book/Select on a single-duration card, or an exact duration-and-price option (for example 1 hour $40) within one named rental/bay card. Duplicate durations, start-time/date choices, mixed action controls, sensitive forms and transaction steps are rejected. productSelector must identify the same enclosing card proved by the control; it cannot be a broad page wrapper."),
  z.object({ action: z.literal("select"), selector: recipeSelectorSchema, value: recipeTemplateSchema,
    purpose: z.enum(["DATE", "PLAYERS", "DURATION", "PRODUCT", "RESOURCE"]) }).strict().describe("Select an observed native HTML <select> option value. PLAYERS/DURATION also support a labelled public role=combobox with an exact visible data-value option, or a focusable dropdown with one adjacent explicit field label and caret whose displayed option and selected readback are independently verified. DURATION also supports an explicitly labelled duration button that opens one bounded duration-only menu; exact offered minutes and the closed menu plus selected button readback are independently verified. PLAYERS supports an explicit Players button with its current count, one SELECT DESIRED PARTY SIZE menu, and unique numeric options with matching accessible labels; current ownership, closed menu and selected count are independently verified. Duration values are minutes; simulator party selection is one bay except the closed SEVENROOMS_PUBLIC_PARTICIPANTS binding, which requests attendees. The inspected PassFactory /ftbb client resets duration when the date changes: select DATE then DURATION. Only that hash-verified local duration operation may retain an already completed date response; all other filters require a new response."),
  z.object({ action: z.literal("fill"), selector: recipeSelectorSchema, value: recipeTemplateSchema,
    purpose: z.enum(["DATE", "PLAYERS", "DURATION"]) }).strict(),
  z.object({ action: z.literal("clickFilter"), selector: recipeSelectorSchema, text: recipeTemplateSchema,
    purpose: z.enum(["OPEN_DATE_PICKER", "NEXT_MONTH", "PREVIOUS_MONTH", "SELECT_DATE", "APPLY_DATE", "OPEN_FILTER", "SELECT_FILTER", "RUN_SEARCH"]) }).strict().describe("Click only an observed public calendar/filter control. OPEN_DATE_PICKER also supports a readonly text/date input with its exact observed date/calendar label or placeholder and dialog popup; click it, never fill it. SELECT_DATE must use an observed reusable day selector plus text {{day}}; the executor requires exactly one visible text match. SELECT_FILTER may use a reusable role=option selector and exact visible text (such as {{players}} Players); exactly one visible match must belong to the currently expanded aria-controls-linked listbox of a public Players/Duration control. Custom tags and data-value do not grant permission. Use waitFor for an observed initial control when the page renders asynchronously. APPLY_DATE may click Apply/Apply dates only inside the same proven public month/day picker after selecting the requested day. It still requires a fresh successful date-bound response and full source-date proof."),
  z.object({ action: z.literal("waitFor"), selector: recipeSelectorSchema }).strict(),
]);
const availabilityResponseSchema = z.object({
  kind: z.enum(["JSON", "SERVER_DOCUMENT"]).optional(),
  url: availabilityUrlTemplate, method: z.enum(["GET", "POST"]),
  date: z.object({ source: z.enum(["QUERY", "JSON_BODY", "PATH"]), path: jsonPath,
    format: z.enum(["ISO_DATE", "MM-DD-YYYY", "M/D/YYYY"]).optional().describe("Default ISO_DATE is YYYY-MM-DD. MM-DD-YYYY is zero-padded; use {{dateMdy}} in its URL. M/D/YYYY is an explicit unpadded month/day/year JSON_BODY date on a POST only.") }).strict(),
  endDatePath: jsonPath.optional(),
  success: z.object({ path: jsonPath, equals: z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]) }).strict().optional(),
}).strict().refine(value => value.method === "POST" || value.date.source === "QUERY" || value.date.source === "PATH", "GET date binding must read a query parameter or explicit path segment")
  .refine(value => {
    const url = expandRecipeTemplate(value.url, { date: "2030-01-02", timeZone: "America/New_York", players: 2,
      durationMinutes: 60, startTime: "08:00", endTime: "18:00" }, true);
    return isSafeRecipeUrl(url) || isSafeBrowserAvailabilityReadUrl(url, "fetch", value.method);
  }, "Availability URL must permit the exact response method")
  .refine(value => value.date.format !== "M/D/YYYY" || value.method === "POST" && value.date.source === "JSON_BODY", "M/D/YYYY date binding requires a POST JSON body")
  .refine(value => value.date.source !== "PATH" || value.method === "GET" && /^(?:[0-9]|[1-5][0-9]|6[0-3])$/u.test(value.date.path) &&
    (!value.endDatePath || /^(?:[0-9]|[1-5][0-9]|6[0-3])$/u.test(value.endDatePath)), "PATH date binding requires GET and zero-based decimal segment indexes 0..63")
  .refine(value => value.kind !== "SERVER_DOCUMENT" || value.method === "GET" && value.date.source === "QUERY" && !value.success && !value.endDatePath,
    "Server document proof requires a dated GET document")
  .describe(`Required completed availability-response fence. Exact URL/method and date must equal the requested date in the explicit format. GET uses QUERY or PATH; PATH path/endDatePath are decimal zero-based indexes 0..63 into nonempty raw URI path segments. Duplicate/trailing slashes, encoded slashes and encoded date values are not date proof. This grants no route permission. Default JSON uses observed scalar success for response-only completion. Explicit kind SERVER_DOCUMENT requires GET/query date and proof.complete {serverDocument:true}: a complete text/html main document whose inert source venue/date/slot fields equal the settled visible DOM; outdoor static CSS only, no pagination or later data fetch. For SERVER_DOCUMENT, every proof field selector, slot field selector and slots.collection.selector must follow this static grammar: ${SERVER_DOCUMENT_SELECTOR_MESSAGE} Use an observed tag/class/ID or bounded descendant/child chain that identifies the intended field; positional selectors such as :first-child and :nth-of-type(1) are unsupported. Supported field attribute readers such as attribute:"value" remain available; CSS attribute selectors are forbidden. A matching response must start after the last date/filter change. Only the runtime-verified PassFactory /ftbb client-only DURATION select may carry a completed day response. This proves freshness, not availability by itself; independent capacity/duration/empty proof remains required.`);
const timeZone = z.string().max(80).refine(value => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
});
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
export const accessExecutionInputSchema = z.object({
  date: localDate, timeZone, players: z.number().int().min(1).max(20),
  durationMinutes: z.number().int().min(15).max(480).optional(), startTime: time, endTime: z.union([time, z.literal("24:00")]),
}).strict().refine(value => value.startTime < value.endTime, "The requested window must end after it starts");
export type AccessExecutionInput = z.infer<typeof accessExecutionInputSchema>;
const common = {
  schemaVersion: z.literal(1),
  target: z.object({ courseId: z.string().min(1).max(128), offeringId: z.string().min(1).max(128).optional(), kind: z.enum(["OUTDOOR", "SIMULATOR"]) }).strict(),
  source: z.object({ officialUrl: safeUrl, bookingUrl: safeUrl, venueName: z.string().min(2).max(200),
    venueAddress: z.string().trim().min(3).max(1024).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)).optional(),
    providerFamily: z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/u), timeZone }).strict(),
  permittedRoutes: z.array(recipeRouteSchema).min(1).max(40),
  proof: z.object({ venue: recipeFieldSchema, date: z.union([recipeFieldSchema, recipeDatePartsSchema]),
    complete: z.union([recipeFieldSchema, z.object({ availabilityResponse: z.literal(true) }).strict(), z.object({ serverDocument: z.literal(true) }).strict()])
      .describe("Read explicit true/ready/loaded/complete state, use {availabilityResponse:true} for verified JSON success, or {serverDocument:true} with kind SERVER_DOCUMENT for full raw/visible HTML equality. Presence of body or an arbitrary container is not completion."),
    empty: recipeFieldSchema.optional(), players: recipeFieldSchema.optional(), durationMinutes: recipeFieldSchema.optional() }).strict(),
  slots: z.object({ collection: z.union([z.object({ path: jsonPath }).strict(), z.object({ selector: recipeSelectorSchema }).strict()]),
    scope: recipeResourceScopeSchema.optional(),
    startsAt: recipeFieldSchema, endsAt: z.union([recipeFieldSchema, z.object({ derive: z.literal("ADD_REQUESTED_DURATION") }).strict()]).optional(), availableSpots: recipeFieldSchema.optional(), minimumPlayers: recipeFieldSchema.optional(), capacity: recipeFieldSchema.optional(),
    holes: recipeFieldSchema.optional(), resourceId: recipeFieldSchema.optional(), productId: recipeFieldSchema.optional(),
  }).strict(),
};
const browserJsonPath = jsonPath.refine(value => !/contact|card|customer|user|person|attendee|member|profile|account|notes?|payment/iu.test(value), "Private response paths are not inventory readers");
const browserJsonRowsSchema = z.object({
  path: browserJsonPath, dateKey: z.literal("REQUESTED_DATE"), rowsPath: browserJsonPath,
  typePath: browserJsonPath, excludeType: z.literal("request"),
  availableTypes: z.array(z.string().regex(/^[A-Za-z][A-Za-z_-]{0,31}$/u)).min(1).max(8)
    .refine(values => !values.includes("request") && new Set(values).size === values.length), accessIdPath: browserJsonPath,
  labelPath: browserJsonPath, expectedRentalLabel: recipeResourceScopeSchema.shape.expectedLabel,
  startsAtPath: browserJsonPath, durationMinutesPath: browserJsonPath,
}).strict().describe("Original completed JSON only: requested own date key -> group array -> one child-array path, at most 500 groups plus rows. Every non-request row needs a nonempty public access identity, exact observed public rental label, actual time and duration. Request rows never become instant availability; malformed rows never disappear. No literal IDs, scripts, recursive wildcards or sampled-schema completion.");
export const accessRecipeSchema = z.discriminatedUnion("engine", [
  z.object({ ...common, engine: z.literal("HTTP_JSON"), request: z.object({ url: urlTemplate,
    method: z.enum(["GET", "POST"]), body: z.record(z.string().max(80).refine(value => !secret.test(value)),
      z.union([recipeTemplateSchema, z.number().finite(), z.boolean()])).optional() }).strict() }).strict(),
  z.object({ ...common, proof: common.proof.extend({ venue: venueProofFieldSchema }), engine: z.literal("BROWSER_DOM"), browserTransport: z.enum(["PINNED_HTTP", "NATIVE_CHROME"]).default("PINNED_HTTP"), pageUrl: urlTemplate,
    availabilityResponse: availabilityResponseSchema, steps: z.array(stepSchema).max(32) }).strict(),
  z.object({ schemaVersion: common.schemaVersion, target: common.target, source: common.source, permittedRoutes: common.permittedRoutes,
    engine: z.literal("BROWSER_JSON"), browserTransport: z.enum(["PINNED_HTTP", "NATIVE_CHROME"]).default("PINNED_HTTP"), pageUrl: urlTemplate,
    steps: z.array(stepSchema).max(32), availabilityResponse: availabilityResponseSchema,
    requestBinding: z.literal("SEVENROOMS_PUBLIC_PARTICIPANTS"), responseRows: browserJsonRowsSchema,
    proof: z.object({ venue: browserJsonVenueSchema, date: z.object({ availabilityDateKey: z.literal(true) }).strict(),
      complete: z.object({ availabilityResponse: z.literal(true) }).strict() }).strict(),
  }).strict(),
  z.object({ schemaVersion: common.schemaVersion, target: common.target, source: common.source,
    engine: z.literal("EXISTING_ADAPTER"), adapter: existingAdapterMetadataSchema }).strict(),
]).superRefine((recipe, ctx) => {
  if (recipe.engine === "EXISTING_ADAPTER") {
    const simulator = ["ACUITY", "USCHEDULE", "WHOOSH", "LIGHTSPEED", "AMELIA", "GOLFVX", "REX"].includes(recipe.adapter.family) ||
      recipe.adapter.family === "TEEITUP" && recipe.adapter.offeringKind === "SIMULATOR";
    if (recipe.source.providerFamily !== recipe.adapter.family ||
      (recipe.target.kind === "SIMULATOR") !== simulator ||
      recipe.target.kind === "SIMULATOR" && !recipe.target.offeringId || ["TEEITUP", "AMELIA", "CHRONOGOLF", "GOLFVX", "EZLINKS", "REX", "CPS"].includes(recipe.adapter.family) && !recipe.source.venueAddress)
      ctx.addIssue({ code: "custom", message: "Supported adapter metadata must match the source and target kind" });
    if (recipe.adapter.family === "USCHEDULE" && recipe.adapter.publicLocationProof && !recipe.source.venueAddress)
      ctx.addIssue({ code: "custom", message: "A public location rental requires canonical venue address context" });
    if (recipe.adapter.family === "TEEITUP" && simulator &&
        (recipe.adapter.facilityIds.length !== 1 || recipe.adapter.officialIdentityProof || recipe.adapter.officialBookingSourceProof))
      ctx.addIssue({ code: "custom", message: "Simulator adapter requires one exact directory identity" });
    return;
  }
  if (recipe.engine === "BROWSER_JSON") {
    const fence = recipe.availabilityResponse;
    if (recipe.target.kind !== "SIMULATOR" || !recipe.target.offeringId || fence.kind === "SERVER_DOCUMENT" || fence.method !== "GET" ||
        fence.date.source !== "QUERY" || fence.date.path !== "start_date" || fence.date.format !== "MM-DD-YYYY" || fence.endDatePath ||
        !fence.success || !browserJsonPath.safeParse(fence.success.path).success)
      ctx.addIssue({ code: "custom", message: "Browser JSON requires a simulator offering and explicit successful public participant/date response" });
    const sample: AccessExecutionInput = { date: "2030-01-02", timeZone: recipe.source.timeZone, players: 2, durationMinutes: 60, startTime: "10:00", endTime: "20:00" };
    try {
      const url = expandRecipeTemplate(fence.url, sample, true), entry = new URL(recipe.source.bookingUrl);
      const page = new URL(expandRecipeTemplate(recipe.pageUrl, sample, true));
      const venue = /^\/reservations\/([a-z0-9]+(?:[-_][a-z0-9]+)*)$/u.exec(entry.pathname)?.[1];
      if (!isSafeBrowserAvailabilityReadUrl(url, "fetch", "GET") || entry.origin !== "https://www.sevenrooms.com" ||
          !venue || page.origin !== entry.origin || page.pathname !== entry.pathname ||
          new URL(url).searchParams.get("venue") !== venue || recipe.pageUrl.includes("{{players}}") ||
          fence.url.replace("party_size={{players}}", "party_size=2").includes("{{players}}") ||
          recipe.steps.some(step => JSON.stringify(step).includes("{{players}}") &&
            (!(step.action === "select" || step.action === "fill") || step.purpose !== "PLAYERS" || step.value !== "{{players}}")))
        ctx.addIssue({ code: "custom", message: "Browser JSON participant binding requires the exact public venue/range role" });
    } catch { ctx.addIssue({ code: "custom", message: "Invalid browser JSON participant response" }); }
    return;
  }
  if (recipe.engine === "BROWSER_DOM" && recipe.target.kind !== "SIMULATOR" &&
      recipe.steps.some(step => ["selectRentalService", "continueToAvailability"].includes(step.action)))
    ctx.addIssue({ code: "custom", message: "Rental-service navigation requires a simulator target" });
  const dateFields = "kind" in recipe.proof.date ? [recipe.proof.date.monthYear, recipe.proof.date.day] : [recipe.proof.date];
  const readers = [recipe.proof.venue, ...dateFields, recipe.proof.complete, recipe.proof.empty, recipe.proof.players,
    recipe.proof.durationMinutes, recipe.slots.startsAt, recipe.slots.endsAt, recipe.slots.availableSpots,
    recipe.slots.holes, recipe.slots.resourceId, recipe.slots.productId, recipe.slots.minimumPlayers, recipe.slots.capacity,
    recipe.slots.scope?.label].filter(value => value && !("derive" in value) && !("availabilityResponse" in value) && !("serverDocument" in value)) as RecipeField[];
  if (readers.some(field => recipe.engine === "HTTP_JSON" ? !("path" in field) : !("selector" in field)) ||
    (recipe.engine === "HTTP_JSON") !== ("path" in recipe.slots.collection)) ctx.addIssue({ code: "custom", message: "Field readers must match the engine" });
  if (recipe.engine === "HTTP_JSON" && "kind" in recipe.proof.date) ctx.addIssue({ code: "custom", message: "DATE_PARTS requires visible DOM fields" });
  if (recipe.engine === "HTTP_JSON" && "availabilityResponse" in recipe.proof.complete)
    ctx.addIssue({ code: "custom", message: "Response completion requires the browser response fence" });
  if (recipe.engine === "HTTP_JSON" && "serverDocument" in recipe.proof.complete)
    ctx.addIssue({ code: "custom", message: "Server document completion requires the browser response fence" });
  if (recipe.engine === "BROWSER_DOM") {
    const serverDocument = recipe.availabilityResponse.kind === "SERVER_DOCUMENT";
    if (serverDocument !== ("serverDocument" in recipe.proof.complete) || serverDocument &&
      (recipe.target.kind !== "OUTDOOR" || "kind" in recipe.proof.date || readers.some(field => !("selector" in field)) ||
        !("selector" in recipe.slots.collection)))
      ctx.addIssue({ code: "custom", message: "Server document proof requires outdoor static selectors and matching completion" });
    if (serverDocument) {
      for (const [section, fields] of [["proof", recipe.proof], ["slots", recipe.slots]] as const) {
        for (const [name, field] of Object.entries(fields)) {
          if (field && "selector" in field && !isServerDocumentSelector(field.selector))
            ctx.addIssue({ code: "custom", path: [section, name, "selector"], message: SERVER_DOCUMENT_SELECTOR_MESSAGE });
        }
      }
    }
  }
  if (recipe.engine === "BROWSER_DOM" && "availabilityResponse" in recipe.proof.complete && !recipe.availabilityResponse.success)
    ctx.addIssue({ code: "custom", message: "Response-only completion requires an application-level JSON success guard" });
  if (recipe.slots.scope && (recipe.engine !== "BROWSER_DOM" || recipe.target.kind !== "SIMULATOR"))
    ctx.addIssue({ code: "custom", message: "Resource scopes apply only to simulator DOM cards" });
  if (recipe.engine === "BROWSER_DOM" && recipe.target.kind === "SIMULATOR" && !recipe.slots.scope)
    ctx.addIssue({ code: "custom", message: "Simulator DOM recipes require a labelled resource-card scope" });
  if (recipe.engine === "HTTP_JSON" && recipe.request.method === "GET" && recipe.request.body) ctx.addIssue({ code: "custom", message: "GET cannot carry a body" });
  const productSelection = recipe.engine === "BROWSER_DOM" && recipe.steps.some(step => step.action === "selectProduct");
  if (recipe.target.kind === "OUTDOOR" && !recipe.slots.availableSpots)
    ctx.addIssue({ code: "custom", message: "Outdoor recipes require available-player evidence" });
  if (recipe.target.kind === "SIMULATOR" && (!recipe.target.offeringId || (!recipe.proof.durationMinutes && !productSelection) || !recipe.slots.endsAt))
    ctx.addIssue({ code: "custom", message: "Simulator recipes require offering, duration and end-time proof" });
  if (recipe.slots.endsAt && "derive" in recipe.slots.endsAt && recipe.target.kind !== "SIMULATOR")
    ctx.addIssue({ code: "custom", message: "Only proven simulator rentals can derive their end time" });
  if (recipe.target.kind === "SIMULATOR" && JSON.stringify(recipe.engine === "HTTP_JSON" ? recipe.request :
    { pageUrl: recipe.pageUrl, steps: recipe.steps }).includes("{{players}}"))
    ctx.addIssue({ code: "custom", message: "Simulator player count is saved context and cannot parameterize availability" });
  if (recipe.target.kind === "SIMULATOR" && recipe.engine === "BROWSER_DOM" && recipe.steps.some(step =>
    (step.action === "select" || step.action === "fill") && step.purpose === "PLAYERS" && step.value !== "1"))
    ctx.addIssue({ code: "custom", message: "Simulator availability may request only one bay; saved players are context" });
});
export type CourseAccessRecipeData = z.infer<typeof accessRecipeSchema>;
export function parseAccessRecipe(input: unknown): CourseAccessRecipeData { return accessRecipeSchema.parse(input); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function hashAccessRecipe(recipe: CourseAccessRecipeData) { return createHash("sha256").update(canonical(parseAccessRecipe(recipe))).digest("hex"); }
export function recipeAllowsRequest(recipe: CourseAccessRecipeData, value: string, method: string, resourceType?: string) {
  if (recipe.engine === "EXISTING_ADAPTER") return false; // Fixed adapter transport owns its exact routes.
  if (!isSafeRecipeUrl(value) && !isSafeBrowserAssetUrl(value, resourceType ?? "", method) &&
    !((recipe.engine === "BROWSER_DOM" || recipe.engine === "BROWSER_JSON") && (isSafeBrowserBootstrapReadUrl(value, resourceType ?? "", method) ||
      isSafeBrowserAvailabilityReadUrl(value, resourceType ?? "", method)))) return false;
  const url = new URL(value);
  return recipe.permittedRoutes.some(route => route.origin === url.origin && route.methods.includes(method as "GET" | "HEAD" | "POST") &&
    (route.path.endsWith("*") ? url.pathname.startsWith(route.path.slice(0, -1)) : route.path === url.pathname) &&
    [...url.searchParams.keys()].every(key => route.queryKeys.includes(key)));
}
export const accessExecutionDiagnosticSchema = z.object({
  code: z.string().regex(/^[A-Z_0-9]{1,80}$/u), stepIndex: z.number().int().min(0).max(31).optional(),
  url: z.string().max(2048).refine(value => {
    try { const url = new URL(value); return !url.search && !url.hash &&
      (isSafeRecipeUrl(value) || isSafeBrowserAssetUrl(value, "script", "GET") || isSafeBrowserAssetUrl(value, "stylesheet", "GET")); } catch { return false; }
  }).optional(),
  method: z.enum(["GET", "HEAD", "POST", "OPTIONS"]).optional(),
  resourceType: z.enum(["document", "stylesheet", "image", "media", "font", "script", "xhr", "fetch", "other"]).optional(),
  simulatorError: z.object({
    code: z.enum(["INVALID_SOURCE", "INVALID_REQUEST", "UNSUPPORTED_PROVIDER", "UNSUPPORTED_DURATION", "PARTY_TOO_LARGE", "PUBLIC_SESSION_REQUIRED", "HTTP_ERROR", "SCHEMA_CHANGED"]),
    retryable: z.boolean(), httpStatus: z.number().int().min(100).max(599).optional(),
  }).strict().optional(),
}).strict();
export type AccessExecutionDiagnostic = z.infer<typeof accessExecutionDiagnosticSchema>;

export const accessExecutionResultSchema = z.object({
  status: z.enum(["AVAILABLE", "EMPTY", "INCOMPLETE", "ACCESS_REQUIRED", "FAILED"]), complete: z.boolean(),
  observedAt: z.string().datetime(), sourceUrl: safeUrl,
  slots: z.array(z.object({ sourceId: z.string().min(1).max(128), startsAt: z.string().datetime(), endsAt: z.string().datetime().optional(),
    availableSpots: z.number().int().min(1).max(100), capacity: z.number().int().min(1).max(100).nullable().optional(), holes: z.union([z.literal(9), z.literal(18)]).optional(),
    bookingUrl: safeUrl, resourceId: z.string().min(1).max(128).optional(), productId: z.string().min(1).max(128).optional() }).strict()).max(500),
  evidence: z.object({ recipeHash: z.string().regex(/^[a-f0-9]{64}$/u), venueVerified: z.boolean(), dateVerified: z.boolean(),
    capacityVerified: z.boolean(), durationVerified: z.boolean(), completeVerified: z.boolean(), reason: z.string().max(120).optional(),
    diagnostic: accessExecutionDiagnosticSchema.optional() }).strict(),
}).strict().superRefine((result, ctx) => {
  if ((result.status === "AVAILABLE" && (!result.complete || !result.slots.length)) ||
    (result.status === "EMPTY" && (!result.complete || result.slots.length)) ||
    (!["AVAILABLE", "EMPTY"].includes(result.status) && (result.complete || result.slots.length)))
    ctx.addIssue({ code: "custom", message: "Result status must agree with completeness and slots" });
  if (result.complete && ![result.evidence.venueVerified, result.evidence.dateVerified, result.evidence.capacityVerified,
    result.evidence.durationVerified, result.evidence.completeVerified].every(Boolean))
    ctx.addIssue({ code: "custom", message: "Complete results require every applicable proof" });
});
export type AccessExecutionResult = z.infer<typeof accessExecutionResultSchema>;

export function readRecipeFieldFormat(field: RecipeField, value: unknown): unknown {
  // Venue claims retain the complete source text through raw/live parity.
  // Only normalize() may interpret this opt-in identity grammar afterwards.
  if (!field.format || field.format === "VENUE_GREETING" || field.format === "VENUE_SELECT_TIME") return value;
  if (field.format === "INTEGER") {
    const match = /^(\d+)(?:\s+(?:players?|people|spots?|available))?$/iu.exec(String(value ?? "").trim());
    return match ? Number(match[1]) : undefined;
  }
  return publicRentalDurationMinutes(String(value ?? ""));
}
/** This intentionally recognizes duration units, never price or appointment time. */
export function publicRentalDurationMinutes(value: string): number | undefined {
  const durations = [...value.matchAll(/\b(\d+(?:\.\d+)?)\s*(hours?|hrs?|hr|minutes?|mins?|min)\b/giu)]
    .map(match => Number(match[1]) * (/^h/iu.test(match[2]) ? 60 : 1));
  const unique = [...new Set(durations)];
  return unique.length === 1 && Number.isInteger(unique[0]) && unique[0] >= 15 && unique[0] <= 480 ? unique[0] : undefined;
}

/** A mention in booking instructions is not a current access gate. */
export function isActiveBrowserAccessChallenge(text: string, title = "") {
  if (/^(?:just a moment[.!…]*|access denied|human verification|security verification|waiting room)$/iu.test(title.trim())) return true;
  const prefix = text.replace(/\s+/gu, " ").trim().slice(0, 800);
  return /\b(?:verify (?:that )?you are human|checking your browser|performing security verification|you (?:must|need to) (?:log|sign) in to (?:view|continue))\b/iu.test(prefix) && text.length < 6000;
}
