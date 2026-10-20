import { describe, expect, it } from "vitest";
import { publicFrameSource } from "./public-frame-source";

describe("official public iframe source navigation", () => {
  const document = "https://venue.example/book-a-bay/", official = "https://venue.example/";
  const entry = { src: "https://example-rental.book.teeitup.com/", label: "", visible: true, srcdoc: false };
  const read = (value = entry, page = document, proved = page) => publicFrameSource(value, page, official, proved);
  it("exposes an exact visible known public booking source for a separately guarded main-frame read", () => {
    expect(read()).toBe(entry.src);
    expect(read({ ...entry, src: "/availability", label: "Tee time booking" })).toBe("https://venue.example/availability");
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
