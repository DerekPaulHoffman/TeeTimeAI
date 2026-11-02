import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { requestFamilyForUrl } from "./request-family";
import { attr, elements, text, golfBookDocument, golfBookTemplate, golfBookSettings, parseGolfBookSource, verifyGolfBookIdentity, type GolfBookSource, type GolfBookMetadata } from "./golfbook-source";
import type { AccessExecutionInput, AccessExecutionResult } from "./recipe";
type Deps = { fetch?: typeof fetch; deadlineAt?: Date; now?: () => Date;
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }> };
function session(source: GolfBookSource, input: AccessExecutionInput, deps: Deps) {
  const root = parseGolfBookSource(source.bookingUrl); if (!root || source.timeZone !== input.timeZone) throw Error("ADAPTER_TARGET_MISMATCH");
  const controller = new AbortController(), remaining = Math.min(30000, (deps.deadlineAt?.getTime() ?? Infinity) - (deps.now?.() ?? new Date()).getTime());
  if (remaining <= 0) throw Error("DEADLINE_EXCEEDED");
  const signal = AbortSignal.any([controller.signal,AbortSignal.timeout(remaining)]), queue = createSimulatorBrowserRequestQueue(deps.requestLease ?? runWithProviderRequestLease,signal);
  let reads=0;
  return { close(){controller.abort();queue.dispose()}, async read(templateId?: string) {
    if (++reads > 2) throw Error("ADAPTER_REQUEST_LIMIT");
    const u = new URL("/bookingsheet.php",root);u.searchParams.set("date",input.date);u.searchParams.set("lang","en");if(templateId)u.searchParams.set("templateId",templateId);
    const fetch = deps.fetch ?? createAddressPinnedPublicFetchTransport({parseUrl:value=>{if(value!==u.href)throw Error("UNSCOPED_ADAPTER_REQUEST");return new URL(value)},maxResponseBytes:1000000,timeoutMs:12000,redirectLimit:0});
    return queue.run(requestFamilyForUrl(u.href),async()=>{
      const response=await fetch(u.href,{method:"GET",credentials:"omit",redirect:"manual",cache:"no-store",signal,
        headers:{accept:"text/html","user-agent":"TeeTimeSpot/1.0 (public availability reader)"}});
      try{if(response.status!==200||response.redirected||response.url&&response.url!==u.href||!/text\/html/iu.test(response.headers.get("content-type")??""))throw Error("ADAPTER_TRANSPORT_FAILED");
        return golfBookDocument(await response.text());
      }finally{await response.body?.cancel().catch(()=>{})}
    });
  }};
}
async function read(source: GolfBookSource,input:AccessExecutionInput,deps:Deps){
  const s=session(source,input,deps);try{const initial=await s.read(),identity=verifyGolfBookIdentity(source,initial),template=golfBookTemplate(initial,input.date);
    const selected=await s.read(template);if(verifyGolfBookIdentity(source,selected)!==identity||golfBookTemplate(selected,input.date)!==template)throw Error("ADAPTER_IDENTITY_MISMATCH");
    return {document:selected,metadata:golfBookSettings(selected,input.date,template,identity)};
  }finally{s.close()}
}
export async function inspectGolfBook(source:GolfBookSource,input:AccessExecutionInput,deps:Deps){return (await read(source,input,deps)).metadata}
export async function executeGolfBook(source:GolfBookSource,saved:GolfBookMetadata,input:AccessExecutionInput,deps:Deps & {toInstant:(value:unknown,input:AccessExecutionInput)=>Date}):Promise<AccessExecutionResult["slots"]>{
  const {document,metadata}=await read(source,input,deps);
  if(JSON.stringify(metadata)!==JSON.stringify(saved))throw Error("ADAPTER_CONFIGURATION_CHANGED");
  const duration=input.durationMinutes;if(!duration||duration<saved.minDurationMinutes||duration>saved.maxDurationMinutes||(duration-saved.minDurationMinutes)%saved.incrementMinutes)throw Error("ADAPTER_TARGET_MISMATCH");
  const table=document.find(e=>e.tagName==="table"&&attr(e,"id")==="bookingsheet")!,bodies=elements(table).filter(e=>e.tagName==="tbody");
  if(bodies.length!==1)throw Error("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
  const rows=bodies[0].childNodes.filter((e):e is typeof table=>"tagName" in e&&e.tagName==="tr"),free=saved.resourceIds.map(()=>new Set<number>()),minutes:number[]=[];
  if(!rows.length||rows.length>96)throw Error("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
  for(const row of rows){const cells=row.childNodes.filter((e):e is typeof table=>"tagName" in e&&e.tagName==="td");
    const clock=/^(\d{1,2}):([0-5]\d)\s+(AM|PM)$/u.exec(cells[0]?text(cells[0]):"");
    if(!clock||Number(clock[1])<1||Number(clock[1])>12||cells.length!==saved.resourceIds.length+1||!attr(cells[0],"class").split(/\s/u).includes("time-col"))throw Error("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
    const minute=Number(clock[1])%12*60+Number(clock[2])+(clock[3]==="PM"?720:0);
    if(minutes.length&&minute - minutes.at(-1)! !== saved.incrementMinutes)throw Error("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");minutes.push(minute);
    for(let i=0;i<free.length;i++){const cell=cells[i+1],states=attr(cell,"class").split(/\s+/u).filter(c=>c.startsWith("status_"));
      if(states.length!==1||!/^status_[0-4]$/u.test(states[0]))throw Error("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
      if(states[0]!=="status_1")continue;
      const action=/^redirect\('reserve','date=(\d{10})&lane=([1-9]\d{0,9})&templateId=([1-9]\d{0,9})'\);?$/u.exec(attr(cell,"onclick"));
      // The publisher encodes the displayed venue wall clock as a UTC-shaped
      // epoch. Validate that label first; convert to an IANA instant only when
      // producing a slot. Comparing this value to a zoned instant shifts it.
      const wallClock=`${input.date}T${String(Math.floor(minute/60)).padStart(2,"0")}:${String(minute%60).padStart(2,"0")}:00.000Z`;
      if(!action||action[2]!==saved.resourceIds[i]||action[3]!==saved.templateId||new Date(Number(action[1])*1000).toISOString()!==wallClock)throw Error("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");free[i].add(minute);
    }
  }
  const slots:AccessExecutionResult["slots"]=[];
  for(let i=0;i<free.length;i++)for(const minute of minutes){if(!Array.from({length:duration/saved.incrementMinutes},(_,n)=>minute+n*saved.incrementMinutes).every(m=>free[i].has(m)))continue;
    const at=deps.toInstant(`${input.date}T${String(Math.floor(minute/60)).padStart(2,"0")}:${String(minute%60).padStart(2,"0")}:00`,input),end=new Date(at.getTime()+duration*60000);
    slots.push({sourceId:`golfbook:${saved.templateId}:${saved.resourceIds[i]}:${at.toISOString()}:${duration}`,resourceId:saved.resourceIds[i],productId:saved.templateId,
      startsAt:at.toISOString(),endsAt:end.toISOString(),availableSpots:1,capacity:null,bookingUrl:source.bookingUrl});
  }
  return slots;
}
