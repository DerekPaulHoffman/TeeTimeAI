import { describe, expect, it, vi } from "vitest";
import { uscheduleReadGate, uscheduleReadGates } from "./uschedule-read-diagnostic";
import { SimulatorAvailabilityError } from "./types";
import { fetchUScheduleRecipeAvailability } from "./uschedule";
import { accessExecutionDiagnosticSchema } from "@/lib/course-discovery/recipe";
import { executeExistingAdapterRecipe } from "@/lib/course-discovery/existing-adapter-executor";
import { recipeTimeToInstant, venueProofMatches } from "@/lib/course-discovery/executor";
import { discoveryReplayDetails } from "../../../../scripts/automation/course-discovery-worker.mjs";
const url="https://clients.uschedule.com/examplegolfstudio/booking",cookie="ASP.NET_SessionId=OwnedAnonymous123";
const controls='<body class="examplegolfstudio"><select id="select_service"><option value="73" selected>Simulator Rental</option></select><select id="select_length"><option value="60" selected>1 hour</option></select>';
const oversized=controls+Array.from({length:26},(_,i)=>`<div class="next_avail_results"><div class="next_avail_item" data-empid="0" data-time="${i<12?'10272026':'10282026'}${String(8+(i%12)).padStart(2,"0")}00">Simulator Rental</div></div>`).join("")+"<script>var chosenDate = new Date(2026,9,27);</script></body>";
const input={date:"2026-10-27",durationMinutes:60,partySize:1,timeZone:"America/New_York",offering:{id:"o",courseId:"c",bookingUrl:url,providerFamilyKey:"USCHEDULE",providerMetadata:{},maxPartySize:null,supportedDurationsMinutes:[60]}};
function fakeFetch(){let gets=0;return vi.fn<typeof fetch>(async(_url,init)=>init?.method==="POST"?Response.json({code:"refresh"}):new Response(++gets===3?oversized:controls+"</body>",{headers:{"content-type":"text/html",...(gets===1?{"set-cookie":cookie+"; Secure"}:{})}}));}
describe("closed USchedule read gates",()=>{
 it("maps only exact known static provider messages, never arbitrary content",()=>{
  expect(uscheduleReadGate(new SimulatorAvailabilityError("SCHEMA_CHANGED","The public availability list is missing or ambiguous"))).toBe("PUBLIC_AVAILABILITY_LIST_IS_MISSING_OR_AMBIGUOUS");
  for(const error of [Error("The public availability list is missing or ambiguous"),new SimulatorAvailabilityError("SCHEMA_CHANGED","PRIVATE https://secret.example/"),new SimulatorAvailabilityError("HTTP_ERROR","The public availability list is missing or ambiguous")])expect(uscheduleReadGate(error)).toBeUndefined();
 });
 it("copies exact gates through the real result schema and worker projection, with unknown/private negatives",()=>{
  for(const gate of uscheduleReadGates){const value={code:"SIMULATOR_PROVIDER_ERROR",simulatorError:{code:"SCHEMA_CHANGED",retryable:false,uscheduleGate:gate}},parsed=accessExecutionDiagnosticSchema.parse(value);expect(discoveryReplayDetails({evidence:{diagnostic:parsed}}).diagnostic?.simulatorError?.uscheduleGate).toBe(gate);}
  for(const gate of ["PRIVATE",{},[uscheduleReadGates[0]]]){const value={code:"SIMULATOR_PROVIDER_ERROR",simulatorError:{code:"SCHEMA_CHANGED",retryable:false,uscheduleGate:gate}};expect(accessExecutionDiagnosticSchema.safeParse(value).success).toBe(false);expect(JSON.stringify(discoveryReplayDetails({evidence:{diagnostic:value}}))).not.toContain("PRIVATE");expect(discoveryReplayDetails({evidence:{diagnostic:value}}).diagnostic?.simulatorError).not.toHaveProperty("uscheduleGate");}
 });
 it("retains the exact existing listing cap and captures only its already-read body without changing five requests",async()=>{
  const fetch=fakeFetch(),seen:string[]=[];await expect(fetchUScheduleRecipeAvailability(input,{serviceId:"73",serviceName:"Simulator Rental"},fetch,{onListingPage:html=>seen.push(html)})).rejects.toMatchObject({code:"SCHEMA_CHANGED",message:"The public availability list is missing or ambiguous"});expect(seen).toEqual([oversized]);expect(fetch.mock.calls.map(([,i])=>i?.method)).toEqual(["GET","POST","GET","POST","GET"]);
 });
 it("diagnostic callback failure cannot mask the original parser rejection",async()=>{await expect(fetchUScheduleRecipeAvailability(input,{serviceId:"73",serviceName:"Simulator Rental"},fakeFetch(),{onListingPage:()=>{throw Error("PRIVATE");}})).rejects.toMatchObject({code:"SCHEMA_CHANGED",message:"The public availability list is missing or ambiguous"});});
 it("actual executor preserves the gate with original incomplete status and false proof flags",async()=>{
  const result=await executeExistingAdapterRecipe({schemaVersion:1,engine:"EXISTING_ADAPTER",source:{bookingUrl:url,officialUrl:"https://example.org/",venueName:"Example Golf Studio",venueAddress:"10 Main Road, Example, NY 12345",timeZone:input.timeZone,providerFamily:"USCHEDULE"},target:{courseId:"c",offeringId:"o",kind:"SIMULATOR"},adapter:{family:"USCHEDULE",tenant:"examplegolfstudio",serviceId:"73",serviceName:"Simulator Rental"}}, {date:input.date,players:1,startTime:"08:00",endTime:"18:00",durationMinutes:60,timeZone:input.timeZone}, {fetch:fakeFetch(),requestLease:async(_f,work)=>({acquired:true,value:await work()}),venueMatches:venueProofMatches,toInstant:recipeTimeToInstant,recipeHash:"a".repeat(64),now:()=>new Date("2026-10-26T00:00:00Z")});
  expect(result.complete).toBe(false);expect(result.status).toBe("INCOMPLETE");expect(result.evidence.reason,JSON.stringify(result.evidence.diagnostic)).toBe("SCHEMA_CHANGED");expect(result.evidence.venueVerified).toBe(false);expect(result.evidence.diagnostic?.simulatorError?.uscheduleGate).toBe("PUBLIC_AVAILABILITY_LIST_IS_MISSING_OR_AMBIGUOUS");
 });
});
