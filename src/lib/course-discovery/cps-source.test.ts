// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CPS_API_PATH, CPS_PUBLIC_BUILD, cpsMetadataSchema, inspectCpsOfficialDocument, parseCpsCatalog,
  parseCpsConfiguration, parseCpsOptions, parseCpsSource, validateCpsIdentity } from "./cps-source";

const source = { officialUrl: "https://www.thebobgc.com/", bookingUrl: "https://thebobgcpa.cps.golf/",
  venueName: "Bob O'Connor Golf Course", venueAddress: "5370 Schenley Dr, Pittsburgh, PA 15217, USA", timeZone: "America/New_York" };
const footer = "<footer>© 2022 Bob O'Connor Golf Course | 5370 Schenley Drive | Pittsburgh, PA 15217 | Phone: 412.622.6959</footer>";
const page = (content: string) => `<html><body>${content}${footer}</body></html>`;
const configuration = () => ({ siteName: "thebobgcpa", onlineApi: "https://thebobgcpa.cps.golf" + CPS_API_PATH,
  authorityBaseUrl: "https://thebobgcpa.cps.golf/identityapi", clientId: "public-client", websiteId: "00000000-0000-0000-0000-000000000000",
  apiKey: "syntheticPublishedKey", buildNumber: CPS_PUBLIC_BUILD });
const options = () => ({ webSiteId: "public-site", courseOptions: [{ courseId: 1, courseName: source.venueName, webSiteId: "public-site" }], reservationOptions: { terminalId: 1 } });
const courses = () => [{ courseId: 1, courseName: source.venueName, timezoneId: source.timeZone, websiteId: "public-site", active: true as const, holes: 9 as const }];

describe("CPS stable public source", () => {
  it("accepts only an exact public tenant document, never API/account/query/credential sources", () => {
    expect(parseCpsSource(source.bookingUrl)?.tenant).toBe("thebobgcpa");
    expect(parseCpsSource(source.bookingUrl + "onlineresweb/search-teetime")?.tenant).toBe("thebobgcpa");
    for (const value of ["http://thebobgcpa.cps.golf/", "https://user:private@thebobgcpa.cps.golf/", "https://thebobgcpa.cps.golf:8443/",
      "https://admin.cps.golf/", "https://thebobgcpa.cps.golf/?key=x", "https://thebobgcpa.cps.golf/#x", "https://thebobgcpa.cps.golf/identityapi",
      "https://nested.thebobgcpa.cps.golf/", "https://thebobgcpa.cps.golf" + CPS_API_PATH + "/TeeTimes"])
      expect(parseCpsSource(value)).toBeUndefined();
  });
  it("replays the retained Bob footer and observed tee-times links then exact titled iframe", () => {
    expect(inspectCpsOfficialDocument(page('<a href="/teetimes">BOOK A TEE TIME</a><a href="/teetimes">Tee Times</a>'), source.officialUrl, source))
      .toEqual({ bookingLinked: false, nextUrls: ["https://www.thebobgc.com/teetimes"] });
    expect(inspectCpsOfficialDocument(page('<a href="/teetimes">BOOK A TEE TIME</a><a href="/bookteetimes">Tee time reservations</a><a href="/teetimes">Tee Times</a>'), source.officialUrl, source))
      .toEqual({ bookingLinked: false, nextUrls: ["https://www.thebobgc.com/teetimes", "https://www.thebobgc.com/bookteetimes"] });
    expect(inspectCpsOfficialDocument(page(`<h1>Book a Tee Time</h1><iframe src="${source.bookingUrl}" title="Book a Tee Time"></iframe>`),
      "https://www.thebobgc.com/bookteetimes", source)).toEqual({ bookingLinked: true });
  });
  it.each([
    ["wrong venue", page(`<iframe src="${source.bookingUrl}" title="Book a Tee Time"></iframe>`).replaceAll("Bob O'Connor", "Another Venue")],
    ["wrong number", page(`<iframe src="${source.bookingUrl}" title="Book a Tee Time"></iframe>`).replace("5370", "5371")],
    ["wrong ZIP", page(`<iframe src="${source.bookingUrl}" title="Book a Tee Time"></iframe>`).replace("15217", "15218")],
    ["foreign tenant", page('<iframe src="https://another.cps.golf/" title="Book a Tee Time"></iframe>')],
    ["multiple tenants", page(`<iframe src="${source.bookingUrl}" title="Book a Tee Time"></iframe><a href="https://another.cps.golf/">Tee Times</a>`)],
    ["hidden iframe", page(`<div hidden><iframe src="${source.bookingUrl}" title="Book a Tee Time"></iframe></div>`)],
    ["srcdoc", page(`<iframe src="${source.bookingUrl}" srcdoc="ignored" title="Book a Tee Time"></iframe>`)],
    ["unlabelled iframe", page(`<iframe src="${source.bookingUrl}"></iframe>`)],
    ["too many booking pages", page('<a href="/teetimes">Tee Times</a><a href="/different">Book a Tee Time</a><a href="/third">Tee Times</a>')],
    ["script identity", `<body><script>${footer}</script><iframe src="${source.bookingUrl}" title="Book a Tee Time"></iframe></body>`],
  ])("rejects %s without promoting a guessed booking route", (_name, html) => {
    expect(() => inspectCpsOfficialDocument(html, source.officialUrl, source)).toThrow();
  });
  it("requires complete canonical identity and IANA context", () => {
    for (const value of [{ ...source, venueAddress: undefined }, { ...source, venueAddress: "Pittsburgh PA" },
      { ...source, timeZone: "Not/AZone" }, { ...source, officialUrl: "http://www.thebobgc.com/" }]) expect(() => validateCpsIdentity(value)).toThrow();
  });
  it("binds fresh configuration, whole catalog IDs/names, website and provider IANA without storing routing secrets", () => {
    const config = parseCpsConfiguration(configuration(), source), selected = parseCpsOptions(options(), config);
    const metadata = parseCpsCatalog(courses(), selected, source);
    expect(metadata).toMatchObject({ family: "CPS", tenant: "thebobgcpa", courseIds: [1] });
    expect(JSON.stringify(metadata)).not.toMatch(/syntheticPublished|public-site|public-client|terminal|transaction/iu);
    expect(Object.keys(metadata).sort()).toEqual(["catalogHash", "courseIds", "family", "tenant"]);
    expect(() => cpsMetadataSchema.parse({ ...metadata, apiKey: "not-durable" })).toThrow();
    for (const data of [{ ...configuration(), siteName: "foreign" }, { ...configuration(), onlineApi: "https://foreign.cps.golf" + CPS_API_PATH },
      { ...configuration(), authorityBaseUrl: "https://foreign.cps.golf/identityapi" }, { ...configuration(), buildNumber: "future-unreviewed" }])
      expect(() => parseCpsConfiguration(data, source)).toThrow();
    for (const data of [{ ...options(), webSiteId: "foreign" }, { ...options(), courseOptions: [...options().courseOptions, ...options().courseOptions] }])
      expect(() => parseCpsOptions(data, config)).toThrow();
  });
  it.each(["name", "timezoneId", "websiteId", "active", "duplicate", "missing", "unknown course"])("rejects changed whole-catalog %s", kind => {
    const rows: unknown[] = courses();
    if (kind === "duplicate") rows.push(...courses());
    else if (kind === "missing") rows.length = 0;
    else rows[0] = { ...courses()[0], ...(kind === "name" ? { courseName: "Another Golf Course" } : kind === "unknown course" ? { courseId: 2 } :
      kind === "active" ? { active: false } : { [kind]: "foreign" }) };
    expect(() => parseCpsCatalog(rows, parseCpsOptions(options(), parseCpsConfiguration(configuration(), source)), source)).toThrow();
  });
});
