import { afterEach, describe, expect, it, vi } from "vitest";
import { delegatedBookingHop, delegatedWitnessHash, bindDelegatedFacility, teeItUpDelegatedBookingProofSchema } from "./teeitup-delegated-booking-source";
import { authorizeDelegatedGet, consumeDelegatedGet, currentNativeDelegatedChain, type DelegatedGetGrant } from "./teeitup-delegated-booking-context";
import { registerFreshNativeOfficialIdentityPage, registerFreshNativeDelegatedDocument } from "./native-official-page-attestation";
import { readNativeDelegatedDocument } from "./native-official-page-reader";
import { readTeeItUpDelegatedBookingChain } from "./teeitup-delegated-booking-reader";
import { inspectExistingAdapter, executeExistingAdapterRecipe } from "./existing-adapter-executor";
import { parseAccessRecipe } from "./recipe";
import type { OfficialIdentityPage, OfficialIdentitySource } from "./teeitup-official-identity";

const source={officialUrl:"https://public.example/",bookingUrl:"https://public.book.teeitup.com/",venueName:"Public Golf Course",venueAddress:"10 Public Road, Example, NY 12345, USA",timeZone:"America/New_York"};
const operator="https://public.example/tee-times/",directory=[{id:11,courseId:"11",name:source.venueName,address:source.venueAddress,timeZone:source.timeZone,isSimulator:false}];
function rawParent():OfficialIdentityPage{return{url:operator,browserTransport:"NATIVE_CHROME",html:'<html><body><iframe src="'+source.bookingUrl+'"></iframe></body></html>',
 visibleEvidence:{title:"Public Booking",headings:[],addressTexts:[],linkUrls:[],delegatedFrameSources:{rows:[{src:source.bookingUrl,visible:true,srcdoc:false,inForm:false}],omitted:false}}};}
const registered=(p=rawParent())=>registerFreshNativeDelegatedDocument(p,source.officialUrl,new Date(Date.now()+120000));
function root(){return registerFreshNativeOfficialIdentityPage({url:source.officialUrl,browserTransport:"NATIVE_CHROME",html:'<h1>'+source.venueName+'</h1><address>'+source.venueAddress+'</address><a href="'+operator+'">Book Tee Times</a>',visibleEvidence:{title:source.venueName,headings:[source.venueName],addressTexts:[source.venueAddress],linkUrls:[operator]}},source.officialUrl,new Date(Date.now()+120000));}
afterEach(()=>vi.restoreAllMocks());
describe("fresh native exact final iframe source hop",()=>{
 it("earns one exact main GET from the current parent and binds the kind into its semantic witness",()=>{
  const p=registered(),hop=delegatedBookingHop(p,source.bookingUrl,undefined,source.officialUrl);
  expect(hop).toEqual({pageUrl:operator,nextUrl:source.bookingUrl,kind:"NATIVE_VISIBLE_IFRAME_SRC",witnessSha256:delegatedWitnessHash({pageUrl:operator,nextUrl:source.bookingUrl,kind:"NATIVE_VISIBLE_IFRAME_SRC"})});
  expect(()=>delegatedBookingHop(p)).toThrow();expect(()=>delegatedBookingHop(p,source.bookingUrl)).toThrow();
  const grant=authorizeDelegatedGet(p,source.officialUrl,new Date(Date.now()+30000),source.bookingUrl);
  expect(()=>consumeDelegatedGet(structuredClone(grant.token))).toThrow();expect(consumeDelegatedGet(grant.token).url).toBe(source.bookingUrl);expect(()=>consumeDelegatedGet(grant.token)).toThrow();
 });
 it.each(["srcdocEmpty","srcdocBody","hidden","inert","ariaHidden","collapse","opacity","form","rawMissing","rawMismatch","renderedMissing","renderedHidden","renderedForm","renderedSrcdoc","overflow","overlong","extraRaw","extraRendered","malformed","foreignRoot","copied","stale","mutated","firstHopRoot","otherSource","nonProvider","query"])
 ("rejects %s without granting a provider read",variant=>{
  let now=Date.now();vi.spyOn(Date,"now").mockImplementation(()=>now);
  const p=rawParent(),rows=p.visibleEvidence!.delegatedFrameSources!.rows;
  if(variant==="srcdocEmpty")p.html=p.html.replace("<iframe ",'<iframe srcdoc="" ');
  if(variant==="srcdocBody")p.html=p.html.replace("<iframe ",'<iframe srcdoc="private" ');
  if(variant==="hidden"||variant==="inert")p.html=p.html.replace("<iframe ",'<iframe '+variant+' ');
  if(variant==="ariaHidden")p.html=p.html.replace("<iframe ",'<iframe aria-hidden="true" ');
  if(variant==="collapse"||variant==="opacity")p.html=p.html.replace("<iframe ",'<iframe style="'+(variant==="collapse"?'visibility:collapse':'opacity:0')+'" ');
  if(variant==="form")p.html=p.html.replace("<iframe ","<form><iframe ").replace("</iframe>","</iframe></form>");
  if(variant==="rawMissing")p.html="<html><body>Public</body></html>";
  if(variant==="rawMismatch")p.html=p.html.replace(source.bookingUrl,"https://other.book.teeitup.com/");
  if(variant==="renderedMissing")rows.length=0;if(variant==="renderedHidden")rows[0].visible=false;
  if(variant==="renderedForm")rows[0].inForm=true;if(variant==="renderedSrcdoc")rows[0].srcdoc=true;
  if(variant==="overflow")p.visibleEvidence!.delegatedFrameSources!.omitted=true;
  if(variant==="overlong")rows[0].src="x".repeat(2049);
  if(variant==="extraRaw")p.html=p.html.replace("</body>",'<iframe src="https://other.book.teeitup.com/"></iframe></body>');
  if(variant==="extraRendered")rows.push({...rows[0]});
  if(variant==="malformed")(rows[0] as unknown as Record<string,unknown>).private="PRIVATE";
  let page=registered(p);
  if(variant==="copied")page=structuredClone(page);if(variant==="stale")now+=30001;if(variant==="mutated")page.html+="changed";
  if(variant==="firstHopRoot")page=registerFreshNativeOfficialIdentityPage(rawParent(),source.officialUrl,new Date(now+30000));
  const requested=variant==="otherSource"?"https://other.book.teeitup.com/":variant==="nonProvider"?"https://booking.example/":variant==="query"?source.bookingUrl+"?course=11":source.bookingUrl;
  expect(()=>authorizeDelegatedGet(page,variant==="foreignRoot"?"https://foreign.example/":source.officialUrl,new Date(now+30000),requested)).toThrow();
 });
 it("preserves conflicting genuine anchor/frame ambiguity while a real exact anchor retains its legacy shape",()=>{
  const p=rawParent();p.html+='<a href="https://public.example/other/">Book Tee Times</a>';p.visibleEvidence!.linkUrls.push("https://public.example/other/");
  expect(()=>authorizeDelegatedGet(registered(p),source.officialUrl,new Date(Date.now()+30000),source.bookingUrl)).toThrow();
  const anchor=rawParent();anchor.html+='<a href="'+source.bookingUrl+'">Book Tee Times</a>';anchor.visibleEvidence!.linkUrls.push(source.bookingUrl);
  expect(authorizeDelegatedGet(registered(anchor),source.officialUrl,new Date(Date.now()+30000),source.bookingUrl).hop.kind).toBeUndefined();
 });
 it("stops readiness on the observed exact frame without renewing clocks or observing for the full rendering limit",async()=>{
  const grant=authorizeDelegatedGet(root(),source.officialUrl,new Date(Date.now()+30000),operator),execute=vi.fn(async()=>({url:operator,navigationStatus:200,browserTransport:"NATIVE_CHROME"})),close=vi.fn(async()=>{});
  const createSession=vi.fn(async()=>({execute,close,readOfficialIdentityPage:vi.fn(),readDelegatedSourceDocument:async()=>rawParent()}));
  const p=await readNativeDelegatedDocument(source,grant.token,{createSession:createSession as never});
  expect(execute).toHaveBeenCalledTimes(1);expect(close).toHaveBeenCalledTimes(1);
  expect(delegatedBookingHop(p,source.bookingUrl,undefined,source.officialUrl).kind).toBe("NATIVE_VISIBLE_IFRAME_SRC");
 });
 it("serializes the typed final hop and rebuilds both native documents for two fresh warm inputs",async()=>{
  const hops=vi.fn(async(_s:OfficialIdentitySource,grant:DelegatedGetGrant)=>{const next=consumeDelegatedGet(grant);return next.url===operator?registered():registerFreshNativeDelegatedDocument({url:next.url,browserTransport:"NATIVE_CHROME",html:"Public booking",visibleEvidence:{title:"Public",headings:[],addressTexts:[],linkUrls:[]}},source.officialUrl,new Date(Date.now()+120000));});
  const roots=vi.fn(async()=>root()),lease=async<T>(_f:string,work:()=>Promise<T>)=>({acquired:true as const,value:await work()}),fetcher=vi.fn<typeof fetch>(async value=>Response.json(new URL(String(value)).pathname.endsWith("facilities")?directory:[{courseId:"11",teetimes:[]}]));
  const deps={localCapabilities:["LOCAL_CHROME"] as const,readDelegatedRoot:roots,readNativeOfficialPage:roots,readDelegatedDocument:hops,deadlineAt:new Date(Date.now()+120000),requestLease:lease,fetch:fetcher};
  const token=await readTeeItUpDelegatedBookingChain(source,deps),chain=currentNativeDelegatedChain(token),proof=bindDelegatedFacility(source,chain,directory);
  expect(teeItUpDelegatedBookingProofSchema.parse(JSON.parse(JSON.stringify(proof)))).toEqual(proof);
  for(const edit of [(v:typeof proof)=>v.hops[1].witnessSha256="a".repeat(64),(v:typeof proof)=>v.hops[0].kind="NATIVE_VISIBLE_IFRAME_SRC"]){const p=structuredClone(proof);edit(p);expect(teeItUpDelegatedBookingProofSchema.safeParse(p).success).toBe(false);}
  const inspected=await inspectExistingAdapter(source,{...deps,nativeDelegatedChainToken:token}),recipe=parseAccessRecipe({schemaVersion:1,engine:"EXISTING_ADAPTER",target:{courseId:"ordinary",kind:"OUTDOOR"},source:{...source,providerFamily:"TEEITUP"},adapter:inspected.adapter});
  for(const date of["2030-10-24","2030-10-25"]){const result=await executeExistingAdapterRecipe(recipe as never,{date,players:2,startTime:"08:00",endTime:"18:00",timeZone:source.timeZone},{...deps,recipeHash:"b".repeat(64),toInstant:value=>new Date(String(value))});expect(result.complete).toBe(true);}
  expect(roots).toHaveBeenCalledTimes(3);expect(hops).toHaveBeenCalledTimes(6);
 });
});
