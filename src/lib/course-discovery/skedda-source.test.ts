import { describe, expect, it } from "vitest";
import { deriveSkeddaMetadata, extractSkeddaSlots, parseSkeddaSource, skeddaCalendarSchema, skeddaMetadataSchema,
  skeddaOpeningAllowed, skeddaWebSchema, skeddaZonesAgree, validateSkeddaCalendar } from "./skedda-source";
import { parseAccessRecipe } from "./recipe";
import { requestFamilyForUrl } from "./request-family";

const source={officialUrl:"https://harbor-golf.example/",bookingUrl:"https://harbor.skedda.com/booking",venueName:"Harbor Golf LLC",
  venueAddress:"10 Harbor Drive, Example, NY 12345, USA",timeZone:"America/New_York"};
const input={date:"2030-01-03",timeZone:source.timeZone,players:2,durationMinutes:60,startTime:"09:00",endTime:"18:00"};
const now=new Date("2030-01-01T12:00:00Z"),toInstant=(v:unknown)=>new Date(String(v)+"-05:00");
function rawWeb(){return{venue:[{id:"42",name:"Harbor Golf",subdomain:"harbor",streetAddress:"10 Harbor Dr. Unit 2",city:"Example",postcode:"12345",
  twoLetterCountryCode:"US",websiteUrl:source.officialUrl,timeZoneId:"America/Detroit",timeGranularityMinutes:15,
  venueUserTagsAllowedToBook:null,defaultVisitorTag:null,defaultSelfRegisterTag:null,contentVisibility:{bookingRules:[]},
  hoursOfAvailability:{rules:[{spaceIds:null,start:300,end:1320,daysBitmask:127}]},
  denyRules:{rules:[{spaceIds:[1],startTotalMinutes:0,endTotalMinutes:1440,daysBitmask:127,mode:1,g:[{p:[{expression:0,relation:0,testValue:60}]},{p:[{expression:0,relation:1,testValue:420}]}]},
    {spaceIds:null,startTotalMinutes:0,endTotalMinutes:1020,daysBitmask:62,mode:1,g:[{p:[{expression:3,relation:10,testValue:[10]}]}]}]},
  bufferTime:{rules:[]},bookingRequestRules:{rules:[]},bookingWindow:{rules:[{tagIds:null,spaceIds:null,value:21,predicate:3,mode:1,daysBitmask:127,endTotalMinutes:1440},
    {tagIds:null,spaceIds:null,value:1,predicate:2,mode:1,daysBitmask:127,endTotalMinutes:1440}]},quotaRules:{rules:[]},
  spacePresentation:{visibility:{"2":[]},capacities:[{capacity:4,spaceIds:[1]}]}}],
  assets:[{id:"1",name:"Golf Simulator",venue:"42",parents:[],children:[]},{id:"2",name:"Office",venue:"42",parents:[],children:[]}]};}
function rawCalendar(){return{bookings:[] as Array<Record<string,unknown>>,bookingslist:{start:"2030-01-01T00:00:00",end:"2030-01-05T23:59:59.999",bookings:[] as string[],idx:{} as Record<string,number[]>}};}
function fixture(){const web=skeddaWebSchema.parse(rawWeb()),calendar=skeddaCalendarSchema.parse(rawCalendar()),metadata=deriveSkeddaMetadata(source,web,["Golf Simulator"],input),
  requestUrl="https://harbor.skedda.com/bookingslists?start=2030-01-01T00%3A00%3A00&end=2030-01-05T23%3A59%3A59.999";return{web,calendar,metadata,requestUrl};}

describe("anonymous public Skedda simulator evidence",()=>{
  it("binds the exact tenant, official backlink, complete building address and visible simulator",()=>{
    const f=fixture();expect(f.metadata).toMatchObject({family:"SKEDDA",tenant:"harbor",venueId:"42",resourceIds:["1"],requiredCapability:"LOCAL_CHROME"});
    expect(skeddaMetadataSchema.parse(f.metadata)).toEqual(f.metadata);
    const replaySource={timeZone:source.timeZone,providerFamily:"SKEDDA",bookingUrl:source.bookingUrl,venueName:source.venueName,officialUrl:source.officialUrl,venueAddress:source.venueAddress};
    expect(deriveSkeddaMetadata(replaySource,f.web,["Golf Simulator"],input)).toEqual(f.metadata);
    expect(parseAccessRecipe({schemaVersion:1,engine:"EXISTING_ADAPTER",source:{...source,providerFamily:"SKEDDA"},target:{kind:"SIMULATOR",courseId:"c",offeringId:"o"},adapter:f.metadata})).toBeTruthy();
  });
  it.each(["name","street","unit","city","postal","backlink","tenant","zone","hidden","duplicate","nonrental"])("rejects conflicting %s evidence",kind=>{
    const f=fixture();let s={...source},visible=["Golf Simulator"];
    if(kind==="name")f.web.venue[0].name="Other Golf";
    if(kind==="street")f.web.venue[0].streetAddress="11 Harbor Drive Unit 2";
    if(kind==="unit")s={...s,venueAddress:"10 Harbor Drive Unit 3, Example, NY 12345"};
    if(kind==="city")f.web.venue[0].city="Other";
    if(kind==="postal")f.web.venue[0].postcode="12346";
    if(kind==="backlink")f.web.venue[0].websiteUrl="https://other.example/";
    if(kind==="tenant")f.web.venue[0].subdomain="other";
    if(kind==="zone")f.web.venue[0].timeZoneId="America/Los_Angeles";
    if(kind==="hidden")f.web.venue[0].spacePresentation.visibility["1"]=[];
    if(kind==="duplicate")f.web.assets.push({...f.web.assets[0],id:"3"});
    if(kind==="nonrental")visible=["Office"];
    expect(()=>deriveSkeddaMetadata(s,f.web,visible,input)).toThrow();
  });
  it("keeps source URLs and simulator target kind bound to saved metadata",()=>{
    const f=fixture(),r={schemaVersion:1,engine:"EXISTING_ADAPTER",source:{...source,providerFamily:"SKEDDA"},target:{kind:"SIMULATOR",courseId:"c",offeringId:"o"},adapter:f.metadata};
    for(const changed of [{...r,source:{...r.source,bookingUrl:"https://other.skedda.com/booking"}},{...r,target:{kind:"OUTDOOR",courseId:"c"}},{...r,source:{...r.source,venueAddress:undefined}}])expect(()=>parseAccessRecipe(changed)).toThrow();
    for(const url of ["http://harbor.skedda.com/booking","https://harbor.skedda.com/login","https://harbor.skedda.com/booking?token=x","https://harbor.skedda.com.evil.example/booking"])expect(parseSkeddaSource(url)).toBeNull();
    expect(requestFamilyForUrl(source.bookingUrl)).toBe(requestFamilyForUrl("https://other.skedda.com/booking"));
    expect(requestFamilyForUrl(source.bookingUrl)).toBe(requestFamilyForUrl("https://cdn.skedda.com/assets/main.js"));
  });
  it("verifies current time-zone agreement across a DST transition rather than equating zone names",()=>{
    expect(skeddaZonesAgree("America/Detroit","America/New_York","2030-03-10")).toBe(true);
    expect(skeddaZonesAgree("America/Chicago","America/New_York","2030-03-10")).toBe(false);
    expect(skeddaZonesAgree("invalid","America/New_York",input.date)).toBe(false);
  });
  it("requires completed full-date coverage and exact list/index joins",()=>{
    const f=fixture();expect(()=>validateSkeddaCalendar(f.web,f.calendar,f.requestUrl,input.date)).not.toThrow();
    for(const kind of ["range","query","ids","index","unknown"]){const c=structuredClone(f.calendar);let url=f.requestUrl;
      if(kind==="range")c.bookingslist.end="2030-01-03T17:59:59";
      if(kind==="query")url+="&start=2030-01-01T00%3A00%3A00";
      if(kind==="ids")c.bookingslist.bookings=["99"];
      if(kind==="index")c.bookingslist.idx[input.date]=[99];
      if(kind==="unknown")url=url.replace("harbor.skedda.com","other.skedda.com");
      expect(()=>validateSkeddaCalendar(f.web,c,url,input.date)).toThrow();
    }
  });
  it("returns only complete ordinary-public one-hour openings in the saved window",()=>{
    const f=fixture(),slots=extractSkeddaSlots(source,f.metadata,f.web,f.calendar,input,now,toInstant);
    expect(slots).toHaveLength(1);expect(slots[0]).toMatchObject({startsAt:"2030-01-03T22:00:00.000Z",endsAt:"2030-01-03T23:00:00.000Z",availableSpots:1,capacity:4,resourceId:"1"});
    expect(extractSkeddaSlots(source,f.metadata,f.web,f.calendar,{...input,endTime:"17:45"},now,toInstant)).toEqual([]);
    expect(extractSkeddaSlots(source,f.metadata,f.web,f.calendar,{...input,players:4},now,toInstant)).toEqual(slots);
  });
  it("excludes a partially occupied hour and never combines resources",()=>{
    const f=fixture(),b={id:"99",start:"2030-01-03T17:15:00",end:"2030-01-03T17:30:00",endOfLastOccurrence:"2030-01-03T17:30:00",recurrenceRule:null,spaces:["1"],venue:"42",type:1,availabilityStatus:null};
    f.calendar.bookings=[b];f.calendar.bookingslist.bookings=["99"];f.calendar.bookingslist.idx[input.date]=[99];
    validateSkeddaCalendar(f.web,f.calendar,f.requestUrl,input.date);
    expect(extractSkeddaSlots(source,f.metadata,f.web,f.calendar,input,now,toInstant)).toEqual([]);
    f.calendar.bookings[0].spaces=["2"];expect(extractSkeddaSlots(source,f.metadata,f.web,f.calendar,input,now,toInstant)).toHaveLength(1);
    f.calendar.bookingslist.idx[input.date]=[];expect(()=>validateSkeddaCalendar(f.web,f.calendar,f.requestUrl,input.date)).toThrow("SKEDDA_CALENDAR_INCOMPLETE");
  });
  it("rejects recurrence, nonpublic access, approval, buffers, public quotas and unknown conditions as incomplete support",()=>{
    for(const kind of ["access","tag","approval","buffer","quota","predicate"]){const r=rawWeb(),v=r.venue[0] as unknown as Record<string,unknown>;
      if(kind==="access")v.venueUserTagsAllowedToBook=[10];if(kind==="tag")v.defaultVisitorTag=10;
      if(kind==="approval")v.bookingRequestRules={rules:[{}]};if(kind==="buffer")v.bufferTime={rules:[{}]};
      if(kind==="quota")v.quotaRules={rules:[{tagIds:null}]};if(kind==="predicate")v.denyRules={rules:[{...r.venue[0].denyRules.rules[0],g:[{p:[{expression:8,relation:0,testValue:60}]}]}]};
      expect(skeddaWebSchema.safeParse(r).success).toBe(false);
    }
    const c=rawCalendar();c.bookings=[{id:"99",start:"2030-01-03T17:00:00",end:"2030-01-03T18:00:00",endOfLastOccurrence:"2030-02-03T18:00:00",recurrenceRule:"FREQ=WEEKLY",spaces:["1"],venue:"42",type:1,availabilityStatus:null}];
    expect(skeddaCalendarSchema.safeParse(c).success).toBe(false);
  });
  it("honors lead time, booking horizon, anonymous tag conditions and adjacent occupied bounds",()=>{
    const f=fixture();expect(skeddaOpeningAllowed(f.web,"1",input,1020,new Date("2030-01-03T21:30:00Z"),toInstant)).toBe(false);
    expect(skeddaOpeningAllowed(f.web,"1",{...input,date:"2030-02-07"},1020,now,toInstant)).toBe(false);
    expect(skeddaOpeningAllowed(f.web,"1",input,1005,now,toInstant)).toBe(false);
    f.web.venue[0].denyRules.rules[1].g[0].p[0].relation=9;
    expect(skeddaOpeningAllowed(f.web,"1",input,540,now,toInstant)).toBe(true);
  });
  it("fails closed on ambiguous hours and changes its saved configuration hash for public rule changes",()=>{
    const f=fixture();f.web.venue[0].hoursOfAvailability.rules.push({...f.web.venue[0].hoursOfAvailability.rules[0]});
    expect(()=>extractSkeddaSlots(source,f.metadata,f.web,f.calendar,input,now,toInstant)).toThrow("SKEDDA_HOURS_UNSUPPORTED");
    const g=fixture();g.web.venue[0].denyRules.rules[1].endTotalMinutes=1080;
    expect(deriveSkeddaMetadata(source,g.web,["Golf Simulator"],input).configurationSha256).not.toBe(g.metadata.configurationSha256);
  });
  it("discards credentials and booking personal fields before evidence can leave the reader",()=>{
    const w=rawWeb();Object.assign(w.venue[0],{apiKey:"PRIVATE_TOKEN",contactEmail:"PRIVATE_EMAIL"});
    expect(JSON.stringify(skeddaWebSchema.parse(w))).not.toMatch(/PRIVATE|apiKey|contactEmail/u);
    expect(()=>skeddaMetadataSchema.parse({...fixture().metadata,token:"PRIVATE"})).toThrow();
  });
});
