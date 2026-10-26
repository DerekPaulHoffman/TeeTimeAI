import { describe, expect, it, vi } from "vitest";
import { readUScheduleNextAvailableView } from "./uschedule-public-view-control";
import { createUSchedulePublicReadPolicy } from "./uschedule-public-read-policy";
import { createUSchedulePublicSession } from "./uschedule-public-session";
import { fetchUScheduleRecipeAvailability } from "@/lib/simulators/providers/uschedule";
const url="https://clients.uschedule.com/examplegolfstudio/booking",tenant="examplegolfstudio";
const control='<li onclick="return saveBookingDetail(\'next_avail\');">Next Available</li>';
const controls='<select id="select_service"><option value="73" selected>Simulator Rental</option></select><select id="select_length"><option value="60" selected>1 hour</option></select>';
const html=(c=control)=>`<body class="${tenant}">${controls}<ul><li class="selected" onclick="return saveBookingDetail('single_date');">Date Chosen</li>${c}</ul><script>var chosenDate = new Date(2026,9,27);</script></body>`;
const headers=new Headers({"content-type":"application/json","origin":"https://clients.uschedule.com","referer":url});
const endpoint=new URL(url+"/changefield"),payload=JSON.stringify([{Name:"next_avail"}]);
describe("fresh public Next Available display control",()=>{
 it("earns only the exact literal one-argument nonhidden current-tenant control",()=>{expect(readUScheduleNextAvailableView(html(),tenant)).toEqual({present:true,selected:false});expect(readUScheduleNextAvailableView(html(control.replace("<li ",'<li class="selected" ')),tenant)).toEqual({present:true,selected:true});});
 it.each([control.replace("<li ","<li hidden "),`<div style="display:none">${control}</div>`,`<form>${control}</form>`,control+control,control.replace("next_avail","payment"),control.replace("next_avail'","next_avail','1'"),control.replace("Next Available","Checkout")])("does not earn hidden/ambiguous/transaction/extra-argument control",c=>{expect(readUScheduleNextAvailableView(html(c),tenant).present).toBe(false);});
 it("requires exact source context, one-key payload, safe headers and fresh current HTML",()=>{
  const p=createUSchedulePublicReadPolicy();expect(p.allows(endpoint,headers,payload)).toBe(false);p.observeResponse(url,"GET",200,"text/html",html());expect(p.allows(endpoint,headers,payload)).toBe(true);
  for(const body of [[{Name:"next_avail",Value:""}],[{Name:"next_avail",Value:null}],[{Name:"next_avail",Value:"1"}],[{Name:"next_avail",extra:true}],[{Name:"payment"}],[{Name:"next_avail"},{Name:"next_avail"}]])expect(p.allows(endpoint,headers,JSON.stringify(body))).toBe(false);
  expect(p.allows(new URL("https://foreign.example/changefield"),headers,payload)).toBe(false);expect(p.allows(endpoint,new Headers({...Object.fromEntries(headers),authorization:"PRIVATE"}),payload)).toBe(false);
  p.observeResponse(url,"GET",200,"text/html",html(control.replace("<li ","<li hidden ")));expect(p.allows(endpoint,headers,payload)).toBe(false);
  p.observeResponse(url,"GET",200,"text/html",html());p.observeResponse(url,"GET",500,"text/html",html());expect(p.allows(endpoint,headers,payload)).toBe(false);
  p.observeResponse(url,"GET",200,"text/html",html().replace(`class="${tenant}"`,'class="foreigntenant"'));expect(p.allows(endpoint,headers,payload)).toBe(false);
 });
 it("selects exact public display after requested date then retains normal chronological later-day completion",async()=>{
  let gets=0;const rows=['102720261000','102820261000'].map(time=>`<div class="next_avail_results"><div class="next_avail_item" data-time="${time}" data-empid="0">Simulator Rental</div></div>`).join('')+"<script>var lastAvailTime = '102820261000';</script>";
  const fetch=vi.fn<typeof globalThis.fetch>(async(_u,init)=>init?.method==='POST'?Response.json({code:'refresh'}):new Response(++gets===4?html(control.replace('<li ','<li class="selected" ')).replace('</body>',rows+'</body>'):html(),{headers:{'content-type':'text/html',...(gets===1?{'set-cookie':'ASP.NET_SessionId=OwnedAnonymous123; Secure'}:{})}}));
  const session=createUSchedulePublicSession(url,{fetch,requestLease:async(_f,work)=>({acquired:true,value:await work()})});
  try{const result=await fetchUScheduleRecipeAvailability({date:'2026-10-27',durationMinutes:60,partySize:1,timeZone:'America/New_York',offering:{id:'o',courseId:'c',bookingUrl:url,providerFamilyKey:'USCHEDULE',providerMetadata:{},maxPartySize:null,supportedDurationsMinutes:[60]}},{serviceId:'73',serviceName:'Simulator Rental'},session.read);
   expect(result.complete).toBe(true);expect(result.slots).toHaveLength(1);expect(fetch.mock.calls.filter(([,i])=>i?.method==='POST').map(([,i])=>i?.body)).toEqual(['[{"Name":"length","Value":"60"}]','[{"Name":"start_date","Value":"10/27/2026"}]',payload]);
  }finally{session.dispose();}
 });
});
