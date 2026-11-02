import { describe, expect, it, vi } from "vitest";
import { inspectExistingAdapter, executeExistingAdapterRecipe } from "./existing-adapter-executor";
import { parseAccessRecipe } from "./recipe";
import { recipeTimeToInstant, venueProofMatches } from "./executor";
import { parseGolfBookSource } from "./golfbook-source";

const source = { officialUrl:"https://venue.example/",bookingUrl:"https://example-venue.golfbooking.us/calendar.php",providerFamily:"GOLFBOOK",
  venueName:"Example Golf Simulator",venueAddress:"100 Post Rd E, Exampletown, CT 06880, USA",timeZone:"America/New_York" };
const input = {date:"2030-01-02",players:2,timeZone:source.timeZone,startTime:"09:00",endTime:"18:00",durationMinutes:60};
const identity = `<a href="https://www.venue.example/?utm_source=golfbooking">Example Golf Simulator</a><a href="https://maps.google.com?q=100 Post Road East, Exampletown CT, 06880">100 Post Road East, Exampletown CT, 06880</a>`;
function page(date:string,selected:boolean,change=""){
  const button=`<button id="btn_tee_sheet" onclick="redirect('bookingsheet', 'date=${date}&templateId=12')">Simulators</button>`;
  const stamp=Date.parse(`${date}T15:00:00Z`)/1000;
  const rows=Array.from({length:5},(_,i)=>`<tr><td class="time-col">${10+Math.floor(i/4)}:${String(i*15%60).padStart(2,"0")} AM</td>${["1","2"].map((resource,j)=>{
    const free=change==="disjoint"?(j===0?i<2:i>=2):change!=="gap"||j!==0||i!==2;
    return `<td class="status_${free?1:2}" ${free?`onclick="redirect('reserve','date=${stamp+i*900}&lane=${resource}&templateId=12')"`:""}>${free?"Available":"Unavailable"}</td>`;
  }).join("")}</tr>`).join("");
  let html=identity+button+(selected?`<input id="waitlist_date" value="${date}"><input id="waitlist_template" value="12"><input id="template_min_booking_mins" value="60"><input id="template_max_booking_mins" value="240"><input id="template_booking_increment_mins" value="15"><table id="bookingsheet"><thead><tr><th>Time</th><th id="th_1">Bay 1 Standard</th><th id="th_2">Bay 2 Widescreen</th></tr></thead><tbody>${rows}</tbody></table>`:"");
  if(change==="foreign")html=html.replaceAll("100 Post Road East","101 Post Road East");
  if(change==="karaoke")html=html.replace("Bay 2 Widescreen","Karaoke 2");
  if(change==="timezone")html=html.replaceAll(`date=${stamp}`,`date=${stamp+3600}`);
  if(change==="resource")html=html.replace('id="th_2"','id="th_3"');
  if(change==="template")html=html.replace('id="waitlist_template" value="12"','id="waitlist_template" value="13"');
  if(change==="wrongDate")html=html.replace(`id="waitlist_date" value="${date}"`,'id="waitlist_date" value="2030-01-03"');
  if(change==="name")html=html.replaceAll("Example Golf Simulator","Other Golf Simulator");
  if(change==="official")html=html.replace("www.venue.example","www.other.example");
  if(change==="hidden")html=html.replace('id="btn_tee_sheet"','id="btn_tee_sheet" hidden');
  return html;
}
function deps(change="",status=200){
  const fetch=vi.fn<typeof globalThis.fetch>(async value=>{const u=new URL(String(value));
    expect(u.origin+u.pathname).toBe("https://example-venue.golfbooking.us/bookingsheet.php");
    expect([...u.searchParams.keys()].sort()).toEqual(u.searchParams.has("templateId")?["date","lang","templateId"]:["date","lang"]);
    return new Response(page(u.searchParams.get("date")!,u.searchParams.has("templateId"),change),{status,headers:{"content-type":"text/html"}});
  });
  return {fetch,now:()=>new Date("2029-01-01T12:00:00Z"),requestedInput:input,venueMatches:venueProofMatches,toInstant:recipeTimeToInstant,recipeHash:"a".repeat(64),
    requestLease:async<T,>(_family:string,work:()=>Promise<T>)=>({acquired:true as const,value:await work()})};
}
async function learned(){const observed=await inspectExistingAdapter(source,deps());return parseAccessRecipe({schemaVersion:1,engine:"EXISTING_ADAPTER",target:{kind:"SIMULATOR",courseId:"course",offeringId:"offering"},source,adapter:observed.adapter})}
describe("learned public GolfBook simulator category",()=>{
  it("derives the published simulator template and complete resource catalog anonymously",async()=>{
    const d=deps(),r=await inspectExistingAdapter(source,d);
    expect(r.adapter).toMatchObject({family:"GOLFBOOK",templateId:"12",resourceIds:["1","2"],incrementMinutes:15,minDurationMinutes:60});
    expect(d.fetch).toHaveBeenCalledTimes(2);
    for(const [,request]of d.fetch.mock.calls){expect(request).toMatchObject({method:"GET",credentials:"omit",redirect:"manual"});expect(new Headers(request?.headers).has("authorization")).toBe(false)}
  });
  it("requires four adjacent public quarter-hour cells on one actual bay",async()=>{
    const r=await executeExistingAdapterRecipe(await learned(),input,deps("gap"));
    expect(r).toMatchObject({status:"AVAILABLE",complete:true});expect(r.slots).toHaveLength(2);
    expect(r.slots.every(s=>s.resourceId==="2"&&Date.parse(s.endsAt!)-Date.parse(s.startsAt)===3600000)).toBe(true);
  });
  it("never combines disjoint half-sessions on different bays",async()=>{
    expect(await executeExistingAdapterRecipe(await learned(),input,deps("disjoint"))).toMatchObject({complete:true,status:"EMPTY",slots:[]});
  });
  it("reuses serialized metadata on another date and golfer context without discovery",async()=>{
    const method=JSON.parse(JSON.stringify(await learned()));
    const first=await executeExistingAdapterRecipe(method,input,deps());
    const second=await executeExistingAdapterRecipe(method,{...input,date:"2030-01-03",players:3},deps());
    expect(first.slots).toHaveLength(4);expect(second.slots).toHaveLength(4);
    expect(second.slots[0].startsAt).toBe("2030-01-03T15:00:00.000Z");expect(second.complete).toBe(true);
  });
  it.each(["foreign","karaoke","timezone","resource","template","wrongDate","name","official","hidden"])("keeps %s drift incomplete rather than empty",async change=>{
    const r=await executeExistingAdapterRecipe(await learned(),input,deps(change));expect(r.complete).toBe(false);expect(r.status).not.toBe("EMPTY");expect(r.slots).toEqual([]);
  });
  it.each([401,403,429,500])("keeps HTTP %i distinct from no availability",async status=>{
    const r=await executeExistingAdapterRecipe(await learned(),input,deps("",status));expect(r.complete).toBe(false);expect(r.status).not.toBe("EMPTY");
  });
  it.each([source.bookingUrl+"?templateId=12",source.bookingUrl.replace("calendar","reserve"),source.bookingUrl.replace("golfbooking.us","golfbooking.us.evil.example"),source.bookingUrl.replace("https:","http:")])("rejects unscoped source %s",url=>expect(parseGolfBookSource(url)).toBeNull());
  it("does not accept an outdoor target for simulator metadata",async()=>{
    const r=await learned();expect(()=>parseAccessRecipe({...r,target:{kind:"OUTDOOR",courseId:"course"}})).toThrow();
  });
});
