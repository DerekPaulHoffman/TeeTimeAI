import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import type { Locator } from "@playwright/test";
import { createPublicBookingParentScope, isCurrentOfficialFrameParent, isCurrentRoutingFrameParent, readPublicBookingMenuLabel } from "./public-booking-parent";
import { publicFrameSource } from "./public-frame-source";

describe("private routing-only public booking parent", () => {
  const official = "https://public-course.example/", parent = "https://municipal-booking.example/public/";
  const entry = { src: "https://municipal-courses.book.teeitup.com/?course=41,42", visible: true, srcdoc: false, label: "" };
  function fixture() {
    const rootRequest = {}, parentRequest = {}, bindings = new Map<object, string>([[rootRequest, "a".repeat(64)]]);
    const scope = createPublicBookingParentScope({ officialUrl: official, venueName: "Example Public Golf Course", venueAddress: "10 Main St, Example, NY 10001, USA" },
      undefined, request => bindings.get(request));
    scope.observeDocument({ url: official, status: 200, nativeRequest: rootRequest });
    scope.observeOfficialLink(official, parent, "Tee time reservations");
    bindings.delete(rootRequest); bindings.set(parentRequest, "b".repeat(64));
    scope.observeDocument({ url: parent, status: 200, nativeRequest: parentRequest });
    return { scope, bindings, rootRequest, parentRequest };
  }
  it("admits one known iframe route without claiming a shared page is the requested venue", () => {
    const { scope } = fixture(), proof = scope.authorizeParent(parent, { headings: ["Public reservations"], addressTexts: [] })!;
    expect(proof).toEqual({ kind: "PUBLIC_BOOKING_ROUTING_ONLY", officialUrl: official, documentUrl: parent });
    expect(isCurrentRoutingFrameParent(proof, official, parent)).toBe(true);
    expect(isCurrentOfficialFrameParent(proof, official, parent)).toBe(false);
    expect(publicFrameSource(entry, parent, official, parent, proof)).toBe(entry.src);
    for (const changed of [{ ...entry, visible: false }, { ...entry, srcdoc: true }, { ...entry, src: "https://other.example/calendar", label: "Tee times" },
      { ...entry, src: "https://municipal-courses.book.teeitup.com/checkout" }, { ...entry, label: "Sign in to booking" }])
      expect(publicFrameSource(changed, parent, official, parent, proof)).toBeUndefined();
  });
  it("rejects forged, copied, foreign-context and changed document capabilities", () => {
    const { scope, bindings, parentRequest } = fixture(), proof = scope.authorizeParent(parent)!;
    for (const copied of [{ ...proof }, JSON.parse(JSON.stringify(proof))])
      expect(publicFrameSource(entry, parent, official, parent, copied)).toBeUndefined();
    expect(createPublicBookingParentScope({ officialUrl: official }).authorizeParent(parent)).toBeUndefined();
    expect(publicFrameSource(entry, parent + "other", official, parent + "other", proof)).toBeUndefined();
    expect(publicFrameSource(entry, parent, "https://different.example/", parent, proof)).toBeUndefined();
    bindings.set(parentRequest, "c".repeat(64));
    expect(publicFrameSource(entry, parent, official, parent, proof)).toBeUndefined();
  });
  it.each(["root", "parent", "failure", "native-expiry"])("revokes the route after %s changes", change => {
    const { scope, bindings } = fixture(), proof = scope.authorizeParent(parent)!;
    if (change === "root") scope.beginDocument(official);
    if (change === "parent") scope.beginDocument(parent);
    if (change === "failure") scope.observeDocument({ url: parent, status: 403 });
    if (change === "native-expiry") bindings.clear();
    expect(publicFrameSource(entry, parent, official, parent, proof)).toBeUndefined();
  });
  it("requires the native source at link observation and the native parent at consumption", () => {
    for (const [nativeSource, nativeParent] of [[false, true], [true, false], [false, false]]) {
      const request = {}, parentRequest = {}, bindings = new Map<object, string>();
      const scope = createPublicBookingParentScope({ officialUrl: official }, undefined, value => bindings.get(value));
      if (nativeSource) bindings.set(request, "a".repeat(64));
      scope.observeDocument({ url: official, status: 200, nativeRequest: request });
      scope.observeOfficialLink(official, parent, "Tee times");
      bindings.clear(); if (nativeParent) bindings.set(parentRequest, "b".repeat(64));
      scope.observeDocument({ url: parent, status: 200, nativeRequest: parentRequest });
      expect(scope.authorizeParent(parent)).toBeUndefined();
    }
    const scope = createPublicBookingParentScope({ officialUrl: official });
    scope.observeDocument({ url: official, status: 200 }); scope.observeOfficialLink(official, parent, "Tee times");
    scope.observeDocument({ url: parent, status: 200 }); expect(scope.authorizeParent(parent)).toBeUndefined();
  });
  it.each([
    ["", "true", "#", "Tee Time Reserve", "Tee Time Reserve"],
    ["hidden", "true", "#", "Tee Time Reserve", undefined],
    ["", "false", "#", "Tee Time Reserve", undefined],
    ["", "true", "/other", "Tee Time Reserve", undefined],
    ["", "true", "#", "Sign in to booking", undefined],
    ["", "true", "#", "Other links", undefined],
  ])("reads only a visible literal public-booking menu caption (%s/%s/%s/%s)", async (hidden, popup, href, caption, expected) => {
    const dom = new JSDOM(`<style>*{opacity:1}</style><ul><li aria-haspopup="${popup}" ${hidden}><a href="${href}">${caption}</a><ul><li><a id="entry" href="https://municipal-booking.example/public/">Public visitor</a></li></ul></li></ul>`,
      { url: official, runScripts: "outside-only" });
    dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 20 }) as DOMRect;
    Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
    const link = { evaluate: async (fn: (element: Element) => unknown) => dom.window.eval(`(${fn.toString()})(document.getElementById("entry"))`) } as unknown as Locator;
    try { expect(await readPublicBookingMenuLabel(link)).toBe(expected); }
    finally { dom.window.close(); }
  });
});
