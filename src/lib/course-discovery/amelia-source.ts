import { createHash } from "node:crypto";
import { parse as parseJavaScript, type Node as JavaScriptNode } from "acorn";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { completeUSAddress } from "./teeitup-official-identity";

/** These three public clients were inspected together. A new build requires a
 * new semantic review, not execution of source supplied by a discovery model. */
export const AMELIA_CLIENT_HASHES = Object.freeze({
  public: "eeca0eb849ccf96ced5cd7b253bd1721df1775f6e426a4acd435f0d1c3381d5b",
  step: "e1958107085afec8d43216af542b5ab656ee6ccdcff601be7b07590012ad0d1e",
  event: "494abf35444be17abb264766c4a712ffededaafb37b982bd1e7da087d6add42c",
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fail(code = "ADAPTER_CONFIGURATION_UNVERIFIED"): never { throw new Error(code); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const publicUrl = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/u.test(url.hostname) &&
    !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/u.test(url.hostname) && !/%/u.test(url.hostname); } catch { return false; }
});
const timeZone = z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; } });
const positiveId = z.number().int().min(1).max(2_147_483_647);
const seconds = z.number().int().min(0).max(86_400);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const shortcodeSchema = z.object({ form: z.literal("sbsNew"), counter: z.string().regex(/^\d{1,10}$/u), category: z.null(), service: z.null(),
  employee: z.null(), location: z.null(), package: z.null() }).strict();
const settingsSchema = z.object({ timeZone, showClientTimeZone: z.literal(true), slotLengthSeconds: seconds.refine(value => value >= 60),
  startOfWeek: z.literal(0), bringingAnyoneLogic: z.literal("additional"), bookMultipleTimes: z.literal(false),
  employeeSelection: z.literal("random"), isGloballyBusySlot: z.literal(false) }).strict();
const serviceSchema = z.object({ id: positiveId, name: z.string().min(3).max(200), durationSeconds: seconds.refine(value => value >= 900 && value <= 28_800),
  timeBeforeSeconds: seconds, timeAfterSeconds: seconds, minCapacity: positiveId.max(100), maxCapacity: positiveId.max(100),
  bringingAnyone: z.boolean(), aggregatedPrice: z.boolean(), hasDurationExtras: z.boolean(), providerIds: z.array(positiveId).min(1).max(40).refine(unique) }).strict()
  .refine(value => value.minCapacity <= value.maxCapacity);
const providerSchema = z.object({ id: positiveId, serviceIds: z.array(positiveId).min(1).max(40).refine(unique) }).strict();
const clientShape = { publicClientUrl: publicUrl, publicClientSha256: z.literal(AMELIA_CLIENT_HASHES.public), stepClientUrl: publicUrl,
  stepClientSha256: z.literal(AMELIA_CLIENT_HASHES.step), eventClientUrl: publicUrl, eventClientSha256: z.literal(AMELIA_CLIENT_HASHES.event) };
export const ameliaMetadataSchema = z.object({ family: z.literal("AMELIA"), apiUrl: publicUrl, timeZone, shortcode: shortcodeSchema,
  settings: settingsSchema, ...clientShape, services: z.array(serviceSchema).min(1).max(40).refine(values => unique(values.map(value => value.id))),
  providers: z.array(providerSchema).min(1).max(40).refine(values => unique(values.map(value => value.id))), catalogHash: sha256 }).strict();
export type AmeliaMetadata = z.infer<typeof ameliaMetadataSchema>;
export type AmeliaIdentitySource = { officialUrl: string; bookingUrl: string; venueName: string; venueAddress: string; timeZone: string };
export type AmeliaPage = { apiUrl: string; publicClientUrl: string; timeZone: string; shortcode: z.infer<typeof shortcodeSchema>; settings: z.infer<typeof settingsSchema> };
export type AmeliaClientWitness = { publicClientUrl: string; publicClientSha256: typeof AMELIA_CLIENT_HASHES.public; stepClientUrl: string; eventClientUrl: string };
export type AmeliaVerifiedClients = AmeliaClientWitness & { stepClientSha256: typeof AMELIA_CLIENT_HASHES.step; eventClientSha256: typeof AMELIA_CLIENT_HASHES.event };

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const element = (value: Node): value is Element => "tagName" in value;
const attr = (value: Element, name: string) => value.attrs.find(entry => entry.name === name)?.value;
const excluded = (node: Element) => ["script", "style", "template", "noscript", "iframe", "form"].includes(node.tagName) ||
  node.attrs.some(value => ["hidden", "inert"].includes(value.name)) || attr(node, "aria-hidden") === "true" ||
  /display\s*:\s*none|visibility\s*:\s*hidden/iu.test(attr(node, "style") ?? "") ||
  /(?:^|;)\s*opacity\s*:\s*0(?:\.0*)?\s*(?:!important\s*)?(?:;|$)/iu.test(attr(node, "style") ?? "") ||
  /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only|screen-reader-only|screen-reader-text|hide)(?:\s|$)/iu.test(attr(node, "class") ?? "");
function nodes(html: string) {
  if (Buffer.byteLength(html) > 2_000_000) fail("ADAPTER_RESPONSE_LIMIT");
  const found: Element[] = [];
  const walk = (node: Node, depth: number) => {
    if (depth > 80 || found.length > 20_000) fail("ADAPTER_DOCUMENT_LIMIT");
    if (element(node)) found.push(node);
    if ("childNodes" in node) for (const child of node.childNodes) walk(child, depth + 1);
  };
  walk(parse(html), 0); return found;
}
function text(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  if (element(node) && excluded(node)) return "";
  if (element(node) && node.tagName === "br") return " ";
  return "childNodes" in node ? node.childNodes.map(text).join(" ").replace(/\s+/gu, " ").trim() : "";
}
function visible(node: Element) {
  let current: Node | null = node;
  for (let depth = 0; current && depth <= 80; depth++, current = "parentNode" in current ? current.parentNode : null) if (element(current) && excluded(current)) return false;
  return true;
}
const legalName = (value: string) => value.normalize("NFKC").toLowerCase().replace(/['’]/gu, "").replace(/[^a-z0-9]+/gu, " ").trim().replace(/\s+llc$/u, "");
const addressKey = (value: string) => value.toLowerCase().replace(/\b(?:north|south|east|west|northeast|northwest|southeast|southwest|avenue|street|drive|road|boulevard|lane|court|parkway|highway|circle|trail|terrace)\b/gu,
  word => ({ north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw", avenue: "ave", street: "st", drive: "dr", road: "rd", boulevard: "blvd", lane: "ln", court: "ct", parkway: "pkwy", highway: "hwy", circle: "cir", trail: "trl", terrace: "ter" })[word]!).replace(/[^a-z0-9]+/gu, " ").trim();
function sourceUrls(source: AmeliaIdentitySource) {
  if (!publicUrl.safeParse(source.officialUrl).success || !publicUrl.safeParse(source.bookingUrl).success || !timeZone.safeParse(source.timeZone).success) fail("ADAPTER_IDENTITY_MISSING");
  const official = new URL(source.officialUrl), booking = new URL(source.bookingUrl);
  if (official.origin !== booking.origin || official.search || booking.search || /\b(?:login|checkout|account|payment)\b/iu.test(booking.pathname)) fail("ADAPTER_IDENTITY_MISMATCH");
  return { official, booking };
}
/** Scoped official-origin proof; legal suffix and directional equivalence do not
 * change the application's general course-name/address matching rules. */
export function verifyAmeliaOfficialPage(source: AmeliaIdentitySource, html: string, actualUrl = source.officialUrl): void {
  const { official, booking } = sourceUrls(source), current = new URL(actualUrl), expected = legalName(source.venueName), address = completeUSAddress(source.venueAddress);
  if (!publicUrl.safeParse(actualUrl).success || current.origin !== official.origin || current.search || !address || expected.length < 8) fail("ADAPTER_IDENTITY_MISMATCH");
  const entries = nodes(html).filter(visible), titles = entries.filter(node => node.tagName === "title");
  if (titles.length !== 1 || !text(titles[0]).split(/[|–—]/u).some(part => [expected, `${expected} simulator`, `${expected} simulators`].includes(legalName(part))) ||
      !entries.some(node => ["h1", "h2"].includes(node.tagName) && legalName(text(node)) === expected)) fail("ADAPTER_IDENTITY_MISMATCH");
  const bookingPath = booking.href.replace(/\/$/u, "");
  const links = entries.filter(node => node.tagName === "a").flatMap(node => {
    try { const url = new URL(attr(node, "href") ?? "", current); return url.origin === official.origin && /\b(?:book|tee\s*time|reserve)\b/iu.test(`${text(node)} ${url.pathname.replace(/[-_/]/gu, " ")}`) ? [url.href.replace(/\/$/u, "")] : []; } catch { return []; }
  });
  if (!links.includes(bookingPath)) fail("ADAPTER_IDENTITY_MISMATCH");
  const needle = addressKey(`${address.street} ${address.locality} ${address.region} ${address.postalCode}`);
  if (!entries.some(node => {
    if (!["address", "p", "div", "li", "td", "footer", "section"].includes(node.tagName)) return false;
    const value = text(node); if (value.length > 600 || !` ${addressKey(value)} `.includes(` ${needle} `)) return false;
    const pending: Node[] = [node]; let count = 0;
    while (pending.length) {
      const child = pending.pop()!; if (++count > 2000) return false;
      if (element(child) && /\b(?:mailing|corporate|billing|headquarters|p\.?\s*o\.?\s*box)\b/iu.test(`${attr(child, "aria-label") ?? ""} ${attr(child, "title") ?? ""}`)) return false;
      if ("childNodes" in child) pending.push(...child.childNodes);
    }
    let current: Node | null = node;
    for (let depth = 0; current && depth < 4; depth++, current = "parentNode" in current ? current.parentNode : null) {
      if (element(current) && /\b(?:mailing|corporate|billing|headquarters|p\.?\s*o\.?\s*box)\b/iu.test(`${attr(current, "aria-label") ?? ""} ${attr(current, "title") ?? ""} ${text(current)}`)) return false;
    }
    return true;
  })) fail("ADAPTER_IDENTITY_MISMATCH");
}

type Ast = JavaScriptNode & Record<string, unknown>;
const ast = (value: unknown): value is Ast => object(value) && typeof value.type === "string";
function plainProperties(node: unknown): Ast[] {
  if (!ast(node) || node.type !== "ObjectExpression" || !Array.isArray(node.properties)) return fail();
  const names = new Set<string>();
  return node.properties.map(value => {
    if (!ast(value) || value.type !== "Property" || value.kind !== "init" || value.computed || value.method || value.shorthand || !ast(value.key) ||
        !["Identifier", "Literal"].includes(value.key.type)) return fail();
    const name = value.key.type === "Identifier" ? value.key.name : value.key.value;
    if (typeof name !== "string" || ["__proto__", "constructor", "prototype"].includes(name) || names.has(name)) return fail();
    names.add(name); return value;
  });
}
function property(node: unknown, name: string): unknown {
  const matches = plainProperties(node).filter(value => ast(value.key) && (value.key.name === name || value.key.value === name));
  if (matches.length !== 1) return fail();
  return matches[0].value;
}
function literal(node: unknown): string | number | boolean | null {
  if (!ast(node) || node.type !== "Literal" || !["string", "number", "boolean"].includes(typeof node.value) && node.value !== null) return fail();
  return node.value as string | number | boolean | null;
}
function pathLiteral(node: unknown, path: string[]) { let current = node; for (const key of path) current = property(current, key); return literal(current); }
function literalTree(node: unknown, depth = 0, state = { count: 0 }): void {
  if (++state.count > 30_000 || depth > 40 || !ast(node)) return fail();
  if (node.type === "Literal") { literal(node); return; }
  if (node.type === "UnaryExpression" && node.operator === "-" && ast(node.argument) && node.argument.type === "Literal" && typeof node.argument.value === "number" && Number.isFinite(node.argument.value)) return;
  if (node.type === "ObjectExpression") { for (const prop of plainProperties(node)) literalTree(prop.value, depth + 1, state); return; }
  if (node.type === "ArrayExpression" && Array.isArray(node.elements)) { for (const value of node.elements) literalTree(value, depth + 1, state); return; }
  return fail();
}
function signature(value: unknown): string {
  const clean = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(clean);
    if (!object(input)) return input;
    return Object.fromEntries(Object.entries(input).filter(([key]) => !["start", "end", "raw"].includes(key)).map(([key, child]) => [key, clean(child)]));
  };
  return JSON.stringify(clean(value));
}
function knownStatement(value: string) { return (parseJavaScript(value, { ecmaVersion: "latest" }) as unknown as { body: unknown[] }).body[0]; }
const shortcodeInit = signature(knownStatement("var ameliaShortcodeData = (typeof ameliaShortcodeData === 'undefined') ? [] : ameliaShortcodeData;"));
const noOpTriggerScaffold = signature(knownStatement(`if (ameliaShortcodeData[ameliaShortcodeData.length - 1].trigger !== '' || ameliaShortcodeData[ameliaShortcodeData.length - 1].ivy !== '') {
  if (ameliaShortcodeDataTriggered.filter(a => a.counter === ameliaShortcodeData[ameliaShortcodeData.length - 1].counter).length === 0) {
    ameliaShortcodeDataTriggered.push(ameliaShortcodeData.pop());
  } else { ameliaShortcodeData.pop() }
}`));
const hasApiCallExpression = signature((knownStatement("var value = (typeof hasAmeliaEntitiesApiCall !== 'undefined') && hasAmeliaEntitiesApiCall;") as Ast).declarations &&
  ((knownStatement("var value = (typeof hasAmeliaEntitiesApiCall !== 'undefined') && hasAmeliaEntitiesApiCall;") as Ast).declarations as Ast[])[0].init);
const protectedNames = new Set(["wpAmeliaUrls", "wpAmeliaSettings", "ameliaShortcodeData"]);
function noProtectedReferences(value: unknown, depth = 0, state = { count: 0 }): void {
  if (++state.count > 100_000 || depth > 100) return fail();
  if (Array.isArray(value)) { for (const child of value) noProtectedReferences(child, depth + 1, state); return; }
  if (!object(value)) return;
  if (value.type === "Identifier" && protectedNames.has(String(value.name)) || value.type === "Literal" && protectedNames.has(String(value.value))) return fail("ADAPTER_BOOTSTRAP_MUTATION_UNSUPPORTED");
  for (const [key, child] of Object.entries(value)) if (!["start", "end", "raw"].includes(key)) noProtectedReferences(child, depth + 1, state);
}
function declarations(html: string) {
  const declarations = new Map<string, unknown[]>(), shortcodes: unknown[] = [];
  for (const script of nodes(html).filter(node => node.tagName === "script" && !attr(node, "src"))) {
    const body = script.childNodes.filter(node => node.nodeName === "#text").map(node => (node as DefaultTreeAdapterMap["textNode"]).value).join("");
    const relevant = /wpAmelia|ameliaShortcodeData/u.test(body);
    if (!["", "text/javascript", "application/javascript"].includes((attr(script, "type") ?? "").toLowerCase().trim())) { if (relevant) return fail(); continue; }
    let parsed: Ast; try { parsed = parseJavaScript(body, { ecmaVersion: "latest", sourceType: "script" }) as unknown as Ast; } catch { if (relevant) return fail(); continue; }
    if (!Array.isArray(parsed.body) || parsed.body.length > 200) return fail();
    for (const statement of parsed.body) {
      if (!ast(statement)) continue;
      if ([shortcodeInit, noOpTriggerScaffold].includes(signature(statement))) continue;
      if (statement.type === "VariableDeclaration" && Array.isArray(statement.declarations)) for (const value of statement.declarations) {
        if (!ast(value) || !ast(value.id) || !["wpAmeliaUrls", "wpAmeliaSettings"].includes(String(value.id.name))) { noProtectedReferences(value); continue; }
        if (statement.kind !== "var") return fail("ADAPTER_BOOTSTRAP_MUTATION_UNSUPPORTED");
        literalTree(value.init);
        declarations.set(String(value.id.name), [...declarations.get(String(value.id.name)) ?? [], value.init]);
      }
      if (statement.type === "VariableDeclaration") continue;
      if (statement.type !== "ExpressionStatement" || !ast(statement.expression)) { noProtectedReferences(statement); continue; }
      const call = statement.expression;
      if (call.type !== "CallExpression" || !ast(call.callee) || call.callee.type !== "MemberExpression" || call.callee.computed ||
          !ast(call.callee.object) || call.callee.object.name !== "ameliaShortcodeData" || !ast(call.callee.property) || call.callee.property.name !== "push") { noProtectedReferences(statement); continue; }
      if (!Array.isArray(call.arguments) || call.arguments.length !== 1) return fail();
      const props = plainProperties(call.arguments[0]);
      if (props.length !== 14) return fail();
      property(call.arguments[0], "hasApiCall");
      for (const prop of props) {
        const key = ast(prop.key) && (prop.key.name ?? prop.key.value);
        if (!["hasApiCall", "trigger", "trigger_type", "triggered_form", "in_dialog", "show", "counter", "category", "service", "employee", "location", "package", "layout", "ivy"].includes(String(key))) return fail();
        if (key === "hasApiCall") { if (!(ast(prop.value) && prop.value.type === "Literal" && prop.value.value === false) && signature(prop.value) !== hasApiCallExpression) return fail(); }
        else literalTree(prop.value);
      }
      shortcodes.push(call.arguments[0]);
    }
  }
  if (shortcodes.length !== 1 || declarations.get("wpAmeliaUrls")?.length !== 1 || declarations.get("wpAmeliaSettings")?.length !== 1) return fail();
  return { urls: declarations.get("wpAmeliaUrls")![0], settings: declarations.get("wpAmeliaSettings")![0], shortcode: shortcodes[0] };
}
export function parseAmeliaBookingPage(html: string, pageUrl: string, source: AmeliaIdentitySource): AmeliaPage {
  const { booking } = sourceUrls(source);
  if (pageUrl.replace(/\/$/u, "") !== booking.href.replace(/\/$/u, "")) fail("ADAPTER_IDENTITY_MISMATCH");
  const values = declarations(html), counter = literal(property(values.shortcode, "counter"));
  for (const name of ["trigger", "trigger_type", "in_dialog", "show", "category", "service", "employee", "location", "package", "layout", "ivy"]) if (literal(property(values.shortcode, name)) !== "") fail("ADAPTER_SHORTCODE_SCOPE_UNSUPPORTED");
  const shortcode = shortcodeSchema.parse({ form: literal(property(values.shortcode, "triggered_form")), counter, category: null, service: null, employee: null, location: null, package: null });
  const entries = nodes(html), roots = entries.filter(node => attr(node, "id") === `amelia-v2-booking-${shortcode.counter}` && visible(node));
  if (roots.length !== 1 || entries.filter(node => /\bamelia-v2-booking\b/u.test(attr(node, "class") ?? "")).length !== 1) fail("ADAPTER_SHORTCODE_SCOPE_UNSUPPORTED");
  if (literal(property(values.urls, "wpAmeliaPluginURL")) !== "/wp-content/plugins/ameliabooking/" ||
      literal(property(values.urls, "wpAmeliaPluginAjaxURL")) !== "/wp-admin/admin-ajax.php?action=wpamelia_api&call=") fail("ADAPTER_ENDPOINT_UNVERIFIED");
  const publicScripts = entries.filter(node => node.tagName === "script" && attr(node, "src")).map(node => new URL(attr(node, "src")!, pageUrl))
    .filter(url => url.origin === booking.origin && /^\/wp-content\/plugins\/ameliabooking\/v3\/public\/assets\/public\.js$/u.test(url.pathname));
  if (publicScripts.length !== 1 || publicScripts[0].username || publicScripts[0].password || publicScripts[0].hash ||
      [...publicScripts[0].searchParams.keys()].some(key => key !== "ver") || publicScripts[0].searchParams.getAll("ver").length > 1) fail("ADAPTER_CLIENT_UNSUPPORTED");
  const settings = settingsSchema.parse({ timeZone: pathLiteral(values.settings, ["wordpress", "timezone"]),
    showClientTimeZone: pathLiteral(values.settings, ["general", "showClientTimeZone"]), slotLengthSeconds: pathLiteral(values.settings, ["general", "timeSlotLength"]),
    startOfWeek: pathLiteral(values.settings, ["wordpress", "startOfWeek"]), bringingAnyoneLogic: pathLiteral(values.settings, ["appointments", "bringingAnyoneLogic"]),
    bookMultipleTimes: pathLiteral(values.settings, ["appointments", "bookMultipleTimes"]), employeeSelection: pathLiteral(values.settings, ["appointments", "employeeSelection"]),
    isGloballyBusySlot: pathLiteral(values.settings, ["appointments", "isGloballyBusySlot"]) });
  if (settings.timeZone !== source.timeZone) fail("ADAPTER_TIMEZONE_MISMATCH");
  return { apiUrl: new URL("/wp-admin/admin-ajax.php", booking).href, publicClientUrl: publicScripts[0].href, timeZone: source.timeZone, shortcode, settings };
}
export function parseAmeliaPublicClient(body: string, publicClientUrl: string): AmeliaClientWitness {
  if (Buffer.byteLength(body) > 100_000 || hash(body) !== AMELIA_CLIENT_HASHES.public) fail("ADAPTER_CLIENT_UNSUPPORTED");
  const url = new URL(publicClientUrl); if (!publicUrl.safeParse(publicClientUrl).success || !url.pathname.endsWith("/wp-content/plugins/ameliabooking/v3/public/assets/public.js")) fail("ADAPTER_CLIENT_UNSUPPORTED");
  const step = [...body.matchAll(/from["'](\.\/stepForm-[a-f0-9]+\.js)["']/gu)], event = [...body.matchAll(/from["'](\.\/eventBooking-[a-f0-9]+\.js)["']/gu)];
  if (step.length !== 1 || event.length !== 1) fail("ADAPTER_CLIENT_UNSUPPORTED");
  return { publicClientUrl, publicClientSha256: AMELIA_CLIENT_HASHES.public, stepClientUrl: new URL(step[0][1], url).href, eventClientUrl: new URL(event[0][1], url).href };
}
export function verifyAmeliaClients(page: AmeliaPage, witness: AmeliaClientWitness, bodies: { step: string; event: string }): AmeliaVerifiedClients {
  const base = new URL(page.publicClientUrl), directory = base.pathname.replace(/public\.js$/u, "");
  if (page.publicClientUrl !== witness.publicClientUrl || witness.publicClientSha256 !== AMELIA_CLIENT_HASHES.public || Buffer.byteLength(bodies.step) > 2_000_000 || Buffer.byteLength(bodies.event) > 200_000 ||
      hash(bodies.step) !== AMELIA_CLIENT_HASHES.step || hash(bodies.event) !== AMELIA_CLIENT_HASHES.event) fail("ADAPTER_CLIENT_UNSUPPORTED");
  for (const [kind, value] of [["stepForm", witness.stepClientUrl], ["eventBooking", witness.eventClientUrl]]) {
    const url = new URL(value); if (url.origin !== base.origin || url.search || url.hash || !new RegExp(`^${directory}${kind}-[a-f0-9]+\\.js$`, "u").test(url.pathname)) fail("ADAPTER_CLIENT_UNSUPPORTED");
  }
  return { ...witness, stepClientSha256: AMELIA_CLIENT_HASHES.step, eventClientSha256: AMELIA_CLIENT_HASHES.event };
}

const excludedRental = /\b(?:lessons?|coaching|classes?|fittings?|tournaments?|events?|part(?:y|ies)|members?|memberships?|leagues?|packages?|gift|retail)\b/iu;
const rental = /\b(?:simulators?|bays?|rooms?|rentals?|time)\b/iu;
const nonGolfResource = /\b(?:baseball|flight|multi[\s-]?sports?|bowling|hockey|soccer|football|basketball|racing|batting|tennis|pickleball|cricket|shooting|archery|disc\s+golf)\b/iu;
const boundedArray = (value: unknown, max: number): unknown[] => Array.isArray(value) && value.length <= max ? value : fail("ADAPTER_CATALOG_INCOMPLETE");
const requiredId = (value: unknown) => positiveId.parse(value);
function safeExtras(value: unknown) {
  const found = boundedArray(value, 40).map(extra => {
    if (!object(extra)) return fail("ADAPTER_CATALOG_INCOMPLETE");
    return [requiredId(extra.id), z.string().min(1).max(200).parse(extra.name), seconds.parse(extra.duration), positiveId.max(100).parse(extra.maxQuantity), z.literal("extra").parse(extra.type)];
  }).sort((a, b) => Number(a[0]) - Number(b[0]));
  if (!unique(found.map(extra => extra[0]))) fail("ADAPTER_CATALOG_AMBIGUOUS");
  return found;
}
/** The reviewed client treats person pricing as price-only. Dormant duration
 * keys do not advertise lengths unless enabled is 'duration' (or legacy true).
 * No period/rule or custom-duration semantics are supported by this reader. */
function safeCustomPricing(input: unknown) {
  let value = input;
  if (typeof value === "string") { if (Buffer.byteLength(value) > 16_384) fail("ADAPTER_RESPONSE_LIMIT"); try { value = JSON.parse(value); } catch { return fail("ADAPTER_CUSTOM_PRICING_UNSUPPORTED"); } }
  if (value === null || value === undefined) return null;
  if (!object(value) || Object.keys(value).some(key => !["enabled", "durations", "persons", "periods"].includes(key)) ||
      ![null, false, "person"].includes(value.enabled as null | false | "person")) fail("ADAPTER_CUSTOM_PRICING_UNSUPPORTED");
  const tiers = (data: unknown, maximumKey: number) => {
    if (Array.isArray(data) && !data.length) return [];
    if (!object(data) || Object.keys(data).length > 100) return fail("ADAPTER_CUSTOM_PRICING_UNSUPPORTED");
    return Object.entries(data).map(([key, tier]) => {
      if (!/^[1-9]\d{0,5}$/u.test(key) || Number(key) > maximumKey || !object(tier) || Object.keys(tier).some(name => !["price", "rules"].includes(name)) ||
          typeof tier.price !== "number" || !Number.isFinite(tier.price) || tier.price < 0 || tier.price > 1_000_000 || !Array.isArray(tier.rules) || tier.rules.length) return fail("ADAPTER_CUSTOM_PRICING_UNSUPPORTED");
      return [Number(key), tier.price];
    }).sort((a, b) => a[0] - b[0]);
  };
  if (!object(value.periods) || Object.keys(value.periods).some(key => !["default", "custom"].includes(key)) ||
      !Array.isArray(value.periods.default) || value.periods.default.length || !Array.isArray(value.periods.custom) || value.periods.custom.length) fail("ADAPTER_CUSTOM_PRICING_UNSUPPORTED");
  return { enabled: value.enabled, durations: tiers(value.durations, 86_400), persons: tiers(value.persons, 100) };
}
/** Project public service/resource facts only. Staff identities, contact data,
 * payment configuration and provider credentials never enter recipe metadata. */
export function parseAmeliaEntities(body: unknown, context: AmeliaPage & AmeliaVerifiedClients): AmeliaMetadata {
  if (!object(body) || body.message !== "Successfully retrieved entities" || !object(body.data)) fail("ADAPTER_CATALOG_INCOMPLETE");
  const data = body.data;
  if (boundedArray(data.locations, 40).length) fail("ADAPTER_LOCATIONS_UNSUPPORTED");
  const categories = boundedArray(data.categories, 40), employees = boundedArray(data.employees, 40), allServices = new Map<number, Record<string, unknown>>(), catalog: unknown[] = [];
  const seenCategoryIds = new Set<number>(), seenServiceIds = new Set<number>(), seenProviderIds = new Set<number>();
  const relations = new Map<number, Set<number>>();
  if (!object(data.entitiesRelations) || Object.keys(data.entitiesRelations).length > 40) fail("ADAPTER_RELATIONS_UNVERIFIED");
  for (const [providerKey, serviceMap] of Object.entries(data.entitiesRelations)) {
    if (!/^[1-9]\d{0,9}$/u.test(providerKey) || !object(serviceMap) || Object.keys(serviceMap).length > 100) fail("ADAPTER_RELATIONS_UNVERIFIED");
    const providerId = requiredId(Number(providerKey)), serviceIds = new Set<number>();
    for (const [serviceKey, locations] of Object.entries(serviceMap)) {
      if (!/^[1-9]\d{0,9}$/u.test(serviceKey) || !Array.isArray(locations) || locations.length !== 1 || locations[0] !== null) fail("ADAPTER_RELATIONS_UNVERIFIED");
      serviceIds.add(requiredId(Number(serviceKey)));
    }
    relations.set(providerId, serviceIds);
  }
  for (const category of categories) {
    if (!object(category) || !["visible", "hidden"].includes(String(category.status))) fail("ADAPTER_CATALOG_INCOMPLETE");
    const categoryId = requiredId(category.id), services = boundedArray(category.serviceList, 100);
    if (seenCategoryIds.has(categoryId)) fail("ADAPTER_CATALOG_AMBIGUOUS"); seenCategoryIds.add(categoryId);
    for (const service of services) {
      if (!object(service) || typeof service.name !== "string" || service.name.length > 200 || !["visible", "hidden", "disabled"].includes(String(service.status)) || typeof service.show !== "boolean") fail("ADAPTER_CATALOG_INCOMPLETE");
      const id = requiredId(service.id); if (seenServiceIds.has(id)) fail("ADAPTER_CATALOG_AMBIGUOUS"); seenServiceIds.add(id);
      catalog.push([categoryId, category.status, id, service.name, service.status, service.show]);
      if (category.status !== "visible" || service.status !== "visible" || !service.show || excludedRental.test(service.name)) continue;
      if (!/\bgolf\b/iu.test(service.name) || !rental.test(service.name) || nonGolfResource.test(service.name)) fail("ADAPTER_RENTAL_UNVERIFIED");
      if (service.mandatoryExtra !== false || service.recurringCycle !== "disabled") fail("ADAPTER_RENTAL_UNSUPPORTED");
      const extras = safeExtras(service.extras), pricing = safeCustomPricing(service.customPricing);
      catalog.push([id, extras, pricing]); allServices.set(id, service);
    }
  }
  const providerServices = new Map<number, number[]>(), providerDurationExtras = new Set<number>();
  for (const employee of employees) {
    if (!object(employee) || employee.type !== "provider" || !["visible", "hidden"].includes(String(employee.status))) fail("ADAPTER_CATALOG_INCOMPLETE");
    const id = requiredId(employee.id), serviceList = boundedArray(employee.serviceList, 100), eligible: number[] = [];
    if (seenProviderIds.has(id)) fail("ADAPTER_CATALOG_AMBIGUOUS"); seenProviderIds.add(id);
    const seenProviderServiceIds = new Set<number>();
    for (const service of serviceList) {
      if (!object(service)) fail("ADAPTER_CATALOG_INCOMPLETE");
      const serviceId = requiredId(service.id), known = allServices.get(serviceId);
      if (!seenServiceIds.has(serviceId)) fail("ADAPTER_PROVIDER_SERVICE_MISMATCH");
      if (seenProviderServiceIds.has(serviceId)) fail("ADAPTER_CATALOG_AMBIGUOUS"); seenProviderServiceIds.add(serviceId);
      if (!known || employee.status !== "visible") continue;
      if (!relations.get(id)?.has(serviceId)) fail("ADAPTER_PROVIDER_SERVICE_MISMATCH");
      if (service.status !== "visible" || service.show !== true || service.name !== known.name || service.duration !== known.duration ||
          service.minCapacity !== known.minCapacity || service.maxCapacity !== known.maxCapacity) fail("ADAPTER_PROVIDER_SERVICE_MISMATCH");
      if (service.mandatoryExtra === true || service.recurringCycle !== undefined && service.recurringCycle !== "disabled") fail("ADAPTER_RENTAL_UNSUPPORTED");
      const pricing = safeCustomPricing(service.customPricing), extras = service.extras === undefined ? [] : safeExtras(service.extras);
      if (extras.some(extra => Number(extra[2]) > 0)) providerDurationExtras.add(serviceId);
      catalog.push(["provider-service", id, serviceId, pricing, extras]);
      eligible.push(serviceId);
    }
    if (!unique(eligible)) fail("ADAPTER_CATALOG_AMBIGUOUS");
    if (eligible.length) providerServices.set(id, eligible.sort((a, b) => a - b));
    catalog.push(["provider", id, employee.status, [...eligible].sort((a, b) => a - b)]);
  }
  const relationProjection = [...relations].map(([providerId, serviceIds]) => {
    if (!seenProviderIds.has(providerId) || [...serviceIds].some(serviceId => !seenServiceIds.has(serviceId))) fail("ADAPTER_RELATIONS_UNVERIFIED");
    return [providerId, [...serviceIds].sort((a, b) => a - b).map(serviceId => [serviceId, [null]])];
  }).sort((a, b) => Number(a[0]) - Number(b[0]));
  catalog.push(["relations", relationProjection]);
  const services = [...allServices].map(([id, value]) => serviceSchema.parse({ id, name: value.name, durationSeconds: value.duration,
    timeBeforeSeconds: value.timeBefore ?? 0, timeAfterSeconds: value.timeAfter ?? 0, minCapacity: value.minCapacity, maxCapacity: value.maxCapacity,
    bringingAnyone: value.bringingAnyone, aggregatedPrice: value.aggregatedPrice,
    hasDurationExtras: providerDurationExtras.has(id) || (value.extras as Record<string, unknown>[]).some(extra => Number(extra.duration) > 0),
    providerIds: [...providerServices].filter(([, ids]) => ids.includes(id)).map(([providerId]) => providerId).sort((a, b) => a - b) })).sort((a, b) => a.id - b.id);
  const providers = [...providerServices].map(([id, serviceIds]) => ({ id, serviceIds })).sort((a, b) => a.id - b.id);
  catalog.sort((a, b) => { const left = JSON.stringify(a), right = JSON.stringify(b); return left < right ? -1 : left > right ? 1 : 0; });
  return ameliaMetadataSchema.parse({ family: "AMELIA", ...context, services, providers, catalogHash: hash(JSON.stringify(catalog)) });
}
