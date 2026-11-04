// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
vi.mock("./youcanbook-public",async original=>({...(await original<typeof import("./youcanbook-public")>()),
  YOUCANBOOK_PUBLIC_CLIENT_SHA256:(await import("node:crypto")).createHash("sha256").update("synthetic reviewed public client").digest("hex")}));
import { executeYouCanBook, inspectYouCanBook } from "./youcanbook-executor";
import { executeAccessRecipe } from "./executor";
import { parseAccessRecipe } from "./recipe";
const source={officialUrl:"https://official.example/",bookingUrl:"https://indoor-example.youcanbook.me/",venueName:"Example Indoor Golf",venueAddress:"123 Main St, Example, CT 06001, USA",timeZone:"America/New_York"};
const input={date:"2030-01-02",startTime:"09:00",endTime:"18:00",players:2,durationMinutes:50,timeZone:source.timeZone};
const page=(heading:string,body:string)=>`<article><h1>${heading}</h1>${body}</article><footer>Example Indoor Golf | 123 Main Street, Example, CT 06001</footer>`;
function fixture(change?:(url:URL,text:string)=>string){
  let active=0,maxActive=0,nonce=0;const reads:Array<{url:string;method:string}>=[],dates=new Map<string,string>();
  const deps={now:()=>new Date("2030-01-01"),requestLease:async<T>(_family:string,work:()=>Promise<T>)=>{active++;maxActive=Math.max(active,maxActive);try{return{acquired:true as const,value:await work()}}finally{active--}},
    fetch:(async(value,init)=>{
      const url=new URL(String(value));expect(active).toBe(1);expect(init?.credentials).toBe("omit");expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).has("cookie")).toBe(false);expect(new Headers(init?.headers).has("authorization")).toBe(false);
      reads.push({url:url.href,method:init?.method??"GET"});let text="",type="text/html";
      if(url.href===source.officialUrl)text=page(source.venueName,'<a href="/rooms/">Book Now</a>');
      else if(url.href==="https://official.example/rooms/")text=page("Select a Room",'All rooms are private bays! All rates are per room, not per person.<a href="/wide/" aria-label="Select Widescreen room">Select this room</a><a href="/curve/" aria-label="Select Curve room">Select this room</a>');
      else if(url.origin==="https://official.example")text=page("Select Booking Duration",`<a href="https://${url.pathname==="/wide/"?"indoor-example":"indoor-curve"}.youcanbook.me/">50 Minutes</a>`);
      else if(url.pathname.startsWith("/assets/")){type="text/javascript";text="synthetic reviewed public client";}
      else if(url.hostname.endsWith(".youcanbook.me")&&url.pathname==="/"){
        const tenant=url.hostname.split(".")[0],id=`itt_12345678-1234-1234-1234-${String(++nonce).padStart(12,"0")}`;
        const intent={id,bookingId:null,intentStatus:"SETTING_UP",selections:{appointmentTypeIds:null,duration:null,form:null,location:null,smsConsent:null,startsAt:null,teamMemberId:null,timeZone:null,units:null}};
        const configuration={id:tenant==="indoor-example"?"12345678-1234-4234-8234-123456789abc":"12345678-1234-4234-8234-123456789abd",status:"ONLINE",subdomain:tenant,captchaActive:false,appointmentTypes:{active:false},teamMembers:{active:false},tentative:false,
          timeZone:"US/Eastern",timeZoneOverridable:false,locations:[{kind:"IN_PERSON_ANY",value:"123 Main Street Example CT"}],times:{duration:{default:"PT50M",options:["PT50M"]},unitsPerSlot:3}};
        const c=(data:unknown)=>({isLoading:false,needsRefresh:false,response:{status:200,ok:true,data}});
        const cache={['https://api.youcanbook.me/v1/intents/'+id]:c(intent),['https://api.youcanbook.me/v1/intents/'+id+'/context']:c({configuration,common_texts:{title:"Public Golf Simulator"}})};
        text=`<script type="module" src="/assets/index-public.js"></script><script id="server-data">window.remoteServer="youcanbook.me";window.initialI18nStore={};window.initialLanguage="en";window.uiStore=${JSON.stringify({isV2Intent:false,isPreviewMode:false,slug:tenant,currentIntentId:id})};window.requestCache=${JSON.stringify(cache)};</script>`;
      }else if(url.pathname.endsWith("/availabilitykey")){
        type="application/json";const key="avl_"+"a".repeat(64)+"T_"+nonce;dates.set(key,url.searchParams.get("startSearchAt")!);text=JSON.stringify({key});
      }else if(url.pathname.startsWith("/v1/availabilities/")){
        type="application/json";const date=dates.get(url.pathname.split("/").at(-1)!);text=JSON.stringify({slots:[{startsAt:String(Date.parse(date+"T15:00:00Z")),freeUnits:3}]});
      }else throw Error("UNEXPECTED_TEST_READ");
      const response=new Response(change?.(url,text)??text,{headers:{"content-type":type}}),arrayBuffer=response.arrayBuffer.bind(response);
      response.arrayBuffer=async()=>{expect(active).toBe(1);return arrayBuffer()};return response;
    }) as typeof fetch};
  return{deps,reads,maxActive:()=>maxActive};
}
describe("saved anonymous public rental reader",()=>{
  it("runs through the real recipe validator and result proof without model or browser dependencies",async()=>{
    const f=fixture(),adapter=await inspectYouCanBook(source,f.deps);
    const recipe=parseAccessRecipe({schemaVersion:1,engine:"EXISTING_ADAPTER",target:{kind:"SIMULATOR",courseId:"course",offeringId:"offering"},source:{...source,providerFamily:"YOUCANBOOKME"},adapter});
    const result=await executeAccessRecipe(recipe,input,f.deps);
    expect(result.status).toBe("AVAILABLE");expect(result.complete).toBe(true);expect(result.slots).toHaveLength(2);
    expect(result.evidence).toMatchObject({venueVerified:true,dateVerified:true,capacityVerified:true,durationVerified:true,completeVerified:true});
    for(const changed of[{...recipe,target:{...recipe.target,kind:"OUTDOOR"}},{...recipe,source:{...recipe.source,bookingUrl:"https://other-room.youcanbook.me/"}},
      {...recipe,source:{...recipe.source,officialUrl:"https://foreign.example/"}}])expect(()=>parseAccessRecipe(changed)).toThrow();
  });
  it("cancels before another public read when the caller is already cancelled",async()=>{
    const f=fixture();await expect(inspectYouCanBook(source,{...f.deps,signal:AbortSignal.abort()})).rejects.toThrow();expect(f.reads).toHaveLength(0);
  });
  it("independently derives all published rooms then replays with fresh unsaved contexts",async()=>{
    const f=fixture(),saved=await inspectYouCanBook(source,f.deps);expect(saved.rooms.map(r=>r.label)).toEqual(["Widescreen","Curve"]);
    expect(JSON.stringify(saved)).not.toMatch(/itt_|startsAt|form|cookie|authorization/u);
    const before=JSON.stringify(saved),first=await executeYouCanBook(source,saved,input,f.deps);
    expect(first).toHaveLength(2);expect(first.every(s=>s.endsAt==="2030-01-02T15:50:00.000Z"&&s.capacity===null&&s.availableSpots===1)).toBe(true);
    const fresh=fixture(),changed=await executeYouCanBook(source,saved,{...input,date:"2030-01-03",players:3},fresh.deps);
    expect(changed).toHaveLength(2);expect(changed[0].startsAt).toBe("2030-01-03T15:00:00.000Z");expect(JSON.stringify(saved)).toBe(before);
    expect(f.maxActive()).toBe(1);expect(f.reads.every(r=>r.method==="GET")).toBe(true);
    expect(f.reads.filter(r=>r.url.includes("startSearchAt=2030-01-02"))).toHaveLength(2);
  });
  it("never accepts a source absent from the complete official catalog",async()=>{
    await expect(inspectYouCanBook({...source,bookingUrl:"https://foreign-room.youcanbook.me/"},fixture().deps)).rejects.toThrow("YOUCANBOOK_OFFICIAL_SOURCE_UNVERIFIED");
  });
  it.each(["catalog","location","client","duration","timezone","profile"])("rejects %s changes instead of returning partial/empty times",async kind=>{
    const saved=await inspectYouCanBook(source,fixture().deps),f=fixture((url,text)=>{
      if(kind==="catalog"&&url.pathname==="/rooms/")return text.replace("Select Curve room","Select Other room");
      if(kind==="location")return text.replaceAll("123 Main Street Example CT","124 Main Street Example CT");
      if(kind==="client"&&url.pathname.startsWith("/assets/"))return text+" changed";
      if(kind==="duration")return text.replaceAll("PT50M","PT60M");
      if(kind==="timezone")return text.replaceAll("US/Eastern","America/Chicago");
      if(kind==="profile")return text.replaceAll("123456789abd","123456789abe");return text;
    });
    await expect(executeYouCanBook(source,saved,input,f.deps)).rejects.toThrow();
  });
  it("does not use an arbitrary/missing address or a duration from the alert as source proof",async()=>{
    for(const changed of[{...source,venueAddress:undefined},{...source,venueAddress:"124 Main St, Example, CT 06001, USA"}])await expect(inspectYouCanBook(changed,fixture().deps)).rejects.toThrow();
    const saved=await inspectYouCanBook(source,fixture().deps);await expect(executeYouCanBook(source,saved,{...input,durationMinutes:60},fixture().deps)).rejects.toThrow("ADAPTER_TARGET_MISMATCH");
  });
});
