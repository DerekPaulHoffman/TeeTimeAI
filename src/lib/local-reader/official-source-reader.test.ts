import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOfficialSourceContextKey, officialSourceJobSchema, validateOfficialSourceResult, type OfficialSourceJob, type OfficialSourcePage, type OfficialSourceResult } from "./official-source-contracts";
import { discoverFromOfficialSource } from "./official-source-discovery";
import { signLocalReaderPayload, verifyLocalReaderSignature } from "./contracts";
import { resolveProviderCapability } from "@/lib/automation/provider-capabilities";

const source = readFileSync(resolve("tools/local-chrome-reader/official-source-reader.js"), "utf8");
const context = { URL, document, TeeTimeOfficialSourceReader: undefined as unknown as { readPage: (document: Document, url: string, expected: OfficialSourceJob["course"]) => OfficialSourcePage } };
runInNewContext(source, context);
const now = new Date("2026-09-09T19:00:00Z");
const fence = { batchId: "batch", leaseToken: "owner-lease", ownerThreadId: "owner", releaseSha: "a".repeat(40),
  runtimeVersion: "a".repeat(40), deployedAt: new Date("2026-09-09T18:00:00Z"), incidentId: "incident",
  courseId: "course", cycle: 14, stage: "RENDERED_BROWSER_DISCOVERY" as const };

const cases = [
  { name: "Johnny Goodman Golf Course", title: "Johnny Goodman Golf Course", street: "6111 S. 99th St.", page: "johnny-goodman-golf-course", facility: 13482, visibleFacility: 13482, website: "https://parks.cityofomaha.org/johnny-goodman-golf-course/" },
  { name: "Elmwood 18 Hole Golf Course", title: "Elmwood Golf Course", street: "6232 Pacific St.", page: "elmwoodgolf-course", facility: 13481, visibleFacility: 8336, website: "http://parks.cityofomaha.org/golf" },
  { name: "Benson Championship Golf Course", title: "Benson Golf Course", street: "5333 N 72nd St.", page: "bensongolf-course", facility: 13479, visibleFacility: 13479, website: "https://parks.cityofomaha.org/bensongolf-course/" },
];
function fixture(row = cases[0]) {
  const zip = row === cases[0] ? "68127" : row === cases[1] ? "68106" : "68134";
  const course = { id: "course", name: row.name, address: `${row.street.replaceAll(".", "")}, Omaha, NE ${zip}, USA`, city: "Omaha", stateCode: "NE", timeZone: "America/Chicago", website: row.website };
  const job = officialSourceJobSchema.parse({ id: "job", purpose: "OFFICIAL_SOURCE_DISCOVERY", courseKey: "official-source:parks.cityofomaha.org",
    course, sourceUrl: course.website.replace("http:", "https:"), contextKey: createOfficialSourceContextKey({ fence, course, providerSnapshotFingerprint: "b".repeat(64) }),
    requestedAt: new Date(now.getTime() - 60_000).toISOString(), expiresAt: new Date(now.getTime() + 240_000).toISOString() });
  return { job, row };
}
function read(row: typeof cases[number], course: OfficialSourceJob["course"], extra = "") {
  document.body.innerHTML = `<span class="elementor-heading-title">${row.title.toLowerCase()}</span>
    <span class="elementor-heading-title">${row.title}</span>
    <a href="https://www.google.com/maps/place/${row.name.replaceAll(" ", "+")}/@41,-96">${row.street}</a>
    <footer>Official Site Of City Of Omaha, NE Parks Department</footer>
    <a href="https://city-of-omaha.book.teeitup.com/?course=${row.visibleFacility}">Book A Tee Time</a>${extra}`;
  return context.TeeTimeOfficialSourceReader.readPage(document, `https://parks.cityofomaha.org/${row.page}/`, course);
}
function result(job: OfficialSourceJob, pages: OfficialSourcePage[]): OfficialSourceResult {
  return { purpose: "OFFICIAL_SOURCE_DISCOVERY", jobId: job.id, contextKey: job.contextKey,
    readerVersion: "official-source-v1", observedAt: now.toISOString(), pages };
}
afterEach(() => { document.body.innerHTML = ""; vi.useRealTimers(); });

describe("official-page reading through signed source validation and existing directory discovery", () => {
  it.each(cases)("resolves $name including its historical visible selector", async row => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const { job } = fixture(row);
    const pages: OfficialSourcePage[] = [];
    if (row === cases[1]) {
      document.body.innerHTML = `<h2>Omaha's Premier Golf Courses</h2>
        <a href="/elmwoodgolf-course/">  <img alt="Elmwoodgolf Course">  </a>
        <a href="/johnny-goodman-golf-course/">Johnnygoodman golf Course</a>`;
      pages.push(context.TeeTimeOfficialSourceReader.readPage(document, "https://parks.cityofomaha.org/golf-course/", job.course));
      expect(pages[0].nextUrls).toEqual(["https://parks.cityofomaha.org/elmwoodgolf-course/"]);
      expect(pages[0].bookingLinks).toEqual([]);
    }
    pages.push(read(row, job.course));
    const sourceResult = result(job, pages);
    const body = JSON.stringify(sourceResult);
    expect(body).not.toContain("Official Site Of");
    const secret = "test-only-source-secret";
    expect(verifyLocalReaderSignature(secret, body, signLocalReaderPayload(secret, body))).toBe(true);
    expect(verifyLocalReaderSignature(secret, body + " ", signLocalReaderPayload(secret, body))).toBe(false);
    validateOfficialSourceResult(job, sourceResult, now);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json([{ id: row.facility,
      name: row === cases[2] ? "Benson Park Golf Course" : row.title,
      address: row === cases[0] ? "6111 S. 99th St, Omaha, NE 68127, US" : row === cases[1]
        ? "6232 Pacific St. , Omaha, NE 68106, US" : "5333 N 72nd St. , Omaha, NE 68134, US", timeZone: job.course.timeZone }]));
    const discovered = await discoverFromOfficialSource({ job, result: sourceResult, cycle: fence.cycle,
      runtimeVersion: fence.runtimeVersion, stage: fence.stage, now, fetchImpl,
      runWithProviderLease: async (_family, worker) => ({ acquired: true, value: await worker() }) });
    expect(discovered.status).toBe("OBSERVED");
    if (discovered.status !== "OBSERVED") throw new Error("Discovery missing");
    if (row === cases[2]) {
      // Live directory calls it Benson Park, while retained identity says
      // Championship. Source reading must not silently waive that mismatch.
      expect(discovered.discovery.apiMetadata).toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledOnce();
      return;
    }
    expect(discovered.discovery.apiMetadata).toMatchObject({ facilityIds: [row.facility] });
    expect(discovered.discovery.evidence.officialSourceReader).toMatchObject({ contextKey: job.contextKey });
    expect(discovered.evidence.browserInvestigation.bookingNavigationAttempts).toBe(0);
    expect(resolveProviderCapability({ detectedPlatform: discovered.discovery.detectedPlatform,
      detectedBookingUrl: discovered.discovery.bookingUrl, bookingMetadata: discovered.discovery.apiMetadata }).isRunnable).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(["batchId", "leaseToken", "ownerThreadId", "incidentId", "cycle", "stage", "deployedAt"] as const)("binds source work to %s", key => {
    const { job } = fixture();
    const changed = { ...fence, [key]: key === "cycle" ? 15 : key === "deployedAt" ? new Date(0) : "changed" };
    expect(createOfficialSourceContextKey({ fence: changed as typeof fence, course: job.course, providerSnapshotFingerprint: "b".repeat(64) })).not.toBe(job.contextKey);
  });
  it.each(["wrong job", "wrong context", "expired", "future", "unlinked page", "wrong address", "wrong course", "unsafe link", "raw text"])("rejects %s", scenario => {
    const { job, row } = fixture(); const page = read(row, job.course); const value = result(job, [page]);
    if (scenario === "wrong job") value.jobId = "other";
    if (scenario === "wrong context") value.contextKey = "c".repeat(64);
    if (scenario === "expired") job.expiresAt = now.toISOString();
    if (scenario === "future") value.observedAt = new Date(now.getTime() + 1).toISOString();
    if (scenario === "unlinked page") value.pages.push({ ...page, pageUrl: "https://parks.cityofomaha.org/unlinked/" });
    if (scenario === "wrong address") page.street = "900 other road";
    if (scenario === "wrong course") page.courseName = "Other Golf Course";
    if (scenario === "unsafe link") page.bookingLinks[0].url += "&token=private";
    if (scenario === "raw text") Object.assign(page, { visibleText: "raw body" });
    expect(() => validateOfficialSourceResult(job, value, now)).toThrow();
  });
  it("does not mix a sibling course address with the requested course heading", () => {
    const { job } = fixture();
    const page = read(cases[1], job.course);
    expect(page.courseName).toBeNull(); expect(page.bookingLinks).toEqual([]);
  });
  it("does not inspect hidden headings or activate links, forms, or challenges", () => {
    const { job, row } = fixture();
    read(row, job.course);
    document.querySelectorAll(".elementor-heading-title").forEach(node => node.setAttribute("hidden", ""));
    const clicked = vi.fn(); document.querySelector("a")!.addEventListener("click", clicked);
    expect(context.TeeTimeOfficialSourceReader.readPage(document, job.sourceUrl, job.course).courseName).toBeNull();
    document.body.innerHTML = `<h1>Verify you are human</h1><form><input type="password"></form>`;
    const page = context.TeeTimeOfficialSourceReader.readPage(document, job.sourceUrl, job.course);
    expect(page.status).toBe("ACCESS_RESTRICTED"); expect(page.nextUrls).toEqual([]); expect(clicked).not.toHaveBeenCalled();
  });
  it.each(["wrong street", "wrong map name", "wrong host", "wrong heading"])("rejects a shortened title with %s", scenario => {
    const { job, row } = fixture(cases[2]);
    read(row, job.course);
    const map = document.querySelector('a[href*="google.com"]')!;
    if (scenario === "wrong street") map.textContent = "900 Other Road";
    if (scenario === "wrong map name") map.setAttribute("href", "https://www.google.com/maps/place/Benson+Executive+Golf+Course/@41,-96");
    if (scenario === "wrong host") map.setAttribute("href", "https://google.com.evil.example/maps/place/Benson+Championship+Golf+Course/@41,-96");
    if (scenario === "wrong heading") document.querySelectorAll(".elementor-heading-title").forEach(node => { node.textContent = "Benson Executive Golf Course"; });
    const page = context.TeeTimeOfficialSourceReader.readPage(document, job.sourceUrl, job.course);
    expect(page.courseName).toBeNull(); expect(page.bookingLinks).toEqual([]);
  });
});
