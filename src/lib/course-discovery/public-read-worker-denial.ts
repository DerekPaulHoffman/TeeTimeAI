import type { BrowserContext } from "@playwright/test";

/** Fixed public-reader context policy. Register before creating its first page. */
export const publicReadWorkerDenialScript = `(()=>{for(const name of ['Worker','SharedWorker']){Object.defineProperty(globalThis,name,{value:undefined,writable:false,configurable:false});const d=Object.getOwnPropertyDescriptor(globalThis,name);if(!d||d.value!==undefined||d.writable||d.configurable)throw new Error('STAGEHAND_WORKER_DENIAL_UNAVAILABLE');}})()`;

export async function registerPublicReadWorkerDenial(context: Pick<BrowserContext, "addInitScript">) {
  await context.addInitScript({ content: publicReadWorkerDenialScript });
}
