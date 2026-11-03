import { deriveSkeddaMetadata, extractSkeddaSlots, validateSkeddaCalendar, type SkeddaMetadata, type SkeddaSource } from "./skedda-source";
import { readSkeddaPublicCalendar, type SkeddaReaderDependencies } from "./skedda-public-reader";
import type { AccessExecutionInput } from "./recipe";
type Dependencies=SkeddaReaderDependencies&{now?:()=>Date;readCalendar?:typeof readSkeddaPublicCalendar};
async function read(source:SkeddaSource,input:AccessExecutionInput,deps:Dependencies){
  if(!deps.localCapabilities?.includes("LOCAL_CHROME"))throw Error("LOCAL_CHROME_REQUIRED");
  const result=await(deps.readCalendar??readSkeddaPublicCalendar)(source,input,deps);
  const metadata=deriveSkeddaMetadata(source,result.web,result.visibleResources,input);
  validateSkeddaCalendar(result.web,result.calendar,result.requestUrl,input.date);
  return {...result,metadata};
}
export async function inspectSkedda(source:SkeddaSource,input:AccessExecutionInput,deps:Dependencies){return(await read(source,input,deps)).metadata;}
export async function executeSkedda(source:SkeddaSource,saved:SkeddaMetadata,input:AccessExecutionInput,deps:Dependencies&{toInstant:(value:unknown,input:AccessExecutionInput)=>Date}){
  const result=await read(source,input,deps);if(JSON.stringify(result.metadata)!==JSON.stringify(saved))throw Error("ADAPTER_CONFIGURATION_CHANGED");
  return extractSkeddaSlots(source,saved,result.web,result.calendar,input,deps.now?.()??new Date(),deps.toInstant);
}
