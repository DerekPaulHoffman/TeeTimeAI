import { describe, expect, it, vi } from "vitest";
import { executeEzLinks, ezlinksLocalInstant, inspectEzLinks, type EzLinksDependencies } from "./ezlinks-executor";
import { parseEzLinksConfiguration, type EzLinksSource } from "./ezlinks-source";

const source: EzLinksSource = { officialUrl:"https://example.org/",bookingUrl:"https://public-course.ezlinksgolf.com/search",venueName:"Example Ridge Golf",
  venueAddress:"100 Golf Road, Example Town, NY 10001, USA",timeZone:"America/New_York" };
const input={date:"2026-10-23",timeZone:source.timeZone,players:2,startTime:"08:00",endTime:"18:00"};
function configuration() {return {
  MasterSponsorID:"110",AllCourseIDs:"101",Courses:[{CourseID:101,RegionName:"New York",AreaName:"Example Area",CourseName:"Example Ridge Golf Course",
    CityName:"Example Town",CityID:7,CountryName:"United States"}],SponsorPageTitle:"Example Ridge Golf Course - Daily Fee - Online tee times made EZ",SponsorSearchType:"1",
  Icons:[{IconId:1,IconName:"18 holes"},{IconId:2,IconName:"Include Cart"}],NumPlayersList:["1","2","3","4"],HolesList:["Any","18","9"],
  StartTime:"05:00:00",EndTime:"19:00:00",StartTimeSet:"05:00:00",EndTimeSet:"19:00:00",SearchMinDate:"2026-10-21T00:00:00",SearchMaxDate:"2026-11-04T00:00:00",
  HoldAndReturnOne:false,RedirectTo:null,UserID:0,ContactFirstName:null,PreFilteredCourses:[],PreFilteredStates:[],PreFilteredCities:[]};}
function body() {return {r01:"synthetic-csrf",r02:"0",r03:"synthetic-session",r04:"999",r05:[{r01:1,r02:110,r03:"Daily Fee",r04:"Pay at Course"}],r07:0,
  r06:[{r01:"synthetic-opaque-offer",r02:-1,r03:300,r04:400,r05:3,r06:110,r07:101,r08:50,r09:50,r10:3,r11:4,r12:300,r13:401,r14:4,
    r15:"2026-10-23T11:00:00",r16:"Example Ridge Golf Course",r17:"2026-10-23T00:00:00",r18:24,r19:null,r20:"3",r21:50,r22:null,r23:null,
    r24:"11:00 AM",r25:"50.0000",r26:"50.0000",r27:"",r28:"1,2",r29:null,r30:"$",r31:"",r32:0}]};}
function dependencies(config: unknown=configuration(),value: unknown=body()) {
  const calls: unknown[]=[],close=vi.fn(async()=>{}),raw=vi.fn(async(request:unknown)=>{calls.push(request);return value;});
  const contract=vi.fn(async()=>({kind:"EZLINKS_UNPAGED_SEARCH_V1",assets:parseEzLinksConfiguration(configuration(),source).metadata.clients}));
  const create=vi.fn(async()=>({execute:vi.fn(async()=>({accessRequirementObserved:false,navigationStatus:200})),
    readEzLinksConfiguration:vi.fn(async()=>config),readEzLinksReadContract:contract,readEzLinksAvailability:raw,close}));
  const deps: EzLinksDependencies={now:()=>new Date("2026-10-21T12:00:00Z"),createSession:create as unknown as NonNullable<EzLinksDependencies["createSession"]>};
  return {deps,calls,raw,close,create,contract};
}
describe("fixed native EZLinks execution",()=>{
  it("freshly inspects without a listing or UI operation, then independently reopens and validates configuration",async()=>{
    const a=dependencies(),meta=await inspectEzLinks(source,a.deps);expect(a.raw).not.toHaveBeenCalled();expect(a.close).toHaveBeenCalledOnce();
    const b=dependencies(),slots=await executeEzLinks(source,meta,{courseId:"canonical-course"},input,b.deps);
    expect(slots).toHaveLength(1);expect(slots[0]).toMatchObject({startsAt:"2026-10-23T15:00:00.000Z",availableSpots:4,bookingUrl:source.bookingUrl,holes:18});
    expect(b.calls).toEqual([{p01:[101],p02:"10/23/2026",p03:"5:00 AM",p04:"7:00 PM",p05:0,p06:2,p07:false}]);
    expect(b.close).toHaveBeenCalledOnce();expect(b.create.mock.calls).toHaveLength(1);
  });
  it("uses real native lifetime while retaining the supplied shared lease and original deadline",async()=>{
    const f=dependencies(),lease=vi.fn(),real=Date.now(),deadlineAt=new Date(real+50_000);
    f.deps.now=()=>new Date("2030-01-01T00:00:00Z");f.deps.deadlineAt=deadlineAt;f.deps.requestLease=lease;
    await inspectEzLinks(source,f.deps);
    const call=f.create.mock.calls[0] as unknown as [Record<string,unknown>,Record<string,unknown>];
    expect((call[0].deadlineAt as Date).getTime()).toBe(deadlineAt.getTime());
    expect(call[1]).toMatchObject({browserTransport:"NATIVE_CHROME",requestLease:expect.any(Function)});
    lease.mockImplementation(async (_family,work)=>({acquired:true,value:await work()}));
    const nativeLease=call[1].requestLease as NonNullable<Parameters<NonNullable<EzLinksDependencies["createSession"]>>[1]>["requestLease"];
    expect(await nativeLease!("EZLINKS",async()=>17)).toEqual({acquired:true,value:17});
    expect(lease).toHaveBeenCalledWith("EZLINKS",expect.any(Function));
    lease.mockResolvedValueOnce({acquired:false});
    expect(await nativeLease!("EZLINKS",async()=>{throw new Error("MUST_NOT_RUN");})).toEqual({acquired:false});
    expect(call[0].initialUrls).toEqual([source.bookingUrl]);
  });
  it("changes date/player/window through the same saved metadata and filters only the complete returned listing",async()=>{
    const saved=parseEzLinksConfiguration(configuration(),source).metadata,value=body();value.r06[0].r15="2026-10-24T11:00:00";value.r06[0].r17="2026-10-24T00:00:00";
    const f=dependencies(configuration(),value);
    const result=await executeEzLinks(source,saved,{courseId:"canonical-course"},{...input,date:"2026-10-24",players:3,startTime:"09:00",endTime:"17:00"},f.deps);
    expect(result).toHaveLength(1);expect(f.calls[0]).toMatchObject({p02:"10/24/2026",p03:"5:00 AM",p04:"7:00 PM",p06:3,p07:false});
  });
  it("never borrows saved catalog flags or a missing current init to send POST",async()=>{
    const meta=parseEzLinksConfiguration(configuration(),source).metadata,missing=dependencies(undefined);
    // An explicit missing response, rather than the fixture function's default.
    missing.deps.createSession=async()=>({execute:async()=>({}) as never,readEzLinksConfiguration:async()=>undefined,
      readEzLinksReadContract:missing.contract,readEzLinksAvailability:missing.raw,close:missing.close});
    await expect(executeEzLinks(source,meta,{courseId:"x"},input,missing.deps)).rejects.toThrow("EZLINKS_CONFIGURATION_INVALID");
    expect(missing.raw).not.toHaveBeenCalled();expect(missing.close).toHaveBeenCalledOnce();
    const changed=configuration();changed.NumPlayersList=["1","2"];
    const f=dependencies(changed);await expect(executeEzLinks(source,meta,{courseId:"x"},input,f.deps)).rejects.toThrow("ADAPTER_CONFIGURATION_CHANGED");expect(f.raw).not.toHaveBeenCalled();
  });
  it("requires fresh native client bytes on inspection and every replay before any listing, including EMPTY",async()=>{
    const meta=parseEzLinksConfiguration(configuration(),source).metadata;
    for(const operation of ["inspect","execute"]){
      const f=dependencies();f.contract.mockResolvedValueOnce({kind:"EZLINKS_UNPAGED_SEARCH_V1",assets:[]} as never);
      await expect(operation==="inspect"?inspectEzLinks(source,f.deps):executeEzLinks(source,meta,{courseId:"x"},input,f.deps))
        .rejects.toThrow("EZLINKS_READ_CONTRACT_UNVERIFIED");
      expect(f.raw).not.toHaveBeenCalled();expect(f.close).toHaveBeenCalledOnce();
    }
    const f=dependencies();f.contract.mockRejectedValueOnce(new Error("EZLINKS_READ_CONTRACT_UNVERIFIED"));
    await expect(executeEzLinks(source,meta,{courseId:"x"},input,f.deps)).rejects.toThrow("EZLINKS_READ_CONTRACT_UNVERIFIED");
    expect(f.raw).not.toHaveBeenCalled();
  });
  it.each(["EZLINKS_DOCUMENT_CHANGED","EZLINKS_PUBLIC_READ_FAILED","EZLINKS_READ_TIMEOUT","ACCESS_REQUIRED"])("preserves %s as failure, never EMPTY",async code=>{
    const f=dependencies(),meta=parseEzLinksConfiguration(configuration(),source).metadata;f.raw.mockRejectedValueOnce(new Error(code));
    await expect(executeEzLinks(source,meta,{courseId:"x"},input,f.deps)).rejects.toThrow(code);expect(f.close).toHaveBeenCalledOnce();
  });
  it("returns verified empty only after complete fresh config and strict completed listing",async()=>{
    const value=body();value.r06=[];
    expect(await executeEzLinks(source,parseEzLinksConfiguration(configuration(),source).metadata,{courseId:"x"},input,dependencies(configuration(),value).deps)).toEqual([]);
    const f=dependencies(configuration(),{r00:false,r06:[]});await expect(executeEzLinks(source,parseEzLinksConfiguration(configuration(),source).metadata,{courseId:"x"},input,f.deps)).rejects.toThrow("EZLINKS_AVAILABILITY_INVALID");
  });
  it("rejects expired native deadline or target mismatch before launching",async()=>{
    const f=dependencies(),meta=parseEzLinksConfiguration(configuration(),source).metadata;f.deps.deadlineAt=new Date(Date.now()-1);
    await expect(inspectEzLinks(source,f.deps)).rejects.toThrow("DEADLINE_EXCEEDED");expect(f.create).not.toHaveBeenCalled();
    await expect(executeEzLinks(source,meta,{courseId:"x"},{...input,durationMinutes:60},f.deps)).rejects.toThrow("ADAPTER_TARGET_MISMATCH");
    await expect(executeEzLinks(source,{...meta,tenant:"other-course"},{courseId:"x"},input,f.deps)).rejects.toThrow("ADAPTER_SOURCE_MISMATCH");
  });
  it("rejects timezone gaps/folds without guessing an offset",()=>{
    expect(ezlinksLocalInstant("2026-10-23T11:00:00",source.timeZone).toISOString()).toBe("2026-10-23T15:00:00.000Z");
    expect(()=>ezlinksLocalInstant("2026-03-08T02:30:00",source.timeZone)).toThrow("AMBIGUOUS_OR_INVALID_LOCAL_TIME");
    expect(()=>ezlinksLocalInstant("2026-11-01T01:30:00",source.timeZone)).toThrow("AMBIGUOUS_OR_INVALID_LOCAL_TIME");
  });
});
