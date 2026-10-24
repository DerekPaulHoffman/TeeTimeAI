// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { bindCpsPostalConflictProof, normalizeCanonicalCoursePhone } from "./cps-postal-conflict-proof";
import { readNativeOfficialIdentityPage } from "./native-official-page-reader";
import type { OfficialIdentityPage } from "./teeitup-official-identity";
import { normalizePublicCourseContactPhone, type PublicCourseContactBlock } from "./public-course-contact-blocks";
import { parseCpsCatalog } from "./cps-source";
import { parseAccessRecipe } from "./recipe";

const source={officialUrl:"https://old-official.example/golf",bookingUrl:"https://harbor.cps.golf/onlineresweb/search-teetime?TeeOffTimeMin=0&TeeOffTimeMax=23.999722222222225",venueName:"Harbor Pointe Golf Course",venueAddress:"10 Harbor Dr, Example, NY 12345, USA",timeZone:"America/New_York"};
const contact:PublicCourseContactBlock={venueName:source.venueName,street:"10 Harbor Drive",locality:"Example",region:"NY",postalCode:"54321",country:"US",phone:"(916) 555-4653"};
const catalog={tenant:"harbor",courseIds:[7],catalogHash:"a".repeat(64)};
function card(value:Partial<PublicCourseContactBlock>={},attribute=""){
  const c={...contact,...value};return `<li class="widgetItem h-card" ${attribute}><h4 class="widgetTitle field p-name">${c.venueName}</h4><div class="field h-adr"><strong>Physical Address</strong><button>View Map</button><br><span class="p-street-address">${c.street}</span><br><span class="locality">${c.locality}</span>, <span class="p-region">${c.region}</span> <span class="p-postal-code">${c.postalCode}</span><span class="p-country-name">${c.country}</span></div><div class="field p-tel"><a href="tel:${c.phone.replace(/\D/gu,"")}">${c.phone}</a></div></li>`;
}
const html=(cards=card())=>`<html><head><title>Public municipal golf</title></head><body><h1>Harbor</h1><a href="${source.bookingUrl}">Book a Tee Time</a><ol>${cards}</ol></body></html>`;
async function freshPage(markup=html(),blocks:PublicCourseContactBlock[]=[contact]){
  const destination="https://new-official.example/golf";
  const page:OfficialIdentityPage={url:destination,html:markup,browserTransport:"NATIVE_CHROME",visibleEvidence:{title:"Public municipal golf",headings:["Harbor"],addressTexts:["10 Harbor Drive, Example, NY 54321"],linkUrls:[source.bookingUrl],publicContactBlocks:blocks}};
  return readNativeOfficialIdentityPage(source,source.officialUrl,new Date(Date.now()+30_000),{createSession:async()=>({execute:async()=>({url:destination,navigationStatus:200,browserTransport:"NATIVE_CHROME",nativeDocumentRedirects:[{fromUrl:source.officialUrl,toUrl:destination,status:301,completed:true}],officialSourceDiagnostic:{stage:"CONTROLLER_CAPTURE",rawOfficialCaptured:true,currentOfficialDocument:true,officialProvenance:true,renderedAddressesPresent:true,renderedLinksPresent:true}} as never),readOfficialIdentityPage:async()=>page,close:async()=>{}})});
}
const bind=(page:OfficialIdentityPage,phone:unknown="+19165554653")=>bindCpsPostalConflictProof(source,page,phone,catalog,source.venueName);
describe("CPS native physical contact postal corroboration",()=>{
  it("accepts the observed physical p-tel Phone: label without changing canonical phone validation or semantic proof",async()=>{
    const printed="303-469-2974", labeled=`Phone: ${printed}`, observed={...contact,phone:printed};
    const plain=await freshPage(html(card({phone:printed})),[observed]);
    const markup=html(card({phone:printed})).replace('<div class="field p-tel">','<div class="field p-tel">Phone: ');
    expect(markup).toContain('<div class="field p-tel">Phone: <a href="tel:3034692974">303-469-2974</a></div>');
    const page=await freshPage(markup,[{...observed,phone:labeled}]);
    expect(bind(page,"+13034692974")).toEqual(bind(plain,"+13034692974"));
    expect(normalizePublicCourseContactPhone(labeled)).toBe("+13034692974");
    expect(normalizeCanonicalCoursePhone(labeled)).toBeUndefined();
    expect(()=>bind(page,labeled)).toThrow("CPS_POSTAL_CONFLICT_UNVERIFIED");
    expect(()=>bind(page,"+13034692975")).toThrow("CPS_POSTAL_CONFLICT_UNVERIFIED");
    const wrongHref=await freshPage(markup.replace("tel:3034692974","tel:3034692975"),[{...observed,phone:labeled}]);
    expect(()=>bind(wrongHref,"+13034692974")).toThrow("CPS_POSTAL_CONFLICT_UNVERIFIED");
  });
  it.each(["Fax: 303-469-2974","phone: 303-469-2974","Telephone: 303-469-2974","Phone: Phone: 303-469-2974","Phone: 303-469-2974 ext 2","Phone: 303-469-2974 / 303-469-2975","Phone: 1303-469-2974 2","Phone:303-469-2974"])("rejects nonexact or additional observed phone content %s",async phone=>{
    expect(normalizePublicCourseContactPhone(phone)).toBeUndefined();
    const page=await freshPage(html(card({phone})),[{...contact,phone}]);
    expect(()=>bind(page,"+13034692974")).toThrow("CPS_POSTAL_CONFLICT_UNVERIFIED");
  });
  it("rejects labeled fields hidden or duplicated in raw markup, and raw/rendered phone disagreement",async()=>{
    const phone="Phone: 303-469-2974",labeled={...contact,phone};
    const markup=html(card({phone:"303-469-2974"})).replace('<div class="field p-tel">','<div class="field p-tel">Phone: ');
    for(const invalid of [markup.replace('class="field p-tel"','class="field p-tel" hidden'),markup.replace('</li>','<div class="p-tel">Phone: 303-469-2974</div></li>')]){
      const page=await freshPage(invalid,[labeled]);expect(()=>bind(page,"+13034692974")).toThrow();
    }
    const page=await freshPage(markup,[{...labeled,phone:"Phone: 303-469-2975"}]);expect(()=>bind(page,"+13034692974")).toThrow();
  });
  it("uses exact named physical contact blocks and preserves canonical ZIP plus explicit observed discrepancy",async()=>{
    const unrelated=card({venueName:"Another Golf Course",street:"500 Other Road",phone:"303-555-1234"});
    const page=await freshPage(html(unrelated+card()+card()),[contact,contact]);const proof=bind(page);
    expect(proof).toMatchObject({kind:"CANONICAL_PHONE_POSTAL_CONFLICT",officialUrl:source.officialUrl,officialPageUrl:page.url,bookingUrl:source.bookingUrl,canonicalAddress:source.venueAddress,officialAddress:"10 Harbor Drive, Example, NY 54321, USA",canonicalPostalCode:"12345",officialPostalCode:"54321",canonicalCoursePhone:"+19165554653",courseIds:[7],catalogHash:catalog.catalogHash,warmTransport:"NATIVE_CHROME",requiredCapability:"LOCAL_CHROME"});
    expect(normalizeCanonicalCoursePhone("(916) 555-4653")).toBe(proof.canonicalCoursePhone);
  });
  it.each([{street:"11 Harbor Drive"},{locality:"Another City"},{region:"CA"},{country:"CA"},{venueName:"Harbor Ridge Golf Course"},{phone:"916-555-9999"}])("rejects changed physical/venue/phone identity %j",async change=>{
    const changed={...contact,...change},page=await freshPage(html(card(change)),[changed]);expect(()=>bind(page)).toThrow("CPS_POSTAL_CONFLICT_UNVERIFIED");
  });
  it("rejects missing/wrong durable phone, conflicting same-venue blocks and raw/rendered contradictions",async()=>{
    const page=await freshPage();for(const phone of [undefined,"", "+19165559999"])expect(()=>bindCpsPostalConflictProof(source,page,phone,catalog,source.venueName)).toThrow();
    expect(()=>bindCpsPostalConflictProof({...source,venueAddress:"10 Harbor Drive, Example, NY 54321, USA"},page,"+19165554653",catalog,source.venueName)).toThrow();
    expect(()=>bind(awaitedCopy(page))).toThrow();
    const conflict=await freshPage(html(card()+card({phone:"916-555-9999"})),[contact,{...contact,phone:"916-555-9999"}]);expect(()=>bind(conflict)).toThrow();
    const changed=await freshPage(html(),[{...contact,street:"11 Harbor Drive"}]);expect(()=>bind(changed)).toThrow();
  });
  it.each(["hidden","mailing","hidden phone","wrong dial target","hidden booking","missing contact"])("rejects %s source markup even with supplied matching visible fields",async mode=>{
    let markup=html();if(mode==="hidden")markup=html(card({},"hidden"));if(mode==="mailing")markup=html(`<section><h2>Mailing Address</h2>${card()}</section>`);if(mode==="hidden phone")markup=markup.replace('class="field p-tel"','class="field p-tel" style="opacity:0"');if(mode==="wrong dial target")markup=markup.replace("tel:9165554653","tel:9165559999");if(mode==="hidden booking")markup=markup.replace('<a href="'+source.bookingUrl+'">','<a hidden href="'+source.bookingUrl+'">');if(mode==="missing contact")markup=html("");const page=await freshPage(markup);expect(()=>bind(page)).toThrow();
  });
  it("requires the same fresh native page object, original bytes and exact canonical source root",async()=>{
    const page=await freshPage();expect(()=>bind(structuredClone(page))).toThrow();
    expect(()=>bindCpsPostalConflictProof({...source,officialUrl:"https://unrelated.example/"},page,"+19165554653",catalog,source.venueName)).toThrow();
    page.html=html(card({phone:"916-555-9999"}));expect(()=>bind(page)).toThrow();
    const stale=await freshPage();vi.useFakeTimers();try{vi.setSystemTime(Date.now()+31_000);expect(()=>bind(stale)).toThrow();}finally{vi.useRealTimers();}
  });
  it("hashes semantic contact identity consistently across fresh nonces and unrelated ancillary markup",async()=>{
    const first=bind(await freshPage());
    const second=bind(await freshPage(html().replace("<body>",'<body><script nonce="different-runtime-nonce">var time=123;</script><div id="ancillary-987">Weather changed</div>')));
    expect(second).toEqual(first);
  });
  it("binds serialized proof to every canonical recipe source field and requires the native capability declaration",async()=>{
    const proof=bind(await freshPage());
    const recipe={schemaVersion:1,engine:"EXISTING_ADAPTER",target:{courseId:"course-1",kind:"OUTDOOR"},source:{...source,providerFamily:"CPS"},adapter:{family:"CPS",...catalog,officialPostalConflictProof:proof}};
    expect(parseAccessRecipe(recipe).engine).toBe("EXISTING_ADAPTER");
    for(const changed of [{officialUrl:"https://another.example/"},{bookingUrl:"https://other.cps.golf/"},{venueAddress:"11 Harbor Dr, Example, NY 12345, USA"},{venueName:"Other Golf Course"},{timeZone:"America/Denver"}])
      expect(()=>parseAccessRecipe({...recipe,source:{...recipe.source,...changed}})).toThrow();
    expect(()=>parseAccessRecipe({...recipe,adapter:{...recipe.adapter,officialPostalConflictProof:{...proof,requiredCapability:"SERVER_HTTP"}}})).toThrow();
    expect(()=>parseAccessRecipe({...recipe,adapter:{...recipe.adapter,courseIds:[8]}})).toThrow();
  });
  it("only selects one exact full-base provider label and matching option ID after fresh independent phone/contact corroboration",async()=>{
    const rows=[{courseId:1,courseName:"Another Golf Course",timezoneId:source.timeZone,websiteId:"public-site",active:true as const,holes:18 as const},
      {courseId:7,courseName:"Harbor Pointe",timezoneId:source.timeZone,websiteId:"public-site",active:true as const,holes:18 as const}];
    const options={webSiteId:"public-site",reservationOptions:{terminalId:3},courseOptions:rows.map(row=>({courseId:row.courseId,courseName:row.courseName,webSiteId:row.websiteId}))};
    const page=await freshPage();let selectedLabel="";
    const context={page,canonicalCoursePhone:"+19165554653",onSelectedLabel:(label:string)=>{selectedLabel=label;}};
    const metadata=parseCpsCatalog(rows,options,source,context);
    expect(metadata.courseIds).toEqual([7]);expect(selectedLabel).toBe("Harbor Pointe");
    expect(()=>parseCpsCatalog(rows,options,source)).toThrow("ADAPTER_IDENTITY_MISMATCH");
    expect(()=>parseCpsCatalog(rows,options,source,{...context,page:structuredClone(page)})).toThrow("CPS_POSTAL_CONFLICT_UNVERIFIED");
    const unrelatedChange=rows.map(row=>row.courseId===1?{...row,courseName:"Other Ridge Golf Course"}:row);
    const changedOptions={...options,courseOptions:unrelatedChange.map(row=>({courseId:row.courseId,courseName:row.courseName,webSiteId:row.websiteId}))};
    expect(parseCpsCatalog(unrelatedChange,changedOptions,source,context).catalogHash).not.toBe(metadata.catalogHash);
    for(const altered of [rows.map(row=>row.courseId===7?{...row,courseName:"Harbor Pointe East"}:row),[...rows,{...rows[1],courseId:8}],rows.map(row=>row.courseId===7?{...row,timezoneId:"America/Denver"}:row)]){
      const declared={...options,courseOptions:altered.map(row=>({courseId:row.courseId,courseName:row.courseName,webSiteId:row.websiteId}))};
      expect(()=>parseCpsCatalog(altered,declared,source,context)).toThrow();
    }
  });
});
function awaitedCopy(page:OfficialIdentityPage){return JSON.parse(JSON.stringify(page)) as OfficialIdentityPage;}
