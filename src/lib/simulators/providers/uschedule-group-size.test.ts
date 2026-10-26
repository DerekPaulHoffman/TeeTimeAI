import { describe, expect, it, vi } from "vitest";
import { fetchUScheduleRecipeAvailability, readUScheduleGroupSizeControl } from "./uschedule";
import { createUSchedulePublicSession } from "@/lib/automation/uschedule-public-session";
const url = "https://clients.uschedule.com/examplegolfstudio/booking", cookie = "ASP.NET_SessionId=OwnedAnonymous123";
const controls = `<body class="examplegolfstudio"><select id="select_service"><option value="73" selected>Simulator Rental</option></select>
 <select id="select_length"><option value="60" selected>1 hour</option></select>`;
const groups = `<select id="select_group_size"><option value="1" selected>1</option></select>`;
const dates = ["102720261000", "102820261000"];
const listing = dates.map(time => `<div class="next_avail_results"><div class="next_avail_item" data-time="${time}" data-empid="0"><span>Simulator Rental</span></div></div>`).join("") +
 `<script>var chosenDate = new Date(2026,9,27); var lastAvailTime = '${dates[1]}';</script></body>`;
const input = { date: "2026-10-27", durationMinutes: 60, partySize: 1, timeZone: "America/New_York",
 offering: { id: "o", courseId: "c", bookingUrl: url, providerFamilyKey: "USCHEDULE", active: true, publicAccessStatus: "PUBLIC" as const,
 providerMetadata: { tenant: "examplegolfstudio", serviceId: "73" }, maxPartySize: null, supportedDurationsMinutes: [60] } };
describe("USchedule observed optional public resource quantity", () => {
 it("accepts a bounded 25-row page only with the same exact row identity/order/date/later-day evidence",async()=>{
  const times=Array.from({length:25},(_,i)=>`${i<12?'10272026':'10282026'}${String(8+(i<12?i:i-12)).padStart(2,'0')}00`),page=controls+times.map(time=>`<div class="next_avail_results"><div class="next_avail_item" data-time="${time}" data-empid="0">Simulator Rental</div></div>`).join('')+`<script>var chosenDate = new Date(2026,9,27); var lastAvailTime = '${times.at(-1)}';</script></body>`;
  let gets=0;const fetch=vi.fn<typeof globalThis.fetch>(async(_u,init)=>init?.method==='POST'?Response.json({code:'refresh'}):new Response(++gets===3?page:controls+'</body>',{headers:{'content-type':'text/html',...(gets===1?{'set-cookie':cookie+'; Secure'}:{})}}));
  const result=await fetchUScheduleRecipeAvailability(input,{serviceId:'73',serviceName:'Simulator Rental'},fetch);expect(result.complete).toBe(true);expect(result.slots).toHaveLength(12);expect(fetch).toHaveBeenCalledTimes(5);
 });
 it("private capture sees existing consumed responses without extra requests or credential fields", async () => {
  let gets=0;const rows:Array<Record<string,unknown>>=[];
  const fetch=vi.fn<typeof globalThis.fetch>(async(_url,init)=>init?.method==='POST'?Response.json({code:'refresh'}):new Response(controls+(++gets===3?listing:'</body>'),{headers:{'content-type':'text/html',...(gets===1?{'set-cookie':cookie+'; Secure'}:{})}}));
  const session=createUSchedulePublicSession(url,{fetch,requestLease:async(_f,work)=>({acquired:true,value:await work()}),onPublicRead:row=>{rows.push({...row});if(row.method==='POST')throw Error('PRIVATE_CAPTURE_FAILED');}});
  try{const result=await fetchUScheduleRecipeAvailability(input,{serviceId:'73',serviceName:'Simulator Rental'},session.read);expect(result.complete).toBe(true);expect(fetch).toHaveBeenCalledTimes(5);expect(rows).toHaveLength(5);expect(rows.map(r=>r.status)).toEqual([200,200,200,200,200]);expect(rows[1].requestBody).toBe('[{"Name":"length","Value":"60"}]');for(const row of rows)expect(Object.keys(row).sort()).toEqual(row.method==='POST'?['method','requestBody','responseText','status']:['method','responseText','status']);}finally{session.dispose();}
 });
 it("skips an absent group field through the real session policy and completes dated provider coverage", async () => {
  let gets = 0; const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => init?.method === "POST" ? Response.json({ code: "refresh" }) :
   new Response(controls + (++gets === 3 ? listing : "</body>"), { headers: { "content-type": "text/html", ...(gets === 1 ? { "set-cookie": cookie + "; Secure" } : {}) } }));
  const session = createUSchedulePublicSession(url, { fetch, requestLease: async (_family, work) => ({ acquired: true, value: await work() }) });
  try {
   const result = await fetchUScheduleRecipeAvailability(input, { serviceId: "73", serviceName: "Simulator Rental" }, session.read);
   expect(result.complete).toBe(true); expect(result.slots).toHaveLength(1); expect(result.slots[0].maxPartySize).toBeNull();
   expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST", "GET", "POST", "GET"]);
   expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => init?.body)).toEqual([
    '[{"Name":"length","Value":"60"}]', '[{"Name":"start_date","Value":"10/27/2026"}]']);
  } finally { session.dispose(); }
 });
 it("retains a genuinely observed single-bay selector and never interprets it as attendee capacity", () => {
  expect(readUScheduleGroupSizeControl(controls + groups)).toEqual({ present: true, oneAvailable: true });
  expect(readUScheduleGroupSizeControl(controls)).toEqual({ present: false, oneAvailable: false });
  expect(readUScheduleGroupSizeControl(controls + groups.replace('value="1"', 'value="2"'))).toEqual({ present: true, oneAvailable: false });
 });
 it.each([groups + groups, groups.replace('<select ', '<select hidden '), `<div style="display:none">${groups}</div>`, '<select id="select_group_size"></select>'])("rejects ambiguous/hidden/malformed existing controls", fragment => {
  expect(() => readUScheduleGroupSizeControl(controls + fragment)).toThrow();
 });
});
