// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { CPS_API_PATH, CPS_PUBLIC_BUILD, parseCpsCatalog, parseCpsConfiguration, parseCpsOptions } from "./cps-source";
import { cpsAvailabilityQuery, cpsBootstrapReadAllowed, cpsLocalInstant, executeCps, inspectCps, normalizeCpsAvailability, decodeCpsOfficialHtml, type CpsDependencies } from "./cps-executor";
import { readNativeOfficialIdentityPage } from "./native-official-page-reader";
import type { PublicCourseContactBlock } from "./public-course-contact-blocks";

const source = { officialUrl: "https://www.thebobgc.com/", bookingUrl: "https://thebobgcpa.cps.golf/", venueName: "Bob O'Connor Golf Course",
  venueAddress: "5370 Schenley Dr, Pittsburgh, PA 15217, USA", timeZone: "America/New_York" };
const input = { date: "2026-10-23", players: 2, startTime: "08:00", endTime: "18:00", timeZone: source.timeZone };
const uuid = "00000000-0000-4000-8000-000000000001";
const config = () => ({ siteName: "thebobgcpa", onlineApi: "https://thebobgcpa.cps.golf" + CPS_API_PATH,
  authorityBaseUrl: "https://thebobgcpa.cps.golf/identityapi", clientId: "public-client", websiteId: "00000000-0000-0000-0000-000000000000",
  apiKey: "syntheticPublishedKey", buildNumber: CPS_PUBLIC_BUILD });
const options = () => ({ webSiteId: "public-site", courseOptions: [{ courseId: 1, courseName: source.venueName, webSiteId: "public-site" }], reservationOptions: { terminalId: 1 } });
const courses = () => [{ courseId: 1, courseName: source.venueName, timezoneId: source.timeZone, websiteId: "public-site", active: true as const, holes: 9 as const }];
const metadata = () => parseCpsCatalog(courses(), parseCpsOptions(options(), parseCpsConfiguration(config(), source)), source);
const row = (id = 7) => ({ teeSheetId: id, courseId: 1, startTime: "2026-10-23T10:30:00", availableParticipantNo: [1, 2, 3, 4], holes: 9 as const, minPlayer: 1 });
const envelope = (rows: unknown[] = [row()], transactionId = uuid) => ({ isSuccess: true, transactionId, content: rows });
const footer = "<footer>© 2022 Bob O'Connor Golf Course | 5370 Schenley Drive | Pittsburgh, PA 15217 | Phone: 412.622.6959</footer>";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
type Change = (url: URL, init: RequestInit, normal: () => Response) => Response | Promise<Response>;
function setup(change?: Change) {
  const reads: Array<{ url: URL; init: RequestInit }> = [], families: string[] = []; let active = 0, maxActive = 0, transactionId = "", sessions = 0;
  const deps: CpsDependencies = { now: () => new Date("2026-10-22T00:00:00Z"),
    requestLease: async <T>(family: string, work: () => Promise<T>) => {
      active++; maxActive = Math.max(maxActive, active); families.push(family);
      try { return { acquired: true as const, value: await work() }; } finally { active--; }
    },
    fetch: (async (value, rawInit = {}) => {
      expect(active).toBe(1); const url = new URL(String(value)), init = rawInit;
      reads.push({ url, init });
      const normal = () => {
        if (url.pathname === "/onlineresweb/assets/env.js") return new Response('(function(window){window.__env=window.__env||{};window.__env.AUTH_CLIENT_ID="unused-account-client";window.__env.SHORT_LIVED_CLIENT_ID="separate-public-startup-client";window.__env.PRODUCTION="true";})(this);',{headers:{"content-type":"text/javascript"}});
        if (url.pathname === "/identityapi/myconnect/token/short") {
          sessions++; return json({ access_token: `synthetic-public-short-session-${sessions}`, token_type: "Bearer", expires_in: 60 });
        }
        if (url.hostname === "thebobgc.com") return new Response(null, { status: 301, headers: { location: source.officialUrl } });
        if (url.hostname === "www.thebobgc.com") {
          if (url.pathname === "/teetimes") return new Response(null, { status: 302, headers: { location: "/bookteetimes" } });
          return new Response(`<body>${url.pathname === "/" ? '<a href="/teetimes">Book a Tee Time</a>' : `<iframe src="${source.bookingUrl}" title="Book a Tee Time"></iframe>`}${footer}</body>`, { headers: { "content-type": "text/html" } });
        }
        if (url.pathname.endsWith("/Configuration")) return json(config());
        if (url.pathname.includes("/GetAllOptions/")) return json(options());
        if (url.pathname.endsWith("/OnlineCourses")) return json(courses());
        if (url.pathname.endsWith("/RegisterTransactionId")) { transactionId = JSON.parse(String(init.body)).transactionId; return json(true); }
        if (url.pathname.endsWith("/TeeTimes")) {
          expect(url.searchParams.get("transactionId")).toBe(transactionId);
          const date = new Date(url.searchParams.get("searchDate")!).toISOString().slice(0, 10);
          return json(envelope([{ ...row(), startTime: date + "T10:30:00" }], transactionId));
        }
        throw new Error("UNEXPECTED_TEST_REQUEST");
      };
      return change ? change(url, init, normal) : normal();
    }) as typeof fetch };
  return { deps, reads, families, get active() { return active; }, get maxActive() { return maxActive; }, get sessions() { return sessions; } };
}
const execute = (deps: CpsDependencies, request = input) => executeCps(source, metadata(), { courseId: "course-1" }, request, deps);

describe("CPS fixed fresh public reads", () => {
  it("uses only explicit supported WHATWG HTML charset labels and preserves exact decoded punctuation", () => {
    const bytes = Uint8Array.from([60,112,62,0x93,0x63,0x61,0x66,0xe9,0x94,60,47,112,62]).buffer;
    for (const label of ["windows-1252", "ISO-8859-1", "latin1", "cp1252", "us-ascii"])
      expect(decodeCpsOfficialHtml(bytes, `text/html; charset=${label}`)).toBe("<p>“café”</p>");
    const utf8 = new TextEncoder().encode("<p>Public café</p>").buffer;
    for (const type of ["text/html", "text/html; charset=utf-8", 'text/html; charset="UTF8"'])
      expect(decodeCpsOfficialHtml(utf8, type)).toBe("<p>Public café</p>");
    const bom = Uint8Array.from([239,187,191,...new TextEncoder().encode("<p>Public</p>")]).buffer;
    expect(decodeCpsOfficialHtml(bom, "text/html")).toBe("<p>Public</p>");
    expect(decodeCpsOfficialHtml(bom, "text/html; charset=utf-8")).toBe("<p>Public</p>");
  });
  it("rejects ambiguous unsupported or malformed HTML encodings rather than guessing", () => {
    const invalidUtf8 = Uint8Array.from([0xc3,0x28]).buffer;
    for (const type of ["text/html", "text/html; charset=utf-8"])
      expect(() => decodeCpsOfficialHtml(invalidUtf8, type)).toThrow(TypeError);
    for (const type of ['text/html; charset=""', "text/html; charset=unknown", "text/html; charset=utf-16", "text/html; charset=shift_jis",
      "text/html; charset=utf-8; charset=ISO-8859-1", "text/html; charset=utf-8; charset=utf-8", "text/html; charset=utf-8,iso-8859-1",
      "text/html; charset=", 'text/html; charset="ISO-8859-1', "text/html; charset=ISO-8859-1\r\n", "text/html; " + "x".repeat(512), "application/json; charset=ISO-8859-1"])
      expect(() => decodeCpsOfficialHtml(invalidUtf8, type)).toThrow("ADAPTER_RESPONSE_INVALID");
    for (const bom of [[255,254,60,0],[254,255,0,60]])
      expect(() => decodeCpsOfficialHtml(Uint8Array.from(bom).buffer, "text/html; charset=ISO-8859-1")).toThrow("ADAPTER_RESPONSE_INVALID");
    expect(() => decodeCpsOfficialHtml(Uint8Array.from([239,187,191,60,112,62]).buffer, "text/html; charset=ISO-8859-1")).toThrow("ADAPTER_RESPONSE_INVALID");
    expect(() => decodeCpsOfficialHtml(new ArrayBuffer(600001), "text/html; charset=ISO-8859-1")).toThrow("ADAPTER_RESPONSE_LIMIT");
  });
  it("does not apply HTML charset decoding to malformed public JSON or waive official identity", async () => {
    const malformed = setup((url, _init, normal) => url.pathname.endsWith("/Configuration")
      ? new Response(Uint8Array.from([123,34,120,34,58,34,0xe9,34,125]), { headers: { "content-type": "application/json; charset=ISO-8859-1" } }) : normal());
    await expect(inspectCps(source, malformed.deps)).rejects.toThrow(TypeError);
    expect(malformed.reads).toHaveLength(4); expect(malformed.active).toBe(0);
    const wrong = setup((url, _init, normal) => url.hostname === "www.thebobgc.com"
      ? new Response(Buffer.from(`<body>Another Public Course ${footer.replace(source.venueName, "Another Public Course")}</body>`, "latin1"), { headers: { "content-type": "text/html; charset=ISO-8859-1" } }) : normal());
    await expect(inspectCps(source, wrong.deps)).rejects.toThrow("OFFICIAL_IDENTITY_UNVERIFIED");
    expect(wrong.reads).toHaveLength(1); expect(wrong.active).toBe(0);
  });
  it("reads explicitly declared Latin-1 official HTML on cold and changed-parameter warm calls without extra requests", async () => {
    const fixture = setup(async (url, _init, normal) => {
      const response = normal();
      if (url.hostname !== "www.thebobgc.com" || response.status !== 200) return response;
      return new Response(Buffer.from(await response.text(), "latin1"), { headers: { "content-type": "text/html;  charset=ISO-8859-1" } });
    });
    const saved = await inspectCps(source, fixture.deps);
    expect(saved).toEqual(metadata()); expect(fixture.reads).toHaveLength(6);
    fixture.reads.length = 0;
    const result = await executeCps(source, saved, { courseId: "course-1" }, { ...input, date: "2026-10-24", players: 3 }, fixture.deps);
    expect(result).toHaveLength(1); expect(result[0].startsAt).toBe("2026-10-24T14:30:00.000Z");
    expect(fixture.reads).toHaveLength(8); expect(fixture.active).toBe(0); expect(fixture.maxActive).toBe(1);
    expect(fixture.reads.every(read => read.init.credentials === "omit" && read.init.redirect === "manual")).toBe(true);
  });
  it.each(["26.1.2.26379768992", "26.3.0.34794395074", "26.3.1.40424176516"].flatMap(buildNumber =>
    [undefined, "injected-published-key"].map(apiKey => ({ buildNumber, apiKey }))))("uses a fresh reviewed public RAM session and never an injected key/account token ($buildNumber, $apiKey)",async ({buildNumber, apiKey})=>{
    const fixture=setup((url,_init,normal)=>url.pathname.endsWith("/Configuration")
      ?json({...config(),buildNumber:buildNumber+"\n",apiKey,authorization:"Bearer untrusted-input",accessToken:"untrusted-input"}):
      buildNumber === "26.1.2.26379768992" && url.pathname.includes("/GetAllOptions/") ? json({ ...options(), reservationOptions: {
        ...options().reservationOptions, clubName: source.venueName, clubAddress: source.venueAddress } }) : normal());
    const saved=await inspectCps(source,fixture.deps);
    const inspectionReads=fixture.reads.length;
    expect(await executeCps(source,saved,{courseId:"course-1"},input,fixture.deps)).toHaveLength(1);
    expect(fixture.reads.length-inspectionReads).toBe(10); // Three official reads + two public startup reads + five API reads.
    expect(fixture.sessions).toBe(2);expect(fixture.maxActive).toBe(1);expect(fixture.active).toBe(0);
    expect(JSON.stringify(saved)).not.toMatch(/synthetic-public|untrusted-input|injected-published/u);
    const bootstrap=fixture.reads.filter(read=>read.url.pathname==="/identityapi/myconnect/token/short");expect(bootstrap).toHaveLength(2);
    for(const read of bootstrap){const headers=new Headers(read.init.headers);expect(read.init.method).toBe("POST");expect(read.init.credentials).toBe("omit");expect(read.init.redirect).toBe("manual");
      expect(headers.has("authorization")).toBe(false);expect(headers.has("cookie")).toBe(false);expect(headers.has("x-apikey")).toBe(false);
      const form=await new Response(read.init.body,{headers:{"content-type":headers.get("content-type")!}}).formData();expect([...form.entries()]).toEqual([["client_id","separate-public-startup-client"]]);}
    expect(fixture.reads.filter(read=>read.url.pathname==="/onlineresweb/assets/env.js")).toHaveLength(2);
    const apiReads=fixture.reads.filter(read=>read.url.pathname.includes(CPS_API_PATH));expect(apiReads.length).toBeGreaterThan(3);
    for(const read of apiReads){const headers=new Headers(read.init.headers);expect(headers.get("authorization")).toMatch(/^Bearer synthetic-public-short-session-[12]$/u);expect(headers.has("x-apikey")).toBe(false);
      expect(headers.get("client-id")).toBe("public-client");expect(headers.get("x-websiteid")).toMatch(/^(?:public-site|00000000-0000-0000-0000-000000000000)$/u);
      expect(headers.get("x-timezoneid")).toBe(source.timeZone);}
    expect(apiReads.filter(read=>read.url.pathname.includes("/GetAllOptions/")).every(read=>read.url.searchParams.get("version")===buildNumber)).toBe(true);
  });
  it("rejects a newly unreviewed build before any anonymous startup or API role", async () => {
    const fixture = setup((url, _init, normal) => url.pathname.endsWith("/Configuration")
      ? json({ ...config(), buildNumber: "26.1.2.26379768993", apiKey: undefined }) : normal());
    await expect(inspectCps(source, fixture.deps)).rejects.toThrow("CPS_PUBLIC_BUILD_UNSUPPORTED");
    expect(fixture.sessions).toBe(0); expect(fixture.active).toBe(0);
    expect(fixture.reads.some(read=>read.url.pathname.includes("/GetAllOptions/") || read.url.pathname.endsWith("/env.js"))).toBe(false);
  });
  it("freshly revalidates the venue-bound public set on changed-date/party reuse and rejects catalog, build or official-source changes", async () => {
    let changedLegacy = false, changedBuild = false, changedAddress = false;
    const fixture = setup((url, _init, normal) => {
      if (url.pathname.endsWith("/Configuration")) return json({ ...config(), apiKey: undefined,
        buildNumber: changedBuild ? "26.3.0.34794395074" : "26.1.2.26379768992" });
      if (url.pathname.includes("/GetAllOptions/")) return json({ ...options(), courseOptions: [
        { courseId: 7, courseName: changedLegacy ? "Changed Legacy" : "Legacy Back", webSiteId: "public-site" },
        { courseId: 1, courseName: "Front 9", webSiteId: "public-site" },
      ], reservationOptions: { ...options().reservationOptions, clubName: source.venueName, clubAddress: source.venueAddress } });
      if (url.pathname.endsWith("/OnlineCourses")) return json([{ ...courses()[0], courseName: "Front 9" }]);
      if (changedAddress && url.hostname === "www.thebobgc.com") return new Response(`<body>${footer.replace("5370", "5371")}<a href="${source.bookingUrl}">Tee Times</a></body>`, { headers: { "content-type": "text/html" } });
      return normal();
    });
    const saved = await inspectCps(source, fixture.deps), immutable = JSON.stringify(saved);
    expect(saved.publicCatalogMode).toBe("VENUE_BOUND_ONLINE_COURSES"); expect(saved.courseIds).toEqual([1]);
    expect((await executeCps(source, saved, { courseId: "course-1" }, input, fixture.deps))).toHaveLength(1);
    expect((await executeCps(source, saved, { courseId: "course-1" }, { ...input, date: "2026-10-24", players: 3 }, fixture.deps))[0].startsAt).toBe("2026-10-24T14:30:00.000Z");
    expect(JSON.stringify(saved)).toBe(immutable); expect(fixture.sessions).toBe(3); expect(fixture.active).toBe(0);
    for (const change of ["catalog", "build", "official"] as const) {
      fixture.reads.length = 0; changedLegacy = change === "catalog"; changedBuild = change === "build"; changedAddress = change === "official";
      await expect(executeCps(source, saved, { courseId: "course-1" }, input, fixture.deps)).rejects.toThrow(change === "official" ? "OFFICIAL_IDENTITY_UNVERIFIED" : "ADAPTER_CONFIGURATION_CHANGED");
      expect(fixture.reads.some(read => read.url.pathname.endsWith("/RegisterTransactionId") || read.url.pathname.endsWith("/TeeTimes"))).toBe(false);
      expect(fixture.active).toBe(0);
    }
  });
  it("revalidates native postal contacts and full catalog on every cold/warm call outside the provider lease, preserving semantic identity across nonces", async () => {
    const fixture=setup((url,_init,normal)=>url.hostname==="www.thebobgc.com"?new Response("public transport rejected",{status:403}):
      url.pathname.endsWith("/Configuration")?json({...config(),buildNumber:"26.3.0.34794395074\n",apiKey:undefined}):normal());
    let calls=0,wrongPhone=false;
    const contact:PublicCourseContactBlock={venueName:source.venueName,street:"5370 Schenley Drive",locality:"Pittsburgh",region:"PA",postalCode:"15218",country:"US",phone:"412-622-6959"};
    const nativeRead:CpsDependencies["readNativeOfficialPage"]=async(identity,pageUrl,until)=>{
      expect(fixture.active).toBe(0);calls++;const c={...contact,phone:wrongPhone?"412-622-9999":contact.phone};
      const html=`<html><body><script nonce="nonce-${calls}">var n=${calls};</script><a href="${source.bookingUrl}">Tee Times</a><section class="h-card"><h4 class="p-name">${c.venueName}</h4><div class="h-adr"><strong>Physical Address</strong><span class="p-street-address">${c.street}</span><span class="p-locality">${c.locality}</span><span class="p-region">${c.region}</span><span class="p-postal-code">${c.postalCode}</span></div><div class="p-tel">${c.phone}</div></section></body></html>`;
      return readNativeOfficialIdentityPage(identity,pageUrl,until,{createSession:async()=>({execute:async()=>({url:source.officialUrl,navigationStatus:200,browserTransport:"NATIVE_CHROME",officialSourceDiagnostic:{stage:"CONTROLLER_CAPTURE",rawOfficialCaptured:true,currentOfficialDocument:true,officialProvenance:true,renderedAddressesPresent:true,renderedLinksPresent:true}}as never),readOfficialIdentityPage:async()=>({url:source.officialUrl,html,browserTransport:"NATIVE_CHROME",visibleEvidence:{title:source.venueName,headings:[source.venueName],addressTexts:[`${c.street}, ${c.locality}, ${c.region} ${c.postalCode}`],linkUrls:[source.bookingUrl],publicContactBlocks:[c]}}),close:async()=>{}})});
    };
    const deps:CpsDependencies={...fixture.deps,trustedContext:{canonicalCoursePhone:"+14126226959"},localCapabilities:["LOCAL_CHROME"],readNativeOfficialPage:nativeRead};
    const saved=await inspectCps(source,deps);expect(saved.officialPostalConflictProof).toMatchObject({canonicalPostalCode:"15217",officialPostalCode:"15218",canonicalCoursePhone:"+14126226959"});
    expect(calls).toBe(1);expect((await executeCps(source,saved,{courseId:"course-1"},input,deps))).toHaveLength(1);expect(calls).toBe(2);
    expect(fixture.sessions).toBe(2);
    fixture.reads.length=0;
    await expect(executeCps(source,saved,{courseId:"course-1"},input,{...deps,localCapabilities:[]})).rejects.toThrow("LOCAL_CHROME_REQUIRED");expect(fixture.reads).toHaveLength(0);
    await expect(executeCps(source,saved,{courseId:"course-1"},input,{...deps,trustedContext:{canonicalCoursePhone:"+14126229999"}})).rejects.toThrow("CPS_CANONICAL_PHONE_CHANGED");expect(fixture.reads).toHaveLength(0);
    wrongPhone=true;await expect(executeCps(source,saved,{courseId:"course-1"},input,deps)).rejects.toThrow("CPS_POSTAL_CONFLICT_UNVERIFIED");
    expect(fixture.reads.some(read=>read.init.method==="POST")).toBe(false);expect(fixture.active).toBe(0);
  });
  it("uses an address-free official phone and booking link only through a fresh native reader on cold and warm calls", async () => {
    const fixture = setup((url, _init, normal) => url.hostname === "www.thebobgc.com"
      ? new Response("public transport rejected", { status: 403 }) : normal());
    let calls = 0, wrongPhone = false;
    const nativeRead: CpsDependencies["readNativeOfficialPage"] = async (identity, pageUrl, until, mode) => {
      expect(fixture.active).toBe(0);
      calls++;
      const printed = wrongPhone ? "412-622-9999" : "412-622-6959";
      const html = `<html><body><h1>${source.venueName}</h1><section><h2>CONTACT US</h2><a href="tel:${printed}">${printed}</a></section>
        <a href="${source.bookingUrl}">Book a Tee Time</a><script nonce="${calls}">var n=${calls}</script></body></html>`;
      return readNativeOfficialIdentityPage(identity, pageUrl, until, { allowCpsPhoneBookingContact: mode === "PHONE_LINK" ? true : undefined,
        createSession: async () => ({ execute: async () => ({ url: source.officialUrl, navigationStatus: 200, browserTransport: "NATIVE_CHROME",
          officialSourceDiagnostic: { stage: "CONTROLLER_CAPTURE", rawOfficialCaptured: true, currentOfficialDocument: true,
            officialProvenance: true, renderedHeadingsPresent: true, renderedAddressesPresent: false, renderedLinksPresent: true } } as never),
          readOfficialIdentityPage: async () => {
            if (mode !== "PHONE_LINK") throw new Error("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");
            return { url: source.officialUrl, html, browserTransport: "NATIVE_CHROME", visibleEvidence: {
              title: source.venueName, headings: [source.venueName, "CONTACT US"], addressTexts: [], linkUrls: [source.bookingUrl],
              phoneTexts: [printed], contactPhoneLinks: [{ href: `tel:${printed}`, text: printed }] } };
          }, close: async () => {} }) });
    };
    const deps: CpsDependencies = { ...fixture.deps, trustedContext: { canonicalCoursePhone: "+14126226959" },
      localCapabilities: ["LOCAL_CHROME"], readNativeOfficialPage: nativeRead };
    const saved = await inspectCps(source, deps);
    expect(saved.officialPhoneBookingProof).toMatchObject({ kind: "OFFICIAL_PHONE_BOOKING_LINK", canonicalAddressInput: source.venueAddress,
      canonicalCoursePhone: "+14126226959", courseIds: [1] });
    expect(saved.officialPostalConflictProof).toBeUndefined();
    expect(calls).toBe(2);
    expect(await executeCps(source, saved, { courseId: "course-1" }, input, deps)).toHaveLength(1);
    expect(calls).toBe(3);
    expect(await executeCps(source, saved, { courseId: "course-1" }, { ...input, date: "2026-10-24" }, deps)).toHaveLength(1);
    expect(calls).toBe(4);
    fixture.reads.length = 0;
    wrongPhone = true;
    await expect(executeCps(source, saved, { courseId: "course-1" }, input, deps)).rejects.toThrow("CPS_PHONE_BOOKING_SOURCE_UNVERIFIED");
    expect(fixture.reads.some(read => read.init.method === "POST")).toBe(false);
    expect(fixture.active).toBe(0);
  });
  it("independently replays the exact observed routing query without replacing canonical input or taking transaction actions", async () => {
    const queried = { ...source, bookingUrl: "https://thebobgcpa.cps.golf/onlineresweb/search-teetime?TeeOffTimeMin=0&TeeOffTimeMax=23.999722222222225" };
    const fixture = setup((url, _init, normal) => url.hostname === "www.thebobgc.com"
      ? new Response(`<body><a href="${queried.bookingUrl}">Book a Tee Time</a>${footer}</body>`, { headers: { "content-type": "text/html" } }) : normal());
    const saved = await inspectCps(queried, fixture.deps);
    expect(fixture.reads.every(read => read.init.method === "GET")).toBe(true);
    fixture.reads.length = 0;
    const slots = await executeCps(queried, saved, { courseId: "course-1" }, input, fixture.deps);
    expect(slots).toHaveLength(1); expect(slots[0].bookingUrl).toBe(queried.bookingUrl);
    expect(fixture.reads[0].url.href).toBe(source.officialUrl);
    expect(fixture.reads.filter(read => read.init.method === "POST").map(read => read.url.pathname)).toEqual([CPS_API_PATH + "/RegisterTransactionId"]);
    const availability = fixture.reads.at(-1)!.url;
    expect(availability.pathname).toBe(CPS_API_PATH + "/TeeTimes");
    expect(availability.searchParams.has("TeeOffTimeMin")).toBe(false);
    expect(availability.searchParams.get("searchDate")).toBe("Fri Oct 23 2026");
    expect(fixture.active).toBe(0);
    const mismatch = setup((url, _init, normal) => url.hostname === "www.thebobgc.com"
      ? new Response(`<body><a href="${source.bookingUrl}">Book a Tee Time</a>${footer}</body>`, { headers: { "content-type": "text/html" } }) : normal());
    await expect(inspectCps(queried, mismatch.deps)).rejects.toThrow("OFFICIAL_BOOKING_SOURCE_MISMATCH");
    expect(mismatch.reads).toHaveLength(1);
  });
  it("inspects without registration and rederives fresh official/config/catalog facts on each execution", async () => {
    const fixture = setup(), saved = await inspectCps(source, fixture.deps);
    expect(saved).toEqual(metadata()); expect(fixture.reads).toHaveLength(6); expect(fixture.reads.every(read => read.init.method === "GET")).toBe(true);
    fixture.reads.length = 0;
    const slots = await executeCps(source, saved, { courseId: "course-1" }, input, fixture.deps);
    expect(slots).toEqual([{ sourceId: "cps-thebobgcpa-7", startsAt: "2026-10-23T14:30:00.000Z", availableSpots: 4,
      bookingUrl: source.bookingUrl, resourceId: "cps-course:1", holes: 9 }]);
    expect(fixture.reads).toHaveLength(8); expect(fixture.maxActive).toBe(1); expect(fixture.active).toBe(0);
    const post = fixture.reads.filter(read => read.init.method === "POST"); expect(post).toHaveLength(1);
    expect(post[0].url.pathname).toBe(CPS_API_PATH + "/RegisterTransactionId");
    expect(Object.keys(JSON.parse(String(post[0].init.body)))).toEqual(["transactionId"]);
    expect(fixture.reads.every(read => read.init.credentials === "omit" && read.init.redirect === "manual" && read.init.signal instanceof AbortSignal)).toBe(true);
    expect(JSON.stringify(saved)).not.toMatch(/syntheticPublished|public-client|public-site|transactionId/iu);
    const headers = new Headers(fixture.reads.find(read => read.url.pathname.endsWith("/Configuration"))!.init.headers);
    expect(Object.fromEntries(headers)).toEqual({ accept: "application/json", referer: source.bookingUrl, "user-agent": "TeeTimeSpot/1.0 (+https://teetimespot.com)" });
  });
  it("supports changed date/players through fresh UUID reads and preserves source IDs across recipe versions", async () => {
    const fixture = setup(), changed = { ...input, date: "2026-10-24", players: 3 };
    const first = await execute(fixture.deps), second = await execute(fixture.deps, changed);
    expect(first[0].sourceId).toBe(second[0].sourceId); expect(second[0].startsAt).toBe("2026-10-24T14:30:00.000Z");
    const posts = fixture.reads.filter(read => read.init.method === "POST"); expect(posts).toHaveLength(2);
    expect(posts[0].init.body).not.toBe(posts[1].init.body);
    const sheet = fixture.reads.at(-1)!.url; expect(sheet.searchParams.get("searchDate")).toBe("Sat Oct 24 2026");
    expect(sheet.searchParams.get("numberOfPlayer")).toBe("0"); expect(sheet.searchParams.has("page")).toBe(false);
  });
  it("follows only observed official redirects and link, including one bare-to-www root redirect", async () => {
    const fixture = setup();
    expect(await inspectCps({ ...source, officialUrl: "https://thebobgc.com/" }, fixture.deps)).toMatchObject({ family: "CPS" });
    expect(fixture.reads.slice(0, 4).map(read => read.url.pathname)).toEqual(["/", "/", "/teetimes", "/bookteetimes"]);
  });
  it.each(["redirect", "link"])("handles the retained two-link homepage and a %s to its already queued booking page", async kind => {
    const fixture = setup((url, _init, normal) => {
      if (url.hostname !== "www.thebobgc.com") return normal();
      const content = url.pathname === "/" ? '<a href="/teetimes">BOOK A TEE TIME</a><a href="/bookteetimes">Tee time reservations</a>' :
        url.pathname === "/teetimes" && kind === "link" ? '<a href="/bookteetimes">Book a Tee Time</a>' : undefined;
      return content ? new Response(`<body>${content}${footer}</body>`, { headers: { "content-type": "text/html" } }) : normal();
    });
    expect(await inspectCps(source, fixture.deps)).toMatchObject({ family: "CPS" });
    expect(fixture.reads.filter(read => read.url.hostname === "www.thebobgc.com").map(read => read.url.pathname))
      .toEqual(["/", "/teetimes", "/bookteetimes"]);
    expect(fixture.reads.every(read => read.init.method === "GET")).toBe(true);
  });
  it("rejects a current official challenge and private/foreign redirects before provider reads", async () => {
    for (const location of ["/login", "https://foreign.example.com/teetimes"]) {
      const fixture = setup(() => new Response(null, { status: 302, headers: { location } }));
      await expect(execute(fixture.deps)).rejects.toThrow("OFFICIAL_BOOKING_SOURCE_UNVERIFIED");
      expect(fixture.reads).toHaveLength(1);
    }
    const fixture = setup(() => new Response(`<title>Just a moment...</title><body>Verify you are human${footer}</body>`, { headers: { "content-type": "text/html" } }));
    await expect(execute(fixture.deps)).rejects.toThrow("ACCESS_REQUIRED"); expect(fixture.reads).toHaveLength(1);
  });
  it.each([401, 403, 429, 500])("preserves HTTP %i as failure rather than EMPTY or retrying forbidden paths", async status => {
    const fixture = setup(url => url.pathname.endsWith("/Configuration") ? json({}, status) :
      new Response(`<body><iframe src="${source.bookingUrl}" title="Book a Tee Time"></iframe>${footer}</body>`, { headers: { "content-type": "text/html" } }));
    await expect(execute(fixture.deps)).rejects.toThrow(status === 429 ? "PROVIDER_THROTTLED" : status === 401 || status === 403 ? "ACCESS_REQUIRED" : "ADAPTER_TRANSPORT_FAILED");
    expect(fixture.reads.some(read => read.init.method === "POST")).toBe(false);
  });
  it.each(["name", "timezone", "catalog", "registration", "root", "row"])("rejects changed %s before returning any partial matches", async kind => {
    const fixture = setup((url, init, normal) => {
      if (url.pathname.endsWith("/OnlineCourses") && ["name", "timezone", "catalog"].includes(kind)) return json([{ ...courses()[0],
        ...(kind === "name" ? { courseName: "Another Golf Course" } : kind === "timezone" ? { timezoneId: "America/Los_Angeles" } : { courseId: 2 }) }]);
      if (kind === "registration" && init.method === "POST") return json({ token: "never-used" });
      if (url.pathname.endsWith("/TeeTimes") && kind === "root") return json({ ...JSON.parse("{}"), content: [] });
      if (url.pathname.endsWith("/TeeTimes") && kind === "row") return json(envelope([row(), { ...row(8), courseId: 99 }], url.searchParams.get("transactionId")!));
      return normal();
    });
    await expect(execute(fixture.deps)).rejects.toThrow(); expect(fixture.active).toBe(0);
    expect(fixture.reads.every(read => !/lock|token|login|reservation|account/iu.test(read.url.pathname.replace(CPS_API_PATH, "")))).toBe(true);
  });
  it("keeps the lease until the full dated body is consumed", async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const fixture = setup((url, _init, normal) => {
      if (!url.pathname.endsWith("/TeeTimes")) return normal();
      const body = JSON.stringify(envelope([row()], url.searchParams.get("transactionId")!));
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); entered.resolve();
        void release.promise.then(() => controller.close()); } }), { headers: { "content-type": "application/json" } });
    });
    const pending = execute(fixture.deps); await entered.promise; expect(fixture.active).toBe(1);
    release.resolve(); expect(await pending).toHaveLength(1); expect(fixture.active).toBe(0);
  });
  it("cancels active reads without starting successor requests and rejects expired deadlines/misused simulator input before transport", async () => {
    const started = Promise.withResolvers<void>(), abort = new AbortController();
    const fixture = setup((_url, init) => new Promise<Response>((_resolve, reject) => { started.resolve();
      init.signal!.addEventListener("abort", () => reject(new Error("TEST_ABORT")), { once: true }); }));
    const pending = execute({ ...fixture.deps, signal: abort.signal }); await started.promise; abort.abort();
    await expect(pending).rejects.toThrow(); expect(fixture.reads).toHaveLength(1); expect(fixture.active).toBe(0);
    const untouched = setup();
    await expect(execute({ ...untouched.deps, deadlineAt: new Date(0) })).rejects.toThrow("DEADLINE_EXCEEDED");
    for (const request of [{ ...input, durationMinutes: 60 }, { ...input, players: 5 }, { ...input, timeZone: "America/Los_Angeles" }])
      await expect(executeCps(source, metadata(), { courseId: "course-1" }, request, untouched.deps)).rejects.toThrow("ADAPTER_TARGET_MISMATCH");
    expect(untouched.reads).toHaveLength(0);
  });
});

describe("CPS complete full-sheet normalization", () => {
  const normalize = (value: unknown, request = input) => normalizeCpsAvailability(value, uuid, metadata(), source, request, new Date("2026-10-22T00:00:00Z"));
  it("accepts the observed full nine-hole sheet with no default round length", () => {
    const rows = Array.from({ length: 55 }, (_, index) => ({ ...row(index + 1), defaultHoles: 0 }));
    expect(normalize(envelope(rows))).toHaveLength(55);
    expect(normalize(envelope(rows)).every(slot => slot.holes === 9)).toBe(true);
  });
  it.each([
    { holes: undefined, defaultHoles: 0 }, { holes: 0, defaultHoles: 9 },
    { holes: 9, defaultHoles: 7 }, { holes: 9, defaultHoles: "0" },
  ])("requires a concrete valid round length for %j", fields => {
    expect(() => normalize(envelope([{ ...row(), ...fields }]))).toThrow("CPS_AVAILABILITY_INCOMPLETE");
  });
  it("uses exact party membership/minPlayer and an end-exclusive window before publishing a stable ID", () => {
    const result = normalize(envelope([row(), { ...row(8), availableParticipantNo: [1, 3, 4] }, { ...row(9), minPlayer: 3 },
      { ...row(10), startTime: "2026-10-23T18:00:00" }, { ...row(11), startTime: "2026-10-23T08:00:00" }]));
    expect(result.map(slot => slot.sourceId)).toEqual(["cps-thebobgcpa-11", "cps-thebobgcpa-7"]);
    expect(normalize(envelope([]))).toEqual([]);
  });
  it.each([
    ["wrong UUID", { ...envelope(), transactionId: "00000000-0000-4000-8000-000000000002" }],
    ["failed envelope", { ...envelope([]), isSuccess: false }], ["extra pagination", { ...envelope([]), totalCount: 0 }],
    ["bare array", []], ["duplicate", envelope([row(), row()])], ["wrong date", envelope([{ ...row(), startTime: "2026-10-24T10:30:00" }])],
    ["invalid calendar", envelope([{ ...row(), startTime: "2026-02-30T10:30:00" }])], ["foreign course", envelope([{ ...row(), courseId: 2 }])],
    ["duplicate party", envelope([{ ...row(), availableParticipantNo: [2, 2] }])], ["invalid party", envelope([{ ...row(), availableParticipantNo: [0] }])],
    ["missing holes", envelope([{ ...row(), holes: undefined }])], ["truncated nonarray", { ...envelope(), content: null }],
    ["row after matching", envelope([row(), { ...row(8), startTime: "invalid" }])], ["too many rows", envelope(Array.from({ length: 501 }, (_, index) => row(index + 1)))],
  ])("rejects %s without partial AVAILABLE or fabricated EMPTY", (_name, value) => { expect(() => normalize(value)).toThrow(); });
  it("rejects course-local DST gaps/folds, preserves fractional instant precision, and does not confuse sold holes with layout", () => {
    expect(() => cpsLocalInstant("2026-03-08T02:30:00", source.timeZone)).toThrow("CPS_SLOT_DATE_INVALID");
    expect(() => cpsLocalInstant("2026-11-01T01:30:00", source.timeZone)).toThrow("CPS_SLOT_DATE_INVALID");
    expect(cpsLocalInstant("2026-10-23T10:30:00.1234567", source.timeZone).toISOString()).toBe("2026-10-23T14:30:00.123Z");
    expect(normalize(envelope([{ ...row(), holes: 18 }]))[0].holes).toBe(18);
    expect(cpsAvailabilityQuery(input.date, [1], uuid).get("holes")).toBe("0");
  });
});

it("the actual pinned transport callback admits only the exact UUID request and no companion credentials", async () => {
  const url = source.bookingUrl.slice(0, -1) + CPS_API_PATH + "/RegisterTransactionId", headers = new Headers({ "content-type": "application/json", "x-apikey": "syntheticPublishedKey" });
  let dns = 0, wire = 0;
  const fetch = createAddressPinnedPublicFetchTransport({ parseUrl: value => new URL(value), maxResponseBytes: 100, timeoutMs: 1000, redirectLimit: 0,
    authorizeReadPost: (target, actual, body) => cpsBootstrapReadAllowed(target, actual, body, { url, headers, transactionId: uuid }) }, {
    resolveAddresses: async () => { dns++; return [{ address: "8.8.8.8", family: 4 }]; },
    requestPinned: async () => { wire++; return json(true); },
  });
  expect((await fetch(url, { method: "POST", headers, body: JSON.stringify({ transactionId: uuid }) })).status).toBe(200);
  for (const [target, requestHeaders, body] of [[url.replace("RegisterTransactionId", "LockTeeTimes"), headers, JSON.stringify({ transactionId: uuid })],
    [url, headers, JSON.stringify({ transactionId: uuid, action: "homepage" })], [url, new Headers({ ...Object.fromEntries(headers), cookie: "not-imported" }), JSON.stringify({ transactionId: uuid })]] as const)
    await expect(fetch(target, { method: "POST", headers: requestHeaders, body })).rejects.toThrow();
  expect(dns).toBe(1); expect(wire).toBe(1);
});
