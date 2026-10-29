// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ACUITY_ONE_HOUR_VARIANTS, fetchAcuitySimulatorAvailability, projectAcuityPublicConfiguration } from "./acuity";
import type { SimulatorAvailabilityInput } from "./types";

const url="https://example.as.me/schedule/owner123", date="2030-10-31", zone="America/New_York";
export function variantsBusiness(){return {id:345,name:"Cedar Simulator",ownerKey:"owner123",timezone:zone,includesAdminOnly:false,isExpired:false,
  description:"Public simulator rentals. Our Private Bay is one bay.",calendars:{"":[{id:"any",name:"Any available",timezone:""}]},
  appointmentTypes:{"":[false,true].flatMap(privateBay=>[1,2,3,4,5,6].map(hours=>({id:(privateBay?200:100)+hours,
    name:`${privateBay?"Private ":""}Simulator Booking ${hours} ${hours===1?"Hour":"Hours"}`,
    duration:privateBay&&hours===6?300:hours*60,active:true,private:false,type:"service",classSize:null,canChooseQuantity:false,
    paddingBefore:0,paddingAfter:0,calendarIDs:["any"]})))}};}
export const variantsHtml=(value=variantsBusiness())=>`<script>var BUSINESS = ${JSON.stringify(value)};</script>`;
function input():SimulatorAvailabilityInput{const c=projectAcuityPublicConfiguration(variantsHtml(),url)!;return {date,durationMinutes:60,partySize:3,timeZone:zone,
  offering:{id:"offering",courseId:"course",bookingUrl:url,providerFamilyKey:"ACUITY",providerMetadata:{ownerKey:c.ownerKey,rentalProductIds:c.rentals.map(r=>r.id),
    rentalScope:c.rentalScope,publicCatalogSha256:c.publicCatalogSha256},maxPartySize:null,supportedDurationsMinutes:[60]}};}
const day=(hour=10)=>({[date]:[{time:`${date}T${hour}:00:00-0400`,slotsAvailable:1}]});
describe("complete scoped one-hour public pool variants",()=>{
  it("records only both explicit one-hour alternatives while hashing contradictory longer rows",()=>{
    const c=projectAcuityPublicConfiguration(variantsHtml(),url)!;
    expect(c).toMatchObject({rentalScope:ACUITY_ONE_HOUR_VARIANTS,rentals:[{id:"101",durationMinutes:60},{id:"201",durationMinutes:60}]});
    const changed=variantsBusiness();changed.appointmentTypes[""][11].duration=360;
    expect(projectAcuityPublicConfiguration(variantsHtml(changed),url)?.publicCatalogSha256).not.toBe(c.publicCatalogSha256);
  });
  it("reads every product and unions complete intervals without counting overlapping pools twice",async()=>{
    const f=vi.fn<typeof fetch>(async value=>{const u=new URL(String(value));return u.pathname.startsWith("/schedule/")?new Response(variantsHtml(),{headers:{"content-type":"text/html"}}):Response.json(
      u.searchParams.get("appointmentTypeId")==="101"?day():{[date]:[...day()[date],...day(11)[date]]});});
    const result=await fetchAcuitySimulatorAvailability(input(),f);
    expect(result.complete).toBe(true);expect(result.slots).toHaveLength(2);expect(new Set(result.slots.map(s=>s.productId))).toEqual(new Set(["one-hour-public-pool"]));
    expect(result.slots.every(s=>s.resourceId==="ANY"&&s.endsAt.getTime()-s.startsAt.getTime()===3600000)).toBe(true);
    expect(f.mock.calls.slice(1).map(c=>new URL(String(c[0])).searchParams.get("appointmentTypeId"))).toEqual(["101","201"]);
  });
  it.each(["missing","wrong-date","malformed"])("never reports partial stock if second product is %s",async kind=>{
    const f=vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(variantsHtml(),{headers:{"content-type":"text/html"}})).mockResolvedValueOnce(Response.json(day()))
      .mockResolvedValueOnce(Response.json(kind==="missing"?{}:kind==="wrong-date"?{"2030-11-01":[]}: {[date]:[{time:"bad",slotsAvailable:1}]}));
    await expect(fetchAcuitySimulatorAvailability(input(),f)).rejects.toMatchObject({code:"SCHEMA_CHANGED"});
  });
  it("requires complete saved IDs and unchanged full catalog before any availability read",async()=>{
    const i=input();(i.offering.providerMetadata as {rentalProductIds:string[]}).rentalProductIds=["101"];
    const f=vi.fn<typeof fetch>().mockResolvedValue(new Response(variantsHtml(),{headers:{"content-type":"text/html"}}));
    await expect(fetchAcuitySimulatorAvailability(i,f)).rejects.toMatchObject({code:"INVALID_SOURCE"});expect(f).toHaveBeenCalledOnce();
  });
  it.each(["restricted","padding","third-product","missing-description","quantity","label-mismatch"])("refuses ambiguous scoped catalog: %s",kind=>{
    const b=variantsBusiness();const row=b.appointmentTypes[""][6];
    if(kind==="restricted")row.private=true;if(kind==="padding")row.paddingAfter=15;if(kind==="quantity")row.canChooseQuantity=true;
    if(kind==="missing-description")b.description="Public simulator rentals";
    if(kind==="label-mismatch")row.duration=120;
    if(kind==="third-product")b.appointmentTypes[""].push({...row,id:999,name:"Another Bay Rental"});
    expect(projectAcuityPublicConfiguration(variantsHtml(b),url)).toBeUndefined();
  });
});
