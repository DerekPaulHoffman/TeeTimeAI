import { createHash } from "node:crypto";
import { z } from "zod";
import { teeItUpCompleteStreetAddress } from "./teeitup-official-booking-source";
import type { AccessExecutionInput, AccessExecutionResult } from "./recipe";

const id = z.string().regex(/^[1-9]\d{0,9}$/u), numericId = z.number().int().positive().max(2147483647);
const minute = z.number().int().min(0).max(1440), mask = z.number().int().min(1).max(127);
const scope = z.array(numericId).min(1).max(100).nullable();
const interval = { startTotalMinutes: minute, endTotalMinutes: minute, daysBitmask: mask, spaceIds: scope };
const predicate = z.object({ expression: z.number().int().min(0).max(3), relation: z.number().int().min(0).max(10),
  testValue: z.union([z.number().int().min(0).max(1440), z.array(numericId).min(1).max(100)]) }).strict().refine(p =>
  p.expression === 3 ? [9,10].includes(p.relation) && Array.isArray(p.testValue) : p.relation <= 6 && typeof p.testValue === "number" &&
    (p.relation !== 6 || p.testValue > 0));
const groups = z.array(z.object({ p: z.array(predicate).min(1).max(20) }).strict()).min(1).max(20);
const deny = z.object({ ...interval, mode: z.literal(1), g: groups }).strict().refine(v => v.startTotalMinutes < v.endTotalMinutes);
const windowRule = z.object({ spaceIds: scope, tagIds: scope, value: z.number().int().min(0).max(365),
  predicate: z.number().int().min(1).max(4), mode: z.literal(1), daysBitmask: mask,
  startTotalMinutes: minute.default(0), endTotalMinutes: minute }).strict().refine(v => v.startTotalMinutes < v.endTotalMinutes);
const publicVenue = z.object({ id, name: z.string().min(3).max(200), subdomain: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u),
  streetAddress: z.string().min(5).max(200), city: z.string().min(2).max(80), postcode: z.string().regex(/^\d{5}(?:-\d{4})?$/u),
  twoLetterCountryCode: z.literal("US"), websiteUrl: z.string().url().max(2048), timeZoneId: z.string().min(1).max(100),
  timeGranularityMinutes: z.union([z.literal(15),z.literal(30),z.literal(60)]),
  venueUserTagsAllowedToBook: z.null(), defaultVisitorTag: z.null(), defaultSelfRegisterTag: z.null(),
  contentVisibility: z.object({ bookingRules: z.array(z.never()).max(0) }),
  hoursOfAvailability: z.object({ rules: z.array(z.object({ spaceIds: scope, start: minute, end: minute, daysBitmask: mask }).strict()
    .refine(v => v.start < v.end)).min(1).max(40) }),
  denyRules: z.object({ rules: z.array(deny).max(100) }),
  bufferTime: z.object({ rules: z.array(z.never()).max(0) }),
  bookingRequestRules: z.object({ rules: z.array(z.never()).max(0) }),
  bookingWindow: z.object({ rules: z.array(windowRule).max(100) }),
  // This first reader supports only quotas restricted to named tags. Public
  // anonymous visitors have no tags; a public quota needs its own evaluator.
  quotaRules: z.object({ rules: z.array(z.object({ tagIds: z.array(numericId).min(1).max(100), spaceIds: scope,
    value: z.number().nonnegative(), aggregationMetric: z.number().int(), startTotalMinutes: minute, endTotalMinutes: minute,
    daysBitmask: mask, period: z.number().int(), mode: z.literal(1), isAllowanceRule: z.boolean() }).strict()).max(100) }),
  spacePresentation: z.object({ visibility: z.record(z.string(),z.array(numericId).max(100)),
    capacities: z.array(z.object({ capacity: z.number().int().min(1).max(100), spaceIds: z.array(numericId).max(100) })).max(100) }),
});
const asset = z.object({ id, name: z.string().min(1).max(200), venue: id, parents: z.array(id).max(100), children: z.array(id).max(100) });
export const skeddaWebSchema = z.object({ venue: z.array(publicVenue).length(1), assets: z.array(asset).min(1).max(100) });
export type SkeddaWeb = z.infer<typeof skeddaWebSchema>;
const wall = z.string().regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/u).refine(v =>
  Number.isFinite(Date.parse(v+"Z")) && new Date(v+"Z").toISOString().slice(0,10) === v.slice(0,10));
export const skeddaCalendarSchema = z.object({ bookings: z.array(z.object({ id, start: wall, end: wall,
  endOfLastOccurrence: wall, recurrenceRule: z.null(), spaces: z.array(id).min(1).max(100), venue: id,
  type: z.number().int().min(0).max(8), availabilityStatus: z.union([z.literal(1),z.null()]) })).max(5000),
  bookingslist: z.object({ start: wall, end: wall, bookings: z.array(id).max(5000), idx: z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),z.array(numericId).max(5000)) }) });
export type SkeddaCalendar = z.infer<typeof skeddaCalendarSchema>;
export const skeddaMetadataSchema = z.object({ family: z.literal("SKEDDA"), tenant: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u),
  venueId: id, resourceIds: z.array(id).min(1).max(20).refine(v => new Set(v).size === v.length),
  configurationSha256: z.string().regex(/^[a-f0-9]{64}$/u), warmTransport: z.literal("NATIVE_CHROME"), requiredCapability: z.literal("LOCAL_CHROME") }).strict();
export type SkeddaMetadata = z.infer<typeof skeddaMetadataSchema>;
export type SkeddaSource = { officialUrl?: string; bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string };
const fail = (code = "SKEDDA_PUBLIC_SCHEMA_UNVERIFIED"): never => { throw Error(code); };
export function parseSkeddaSource(value: string) {
  try { const u=new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.port && !u.search && !u.hash &&
    /^[a-z][a-z0-9-]{0,62}\.skedda\.com$/u.test(u.hostname) && u.pathname === "/booking" ? u : null; } catch { return null; }
}
const nameKey = (v: string) => v.normalize("NFKC").toLowerCase().replace(/\s+(?:llc|inc\.?|ltd\.?)\s*$/u, "").replace(/[^\p{L}\p{N}]+/gu," ").trim();
function siteKey(value: string) { const u=new URL(value); if(u.protocol!=="https:"||u.username||u.password||u.port||u.search||u.hash) return fail("ADAPTER_IDENTITY_MISMATCH"); return u.hostname.replace(/^www\./u,"")+u.pathname.replace(/\/$/u,""); }
export function skeddaZonesAgree(a: string,b: string,date: string) {
  try { const f=(zone:string)=>new Intl.DateTimeFormat("en-US",{timeZone:zone,timeZoneName:"longOffset"}); const x=f(a),y=f(b),at=Date.parse(date+"T00:00:00Z");
    return Number.isFinite(at)&&Array.from({length:49},(_,h)=>at+(h-12)*3600000).every(t=>x.formatToParts(t).find(v=>v.type==="timeZoneName")?.value===y.formatToParts(t).find(v=>v.type==="timeZoneName")?.value);
  } catch { return false; }
}
export function deriveSkeddaMetadata(source:SkeddaSource,web:SkeddaWeb,visibleResources:string[],input:AccessExecutionInput) {
  const root=parseSkeddaSource(source.bookingUrl),v=web.venue[0];
  if(!root||!source.officialUrl||!source.venueAddress||input.timeZone!==source.timeZone||v.subdomain!==root.hostname.split(".")[0]||
    siteKey(v.websiteUrl)!==siteKey(source.officialUrl)||nameKey(v.name)!==nameKey(source.venueName)||!skeddaZonesAgree(v.timeZoneId,source.timeZone,input.date))return fail("ADAPTER_IDENTITY_MISMATCH");
  const canonical=teeItUpCompleteStreetAddress(source.venueAddress);
  const provider=canonical&&teeItUpCompleteStreetAddress(`${v.streetAddress}, ${v.city}, ${canonical.region} ${v.postcode}, US`);
  // An explicitly published unit refines a canonical building address. Keep
  // every other component and never discard a unit already in canonical data.
  if(!canonical||!provider||JSON.stringify(canonical.unit?canonical:{...canonical,unit:provider.unit,unitType:provider.unitType})!==JSON.stringify(provider))return fail("ADAPTER_IDENTITY_MISMATCH");
  if(!visibleResources.length||visibleResources.length>100||new Set(visibleResources).size!==visibleResources.length||new Set(web.assets.map(a=>a.id)).size!==web.assets.length||web.assets.some(a=>a.venue!==v.id))return fail();
  const resources=visibleResources.filter(n=>/^(?:golf\s+)?simulator(?:\s+(?:bay\s*)?#?\d+)?$/iu.test(n)).map(n=>{
    const rows=web.assets.filter(a=>a.name===n);if(rows.length!==1||rows[0].parents.length||rows[0].children.length||Object.hasOwn(v.spacePresentation.visibility,rows[0].id))return fail("ADAPTER_RENTAL_SCOPE_UNVERIFIED");return rows[0];
  });
  if(!resources.length||resources.length>20)return fail("ADAPTER_RENTAL_SCOPE_UNVERIFIED");
  // Inspection and replay pass different structural source objects. Hash the
  // canonical contract explicitly, never caller key order or extra fields.
  const identity={officialUrl:source.officialUrl,bookingUrl:source.bookingUrl,venueName:source.venueName,venueAddress:source.venueAddress,timeZone:source.timeZone};
  const configurationSha256=createHash("sha256").update(JSON.stringify({source:identity,venue:v,resources})).digest("hex");
  return skeddaMetadataSchema.parse({family:"SKEDDA",tenant:v.subdomain,venueId:v.id,resourceIds:resources.map(a=>a.id).sort(),configurationSha256,warmTransport:"NATIVE_CHROME",requiredCapability:"LOCAL_CHROME"});
}
export function validateSkeddaCalendar(web:SkeddaWeb,calendar:SkeddaCalendar,requestUrl:string,date:string) {
  const u=new URL(requestUrl),v=web.venue[0],range=calendar.bookingslist;
  if(u.origin!==`https://${v.subdomain}.skedda.com`||u.pathname!=="/bookingslists"||u.hash||[...u.searchParams.keys()].sort().join(",")!=="end,start"||
    u.searchParams.get("start")!==range.start||u.searchParams.get("end")!==range.end||Date.parse(range.start+"Z")>Date.parse(date+"T00:00:00Z")||
    Date.parse(range.end+"Z")<Date.parse(date+"T23:59:59.999Z")||Date.parse(range.end+"Z")-Date.parse(range.start+"Z")>120*86400000)return fail("SKEDDA_DATE_COVERAGE_UNVERIFIED");
  const ids=calendar.bookings.map(b=>b.id),known=new Set(web.assets.map(a=>a.id));
  if(new Set(ids).size!==ids.length||new Set(range.bookings).size!==range.bookings.length||JSON.stringify([...ids].sort())!==JSON.stringify([...range.bookings].sort())||
    Object.values(range.idx).some(values=>new Set(values).size!==values.length||values.some(value=>!ids.includes(String(value)))))return fail("SKEDDA_CALENDAR_INCOMPLETE");
  for(const b of calendar.bookings)if(b.venue!==v.id||new Set(b.spaces).size!==b.spaces.length||b.spaces.some(s=>!known.has(s))||b.end<=b.start||b.endOfLastOccurrence!==b.end)return fail("SKEDDA_CALENDAR_INCOMPLETE");
  const from=date+"T00:00:00",next=new Date(Date.parse(date+"T00:00:00Z")+86400000).toISOString().slice(0,10)+"T00:00:00";
  const overlapping=calendar.bookings.filter(b=>b.start<next&&b.end>from).map(b=>Number(b.id)).sort((a,b)=>a-b);
  if(JSON.stringify(overlapping)!==JSON.stringify([...(range.idx[date]??[])].sort((a,b)=>a-b)))return fail("SKEDDA_CALENDAR_INCOMPLETE");
}
const inSpace=(ids:number[]|null,id:string)=>ids===null||ids.includes(Number(id));
const overlaps=(start:number,end:number,a:number,b:number)=>start<b&&end>a;
function predicateMatches(p:z.infer<typeof predicate>,start:number,end:number,rule:z.infer<typeof deny>) {
  if(p.expression===3)return p.relation===10; // Empty anonymous holder tags.
  const value=p.expression===0?end-start:p.expression===1?Math.max(start-rule.startTotalMinutes,0):Math.max(rule.endTotalMinutes-end,0),test=p.testValue as number;
  return [()=>value<test,()=>value>test,()=>value>=test,()=>value<=test,()=>value===test,()=>value!==test,()=>value%test!==0][p.relation]();
}
export function skeddaOpeningAllowed(web:SkeddaWeb,resourceId:string,input:AccessExecutionInput,start:number,now:Date,toInstant:(value:unknown,input:AccessExecutionInput)=>Date) {
  const v=web.venue[0],end=start+input.durationMinutes!,day=1<<new Date(input.date+"T12:00:00Z").getUTCDay();
  const hours=v.hoursOfAvailability.rules.filter(r=>inSpace(r.spaceIds,resourceId)&&(r.daysBitmask&day));
  // Different overlapping public hour rules require the provider's precedence
  // semantics. Do not silently merge them into wider availability.
  if(hours.length!==1)return fail("SKEDDA_HOURS_UNSUPPORTED");
  if(start<hours[0].start||end>hours[0].end)return false;
  for(const r of v.denyRules.rules)if(inSpace(r.spaceIds,resourceId)&&(r.daysBitmask&day)&&overlaps(start,end,r.startTotalMinutes,r.endTotalMinutes)&&
    r.g.some(g=>g.p.every(p=>predicateMatches(p,start,end,r))))return false;
  const clock=`${input.date}T${String(Math.floor(start/60)).padStart(2,"0")}:${String(start%60).padStart(2,"0")}:00`,at=toInstant(clock,input);
  for(const r of v.bookingWindow.rules){if(r.tagIds!==null||!inSpace(r.spaceIds,resourceId)||!(r.daysBitmask&day)||!overlaps(start,end,r.startTotalMinutes,r.endTotalMinutes))continue;
    if(r.predicate===2&&at.getTime()<now.getTime()+r.value*3600000||r.predicate===4&&at.getTime()>now.getTime()+r.value*3600000)return false;
    if(r.predicate===1||r.predicate===3){const date=new Intl.DateTimeFormat("en-CA",{timeZone:input.timeZone,year:"numeric",month:"2-digit",day:"2-digit"}).format(now),dayStart=Date.parse(date+"T00:00:00Z"),wanted=Date.parse(input.date+"T00:00:00Z");
      if(r.predicate===3&&wanted>dayStart+r.value*86400000)return false;
      if(r.predicate===1){const boundaryDate=new Date(dayStart+r.value*86400000).toISOString().slice(0,10),localClock=new Intl.DateTimeFormat("en-GB",{timeZone:input.timeZone,hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).format(now);if(at>toInstant(boundaryDate+"T"+localClock,input))return false;}
    }
  }
  return true;
}
export function extractSkeddaSlots(source:SkeddaSource,metadata:SkeddaMetadata,web:SkeddaWeb,calendar:SkeddaCalendar,input:AccessExecutionInput,
  now:Date,toInstant:(value:unknown,input:AccessExecutionInput)=>Date):AccessExecutionResult["slots"] {
  const duration=input.durationMinutes,step=web.venue[0].timeGranularityMinutes;
  if(!duration||duration%step||duration<15||duration>480)return fail("ADAPTER_TARGET_MISMATCH");
  const number=(time:string)=>time.split(":").map(Number).reduce((a,b)=>a*60+b),first=Math.ceil(number(input.startTime)/step)*step,last=number(input.endTime),slots:AccessExecutionResult["slots"]=[];
  for(const resourceId of metadata.resourceIds){const capacities=web.venue[0].spacePresentation.capacities.filter(c=>c.spaceIds.includes(Number(resourceId)));
    if(capacities.length>1)return fail("ADAPTER_CONFIGURATION_CHANGED");
    for(let minute=first;minute+duration<=last;minute+=step){if(!skeddaOpeningAllowed(web,resourceId,input,minute,now,toInstant))continue;
      const wall=`${input.date}T${String(Math.floor(minute/60)).padStart(2,"0")}:${String(minute%60).padStart(2,"0")}:00`,endWall=new Date(Date.parse(wall+"Z")+duration*60000).toISOString().slice(0,19);
      if(calendar.bookings.some(b=>b.spaces.includes(resourceId)&&b.start<endWall&&b.end>wall))continue;
      const at=toInstant(wall,input),end=toInstant(endWall,input);if(end.getTime()-at.getTime()!==duration*60000)return fail("SKEDDA_LOCAL_CLOCK_AMBIGUOUS");
      if(at<=now)continue;
      slots.push({sourceId:`skedda:${metadata.venueId}:${resourceId}:${at.toISOString()}:${duration}`,resourceId,productId:`skedda:${resourceId}:${duration}`,
        startsAt:at.toISOString(),endsAt:end.toISOString(),availableSpots:1,capacity:capacities[0]?.capacity??null,bookingUrl:source.bookingUrl});
    }
  }
  return slots;
}
