import { describe, expect, it } from "vitest";
import { parseTeeItUpV2PublicSource } from "./teeitup-public-source";

const origin = "https://c70350ae-111b-4722-b4d0-c74be760d7ec.book-v2.teeitup.golf";
describe("bounded public TeeItUp V2 URL", () => {
  it.each(["/", "/teetimes", "/teetimes/"])("accepts only the observed public landing %s", path => {
    expect(parseTeeItUpV2PublicSource(`${origin}${path}?course=22,11&date=2030-10-23`)).toMatchObject({
      alias: "c70350ae-111b-4722-b4d0-c74be760d7ec", origin, selectedIds: [11, 22], date: "2030-10-23" });
  });
  it.each(["/account", "/login", "/checkout", "/teetimes/123", "/reservation", "/api/availability", "/Teetimes", "/%74eetimes",
    "/?token=secret", "/?timeId=123", "/?course=11&course=22", "/?date=2030-10-23&date=2030-10-24", "/?course=11,11",
    "/?course=0", "/?course=2147483648", "/?course=1,", "/?date=2030-02-30", "/?date=2030-1-01", "/#teetimes"])
    ("rejects non-public or ambiguous V2 path/query %s", path => expect(parseTeeItUpV2PublicSource(`${origin}${path}`)).toBeNull());
  it.each(["http://public.book-v2.teeitup.golf/", "https://u:p@public.book-v2.teeitup.golf/", "https://public.book-v2.teeitup.golf:8443/",
    "https://public.book-v2.teeitup.com/", "https://public.book-v2.teeitup.golf.evil.example/", "https://a.b.book-v2.teeitup.golf/",
    "https://public.book.teeitup.golf/", "https://public.play.teeitup.golf/", "https://public.book-v3.teeitup.golf/", "https://public.book-v2.teeitup.golf/\n"])
    ("does not widen host or legacy authority %s", url => expect(parseTeeItUpV2PublicSource(url)).toBeNull());
});
