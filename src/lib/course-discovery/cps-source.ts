import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";
import { completeUSAddress, fullCourseName } from "./teeitup-official-identity";
import { cpsPostalConflictProofSchema, verifyCpsPostalContact } from "./cps-postal-conflict-proof";
import { cpsPhoneBookingProofSchema, cpsOfficialCourseDescriptor, cpsOfficialSelectedCourseName,
  selectedCpsOfficialBookingAnchor, hasCpsObservedSelectedCourseLabel, verifyCpsPhoneBookingContact } from "./cps-phone-booking-proof";
import type { OfficialIdentityPage } from "./teeitup-official-identity";
import { parsePublicUSBusinessAddress } from "./public-us-business-address";

const id = z.number().int().min(1).max(2_147_483_647);
const tenant = z.string().regex(/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u)
  .refine(value => !/^(?:www|api|admin|auth|login|account|private|member|test|staging)$/u.test(value));
const label = z.string().trim().min(1).max(240).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const publicValue = z.string().trim().min(1).max(2048).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
export const CPS_API_PATH = "/onlineres/onlineapi/api/v1/onlinereservation";
// This build's published 569/507/647 + main clients perform one unpaged GET;
// the UI's load-more operation slices the already returned content locally.
export const CPS_PUBLIC_BUILD = "25.3.4.21239412485";
export const CPS_VENUE_PUBLIC_CATALOG_BUILD = "26.1.2.26379768992";
// 26.3.0.34794395074: reviewed public main 9b94214d3a50be69 and its
// exact runtime-linked 569/507/647 modules. SearchTeetimes sends the same
// unpaged dated GET; normal display pagination slices its complete array.
export type CpsPublicBuildProtocol = "PUBLISHED_KEY" | "ANONYMOUS_SHORT_SESSION";
// Each exact public build is reviewed for its own startup and complete-sheet
// request contract. A version number alone never grants a neighboring build.
const reviewedPublicBuilds = new Map<string, CpsPublicBuildProtocol>([
  [CPS_PUBLIC_BUILD, "PUBLISHED_KEY"],
  [CPS_VENUE_PUBLIC_CATALOG_BUILD, "ANONYMOUS_SHORT_SESSION"],
  ["26.3.0.34794395074", "ANONYMOUS_SHORT_SESSION"],
]);
export function cpsPublicBuildProtocol(build: string): CpsPublicBuildProtocol | undefined {
  return reviewedPublicBuilds.get(build);
}
export const cpsMetadataSchema = z.object({ family: z.literal("CPS"), tenant,
  courseIds: z.array(id).min(1).max(40).refine(values => values.every((value, index) => !index || values[index - 1] < value)),
  catalogHash: z.string().regex(/^[a-f0-9]{64}$/u), publicCatalogMode: z.literal("VENUE_BOUND_ONLINE_COURSES").optional(), officialPostalConflictProof: cpsPostalConflictProofSchema.optional(),
  officialPhoneBookingProof: cpsPhoneBookingProofSchema.optional() }).strict()
  .refine(value=>!(value.officialPostalConflictProof&&value.officialPhoneBookingProof)&&
    !(value.publicCatalogMode&&(value.officialPostalConflictProof||value.officialPhoneBookingProof))&&
    (!value.officialPhoneBookingProof||value.tenant===value.officialPhoneBookingProof.tenant&&value.catalogHash===value.officialPhoneBookingProof.catalogHash&&
      value.courseIds.length===1&&JSON.stringify(value.courseIds)===JSON.stringify(value.officialPhoneBookingProof.courseIds)&&
      (value.officialPhoneBookingProof.selectedAnchorLabel ?
        fullCourseName(value.officialPhoneBookingProof.providerVenueName)===fullCourseName(cpsOfficialCourseDescriptor(value.officialPhoneBookingProof.selectedAnchorLabel)??"")||
        fullCourseName(value.officialPhoneBookingProof.providerVenueName)===cpsOfficialSelectedCourseName(
          value.officialPhoneBookingProof.venueName,cpsOfficialCourseDescriptor(value.officialPhoneBookingProof.selectedAnchorLabel)??"") :
        cpsCourseNameBase(value.officialPhoneBookingProof.providerVenueName)===cpsCourseNameBase(value.officialPhoneBookingProof.venueName))&&
      cpsCourseNameBase(value.officialPhoneBookingProof.venueName).replace(/\s/gu,"").length>=8)&&
    (!value.officialPostalConflictProof||value.tenant===value.officialPostalConflictProof.tenant&&value.catalogHash===value.officialPostalConflictProof.catalogHash&&
    value.courseIds.length===1&&JSON.stringify(value.courseIds)===JSON.stringify(value.officialPostalConflictProof.courseIds)&&
    cpsCourseNameBase(value.officialPostalConflictProof.providerVenueName)===cpsCourseNameBase(value.officialPostalConflictProof.venueName)&&
    cpsCourseNameBase(value.officialPostalConflictProof.venueName).replace(/\s/gu,"").length>=8));
export type CpsMetadata = z.infer<typeof cpsMetadataSchema>;
export type CpsSource = { officialUrl: string; bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string };
export function cpsFailure(code: string): never { throw new Error(code); }
function safePublicUrl(value: string, allowRoutingQuery = false) {
  try { const url = new URL(value); return value.length <= 2048 && url.href === value && url.protocol === "https:" &&
    !url.username && !url.password && !url.port && (allowRoutingQuery || !url.search) && !url.hash && Boolean(getSafeCustomerBookingUrl(value)); }
  catch { return false; }
}
function publicRoutingQuery(url: URL) {
  if (!url.search) return true;
  // The public search link publishes decimal hour bounds. They identify the
  // exact observed entry URL; they never alter our canonical requested window.
  if (url.pathname !== "/onlineresweb/search-teetime") return false;
  const fields = url.search.slice(1).split("&");
  if (fields.length !== 2 || fields.some(field => !/^(?:TeeOffTimeMin|TeeOffTimeMax)=(?:0|[1-9]\d?)(?:\.\d{1,15})?$/u.test(field))) return false;
  if (new Set([...url.searchParams.keys()]).size !== 2) return false;
  const min = Number(url.searchParams.get("TeeOffTimeMin")), max = Number(url.searchParams.get("TeeOffTimeMax"));
  return min >= 0 && min <= max && max < 24;
}
export function parseCpsSource(value: string): { bookingUrl: string; origin: string; tenant: string } | undefined {
  try {
    if (!safePublicUrl(value, true)) return;
    const url = new URL(value), match = /^([a-z][a-z0-9-]*)\.cps\.golf$/u.exec(url.hostname);
    if (!match || !tenant.safeParse(match[1]).success || !["/", "/onlineresweb/search-teetime"].includes(url.pathname) || !publicRoutingQuery(url)) return;
    return { bookingUrl: url.href, origin: url.origin, tenant: match[1] };
  } catch { return; }
}
export function validateCpsIdentity(source: CpsSource) {
  if (!parseCpsSource(source.bookingUrl) || !safePublicUrl(source.officialUrl) || !source.venueAddress ||
      source.venueAddress.length > 1024 || !completeUSAddress(source.venueAddress) || !label.safeParse(source.venueName).success ||
      fullCourseName(source.venueName).replace(/[^\p{L}\p{N}]/gu, "").length < 8) cpsFailure("ADAPTER_IDENTITY_MISSING");
  try { if (!source.timeZone.includes("/")) cpsFailure("ADAPTER_IDENTITY_MISSING"); new Intl.DateTimeFormat("en-US", { timeZone: source.timeZone }); }
  catch { cpsFailure("ADAPTER_IDENTITY_MISSING"); }
}
export function sameCpsOfficialSite(value: string, officialUrl: string) {
  if (!safePublicUrl(value) || !safePublicUrl(officialUrl)) return false;
  const current = new URL(value), official = new URL(officialUrl);
  return current.hostname.replace(/^www\./u, "") === official.hostname.replace(/^www\./u, "");
}

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const element = (node: Node): node is Element => "tagName" in node;
const attr = (node: Element, key: string) => node.attrs.find(value => value.name === key)?.value;
const excluded = (node: Element) => ["script", "style", "template", "noscript", "form"].includes(node.tagName) ||
  ["hidden", "inert"].some(key => attr(node, key) !== undefined) || attr(node, "aria-hidden") === "true" ||
  /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:[;\s]|$)/iu.test(attr(node, "style") ?? "") ||
  /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only|screen-reader-only)(?:\s|$)/iu.test(attr(node, "class") ?? "");
function visibleText(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  if (element(node) && (excluded(node) || node.tagName === "iframe")) return " ";
  return "childNodes" in node ? node.childNodes.map(visibleText).join(" ") : "";
}
/** Fresh inert HTML corroborates the canonical address and exact observed
 * provider link. It does not claim a provider street address or refreshed CSS. */
export function inspectCpsOfficialDocument(html: string, pageUrl: string, source: CpsSource): { bookingLinked: boolean; nextUrls?: string[] } {
  validateCpsIdentity(source);
  if (html.length > 600_000 || !sameCpsOfficialSite(pageUrl, source.officialUrl)) cpsFailure("OFFICIAL_IDENTITY_UNVERIFIED");
  const root = parse(html), entries: Element[] = [];
  const walk = (node: Node) => {
    if (element(node)) { if (excluded(node)) return; entries.push(node); }
    if (entries.length > 10_000) cpsFailure("ADAPTER_RESPONSE_LIMIT");
    if ("childNodes" in node) node.childNodes.forEach(walk);
  };
  walk(root);
  const body = entries.find(node => node.tagName === "body");
  const text = visibleText(body ?? root).normalize("NFKC").replace(/[|\r\n]+/gu, ", ").replace(/\s+/gu, " ");
  const name = fullCourseName(source.venueName), words = fullCourseName(text);
  if (!(` ${words} `).includes(` ${name} `)) cpsFailure("OFFICIAL_IDENTITY_UNVERIFIED");
  const addresses = new Set<string>();
  for (const match of text.matchAll(/\b\d{1,8}\s+[A-Za-z0-9 .#'’-]+,\s*[A-Za-z .'-]+,\s*[A-Za-z]{2}\s+\d{5}(?:-\d{4})?(?:,?\s*(?:USA|US|United States))?\b/gu)) {
    const address = completeUSAddress(match[0]); if (address) addresses.add(JSON.stringify(address));
  }
  if (addresses.size !== 1 || !addresses.has(JSON.stringify(completeUSAddress(source.venueAddress!)))) cpsFailure("OFFICIAL_IDENTITY_UNVERIFIED");
  const providerLinks = new Set<string>(), localLinks = new Set<string>();
  for (const node of entries) {
    if (!["a", "iframe"].includes(node.tagName)) continue;
    const isFrame = node.tagName === "iframe", raw = attr(node, isFrame ? "src" : "href");
    if (!raw || isFrame && attr(node, "srcdoc") !== undefined) continue;
    const title = isFrame ? attr(node, "title") ?? "" : visibleText(node);
    if (!/\b(?:tee\s*times?|book(?:\s+a)?\s+tee\s*time|reservations?)\b/iu.test(title)) continue;
    let url: URL; try { url = new URL(raw, pageUrl); } catch { continue; }
    if (parseCpsSource(url.href)) providerLinks.add(url.href);
    else if (!isFrame && sameCpsOfficialSite(url.href, pageUrl) && url.origin === new URL(pageUrl).origin && url.href !== pageUrl &&
        !/\/(?:login|signin|account|checkout|cart|payment|contact)(?:\/|$)/iu.test(url.pathname)) localLinks.add(url.href);
  }
  if (providerLinks.size) {
    if (providerLinks.size !== 1 || !providerLinks.has(source.bookingUrl)) cpsFailure("OFFICIAL_BOOKING_SOURCE_MISMATCH");
    return { bookingLinked: true };
  }
  if (!localLinks.size || localLinks.size > 2) cpsFailure("OFFICIAL_BOOKING_SOURCE_UNVERIFIED");
  return { bookingLinked: false, nextUrls: [...localLinks] };
}

const configurationSchema = z.object({ siteName: tenant, onlineApi: publicValue, authorityBaseUrl: publicValue,
  clientId: publicValue, websiteId: publicValue, apiKey: publicValue.optional(), buildNumber: z.string().trim() }).passthrough();
// Classification only. An unknown public build has no reviewed header/session
// contract and must never inherit version-specific IDs, keys or read authority.
const configurationCoreSchema = z.object({ siteName: tenant, onlineApi: publicValue, authorityBaseUrl: publicValue,
  buildNumber: z.string().max(64).trim().regex(/^(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,19})$/u) }).passthrough();
export type CpsConfiguration = z.infer<typeof configurationSchema>;
const optionCourse = z.object({ courseId: id, courseName: label, webSiteId: publicValue }).passthrough();
const optionsSchema = z.object({ webSiteId: publicValue, courseOptions: z.array(optionCourse).min(1).max(40),
  reservationOptions: z.object({ terminalId: z.number().int().min(0).max(2_147_483_647) }).passthrough() }).passthrough();
export type CpsOptions = z.infer<typeof optionsSchema>;
export function parseCpsConfiguration(value: unknown, source: CpsSource): CpsConfiguration {
  const context = parseCpsSource(source.bookingUrl), core = configurationCoreSchema.safeParse(value);
  if (core.success && context && core.data.siteName === context.tenant && core.data.onlineApi === context.origin + CPS_API_PATH &&
      core.data.authorityBaseUrl === context.origin + "/identityapi" && !cpsPublicBuildProtocol(core.data.buildNumber))
    cpsFailure("CPS_PUBLIC_BUILD_UNSUPPORTED");
  const result = configurationSchema.safeParse(value);
  if (!result.success || !context || result.data.siteName !== context.tenant || result.data.onlineApi !== context.origin + CPS_API_PATH ||
      result.data.authorityBaseUrl !== context.origin + "/identityapi" || !cpsPublicBuildProtocol(result.data.buildNumber) ||
      cpsPublicBuildProtocol(result.data.buildNumber) === "PUBLISHED_KEY" && !result.data.apiKey) cpsFailure("CPS_CONFIGURATION_UNVERIFIED");
  return result.data;
}
export function parseCpsOptions(value: unknown, configuration: CpsConfiguration): CpsOptions {
  const parsed = optionsSchema.safeParse(value);
  if (!parsed.success || parsed.data.webSiteId !== configuration.websiteId && !/^0+(?:-0+)*$/u.test(configuration.websiteId) ||
      parsed.data.courseOptions.some(row => row.webSiteId !== parsed.data.webSiteId) ||
      new Set(parsed.data.courseOptions.map(row => row.courseId)).size !== parsed.data.courseOptions.length) cpsFailure("CPS_OPTIONS_UNVERIFIED");
  return parsed.data;
}
export function cpsCourseNameBase(value:string){return fullCourseName(value).replace(/\s+golf (?:course|club|preserve)$/u,"").trim();}
/** The public footer publishes either the existing complete-address grammar or
 * one flat full US address. No source/expected component fills a missing part. */
function publicClubAddress(value: unknown) {
  const complete = parsePublicUSBusinessAddress(value);
  if (complete) return complete;
  if (typeof value !== "string" || value.length > 1024 || /[,<>\u0000-\u001f\u007f]/u.test(value)) return null;
  const flat = /^(\d{1,7}[A-Za-z]?\s+[\p{L}\p{N} .#'’-]{1,135}\s+(?:dr(?:ive)?|rd|road|st(?:reet)?|ave(?:nue)?|blvd|boulevard|ln|lane|ct|court|pkwy|parkway|hwy|highway|cir(?:cle)?|trl|trail|ter(?:race)?|way)\.?)\s+([\p{L} .'-]{2,80})\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)(?:\s+(?:US|USA|United States))?$/iu.exec(value.trim());
  return flat ? parsePublicUSBusinessAddress(`${flat[1]}, ${flat[2]}, ${flat[3]} ${flat[4]}, US`) : null;
}
function publicClubIdentity(options: CpsOptions, source: CpsSource) {
  const name = label.safeParse(options.reservationOptions.clubName);
  const address = publicClubAddress(options.reservationOptions.clubAddress);
  const expectedAddress = parsePublicUSBusinessAddress(source.venueAddress);
  // Category words may differ only after the independent entire physical
  // address agrees. This local rule never changes the global venue predicate.
  const core = (value: string) => fullCourseName(value).replace(/\s+(?:country club|golf course)$/u, "");
  const expected = core(source.venueName), actual = name.success ? core(name.data) : "";
  if (!name.success || !address || !expectedAddress || JSON.stringify(address) !== JSON.stringify(expectedAddress) ||
      expected !== actual || expected.replace(/\s/gu, "").length < 8 ||
      /^(?:the\s+)?(?:(?:golf|course|club|public|municipal|country)\s*)+$/u.test(expected)) cpsFailure("ADAPTER_IDENTITY_MISMATCH");
  return { name: fullCourseName(name.data), address };
}
const publicAccessFlags = ["private", "is_private", "membersOnly", "members_only", "requiresLogin", "requires_login"] as const;
function publicFlags(value: Record<string, unknown>) {
  return Object.fromEntries(publicAccessFlags.map(key => {
    if (Object.hasOwn(value, key) && typeof value[key] !== "boolean") cpsFailure("ADAPTER_IDENTITY_MISMATCH");
    return [key, value[key] ?? null];
  }));
}
function requirePublicFlags(value: Record<string, unknown>) {
  if (Object.values(publicFlags(value)).some(flag => flag === true)) cpsFailure("ADAPTER_IDENTITY_MISMATCH");
}
export function parseCpsCatalog(value: unknown, options: CpsOptions, source: CpsSource,
  nativeContact?:{page:OfficialIdentityPage;canonicalCoursePhone:unknown;onSelectedLabel:(label:string)=>void;phoneBooking?:true}, publicBuild?: string): CpsMetadata {
  validateCpsIdentity(source);
  const rows = z.array(z.object({ courseId: id, courseName: label, timezoneId: label, websiteId: publicValue,
    active: z.literal(true), holes: z.union([z.literal(9), z.literal(18)]) }).passthrough()).min(1).max(40).safeParse(value);
  if (!rows.success) cpsFailure("CPS_CATALOG_UNVERIFIED");
  const name = fullCourseName(source.venueName), courses = [...rows.data].sort((a, b) => a.courseId - b.courseId);
  const ids = courses.map(row => row.courseId), declared = options.courseOptions.map(row => row.courseId).sort((a, b) => a - b);
  if (publicBuild === CPS_VENUE_PUBLIC_CATALOG_BUILD) {
    // In this exact reviewed public client OnlineCourses populates the course
    // selector; GetAllOptions also contains unselectable legacy options. Admit
    // the complete explicit one-sheet public set, never a default/order/name
    // guess from the wider options catalog.
    const venue = publicClubIdentity(options, source);
    requirePublicFlags(options.reservationOptions);
    for (const course of courses) {
      requirePublicFlags(course);
      const option = options.courseOptions.find(row => row.courseId === course.courseId);
      if (option) requirePublicFlags(option);
    }
    if (courses.length !== 1 || new Set(declared).size !== declared.length ||
        courses.some(row => row.websiteId !== options.webSiteId || row.timezoneId !== source.timeZone ||
          options.courseOptions.filter(option => option.courseId === row.courseId && option.courseName === row.courseName && option.webSiteId === row.websiteId).length !== 1) ||
        /\b(?:private|members?|login|sign\s*in|simulator|practice|driving range|lesson|event|gift)\b/iu.test(courses[0].courseName.replace(/[_-]/gu, " ")))
      cpsFailure("ADAPTER_IDENTITY_MISMATCH");
    const context = parseCpsSource(source.bookingUrl)!;
    const stable = { mode: "VENUE_BOUND_ONLINE_COURSES", buildNumber: publicBuild, tenant: context.tenant,
      officialUrl: source.officialUrl, canonicalName: name, canonicalAddress: parsePublicUSBusinessAddress(source.venueAddress),
      timeZone: source.timeZone, venue, publicFlags: publicFlags(options.reservationOptions), publicCourses: courses.map(row => ({ id: row.courseId, name: row.courseName,
        timeZone: row.timezoneId, websiteId: row.websiteId, active: row.active, holes: row.holes, flags: publicFlags(row) })),
      options: [...options.courseOptions].sort((a, b) => a.courseId - b.courseId).map(row => ({ id: row.courseId, name: row.courseName, websiteId: row.webSiteId, flags: publicFlags(row) })) };
    return cpsMetadataSchema.parse({ family: "CPS", tenant: context.tenant, courseIds: ids,
      publicCatalogMode: "VENUE_BOUND_ONLINE_COURSES", catalogHash: createHash("sha256").update(JSON.stringify(stable)).digest("hex") });
  }
  if(nativeContact){
    if(nativeContact.phoneBooking)verifyCpsPhoneBookingContact(source,nativeContact.page,nativeContact.canonicalCoursePhone);
    else verifyCpsPostalContact(source,nativeContact.page,nativeContact.canonicalCoursePhone);
    const base=cpsCourseNameBase(source.venueName);
    if(base.replace(/\s/gu,"").length<8||new Set(ids).size!==ids.length||
      (nativeContact.phoneBooking ? ids.some(courseId=>!declared.includes(courseId)) : JSON.stringify(ids)!==JSON.stringify(declared))||
      courses.some(row=>row.websiteId!==options.webSiteId||options.courseOptions.find(option=>option.courseId===row.courseId)?.courseName!==row.courseName||
        nativeContact.phoneBooking&&row.timezoneId!==source.timeZone))cpsFailure("ADAPTER_IDENTITY_MISMATCH");
    for(const row of courses){try{new Intl.DateTimeFormat("en-US",{timeZone:row.timezoneId});}catch{cpsFailure("CPS_CATALOG_UNVERIFIED");}}
    const exactSingle=nativeContact.phoneBooking&&courses.length===1&&declared.length===1&&
      cpsCourseNameBase(courses[0].courseName)===base;
    const selectedAnchor=nativeContact.phoneBooking ? selectedCpsOfficialBookingAnchor(source,nativeContact.page) : undefined;
    if(exactSingle&&hasCpsObservedSelectedCourseLabel(source,nativeContact.page)&&!selectedAnchor)
      cpsFailure("ADAPTER_IDENTITY_MISMATCH");
    const descriptorName=selectedAnchor&&cpsOfficialSelectedCourseName(source.venueName,selectedAnchor.descriptor);
    if(exactSingle&&selectedAnchor&&fullCourseName(selectedAnchor.descriptor)!==fullCourseName(courses[0].courseName)&&
       descriptorName!==fullCourseName(courses[0].courseName))cpsFailure("ADAPTER_IDENTITY_MISMATCH");
    const matching=exactSingle ? courses : nativeContact.phoneBooking ?
      descriptorName ? courses.filter(row=>fullCourseName(row.courseName)===descriptorName) : [] :
      courses.filter(row=>cpsCourseNameBase(row.courseName)===base);
    if(matching.length!==1)cpsFailure("ADAPTER_IDENTITY_MISMATCH");
    const selected=matching[0],option=options.courseOptions.find(row=>row.courseId===selected.courseId);
    if(!option||option.courseName!==selected.courseName||selected.timezoneId!==source.timeZone||
      (!nativeContact.phoneBooking&&cpsCourseNameBase(option.courseName)!==base))cpsFailure("ADAPTER_IDENTITY_MISMATCH");
    const context=parseCpsSource(source.bookingUrl)!;
    const stable={tenant:context.tenant,officialUrl:source.officialUrl,canonicalName:source.venueName,canonicalAddress:completeUSAddress(source.venueAddress!),timeZone:source.timeZone,
      selectedCourseId:selected.courseId,
      ...(nativeContact.phoneBooking&&selectedAnchor?{
        selectedOfficialAnchorRawWitnessSha256:selectedAnchor.selectedAnchorRawWitnessSha256,
        selectedOfficialAnchorRenderedWitnessSha256:selectedAnchor.selectedAnchorRenderedWitnessSha256,
        observedActiveOrder:rows.data.map(row=>row.courseId),
        observedOptionOrder:options.courseOptions.map(row=>row.courseId)}:{}),
      courses:courses.map(row=>({id:row.courseId,name:row.courseName,timeZone:row.timezoneId,websiteId:row.websiteId,holes:row.holes})),
      options:[...options.courseOptions].sort((a,b)=>a.courseId-b.courseId).map(row=>({id:row.courseId,name:row.courseName,websiteId:row.webSiteId}))};
    nativeContact.onSelectedLabel(selected.courseName);
    return cpsMetadataSchema.parse({family:"CPS",tenant:context.tenant,courseIds:[selected.courseId],catalogHash:createHash("sha256").update(JSON.stringify(stable)).digest("hex")});
  }
  if (new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify(declared) ||
      courses.some(row => fullCourseName(row.courseName) !== name || row.timezoneId !== source.timeZone || row.websiteId !== options.webSiteId) ||
      options.courseOptions.some(row => fullCourseName(row.courseName) !== name)) cpsFailure("ADAPTER_IDENTITY_MISMATCH");
  const context = parseCpsSource(source.bookingUrl)!;
  // Website IDs and public API keys are freshly rederived RAM-only routing data.
  const stable = { tenant: context.tenant, courseIds: ids, venueName: name, venueAddress: completeUSAddress(source.venueAddress!),
    officialUrl: source.officialUrl, timeZone: source.timeZone, courses: courses.map(row => ({ id: row.courseId, name: row.courseName, timeZone: row.timezoneId })) };
  return cpsMetadataSchema.parse({ family: "CPS", tenant: context.tenant, courseIds: ids,
    catalogHash: createHash("sha256").update(JSON.stringify(stable)).digest("hex") });
}
