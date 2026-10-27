// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://official.example/"}
import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectNativeOfficialPublicMetadata } from "./public-document-metadata";

it("collects all six visible semantic heading levels without promoting hidden, inert or form headings",()=>{
 const visible=Array.from({length:6},(_,i)=>`<h${i+1}>Public heading ${i+1}</h${i+1}>`).join("");
 setup(visible+'<h4 hidden>Hidden venue</h4><section inert><h4>Inert venue</h4></section><form><h4>Form venue</h4></form><section style="display:none"><h4>CSS-hidden venue</h4></section>');
 expect(collectNativeOfficialPublicMetadata(venue).headings).toEqual(Array.from({length:6},(_,i)=>`Public heading ${i+1}`));
});

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
afterEach(()=>{vi.restoreAllMocks();document.body.innerHTML="";window.history.replaceState(null,"",location.origin+"/");});
it("actual installed tsx serialization runs in a separate page-like VM without module helpers",()=>{
 const moduleUrl=pathToFileURL(resolve("src/lib/course-discovery/public-document-metadata.ts")).href;
 const script=`import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {runInNewContext} from 'node:vm';const {collectNativeOfficialPublicMetadata:collect}=createRequire(process.cwd()+'/package.json')(fileURLToPath(${JSON.stringify(moduleUrl)}));const result=runInNewContext('('+collect.toString()+')('+JSON.stringify('Example Golf Studio')+')',{document:{forms:[],querySelectorAll:()=>[],title:''}});if(result.headings.length||result.addressTexts.length)throw Error('INVALID');console.log('SERIALIZATION_OK');`;
 const result=spawnSync(process.execPath,["--import",pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href,"--input-type=module","--eval",script],{encoding:"utf8",timeout:10000});
 expect(result.status,result.stderr).toBe(0);expect(result.stdout.trim()).toBe("SERIALIZATION_OK");
});
it("reads static exact-venue H2 public metadata in the unique whole-document wrapper without field values",()=>{setup(html());const got=collectNativeOfficialPublicMetadata(venue);expect(got.headings).toContain(venue);expect(got.addressTexts).toContain(address);expect(got.publicRentalTexts).toContain(rental);expect(JSON.stringify(got)).not.toContain("PRIVATE");});
it.each([["//","/"],["/","https://official.example//"]])("reads only static metadata for an HTTPS root form action %s → %s without rewriting either URL",(path,action)=>{
 window.history.replaceState(null,"",location.origin+path);const current=document.URL;
 setup(html().replace(`action="${current}"`,`action="${action}"`));const form=document.forms[0],literal=form.getAttribute("action"),got=collectNativeOfficialPublicMetadata(venue);
 expect(got.headings).toContain(venue);expect(got.addressTexts).toContain(address);expect(got.linkUrls).toContain("https://booking.example/");expect(got.publicRentalTexts).toContain(rental);
 expect(document.URL).toBe(current);expect(form.getAttribute("action")).toBe(literal);expect(JSON.stringify(got)).not.toContain("PRIVATE");
});
it.each([
 ["//","/booking"],["/booking//","/booking/"],["///","/"],["//?view=public","/?view=public"],["//#public","/#public"],
 ["//","/?view=public"],["//","/#public"],["//","https://foreign.example/"],["//","https://user:pass@official.example/"],["//","http://official.example/"],
])("does not turn root equivalence into path/query/hash/origin/credential permission: %s → %s",(path,action)=>{
 window.history.replaceState(null,"",location.origin+path);setup(html().replace(`action="${document.URL}"`,`action="${action}"`));const got=collectNativeOfficialPublicMetadata(venue);
 expect(got.headings).not.toContain(venue);expect(got.addressTexts).not.toContain(address);expect(got.linkUrls).toEqual([]);expect(got.publicRentalTexts).toEqual([]);
});
it("retains legacy exact non-root self-actions without extending equivalence to them",()=>{
 window.history.replaceState(null,"",location.origin+"/public?view=one#section");setup(html());expect(collectNativeOfficialPublicMetadata(venue).addressTexts).toContain(address);
});
it.each(["foreign","hidden","login","nested","nofooter","get","multiple","control","private"])("root equivalence preserves the %s rejection",mode=>{
 window.history.replaceState(null,"",location.origin+"//");let markup=html().replace(`action="${document.URL}"`,'action="/"');
 if(mode==="foreign")markup=markup.replace(venue,"Foreign Golf Studio");if(mode==="hidden")markup=markup.replace("<h2>","<h2 hidden>");if(mode==="login")markup=markup.replace('<form ', '<form class="login" ');
 if(mode==="nested")markup="<div>"+markup+"</div>";if(mode==="nofooter")markup=markup.replaceAll("footer","section");if(mode==="get")markup=markup.replace('method="post"','method="get"');if(mode==="multiple")markup+="<form></form>";
 if(mode==="control")markup=markup.replace(`<p>${rental}</p>`,`<p>${rental}<input value="PRIVATE"></p>`);if(mode==="private")markup=markup.replace(`<p>${rental}</p>`,`<section class="checkout"><p>${rental}</p></section>`);
 setup(markup);const got=collectNativeOfficialPublicMetadata(venue);expect(got.publicRentalTexts).not.toContain(rental);expect(JSON.stringify(got)).not.toContain("PRIVATE");
});
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

const cmsContext={venueName:venue,venueAddress:"10 Example Rd C, Example, NY 12345, USA",canonicalCoursePhone:"+19165554653"};
const branchHtml=()=>`<form method="post" action="${document.URL}"><input type="hidden" value="PRIVATE"><a href="/"><img alt="${venue}" src="/logo.png"></a><h1>Example, NY</h1><div><p>916-555-4653</p> <p>10 Example Road, Suite C, Example, NY 12345</p> <a href="https://booking.example/location">Book this location</a></div><footer>Public contact</footer></form>`;
it("reads actual branch heading, root-logo alt and plain public phone only with trusted visible contact scope",()=>{
 setup(branchHtml());
 expect(collectNativeOfficialPublicMetadata(venue).headings).toEqual([]);
 const got=collectNativeOfficialPublicMetadata(cmsContext);
 expect(got.headings).toEqual(["Example, NY"]);
 expect(got.headings).not.toContain(venue);
 expect(got.brandLinks).toEqual([{href:location.origin+"/",text:venue}]);
 expect(got.phoneTexts).toContain("916-555-4653");
 expect(got.phoneTexts.every(v=>!v.startsWith("tel:"))).toBe(true);
 expect(got.addressTexts).toContain("10 Example Road, Suite C, Example, NY 12345");
 expect(got.linkUrls).toContain("https://booking.example/location");
 expect(got.namedContactBlocks).toEqual([]);expect(JSON.stringify(got)).not.toContain("PRIVATE");
});
it.each(["brand","phone","street","house","zip","hiddenLogo","hiddenPhone","hiddenAddress","privateContact","foreignRoot","nonRoot","rootQuery","rootHash","rootCredentials","onclick","download","duplicateLogo","get","foreignAction","noFooter","multiple","nested","contactControl"])("does not expose the branch CMS contact alternative for %s",mode=>{
 let markup=branchHtml();
 if(mode==="brand")markup=markup.replace(`alt="${venue}"`,'alt="Different Studio"');
 if(mode==="phone")markup=markup.replace("916-555-4653","916-555-4654");
 if(mode==="street")markup=markup.replace("10 Example Road","10 Other Road");
 if(mode==="house")markup=markup.replace("10 Example Road","11 Example Road");
 if(mode==="zip")markup=markup.replace("12345","54321");
 if(mode==="hiddenLogo")markup=markup.replace("<img ","<img hidden ");
 if(mode==="hiddenPhone")markup=markup.replace("<p>916","<p hidden>916");
 if(mode==="hiddenAddress")markup=markup.replace("<p>10","<p hidden>10");
 if(mode==="privateContact")markup=markup.replace("<div>",'<div class="billing">');
 if(mode==="foreignRoot")markup=markup.replace('href="/"','href="https://foreign.example/"');
 if(mode==="nonRoot")markup=markup.replace('href="/"','href="/other"');
 if(mode==="rootQuery")markup=markup.replace('href="/"','href="/?brand=public"');
 if(mode==="rootHash")markup=markup.replace('href="/"','href="/#brand"');
 if(mode==="rootCredentials")markup=markup.replace('href="/"','href="https://user:pass@official.example/"');
 if(mode==="onclick")markup=markup.replace('href="/"','href="/" onclick="go()"');
 if(mode==="download")markup=markup.replace('href="/"','href="/" download');
 if(mode==="duplicateLogo")markup=markup.replace('</a>',`<img alt="${venue}"></a>`);
 if(mode==="get")markup=markup.replace('method="post"','method="get"');
 if(mode==="foreignAction")markup=markup.replace(`action="${document.URL}"`,'action="https://foreign.example/"');
 if(mode==="noFooter")markup=markup.replaceAll("footer","section");
 if(mode==="multiple")markup+="<form></form>";
 if(mode==="nested")markup="<div>"+markup+"</div>";
 if(mode==="contactControl")markup=markup.replace("<div>",'<div><input value="PRIVATE">');
 setup(markup);const got=collectNativeOfficialPublicMetadata(cmsContext);
 expect(got.headings).toEqual([]);expect(got.phoneTexts).toEqual([]);expect(got.addressTexts).toEqual([]);expect(got.brandLinks).toEqual([]);
});
it("production tsx serialization exercises the trusted CMS path in an isolated page context",()=>{
 const moduleUrl=pathToFileURL(resolve("src/lib/course-discovery/public-document-metadata.ts")).href;
 const script=`import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {runInContext} from 'node:vm';const req=createRequire(process.cwd()+'/package.json');const {JSDOM}=req('jsdom');const {collectNativeOfficialPublicMetadata:collect}=req(fileURLToPath(${JSON.stringify(moduleUrl)}));const dom=new JSDOM(${JSON.stringify(branchHtml())},{url:'https://official.example/',runScripts:'outside-only'});Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent??'';}});dom.window.HTMLElement.prototype.getBoundingClientRect=function(){return {width:10,height:10};};const result=runInContext('('+collect.toString()+')('+${JSON.stringify(JSON.stringify(cmsContext))}+')',dom.getInternalVMContext());if(result.headings[0]!=='Example, NY'||result.brandLinks[0]?.text!==${JSON.stringify(venue)}||!result.phoneTexts.includes('916-555-4653'))throw Error('CMS_SERIALIZATION_INVALID');console.log('CMS_SERIALIZATION_OK');`;
 const result=spawnSync(process.execPath,["--import",pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href,"--input-type=module","--eval",script],{encoding:"utf8",timeout:10000});
 expect(result.status,result.stderr).toBe(0);expect(result.stdout.trim()).toBe("CMS_SERIALIZATION_OK");
});
it("keeps literal unit/contact facts without claiming complete identity or unit equivalence",()=>{
 setup(branchHtml().replace("Suite C","Suite D"));const got=collectNativeOfficialPublicMetadata(cmsContext);
 expect(got.addressTexts).toContain("10 Example Road, Suite D, Example, NY 12345");
 expect(JSON.stringify(got)).not.toMatch(/identityVerified|unitVerified|sourceVerified/u);
 setup(branchHtml());expect(collectNativeOfficialPublicMetadata({...cmsContext,canonicalCoursePhone:""}).headings).toEqual([]);
 expect(collectNativeOfficialPublicMetadata({...cmsContext,venueAddress:"Example, NY"}).headings).toEqual([]);
});
it("takes the postal ZIP after a five-digit street number rather than treating the house as a ZIP",()=>{
 const context={...cmsContext,venueAddress:"10410 Example Rd C, Example, NY 28078, USA"};
 setup(branchHtml().replace("10 Example Road, Suite C, Example, NY 12345","10410 Example Road, Suite C, Example, NY 28078"));
 expect(collectNativeOfficialPublicMetadata(context).headings).toContain("Example, NY");
 setup(branchHtml().replace("10 Example Road, Suite C, Example, NY 12345","10410 Example Road, Suite C, Example, NY 10410"));
 expect(collectNativeOfficialPublicMetadata(context).headings).toEqual([]);
});
