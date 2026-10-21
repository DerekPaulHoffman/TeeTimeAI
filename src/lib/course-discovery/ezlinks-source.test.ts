import { describe, expect, it } from "vitest";
import { ezlinksAvailabilityBody, ezlinksMetadataSchema, ezlinksRequestClock, ezlinksVenueMatches,
  parseEzLinksAvailability, parseEzLinksConfiguration, parseEzLinksSource, verifyEzLinksReadContract, type EzLinksSource } from "./ezlinks-source";

describe("exact public EZLinks recipe source", () => {
  it.each(["/", "/search", "/index.html"])("retains only the actual observed document form %s", path => {
    const bookingUrl = `https://public-course.ezlinksgolf.com${path}`;
    expect(parseEzLinksSource(bookingUrl)).toEqual({ bookingUrl, origin: "https://public-course.ezlinksgolf.com", tenant: "public-course" });
  });
  it.each([
    "http://public-course.ezlinksgolf.com/search", "https://u:p@public-course.ezlinksgolf.com/search",
    "https://public-course.ezlinksgolf.com:8443/search", "https://public-course.ezlinksgolf.com/search?course=1",
    "https://public-course.ezlinksgolf.com/index.html#/search", "https://public-course.ezlinksgolf.com/api/search/init",
    "https://public-course.ezlinksgolf.com/search/", "https://public-course.ezlinksgolf.com/%73earch",
    "https://public-course.ezlinksgolf.com/payment", "https://public-course.ezlinksgolf.com/checkout",
    "https://public-course.ezlinksgolf.com.evil.example/search", "https://nested.public-course.ezlinksgolf.com/search",
    "https://api.ezlinksgolf.com/search", "https://adminportal.ezlinksgolf.com/search", "https://member-course.ezlinksgolf.com/search",
    "https://public-course.ezlinksgolf.com/search#token", "https://Public-course.ezlinksgolf.com/search",
    "https://public-course-.ezlinksgolf.com/search",
  ])("does not grant source authority to %s", url => { expect(parseEzLinksSource(url)).toBeUndefined(); });
});

const identity: EzLinksSource = { officialUrl: "https://example.org/", bookingUrl: "https://public-course.ezlinksgolf.com/search",
  venueName: "Example Ridge Golf", venueAddress: "100 Golf Road, Example Town, NY 10001, USA", timeZone: "America/New_York" };
function configuration() {
  return { MasterSponsorID: "110", AllCourseIDs: "101", Courses: [{ CourseID: 101, RegionName: "New York", AreaName: "Example Area",
    CourseName: "Example Ridge Golf Course", CityName: "Example Town", CityID: 7, CountryName: "United States" }],
  SponsorPageTitle: "Example Ridge Golf Course - Daily Fee - Online tee times made EZ", SponsorSearchType: "1",
  Icons: [{ IconId:1,IconName:"18 holes" },{IconId:2,IconName:"Include Cart"},{IconId:5,IconName:"Resident Fee"},
    {IconId:6,IconName:"Member Fee"},{IconId:7,IconName:"Senior Fee"},{IconId:8,IconName:"Junior Fee"},{IconId:9,IconName:"9 holes"},{IconId:20,IconName:"Course Closed"}],
  NumPlayersList:["1","2","3","4"],HolesList:["Any","18","9"],StartTime:"05:00:00",EndTime:"19:00:00",StartTimeSet:"05:00:00",EndTimeSet:"19:00:00",
  SearchMinDate:"2026-10-21T18:33:44.07",SearchMaxDate:"2026-11-04T18:33:44.07",HoldAndReturnOne:false,RedirectTo:null,UserID:0,ContactFirstName:null,
  PreFilteredCourses:[],PreFilteredStates:[],PreFilteredCities:[] };
}
function row(changes = {}) {
  return { r01:"synthetic-ephemeral-not-identity",r02:-1,r03:300,r04:400,r05:3,r06:110,r07:101,r08:50,r09:50,r10:3,r11:4,r12:300,r13:401,r14:4,
    r15:"2026-10-23T11:00:00",r16:"Example Ridge Golf Course",r17:"2026-10-23T00:00:00",r18:24,r19:null,r20:"3",r21:50,r22:null,r23:null,
    r24:"11:00 AM",r25:"50.0000",r26:"50.0000",r27:"",r28:"1,2",r29:null,r30:"$",r31:"",r32:0,...changes };
}
function listing(rows = [row()]) {
  return { r01:"synthetic-csrf",r02:"0",r03:"synthetic-session",r04:"999",r05:[
    {r01:1,r02:110,r03:"Daily Fee",r04:"Pay at Course"}, {r01:2,r02:111,r03:"Senior Fee",r04:"Pay Now"},
    {r01:3,r02:112,r03:"Daily Fee",r04:"Pay Now"}],r06:rows,r07:0 };
}
const input = { date:"2026-10-23",players:2,startTime:"08:00",endTime:"18:00" };
const instant = (value: string) => new Date(`${value}-04:00`);
const parse = (body: unknown) => parseEzLinksAvailability(body,parseEzLinksConfiguration(configuration(),identity),input,instant);

describe("fresh EZLinks public configuration", () => {
  it("matches complete names and narrow Golf category labels without substring or location aliases", () => {
    expect(ezlinksVenueMatches("Example Ridge Golf","Example Ridge Golf Course")).toBe(true);
    expect(ezlinksVenueMatches("Example Ridge Golf Club","Example Ridge Golf Course")).toBe(true);
    for (const name of ["Example Ridge Golf East","Other Example Ridge Golf","Example Ridge Golf Course North","Example Golf"])
      expect(ezlinksVenueMatches(identity.venueName,name)).toBe(false);
  });
  it("stores no dynamic dates/window, opaque response fields or inferred provider address/timezone", () => {
    const first = configuration(), second = { ...configuration(), SearchMinDate:"2026-10-22T01:00:00",SearchMaxDate:"2026-11-05T01:00:00",
      StartTime:"06:00:00",StartTimeSet:"06:00:00",CsrfToken:"synthetic changed token",HdnCourseTime:"changes every read" };
    const a = parseEzLinksConfiguration(first,identity), b = parseEzLinksConfiguration(second,identity);
    expect(a.metadata).toEqual(b.metadata); expect(a.firstDate).not.toBe(b.firstDate);
    expect(Object.keys(a.metadata).sort()).toEqual(["browserTransport","catalogHash","clients","courseIds","family","sponsorId","tenant"]);
  });
  it("accepts anonymous positive site UserID without treating it as contact identity or durable authority", () => {
    const a = parseEzLinksConfiguration({...configuration(),UserID:12345},identity);
    const b = parseEzLinksConfiguration({...configuration(),UserID:54321},identity);
    expect(a.metadata).toEqual(b.metadata);
    expect(JSON.stringify(a)).not.toContain("UserID");
    expect(ezlinksAvailabilityBody(a,input)).not.toHaveProperty("UserID");
    expect(()=>parseEzLinksConfiguration({...configuration(),UserID:12345,ContactFirstName:"Account holder"},identity))
      .toThrow("EZLINKS_CONFIGURATION_INVALID");
  });
  it.each([
    {Courses:[]},{AllCourseIDs:"101,102"},{AllCourseIDs:"101,101"},{NumPlayersList:["2","1"]},{NumPlayersList:["1","1"]},
    {HolesList:["18","Any"]},{HolesList:["Any","Any"]},{HoldAndReturnOne:true},{UserID:-1},{UserID:1.5},{UserID:"123"},
    {UserID:10_000_000_000},{ContactFirstName:"synthetic account"},
    {PreFilteredCourses:[101]},{SearchMinDate:"2026-02-30T00:00:00"},{SearchMaxDate:"2026-10-20T00:00:00"},
    {StartTimeSet:"08:00:00"},{SponsorPageTitle:"Other Golf - Daily Fee - Online tee times made EZ"},
    {Courses:[{...configuration().Courses[0],CourseName:"Example Ridge Golf East"}]},
    {Courses:[{...configuration().Courses[0],CountryName:"Canada"}]},
    {Icons:[{IconId:1,IconName:"18 holes"},{IconId:1,IconName:"Member Fee"}]}, {Icons:[{IconId:1,IconName:"Unknown eligibility"}]},
  ])("fails unsupported or ambiguous fresh configuration %#", changes => {
    expect(()=>parseEzLinksConfiguration({...configuration(),...changes},identity)).toThrow(/^EZLINKS_/u);
  });
  it("requires canonical identity context without claiming provider locality equivalence", () => {
    expect(()=>parseEzLinksConfiguration(configuration(),{...identity,venueAddress:undefined})).toThrow("ADAPTER_IDENTITY_MISSING");
    const value=configuration();value.Courses[0].CityName="Other municipal spelling";
    expect(parseEzLinksConfiguration(value,identity).metadata.courseIds).toEqual([101]);
  });
  it("constructs the complete configured daytime query with source-proven clock syntax and Any index", () => {
    const config=parseEzLinksConfiguration(configuration(),identity);
    expect(ezlinksAvailabilityBody(config,input)).toEqual({p01:[101],p02:"10/23/2026",p03:"5:00 AM",p04:"7:00 PM",p05:0,p06:2,p07:false});
    expect(ezlinksRequestClock("12:00")).toBe("12:00 PM");expect(ezlinksRequestClock("00:00")).toBe("0:00 AM");
    expect(()=>ezlinksAvailabilityBody(config,{date:"2026-11-05",players:2})).toThrow("EZLINKS_REQUEST_OUTSIDE_CONFIGURATION");
    expect(()=>ezlinksAvailabilityBody(config,{date:input.date,players:5})).toThrow("EZLINKS_REQUEST_OUTSIDE_CONFIGURATION");
  });
});

describe("strict unpaged public EZLinks listing", () => {
  it("coalesces consistent rate rows without summing capacity or retaining tokens/prices", () => {
    const slots=parse(listing([row(),row({r06:112,r12:302,r08:45})]));expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({startsAt:"2026-10-23T15:00:00.000Z",availableSpots:4,holes:18,resourceId:"ezlinks-course:101"});
    const serialized=JSON.stringify(slots);for(const value of ["synthetic-ephemeral","synthetic-csrf","synthetic-session",'"price"','"productId"'])expect(serialized).not.toContain(value);
    const changed=parse(listing([row({r01:"another synthetic token",r08:70,r11:3})]));expect(changed[0].sourceId).toBe(slots[0].sourceId);
    expect(parse(listing([row({r28:"2,9"})]))[0].sourceId).toBe(slots[0].sourceId);
  });
  it("r04 max price and r07 display mode are not row-count/status markers",()=>{
    expect(parse(listing())).toHaveLength(1);expect(parse(listing([]))).toEqual([]);
  });
  it.each(["5","6","7","8","20"])("never treats restricted/closed icon %s as general public inventory",icon=>{
    expect(parse(listing([row({r28:`1,2,${icon}`})]))).toEqual([]);
  });
  it("excludes known senior rates but validates them before exclusion",()=>{
    expect(parse(listing([row({r06:111,r28:"1,2,7"})]))).toEqual([]);
    expect(()=>parse(listing([row({r06:111,r28:"1,2,7",r17:"2026-10-24T00:00:00"})]))).toThrow("EZLINKS_SLOT_MISMATCH");
  });
  it.each([
    {r00:1},{r06:undefined},{r06:null},{r06:Array.from({length:501},()=>row())},{r04:"-1"},{r02:"1000",r04:"999"},
    {r05:[]},{r05:[{r01:1,r02:110,r03:"Members",r04:"Pay Now"}]},
    {r05:[{r01:1,r02:111,r03:"Senior Fee",r04:"Pay Now"}]},
  ])("does not convert malformed/error/incomplete envelope %# to empty",changes=>{
    expect(()=>parse({...listing(),...changes})).toThrow(/^EZLINKS_/u);
  });
  it.each([
    {r06:999},{r07:999},{r16:"Other Golf"},{r11:undefined},{r11:5},{r11:3,r14:2},
    {r15:"2026-10-24T11:00:00"},{r15:"2026-10-23T04:00:00",r24:"4:00 AM"},{r15:"2026-10-23T11:00:01"},
    {r17:"2026-10-24T00:00:00"},{r24:"12:00 PM"},{r28:"1,999"},{r28:"1,1"},{r28:"1,9"},
  ])("fails contradictory or unverified raw row %# before filtering",changes=>{
    expect(()=>parse(listing([row(changes)]))).toThrow(/^EZLINKS_/u);
  });
  it("fails conflicting capacity/round and duplicate offers instead of adding or choosing rate inventory",()=>{
    expect(()=>parse(listing([row(),row({r06:112,r11:3})]))).toThrow("EZLINKS_SLOT_AMBIGUOUS");
    expect(()=>parse(listing([row(),row({r06:112,r28:"2,9"})]))).toThrow("EZLINKS_SLOT_AMBIGUOUS");
    expect(()=>parse(listing([row(),row()]))).toThrow("EZLINKS_DUPLICATE_OFFER");
  });
  it("does not truncate a raw listing to the UI page size and filters only after full validation",()=>{
    const rows=Array.from({length:30},(_,i)=>{const minute=String(i%6*10).padStart(2,"0"),hour=String(8+Math.floor(i/6)).padStart(2,"0");
      return row({r15:`2026-10-23T${hour}:${minute}:00`,r24:ezlinksRequestClock(`${hour}:${minute}`)});});
    expect(parse(listing(rows))).toHaveLength(30);
    expect(parse(listing([row({r11:1})]))).toEqual([]);
  });
});

describe("public catalog metadata", () => {
  const value = () => ({ family: "EZLINKS", browserTransport: "NATIVE_CHROME", tenant: "public-course", sponsorId: 42, courseIds: [101, 102],
    clients:parseEzLinksConfiguration(configuration(),identity).metadata.clients,catalogHash: "a".repeat(64) });
  it("keeps one sorted bounded exact public catalog", () => {
    expect(ezlinksMetadataSchema.parse(value())).toEqual(value());
  });
  it.each([
    { courseIds: [] }, { courseIds: [101, 101] }, { courseIds: [102, 101] }, { courseIds: [0] }, { courseIds: [1.5] },
    { courseIds: Array.from({ length: 41 }, (_, i) => i + 1) }, { sponsorId: 0 }, { tenant: "api" }, { tenant: "member-course" },
    { tenant: "public-course-" }, { browserTransport: "PINNED_HTTP" }, { browserTransport: undefined },
    { catalogHash: "not-a-hash" }, { clients:undefined }, { clients:[] }, { clients:[{path:"/assets/new.js",sha256:"a".repeat(64)}] },
    { trusted: true }, { SessionID: "must-not-persist" }, { CsrfToken: "must-not-persist" },
  ])("rejects unknown, ambiguous or ephemeral configuration %j", changes => {
    expect(ezlinksMetadataSchema.safeParse({ ...value(), ...changes }).success).toBe(false);
  });
  it("requires exact fresh unpaged client proof, without structural extras, missing bytes or reordered pins", () => {
    const assets=value().clients;
    expect(()=>verifyEzLinksReadContract({kind:"EZLINKS_UNPAGED_SEARCH_V1",assets})).not.toThrow();
    for(const changed of [undefined,{kind:"EZLINKS_UNPAGED_SEARCH_V1",assets:[]},
      {kind:"OTHER",assets},{kind:"EZLINKS_UNPAGED_SEARCH_V1",assets:[...assets].reverse()},
      {kind:"EZLINKS_UNPAGED_SEARCH_V1",assets:[{...assets[0],sha256:"a".repeat(64)},assets[1]]},
      {kind:"EZLINKS_UNPAGED_SEARCH_V1",assets,verified:true}])
      expect(()=>verifyEzLinksReadContract(changed)).toThrow("EZLINKS_READ_CONTRACT_UNVERIFIED");
  });
});
