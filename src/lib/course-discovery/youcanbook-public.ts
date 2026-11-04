import { createHash } from "node:crypto";
import { parse as parseScript } from "acorn";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { completeUSAddress, fullCourseName } from "./teeitup-official-identity";

// Reviewed v1 client: US requests a dated availability key, Qz reads its full
// slots array, and the displayed start timestamps are Unix milliseconds. The
// server creates a SETTING_UP context on an anonymous document GET. No POST,
// selection, cookie, account, booking, or intent is saved in a recipe.
export const YOUCANBOOK_PUBLIC_CLIENT_SHA256 = "f6cee1d801ec86d2d1b8fadea0b40dbe57bbd31dd4ad80e3b365a6551f33d90e";
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(code: string): never { throw Error(code); }
const safeUrl = (value: string) => {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.port && !u.search && !u.hash && u.href === value; }
  catch { return false; }
};
export function parseYouCanBookSource(value: string) {
  if (!safeUrl(value)) return;
  const u = new URL(value), m = /^([a-z][a-z0-9-]{0,61}[a-z0-9])\.youcanbook\.me$/u.exec(u.hostname);
  if (!m || u.pathname !== "/" || /^(?:www|api|app|admin|login|account|test|staging)$/u.test(m[1])) return;
  return { tenant: m[1], origin: u.origin };
}
const room = z.object({ label: z.string().min(2).max(100), officialPageUrl: z.string().max(2048).refine(safeUrl),
  bookingUrl: z.string().max(2048).refine(v => Boolean(parseYouCanBookSource(v))), durationMinutes: z.number().int().min(15).max(480),
  profileId: z.string().uuid(), contextSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export const youCanBookMetadataSchema = z.object({ family: z.literal("YOUCANBOOKME"),
  officialEntryUrl: z.string().max(2048).refine(safeUrl), catalogSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  rooms: z.array(room).min(1).max(4) }).strict().refine(v => new Set(v.rooms.map(r => r.bookingUrl)).size === v.rooms.length &&
    new Set(v.rooms.map(r=>r.profileId)).size===v.rooms.length && new Set(v.rooms.map(r=>r.label)).size===v.rooms.length && new Set(v.rooms.map(r=>r.durationMinutes)).size===1);
export type YouCanBookMetadata = z.infer<typeof youCanBookMetadataSchema>;
/** Per-slot destinations may cross tenant origins only for an exact room in
 * the independently replayed catalog, with its own full-session identifiers. */
export function isYouCanBookRecipeSlotLink(sourceBookingUrl: string, metadata: unknown, slot: {
  sourceId: string; bookingUrl: string; startsAt: string; endsAt?: string; resourceId?: string; productId?: string;
}) {
  const parsed=youCanBookMetadataSchema.safeParse(metadata);
  if(!parsed.success||!parsed.data.rooms.some(room=>room.bookingUrl===sourceBookingUrl))return false;
  const room=parsed.data.rooms.find(room=>room.bookingUrl===slot.bookingUrl&&room.profileId===slot.resourceId);
  const start=Date.parse(slot.startsAt),end=Date.parse(slot.endsAt??"");
  return Boolean(room&&Number.isFinite(start)&&Number.isFinite(end)&&end-start===room.durationMinutes*60000&&
    slot.productId===`ycbm:${room.profileId}:${room.durationMinutes}`&&slot.sourceId===`ycbm:${room.profileId}:${start}:${room.durationMinutes}`);
}
export type YouCanBookSource = { officialUrl: string; bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string };
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const element = (n: Node): n is Element => "tagName" in n;
const attr = (n: Element, k: string) => n.attrs.find(a => a.name === k)?.value ?? "";
const excluded = (n: Element) => ["script", "style", "template", "noscript", "form"].includes(n.tagName) ||
  n.attrs.some(a => ["hidden", "inert"].includes(a.name)) || attr(n, "aria-hidden") === "true" ||
  /display\s*:\s*none|visibility\s*:\s*hidden/iu.test(attr(n, "style"));
const text = (n: Node): string => n.nodeName === "#text" ? (n as DefaultTreeAdapterMap["textNode"]).value :
  element(n) && excluded(n) ? " " : "childNodes" in n ? n.childNodes.map(text).join(" ") : "";
const clean = (v: string) => v.normalize("NFKC").replace(/\s+/gu, " ").trim();
export function readYouCanBookOfficialPage(html: string, url: string) {
  if (Buffer.byteLength(html) > 300_000 || !safeUrl(url)) fail("YOUCANBOOK_OFFICIAL_DOCUMENT_UNVERIFIED");
  const all: Element[] = [], walk = (n: Node) => {
    if (element(n)) { if (excluded(n)) return; all.push(n); }
    if (all.length > 10_000) fail("YOUCANBOOK_OFFICIAL_DOCUMENT_LIMIT");
    if ("childNodes" in n) n.childNodes.forEach(walk);
  };
  const root = parse(html); walk(root);
  const main = all.find(n => n.tagName === "article") ?? all.find(n => n.tagName === "main");
  if (!main) fail("YOUCANBOOK_OFFICIAL_DOCUMENT_UNVERIFIED");
  const inside = new Set<Node>(), visit = (n: Node) => { inside.add(n); if ("childNodes" in n) n.childNodes.forEach(visit); }; visit(main);
  if (all.some(n => inside.has(n) && n.tagName === "iframe")) fail("YOUCANBOOK_OFFICIAL_CATALOG_INCOMPLETE");
  const links = all.filter(n => inside.has(n) && n.tagName === "a").map(n => {
    let href = ""; try { href = new URL(attr(n, "href"), url).href; } catch { /* Not a public route. */ }
    return { href, label: clean(attr(n, "aria-label") || text(n)) };
  }).filter(l => safeUrl(l.href));
  return { text: clean(text(root)), mainText: clean(text(main)), heading: clean(text(all.find(n => inside.has(n) && n.tagName === "h1") ?? main)), links };
}
export function verifyYouCanBookOfficialIdentity(page: ReturnType<typeof readYouCanBookOfficialPage>, source: YouCanBookSource) {
  const address = completeUSAddress(source.venueAddress ?? "");
  if (!address || !(` ${fullCourseName(page.text)} `).includes(` ${fullCourseName(source.venueName)} `)) fail("YOUCANBOOK_OFFICIAL_IDENTITY_UNVERIFIED");
  // Require one whole printed street/locality/state/postal sequence. Components
  // from separated page sections never fill a missing published address.
  const words = (v: string) => v.toLowerCase().replace(/\bdrive\b/gu,"dr").replace(/\broad\b/gu,"rd")
    .replace(/\bstreet\b/gu,"st").replace(/[^a-z0-9]+/gu," ").trim();
  const printed = words(page.text), expected = words(`${address.street} ${address.locality} ${address.region} ${address.postalCode}`);
  if (!(` ${printed} `).includes(` ${expected} `)) fail("YOUCANBOOK_OFFICIAL_IDENTITY_UNVERIFIED");
}
export function youCanBookDuration(label: string) {
  const m = /^(?:(\d{1,2})\s+hours?\s*,?\s*)?(\d{1,3})\s+min(?:ute)?s?$/iu.exec(label);
  if (!m) return;
  const value = Number(m[1] ?? 0) * 60 + Number(m[2]);
  return value >= 15 && value <= 480 ? value : undefined;
}
type JsonObject = Record<string, unknown>;
const object = (v: unknown): JsonObject => v !== null && typeof v === "object" && !Array.isArray(v) ? v as JsonObject : {};
export function parseYouCanBookBootstrap(html: string, bookingUrl: string, expectedZone: string) {
  const source = parseYouCanBookSource(bookingUrl); if (!source || Buffer.byteLength(html) > 300_000) fail("YOUCANBOOK_BOOTSTRAP_UNVERIFIED");
  const scripts: Element[] = [], walk = (n: Node) => {
    if (element(n) && n.tagName === "script") scripts.push(n);
    if (scripts.length > 16) fail("YOUCANBOOK_BOOTSTRAP_UNVERIFIED");
    if ("childNodes" in n) n.childNodes.forEach(walk);
  }; walk(parse(html));
  const server = scripts.filter(n => attr(n,"id") === "server-data");
  const clients = scripts.filter(n => attr(n,"type") === "module" && attr(n,"src"));
  if (server.length !== 1 || clients.length !== 1) fail("YOUCANBOOK_BOOTSTRAP_UNVERIFIED");
  const clientUrl = new URL(attr(clients[0],"src"),bookingUrl);
  if (clientUrl.origin !== source.origin || !/^\/assets\/index-[A-Za-z0-9_-]{4,40}\.js$/u.test(clientUrl.pathname) || clientUrl.search || clientUrl.hash)
    fail("YOUCANBOOK_PUBLIC_CLIENT_UNSUPPORTED");
  const script = server[0].childNodes.filter(n => n.nodeName === "#text").map(n => (n as DefaultTreeAdapterMap["textNode"]).value).join("");
  let ast: ReturnType<typeof parseScript>; try { ast = parseScript(script,{ecmaVersion:2022}); } catch { fail("YOUCANBOOK_BOOTSTRAP_UNVERIFIED"); }
  const assignments=new Set(["window.remoteServer","window.initialI18nStore","window.initialLanguage","window.uiStore","window.requestCache"]);
  if(ast.body.length!==assignments.size||ast.body.some(n=>n.type!=="ExpressionStatement"||n.expression.type!=="AssignmentExpression"||n.expression.operator!=="="||
    !assignments.has(script.slice(n.expression.left.start,n.expression.left.end))))fail("YOUCANBOOK_BOOTSTRAP_UNVERIFIED");
  const assignment = (key: string) => {
    const rows = ast.body.filter(n => n.type === "ExpressionStatement" && n.expression.type === "AssignmentExpression" && n.expression.operator === "=" &&
      script.slice(n.expression.left.start,n.expression.left.end) === "window."+key);
    if (rows.length !== 1 || rows[0].type !== "ExpressionStatement" || rows[0].expression.type !== "AssignmentExpression") fail("YOUCANBOOK_BOOTSTRAP_UNVERIFIED");
    const node=rows[0].expression.right; try { return JSON.parse(script.slice(node.start,node.end)) as unknown; } catch { fail("YOUCANBOOK_BOOTSTRAP_UNVERIFIED"); }
  };
  if(assignment("remoteServer")!=="youcanbook.me")fail("YOUCANBOOK_BOOTSTRAP_UNVERIFIED");
  assignment("initialI18nStore");assignment("initialLanguage");
  const ui=object(assignment("uiStore")),cache=object(assignment("requestCache")),intentId=ui.currentIntentId;
  if (ui.isV2Intent!==false || ui.isPreviewMode!==false || ui.slug!==source.tenant || typeof intentId!=="string" || !/^itt_[a-f0-9-]{36}$/u.test(intentId)) fail("YOUCANBOOK_BOOTSTRAP_UNVERIFIED");
  const cached = (suffix: string) => {
    const entry=object(cache[`https://api.youcanbook.me/v1/intents/${intentId}${suffix}`]),response=object(entry.response);
    if (entry.isLoading!==false || entry.needsRefresh!==false || response.status!==200 || response.ok!==true) fail("YOUCANBOOK_BOOTSTRAP_UNVERIFIED");
    return object(response.data);
  };
  const intent=cached(""), selections=object(intent.selections),context=cached("/context"),c=object(context.configuration),times=object(c.times),duration=object(times.duration);
  if (intent.id!==intentId || intent.bookingId!==null || intent.intentStatus!=="SETTING_UP" || selections.startsAt!==null || selections.form!==null ||
      selections.appointmentTypeIds!==null || selections.teamMemberId!==null || selections.duration!==null || selections.units!==null ||
      Object.keys(selections).sort().join()!=="appointmentTypeIds,duration,form,location,smsConsent,startsAt,teamMemberId,timeZone,units" || Object.values(selections).some(v=>v!==null) ||
      c.status!=="ONLINE" || c.subdomain!==source.tenant || c.captchaActive!==false || object(c.appointmentTypes).active!==false || object(c.teamMembers).active!==false ||
      c.tentative!==false || c.timeZoneOverridable!==false || !Array.isArray(c.locations) || c.locations.length!==1 || object(c.locations[0]).kind!=="IN_PERSON_ANY" ||
      typeof c.id!=="string" || !z.string().uuid().safeParse(c.id).success || !Number.isInteger(times.unitsPerSlot) || Number(times.unitsPerSlot)<1 || Number(times.unitsPerSlot)>20)
    fail("YOUCANBOOK_PUBLIC_CONTEXT_UNSUPPORTED");
  const minutes = typeof duration.default === "string" ? /^PT([1-9]\d{0,2})M$/u.exec(duration.default) : null;
  if (!minutes || JSON.stringify(duration.options)!==JSON.stringify([duration.default]) || Number(minutes[1])<15 || Number(minutes[1])>480) fail("YOUCANBOOK_PUBLIC_DURATION_UNSUPPORTED");
  let zone: string; try { zone=new Intl.DateTimeFormat("en-US",{timeZone:String(c.timeZone)}).resolvedOptions().timeZone;
    if (zone!==new Intl.DateTimeFormat("en-US",{timeZone:expectedZone}).resolvedOptions().timeZone) fail("YOUCANBOOK_TIME_ZONE_CHANGED");
  } catch { fail("YOUCANBOOK_TIME_ZONE_CHANGED"); }
  const title=object(context.common_texts).title,location=object(c.locations[0]).value;
  if(typeof title!=="string"||!/\bgolf\b/iu.test(title)||typeof location!=="string"||location.length>300)fail("YOUCANBOOK_PUBLIC_CONTEXT_UNSUPPORTED");
  const stable={profileId:c.id,tenant:source.tenant,title,location,
    timeZone:zone,durationMinutes:Number(minutes[1]),unitsPerSlot:Number(times.unitsPerSlot)};
  return {intentId,clientUrl:clientUrl.href,...stable,contextSha256:sha(stable)};
}
export function parseYouCanBookSlots(value: unknown, context: ReturnType<typeof parseYouCanBookBootstrap>, input: {date:string;startTime:string;endTime:string;durationMinutes?:number}, now: Date) {
  const data=object(value); if (Object.keys(data).join()!=="slots" || !Array.isArray(data.slots) || data.slots.length>5000 || input.durationMinutes!==context.durationMinutes)
    fail("YOUCANBOOK_AVAILABILITY_UNVERIFIED");
  const date=new Date(input.date+"T00:00:00Z"); if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10)!==input.date) fail("YOUCANBOOK_TARGET_INVALID");
  const parts=(at:Date)=>Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:context.timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(at).map(p=>[p.type,p.value]));
  let previous=-Infinity;
  return data.slots.flatMap(raw=>{
    const s=object(raw);if(Object.keys(s).sort().join()!=="freeUnits,startsAt" || typeof s.startsAt!=="string" || !/^\d{13}$/u.test(s.startsAt) ||
      !Number.isInteger(s.freeUnits) || Number(s.freeUnits)<0 || Number(s.freeUnits)>context.unitsPerSlot) fail("YOUCANBOOK_AVAILABILITY_UNVERIFIED");
    const milliseconds=Number(s.startsAt);if(milliseconds<=previous)fail("YOUCANBOOK_AVAILABILITY_UNVERIFIED");previous=milliseconds;
    const at=new Date(milliseconds),end=new Date(milliseconds+context.durationMinutes*60000),p=parts(at),q=parts(end),localDate=`${p.year}-${p.month}-${p.day}`,endDate=`${q.year}-${q.month}-${q.day}`;
    if(localDate<input.date || Date.parse(localDate+"T00:00:00Z")-date.getTime()>62*86400000)fail("YOUCANBOOK_DATE_COVERAGE_UNVERIFIED");
    const nextDate=new Date(date.getTime()+86400000).toISOString().slice(0,10);
    const endClock=`${q.hour}:${q.minute}`;
    const endWithin=endDate===input.date&&(endClock<input.endTime||endClock===input.endTime&&end.getUTCSeconds()===0&&end.getUTCMilliseconds()===0) ||
      input.endTime==="24:00"&&endDate===nextDate&&q.hour==="00"&&q.minute==="00"&&end.getUTCSeconds()===0&&end.getUTCMilliseconds()===0;
    if(localDate!==input.date||at<=now||Number(s.freeUnits)===0||`${p.hour}:${p.minute}`<input.startTime||!endWithin)return[];
    return[{startsAt:at.toISOString(),endsAt:end.toISOString(),freeBays:Number(s.freeUnits)}];
  });
}
