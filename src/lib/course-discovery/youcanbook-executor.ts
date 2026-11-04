import { createHash } from "node:crypto";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { accessExecutionInputSchema, isSafeRecipeUrl, type AccessExecutionInput, type AccessExecutionResult } from "./recipe";
import { requestFamilyForUrl } from "./request-family";
import { completeUSAddress } from "./teeitup-official-identity";
import { parseYouCanBookBootstrap, parseYouCanBookSlots, parseYouCanBookSource, readYouCanBookOfficialPage, verifyYouCanBookOfficialIdentity,
  youCanBookDuration, youCanBookMetadataSchema, YOUCANBOOK_PUBLIC_CLIENT_SHA256, type YouCanBookMetadata, type YouCanBookSource } from "./youcanbook-public";

type Dependencies = { fetch?: typeof fetch; deadlineAt?: Date; signal?: AbortSignal; now?: () => Date;
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{acquired:true;value:T}|{acquired:false}> };
function fail(code:string):never{throw Error(code)}
const hash=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const sameOfficial=(url:string,official:string)=>new URL(url).hostname.replace(/^www\./u,"")===new URL(official).hostname.replace(/^www\./u,"");
function createReader(source:YouCanBookSource,deps:Dependencies){
  if(!source.venueAddress||!isSafeRecipeUrl(source.officialUrl)||new URL(source.officialUrl).pathname!=="/"||new URL(source.officialUrl).search||new URL(source.officialUrl).hash||!parseYouCanBookSource(source.bookingUrl))fail("ADAPTER_IDENTITY_MISSING");
  const deadline=Math.min(Date.now()+120000,deps.deadlineAt?.getTime()??Infinity);
  if(!Number.isFinite(deadline)||deadline<=Date.now())fail("DEADLINE_EXCEEDED");
  const signal=AbortSignal.any([AbortSignal.timeout(deadline-Date.now()),...(deps.signal?[deps.signal]:[])]);
  const queue=createSimulatorBrowserRequestQueue(deps.requestLease??runWithProviderRequestLease,signal);let requests=0,bytes=0;
  const read=async(url:string,kind:"HTML"|"JSON"|"CLIENT",rootRedirect=false):Promise<{url:string;text:string}>=>{
    if(++requests>24||!isSafeRecipeUrl(source.officialUrl))fail("YOUCANBOOK_REQUEST_LIMIT");
    const u=new URL(url);
    const publicApi=u.origin==="https://api.youcanbook.me"&&kind==="JSON"&&
      (/^\/v1\/intents\/itt_[a-f0-9-]{36}\/availabilitykey$/u.test(u.pathname)&&u.searchParams.size===1&&/^\d{4}-\d{2}-\d{2}$/u.test(u.searchParams.get("startSearchAt")??"")||
       /^\/v1\/availabilities\/avl_[a-f0-9]{64}T_[1-9]\d{0,6}$/u.test(u.pathname)&&!u.search);
    const publicDocument=kind==="HTML"&&!u.search&&!u.hash&&isSafeRecipeUrl(url)&&(sameOfficial(url,source.officialUrl)||Boolean(parseYouCanBookSource(url)));
    const publicClient=kind==="CLIENT"&&!u.search&&!u.hash&&Boolean(parseYouCanBookSource(u.origin+"/"))&&/^\/assets\/index-[A-Za-z0-9_-]{4,40}\.js$/u.test(u.pathname);
    if(u.protocol!=="https:"||u.username||u.password||u.port||u.hash||!(publicApi||publicDocument||publicClient))fail("YOUCANBOOK_UNSCOPED_READ");
    const limit=kind==="CLIENT"?3000000:300000;
    const transport=deps.fetch??createAddressPinnedPublicFetchTransport({parseUrl:value=>{if(value!==url)fail("YOUCANBOOK_UNSCOPED_READ");return new URL(value)},maxResponseBytes:limit,timeoutMs:15000,redirectLimit:0});
    const readResult=await queue.run(requestFamilyForUrl(url),async():Promise<{redirectUrl:string}|{url:string;text:string}>=>{
    const response=await transport(url,{method:"GET",credentials:"omit",redirect:"manual",cache:"no-store",signal,
      headers:{accept:kind==="HTML"?"text/html":kind==="JSON"?"application/json":"application/javascript, text/javascript","user-agent":"TeeTimeSpot/1.0 (+https://teetimespot.com)"}});
    try{
      if(response.redirected||response.url&&response.url!==url)fail("YOUCANBOOK_TRANSPORT_FAILED");
      if(rootRedirect&&[301,302,307,308].includes(response.status)){
        const next=new URL(response.headers.get("location")??"",url);
        if(!sameOfficial(next.href,source.officialUrl)||next.pathname!=="/"||next.search||next.hash||next.origin===u.origin)fail("YOUCANBOOK_OFFICIAL_REDIRECT_UNVERIFIED");
        await response.body?.cancel();return{redirectUrl:next.href};
      }
      if(response.status!==200)fail(response.status===429?"PROVIDER_THROTTLED":"YOUCANBOOK_TRANSPORT_FAILED");
      const type=response.headers.get("content-type")??"";
      if(!(kind==="HTML"?/^text\/html(?:;|$)/iu:kind==="JSON"?/^application\/json(?:;|$)/iu:/^(?:application|text)\/(?:javascript|x-javascript)(?:;|$)/iu).test(type))fail("YOUCANBOOK_RESPONSE_INVALID");
      const content=await response.arrayBuffer();bytes+=content.byteLength;
      if(content.byteLength>limit||bytes>8000000)fail("YOUCANBOOK_RESPONSE_LIMIT");
      signal.throwIfAborted();return{url,text:new TextDecoder("utf-8",{fatal:true}).decode(content)};
    }finally{if(!response.bodyUsed)await response.body?.cancel().catch(()=>{});}
    });
    if("redirectUrl"in readResult)return read(readResult.redirectUrl,"HTML");
    return readResult;
  };
  return{read,signal,close:()=>queue.dispose()};
}
async function catalog(source:YouCanBookSource,reader:ReturnType<typeof createReader>){
  const root=await reader.read(source.officialUrl,"HTML",true),page=readYouCanBookOfficialPage(root.text,root.url);verifyYouCanBookOfficialIdentity(page,source);
  const entries=[...new Set(page.links.filter(l=>/\b(?:book\s*now|simulator\s*rentals?)\b/iu.test(l.label)&&sameOfficial(l.href,root.url)&&l.href!==root.url).map(l=>l.href))];
  if(entries.length!==1)fail("YOUCANBOOK_OFFICIAL_ENTRY_UNVERIFIED");
  const entry=await reader.read(entries[0],"HTML"),roomsPage=readYouCanBookOfficialPage(entry.text,entry.url);
  if(!/^select (?:a )?room$/iu.test(roomsPage.heading)||!/all rooms are private bays/iu.test(roomsPage.mainText)||!/rates are per room, not per person/iu.test(roomsPage.mainText))fail("YOUCANBOOK_OFFICIAL_CATALOG_UNVERIFIED");
  const rooms=roomsPage.links.flatMap(l=>{const m=/^select (.{2,100}) room$/iu.exec(l.label);return m&&sameOfficial(l.href,entry.url)&&new URL(l.href).origin===new URL(entry.url).origin?[{label:m[1],officialPageUrl:l.href}]:[]});
  if(!rooms.length||rooms.length>4||new Set(rooms.map(r=>r.label)).size!==rooms.length||new Set(rooms.map(r=>r.officialPageUrl)).size!==rooms.length)fail("YOUCANBOOK_OFFICIAL_CATALOG_INCOMPLETE");
  const result=[];
  for(const room of rooms){
    const body=await reader.read(room.officialPageUrl,"HTML"),page=readYouCanBookOfficialPage(body.text,body.url);
    if(!/^select booking duration$/iu.test(page.heading))fail("YOUCANBOOK_OFFICIAL_CATALOG_UNVERIFIED");
    const rentals=page.links.filter(l=>parseYouCanBookSource(l.href)).map(l=>({bookingUrl:l.href,durationMinutes:youCanBookDuration(l.label)}));
    if(!rentals.length||rentals.length>8||rentals.some(r=>!r.durationMinutes)||new Set(rentals.map(r=>r.durationMinutes)).size!==rentals.length)fail("YOUCANBOOK_OFFICIAL_CATALOG_INCOMPLETE");
    result.push({...room,rentals});
  }
  return{entryUrl:entry.url,rooms:result,catalogSha256:hash(result)};
}
async function inspect(source:YouCanBookSource,deps:Dependencies){
  const reader=createReader(source,deps);
  try{
  const directory=await catalog(source,reader);
  const sourceRental=directory.rooms.flatMap(r=>r.rentals).find(r=>r.bookingUrl===source.bookingUrl);
  if(!sourceRental?.durationMinutes)fail("YOUCANBOOK_OFFICIAL_SOURCE_UNVERIFIED");
  const rooms:YouCanBookMetadata["rooms"]=[],contexts=[];
  for(const room of directory.rooms){
    const selected=room.rentals.filter(r=>r.durationMinutes===sourceRental.durationMinutes);
    if(selected.length!==1)fail("YOUCANBOOK_RENTAL_SCOPE_UNSUPPORTED");
    const document=await reader.read(selected[0].bookingUrl,"HTML"),context=parseYouCanBookBootstrap(document.text,document.url,source.timeZone);
    const client=await reader.read(context.clientUrl,"CLIENT");
    if(createHash("sha256").update(client.text).digest("hex")!==YOUCANBOOK_PUBLIC_CLIENT_SHA256)fail("YOUCANBOOK_PUBLIC_CLIENT_UNSUPPORTED");
    const addressWords=(v:string)=>v.toLowerCase().replace(/\bdrive\b/gu,"dr").replace(/\broad\b/gu,"rd").replace(/\bstreet\b/gu,"st").replace(/[^a-z0-9]+/gu," ").trim();
    // The provider's published location must be a whole prefix of the canonical
    // street/locality/state/postal address. A different house or locality fails.
    const canonical=completeUSAddress(source.venueAddress!);if(!canonical)fail("ADAPTER_IDENTITY_MISSING");
    const expected=addressWords(`${canonical.street} ${canonical.locality} ${canonical.region}`);
    const location=addressWords(context.location);
    if(context.durationMinutes!==sourceRental.durationMinutes||![expected,expected+" "+canonical.postalCode].includes(location))fail("YOUCANBOOK_PROVIDER_IDENTITY_UNVERIFIED");
    rooms.push({label:room.label,officialPageUrl:room.officialPageUrl,bookingUrl:document.url,durationMinutes:context.durationMinutes,profileId:context.profileId,contextSha256:context.contextSha256});
    contexts.push(context);
  }
  const metadata=youCanBookMetadataSchema.parse({family:"YOUCANBOOKME",officialEntryUrl:directory.entryUrl,catalogSha256:directory.catalogSha256,rooms});
  return{metadata,contexts,reader};
  }catch(error){reader.close();throw error;}
}
export async function inspectYouCanBook(source:YouCanBookSource,deps:Dependencies){const result=await inspect(source,deps);try{return result.metadata;}finally{result.reader.close();}}
export async function executeYouCanBook(source:YouCanBookSource,saved:YouCanBookMetadata,input:AccessExecutionInput,deps:Dependencies):Promise<AccessExecutionResult["slots"]>{
  input=accessExecutionInputSchema.parse(input);
  if(!input.durationMinutes||input.timeZone!==source.timeZone)fail("ADAPTER_TARGET_MISMATCH");
  const result=await inspect(source,deps);
  try{
  if(JSON.stringify(result.metadata)!==JSON.stringify(youCanBookMetadataSchema.parse(saved)))fail("ADAPTER_CONFIGURATION_CHANGED");
  const slots:AccessExecutionResult["slots"]=[];
  for(const [index,context]of result.contexts.entries()){
    if(context.durationMinutes!==input.durationMinutes)fail("ADAPTER_TARGET_MISMATCH");
    const keyResponse=await result.reader.read(`https://api.youcanbook.me/v1/intents/${context.intentId}/availabilitykey?startSearchAt=${input.date}`,"JSON");
    let key;try{key=JSON.parse(keyResponse.text)}catch{fail("YOUCANBOOK_AVAILABILITY_UNVERIFIED")}
    if(!key||Object.keys(key).join()!=="key"||!/^avl_[a-f0-9]{64}T_[1-9]\d{0,6}$/u.test(key.key??""))fail("YOUCANBOOK_AVAILABILITY_UNVERIFIED");
    const availability=await result.reader.read(`https://api.youcanbook.me/v1/availabilities/${key.key}`,"JSON");
    let data;try{data=JSON.parse(availability.text)}catch{fail("YOUCANBOOK_AVAILABILITY_UNVERIFIED")}
    const room=result.metadata.rooms[index];
    for(const slot of parseYouCanBookSlots(data,context,input,deps.now?.()??new Date()))slots.push({sourceId:`ycbm:${room.profileId}:${Date.parse(slot.startsAt)}:${input.durationMinutes}`,
      startsAt:slot.startsAt,endsAt:slot.endsAt,availableSpots:1,capacity:null,resourceId:room.profileId,productId:`ycbm:${room.profileId}:${input.durationMinutes}`,bookingUrl:room.bookingUrl});
  }
  if(slots.length>500)fail("YOUCANBOOK_AVAILABILITY_LIMIT");return slots;
  }finally{result.reader.close();}
}
