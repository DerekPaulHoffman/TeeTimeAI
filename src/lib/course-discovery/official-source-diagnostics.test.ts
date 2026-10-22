import { describe, expect, it, vi } from "vitest";
import { discoveryNavigationFailureKind, officialSourceBooleanKeys, officialSourceStages, safeOfficialSourceDiagnostic } from "./official-source-diagnostics";
import { deriveUScheduleOfficialLocation } from "@/lib/simulators/providers/uschedule-location-source";
import { inspectExistingAdapter } from "./existing-adapter-executor";
import { venueProofMatches } from "./executor";
import { createDiscoverySnapshotCompactor, discoveryBrowserFeedback, readDiscoveryControllerCheckpoint, safeBrowserFailureDiagnostics } from "../../../scripts/automation/course-discovery-worker.mjs";

const entry = "https://clients.uschedule.com/examplegolf/booking?filter=loc[82]";
const source = { officialUrl: "https://example.org/", bookingUrl: entry, venueName: "Example Indoor Golf Club", venueAddress: "10 Main Street, Example, WA 98000, USA", timeZone: "America/Los_Angeles" };
const page = () => ({ url: source.officialUrl, html: `<h1>${source.venueName}</h1><p>${source.venueAddress}</p><a href="${entry}">Tee Time</a>`,
  visibleEvidence: { title: source.venueName, headings: [source.venueName], linkUrls: [entry], addressTexts: [source.venueAddress] } });
describe("closed official-source diagnostics", () => {
  it("projects copied primitive facts only, never markup, URLs, tokens or unknown keys", () => {
    const input = { stage: "RAW_ADDRESS", rawOfficialCaptured: true, rawAddressMatches: false, renderedAddressMatches: "true", unknown: true, html: "private", url: "https://private.example/secret" };
    const result = safeOfficialSourceDiagnostic(input)!;
    expect(result).toEqual({ stage: "RAW_ADDRESS", rawOfficialCaptured: true, rawAddressMatches: false });
    input.rawOfficialCaptured = false; expect(result.rawOfficialCaptured).toBe(true);
    for (const stage of [["RAW_ADDRESS"], {}, "private", null]) expect(safeOfficialSourceDiagnostic({ ...input, stage })).toBeUndefined();
  });
  it.each(["RAW_VENUE", "RAW_LINK", "RAW_ADDRESS", "RENDERED_VENUE", "RENDERED_LINK", "RENDERED_ADDRESS"] as const)("reports exact rejected %s without changing the original guard result", stage => {
    const document = page();
    if (stage === "RAW_VENUE") document.html = document.html.replace(source.venueName, "Other Venue");
    if (stage === "RAW_LINK") document.html = document.html.replace(entry, "https://other.example.org/");
    if (stage === "RAW_ADDRESS") document.html = document.html.replace(source.venueAddress, "99 Other Road, Other, WA 98000, USA");
    if (stage === "RENDERED_VENUE") document.visibleEvidence.headings = [];
    if (stage === "RENDERED_LINK") document.visibleEvidence.linkUrls = [];
    if (stage === "RENDERED_ADDRESS") document.visibleEvidence.addressTexts = [];
    const diagnostics: unknown[] = [];
    expect(() => deriveUScheduleOfficialLocation(source, document, true, value => diagnostics.push(value))).toThrow("USCHEDULE_PUBLIC_LOCATION_UNVERIFIED");
    expect(diagnostics.at(-1)).toMatchObject({ stage });
    expect(JSON.stringify(diagnostics)).not.toMatch(/https:|private|Main Street|Other Road|<h1>/u);
  });
  it("retains derivation rejection rather than only the resulting legacy filtered-source error", async () => {
    const document = page(); document.visibleEvidence.addressTexts = [];
    const fetch = vi.fn<typeof globalThis.fetch>(), onOfficialSourceDiagnostic = vi.fn();
    await expect(inspectExistingAdapter(source, { venueMatches: venueProofMatches, officialIdentityPage: document, fetch, onOfficialSourceDiagnostic })).rejects.toThrow("INVALID_ADAPTER_SOURCE");
    expect(onOfficialSourceDiagnostic.mock.lastCall?.[0]).toMatchObject({ stage: "RENDERED_ADDRESS", rawVenueMatches: true, rawLinkMatches: true, rawAddressMatches: true,
      renderedVenueMatches: true, renderedLinkMatches: true, renderedAddressMatches: false, derivationRejected: true, legacyFallback: true });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("inert warm derivation never claims skipped rendered checks, and throwing callbacks cannot affect validation", () => {
    const values: unknown[] = [], document = page();
    deriveUScheduleOfficialLocation(source, { ...document, visibleEvidence: undefined }, false, value => values.push(value));
    expect(JSON.stringify(values)).not.toMatch(/rendered(?:Venue|Link|Address)Matches|officialProvenance/u);
    const expected = deriveUScheduleOfficialLocation(source, document);
    expect(deriveUScheduleOfficialLocation(source, document, true, () => { throw new Error("PRIVATE_CALLBACK_FAILURE"); })).toEqual(expected);
    document.visibleEvidence.addressTexts = [];
    expect(() => deriveUScheduleOfficialLocation(source, document, true, () => { throw new Error("PRIVATE_CALLBACK_FAILURE"); })).toThrow("USCHEDULE_PUBLIC_LOCATION_UNVERIFIED");
  });
  it("safe worker projection preserves closed diagnostics through feedback/checkpoint/compaction", () => {
    const malicious = { officialSourceDiagnostic: { stage: "RENDERED_ADDRESS", renderedAddressMatches: false, rawAddressMatches: true, html: "private-body", token: "private-token", extra: [] },
      navigationFailureKind: "ABORTED", url: source.officialUrl, text: "Public page", loading: false, requests: [], controls: [], elements: [], frames: [], responses: [] };
    const safe = safeBrowserFailureDiagnostics(malicious);
    expect(safe.officialSourceDiagnostic).toEqual({ stage: "RENDERED_ADDRESS", renderedAddressMatches: false, rawAddressMatches: true });
    const feedback = discoveryBrowserFeedback(safe, "inspect_adapter", { code: "INVALID_ADAPTER_SOURCE" });
    const checkpoint = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: source.officialUrl, observedNavigationUrls: [], lastFeedback: feedback } }, source.officialUrl);
    expect(checkpoint.lastFeedback.details.officialSourceDiagnostic).toEqual(safe.officialSourceDiagnostic);
    expect(checkpoint.lastFeedback.details.navigationFailureKind).toBe("ABORTED");
    const compact = createDiscoverySnapshotCompactor(); for (let index = 0; index < 4; index++) expect(JSON.stringify(compact(malicious))).not.toMatch(/private|html|token/u);
    for (const stage of officialSourceStages) expect(safeBrowserFailureDiagnostics({ officialSourceDiagnostic: { stage } }).officialSourceDiagnostic).toEqual({ stage });
    for (const key of officialSourceBooleanKeys) expect(safeBrowserFailureDiagnostics({ officialSourceDiagnostic: { stage: "CONTROLLER_CAPTURE", [key]: true } }).officialSourceDiagnostic[key]).toBe(true);
    expect(safeBrowserFailureDiagnostics({ officialSourceDiagnostic: { stage: ["RAW_ADDRESS"] }, navigationFailureKind: ["ABORTED"] })).not.toHaveProperty("officialSourceDiagnostic");
  });
  it.each([["TimeoutError", "page.goto: Timeout 30000ms exceeded private-url", "TIMEOUT"], ["Error", "page.goto: net::ERR_ABORTED at private-url", "ABORTED"],
    ["Error", "net::ERR_NAME_NOT_RESOLVED", "DNS"], ["Error", "net::ERR_CERT_AUTHORITY_INVALID", "TLS"], ["Error", "net::ERR_CONNECTION_RESET", "NETWORK"],
    ["Error", "Target page, context or browser has been closed", "CLOSED"], ["Error", "private arbitrary message", "UNKNOWN"]])("classifies only navigation category %s %s", (name, message, category) => {
    const error = new Error(message); error.name = name;
    expect(discoveryNavigationFailureKind(error)).toBe(category);
    expect(discoveryNavigationFailureKind({ message })).toBe("UNKNOWN");
  });
});
