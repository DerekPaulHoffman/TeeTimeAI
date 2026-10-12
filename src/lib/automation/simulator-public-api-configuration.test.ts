// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { collectSimulatorSupportResearch, type SimulatorResearchDependencies } from "./simulator-support-research";
import { projectTeeSheetPublicConfiguration, projectUpperHandPublicConfiguration } from "./simulator-public-api-configuration";
import { buildSimulatorResearchConfigurationCandidate } from "./simulator-research-configuration-candidate";
import { getSimulatorResearchRetryGuide, readSimulatorResearchState, type SimulatorResearchState } from "./simulator-support-research-policy";
import { knownSimulatorPublicConfigurationFamily } from "@/lib/simulators/providers/public-configuration";

const tee = "https://fixturevenue.teesheet.ai/";
const catalogUrl = "https://app.upperhand.io/customers/1683-fixture-venue/events";
const eventUrl = `${catalogUrl}/100948-virtual-golf-1-hour`;
const now = new Date("2026-10-12T20:00:00Z");
const fingerprint = "a".repeat(64);
const lease = (async (_host: string, worker: () => Promise<unknown>) => ({ acquired: true as const, value: await worker() })) as NonNullable<SimulatorResearchDependencies["lease"]>;
const json = (value: unknown, status=200) => new Response(JSON.stringify(value), {status,headers:{"content-type":"application/json"}});
const html = () => new Response("<html><body>Public simulator calendar</body></html>",{headers:{"content-type":"text/html"}});
const pricing = () => ({booking_settings:{min_duration_mins:30,max_duration_mins:480,time_increment_mins:15,advance_booking_days:60,
  notification_phones:[{phone:"private-phone"}],contact_email:"private@example.test",faq_text:"private text"}});
const event = () => ({id:100948,url:eventUrl,privacy:false,status:"active",schedule_type:"open_booking",exclusive_membership_ids:[],exclusive_membership_tier_ids:[],
  schedules:[{event_id:100948,status:"standard",duration:3600,resource_usage_mode:"use_one",max_size:1,staff_member_ids:[],staff_admin_ids:[],resource_ids:[3859,3860]}],
  customer_user_ids:["private-id"],description:"private token",session_ids:["private-session"]});
const catalog = () => ({page:1,per_page:20,total_count:2,events:[
  {event_id:100943,event_title:"Virtual Golf - Half Hour",duration:1800,schedule_type:"open_booking"},
  {event_id:100948,event_title:"Virtual Golf - One Hour",duration:3600,schedule_type:"open_booking"}]});
const course = {googlePlaceId:"fixture_place",name:"Fixture Venue",address:"1 Fixture Road",latitude:41,longitude:-73,website:"https://official.example.test/"};
function state(result: Awaited<ReturnType<typeof collectSimulatorSupportResearch>>): SimulatorResearchState {
  return {version:1,sourceFingerprint:fingerprint,readCount:1,inFlight:null,links:[],bookingLinks:[],linkBaseUrl:null,history:[{
    source:"booking",requestedUrl:result.requestedUrl,sourceUrl:result.url,observedAt:now.toISOString(),httpStatus:result.httpStatus,rendered:false,outcome:"READ",
    sourceFingerprint:fingerprint,requestId:"12345678-1234-4123-8123-123456789abc",publicConfiguration:result.publicConfiguration,configurationDiagnostic:result.configurationDiagnostic,
    publicReadEvidence:{sourceFingerprint:fingerprint,accessControlsObserved:true,accessControls:[],method:"HTTP"}}]};
}
const candidate = (research: SimulatorResearchState) => buildSimulatorResearchConfigurationCandidate({course,research,sourceFingerprint:fingerprint,
  offeringRevision:2,claimedAt:"2026-10-12T19:59:00Z",now});

describe("owned public configuration discovery",()=>{
  it("projects Mulligan's reviewed nullable slot contract without relabeling its rejected legacy rental",async()=>{
    const booking="https://booking.trackmangolf.com/venues/fixture-venue/booking/bays";
    const config={venue:{id:1543,slug:"fixture-venue",timezone:"America/New_York",status:"live",maintenanceMode:false},
      ranges:{items:[{id:1591,venue:1543,slug:"bays",bookable:true,slotDuration:30,slotInterval:30,slotIntervalStart:30,assumeOpen:true,
        bookingUi:"standard",customerBookingUi:"slots",maxBookAheadValue:2,maxBookAheadUnit:"week",openingTimes:[],
        openingHours:"Mo off;Tu off;We off;Th off;Fr off;Sa 12:00-17:00 open;Su 10:00-17:00 open"}]},
      bays:{items:[9939,9940,9941,9942,9943,9944].map(id=>({id,venue:1543,range:1591,type:"simulator",bookable:true,restrictedTimes:[],options:[23928],appliedOptions:[23928]})),
        bayOptions:[{id:23928,venue:1543,name:"Public Rate",adminOnly:false,type:"simulator",category:null,disabled:false,waitlisted:false,
          duration:1,durationType:"slot",minBookingDuration:2,maxBookingDuration:8,minPlayers:1,maxPlayers:4,bufferPeriodMinutes:0,restrictions:[],appliedRequiredPerks:[] as number[]}]}};
    const body=()=>`<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{pageProps:{initialReduxState:config}}})}</script></html>`;
    const read=async()=>collectSimulatorSupportResearch({url:booking},{fetch:vi.fn(async()=>new Response(body(),{headers:{"content-type":"text/html"}})),lease,now:()=>now});
    config.bays.bayOptions.push({...config.bays.bayOptions[0],id:23930,name:"Member Rental",appliedRequiredPerks:[8]});
    const result=await read();
    expect(result.configurationDiagnostic?.reason).toBe("CONFIG_NO_ELIGIBLE_RENTALS");
    expect(result.publicConfiguration).toMatchObject({family:"YOUR_GOLF_BOOKING",venueSlug:"fixture-venue",venueId:"1543",rangeId:"1591",
      publicOptionId:"23928",category:null,maintenanceMode:false,slotIntervalStart:30,bookingWindowDaysAhead:14,resourceIds:["9939","9940","9941","9942","9943","9944"]});
    expect(candidate(readSimulatorResearchState(state(result),fingerprint))?.manifest.providerMetadata).toMatchObject({category:null,maintenanceMode:false,rentalContract:"PUBLIC_SLOT_V1"});
    config.bays.items[0].bookable=false;
    expect((await read()).publicConfiguration).toMatchObject({resourceIds:["9940","9941","9942","9943","9944"]});
    config.bays.items[0].bookable=true;config.venue.maintenanceMode=true;
    expect((await read()).publicConfiguration).toBeUndefined();
    config.venue.maintenanceMode=false;
    config.bays.bayOptions.push({...config.bays.bayOptions[0],id:23931});
    expect((await read()).publicConfiguration).toBeUndefined();
  });
  it("reads TeeSheet's fixed pricing contract and derives a configuration without a facts packet",async()=>{
    const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(html()).mockResolvedValueOnce(json(pricing()));
    const result=await collectSimulatorSupportResearch({url:tee},{fetch,lease,now:()=>now});
    expect(String(fetch.mock.calls[1][0])).toBe("https://qdp9jvb6p6.execute-api.us-east-1.amazonaws.com/prod/availability/pricing?venue=fixturevenue");
    expect(result).toMatchObject({admittedRequests:2,publicConfiguration:{family:"TEESHEET",tenant:"fixturevenue",durationMinutes:60,maxPartySize:null,bookingWindowDaysAhead:60}});
    const saved=readSimulatorResearchState(state(result),fingerprint);
    expect(candidate(saved)?.manifest).toMatchObject({providerFamilyKey:"TEESHEET",providerMetadata:{venueSlug:"fixturevenue"},maxPartySize:null,bookingUrl:tee});
    expect(JSON.stringify(result.publicConfiguration)).not.toMatch(/private|notification|contact|faq/u);
    for(const [,init] of fetch.mock.calls) expect(init).toMatchObject({method:"GET",credentials:"omit",redirect:"manual"});
  });
  it("finds the single public one-hour Upper Hand rental using its public tenant selector",async()=>{
    const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(html()).mockResolvedValueOnce(json(catalog())).mockResolvedValueOnce(json(event()));
    const result=await collectSimulatorSupportResearch({url:catalogUrl},{fetch,lease,now:()=>now});
    expect(String(fetch.mock.calls[1][0])).toBe("https://api.upperhand.io/api/compound_objects/browse_events_list?page=1&per_page=20&search=Virtual+Golf");
    expect(String(fetch.mock.calls[2][0])).toBe("https://api.upperhand.io/api/events/100948?fields%5B%5D=image&fields%5B%5D=exclusive_membership_ids");
    expect(result).toMatchObject({admittedRequests:3,publicConfiguration:{family:"UPPER_HAND",customerId:"1683",eventId:"100948",resourceIds:["3859","3860"],maxPartySize:null}});
    for(const [,init] of fetch.mock.calls.slice(1)) expect(init).toMatchObject({method:"GET",credentials:"omit",headers:{"X-Customer-Id":"1683"}});
    const manifest=candidate(readSimulatorResearchState(state(result),fingerprint))?.manifest;
    expect(manifest).toMatchObject({bookingUrl:eventUrl,providerMetadata:{customerId:"1683",eventId:"100948",resourceIds:["3859","3860"]},maxPartySize:null});
    expect(JSON.stringify(result.publicConfiguration)).not.toMatch(/private|description|session_ids|customer_user_ids/u);
  });
  it("reads the exact public event directly when the official handoff is already a detail route",async()=>{
    const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(html()).mockResolvedValueOnce(json(event()));
    expect((await collectSimulatorSupportResearch({url:eventUrl},{fetch,lease})).publicConfiguration?.family).toBe("UPPER_HAND");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    {privacy:true},{exclusive_membership_ids:[1]},{id:999},{url:eventUrl.replace("1683","9999")},
    {schedules:[{...event().schedules[0],duration:1800}]},{schedules:[{...event().schedules[0],resource_ids:[3859,3859]}]},
  ])("rejects changed/private rental facts rather than configuring them %j",patch=>{
    const result=projectUpperHandPublicConfiguration({...event(),...patch},catalogUrl,"100948");
    expect(result.publicConfiguration).toBeUndefined();
    expect(result.configurationDiagnostic?.reason).toBe("PUBLIC_PROVIDER_CONFIG_REJECTED");
  });
  it.each(["https://fixturevenue.teesheet.ai.attacker.test/","https://app.upperhand.io/customers/1683-fixture-venue/checkout",
    `${eventUrl}?token=private`,"https://user:secret@app.upperhand.io/customers/1683-fixture-venue/events"])("rejects an unsafe/unrecognized source before companion requests %s",source=>{
    expect(knownSimulatorPublicConfigurationFamily(source)).toBeUndefined();
    expect(projectTeeSheetPublicConfiguration(pricing(),source)).toBeUndefined();
  });
  it.each([
    {...catalog(),total_count:21},{...catalog(),events:[...catalog().events,{...catalog().events[1],event_id:100949}],total_count:3},
    {...catalog(),events:[catalog().events[1],catalog().events[1]]},{...catalog(),events:[catalog().events[1],{}]},
  ])("does not pick a guessed rental from an ambiguous or truncated catalog %j",async data=>{
    const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(html()).mockResolvedValueOnce(json(data));
    const result=await collectSimulatorSupportResearch({url:catalogUrl},{fetch,lease});
    expect(result.publicConfiguration).toBeUndefined();expect(result.configurationDiagnostic?.reason).toBe("PUBLIC_PROVIDER_CATALOG_AMBIGUOUS");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("retains companion provider backoff instead of consuming a new route or inventing a configuration",async()=>{
    const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(html()).mockResolvedValueOnce(json({},503));
    const result=await collectSimulatorSupportResearch({url:tee},{fetch,lease,now:()=>now});
    const saved=readSimulatorResearchState(state(result),fingerprint);
    expect(saved.history[0].configurationDiagnostic).toMatchObject({reason:"PUBLIC_PROVIDER_HTTP_ERROR",httpStatus:503});
    expect(getSimulatorResearchRetryGuide({state:saved,officialUrl:course.website,bookingUrl:tee,now,priorFailedRoutes:[]}).closeoutReason).toBe("PROVIDER_BACKOFF");
    expect(candidate(saved)).toBeUndefined();
  });
  it("never fetches companion configuration after a challenged/denied main page",async()=>{
    const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("<html><body>Verify you are human</body></html>",{status:403,headers:{"content-type":"text/html"}}));
    expect((await collectSimulatorSupportResearch({url:tee},{fetch,lease})).publicConfiguration).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("rejects stale, future, foreign-source and superseded candidate observations",async()=>{
    const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(html()).mockResolvedValueOnce(json(pricing()));
    const result=await collectSimulatorSupportResearch({url:tee},{fetch,lease,now:()=>now});
    for(const patch of [{observedAt:"2026-10-12T19:00:00Z"},{observedAt:"2026-10-12T20:01:00Z"},{sourceFingerprint:"b".repeat(64)},
      {rendered:true,publicReadEvidence:{sourceFingerprint:fingerprint,accessControlsObserved:true,accessControls:[],method:"BROWSER",renderComplete:false}},
      {publicReadEvidence:{sourceFingerprint:fingerprint,accessControlsObserved:true,accessControls:["ACCOUNT_REQUIRED"],method:"HTTP"}}]){
      const saved=state(result);saved.history[0]={...saved.history[0],...patch} as typeof saved.history[0];expect(candidate(saved)).toBeUndefined();
    }
    const saved=state(result);saved.history.push({...saved.history[0],publicConfiguration:undefined,httpStatus:403});saved.readCount=2;
    expect(candidate(saved)).toBeUndefined();
  });
});
