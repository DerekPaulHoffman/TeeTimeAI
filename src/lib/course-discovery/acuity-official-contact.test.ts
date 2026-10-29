// @vitest-environment node
import { describe,expect,it,vi } from "vitest";
import { deriveAcuityOfficialContact,acuityOfficialContactProofSchema } from "./acuity-official-contact";
import { registerFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
import type { OfficialIdentityPage } from "./teeitup-official-identity";
import { executeExistingAdapterRecipe,inspectExistingAdapter } from "./existing-adapter-executor";
import { recipeTimeToInstant,venueProofMatches } from "./executor";

const source={officialUrl:"https://example.org/cedar/",bookingUrl:"https://cedar.as.me/schedule/owner123",venueName:"Cedar Indoor Golf & Bar",
  venueAddress:"10 Cedar Street Unit 7, Example, MA 01844, USA",timeZone:"America/New_York",providerFamily:"ACUITY"};
const phone="+14126226959", short="Cedar";
function page():OfficialIdentityPage{return {url:source.officialUrl,browserTransport:"NATIVE_CHROME",html:`<h1>Cedar</h1><ul><li>Market Place<br>10 Cedar Street<br>Example, Massachusetts 01844<br><a href="https://maps.example.org/">Map &amp; Directions</a></li><li>${phone}</li></ul><iframe src="https://cedar.as.me/"></iframe>`,
  visibleEvidence:{title:"Cedar",headings:["Cedar"],linkUrls:["https://maps.example.org/"],addressTexts:["Market Place, 10 Cedar Street, Example, Massachusetts 01844, Map & Directions"],
    phoneTexts:[phone,phone],phoneTextsOmitted:false,delegatedFrameSources:{rows:[{src:"https://cedar.as.me/",visible:true,srcdoc:false,inForm:false}],omitted:false}}};}
const fresh=(p=page())=>registerFreshNativeOfficialIdentityPage(p,source.officialUrl,new Date(Date.now()+30000));
describe("independent Acuity physical contact for a terminal category suffix",()=>{
  it("earns explicit unit omission from a current complete printed base address and independent phone",()=>{
    const proof=deriveAcuityOfficialContact(source,fresh(),short,phone);expect(acuityOfficialContactProofSchema.safeParse(proof).success).toBe(true);
    expect(proof).toMatchObject({venueName:source.venueName,venueAddress:source.venueAddress,providerName:short,addressRepresentation:"CANONICAL_UNIT_OMITTED"});
    expect(JSON.stringify(proof)).not.toContain(phone);
  });
  it.each(["copy","changed","foreign-address","incomplete","foreign-phone","two-phones","hidden-card","missing-heading","other-brand","hidden-frame","srcdoc","form","two-frames"])("rejects %s",kind=>{
    const p=page();let brand=short;
    if(kind==="foreign-address")p.html=p.html.replace("10 Cedar","11 Cedar");
    if(kind==="incomplete")p.visibleEvidence!.addressTexts=["10 Cedar Street"];
    if(kind==="foreign-phone")p.visibleEvidence!.phoneTexts=["+14126226950"];
    if(kind==="two-phones")p.html=p.html.replace("</ul>","<li>+14126226950</li></ul>");
    if(kind==="hidden-card")p.html=p.html.replace("<ul>",'<ul hidden>');
    if(kind==="missing-heading")p.visibleEvidence!.headings=[];
    if(kind==="other-brand")brand="Another Cedar";
    if(kind==="hidden-frame")p.visibleEvidence!.delegatedFrameSources!.rows[0].visible=false;
    if(kind==="srcdoc")p.visibleEvidence!.delegatedFrameSources!.rows[0].srcdoc=true;
    if(kind==="form")p.visibleEvidence!.delegatedFrameSources!.rows[0].inForm=true;
    if(kind==="two-frames")p.html+='<iframe src="https://other.as.me/"></iframe>';
    const captured=fresh(p);const value=kind==="copy"?structuredClone(captured):captured;
    if(kind==="changed")value.html+=" changed";
    expect(()=>deriveAcuityOfficialContact(source,value,brand,phone)).toThrow("ACUITY_OFFICIAL_CONTACT_UNVERIFIED");
  });
  it("rejects arbitrary canonical aliases and missing trusted phone",()=>{
    expect(()=>deriveAcuityOfficialContact({...source,venueName:"Cedar Sports Complex"},fresh(),short,phone)).toThrow();
    expect(()=>deriveAcuityOfficialContact(source,fresh(),short,"")).toThrow();
  });
});

function html(){return `<script>var BUSINESS=${JSON.stringify({name:short,id:345,ownerKey:"owner123",timezone:source.timeZone,includesAdminOnly:false,isExpired:false,
  description:"Public simulator rental",calendars:{"":[{id:"any",name:"Any available",timezone:""}]},appointmentTypes:{"":[{id:101,name:"Simulator Booking 1 Hour",duration:60,
    active:true,private:false,type:"service",classSize:null,canChooseQuantity:false,paddingBefore:0,paddingAfter:0,calendarIDs:["any"]}]}})};</script>`;}
const input={date:"2030-10-31",players:2,startTime:"10:00",endTime:"20:00",durationMinutes:60,timeZone:source.timeZone};
function dependencies(badRedirect=false){const native=vi.fn(async()=>fresh()),fetch=vi.fn<typeof globalThis.fetch>(async value=>{const u=new URL(String(value));
  if(u.pathname==="/")return new Response(null,{status:302,headers:{location:badRedirect?"https://other.as.me/schedule/owner123":"/schedule.php"}});
  if(u.pathname==="/schedule.php")return new Response(null,{status:302,headers:{location:"/schedule/owner123"}});
  if(u.pathname.startsWith("/schedule/"))return new Response(html(),{headers:{"content-type":"text/html"}});
  return Response.json({[u.searchParams.get("startDate")!]:[{time:`${u.searchParams.get("startDate")}T12:00:00-0400`,slotsAvailable:1}]});});
  return {fetch,readNativeOfficialPage:native,localCapabilities:["LOCAL_CHROME"] as const,trustedContext:{canonicalCoursePhone:phone},venueMatches:venueProofMatches,
    requestLease:async<T>(_f:string,work:()=>Promise<T>)=>({acquired:true as const,value:await work()}),now:()=>new Date("2030-10-29T00:00:00Z"),recipeHash:"a".repeat(64),toInstant:recipeTimeToInstant};}
describe("fresh official entry and saved native replay",()=>{
  it("binds exact public redirects and refreshes proof independently for changed date/party",async()=>{
    const d=dependencies(),{adapter}=await inspectExistingAdapter(source,d);expect(adapter.family).toBe("ACUITY");
    expect(adapter).toHaveProperty("officialContactProof");expect(d.readNativeOfficialPage).toHaveBeenCalledOnce();
    const saved={schemaVersion:1 as const,engine:"EXISTING_ADAPTER" as const,target:{courseId:"course",offeringId:"offering",kind:"SIMULATOR" as const},source,adapter};
    for(const request of [input,{...input,date:"2030-11-01",players:3}]){const next=dependencies();const result=await executeExistingAdapterRecipe(saved,request,next);
      expect(result).toMatchObject({complete:true,status:"AVAILABLE"});expect(next.readNativeOfficialPage).toHaveBeenCalledOnce();}
  });
  it("rejects foreign entry redirects before availability",async()=>{
    const d=dependencies(true);await expect(inspectExistingAdapter(source,d)).rejects.toThrow("ACUITY_OFFICIAL_CONTACT_UNVERIFIED");
    expect(d.fetch.mock.calls.some(c=>new URL(String(c[0])).pathname.includes("availability"))).toBe(false);
  });
});
