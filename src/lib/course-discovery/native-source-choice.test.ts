import { describe, expect, it } from "vitest";
import { strictNativeSupportedSource, uniqueNativeSupportedSource, type NativeSourceChoiceCapture } from "./native-source-choice";
import { JSDOM } from "jsdom";
import { stagehandNativeSourceDomExpression } from "./stagehand-source-browser";

const foreup = "https://foreupsoftware.com/index.php/booking/123/456#/teetimes";
const teeitup = "https://public-course.book.teeitup.com/";
const uschedule = "https://iframe.uschedule.com/public-studio/booking";
const capture = (patch: Partial<NativeSourceChoiceCapture> = {}): NativeSourceChoiceCapture => ({ pageUrl: "https://official.example/booking", observedAt: 1000,
  documentHash: "a".repeat(64), settled: true, links: [], frames: [teeitup], linksOverflow: false, framesOverflow: false, ...patch });
const choose = (a: NativeSourceChoiceCapture, b = a) => uniqueNativeSupportedSource(a, b, { startedAt: 999, now: 1001, deadline: 2000 });
it("recognizes only a stable current public search document without inventing a link or frame",()=>{
 const pageUrl="https://public-course.ezlinksgolf.com/search",value=capture({pageUrl,links:[],frames:[]});
 expect(choose(value)).toMatchObject({url:pageUrl,family:"EZLINKS",via:"DOCUMENT"});
 expect(choose({...value,links:[foreup]})).toBeNull();
 for(const url of["https://public-course.ezlinksgolf.com/","https://public-course.ezlinks.com/search","https://admin.ezlinksgolf.com/search",pageUrl+"?date=2030-01-01",pageUrl+"#calendar"])
   expect(choose({...value,pageUrl:url})).toBeNull();
 expect(choose(value,{...value,documentHash:"b".repeat(64)})).toBeNull();expect(choose({...value,settled:false})).toBeNull();
});
describe("strict source-only routing families", () => {
  it.each([[foreup, "FOREUP"], [teeitup, "TEEITUP"], [uschedule, "USCHEDULE"], ["https://clients.uschedule.com/public-studio/booking", "USCHEDULE"]])("recognizes the exact public route %s", (url, family) => expect(strictNativeSupportedSource(url)).toBe(family));
  it.each(["https://foreupsoftware.com/", "https://foreupsoftware.com/index.php/booking/123/456#/login",
    "https://foreupsoftware.com/index.php/booking/123/2147483648", "https://public-course.book.teeitup.com/?date=2026-11-01", "https://public-course.book.teeitup.com/#book",
    "https://public-course.book.teeitup.com/account", "https://public-course.book.teeitup.com.evil.example/", "https://iframe.uschedule.com.evil.example/public-studio/booking",
    "https://other.uschedule.com/public-studio/booking", "https://iframe.uschedule.com/public-studio/booking?date=2026-11-01", "https://iframe.uschedule.com/public-studio/booking#book",
    "https://user@iframe.uschedule.com/public-studio/booking", "http://iframe.uschedule.com/public-studio/booking", "https://iframe.uschedule.com:443/public-studio/booking"])("unknown/credential/operator routes do not shortcut %s", url => expect(strictNativeSupportedSource(url)).toBeUndefined());
});
it("deduplicates the same exact supported URL across visible links and frames without inventing a URL", () => {
  expect(choose(capture({ links: [foreup, foreup], frames: [foreup] }))).toMatchObject({ url: foreup, via: "LINK_AND_FRAME" });
  expect(choose(capture({ links: ["https://official.example/contact", uschedule], frames: [] }))).toMatchObject({ url: uschedule, via: "LINK" });
});
it("ambiguous, unsupported, overflow, changed document/loader/page, unready or expired captures fall back", () => {
  for (const patch of [{ links: [foreup] }, { frames: [] }, { linksOverflow: true }, { framesOverflow: true }, { settled: false },
    { observedAt: 998 }, { observedAt: 1002 }, { pageUrl: teeitup }, { documentHash: "wrong" }]) expect(choose(capture(patch))).toBeNull();
  for (const patch of [{ documentHash: "b".repeat(64) }, { pageUrl: "https://foreign.example/booking" }, { frames: [uschedule] }]) expect(choose(capture(), capture(patch))).toBeNull();
  expect(uniqueNativeSupportedSource(capture(), capture(), { startedAt: 999, now: 2000, deadline: 2000 })).toBeNull();
});

function collect(html: string) {
  const dom = new JSDOM(`<style>*{opacity:1}</style>${html}`, { url: "https://official.example/booking", runScripts: "outside-only" });
  dom.window.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as unknown as DOMRectList; };
  dom.window.Element.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, top: 0, left: 0, right: 20, bottom: 20,
    width: this.hasAttribute("data-zero-width") ? 0 : 20, height: this.hasAttribute("data-zero-height") ? 0 : 20, toJSON() { return {}; } }; };
  return JSON.parse(dom.window.eval(stagehandNativeSourceDomExpression));
}
it("the exact native collector excludes hidden/srcdoc/form/zero-area early sources", () => {
  const value = collect(`<a href="${foreup}">Public times</a><div hidden><iframe src="${teeitup}"></iframe></div>
    <iframe src="${teeitup}" srcdoc=""></iframe><iframe data-zero-width src="${teeitup}"></iframe>
    <a data-zero-height href="${teeitup}">Zero</a><form><a href="${teeitup}">Account</a></form>`);
  const links = value.sourceLinkIndexes.map((index: number) => value.links[index]);
  const frames = value.sourceFrameIndexes.map((index: number) => value.frames[index]);
  expect(links).toEqual([foreup]); expect(frames).toEqual([]);
});
it("a second supported route beyond either original native cap cannot become false uniqueness", () => {
  const links = collect(`<a href="${foreup}">One</a>${'<a href="https://official.example/page">Other</a>'.repeat(159)}<a href="${teeitup}">Two</a>`);
  expect(links.links).toHaveLength(160); expect(links.linksOverflow).toBe(true);
  const frames = collect(`<iframe src="${foreup}"></iframe>${'<iframe src="https://official.example/widget"></iframe>'.repeat(23)}<iframe src="${teeitup}"></iframe>`);
  expect(frames.frames).toHaveLength(24); expect(frames.framesOverflow).toBe(true);
  expect(choose(capture({ links: links.links, frames: [], linksOverflow: links.linksOverflow }))).toBeNull();
  expect(choose(capture({ frames: frames.frames, framesOverflow: frames.framesOverflow }))).toBeNull();
});
