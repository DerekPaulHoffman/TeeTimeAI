// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectNativeOfficialPublicMetadata } from "./public-document-metadata";

it("captures a literal named semantic address/tel block independently of marketing headings and site-title classes",()=>{
 setup('<h1>A championship experience</h1><footer><div><h5>Contact Us</h5><p>'+venue+'</p><a href="https://maps.example/"><address>10 Example Road, Example, New York.12345</address></a><p>Telephone: <a href="tel:+19165554653">916-555-4653</a></p></div></footer>');
 const got=collectNativeOfficialPublicMetadata(venue);
 expect(got.namedContactBlocksOmitted).toBe(false);
 expect(got.namedContactBlocks).toEqual([{name:venue,addressText:"10 Example Road, Example, New York.12345",phones:[{href:"tel:+19165554653",text:"916-555-4653"}]}]);
 expect(got.brandLinks).toEqual([]);
});
it.each(["hiddenName","hiddenAddress","hiddenPhone","mailing","form","input"])("does not grant named physical contact from %s metadata",which=>{
 let markup='<div><h5>Contact Us</h5><p>'+venue+'</p><address>10 Example Road, Example, New York.12345</address><a href="tel:+19165554653">916-555-4653</a></div>';
 if(which==="hiddenName")markup=markup.replace("<p>","<p hidden>");
 if(which==="hiddenAddress")markup=markup.replace("<address>","<address style=\"display:none\">");
 if(which==="hiddenPhone")markup=markup.replace('<a href="tel:','<a hidden href="tel:');
 if(which==="mailing")markup=markup.replace("Contact Us","Mailing Address");
 if(which==="form")markup="<form>"+markup+"</form>";
 if(which==="input")markup=markup.replace("</div>",'<input value="PRIVATE"></div>');
 setup(markup);const got=collectNativeOfficialPublicMetadata(venue);
 expect(got.namedContactBlocks).toEqual([]);expect(JSON.stringify(got.namedContactBlocks)).not.toContain("PRIVATE");
});

const venue="Example Golf Studio",address="10 Example Road, Example, New York 12345",rental="Public Simulator Rental — per bay Up to 3 golfers";
const html=()=>`<form method="post" action="${document.URL}"><input type="hidden" value="PRIVATE"><h2>${venue}</h2><p>${address}</p><p>${rental}</p><a href="https://booking.example/">Book public rental</a><footer>Public address</footer></form>`;
function setup(markup:string){document.body.innerHTML=markup;vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockImplementation(()=>({width:10,height:10,x:0,y:0,top:0,right:10,bottom:10,left:0,toJSON:()=>({})}));Object.defineProperty(HTMLElement.prototype,"innerText",{configurable:true,get(){return this.textContent??"";}});}
afterEach(()=>{vi.restoreAllMocks();document.body.innerHTML="";});
it("actual installed tsx serialization runs in a separate page-like VM without module helpers",()=>{
 const moduleUrl=pathToFileURL(resolve("src/lib/course-discovery/public-document-metadata.ts")).href;
 const script=`import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {runInNewContext} from 'node:vm';const {collectNativeOfficialPublicMetadata:collect}=createRequire(process.cwd()+'/package.json')(fileURLToPath(${JSON.stringify(moduleUrl)}));const result=runInNewContext('('+collect.toString()+')('+JSON.stringify('Example Golf Studio')+')',{document:{forms:[],querySelectorAll:()=>[],title:''}});if(result.headings.length||result.addressTexts.length)throw Error('INVALID');console.log('SERIALIZATION_OK');`;
 const result=spawnSync(process.execPath,["--import",pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href,"--input-type=module","--eval",script],{encoding:"utf8",timeout:10000});
 expect(result.status,result.stderr).toBe(0);expect(result.stdout.trim()).toBe("SERIALIZATION_OK");
});
it("reads static exact-venue H2 public metadata in the unique whole-document wrapper without field values",()=>{setup(html());const got=collectNativeOfficialPublicMetadata(venue);expect(got.headings).toContain(venue);expect(got.addressTexts).toContain(address);expect(got.publicRentalTexts).toContain(rental);expect(JSON.stringify(got)).not.toContain("PRIVATE");});
it.each(["foreign","hidden","login","nested","nofooter","get","foreignaction","multiple"])("rejects %s wrapper admission",mode=>{let markup=html();if(mode==="foreign")markup=markup.replace(venue,"Foreign Golf Studio");if(mode==="hidden")markup=markup.replace("<h2>","<h2 hidden>");if(mode==="login")markup=markup.replace('<form ', '<form class="login" ');if(mode==="nested")markup='<div>'+markup+'</div>';if(mode==="nofooter")markup=markup.replaceAll("footer","section");if(mode==="get")markup=markup.replace('method="post"','method="get"');if(mode==="foreignaction")markup=markup.replace(`action="${document.URL}"`,'action="https://foreign.example/"');if(mode==="multiple")markup+='<form></form>';setup(markup);const got=collectNativeOfficialPublicMetadata(venue);expect(got.addressTexts).not.toContain(address);expect(got.publicRentalTexts).not.toContain(rental);});
it("control values, labels and transaction subtrees cannot become static party evidence",()=>{setup(html().replace(`<p>${rental}</p>`,`<label>${rental}</label><p><input value="${rental}"></p><section class="checkout"><p>${rental}</p></section>`));const got=collectNativeOfficialPublicMetadata(venue);expect(got.publicRentalTexts).toEqual([]);});
it("retains only bounded computed-visible standalone public service labels for an exact combined-business remainder",()=>{
 setup('<nav><a href="#grille">Grille Restaurant</a><a href="#bad">Restaurantish</a><a hidden href="#hidden">Restaurant Hidden</a><a href="#large">one two three four five six seven eight Restaurant</a></nav><form><a href="#form">Restaurant Form</a></form><div class="checkout"><a href="#private">Restaurant Private</a></div>');
 expect(collectNativeOfficialPublicMetadata("Harbor Golf Club and Restaurant").publicBusinessLabels).toEqual(["Grille Restaurant"]);
 expect(collectNativeOfficialPublicMetadata("Harbor Golf Club").publicBusinessLabels).toEqual([]);
});
it("captures bounded parent iframe src facts without child URLs or a srcdoc/form visibility waiver",()=>{
 setup('<iframe src="https://one.example/"></iframe><iframe src="https://two.example/" srcdoc=""></iframe><form><iframe src="https://three.example/"></iframe></form><section hidden><iframe src="https://four.example/"></iframe></section>');
 const got=collectNativeOfficialPublicMetadata(venue).delegatedFrameSources;
 expect(got.omitted).toBe(false);expect(got.rows).toEqual([
  {src:"https://one.example/",visible:true,srcdoc:false,inForm:false},
  {src:"https://two.example/",visible:true,srcdoc:true,inForm:false},
  {src:"https://three.example/",visible:true,srcdoc:false,inForm:true},
  {src:"https://four.example/",visible:false,srcdoc:false,inForm:false}]);
 setup('<iframe src="https://one.example/"></iframe>'.repeat(25));
 expect(collectNativeOfficialPublicMetadata(venue).delegatedFrameSources).toEqual({rows:[],omitted:true});
});
