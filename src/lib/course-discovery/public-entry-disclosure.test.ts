import { describe, expect, it } from "vitest";
import { classifyPublicEntryDisclosure, revalidatePublicEntryDisclosure, type PublicEntryDisclosureEvidence } from "./public-entry-disclosure";

describe("fresh public entry disclosure", () => {
  const context = { officialUrl: "https://official.example/", currentUrl: "https://official.example/", documentStartedAt: 1000, now: 2000, deadline: 5000 };
  const entry: PublicEntryDisclosureEvidence = { pageUrl: context.currentUrl, documentStartedAt: 1000, observedAt: 1900,
    tag: "A", href: "https://official.example/public-entry", rawHref: "/public-entry", text: "Reserve Your Bay", label: "", rowText: "",
    visible: true, inForm: false, inlineHandler: false, download: false, disabled: false, role: "" };
  it("binds only the exact observed safe document edge without a selector, navigation or metadata authority", () => {
    const proof = classifyPublicEntryDisclosure(entry, context)!;
    expect(proof).toMatchObject({ kind: "PUBLIC_ENTRY_DISCLOSURE_V1", href: entry.href, rawHref: entry.rawHref, pageUrl: context.currentUrl, documentStartedAt: 1000 });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(proof).not.toHaveProperty("selector"); expect(proof).not.toHaveProperty("target"); expect(proof).not.toHaveProperty("adapter");
    for (const text of ["Reserve a Bay", "Reserve Your Simulator", "Reserve Tee Times"])
      expect(classifyPublicEntryDisclosure({ ...entry, text }, context)).not.toBeNull();
    expect(classifyPublicEntryDisclosure({ ...entry, text: " \n Reserve Your Bay \t " }, context)?.text).toBe("Reserve Your Bay");
    expect(revalidatePublicEntryDisclosure(proof, { ...entry, observedAt: 1950 }, context)).toBe(true);
  });
  it.each([
    { visible: false }, { tag: "BUTTON" }, { inForm: true }, { inlineHandler: true }, { download: true }, { disabled: true }, { role: "button" },
    { text: "Reserve now" }, { text: "Reserve ReservationConfirm" }, { label: "Confirm reservation" }, { text: "Reserve Your Bay and pay" },
    { rowText: "10:00 AM Reserve Your Bay" }, { rowText: "10 AM Reserve Your Bay" }, { rowText: "Selected appointment" },
    { text: "Reserve Your Bay" + " ".repeat(161) }, { rowText: "x".repeat(701) }, { rawHref: "/different" }, { rawHref: "//official.example/public-entry" },
    { pageUrl: "https://official.example/old" }, { documentStartedAt: 999 }, { observedAt: 2001 }, { observedAt: 999 },
  ])("rejects incomplete, private, stale, non-anchor or transaction facts: %j", delta => {
    expect(classifyPublicEntryDisclosure({ ...entry, ...delta }, context)).toBeNull();
  });
  it.each(["https://foreign.example/public-entry", "https://official.example/public-entry?date=2030-01-01",
    "https://official.example/public-entry#calendar", "https://official.example/slot/123", "https://official.example/reservationConfirm",
    "https://official.example/checkout", "https://official.example/account", "https://official.example/%70ublic-entry",
    "https://user:secret@official.example/public-entry", "https://127.0.0.1/public-entry", "http://official.example/public-entry"])
  ("does not disclose an unsafe or parameterized destination: %s", href => {
    const url = new URL(href);
    expect(classifyPublicEntryDisclosure({ ...entry, href, rawHref: url.pathname + url.search + url.hash }, context)).toBeNull();
  });
  it("requires complete native facts, a fresh caller clock and current official document rather than model arguments", () => {
    for (const value of [{ ...entry, selector: "a" }, { ...entry, rowText: undefined }, { ...entry, observedAt: undefined }])
      expect(classifyPublicEntryDisclosure(value as PublicEntryDisclosureEvidence, context)).toBeNull();
    expect(classifyPublicEntryDisclosure(entry, { ...context, now: 7000, deadline: 8000 })).toBeNull();
    expect(classifyPublicEntryDisclosure(entry, { ...context, now: 5000 })).toBeNull();
    expect(classifyPublicEntryDisclosure(entry, { ...context, officialUrl: "https://other.example/" })).toBeNull();
    expect(classifyPublicEntryDisclosure(entry, { ...context, currentUrl: "https://official.example/new" })).toBeNull();
  });
  it("requires immediate exact revalidation and cannot revive an old or copied proof", () => {
    const proof = classifyPublicEntryDisclosure(entry, context)!;
    for (const delta of [{ text: "Reserve Your Simulator" }, { rawHref: entry.href }, { documentStartedAt: 1100 }, { href: "https://official.example/other" }, { visible: false }])
      expect(revalidatePublicEntryDisclosure(proof, { ...entry, observedAt: 1950, ...delta }, context)).toBe(false);
    expect(revalidatePublicEntryDisclosure({ ...proof, observedAt: 2001 }, entry, context)).toBe(false);
    expect(revalidatePublicEntryDisclosure({ ...proof, selector: "a" } as typeof proof, entry, context)).toBe(false);
    expect(revalidatePublicEntryDisclosure(proof, { ...entry, observedAt: 7100 }, { ...context, now: 7100, deadline: 8000 })).toBe(false);
  });
});
