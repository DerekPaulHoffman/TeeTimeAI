import { describe, expect, it } from "vitest";
import { publicFrameSource } from "./public-frame-source";
import { createPublicBookingParentScope } from "./public-booking-parent";

describe("official public iframe source navigation", () => {
  const document = "https://venue.example/book-a-bay/", official = "https://venue.example/";
  const entry = { src: "https://example-rental.book.teeitup.com/", label: "", visible: true, srcdoc: false };
  const read = (value = entry, page = document, proved = page) => publicFrameSource(value, page, official, proved);
  it("exposes an exact visible known public booking source for a separately guarded main-frame read", () => {
    expect(read()).toBe(entry.src);
    expect(read({ ...entry, src: "/availability", label: "Tee time booking" })).toBe("https://venue.example/availability");
  });
  it("exposes a visible unlabeled v2 public entry exactly as observed without inventing a legacy route", () => {
    const src = "https://c70350ae-111b-4722-b4d0-c74be760d7ec.book-v2.teeitup.golf/";
    expect(read({ ...entry, src })).toBe(src);
    expect(read({ ...entry, src: `${src}?course=123` })).toBe(`${src}?course=123`);
    for (const unsafe of [src.replace("teeitup.golf", "teeitup.golf.example.org"), src.replace("book-v2", "account"),
      `${src}login`, `${src}?course=invalid`, `${src}?course=123&course=456`, `${src}#login`, src.replace("https://", "http://")])
      expect(read({ ...entry, src: unsafe })).toBeUndefined();
    expect(read({ ...entry, src, visible: false })).toBeUndefined();
    expect(read({ ...entry, src, label: "Sign in to booking" })).toBeUndefined();
  });
  it("exposes only the exact visible legacy play root on the current verified official booking page", () => {
    const src = "https://public-course.play.teeitup.com/";
    const readPlay = (value = { ...entry, src }, page = document, proved = page) => publicFrameSource(value, page, official, proved,
      { kind: "VERIFIED_OFFICIAL_DOCUMENT", officialUrl: official, documentUrl: page });
    expect(readPlay()).toBe(src);
    expect(readPlay({ ...entry, src: src.slice(0, -1) })).toBe(src);
    expect(readPlay()).not.toContain(".book.");
    for (const unsafe of ["https://public-course-.play.teeitup.com/", "https://-public-course.play.teeitup.com/",
      "https://public-course.play.teeitup.com.example.org/", "https://public-course.play.teeitup.golf/",
      `${src}teetimes`, `${src}login`, `${src}checkout`, `${src}?course=123`, `${src}?token=secret`, `${src}#times`,
      src.replace("https://", "http://"), src.replace("https://", "https://user:secret@"), src.replace(".com/", ".com:8443/")])
      expect(readPlay({ ...entry, src: unsafe })).toBeUndefined();
    expect(readPlay({ ...entry, src, visible: false })).toBeUndefined();
    expect(readPlay({ ...entry, src, srcdoc: true })).toBeUndefined();
    expect(readPlay({ ...entry, src, label: "Sign in to booking" })).toBeUndefined();
    expect(readPlay({ ...entry, src }, document, "https://venue.example/old")).toBeUndefined();
    expect(readPlay({ ...entry, src }, "https://other.example/tee-times/", "https://other.example/tee-times/")).toBeUndefined();
    expect(read({ ...entry, src })).toBeUndefined();
    expect(publicFrameSource({ ...entry, src }, "https://provider.example/venue", official, "https://provider.example/venue", {
      kind: "OBSERVED_PUBLIC_BOOKING_PARENT", officialUrl: official, documentUrl: "https://provider.example/venue",
      officialDocumentUrl: document, observedBookingHref: "https://provider.example/venue",
    })).toBeUndefined();
  });
  it("requires fresh official-document proof again after a same-URL navigation begins or fails", () => {
    const scope = createPublicBookingParentScope({ officialUrl: official });
    scope.observeDocument({ url: official, status: 200 });
    scope.observeOfficialLink(official, document, "Book tee times");
    scope.observeDocument({ url: document, status: 200 });
    const src = "https://public-course.play.teeitup.com/", value = { ...entry, src };
    const current = () => publicFrameSource(value, document, official, document, scope.authorizeParent(document));
    expect(current()).toBe(src);
    scope.beginDocument(document); expect(current()).toBeUndefined();
    scope.observeDocument({ url: document, status: 403 }); expect(current()).toBeUndefined();
    scope.observeDocument({ url: document, status: 200 }); expect(current()).toBe(src);
  });
  it("requires the current HTTP-verified official document and visible source markup", () => {
    expect(read(entry, "https://other.example/book", "https://other.example/book")).toBeUndefined();
    expect(publicFrameSource(entry, "https://127.0.0.1/", "https://127.0.0.1/", "https://127.0.0.1/")).toBeUndefined();
    expect(read(entry, document, "https://venue.example/old")).toBeUndefined();
    expect(read({ ...entry, visible: false })).toBeUndefined();
    expect(read({ ...entry, srcdoc: true })).toBeUndefined();
    expect(read({ ...entry, src: "" })).toBeUndefined();
  });
  it.each([
    "javascript:alert(1)", "http://booking.example/", "https://127.0.0.1/", "https://user:secret@booking.example/",
    "https://booking.example/login", "https://booking.example/checkout", "https://booking.example/?slotId=123",
    "https://booking.example/?token=secret", "https://example-rental.book.teeitup.com/?Time=09:00",
  ])("rejects unsafe or transaction-specific source %s", src => {
    expect(read({ ...entry, src, label: "Tee time booking" })).toBeUndefined();
  });
  it("does not promote an unlabeled unrelated embed or an authentication-labelled known entry", () => {
    expect(read({ ...entry, src: "https://video.example/clip" })).toBeUndefined();
    expect(read({ ...entry, label: "Sign in to booking" })).toBeUndefined();
  });
  it("discards copied CPS session and date state before returning a public entry", () => {
    const src = "https://sc.cps.golf/ExampleV3/(S(abc123abc123abc123abc123))/Home/nIndex?CourseId=1&Time=AnyTime&Player=99&Hole=Any&Date=2026-10-23";
    const result = read({ ...entry, src, label: "Tee time booking" });
    expect(result).toBe("https://sc.cps.golf/ExampleV3/Home/nIndex?CourseId=1&Time=AnyTime&Player=99&Hole=Any");
    expect(result).not.toMatch(/abc123|2026/);
  });
});
