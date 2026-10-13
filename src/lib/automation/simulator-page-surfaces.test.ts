import { describe, expect, it } from "vitest";
import { simulatorPageSurfacesSchema, summarizeSimulatorPageSurfaces } from "./simulator-page-surfaces";

describe("bounded public page structure diagnostics", () => {
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
