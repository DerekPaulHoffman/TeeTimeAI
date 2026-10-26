import { expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { collectPublicBookingLinks, rawPublicBookingLinks, uniquePublicBookingIntermediary, observedPublicBookingIntermediary, uniqueNativePublicBookingIntermediary } from "./public-booking-intermediary";
const root = "https://public-course.example/", href = root + "tee-times";
const html = '<div hidden role="dialog"><a href="/tee-times">Tee Times</a></div><a style="display:none" href="/tee-times">Book Online</a><a href="/tee-times">Book A Tee Time</a><a href="/other">Book Yours</a>';
const proof = { kind: "VERIFIED_OFFICIAL_DOCUMENT" as const, officialUrl: root, documentUrl: root };
function fixture(source = html) {
  const dom = new JSDOM(source, { url: root, runScripts: "outside-only" });let url = root, reads = 0;
  const page = { url: () => url, evaluate: async (fn: () => unknown) => { reads++;return dom.window.eval(`(${fn.toString()})()`); } } as unknown as Page;
  return { dom, page, get reads() { return reads; }, setUrl: (value: string) => { url = value; } };
}
it("deduplicates exact literal hidden first-party booking links without a visible-control or provider claim", () => {
  const f = fixture();try {
    const rows = f.dom.window.eval(`(${collectPublicBookingLinks.toString()})()`);
    expect(uniquePublicBookingIntermediary(rows, root)).toBe(href);expect(uniquePublicBookingIntermediary(rawPublicBookingLinks(html), root)).toBe(href);
    expect(JSON.stringify(rows)).not.toContain('"visible":true');
  } finally { f.dom.window.close(); }
});
it.each([
  '<a href="/tee-times">Tee Times</a><a href="/booking">Book Online</a>',
  '<form><a href="/tee-times">Tee Times</a></form>', '<template><a href="/tee-times">Tee Times</a></template>',
  '<a download href="/tee-times">Tee Times</a>', '<a onclick="login()" href="/tee-times">Tee Times</a>',
  '<a href="https://foreign.example/tee-times">Tee Times</a>', '<a href="//evil.example/tee-times">Tee Times</a>',
  '<a href="/tee-times?course=1">Tee Times</a>', '<a href="/tee-times#checkout">Tee Times</a>',
  '<a href="/members/tee-times">Tee Times</a>', '<a href="/checkout/booking">Book Online</a>',
  '<a href="/tee-times" aria-label="Register">Tee Times</a>', '<a href="/tee-times">Book Yours</a>',
  '<a href="/tee-times">Book 09:00 AM</a>', '<a href="/tee-times">Login to book online</a>',
  '<a href="javascript:login()">Tee Times</a>', '<a href="http://public-course.example/tee-times">Tee Times</a>',
])("excludes ambiguous, private, transaction, parameterized or nonliteral markup %s", source => {
  expect(uniquePublicBookingIntermediary(rawPublicBookingLinks(source), root)).toBeNull();
  const f = fixture(source);try { expect(uniquePublicBookingIntermediary(f.dom.window.eval(`(${collectPublicBookingLinks.toString()})()`), root)).toBeNull(); } finally { f.dom.window.close(); }
});
it("retains original raw relative href and refuses truncation-based false uniqueness", () => {
  const rows = rawPublicBookingLinks(html);expect(rows.rows[0].href).toBe("/tee-times");
  const over = html + '<a href="/other">Other</a>'.repeat(160);expect(rawPublicBookingLinks(over).overflow).toBe(true);expect(uniquePublicBookingIntermediary(rawPublicBookingLinks(over), root)).toBeNull();
});
it("irrelevant fragment menu SVG/style captions cannot veto one literal hidden public gateway", () => {
  const source = `<a href="#mobile-menu" aria-label="Open Menu"><svg><style>${".menu{opacity:1}".repeat(40)}</style></svg></a>${html}<a href="#menu" aria-label="Open Menu"><svg><style>${".icon{opacity:1}".repeat(40)}</style></svg></a>`;
  const raw = rawPublicBookingLinks(source);expect(raw.rows.some(row => row.text.length === 161)).toBe(true);
  expect(uniquePublicBookingIntermediary(raw, root)).toBe(href);
  const f = fixture(source);try {
    expect(uniquePublicBookingIntermediary(f.dom.window.eval(`(${collectPublicBookingLinks.toString()})()`), root)).toBe(href);
  } finally { f.dom.window.close(); }
});
it("overlong relevant same/competing gateway captions and malformed or oversized hrefs still defeat uniqueness", () => {
  const valid = '<a href="/tee-times">Tee Times</a>';
  for (const path of ['/tee-times', '/booking']) for (const field of ['text', 'label']) {
    const source = valid + `<a href="${path}"${field === 'label' ? ` aria-label="${'X'.repeat(161)}"` : ''}>${field === 'text' ? 'X'.repeat(161) : 'Book Online'}</a>`;
    expect(uniquePublicBookingIntermediary(rawPublicBookingLinks(source), root)).toBeNull();
    const f = fixture(source);try { expect(uniquePublicBookingIntermediary(f.dom.window.eval(`(${collectPublicBookingLinks.toString()})()`), root)).toBeNull(); } finally { f.dom.window.close(); }
  }
  for (const extra of ['<a href="https://[invalid/tee-times">Other</a>', `<a href="https://foreign.example/${'x'.repeat(2049)}">Other</a>`])
    expect(uniquePublicBookingIntermediary(rawPublicBookingLinks(valid + extra), root)).toBeNull();
});
it("fresh inspector requires actual official response and two unchanged current document observations", async () => {
  const f = fixture();try {
    expect(await observedPublicBookingIntermediary(f.page, html, proof)).toBe(href);
    expect(await observedPublicBookingIntermediary(f.page, html, undefined)).toBeNull();
    expect(await observedPublicBookingIntermediary(f.page, html, { ...proof, documentUrl: root + 'foreign' })).toBeNull();
    expect(await observedPublicBookingIntermediary(f.page, '<a href="/booking">Tee Times</a>', proof)).toBeNull();
    f.dom.window.document.querySelector('a')!.setAttribute('href', '/booking');expect(await observedPublicBookingIntermediary(f.page, html, proof)).toBeNull();
    f.setUrl(root + 'new');expect(await observedPublicBookingIntermediary(f.page, html, proof)).toBeNull();
  } finally { f.dom.window.close(); }
});
it("actual installed tsx serialization of the fixed callback has no module helper dependency", () => {
  const result = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', '--eval', "const vm=require('node:vm');const {collectPublicBookingLinks:f}=require('./src/lib/course-discovery/public-booking-intermediary.ts');const s=f.toString();console.log(JSON.stringify({value:vm.runInNewContext('('+s+')()',{document:{querySelectorAll:()=>[]}}),moduleHelper:/__name/.test(s)}))"], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true });
  expect(JSON.parse(result)).toEqual({ value: { rows: [], overflow: false }, moduleHelper: false });
});
it("native selection requires both complete same-current-loader/hash observations within the original clock", () => {
  const first = { pageUrl: root, documentHash: 'a'.repeat(64), observedAt: 1000, settled: true, links: rawPublicBookingLinks(html) };
  const clock = { startedAt: 999, now: 1001, deadline: 2000 };
  expect(uniqueNativePublicBookingIntermediary(first, first, clock)).toBe(href);
  for (const patch of [{ settled: false }, { documentHash: 'b'.repeat(64) }, { pageUrl: 'https://other.example/' }, { observedAt: 998 }, { observedAt: 1002 },
    { links: rawPublicBookingLinks('<a href="/booking">Tee Times</a>') }, { links: { ...first.links, overflow: true } }])
    expect(uniqueNativePublicBookingIntermediary(first, { ...first, ...patch }, clock)).toBeNull();
  expect(uniqueNativePublicBookingIntermediary(first, first, { ...clock, now: 2000 })).toBeNull();
});
