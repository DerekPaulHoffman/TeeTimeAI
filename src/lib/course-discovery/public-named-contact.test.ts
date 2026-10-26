import { afterEach, describe, expect, it, vi } from "vitest";
import { readNamedPublicContacts, parseNamedContactAddress } from "./public-named-contact";
import { deriveNativePhysicalContactSource, bindTeeItUpPhysicalContactFacility, teeItUpPhysicalContactProofSchema } from "./teeitup-physical-contact-proof";
import { registerFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
import type { OfficialIdentityPage } from "./teeitup-official-identity";
const source={officialUrl:"https://ordinary.example/",bookingUrl:"https://ordinary.book.teeitup.com/",venueName:"Example Golf",venueAddress:"10 N Example Road, Example, FL 12345-6789, USA",timeZone:"America/New_York"};
const phone="+19165554653",address="10 N Example Road, Example, Florida.12345-6789";
const card=(a=address)=>'<div><h5>Contact Us</h5><p>'+source.venueName+'</p><a href="https://maps.example/"><address>'+a+'</address></a><p>Telephone: <a href="tel:'+phone+'">916-555-4653</a></p></div>';
const html=()=>'<title>Example Golf | Regional Marketing</title><h1>A championship experience</h1>'+card()+'<a href="'+source.bookingUrl+'">Book Tee Times</a>';
function page(markup=html(),visibleChange:Partial<NonNullable<OfficialIdentityPage["visibleEvidence"]>>={}){
 const p:OfficialIdentityPage={url:source.officialUrl,browserTransport:"NATIVE_CHROME",html:markup,visibleEvidence:{title:"Example Golf | Regional Marketing",headings:["A championship experience"],addressTexts:[address],phoneTexts:["916-555-4653"],brandLinks:[],linkUrls:[source.bookingUrl],namedContactBlocks:readNamedPublicContacts(markup,source.venueName),namedContactBlocksOmitted:false,...visibleChange}};
 return registerFreshNativeOfficialIdentityPage(p,source.officialUrl,new Date(Date.now()+30000),{requestedUrl:source.officialUrl,redirects:[]});
}
afterEach(()=>vi.useRealTimers());
describe("fresh literal title and named semantic address/phone contact",()=>{
 it("requires no marketing H1 or WordPress brand class and preserves all semantic identity data",()=>{
  const contact=deriveNativePhysicalContactSource(source,page(),phone);
  expect(contact).toMatchObject({canonicalName:source.venueName,officialBrandName:source.venueName,publicLocationName:source.venueName,canonicalNameRelation:"EXACT_PUBLIC_LOCATION_NAME",officialAddress:address,publicCoursePhone:phone});
  const directory=[{id:11,courseId:"11",name:source.venueName,address:source.venueAddress,timeZone:source.timeZone,country:"US",isSimulator:false,phone}];
  const bound=bindTeeItUpPhysicalContactFacility(source,contact,directory);
  expect(teeItUpPhysicalContactProofSchema.parse(JSON.parse(JSON.stringify(bound.physicalContactProof)))).toEqual(bound.physicalContactProof);
  expect(()=>bindTeeItUpPhysicalContactFacility(source,contact,[directory[0],{...directory[0],id:12,courseId:"12"}])).toThrow();
  for(const change of [{phone:"+19165554654"},{address:source.venueAddress.replace("10 N","11 N")},{address:source.venueAddress.replace("12345-6789","12345")},{timeZone:"America/Chicago"},{name:"Other Golf"},{country:"CA"}])
   expect(()=>bindTeeItUpPhysicalContactFacility(source,contact,[{...directory[0],...change}])).toThrow();
 });
 it.each(["number","street","direction","unit","city","state","zip","zipExtension","country","phone","href","title","name","missingAddress","mailing","form","hiddenPhone","secondPhysical"])
 ("rejects observed %s conflicts without borrowing another visible scalar",change=>{
  let value=html();
  if(change==="number")value=value.replace("10 N","11 N");if(change==="street")value=value.replace("Example Road","Other Road");
  if(change==="direction")value=value.replace("10 N","10 S");if(change==="unit")value=value.replace("Road,","Road Unit 2,");
  if(change==="city")value=value.replace("Road, Example","Road, Other");if(change==="state")value=value.replace("Florida.","Georgia.");
  if(change==="zip")value=value.replace("12345-6789","12346-6789");if(change==="zipExtension")value=value.replace("12345-6789","12345");
  if(change==="country")value=value.replace("Florida.12345-6789","Florida.12345-6789, Canada");
  if(change==="phone")value=value.replace(">916-555-4653<",">916-555-4654<");if(change==="href")value=value.replace("tel:"+phone,"tel:+19165554654");
  if(change==="title")value=value.replace("<title>Example Golf","<title>Other Golf");if(change==="name")value=value.replace("<p>Example Golf","<p>Other Golf");
  if(change==="missingAddress")value=value.replaceAll("address","span");if(change==="mailing")value=value.replace("Contact Us","Mailing Address");
  if(change==="form")value=value.replace("<div>","<form><div>").replace("</div>","</div></form>");
  if(change==="hiddenPhone")value=value.replace('<a href="tel:','<a hidden href="tel:');
  if(change==="secondPhysical")value+=card(address.replace("10 N","11 N"));
  expect(()=>deriveNativePhysicalContactSource(source,page(value),phone)).toThrow();
 });
 it.each(["title","contact","address","phone","href","booking","omitted"])("requires actual matching computed-visible %s evidence",which=>{
  const visible=page().visibleEvidence!;const change:Partial<typeof visible>={};
  if(which==="title")change.title="Other";
  if(which==="contact")change.namedContactBlocks=[];
  if(which==="address")change.namedContactBlocks=[{...visible.namedContactBlocks![0],addressText:address.replace("10 N","11 N")}];
  if(which==="phone")change.namedContactBlocks=[{...visible.namedContactBlocks![0],phones:[{href:"tel:"+phone,text:"916-555-4654"}]}];
  if(which==="href")change.namedContactBlocks=[{...visible.namedContactBlocks![0],phones:[{href:"tel:+19165554654",text:"916-555-4653"}]}];
  if(which==="booking")change.linkUrls=[];
  if(which==="omitted")change.namedContactBlocksOmitted=true;
  expect(()=>deriveNativePhysicalContactSource(source,page(html(),change),phone)).toThrow();
 });
 it("rejects copied, foreign and stale native data; serialized JSON cannot mint a native witness",()=>{
  const p=page();expect(()=>deriveNativePhysicalContactSource(source,JSON.parse(JSON.stringify(p)),phone)).toThrow();
  expect(()=>deriveNativePhysicalContactSource({...source,officialUrl:"https://foreign.example/"},p,phone)).toThrow();
  vi.useFakeTimers();vi.setSystemTime(Date.now()+31000);expect(()=>deriveNativePhysicalContactSource(source,p,phone)).toThrow();
 });
 it("normalizes only an observed known US state/postal separator, without supplying missing parts",()=>{
  expect(parseNamedContactAddress(address)).toEqual(parseNamedContactAddress(source.venueAddress));
  for(const v of ["Example, Florida.12345","10 N Example Road, Florida.12345","10 N Example Road, Example, Imaginary.12345","10 N Example Road, Example, Florida.","10 N Example Road, Example, Florida.12345, Canada"])
   expect(parseNamedContactAddress(v)).toBeNull();
 });
});
