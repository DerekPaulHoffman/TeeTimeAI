// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseYouCanBookBootstrap, parseYouCanBookSlots, parseYouCanBookSource, readYouCanBookOfficialPage,
  verifyYouCanBookOfficialIdentity, youCanBookDuration, youCanBookMetadataSchema } from "./youcanbook-public";
const bookingUrl="https://indoor-example.youcanbook.me/",intentId="itt_12345678-1234-1234-1234-123456789abc";
function fixture(){
  const intent={id:intentId,bookingId:null,intentStatus:"SETTING_UP",selections:{appointmentTypeIds:null,duration:null,form:null,location:null,smsConsent:null,startsAt:null,teamMemberId:null,timeZone:null,units:null}};
  const configuration={id:"12345678-1234-4234-8234-123456789abc",status:"ONLINE",subdomain:"indoor-example",captchaActive:false,appointmentTypes:{active:false},teamMembers:{active:false},tentative:false,
    timeZone:"US/Eastern",timeZoneOverridable:false,locations:[{kind:"IN_PERSON_ANY",value:"123 Main Street Example CT"}],times:{duration:{default:"PT50M",options:["PT50M"]},unitsPerSlot:3}};
  const context={configuration,common_texts:{title:"Public Golf Simulator"}},ui={isV2Intent:false,isPreviewMode:false,slug:"indoor-example",currentIntentId:intentId};
  const cached=(data:unknown)=>({isLoading:false,needsRefresh:false,response:{status:200,ok:true,data}});
  const cache={['https://api.youcanbook.me/v1/intents/'+intentId]:cached(intent),['https://api.youcanbook.me/v1/intents/'+intentId+'/context']:cached(context)};
  return{intent,configuration,ui,cache,html:()=>`<script type="module" src="/assets/index-public.js"></script><script id="server-data">window.remoteServer="youcanbook.me";window.initialI18nStore={};window.initialLanguage="en";window.uiStore=${JSON.stringify(ui)};window.requestCache=${JSON.stringify(cache)};</script>`};
}
const context=()=>parseYouCanBookBootstrap(fixture().html(),bookingUrl,"America/New_York");
const input={date:"2030-01-02",startTime:"09:00",endTime:"18:00",durationMinutes:50};
const slot=(iso="2030-01-02T15:00:00Z",freeUnits=3)=>({startsAt:String(Date.parse(iso)),freeUnits});
describe("anonymous public default-rental protocol",()=>{
  it("accepts only a public tenant root without supplied browsing context",()=>{
    expect(parseYouCanBookSource(bookingUrl)?.tenant).toBe("indoor-example");
    for(const url of["http://indoor-example.youcanbook.me/",bookingUrl+"?i=anything",bookingUrl+"book",bookingUrl+"#calendar","https://api.youcanbook.me/","https://name:secret@indoor-example.youcanbook.me/"])
      expect(parseYouCanBookSource(url)).toBeUndefined();
  });
  it("reads only the closed data assignments and rejects executable or additional statements",()=>{
    const f=fixture(),parsed=parseYouCanBookBootstrap(f.html(),bookingUrl,"America/New_York");
    expect(parsed).toMatchObject({tenant:"indoor-example",durationMinutes:50,timeZone:"America/New_York",unitsPerSlot:3,intentId});
    expect(parsed.contextSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(parseYouCanBookBootstrap(f.html(),bookingUrl,"America/New_York").contextSha256).toBe(parsed.contextSha256);
    for(const extra of["throw new Error('must never run');","window.uiStore.location='changed';","window.other={};"])
      expect(()=>parseYouCanBookBootstrap(f.html().replace("window.uiStore=",extra+"window.uiStore="),bookingUrl,"America/New_York")).toThrow("YOUCANBOOK_BOOTSTRAP_UNVERIFIED");
  });
  it.each(["bookingId","intentStatus","startsAt","form","location","timeZone","units"])("does not import a booked, selected or personalized %s context",field=>{
    const f=fixture();if(field==="bookingId")f.intent.bookingId="booking" as never;else if(field==="intentStatus")f.intent.intentStatus="READY";else Object.assign(f.intent.selections,{[field]:"selected"});
    expect(()=>parseYouCanBookBootstrap(f.html(),bookingUrl,"America/New_York")).toThrow("YOUCANBOOK_PUBLIC_CONTEXT_UNSUPPORTED");
  });
  it.each(["captchaActive","tentative","timeZoneOverridable"])("rejects a changed %s contract",field=>{
    const f=fixture();Object.assign(f.configuration,{[field]:true});
    expect(()=>parseYouCanBookBootstrap(f.html(),bookingUrl,"America/New_York")).toThrow();
  });
  it("rejects member/service choices, unknown versions and mismatched tenant/timezone",()=>{
    for(const change of[(f:ReturnType<typeof fixture>)=>{f.ui.isV2Intent=true},(f:ReturnType<typeof fixture>)=>{f.configuration.appointmentTypes.active=true},
      (f:ReturnType<typeof fixture>)=>{f.configuration.teamMembers.active=true},(f:ReturnType<typeof fixture>)=>{f.configuration.subdomain="other"},
      (f:ReturnType<typeof fixture>)=>{f.configuration.timeZone="America/Chicago"}]){const f=fixture();change(f);expect(()=>parseYouCanBookBootstrap(f.html(),bookingUrl,"America/New_York")).toThrow()}
  });
  it("requires a closed, current complete cache and one current public client",()=>{
    const f=fixture();f.cache[Object.keys(f.cache)[0]].needsRefresh=true;expect(()=>parseYouCanBookBootstrap(f.html(),bookingUrl,"America/New_York")).toThrow();
    for(const html of[fixture().html().replace('src="/assets/','src="https://foreign.example/assets/'),fixture().html()+fixture().html(),fixture().html().replace('window.uiStore=','window.uiStore=readPrivateState();window.other=')])
      expect(()=>parseYouCanBookBootstrap(html,bookingUrl,"America/New_York")).toThrow();
  });
  it("uses the published complete duration, never rounds fifty minutes into an hour",()=>{
    expect(context().durationMinutes).toBe(50);
    for(const [label,minutes] of[["50 Minutes",50],["1 Hour, 50 Min",110],["3 Hours, 50 Minutes",230],["Book now",undefined]] as const)expect(youCanBookDuration(label)).toBe(minutes);
    const f=fixture();f.configuration.times.duration.options.push("PT60M");expect(()=>parseYouCanBookBootstrap(f.html(),bookingUrl,"America/New_York")).toThrow("YOUCANBOOK_PUBLIC_DURATION_UNSUPPORTED");
  });
  it("extracts full requested sessions with free bay units, keeping golfer capacity unknown",()=>{
    const slots=parseYouCanBookSlots({slots:[slot()]},context(),input,new Date("2030-01-01"));
    expect(slots).toEqual([{startsAt:"2030-01-02T15:00:00.000Z",endsAt:"2030-01-02T15:50:00.000Z",freeBays:3}]);
    expect(parseYouCanBookSlots({slots:[slot()]},context(),{...input,endTime:"10:49"},new Date("2030-01-01"))).toEqual([]);
    expect(parseYouCanBookSlots({slots:[slot("2030-01-02T15:00:01Z")]},context(),{...input,endTime:"10:50"},new Date("2030-01-01"))).toEqual([]);
  });
  it("allows only complete empty evidence; changed schemas never become no availability",()=>{
    expect(parseYouCanBookSlots({slots:[]},context(),input,new Date("2030-01-01"))).toEqual([]);
    for(const data of[{}, {slots:[],nextPage:"later"},{slots:[{...slot(),freeUnits:-1}]},{slots:[slot(),slot()]},{slots:[slot("2030-01-01T15:00:00Z")]},{slots:[{...slot(),startsAt:"2030-01-02T15:00:00Z"}]},
      {slots:[{...slot(),freeUnits:4}]}])expect(()=>parseYouCanBookSlots(data,context(),input,new Date("2030-01-01"))).toThrow();
  });
  it("keeps midnight in the venue timezone rather than UTC",()=>{
    const midnight={...input,startTime:"23:00",endTime:"24:00"};
    expect(parseYouCanBookSlots({slots:[slot("2030-01-03T04:10:00Z")]},context(),midnight,new Date("2030-01-01"))).toHaveLength(1);
    expect(parseYouCanBookSlots({slots:[slot("2030-01-03T04:11:00Z")]},context(),midnight,new Date("2030-01-01"))).toEqual([]);
  });
  it("does not persist an intent, credential or arbitrary operation in metadata",()=>{
    const metadata={family:"YOUCANBOOKME",officialEntryUrl:"https://official.example/rooms/",catalogSha256:"a".repeat(64),rooms:[{label:"Indoor Bay",officialPageUrl:"https://official.example/room/",bookingUrl,durationMinutes:50,profileId:context().profileId,contextSha256:context().contextSha256}]};
    expect(youCanBookMetadataSchema.safeParse(metadata).success).toBe(true);
    for(const changed of[{...metadata,intentId},{...metadata,run:"code"},{...metadata,rooms:[{...metadata.rooms[0],intentId}]}])expect(youCanBookMetadataSchema.safeParse(changed).success).toBe(false);
  });
  it("reads whole official identity and visible public routing without form or hidden links",()=>{
    const html='<article><h1>Example Indoor Golf</h1><p>123 Main Street, Example, CT 06001</p><a href="/rooms/">Book now</a><div hidden><a href="/secret/">Book now</a></div><form><a href="/form/">Book now</a></form></article>';
    const page=readYouCanBookOfficialPage(html,"https://official.example/");expect(page.links).toEqual([{href:"https://official.example/rooms/",label:"Book now"}]);
    const source={officialUrl:"https://official.example/",bookingUrl,venueName:"Example Indoor Golf",venueAddress:"123 Main St, Example, CT 06001, USA",timeZone:"America/New_York"};
    expect(()=>verifyYouCanBookOfficialIdentity(page,source)).not.toThrow();
    expect(()=>verifyYouCanBookOfficialIdentity(page,{...source,venueAddress:"124 Main St, Example, CT 06001, USA"})).toThrow();
    expect(()=>readYouCanBookOfficialPage(html.replace("</article>",'<iframe src="/other/"></iframe></article>'),source.officialUrl)).toThrow("YOUCANBOOK_OFFICIAL_CATALOG_INCOMPLETE");
  });
});
