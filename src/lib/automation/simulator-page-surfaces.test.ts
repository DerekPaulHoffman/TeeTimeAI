import { describe, expect, it } from "vitest";
import { simulatorPageSurfacesSchema, summarizeSimulatorPageSurfaces } from "./simulator-page-surfaces";

describe("bounded public page structure diagnostics", () => {
  it("distinguishes deferred declarations and script types from actual inline code", () => {
    const result = summarizeSimulatorPageSurfaces('<script data-src="/public-a.js" type="text/deferred"></script>' +
      '<script data-cache-src="/public-b.js" type="module"></script>' +
      '<script>privateInline()</script><script src="/public-c.js" type="text/javascript"></script>', "https://venue.example.test/");
    expect(result.entries).toEqual([
      { kind: "EXTERNAL_SCRIPT", target: "LAZY_URL", hidden: false, bookingLabel: false, count: 1, scriptType: "OTHER" },
      { kind: "EXTERNAL_SCRIPT", target: "LAZY_URL", hidden: false, bookingLabel: false, count: 1, scriptType: "MODULE" },
      { kind: "INLINE_SCRIPT", target: "INLINE_CODE", hidden: false, bookingLabel: false, count: 1, scriptType: "MISSING" },
      { kind: "EXTERNAL_SCRIPT", target: "PUBLIC_URL", hidden: false, bookingLabel: false, count: 1, scriptType: "JAVASCRIPT" },
    ]);
    expect(simulatorPageSurfacesSchema.parse(result)).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(/public-[abc]|privateInline/);
    const conflicting = summarizeSimulatorPageSurfaces('<script data-src="/one.js" data-cache-src="/two.js"></script>', "https://venue.example.test/");
    expect(conflicting.entries[0]).toMatchObject({ kind: "EXTERNAL_SCRIPT", target: "UNSAFE" });
  });
  it("distinguishes hidden, unlabelled and scripted booking surfaces without exposing their contents", () => {
    const result = summarizeSimulatorPageSurfaces(`<iframe src="https://unknown.example.test/private-venue-id"></iframe>
      <div hidden><iframe title="Online booking" data-src="https://calendar.example.test/private-id"></iframe></div>
      <a href="#private-popup">Book a session</a><button onclick="privateFunction('secret')">Book now</button>
      <form action="/private-form"><input name="customerEmail" value="private@example.test"></form>
      <script src="/private-app.js"></script><script>var privateToken='secret';</script>`, "https://venue.example.test/");
    expect(result.entries).toEqual(expect.arrayContaining([
      { kind: "IFRAME", target: "PUBLIC_URL", hidden: false, bookingLabel: false, count: 1 },
      { kind: "IFRAME", target: "LAZY_URL", hidden: true, bookingLabel: true, count: 1 },
      { kind: "BOOKING_LINK", target: "FRAGMENT", hidden: false, bookingLabel: true, count: 1 },
      { kind: "BOOKING_ACTION", target: "INLINE_CODE", hidden: false, bookingLabel: true, count: 1 },
    ]));
    expect(simulatorPageSurfacesSchema.parse(result)).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(/private|secret|customer|https|example/iu);
  });
  it("marks unsafe and inline frame targets without retaining URLs or code", () => {
    const result = summarizeSimulatorPageSurfaces('<iframe title="Calendar" src="http://127.0.0.1/private"></iframe><iframe srcdoc="secret"></iframe>', "https://venue.example.test");
    expect(result.entries.map(entry => entry.target)).toEqual(["UNSAFE", "SRCDOC"]);
    expect(JSON.stringify(result)).not.toMatch(/127|private|secret/u);
  });
  it("bounds all counts and reports truncation rather than claiming a complete inventory", () => {
    const result = summarizeSimulatorPageSurfaces('<iframe src="/public"></iframe>'.repeat(100), "https://venue.example.test");
    expect(result).toEqual({ entries: [{ kind: "IFRAME", target: "PUBLIC_URL", hidden: false, bookingLabel: false, count: 64 }], truncated: true });
    expect(() => simulatorPageSurfacesSchema.parse({ ...result, entries: [{ ...result.entries[0], count: 65 }] })).toThrow();
    expect(() => simulatorPageSurfacesSchema.parse({ ...result, rawHtml: "secret" })).toThrow();
  });
});
