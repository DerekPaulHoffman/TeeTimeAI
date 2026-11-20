// @vitest-environment node
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { executeAccessRecipe } from "./executor";
import { parseAccessRecipe, recipeResourceScopeSchema } from "./recipe";
import { inspectSquareRentalAddElement, selectSquareRental, inspectSquareRentalNext, continueSquareRental, inspectSquareAvailabilityScope } from "./square-public-service-control";

const catalog = "https://book.squareup.com/appointments/publicfixture/location/LOC1234567890/services";
const source = `${catalog}/${"A".repeat(24)}`;
const label = "1 hour practice/play";
const detail = (name = label) => `<section aria-label="Main content"><h2>${name}</h2><div data-testid="variation-details-summary"><span>$75.00 ・ 1 hr</span></div><div data-testid="service-description"></div><market-button type="button" id="add">Add</market-button></section>`;
const summary = (name: string) => `<div><div data-testid="desktop-cart"><h2>Appointment summary</h2><div data-testid="service-staff-row"><span>${name}</span><div>$75.00</div></div></div><market-button type="button" id="next">Next</market-button></div>`;
const calendar = (name: string) => `<div data-testid="availability-page"><section aria-label="Main content"><div data-testid="availability-segments"><div role="list" aria-label="Available time slots, Afternoon, select a time to proceed"><market-button type="button" role="listitem" data-testid="time-slot">4:30 PM</market-button></div></div></section><aside><div data-testid="desktop-cart"><div data-testid="service-staff-row"><span class="rental-name">${name}</span><div>$75.00</div></div></div></aside></div>`;
const html = (name = label) => `<html><head><meta charset="utf-8"><style>market-button{display:block}</style></head><body>${detail(name)}<script>
customElements.define('market-button',class extends HTMLElement{connectedCallback(){if(!this.shadowRoot)this.attachShadow({mode:'open'}).innerHTML='<button type="button"><slot></slot></button>'}});
document.getElementById('add').addEventListener('click',()=>{history.pushState({},'',${JSON.stringify(catalog)});document.body.innerHTML=${JSON.stringify(summary(name))};document.getElementById('next').addEventListener('click',()=>{history.pushState({},'',${JSON.stringify(catalog.replace(/services$/u, "availability"))});document.body.innerHTML=${JSON.stringify(calendar(name))}})})
</script></body></html>`;

describe("public Square rental without variants", () => {
  it("keeps browser callbacks self-contained under the production loader", () => {
    const result = execFileSync(process.execPath, ["--import", "tsx", "-e", `const {inspectSquareRentalAddElement,inspectSquareRentalNext}=require('./src/lib/course-discovery/square-public-service-control.ts');process.stdout.write(JSON.stringify([inspectSquareRentalAddElement,inspectSquareRentalNext].map(f=>f.toString())))`], {encoding:"utf8",timeout:15000});
    for (const serialized of JSON.parse(result)) { expect(serialized).not.toMatch(/\b__name\(/u); expect(() => new Function(`return (${serialized})`)()).not.toThrow(); }
  });
  it("selects one priced full-session rental and binds its single-label summary", async () => {
    const browser = await chromium.launch({headless:true});
    try {
      const page = await browser.newPage(); await page.route("**/*", route => route.fulfill({contentType:"text/html",body:html()})); await page.goto(source);
      const add = page.locator("#add button");
      const proof = await add.evaluate(inspectSquareRentalAddElement);
      expect(proof).toMatchObject({squareService:true,label,durationMinutes:60,option:null});
      const selection = await selectSquareRental(add, proof!);
      expect(await inspectSquareRentalNext(page.locator("#next button"), selection)).toBe(true);
      await continueSquareRental(page.locator("#next button"), selection);
      expect(await inspectSquareAvailabilityScope(page.locator('[data-testid="availability-page"]'),selection,'.rental-name','[data-testid="time-slot"]',60)).toBe(true);
    } finally {await browser.close();}
  },30000);
  it("rejects ambiguous prices, member services, inputs and hidden or injected option lists", async () => {
    const browser = await chromium.launch({headless:true});
    try {
      const page = await browser.newPage(); await page.route("**/*", route=>route.fulfill({contentType:"text/html",body:html()}));
      for (const mutation of ["member","price","input","options","duration","hidden"]) {
        await page.goto(source);
        await page.evaluate(kind=>{const section=document.querySelector('section')!;
          if(kind==='member')section.querySelector('h2')!.textContent='Member 1 hour practice/play';
          if(kind==='price')section.querySelector('[data-testid="variation-details-summary"]')!.insertAdjacentHTML('beforeend','<span>$80.00 ・ 1 hr</span>');
          if(kind==='input')section.insertAdjacentHTML('beforeend','<input name="customer">');
          if(kind==='options')section.insertAdjacentHTML('beforeend','<market-list role="listbox" hidden></market-list>');
          if(kind==='duration')section.querySelector('[data-testid="variation-details-summary"] span')!.textContent='$75.00 ・ 2 hr';
          if(kind==='hidden')section.querySelector('[data-testid="variation-details-summary"]')!.setAttribute('hidden','');
        },mutation);
        expect(await page.locator('#add button').evaluate(inspectSquareRentalAddElement),mutation).toBeUndefined();
      }
    } finally {await browser.close();}
  },30000);
  it("preserves published weekday limits and rejects an altered single-label summary", async () => {
    const browser = await chromium.launch({headless:true});
    try {
      const name = `${label} after 4pm and weekends`, page=await browser.newPage();
      await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:html(name)}));await page.goto(source);
      const proof=await page.locator('#add button').evaluate(inspectSquareRentalAddElement);
      expect(proof).toMatchObject({option:null,weekdayStartMinutes:960,durationMinutes:60});
      const selected=await selectSquareRental(page.locator('#add button'),proof!);
      await page.locator('[data-testid="service-staff-row"]').evaluate(e=>e.insertAdjacentHTML('beforeend','<span>Regular</span>'));
      expect(await inspectSquareRentalNext(page.locator('#next button'),selected)).toBe(false);
      await page.locator('[data-testid="service-staff-row"] span').last().evaluate(e=>e.remove());
      await continueSquareRental(page.locator('#next button'),selected);
      const scope=page.locator('[data-testid="availability-page"]');
      expect(await inspectSquareAvailabilityScope(scope,selected,'.rental-name','[data-testid="time-slot"]',60)).toBe(false);
      expect(await inspectSquareAvailabilityScope(scope,selected,'.rental-name','[data-testid="time-slot"]',60,'2030-01-11')).toBe(true);
      await page.locator('[data-testid="time-slot"]').evaluate(e=>e.textContent='10:30 AM');
      expect(await inspectSquareAvailabilityScope(scope,selected,'.rental-name','[data-testid="time-slot"]',60,'2030-01-11')).toBe(false);
      expect(await inspectSquareAvailabilityScope(scope,selected,'.rental-name','[data-testid="time-slot"]',60,'2030-01-12')).toBe(true);
    } finally {await browser.close();}
  },30000);
  it.each(['open','occupied','incomplete'] as const)('independently replays %s inventory without a variant or model',async mode=>{
    const endpoint='https://app.squareup.com/appointments/api/buyer/availability';
    const request={search_availability_request:{query:{filter:{location_id:'LOC1234567890',start_at_range:{start_at:'2030-01-11T00:00:00Z',end_at:'2030-01-12T00:00:00Z'},segment_filters:[{service_variation_id:'B'.repeat(24),team_member_id_filter:{any:['public-staff']}}]}}}};
    const start=Date.parse('2030-01-11T16:30:00Z')/1000;
    const response={staff_ids:['public-staff'],resources:{},availability:[{start,end:start+3600,available:mode!=='occupied',staff_id:'public-staff',segments:[{start,end:start+3600,resource_token:null,employee_token:null}]}]};
    const inventory=calendar(label).replace('4:30 PM',mode==='occupied'?'': '4:30 PM').replace('<market-button type="button" role="listitem" data-testid="time-slot"></market-button>','No availability')
      .replace('</section>',`<p id="empty">${mode==='occupied'}</p></section>`)+
      '<h1 id="venue">Public golf fixture</h1><p id="date">2030-01-11</p>';
    let shell=html().replace(JSON.stringify(calendar(label)),JSON.stringify(inventory));
    shell=shell.replace(`document.body.innerHTML=${JSON.stringify(inventory)}`,`document.body.innerHTML=${JSON.stringify(inventory)};fetch(${JSON.stringify(endpoint)},{method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(JSON.stringify(request))}}).then(r=>r.json()).then(()=>document.body.insertAdjacentHTML('beforeend','<p id="loaded">true</p>'))`);
    let reads=0;
    const fetcher:typeof fetch=async url=>{if(String(url)===source)return new Response(shell,{headers:{'content-type':'text/html'}});if(String(url)!==endpoint)throw Error('UNEXPECTED_FIXTURE_READ');reads++;return new Response(JSON.stringify(mode==='incomplete'?{availability:response.availability}:response),{headers:{'content-type':'application/json','access-control-allow-origin':'https://book.squareup.com','access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type'}});};
    const recipe=parseAccessRecipe({schemaVersion:1,engine:'BROWSER_DOM',target:{kind:'SIMULATOR',courseId:'fixture-course',offeringId:'fixture-offering'},source:{venueName:'Public golf fixture',officialUrl:source,bookingUrl:catalog,timeZone:'UTC',providerFamily:'SQUARE'},pageUrl:source,
      permittedRoutes:[{origin:'https://book.squareup.com',path:new URL(source).pathname,methods:['GET'],queryKeys:[]},{origin:'https://book.squareup.com',path:new URL(catalog).pathname,methods:['GET'],queryKeys:[]},{origin:'https://book.squareup.com',path:new URL(catalog.replace(/services$/u,'availability')).pathname,methods:['GET'],queryKeys:[]},{origin:'https://app.squareup.com',path:new URL(endpoint).pathname,methods:['POST'],queryKeys:[]}],
      availabilityResponse:{kind:'SQUARE_PUBLIC_MONTH',url:endpoint,method:'POST',date:{source:'JSON_BODY',path:'search_availability_request.query.filter.start_at_range.start_at',format:'SQUARE_PUBLIC_MONTH_RANGE'},endDatePath:'search_availability_request.query.filter.start_at_range.end_at'},
      steps:[{action:'selectProduct',productSelector:'section[aria-label="Main content"]',selector:'#add button'},{action:'continueToAvailability',selector:'#next button',mode:'SQUARE_SERVICE'},{action:'waitFor',selector:'#loaded'}],
      proof:{venue:{selector:'#venue'},date:{selector:'#date'},complete:{availabilityResponse:true},empty:{selector:'#empty'}},slots:{scope:{selector:'[data-testid="availability-page"]',label:{selector:'.rental-name'},expectedLabel:label},collection:{selector:'[data-testid="time-slot"]'},startsAt:{selector:':scope'},endsAt:{derive:'ADD_REQUESTED_DURATION'}}});
    if (mode==='open') {
      expect(recipeResourceScopeSchema.safeParse(recipe.slots.scope).success).toBe(false);
      expect(()=>parseAccessRecipe({...recipe,source:{...recipe.source,providerFamily:'OTHER'}})).toThrow();
      expect(()=>parseAccessRecipe({...recipe,pageUrl:source.replace('publicfixture','foreignfixture')})).toThrow();
      expect(()=>parseAccessRecipe({...recipe,steps:recipe.steps.filter(step=>step.action!=='selectProduct')})).toThrow();
      expect(()=>parseAccessRecipe({...recipe,availabilityResponse:{...recipe.availabilityResponse,kind:'JSON'}})).toThrow();
    }
    const result=await executeAccessRecipe(recipe,{date:'2030-01-11',timeZone:'UTC',players:4,durationMinutes:60,startTime:'09:00',endTime:'20:00'},{fetch:fetcher,launchBrowser:()=>chromium.launch({headless:true}),requestLease:async(_family,work)=>({acquired:true,value:await work()})});
    expect(result,JSON.stringify(result)).toMatchObject({status:mode==='open'?'AVAILABLE':mode==='occupied'?'EMPTY':'INCOMPLETE',complete:mode!=='incomplete'});
    expect(result.slots).toHaveLength(mode==='open'?1:0);expect(reads).toBe(1);
  },75000);
});
