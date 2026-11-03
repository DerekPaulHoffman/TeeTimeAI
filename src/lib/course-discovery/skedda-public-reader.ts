import type { Browser, Response } from "@playwright/test";
import { launchPublicReadBrowser } from "./public-browser-launch";
import { createNativePublicBrowserProxy } from "./native-public-browser";
import { resolvePinnedPublicAddress } from "@/lib/automation/address-pinned-public-fetch";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { requestFamilyForUrl } from "./request-family";
import { isSafeRecipeUrl, type AccessExecutionInput } from "./recipe";
import { parseSkeddaSource, skeddaWebSchema, skeddaCalendarSchema, type SkeddaSource } from "./skedda-source";

export type SkeddaReaderDependencies = { deadlineAt?: Date; localCapabilities?: readonly "LOCAL_CHROME"[];
  requestLease?: <T>(family:string,work:()=>Promise<T>)=>Promise<{acquired:true;value:T}|{acquired:false}>;
  launchBrowser?: (proxy: string) => Promise<Browser> };
/** Closed read boundary for an empty, controller-owned anonymous profile. */
export function skeddaPublicReadGate(input:{url:string;sourceUrl:string;documentUrl:string;method:string;resourceType:string;
  headers:Record<string,string>;mainFrame:boolean;navigation:boolean;body:string|null}) {
  try{
    const root=parseSkeddaSource(input.sourceUrl),u=new URL(input.url);
    if(!root||!input.mainFrame||input.method!=="GET"||input.body||!isSafeRecipeUrl(u.href)||
      Object.keys(input.headers).some(k=>/^(?:authorization|proxy-authorization|x-api-key)$/iu.test(k)))return false;
    const local=u.origin===root.origin,data=local&&["/webs","/bookingslists"].includes(u.pathname);
    if(Object.keys(input.headers).some(k=>/token|secret|credential|csrf|session/iu.test(k)&&!(data&&k.toLowerCase()==="x-skedda-requestverificationtoken")))return false;
    const publicPaymentLibrary=input.resourceType==="script"&&["https://connect-js.stripe.com/v1.0/connect.js","https://js.stripe.com/v3"].includes(u.href);
    if(input.navigation)return u.href===input.documentUrl;
    if(local&&!data||!local&&!publicPaymentLibrary&&!(["cdn.skedda.com","fonts.googleapis.com","fonts.gstatic.com"].includes(u.hostname)&&["script","stylesheet","font","image"].includes(input.resourceType)))return false;
    if(data&&(u.pathname==="/webs"&&u.search||u.pathname==="/bookingslists"&&([...u.searchParams.keys()].sort().join(",")!=="end,start"||
      ![u.searchParams.get("start"),u.searchParams.get("end")].every(v=>v&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/u.test(v)))))return false;
    return true;
  }catch{return false;}
}
export async function readSkeddaPublicCalendar(source:SkeddaSource,input:AccessExecutionInput,deps:SkeddaReaderDependencies) {
  if(!deps.localCapabilities?.includes("LOCAL_CHROME"))throw Error("LOCAL_CHROME_REQUIRED");
  const root=parseSkeddaSource(source.bookingUrl);if(!root)throw Error("INVALID_ADAPTER_SOURCE");
  const remaining=Math.min(75000,(deps.deadlineAt?.getTime()??Infinity)-Date.now());if(remaining<=0)throw Error("DEADLINE_EXCEEDED");
  const stop=new AbortController(),signal=AbortSignal.any([stop.signal,AbortSignal.timeout(remaining)]),
    queue=createSimulatorBrowserRequestQueue(deps.requestLease??runWithProviderRequestLease,signal);
  const proxy=await createNativePublicBrowserProxy({signal,maxBytes:32000000,maxConnections:250});
  let browser:Browser|undefined;
  let phase="LAUNCH",requests=0;
  const denied:Array<{role:string;path:string;type:string;reason:string}>=[];
  try{
    browser=deps.launchBrowser?await deps.launchBrowser(proxy.server):await launchPublicReadBrowser({headless:process.platform!=="win32",
      ...(process.platform==="win32"?{channel:"chrome"}:{}),proxy:{server:proxy.server,bypass:"<-loopback>"},
      args:["--disable-quic"],timeout:Math.min(15000,remaining)});
    const ownedBrowser=browser,abort=()=>{void ownedBrowser.close().catch(()=>{});};signal.addEventListener("abort",abort,{once:true});
    try{
      const context=await browser.newContext({timezoneId:input.timeZone,locale:"en-US",viewport:{width:1280,height:720},serviceWorkers:"block",acceptDownloads:false});
      await context.routeWebSocket("**/*",route=>route.close());
      const page=await context.newPage(),dated=new URL(root);dated.searchParams.set("viewdate",input.date);
      await context.route("**/*",async route=>{
        const request=route.request();let continued=false,reason="TRANSPORT";
        try{
          signal.throwIfAborted();const u=new URL(request.url()),headers=await request.allHeaders();
          reason="ROUTE";
          if(++requests>250||!skeddaPublicReadGate({url:u.href,sourceUrl:source.bookingUrl,documentUrl:dated.href,method:request.method(),resourceType:request.resourceType(),
            headers,mainFrame:request.frame()===page.mainFrame(),navigation:request.isNavigationRequest(),body:request.postData()}))throw Error("SKEDDA_READ_REJECTED");
          await resolvePinnedPublicAddress(u.hostname);proxy.allowHostConnections(u.hostname);
          await queue.run(requestFamilyForUrl(u.href),async()=>{signal.throwIfAborted();continued=true;await route.continue();const response=await request.response();if(response)await response.finished();});
        }catch{const u=new URL(request.url());if(denied.length<20)denied.push({role:u.origin===root.origin?"SOURCE":u.hostname==="cdn.skedda.com"?"CDN":"OTHER",
          path:u.hostname==="cdn.skedda.com"?u.pathname:"OTHER",type:request.resourceType(),reason});if(!continued)await route.abort().catch(()=>{});}
      });
      const bound=(response:Response,path:string)=>response.url()===root.origin+path&&response.request().frame()===page.mainFrame();
      const metadata=page.waitForResponse(r=>bound(r,"/webs"),{timeout:Math.min(60000,remaining)});
      const calendar=page.waitForResponse(r=>{try{const u=new URL(r.url());return u.origin===root.origin&&u.pathname==="/bookingslists"&&r.request().frame()===page.mainFrame();}catch{return false;}},{timeout:Math.min(60000,remaining)});
      const captured=Promise.all([metadata,calendar]).then(async responses=>Promise.all(responses.map(async response=>{
        if(response.status()!==200||response.request().redirectedFrom()||!/application\/json/iu.test(response.headers()["content-type"]??"")||Number(response.headers()["content-length"]??0)>1000000)throw Error("SKEDDA_PUBLIC_READ_FAILED");
        const body=await response.body();if(body.length>1000000)throw Error("SKEDDA_RESPONSE_LIMIT");
        const data:unknown=JSON.parse(body.toString("utf8"));return {url:response.url(),data};
      }))).then(value=>({value}),()=>({value:undefined}));
      phase="DOCUMENT";const main=await page.goto(dated.href,{waitUntil:"domcontentloaded",timeout:Math.min(60000,remaining)});
      if(!main||main.status()!==200||main.request().redirectedFrom()||page.url()!==dated.href)throw Error("SKEDDA_DOCUMENT_UNVERIFIED");
      phase="SPACES";const table=page.getByRole("table",{name:"Spaces",exact:true});await table.waitFor({timeout:Math.min(30000,remaining)});
      await page.getByRole("table",{name:"Day view schedule",exact:true}).waitFor({timeout:Math.min(30000,remaining)});
      phase="DATA";const visibleResources=await table.locator("th").allTextContents(),result=await captured;signal.throwIfAborted();
      if(!result.value||page.url()!==dated.href)throw Error("SKEDDA_PUBLIC_READ_FAILED");
      const web=skeddaWebSchema.safeParse(result.value[0].data),schedule=skeddaCalendarSchema.safeParse(result.value[1].data);
      if(!web.success||!schedule.success)throw Error("SKEDDA_PUBLIC_SCHEMA_UNVERIFIED");
      return {web:web.data,calendar:schedule.data,requestUrl:result.value[1].url,visibleResources:visibleResources.map(v=>v.replace(/\s+/gu," ").trim()).filter(Boolean)};
    }finally{signal.removeEventListener("abort",abort);}
  }catch(error){const code=error instanceof Error&&/^[A-Z_]+$/u.test(error.message)?error.message:"SKEDDA_PUBLIC_READ_FAILED";
    throw Object.assign(new Error(code),{details:{phase,requests,denied}});
  }finally{stop.abort();queue.dispose();await browser?.close().catch(()=>{});await proxy.close();}
}
