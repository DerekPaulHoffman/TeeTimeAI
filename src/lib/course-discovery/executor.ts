import { createHash } from "node:crypto";
import type { Browser, Locator } from "@playwright/test";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { createPassfactoryPublicReadPolicy, isIncidentalBrowserRequest, isNonEvidenceBrowserResource } from "@/lib/automation/passfactory-public-read-policy";
import { isAnonymousBrowserReadPost } from "@/lib/automation/simulator-interactive-browser";
import { addVerifiedMindbodyReadHeaders } from "@/lib/automation/mindbody-public-read-policy";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { getTimeZoneOffsetMinutes } from "@/lib/timezones";
import { accessExecutionDiagnosticSchema, accessExecutionInputSchema, accessExecutionResultSchema, expandRecipeTemplate, hashAccessRecipe,
  parseAccessRecipe, recipeAllowsRequest, type AccessExecutionInput, type AccessExecutionResult,
  readRecipeFieldFormat, isActiveBrowserAccessChallenge, type AccessExecutionDiagnostic, type CourseAccessRecipeData, type RecipeDateParts, type RecipeField } from "./recipe";
import { continueNativeBrowserRead, createNativePublicBrowserProxy, nativeReadPreflightMethod, type NativePublicProxy } from "./native-public-browser";
import { installNativeRedirectRouting, type NativeReadRoute } from "./native-redirect-routing";
import { requestFamilyForUrl } from "./request-family";
import { canonicalPublicReadUrl } from "./public-request-url";
import { canonicalCpsPublicUrl, cpsSessionKey, createCpsPublicSessionScope } from "./cps-public-navigation";
import { executeExistingAdapterRecipe } from "./existing-adapter-executor";
import { selectPublicFilter } from "./public-filter-control";
import { selectPublicCalendarDate } from "./public-calendar-control";
import { applyPublicCalendarDate } from "./public-calendar-apply";
import { hasInspectedPassfactoryDurationClients, isInspectedPassfactoryDurationClient, isPassfactoryDurationClientUrl, isPassfactoryAvailabilityRequest, isPassfactoryDurationContext,
  isPassfactoryDurationRequestBound, type PublicAvailabilityRequest } from "./passfactory-client-duration";
import { extractServerDocument, sameServerDocumentEvidence, type ServerDocumentExtraction } from "./server-document-proof";
import { PUBLIC_BROWSER_TOTAL_BYTES, PUBLIC_BROWSER_TUNNEL_BYTES, publicBrowserResponseLimit } from "./browser-resource-limits";
import { isObservedPublicCalendarDay } from "./public-calendar-day";
import { selectPublicRentalProduct } from "./public-product-control";
import { followPublicAvailabilityLink } from "./public-navigation-control";
import { selectPublicDateChoice } from "./public-date-choice";

type ExtractedAccessRecipe = Exclude<CourseAccessRecipeData, { engine: "EXISTING_ADAPTER" }>;

export type AccessExecutorDependencies = {
  fetch?: typeof fetch;
  now?: () => Date;
  deadlineAt?: Date;
  launchBrowser?: () => Promise<Browser>;
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }>;
};
type Extracted = { venue: unknown; date: unknown; complete: unknown; empty: unknown; players: unknown; duration: unknown;
  rows: Array<Record<string, unknown>> };
const forbiddenControl = /\b(?:login|sign in|sign up|register|checkout|pay|payment|purchase|buy|book|cart|reserve|confirm|submit|cancel|delete|send|subscribe|password|email|phone)\b/iu;
const clean = (value: unknown) => String(value ?? "").replace(/\s+/gu, " ").trim();
/** Public providers often append a category label to the same venue name.
 * This only normalizes observed proof; canonical recipe/source binding stays exact. */
export function venueProofMatches(canonical: string, observed: unknown) {
  const compact = (value: unknown) => clean(value).normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]/gu, "");
  const expected = compact(canonical), actual = compact(observed);
  if (expected === actual) return true;
  const core = (value: string) => value.replace(/golf(?:course|club)$/u, "");
  const expectedCore = core(expected), actualCore = core(actual);
  return expectedCore === actualCore && expectedCore.length >= 8 &&
    !/^(?:the)?(?:golf|course|club|public|municipal|country)+$/u.test(expectedCore);
}
export function recipeExecutionDiagnostic(error: unknown, context: { stepIndex?: number; url?: string; method?: string; resourceType?: string } = {}): AccessExecutionDiagnostic {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = /^[A-Z_0-9]{1,80}$/u.test(message) ? message
    : /timeout/iu.test(message) ? (context.stepIndex === undefined ? "REQUEST_TIMEOUT" : "STEP_TIMEOUT")
    : /strict mode|resolved to \d+ elements/iu.test(message) ? "AMBIGUOUS_SELECTOR"
    : /evaluate:|__name is not defined/iu.test(message) ? "BROWSER_EVALUATION_FAILED"
    : /selectOption:/iu.test(message) ? "SELECT_OPTION_FAILED"
    : /fill:/iu.test(message) ? "FILL_FAILED"
    : /click:/iu.test(message) ? "CLICK_FAILED"
    : /goto:|net::ERR_/iu.test(message) ? "NAVIGATION_FAILED" : "EXECUTION_FAILED";
  const diagnostic: AccessExecutionDiagnostic = { code };
  if (Number.isInteger(context.stepIndex) && context.stepIndex! >= 0 && context.stepIndex! <= 31) diagnostic.stepIndex = context.stepIndex;
  if (["GET", "HEAD", "POST", "OPTIONS"].includes(context.method ?? "")) diagnostic.method = context.method as AccessExecutionDiagnostic["method"];
  if (["document", "stylesheet", "image", "media", "font", "script", "xhr", "fetch", "other"].includes(context.resourceType ?? "")) diagnostic.resourceType = context.resourceType as AccessExecutionDiagnostic["resourceType"];
  try {
    const url = new URL(context.url ?? ""); url.search = ""; url.hash = "";
    if (accessExecutionDiagnosticSchema.safeParse({ code, url: url.href }).success) diagnostic.url = url.href;
  } catch { /* No unsafe or unparseable URL enters diagnostic feedback. */ }
  return diagnostic;
}
function matchesAvailabilityRequest(recipe: Extract<CourseAccessRecipeData, { engine: "BROWSER_DOM" }>, input: AccessExecutionInput,
  request: { url: string; method: string; body?: string | null }) {
  const fence = recipe.availabilityResponse;
  if (request.method !== fence.method || request.url !== expandRecipeTemplate(fence.url, input, true)) return false;
  try {
    const source = fence.date.source === "QUERY" ? new URL(request.url).searchParams : JSON.parse(request.body ?? "");
    const read = (path: string) => source instanceof URLSearchParams ? source.get(path) : jsonField(source, { path });
    return read(fence.date.path) === input.date && (!fence.endDatePath || read(fence.endDatePath) === input.date);
  } catch { return false; }
}
export function matchesAvailabilityResponse(recipe: Extract<CourseAccessRecipeData, { engine: "BROWSER_DOM" }>, input: AccessExecutionInput,
  request: { url: string; method: string; body?: string | null }, status: number, responseBody?: string | Uint8Array) {
  if (status < 200 || status >= 300 || !matchesAvailabilityRequest(recipe, input, request)) return false;
  const success = recipe.availabilityResponse.success;
  if (!success) return true;
  try {
    const body = JSON.parse(typeof responseBody === "string" ? responseBody : Buffer.from(responseBody ?? []).toString("utf8"));
    return Object.is(jsonField(body, { path: success.path }), success.equals);
  } catch { return false; }
}
const affirmative = (value: unknown) => value === true || value === 1 || /^(?:true|1|complete|ready|loaded)$/iu.test(clean(value));
const explicitEmpty = (value: unknown) => value === true || value === 1 || /^(?:true|1)$/iu.test(clean(value)) ||
  clean(value).length <= 300 && (/\bno\s+(?:(?:available|matching)\s+)?(?:tee[ -]?times?|appointment times?|appointments?|openings?|time slots?|slots?|sessions?|results?|availability)\b/iu.test(clean(value)) ||
    /^(?:sold out|fully booked)[.!]?$/iu.test(clean(value)));
function jsonField(root: unknown, field: RecipeField | undefined): unknown {
  if (!field || !("path" in field)) return undefined;
  let value = root;
  for (const key of field.path.split(".")) {
    if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return readRecipeFieldFormat(field, value);
}
function extractJson(recipe: ExtractedAccessRecipe, body: unknown): Extracted {
  const p = recipe.proof;
  const collection = "path" in recipe.slots.collection ? jsonField(body, recipe.slots.collection) : undefined;
  if (!Array.isArray(collection) || collection.length > 500) throw new Error("INCOMPLETE_COLLECTION");
  const fields = Object.entries(recipe.slots).filter(([key]) => key !== "collection" && key !== "scope") as Array<[string, RecipeField]>;
  return { venue: jsonField(body, p.venue), date: jsonField(body, "kind" in p.date ? undefined : p.date), complete: jsonField(body, "availabilityResponse" in p.complete || "serverDocument" in p.complete ? undefined : p.complete),
    empty: jsonField(body, p.empty), players: jsonField(body, p.players), duration: jsonField(body, p.durationMinutes),
    rows: collection.map(row => Object.fromEntries(fields.map(([key, field]) => [key, jsonField(row, field)]))) };
}
function localParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}T${byType.hour}:${byType.minute}:${byType.second}`;
}
function parseSourceDate(value: unknown) {
  const text = clean(value).replace(/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*,?\s*/iu, "")
    .replace(/([A-Za-z])(\d)/gu, "$1 $2");
  if (/^\d{4}-\d{2}-\d{2}(?:T|$)/u.test(text)) return text.slice(0, 10);
  const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(text);
  if (numeric) return `${numeric[3]}-${numeric[1].padStart(2, "0")}-${numeric[2].padStart(2, "0")}`;
  const written = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\s*,?\s*(\d{4})$/iu.exec(text);
  if (written) {
    const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(written[1].toLowerCase()) + 1;
    return `${written[3]}-${String(month).padStart(2, "0")}-${written[2].padStart(2, "0")}`;
  }
  return text;
}
/** Reject DST gaps and ambiguous local wall times; an explicit offset disambiguates. */
export function recipeTimeToInstant(value: unknown, input: AccessExecutionInput) {
  let text = clean(value);
  text = text.replace(/(T\d{2}:\d{2}:\d{2})\.(\d{1,9})(?=Z|[+-]\d{2}:\d{2}|$)/u,
    (_, seconds: string, fraction: string) => `${seconds}.${fraction.slice(0, 3).padEnd(3, "0")}`);
  const clock = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\s*(AM|PM)?$/iu.exec(text);
  if (clock) {
    let hour = Number(clock[1]);
    if (clock[4]) { if (hour < 1 || hour > 12) throw new Error("INVALID_SLOT_TIME"); hour = hour % 12 + (clock[4].toUpperCase() === "PM" ? 12 : 0); }
    if (hour > 23) throw new Error("INVALID_SLOT_TIME");
    text = `${input.date}T${String(hour).padStart(2, "0")}:${clock[2]}:${clock[3] ?? "00"}`;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(text)) {
    const date = new Date(text);
    if (!Number.isFinite(date.getTime())) throw new Error("INVALID_SLOT_TIME");
    return date;
  }
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{3})?)?$/u.test(text)) throw new Error("INVALID_SLOT_TIME");
  if (text.length === 16) text += ":00";
  const fraction = /\.\d{3}$/u.exec(text)?.[0] ?? "";
  if (fraction) text = text.slice(0, -4);
  const wall = Date.parse(`${text}Z`);
  const offsets = new Set([-36, 0, 36].map(hours => getTimeZoneOffsetMinutes(new Date(wall + hours * 3_600_000), input.timeZone)));
  const matches = [...offsets].map(offset => new Date(wall - offset * 60_000)).filter(date => localParts(date, input.timeZone) === text);
  if (matches.length !== 1) throw new Error("AMBIGUOUS_OR_INVALID_LOCAL_TIME");
  return new Date(matches[0].getTime() + Number(fraction || 0) * 1000);
}
function boundedNumber(value: unknown, maximum: number) {
  const text = clean(value);
  if (!/^\d+$/u.test(text)) throw new Error("INVALID_CAPACITY_OR_DURATION");
  const number = Number(text);
  if (!Number.isInteger(number) || number < 1 || number > maximum) throw new Error("INVALID_CAPACITY_OR_DURATION");
  return number;
}
function normalize(recipe: ExtractedAccessRecipe, input: AccessExecutionInput, data: Extracted, now: Date): AccessExecutionResult {
  const simulator = recipe.target.kind === "SIMULATOR";
  const evidence = { recipeHash: hashAccessRecipe(recipe), venueVerified: venueProofMatches(recipe.source.venueName, data.venue),
    dateVerified: parseSourceDate(data.date) === input.date, capacityVerified: simulator,
    durationVerified: recipe.target.kind === "OUTDOOR", completeVerified: affirmative(data.complete) };
  const result = (status: AccessExecutionResult["status"], reason?: string, slots: AccessExecutionResult["slots"] = []): AccessExecutionResult =>
    accessExecutionResultSchema.parse({ status, complete: status === "AVAILABLE" || status === "EMPTY", observedAt: now.toISOString(),
      sourceUrl: recipe.source.bookingUrl, slots, evidence: { ...evidence, ...(reason ? { reason, diagnostic: { code: reason } } : {}) } });
  if (!evidence.venueVerified || !evidence.dateVerified || !evidence.completeVerified) return result("INCOMPLETE", "SOURCE_PROOF_MISMATCH");
  // Simulator player count is saved context. A full rental is one available
  // bay; public capacity, when known, remains descriptive metadata only.
  if (!simulator && data.players !== undefined && boundedNumber(data.players, 100) !== input.players) return result("INCOMPLETE", "PLAYER_FILTER_MISMATCH");
  if (recipe.target.kind === "SIMULATOR") {
    if (!input.durationMinutes || boundedNumber(data.duration, 480) !== input.durationMinutes) return result("INCOMPLETE", "DURATION_PROOF_MISMATCH");
    evidence.durationVerified = true;
  }
  const windowStart = recipeTimeToInstant(`${input.date}T${input.startTime}:00`, input);
  const endDate = input.endTime === "24:00"
    ? new Date(Date.parse(`${input.date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
    : input.date;
  const windowEnd = recipeTimeToInstant(`${endDate}T${input.endTime === "24:00" ? "00:00" : input.endTime}:00`, input);
  if (!data.rows.length) {
    evidence.capacityVerified = simulator || data.players !== undefined && boundedNumber(data.players, 100) === input.players;
    return explicitEmpty(data.empty) && evidence.capacityVerified ? result("EMPTY") : result("INCOMPLETE", "EMPTY_NOT_PROVEN");
  }
  const slots: AccessExecutionResult["slots"] = [];
  for (const row of data.rows) {
    const start = recipeTimeToInstant(row.startsAt, input);
    const local = localParts(start, input.timeZone);
    if (local.slice(0, 10) !== input.date) return result("INCOMPLETE", "WRONG_SLOT_DATE");
    const availableSpots = simulator ? 1 : boundedNumber(row.availableSpots, 100);
    const minimumPlayers = simulator || row.minimumPlayers === undefined ? 1 : boundedNumber(row.minimumPlayers, 100);
    const capacityText = clean(row.capacity);
    const capacity = /^\d+$/u.test(capacityText) && Number(capacityText) >= 1 && Number(capacityText) <= 100 ? Number(capacityText) : null;
    if (minimumPlayers > availableSpots) return result("INCOMPLETE", "INVALID_CAPACITY_RANGE");
    const end = recipe.slots.endsAt && "derive" in recipe.slots.endsAt
      ? new Date(start.getTime() + input.durationMinutes! * 60_000)
      : row.endsAt === undefined ? undefined : recipeTimeToInstant(row.endsAt, input);
    if (end && end <= start) return result("INCOMPLETE", "INVALID_SLOT_DURATION");
    if (recipe.target.kind === "SIMULATOR" && (!end || end.getTime() - start.getTime() !== input.durationMinutes! * 60_000))
      return result("INCOMPLETE", "SLOT_DURATION_MISMATCH");
    const holes = simulator || row.holes === undefined ? undefined : boundedNumber(row.holes, 18);
    if (holes !== undefined && holes !== 9 && holes !== 18) return result("INCOMPLETE", "INVALID_HOLES");
    const resourceId = row.resourceId === undefined ? undefined : clean(row.resourceId);
    const productId = row.productId === undefined ? undefined : clean(row.productId);
    if ((resourceId !== undefined && (!resourceId || resourceId.length > 128)) || (productId !== undefined && (!productId || productId.length > 128))) return result("INCOMPLETE", "INVALID_RESOURCE_IDENTITY");
    if ((!simulator && (availableSpots < input.players || minimumPlayers > input.players)) || start <= now ||
      start < windowStart || start >= windowEnd || (end && end > windowEnd)) continue;
    const startsAt = start.toISOString();
    const sourceId = createHash("sha256").update([recipe.target.courseId, recipe.target.offeringId ?? "", resourceId ?? "", productId ?? "", startsAt, end?.toISOString() ?? "", String(holes ?? "")].join("\n")).digest("hex");
    slots.push({ sourceId, startsAt, ...(end ? { endsAt: end.toISOString() } : {}), availableSpots, ...(simulator ? { capacity } : {}),
      ...(holes ? { holes: holes as 9 | 18 } : {}), bookingUrl: recipe.source.bookingUrl,
      ...(resourceId ? { resourceId } : {}), ...(productId ? { productId } : {}) });
  }
  evidence.capacityVerified = true;
  const byId = new Map<string, AccessExecutionResult["slots"][number]>();
  for (const slot of slots) {
    if (byId.has(slot.sourceId) && JSON.stringify(byId.get(slot.sourceId)) !== JSON.stringify(slot)) return result("INCOMPLETE", "CONFLICTING_SLOT_EVIDENCE");
    byId.set(slot.sourceId, slot);
  }
  const unique = [...byId.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.sourceId.localeCompare(b.sourceId));
  return result(unique.length ? "AVAILABLE" : "EMPTY", undefined, unique);
}
async function domField(root: Locator, field: RecipeField | undefined): Promise<unknown> {
  if (!field || !("selector" in field)) return undefined;
  const node = root.locator(field.selector);
  const count = await node.count();
  if (count > 1) throw new Error("AMBIGUOUS_PROOF_FIELD");
  if (count !== 1 || !(await node.isVisible())) return undefined;
  let value: unknown;
  if (field.attribute === "value") value = await node.inputValue();
  else if (field.attribute === "selected-label") value = await node.evaluate(element => element instanceof HTMLSelectElement ? element.selectedOptions[0]?.textContent : null);
  else if (field.attribute) value = await node.getAttribute(field.attribute);
  else value = await node.innerText();
  return readRecipeFieldFormat(field, value);
}
export function parseObservedCalendarDate(monthYear: unknown, day: unknown): string | undefined {
  const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const month = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/iu.exec(clean(monthYear));
  if (!month || !/^(?:[1-9]|[12]\d|3[01])$/u.test(clean(day))) return undefined;
  const result = `${month[2]}-${String(monthNames.indexOf(month[1].toLowerCase()) + 1).padStart(2, "0")}-${clean(day).padStart(2, "0")}`;
  const date = new Date(`${result}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === result ? result : undefined;
}
async function domDateParts(root: Locator, field: RecipeDateParts) {
  const day = root.locator(field.day.selector);
  if (await day.count() !== 1 || !await day.isVisible()) return undefined;
  const selected = await day.evaluate(element => element.getAttribute("aria-selected") === "true" ||
    element.getAttribute("aria-current") === "date" || element.getAttribute("data-selected") === "true" ||
    element.classList.contains("Mui-selected") || element.classList.contains("active") && element.classList.contains("day"));
  if (!selected) return undefined;
  return parseObservedCalendarDate(await domField(root, field.monthYear), await domField(root, field.day));
}
async function extractDom(recipe: ExtractedAccessRecipe, root: Locator): Promise<Extracted> {
  const p = recipe.proof;
  const rows: Extracted["rows"] = [];
  if (!("selector" in recipe.slots.collection)) throw new Error("INVALID_COLLECTION");
  let collectionRoot = root;
  let observedResourceId: string | undefined;
  const scope = recipe.slots.scope;
  if (scope) {
    const groups = root.locator(scope.selector);
    if (await groups.count() > 100) throw new Error("AMBIGUOUS_RESOURCE_SCOPE");
    const matching: Locator[] = [];
    for (const group of await groups.all()) {
      if (!await group.isVisible()) continue;
      const forbiddenRoot = await group.evaluate(element => ["BODY", "HTML", "MAIN"].includes(element.tagName));
      if (forbiddenRoot) throw new Error("INVALID_RESOURCE_SCOPE");
      const label = clean(await domField(group, scope.label));
      if (label === clean(scope.expectedLabel)) {
        if (!("selector" in scope.label) || !await group.evaluate((element, selector) => {
          const labels = element.querySelectorAll(selector);
          return labels.length === 1 && labels[0].parentElement === element;
        }, scope.label.selector) || await group.locator(scope.selector).count() > 0) throw new Error("RESOURCE_SCOPE_NOT_CARD");
        matching.push(group);
        // This is an internal identity for the observed card label, not a
        // claimed provider ID. Actual provider IDs below take precedence.
        observedResourceId = `dom-label:${createHash("sha256").update(label).digest("hex")}`;
      }
    }
    if (!matching.length) throw new Error("RESOURCE_IDENTITY_MISMATCH");
    if (matching.length !== 1) throw new Error("AMBIGUOUS_RESOURCE_SCOPE");
    collectionRoot = matching[0];
  }
  const elements = collectionRoot.locator(recipe.slots.collection.selector);
  if (await elements.count() > 500) throw new Error("INCOMPLETE_COLLECTION");
  if (scope && "selector" in scope.label && !await collectionRoot.evaluate((card, selectors) => {
    const label = card.querySelector(selectors.label);
    if (!label) return false;
    const rows = Array.from(card.querySelectorAll(selectors.rows)).filter(element =>
      element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
    const parents = new Set(rows.map(row => row.parentElement));
    if (parents.size > 1 || [...parents].some(parent => parent !== card && parent?.parentElement !== card)) return false;
    const resourceText = /(?:^|\W)(?:simulators?|rentals?|bays?|rooms?|multi[-\s]?sport|baseball|soccer|hockey|tennis)(?:\W|\d|$)/iu;
    const descendants = card.querySelectorAll("*");
    if (descendants.length > 2000) return false;
    for (const node of Array.from(descendants)) {
      if (node === label || label.contains(node) || rows.some(row => row === node || row.contains(node)) ||
        ["BUTTON", "INPUT", "SELECT", "OPTION", "SCRIPT", "STYLE"].includes(node.tagName) || !node.getClientRects().length) continue;
      const directText = Array.from(node.childNodes).filter(child => child.nodeType === Node.TEXT_NODE)
        .map(child => child.textContent).join(" ").replace(/\s+/gu, " ").trim();
      if (directText.length > 0 && directText.length <= 160 && resourceText.test(directText)) return false;
    }
    return true;
  }, { label: scope.label.selector, rows: recipe.slots.collection.selector })) throw new Error("RESOURCE_SCOPE_NOT_CARD");
  for (const element of await elements.all()) {
    if (!await element.isVisible()) continue;
    const row: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(recipe.slots)) if (key !== "collection" && key !== "scope") row[key] = await domField(element, field as RecipeField);
    if (row.resourceId === undefined && observedResourceId) row.resourceId = observedResourceId;
    rows.push(row);
  }
  return { venue: await domField(root, p.venue), date: "kind" in p.date ? await domDateParts(root, p.date) : await domField(root, p.date), complete: "availabilityResponse" in p.complete || "serverDocument" in p.complete ? true : await domField(root, p.complete),
    empty: await domField(scope ? collectionRoot : root, p.empty), players: await domField(root, p.players), duration: await domField(root, p.durationMinutes), rows };
}

export async function executeAccessRecipe(recipeValue: CourseAccessRecipeData, inputValue: AccessExecutionInput,
  deps: AccessExecutorDependencies = {}): Promise<AccessExecutionResult> {
  const recipe = parseAccessRecipe(recipeValue);
  const input = accessExecutionInputSchema.parse(inputValue);
  const clock = deps.now ?? (() => new Date());
  const now = clock();
  let activity: { stepIndex?: number; url?: string; method?: string; resourceType?: string } = {};
  let failure: AccessExecutionDiagnostic | undefined;
  let providerThrottled = false;
  const fail = (status: AccessExecutionResult["status"], reason: string): AccessExecutionResult => ({ status, complete: false,
    observedAt: clock().toISOString(), sourceUrl: recipe.source.bookingUrl, slots: [], evidence: { recipeHash: hashAccessRecipe(recipe),
      venueVerified: false, dateVerified: false, capacityVerified: false, durationVerified: false, completeVerified: false, reason,
      diagnostic: failure ?? recipeExecutionDiagnostic(reason, activity) } });
  if (input.timeZone !== recipe.source.timeZone || input.date < localParts(now, input.timeZone).slice(0, 10)) return fail("INCOMPLETE", "INVALID_REQUEST_DATE_OR_ZONE");
  const deadline = Math.min(deps.deadlineAt?.getTime() ?? Infinity, now.getTime() + 120_000);
  if (deadline <= now.getTime()) return fail("FAILED", "DEADLINE_EXCEEDED");
  if (recipe.engine === "EXISTING_ADAPTER") return executeExistingAdapterRecipe(recipe, input, {
    ...deps, recipeHash: hashAccessRecipe(recipe), venueMatches: venueProofMatches, toInstant: recipeTimeToInstant,
  });
  const cancellation = new AbortController();
  const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, deadline - now.getTime())), cancellation.signal]);
  const passfactory = createPassfactoryPublicReadPolicy();
  passfactory.observeWidgetUrl(recipe.source.bookingUrl);
  const allowsPost = (url: URL, headers: Headers, body: string) => recipeAllowsRequest(recipe, url.href, "POST") &&
    (isAnonymousBrowserReadPost(url, headers, body) || passfactory.allows(url, headers, body));
  const requestQueue = createSimulatorBrowserRequestQueue(deps.requestLease ?? runWithProviderRequestLease, signal);
  const read = async (url: string, method: string, body?: string, headers = new Headers({ accept: "application/json" }), resourceType?: string) => {
    if (!recipeAllowsRequest(recipe, url, method, resourceType)) throw new Error("UNSCOPED_REQUEST");
    if (method === "POST" && !allowsPost(new URL(url), headers, body ?? "")) throw new Error("UNSAFE_POST");
    const maxResponseBytes = publicBrowserResponseLimit(resourceType ?? "");
    const transport = deps.fetch ?? createAddressPinnedPublicFetchTransport({
      parseUrl: value => { if (!recipeAllowsRequest(recipe, value, method, resourceType)) throw new Error("UNSCOPED_REQUEST"); return new URL(value); },
      maxResponseBytes, timeoutMs: 15_000, redirectLimit: 0, authorizeReadPost: allowsPost,
    });
    return requestQueue.run(requestFamilyForUrl(url), async () => {
      const response = await transport(url, { method, body, headers, signal, credentials: "omit", redirect: "manual", cache: "no-store" });
      if (!response.ok) failure ??= recipeExecutionDiagnostic(`HTTP_${response.status}`, { url, method, resourceType });
      if (response.status === 429) { providerThrottled = true; throw new Error("PROVIDER_THROTTLED"); }
      if ([401, 403].includes(response.status)) throw new Error("ACCESS_REQUIRED");
      if (!response.ok || response.redirected || response.url && response.url !== url) throw new Error("TRANSPORT_FAILED");
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxResponseBytes) throw new Error("RESPONSE_LIMIT");
      return { response, buffer };
    });
  };
  let browser: Browser | undefined;
  let nativeProxy: NativePublicProxy | undefined;
  try {
    if (recipe.engine === "HTTP_JSON") {
      const url = expandRecipeTemplate(recipe.request.url, input, true);
      activity = { url, method: recipe.request.method };
      const body = recipe.request.body ? JSON.stringify(Object.fromEntries(Object.entries(recipe.request.body).map(([key, value]) => {
        const expanded = typeof value === "string" ? expandRecipeTemplate(value, input) : value;
        return [key, typeof value === "string" && /^\{\{(?:players|durationMinutes|day|month|year)\}\}$/u.test(value) ? Number(expanded) : expanded];
      }))) : undefined;
      const headers = new Headers({ accept: "application/json", "content-type": "application/json", origin: new URL(recipe.source.bookingUrl).origin });
      const { response, buffer } = await read(url, recipe.request.method, body, headers);
      if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) throw new Error("NOT_JSON");
      return normalize(recipe, input, extractJson(recipe, JSON.parse(Buffer.from(buffer).toString("utf8"))), clock());
    }
    if (recipe.browserTransport === "NATIVE_CHROME") nativeProxy = await createNativePublicBrowserProxy({ signal, maxBytes: PUBLIC_BROWSER_TUNNEL_BYTES, maxConnections: 128 });
    try {
      browser = deps.launchBrowser ? await deps.launchBrowser() : await (await import("@playwright/test")).chromium.launch({ headless: !(nativeProxy && process.platform === "win32"),
        ...(process.platform === "win32" ? { channel: "chrome" } : {}),
        ...(nativeProxy ? { args: ["--disable-quic", "--proxy-bypass-list=<-loopback>"] } : {}) });
    } catch { throw new Error("BROWSER_UNAVAILABLE"); }
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, timezoneId: recipe.source.timeZone, locale: "en-US",
      ...(nativeProxy ? { proxy: { server: nativeProxy.server, bypass: "<-loopback>" } } : {}) });
    await context.routeWebSocket("**/*", route => { route.close(); });
    const page = await context.newPage();
    let redirectRouting: Awaited<ReturnType<typeof installNativeRedirectRouting>> | undefined;
    const cpsScope = createCpsPublicSessionScope([recipe.source.bookingUrl, expandRecipeTemplate(recipe.pageUrl, input, true)]);
    page.on("popup", popup => { void popup.close(); });
    page.setDefaultTimeout(Math.min(10_000, Math.max(1, deadline - clock().getTime())));
    let blocked = false, requests = 0, bytes = 0, pendingRequests = 0, mutationGeneration = 0;
    let responseGeneration: number | undefined;
    let rejectedResponseGeneration: number | undefined;
    const usesServerDocument = recipe.availabilityResponse.kind === "SERVER_DOCUMENT";
    let mainDocumentSequence = 0, dataRequestSequence = 0;
    let serverDocument: { generation: number; documentSequence: number; dataSequence: number; extracted: ServerDocumentExtraction } | undefined;
    let lastSuccessfulAvailabilityRequest: PublicAvailabilityRequest | undefined;
    const inspectedPassfactoryDurationClients = new Set<string>();
    let selectedRequestedDate = false;
    let passfactoryAvailabilityRequests = 0, carriedDurationGeneration: number | undefined;
    const observeAvailabilityResponse = (generation: number, request: { url: string; method: string; body?: string | null }, status: number, body: Uint8Array,
      document?: { main: boolean; sequence: number; dataSequence: number; contentType: string }) => {
      if (generation !== mutationGeneration || !matchesAvailabilityRequest(recipe, input, request)) return;
      if (usesServerDocument) {
        try {
          if (!document?.main || document.sequence !== mainDocumentSequence || document.dataSequence !== dataRequestSequence ||
              status !== 200 || !/^text\/html(?:;|$)/iu.test(document.contentType)) throw new Error("SERVER_DOCUMENT_UNCONFIRMED");
          const extracted = extractServerDocument(recipe, Buffer.from(body).toString("utf8"), (field, value) => readRecipeFieldFormat(field, value));
          serverDocument = { generation, documentSequence: document.sequence, dataSequence: document.dataSequence, extracted };
          responseGeneration = generation; rejectedResponseGeneration = undefined;
        } catch (error) {
          serverDocument = undefined; responseGeneration = undefined; rejectedResponseGeneration = generation;
          failure ??= recipeExecutionDiagnostic(error);
        }
        return;
      }
      if (matchesAvailabilityResponse(recipe, input, request, status, body)) {
        responseGeneration = generation;
        rejectedResponseGeneration = undefined;
        lastSuccessfulAvailabilityRequest = request;
      } else {
        responseGeneration = undefined;
        rejectedResponseGeneration = generation;
        lastSuccessfulAvailabilityRequest = undefined;
      }
    };
    const observeClientScript = (url: string, resourceType: string, status: number, body: Uint8Array) => {
      if (resourceType !== "script" || !isPassfactoryDurationClientUrl(url)) return;
      const path = new URL(url).pathname;
      if (status >= 200 && status < 300 && isInspectedPassfactoryDurationClient(url, createHash("sha256").update(body).digest("hex")))
        inspectedPassfactoryDurationClients.add(path);
      else inspectedPassfactoryDurationClients.delete(path);
    };
    const waitForAvailabilityResponse = async () => {
      const expires = Date.now() + 15_000;
      while (!signal.aborted && Date.now() < expires) {
        if (responseGeneration === mutationGeneration) return;
        if (rejectedResponseGeneration === mutationGeneration && !pendingRequests) throw new Error("AVAILABILITY_RESPONSE_FAILED");
        if (blocked) throw new Error("AVAILABILITY_RESPONSE_UNCONFIRMED");
        await page.waitForTimeout(100);
      }
      throw new Error("AVAILABILITY_RESPONSE_UNCONFIRMED");
    };
    const waitForQuietReads = async () => {
      const expires = Date.now() + 10_000;
      let quietSince = Date.now();
      while (!signal.aborted && Date.now() < expires) {
        if (pendingRequests) quietSince = Date.now();
        else if (Date.now() - quietSince >= 600) return;
        await page.waitForTimeout(100);
      }
      throw new Error("UNSETTLED_REQUESTS");
    };
    let selectedProductDuration: number | undefined;
    let selectedDateDay: Locator | undefined;
    const handleRoute = async (route: NativeReadRoute) => {
      const request = route.request();
      if (isIncidentalBrowserRequest(request.url()) || isNonEvidenceBrowserResource(request.url(), request.resourceType())) { await route.abort(); return; }
      pendingRequests++;
      const transportUrl = canonicalPublicReadUrl(request.url(), request.method());
      const requestUrl = canonicalCpsPublicUrl(transportUrl);
      const requestGeneration = mutationGeneration;
      const mainDocument = request.resourceType() === "document" && request.isNavigationRequest() && request.frame() === page.mainFrame();
      if (mainDocument) mainDocumentSequence++;
      if (["xhr", "fetch"].includes(request.resourceType())) dataRequestSequence++;
      const capturedDocumentSequence = mainDocumentSequence, capturedDataSequence = dataRequestSequence;
      if (usesServerDocument && (mainDocument || ["xhr", "fetch"].includes(request.resourceType()))) {
        serverDocument = undefined; responseGeneration = undefined; rejectedResponseGeneration = requestGeneration;
      }
      if (isPassfactoryAvailabilityRequest({ url: requestUrl, method: request.method() })) {
        passfactoryAvailabilityRequests++;
        if (carriedDurationGeneration === mutationGeneration) {
          responseGeneration = undefined; lastSuccessfulAvailabilityRequest = undefined;
        }
      }
      try {
        if (++requests > 128 || signal.aborted) throw new Error("REQUEST_LIMIT");
        if (request.frame().page() !== page) throw new Error("UNSUPPORTED_BROWSER_PAGE");
        redirectRouting?.prepare(request.frame());
        if (!cpsScope.authorize(transportUrl, request.redirectedFrom()?.url())) throw new Error("UNOBSERVED_CPS_SESSION");
        if (cpsSessionKey(transportUrl) && !nativeProxy) throw new Error("CPS_NATIVE_BROWSER_REQUIRED");
        passfactory.observeWidgetUrl(requestUrl);
        const frameUrl = canonicalCpsPublicUrl(request.frame().url());
        if (recipeAllowsRequest(recipe, frameUrl, "GET")) passfactory.observeWidgetUrl(frameUrl);
        const requestHeaders = request.headers();
        const headers = new Headers();
        for (const key of ["accept", "content-type", "origin"]) if (requestHeaders[key]) headers.set(key, requestHeaders[key]);
        if (!addVerifiedMindbodyReadHeaders(new URL(requestUrl), request.method(), requestHeaders, headers, request.postData() ?? "")) throw new Error("UNSCOPED_REQUEST");
        if (nativeProxy) {
          const preflight = request.method() === "OPTIONS" ? nativeReadPreflightMethod(requestHeaders) : null;
          if (!recipeAllowsRequest(recipe, requestUrl, preflight ?? request.method(), request.resourceType()) ||
            Object.keys(requestHeaders).some(key => /^(?:authorization|proxy-authorization|x-api-key)$/iu.test(key)) ||
            request.method() === "POST" && !allowsPost(new URL(requestUrl), headers, request.postData() ?? "")) throw new Error("UNSCOPED_REQUEST");
          const responseLimit = publicBrowserResponseLimit(request.resourceType());
          const native = await requestQueue.run(requestFamilyForUrl(requestUrl), () => {
            const hostname = new URL(requestUrl).hostname;
            nativeProxy!.allowHostConnections(hostname);
            return continueNativeBrowserRead(route, signal, responseLimit, () => nativeProxy!.cancelHostConnections(hostname), transportUrl);
          });
          bytes += native.body.length;
          if (bytes > PUBLIC_BROWSER_TOTAL_BYTES) { cancellation.abort("RESPONSE_LIMIT"); throw new Error("RESPONSE_LIMIT"); }
          if (native.status >= 400) { blocked = true; failure ??= recipeExecutionDiagnostic(`HTTP_${native.status}`, { url: requestUrl, method: request.method(), resourceType: request.resourceType() }); }
          if (native.status === 429) { providerThrottled = true; throw new Error("PROVIDER_THROTTLED"); }
          observeClientScript(requestUrl, request.resourceType(), native.status, native.body);
          observeAvailabilityResponse(requestGeneration, { url: requestUrl, method: request.method(), body: request.postData() }, native.status, native.body,
            { main: mainDocument, sequence: capturedDocumentSequence, dataSequence: capturedDataSequence, contentType: native.headers["content-type"] ?? "" });
          return;
        }
        const { response, buffer } = await read(requestUrl, request.method(), request.postData() ?? undefined, headers, request.resourceType());
        bytes += buffer.byteLength;
        if (bytes > PUBLIC_BROWSER_TOTAL_BYTES) throw new Error("RESPONSE_LIMIT");
        const responseHeaders: Record<string, string> = {};
        for (const key of ["content-type", "access-control-allow-origin"]) { const value = response.headers.get(key); if (value) responseHeaders[key] = value; }
        await route.fulfill({ status: response.status, headers: responseHeaders, body: Buffer.from(buffer) });
        observeClientScript(requestUrl, request.resourceType(), response.status, new Uint8Array(buffer));
        observeAvailabilityResponse(requestGeneration, { url: requestUrl, method: request.method(), body: request.postData() }, response.status, new Uint8Array(buffer),
          { main: mainDocument, sequence: capturedDocumentSequence, dataSequence: capturedDataSequence, contentType: response.headers.get("content-type") ?? "" });
      } catch (error) { blocked = true; failure ??= recipeExecutionDiagnostic(error, { url: requestUrl, method: request.method(), resourceType: request.resourceType() }); await route.abort().catch(() => {}); }
      finally { pendingRequests--; }
    };
    await context.route("**/*", async route => {
      try { await handleRoute(redirectRouting ? redirectRouting.wrapRoute(route) : route); }
      catch (error) {
        blocked = true;
        failure ??= recipeExecutionDiagnostic(error, activity);
        await route.abort().catch(() => {});
        void redirectRouting?.close();
      }
    });
    if (nativeProxy) redirectRouting = await installNativeRedirectRouting(page, handleRoute, {
      signal, maxRequests: 1024,
      onFailure: code => { blocked = true; failure ??= recipeExecutionDiagnostic(code, activity); },
    });
    const stop = () => { void context.close().catch(() => {}); };
    signal.addEventListener("abort", stop, { once: true });
    try {
      const pageUrl = expandRecipeTemplate(recipe.pageUrl, input, true);
      activity = { url: pageUrl, method: "GET", resourceType: "document" };
      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: Math.min(30_000, Math.max(1, deadline - clock().getTime())) });
      for (const [stepIndex, step] of recipe.steps.entries()) {
        activity = { stepIndex, url: canonicalCpsPublicUrl(page.url()), method: "GET", resourceType: "document" };
        signal.throwIfAborted();
        if (isActiveBrowserAccessChallenge(await page.locator("body").innerText(), await page.title())) return fail("ACCESS_REQUIRED", "ACCESS_REQUIRED");
        let carryDurationFence = false, previousAvailabilityRequests = passfactoryAvailabilityRequests;
        if (step.action === "select" && step.purpose === "DURATION" && selectedRequestedDate && isPassfactoryDurationContext(recipe, page.url())) {
          await waitForAvailabilityResponse();
          await waitForQuietReads();
          if (!hasInspectedPassfactoryDurationClients(inspectedPassfactoryDurationClients) || !isPassfactoryDurationRequestBound(recipe, page.url(), input.date, lastSuccessfulAvailabilityRequest))
            throw new Error("UNVERIFIED_CLIENT_DURATION");
          carryDurationFence = true; previousAvailabilityRequests = passfactoryAvailabilityRequests;
        }
        if (step.action === "followLink" || step.action === "selectDateChoice" || step.action === "selectDate" || step.action === "selectProduct" || step.action === "select" || step.action === "fill" ||
          step.action === "clickFilter" && ["SELECT_DATE", "APPLY_DATE", "SELECT_FILTER", "RUN_SEARCH"].includes(step.purpose)) {
          mutationGeneration++; responseGeneration = undefined; rejectedResponseGeneration = undefined;
          carriedDurationGeneration = carryDurationFence ? mutationGeneration : undefined;
        }
        if (step.action === "followLink") {
          await followPublicAvailabilityLink(page.locator(step.selector), expandRecipeTemplate(step.text, input), url => recipeAllowsRequest(recipe, url, "GET"));
          continue;
        }
        if (step.action === "selectDateChoice") {
          selectedDateDay = await selectPublicDateChoice(page, step.selector, input.date);
          selectedRequestedDate = true;
          continue;
        }
        if (step.action === "selectDate") {
          selectedDateDay = await selectPublicCalendarDate(page, { ...step, date: input.date });
          selectedRequestedDate = true;
          continue;
        }
        if (step.action === "selectProduct") {
          const card = page.locator(step.productSelector);
          const button = card.locator(step.selector);
          if (!input.durationMinutes) throw new Error("UNSAFE_PRODUCT_SELECTION");
          await selectPublicRentalProduct(button, card, input.durationMinutes);
          selectedProductDuration = input.durationMinutes;
          continue;
        }
        let node = page.locator(step.selector);
        if (step.action === "waitFor") { await node.waitFor({ state: "visible" }); continue; }
        if (step.action === "clickFilter" && step.purpose === "APPLY_DATE") {
          if (!selectedRequestedDate || !selectedDateDay || await node.count() !== 1 ||
              clean(await node.innerText()) !== expandRecipeTemplate(step.text, input)) throw new Error("UNSAFE_CALENDAR_APPLY");
          await applyPublicCalendarDate(node, { day: selectedDateDay, date: input.date });
          continue;
        }
        if (step.action === "clickFilter" && step.purpose === "SELECT_DATE") {
          const dateText = expandRecipeTemplate(step.text, input);
          if (!/^\d{1,2}$|^\d{4}-\d{2}-\d{2}$/u.test(dateText)) throw new Error("UNSAFE_CONTROL");
          const candidates = node.filter({ hasText: new RegExp(`^\\s*${dateText}\\s*$`, "u") });
          if (await candidates.count() > 100) throw new Error("AMBIGUOUS_CONTROL");
          const visible: Locator[] = [];
          for (const candidate of await candidates.all()) if (await candidate.isVisible()) visible.push(candidate);
          if (visible.length !== 1) throw new Error("AMBIGUOUS_CONTROL");
          node = visible[0];
        }
        if (await node.count() !== 1 || !await node.isVisible()) throw new Error("AMBIGUOUS_CONTROL");
        const tag = await node.evaluate(element => element.tagName.toLowerCase());
        const label = clean(await node.getAttribute("aria-label")) + " " + clean(await node.getAttribute("name"));
        if (forbiddenControl.test(label)) throw new Error("UNSAFE_CONTROL");
        if (step.action === "select") {
          await selectPublicFilter(node, { value: expandRecipeTemplate(step.value, input), purpose: step.purpose,
            simulator: recipe.target.kind === "SIMULATOR" });
          if (step.purpose === "DATE") selectedRequestedDate = true;
          if (carryDurationFence) {
            await waitForQuietReads();
            if (boundedNumber(await domField(page.locator("body"), recipe.proof.durationMinutes), 480) !== input.durationMinutes)
              throw new Error("DURATION_PROOF_MISMATCH");
            if (previousAvailabilityRequests === passfactoryAvailabilityRequests && !blocked) {
              responseGeneration = mutationGeneration; rejectedResponseGeneration = undefined; carriedDurationGeneration = mutationGeneration;
            } else if (responseGeneration !== mutationGeneration) {
              throw new Error("AVAILABILITY_RESPONSE_UNCONFIRMED");
            }
          }
        } else if (step.action === "fill") {
          if (tag !== "input" || !["date", "text", "number"].includes(await node.getAttribute("type") ?? "text")) throw new Error("UNSAFE_CONTROL");
          const value = expandRecipeTemplate(step.value, input);
          if (!/^[0-9T:/. -]{1,32}$/u.test(value)) throw new Error("UNSAFE_CONTROL_VALUE");
          await node.fill(value); await node.dispatchEvent("change");
          if (step.purpose === "DATE") selectedRequestedDate = true;
        } else {
          const expected = expandRecipeTemplate(step.text, input);
          const text = clean(await node.innerText()) || clean(await node.getAttribute("aria-label"));
          const choice = await node.evaluate(element => {
            let context = "";
            let parent = element.parentElement;
            for (let depth = 0; parent && depth < 3 && !["BODY", "FORM"].includes(parent.tagName); depth++, parent = parent.parentElement) {
              const candidate = `${parent.id} ${parent.className} ${parent.innerText}`.replace(/\s+/gu, " ").trim();
              if (candidate.length <= 300 && /players?|holes?|duration|time.?of.?day|morning|midday|evening/iu.test(candidate)) { context = candidate; break; }
            }
            return { context, value: element.getAttribute("data-value"), href: element.getAttribute("href"),
              disabled: element.getAttribute("aria-disabled") === "true" || element.hasAttribute("disabled") || element.classList.contains("disabled"),
              sensitive: Boolean(element.closest("form")?.querySelector('input[type=password],input[type=email],input[type=tel],[autocomplete^="cc-"]')) };
          });
          const filterChoice = step.purpose === "SELECT_FILTER" && ["a", "button", "div", "span"].includes(tag) &&
            choice.value && choice.value.length <= 40 && choice.context && !choice.href && !choice.sensitive &&
            /^(?:\d{1,3}(?:\s+(?:holes?|players?|guests?|minutes?|hours?))?|any|all|both|morning|midday|evening|anytime)$/iu.test(text);
          if (text !== expected || forbiddenControl.test(text) || /\b\d{1,2}:\d{2}\b/u.test(text) ||
            choice.disabled || choice.sensitive || (!["button", "div", "span", "td", "th"].includes(tag) && !filterChoice)) throw new Error("UNSAFE_CONTROL");
          const calendar = await node.evaluate(element => Boolean(element.closest('[role="grid"], [role="dialog"], [class*="calendar"], [class*="datepicker"]'))) ||
            step.purpose === "SELECT_DATE" && await isObservedPublicCalendarDay(node, input.date);
          if (["td", "th"].includes(tag) && (!calendar || !["SELECT_DATE", "NEXT_MONTH", "PREVIOUS_MONTH"].includes(step.purpose))) throw new Error("UNSAFE_CONTROL");
          if (filterChoice && recipe.target.kind === "SIMULATOR" && /players?|party|guests?/iu.test(choice.context) && choice.value !== "1") throw new Error("UNSAFE_CONTROL");
          if (step.purpose === "SELECT_DATE" && (!calendar || !/^\d{1,2}$|^\d{4}-\d{2}-\d{2}$/u.test(text))) throw new Error("UNSAFE_CONTROL");
          if (step.purpose === "NEXT_MONTH" && (!calendar || !/^(?:next(?: month)?|>|›|»|chevron_right)$/iu.test(text))) throw new Error("UNSAFE_CONTROL");
          if (step.purpose === "PREVIOUS_MONTH" && (!calendar || !/^(?:previous(?: month)?|prev|<|‹|«|chevron_left)$/iu.test(text))) throw new Error("UNSAFE_CONTROL");
          if (step.purpose === "OPEN_DATE_PICKER" && !/date|calendar|choose day/iu.test(text)) throw new Error("UNSAFE_CONTROL");
          if (step.purpose === "RUN_SEARCH" && !/^(?:search|find times|show times|view availability|check availability)$/iu.test(text)) throw new Error("UNSAFE_CONTROL");
          if (["OPEN_FILTER", "SELECT_FILTER"].includes(step.purpose) && !filterChoice && !/duration|minutes?|hours?|players?|party|group|golf|bay|resource|rental/iu.test(text)) throw new Error("UNSAFE_CONTROL");
          await node.click();
          if (step.purpose === "SELECT_DATE") { selectedRequestedDate = true; selectedDateDay = node; }
        }
      }
      await waitForAvailabilityResponse();
      await waitForQuietReads();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      if (isActiveBrowserAccessChallenge(await page.locator("body").innerText(), await page.title())) return fail("ACCESS_REQUIRED", "ACCESS_REQUIRED");
      if (providerThrottled) return fail("FAILED", "PROVIDER_THROTTLED");
      if (blocked || !recipeAllowsRequest(recipe, canonicalCpsPublicUrl(page.url()), "GET")) return fail("INCOMPLETE", "UNSCOPED_OR_FAILED_RESOURCE");
      const first = await extractDom(recipe, page.locator("body"));
      if (first.duration === undefined) first.duration = selectedProductDuration;
      await page.waitForTimeout(750);
      await waitForQuietReads();
      const second = await extractDom(recipe, page.locator("body"));
      if (second.duration === undefined) second.duration = selectedProductDuration;
      if (providerThrottled) return fail("FAILED", "PROVIDER_THROTTLED");
      if (blocked || !recipeAllowsRequest(recipe, canonicalCpsPublicUrl(page.url()), "GET")) return fail("INCOMPLETE", "UNSCOPED_OR_FAILED_RESOURCE");
      if (pendingRequests || responseGeneration !== mutationGeneration || JSON.stringify(first) !== JSON.stringify(second)) return fail("INCOMPLETE", "UNSETTLED_RESULTS");
      if (usesServerDocument && (!serverDocument || serverDocument.generation !== mutationGeneration ||
          serverDocument.documentSequence !== mainDocumentSequence || serverDocument.dataSequence !== dataRequestSequence ||
          !sameServerDocumentEvidence(serverDocument.extracted, second))) return fail("INCOMPLETE", "SERVER_DOCUMENT_DOM_MISMATCH");
      return normalize(recipe, input, second, clock());
    } finally { signal.removeEventListener("abort", stop); await redirectRouting?.close(); await context.close().catch(() => {}); }
  } catch (error) {
    failure ??= recipeExecutionDiagnostic(error, activity);
    const message = error instanceof Error ? error.message : "";
    const reason = providerThrottled ? "PROVIDER_THROTTLED" : /^[A-Z_0-9]{1,80}$/u.test(message) ? message : failure.code;
    return fail(reason === "ACCESS_REQUIRED" ? "ACCESS_REQUIRED" : ["INVALID_SLOT_TIME", "AMBIGUOUS_OR_INVALID_LOCAL_TIME", "INCOMPLETE_COLLECTION", "INVALID_CAPACITY_OR_DURATION", "UNSETTLED_REQUESTS", "AMBIGUOUS_PROOF_FIELD", "RESOURCE_IDENTITY_MISMATCH", "AMBIGUOUS_RESOURCE_SCOPE", "INVALID_RESOURCE_SCOPE", "RESOURCE_SCOPE_NOT_CARD", "AVAILABILITY_RESPONSE_UNCONFIRMED", "AVAILABILITY_RESPONSE_FAILED", "UNVERIFIED_CLIENT_DURATION", "DURATION_PROOF_MISMATCH"].includes(reason) ? "INCOMPLETE" : "FAILED",
      reason);
  } finally { cancellation.abort("EXECUTION_FINISHED"); requestQueue.dispose(); await browser?.close().catch(() => {}); await nativeProxy?.close(); }
}
