// @vitest-environment node
// Actual tsx serialization and disposable local Chrome; all page network denied.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import type { PublicCourseContactBlock } from "./public-course-contact-blocks";

const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH??"C:/Program Files/Google/Chrome/Application/chrome.exe";
describe.runIf(existsSync(executablePath))("physical contact callback in the actual helper runtime",()=>{
  it("serializes under tsx without module helpers and reads only a visible exact venue contact in real Chrome",async()=>{
    const helper=resolve(process.cwd(),"src/lib/course-discovery/public-course-contact-blocks.ts");
    const serialized=execFileSync(process.execPath,[resolve(process.cwd(),"node_modules/tsx/dist/cli.mjs"),"-e",
      `import {readVisiblePublicCourseContactBlocks as read} from ${JSON.stringify(helper)};void read({evaluate:async(fn)=>{process.stdout.write(fn.toString());return[];}},'Harbor Pointe Golf Course');`],
    {encoding:"utf8",timeout:10000,maxBuffer:100000,windowsHide:true});
    expect(serialized).not.toMatch(/\b__name\s*\(/u);
    const compiled=new Function(`return (${serialized});`)()as(name:string)=>PublicCourseContactBlock[];
    const browser=await chromium.launch({executablePath,headless:true}),page=await browser.newPage();let network=0;
    await page.route("**/*",async route=>{network++;await route.abort();});
    const name="Harbor Pointe Golf Course",markup=`<html><body><ul><li class="h-card"><h4 class="p-name">Other Golf Course</h4><div class="p-tel" id="private">Do not read</div></li>`+
      `<li class="h-card"><h4 class="p-name">${name}</h4><div class="h-adr"><strong>Physical Address</strong><button>Map</button><br>`+
      `<span class="p-street-address">10 Harbor Drive</span><span class="locality">Example</span><span class="p-region">NY</span><span class="p-postal-code">54321</span></div>`+
      `<div class="p-tel" id="phone"><a href="tel:9165554653">(916) 555-4653</a></div></li></ul></body></html>`;
    try{
      await page.setContent(markup);
      await page.evaluate(()=>{Object.defineProperty(document.querySelector("#private"),"innerText",{get(){throw new Error("UNRELATED_PHONE_READ");}});});
      expect(await page.evaluate(compiled,name)).toEqual([{venueName:name,street:"10 Harbor Drive",locality:"Example",region:"NY",postalCode:"54321",country:"US",phone:"(916) 555-4653"}]);
      expect(await page.evaluate(compiled,"Unrelated Named Golf Course")).toEqual([]);
      await page.locator("#phone").evaluate(node=>{(node as HTMLElement).style.opacity="0";});
      await expect(page.evaluate(compiled,name)).rejects.toThrow("CPS_POSTAL_CONFLICT_UNVERIFIED");
      await page.setContent(`<section><h2>Mailing Address</h2>${markup}</section>`);
      expect(await page.evaluate(compiled,name)).toEqual([]);
      expect(network).toBe(0);
    }finally{await browser.close();}
  },20000);
});
