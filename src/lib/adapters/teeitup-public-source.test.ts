import { describe, expect, it } from "vitest";
import { parseTeeItUpV2PublicSource } from "./teeitup-public-source";
import { parseTeeItUpRecipeSource, teeItUpRecipeBookingUrl, isTeeItUpRecipeSlotLink } from "@/lib/course-discovery/teeitup-recipe-source";

const origin = "https://c70350ae-111b-4722-b4d0-c74be760d7ec.book-v2.teeitup.golf";
describe("bounded public TeeItUp V2 URL", () => {
  it.each(["/", "/teetimes", "/teetimes/"])("accepts only the observed public landing %s", path => {
    expect(parseTeeItUpV2PublicSource(`${origin}${path}?course=22,11&date=2030-10-23`)).toMatchObject({
      alias: "c70350ae-111b-4722-b4d0-c74be760d7ec", origin, selectedIds: [11, 22], date: "2030-10-23" });
  });
  it("recognizes only the exact public teetimes path on the legacy golf host without rewriting its origin", () => {
    const source = "https://public-course.book.teeitup.golf/teetimes?course=22,11&date=2030-10-23";
    expect(parseTeeItUpV2PublicSource(source)).toEqual({ alias: "public-course", origin: "https://public-course.book.teeitup.golf", url: source, selectedIds: [11, 22], date: "2030-10-23" });
    expect(parseTeeItUpRecipeSource(source)).toMatchObject({ alias: "public-course", origin: "https://public-course.book.teeitup.golf", selectedIds: [11, 22] });
    const link = teeItUpRecipeBookingUrl(source, "2030-10-24", 11);
    expect(link).toBe("https://public-course.book.teeitup.golf/teetimes?course=11&date=2030-10-24");
    expect(isTeeItUpRecipeSlotLink(source, "2030-10-24", [11], { sourceId: "teeitup-11-start", resourceId: "teeitup-facility:11", bookingUrl: link })).toBe(true);
    expect(isTeeItUpRecipeSlotLink(source, "2030-10-24", [11], { sourceId: "teeitup-11-start", resourceId: "teeitup-facility:11", bookingUrl: link.replace("/teetimes?", "/?") })).toBe(false);
    expect(() => teeItUpRecipeBookingUrl(source, "2030-10-24", 33)).toThrow("ADAPTER_SOURCE_MISMATCH");
  });
  it.each(["com", "golf"])("keeps the %s legacy root in V1", suffix => {
    const source = `https://public-course.book.teeitup.${suffix}/?course=11`;
    expect(parseTeeItUpV2PublicSource(source)).toBeNull();
    expect(parseTeeItUpRecipeSource(source)).toEqual({ alias: "public-course", origin: `https://public-course.book.teeitup.${suffix}`, selectedIds: [11] });
  });
  it.each(["/", "/teetimes/", "/Teetimes", "/%74eetimes", "/teetimes/1", "/checkout", "/teetimes?course=11&course=22", "/teetimes?course=11,11", "/teetimes?course=0", "/teetimes?course=2147483648", "/teetimes?date=2030-02-30", "/teetimes?timeId=1", "/teetimes#book"])
    ("does not widen the new host's route/query %s", path => expect(parseTeeItUpV2PublicSource(`https://public-course.book.teeitup.golf${path}`)).toBeNull());
  it.each(["https://public-course.book.teeitup.com/teetimes", "https://public-course.book.teeitup.golf.evil.example/teetimes", "https://a.b.book.teeitup.golf/teetimes", "http://public-course.book.teeitup.golf/teetimes", "https://u:p@public-course.book.teeitup.golf/teetimes", "https://public-course.book.teeitup.golf:8443/teetimes"])
    ("keeps exact public host and credential guards %s", source => expect(parseTeeItUpV2PublicSource(source)).toBeNull());
  it.each(["/account", "/login", "/checkout", "/teetimes/123", "/reservation", "/api/availability", "/Teetimes", "/%74eetimes",
    "/?token=secret", "/?timeId=123", "/?course=11&course=22", "/?date=2030-10-23&date=2030-10-24", "/?course=11,11",
    "/?course=0", "/?course=2147483648", "/?course=1,", "/?date=2030-02-30", "/?date=2030-1-01", "/#teetimes"])
    ("rejects non-public or ambiguous V2 path/query %s", path => expect(parseTeeItUpV2PublicSource(`${origin}${path}`)).toBeNull());
  it.each(["http://public.book-v2.teeitup.golf/", "https://u:p@public.book-v2.teeitup.golf/", "https://public.book-v2.teeitup.golf:8443/",
    "https://public.book-v2.teeitup.com/", "https://public.book-v2.teeitup.golf.evil.example/", "https://a.b.book-v2.teeitup.golf/",
    "https://public.book.teeitup.golf/", "https://public.play.teeitup.golf/", "https://public.book-v3.teeitup.golf/", "https://public.book-v2.teeitup.golf/\n"])
    ("does not widen host or legacy authority %s", url => expect(parseTeeItUpV2PublicSource(url)).toBeNull());
});
