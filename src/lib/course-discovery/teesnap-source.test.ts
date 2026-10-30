import { describe, expect, it, vi } from "vitest";
import {
  inspectTeesnapConfiguration,
  parseTeesnapConfiguration,
  parseTeesnapRecipeSource,
  parseTeesnapPublicProperty,
  teesnapPublicPropertyUrl,
  revalidateTeesnapConfiguration,
  teesnapMetadataSchema,
  type TeesnapIdentitySource,
} from "./teesnap-source";

const source = (): TeesnapIdentitySource => ({
  officialUrl: "https://cedar-fixture.teesnap.net/",
  bookingUrl: "https://cedar-fixture.teesnap.net/",
  venueName: "Cedar Fixture Golf Club",
  venueAddress: "731 Cedar Drive, Fairhaven, MA 02719, USA",
  timeZone: "America/New_York",
});
const course = () => ({
  id: 731,
  name: "Cedar Fixture Golf Club",
  enabled: true,
  customer_enabled: true,
  course_type: "golf",
  holes_default: 18,
  addons_default: "off",
});
const property = () => ({
  id: 91,
  name: "Cedar Fixture Golf Club",
  timezone: "America/New_York",
  enabled: true,
  customer_enabled: true,
});
const html = (
  courses: unknown = [course()],
  info: unknown = property(),
) => `<!doctype html><html><head><title>Cedar Fixture Golf Club | Home</title></head><body>
  <h1>Cedar Fixture Golf Club</h1><address>731 Cedar Dr<br>Fairhaven, MA, 02719</address>
  <a href="/login">Log In</a><script>window.courses = ${JSON.stringify(courses)}; window.property = ${JSON.stringify(info)};</script></body></html>`;
const read = (body = html()) =>
  vi.fn(
    async () =>
      new Response(body, {
        headers: { "content-type": "text/html; charset=UTF-8" },
      }),
  );

describe("strict Teesnap public tenant roots", () => {
  it("accepts only the ordinary canonical tenant root", () => {
    expect(parseTeesnapRecipeSource(source().bookingUrl)).toEqual({
      tenant: "cedar-fixture",
      bookingUrl: source().bookingUrl,
    });
    expect(
      parseTeesnapRecipeSource("https://cedar-fixture.teesnap.net"),
    ).toEqual({ tenant: "cedar-fixture", bookingUrl: source().bookingUrl });
  });
  it.each([
    "http://cedar-fixture.teesnap.net/",
    "https://teesnap.net/",
    "https://www.teesnap.net/",
    "https://www.cedar-fixture.teesnap.net/",
    "https://cedar-fixture.teesnap.net.evil.example/",
    "https://cedar-fixture.teesnap.net/login",
    "https://cedar-fixture.teesnap.net/customer-api/teetimes-day",
    "https://cedar-fixture.teesnap.net/?date=2030-05-17",
    "https://cedar-fixture.teesnap.net/#public",
    "https://user:pass@cedar-fixture.teesnap.net/",
    "https://cedar-fixture.teesnap.net:443/",
    "https://CEDAR-FIXTURE.teesnap.net/",
    " https://cedar-fixture.teesnap.net/",
    "https://%63edar-fixture.teesnap.net/",
  ])("rejects ambiguous, stateful or nonpublic URL %s", (value) =>
    expect(parseTeesnapRecipeSource(value)).toBeNull(),
  );
});

describe("fresh static public configuration and exact identity", () => {
  it("reads the ordinary source once and returns closed immutable method metadata", async () => {
    const scopedRead = read(),
      value = await inspectTeesnapConfiguration(source(), scopedRead);
    expect(scopedRead).toHaveBeenCalledExactlyOnceWith(source().bookingUrl);
    expect(value).toEqual({
      family: "TEESNAP",
      tenant: "cedar-fixture",
      courseId: 731,
      defaultHoles: 18,
      defaultAddons: "off",
      timeZone: "America/New_York",
      catalogHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(
      teesnapMetadataSchema.safeParse({
        ...value,
        arbitrarySourceUrl: "https://unobserved.example/",
      }).success,
    ).toBe(false);
  });
  it("retains canonical source timezone without claiming a provider zone when absent", () => {
    const info = property();
    delete (info as Partial<typeof info>).timezone;
    expect(
      parseTeesnapConfiguration(source(), html([course()], info)).timeZone,
    ).toBe("America/New_York");
  });
  it("compares published provider timezone aliases to the canonical source zone", () => {
    expect(
      parseTeesnapConfiguration(
        source(),
        html([course()], { ...property(), timezone: "US/Eastern" }),
      ).timeZone,
    ).toBe("America/New_York");
    expect(() =>
      parseTeesnapConfiguration(
        { ...source(), timeZone: "US/Eastern" },
        html(),
      ),
    ).toThrow("ADAPTER_IDENTITY_MISMATCH");
    expect(() =>
      parseTeesnapConfiguration(
        source(),
        html([course()], { ...property(), time_zone: "America/Chicago" }),
      ),
    ).toThrow("ADAPTER_IDENTITY_MISMATCH");
    expect(() =>
      parseTeesnapConfiguration(
        source(),
        html([{ ...course(), timezone: "America/Chicago" }]),
      ),
    ).toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
  it("never makes an unrelated marketing root an official Teesnap witness", async () => {
    const scopedRead = read();
    await expect(
      inspectTeesnapConfiguration(
        { ...source(), officialUrl: "https://cedar-fixture.example/" },
        scopedRead,
      ),
    ).rejects.toThrow("TEESNAP_OFFICIAL_SOURCE_UNVERIFIED");
    expect(scopedRead).toHaveBeenCalledOnce();
    scopedRead.mockClear();
    await expect(
      inspectTeesnapConfiguration(
        { ...source(), officialUrl: "https://other-fixture.teesnap.net/" },
        scopedRead,
      ),
    ).rejects.toThrow("UNSUPPORTED_ADAPTER_SOURCE");
    expect(scopedRead).not.toHaveBeenCalled();
  });
  it("independently rechecks the official booking link and tenant homepage on each linked-site replay", async () => {
    const linked = { ...source(), officialUrl: "https://cedar-fixture.example/" };
    let currentLink = source().bookingUrl;
    const official = () => `<title>Cedar Fixture Golf Club | Tee times</title><h1>Welcome to public golf</h1><a href="${currentLink}">Book a tee time</a>`;
    const tenant = html().replace('<a href="/login">', '<a href="http://www.cedar-fixture.example/">Course Homepage</a><a href="/login">');
    const scopedRead = vi.fn(async (url: string) => new Response(url === linked.officialUrl ? official() : tenant, { headers: { "content-type": "text/html" } }));
    const saved = await inspectTeesnapConfiguration(linked, scopedRead);
    expect(await revalidateTeesnapConfiguration(linked, saved, scopedRead)).toEqual(saved);
    expect(scopedRead.mock.calls.map(([url]) => url)).toEqual([linked.officialUrl, linked.bookingUrl, linked.officialUrl, linked.bookingUrl]);
    currentLink = "https://other-fixture.teesnap.net/";
    await expect(revalidateTeesnapConfiguration(linked, saved, scopedRead)).rejects.toThrow("TEESNAP_OFFICIAL_SOURCE_UNVERIFIED");
  });
  it.each(["hidden link", "form link", "wrong title", "other tenant", "missing backlink", "hidden backlink", "foreign backlink", "foreign redirect", "redirect loop"])(
    "does not use incomplete or conflicting official-source evidence: %s", async mode => {
      const linked = { ...source(), officialUrl: "https://cedar-fixture.example/" };
      const link = `<a href="${mode === "other tenant" ? "https://other-fixture.teesnap.net/" : linked.bookingUrl}">Book a tee time</a>`;
      const official = `<title>${mode === "wrong title" ? "Other Venue" : "Cedar Fixture Golf Club"} | Home</title>` +
        (mode === "hidden link" ? `<div hidden>${link}</div>` : mode === "form link" ? `<form>${link}</form>` : link);
      const backlink = `<a href="${mode === "foreign backlink" ? "https://other.example/" : linked.officialUrl}">Course Homepage</a>`;
      const tenant = html().replace('<a href="/login">', (mode === "missing backlink" ? "" : mode === "hidden backlink" ? `<div hidden>${backlink}</div>` : backlink) + '<a href="/login">');
      const scopedRead = vi.fn(async (url: string) => {
        if (url === linked.officialUrl && mode.includes("redirect")) return new Response(null, { status: 301, headers: { location: mode === "foreign redirect" ? "https://other.example/" : linked.officialUrl } });
        return new Response(url === linked.officialUrl ? official : tenant, { headers: { "content-type": "text/html" } });
      });
      await expect(inspectTeesnapConfiguration(linked, scopedRead)).rejects.toThrow("TEESNAP_OFFICIAL_SOURCE_UNVERIFIED");
      expect(scopedRead.mock.calls.every(([url]) => [linked.officialUrl, linked.bookingUrl].includes(url))).toBe(true);
    });
  it("follows only a freshly observed canonical www root redirect", async () => {
    const linked = { ...source(), officialUrl: "https://www.cedar-fixture.example/" };
    const canonical = "https://cedar-fixture.example/";
    const scopedRead = vi.fn(async (url: string) => url === linked.officialUrl
      ? new Response(null, { status: 308, headers: { location: canonical } })
      : new Response(url === canonical ? `<title>Cedar Fixture Golf Club</title><a href="${linked.bookingUrl}">Book</a>` :
        html().replace('<a href="/login">', `<a href="${linked.officialUrl}">Course Homepage</a><a href="/login">`), { headers: { "content-type": "text/html" } }));
    await expect(inspectTeesnapConfiguration(linked, scopedRead)).resolves.toMatchObject({ tenant: "cedar-fixture" });
    expect(scopedRead.mock.calls.map(([url]) => url)).toEqual([linked.officialUrl, canonical, linked.bookingUrl]);
  });
  it.each([
    { venueName: "Wrong Fixture Golf Club" },
    { venueAddress: "732 Cedar Drive, Fairhaven, MA 02719, USA" },
    { venueAddress: "Fairhaven, MA 02719" },
    { venueAddress: "731 Cedar Drive, Fairhaven, RI 02719, USA" },
    { timeZone: "Unknown/Fixture" },
  ])(
    "requires the exact canonical venue and complete physical address %j",
    (mismatch) => {
      expect(() =>
        parseTeesnapConfiguration(
          { ...source(), ...mismatch },
          html(),
          () => true,
        ),
      ).toThrow("ADAPTER_IDENTITY_MISMATCH");
    },
  );
  it.each([
    html().replace("<h1>Cedar Fixture Golf Club</h1>", ""),
    html().replace("<h1>", "<h1 hidden>"),
    html().replace("<address>", '<address style="display:none">'),
    html()
      .replace("<address>", "<form><address>")
      .replace("</address>", "</address></form>"),
    html()
      .replace("<address>", '<div class="billing"><address>')
      .replace("</address>", "</address></div>"),
    html().replace("731 Cedar Dr", "732 Cedar Dr"),
    html().replace(
      "Cedar Fixture Golf Club | Home",
      "Other Fixture Golf Club | Home",
    ),
    html().replace(
      "</address>",
      "</address><address>732 Cedar Dr, Fairhaven, MA 02719</address>",
    ),
  ])(
    "cannot adopt hidden, absent, conflicting or nonphysical identity evidence",
    (body) => {
      expect(() => parseTeesnapConfiguration(source(), body)).toThrow(
        "ADAPTER_IDENTITY_MISMATCH",
      );
    },
  );
  it("retains suite identity instead of silently dropping a unit", () => {
    const body = html().replace("731 Cedar Dr", "731 Cedar Dr, Suite 5");
    expect(() => parseTeesnapConfiguration(source(), body)).toThrow(
      "ADAPTER_IDENTITY_MISMATCH",
    );
    expect(
      parseTeesnapConfiguration(
        {
          ...source(),
          venueAddress: "731 Cedar Drive, Ste 5, Fairhaven, MA 02719, US",
        },
        body,
      ).courseId,
    ).toBe(731);
  });
  it.each(
    [
      [course(), course()],
      [course(), { ...course(), id: 732 }],
      [course(), { ...course(), name: "Other Fixture" }],
      [{ ...course(), id: 0 }],
      [{ ...course(), id: "731" }],
      [{ ...course(), id: 1.5 }],
      [{ ...course(), id: 2_147_483_648 }],
      [{ ...course(), name: "Other Fixture Golf Club" }],
      [],
    ].map((courses) => ({ courses })),
  )(
    "rejects duplicate, ambiguous, wrong or malformed course IDs (%j)",
    ({ courses }) => {
      expect(() =>
        parseTeesnapConfiguration(source(), html(courses)),
      ).toThrow();
    },
  );
  it.each([
    { enabled: false },
    { customer_enabled: false },
    { enabled: "true" },
    { private: true },
    { is_private: true },
    { members_only: true },
    { requires_login: true },
    { authenticated: true },
    { visibility: "private" },
    { holes_default: 9 },
    { addons_default: "on" },
    { holes_default: undefined },
    { addons_default: undefined },
    { course_type: "simulator" },
  ])(
    "fails closed on inactive, private or incompatible public defaults (%j)",
    (change) => {
      expect(() =>
        parseTeesnapConfiguration(source(), html([{ ...course(), ...change }])),
      ).toThrow("ADAPTER_CONFIGURATION_UNVERIFIED");
    },
  );
  it.each([
    { customer_enabled: false },
    { requires_login: true },
    { name: "Other Fixture Golf Club" },
  ])("rejects conflicting property authority (%j)", (change) => {
    expect(() =>
      parseTeesnapConfiguration(
        source(),
        html([course()], { ...property(), ...change }),
      ),
    ).toThrow();
  });
  it.each([
    'window.customer={"id":7};',
    "window.user={};",
    "window.isLoggedIn=true;",
    "window.authenticated=true;",
  ])("rejects logged-in bootstrap variant %s", (script) =>
    expect(() =>
      parseTeesnapConfiguration(
        source(),
        html().replace("</script>", script + "</script>"),
      ),
    ).toThrow(),
  );
  it("allows explicit anonymous bootstrap markers without executing script", () => {
    expect(
      parseTeesnapConfiguration(
        source(),
        html().replace(
          "</script>",
          "window.customer=null;window.isLoggedIn=false;</script>",
        ),
      ).courseId,
    ).toBe(731);
  });
  it("rejects a logged-in visible session even when course configuration is public", () => {
    expect(() =>
      parseTeesnapConfiguration(source(), html().replace("Log In", "Log Out")),
    ).toThrow("ADAPTER_CONFIGURATION_UNVERIFIED");
  });
  it("does not evaluate unrelated inline JavaScript while extracting literal public configuration", () => {
    const body = html().replace(
      "</script>",
      "const untouched={['computed']:()=>{throw Error('DO_NOT_EXECUTE')}};</script>",
    );
    expect(parseTeesnapConfiguration(source(), body).courseId).toBe(731);
  });
  it.each([
    html().replace(
      "window.courses =",
      "window.courses = loadPublicCourses() ||",
    ),
    html().replace("window.courses =", "window.courses = JSON.parse("),
    html().replace('"id":731', '"id":731,"id":732'),
    html().replace("window.courses =", "window['courses'] ="),
    html().replace("</script>", "window.courses=[];</script>"),
    html().replace("</script>", "window.courses[0].id=732;</script>"),
    html().replace("</script>", "globalThis.courses=[];</script>"),
    html().replace("</script>", "courses=[];</script>"),
    html().replace(
      "</script>",
      "Object.defineProperty(window,'courses',{value:[]});</script>",
    ),
    html().replace("</script>", "Object.assign(window,{courses:[]});</script>"),
    html().replace("</script>", "eval('courses=[]');</script>"),
    html().replace("window.courses =", "if(true)window.courses ="),
    html().replace("<script>", '<script type="application/json">'),
    html().replace(
      "<script>",
      '<script src="https://script-fixture.example/config.js">',
    ),
    html()
      .replace("<script>", "<template><script>")
      .replace("</script>", "</script></template>"),
    html().replace(
      "window.property =",
      "window.property = getPrivateProperty() ||",
    ),
  ])(
    "does not execute or recover authority from malformed/dynamic/shadowed config",
    (body) => {
      expect(() => parseTeesnapConfiguration(source(), body)).toThrow(
        "ADAPTER_CONFIGURATION_UNVERIFIED",
      );
    },
  );
  it("uses a unique exact physical course while retaining the full semantic catalog", () => {
    const other = { ...course(), id: 732, name: "Other Fixture Golf Club" };
    expect(
      parseTeesnapConfiguration(source(), html([other, course()])).courseId,
    ).toBe(731);
    expect(
      parseTeesnapConfiguration(source(), html([other, course()])).catalogHash,
    ).toBe(
      parseTeesnapConfiguration(source(), html([course(), other])).catalogHash,
    );
  });
});

describe("fresh execution configuration binding", () => {
  it("revalidates identical semantic public configuration on every execution", async () => {
    const scopedRead = read(),
      saved = await inspectTeesnapConfiguration(source(), scopedRead);
    await expect(
      revalidateTeesnapConfiguration(source(), saved, scopedRead),
    ).resolves.toEqual(saved);
    await expect(
      revalidateTeesnapConfiguration(source(), saved, scopedRead),
    ).resolves.toEqual(saved);
    expect(scopedRead).toHaveBeenCalledTimes(3);
  });
  it("excludes volatile markup, prices, nonce and booking-window dates from catalog identity", async () => {
    const saved = parseTeesnapConfiguration(source(), html());
    const changed = html([
      { ...course(), advance: 14, today: "2030-05-17", price: 55 },
    ]).replace(
      "<script>",
      '<p>Updated public notice</p><script nonce="changed">',
    );
    await expect(
      revalidateTeesnapConfiguration(source(), saved, read(changed)),
    ).resolves.toEqual(saved);
  });
  it.each(
    [
      [{ ...course(), id: 732 }],
      [course(), { ...course(), id: 733, name: "Other Fixture Golf Club" }],
    ].map((courses) => ({ courses })),
  )(
    "rejects changed selected ID or functional catalog (%j)",
    async ({ courses }) => {
      const saved = parseTeesnapConfiguration(source(), html());
      await expect(
        revalidateTeesnapConfiguration(source(), saved, read(html(courses))),
      ).rejects.toThrow("ADAPTER_CONFIGURATION_CHANGED");
    },
  );
  it("rejects source tenant/timezone changes and malformed saved metadata before reading", async () => {
    const saved = parseTeesnapConfiguration(source(), html()),
      scopedRead = read();
    await expect(
      revalidateTeesnapConfiguration(
        {
          ...source(),
          officialUrl: "https://changed-fixture.teesnap.net/",
          bookingUrl: "https://changed-fixture.teesnap.net/",
        },
        saved,
        scopedRead,
      ),
    ).rejects.toThrow("ADAPTER_CONFIGURATION_CHANGED");
    await expect(
      revalidateTeesnapConfiguration(
        { ...source(), timeZone: "America/Chicago" },
        saved,
        scopedRead,
      ),
    ).rejects.toThrow("ADAPTER_CONFIGURATION_CHANGED");
    await expect(
      revalidateTeesnapConfiguration(
        source(),
        { ...saved, defaultAddons: "on" },
        scopedRead,
      ),
    ).rejects.toThrow("ADAPTER_CONFIGURATION_CHANGED");
    expect(scopedRead).not.toHaveBeenCalled();
  });
  it.each([
    () =>
      new Response(html(), {
        status: 403,
        headers: { "content-type": "text/html" },
      }),
    () =>
      new Response(html(), { headers: { "content-type": "application/json" } }),
    () => {
      const response = new Response(html(), {
        headers: { "content-type": "text/html" },
      });
      Object.defineProperty(response, "url", {
        value: "https://other-fixture.teesnap.net/",
      });
      return response;
    },
    () => {
      const response = new Response(html(), {
        headers: { "content-type": "text/html" },
      });
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    },
  ])(
    "cannot accept a failed, redirected, changed-origin or non-HTML read",
    async (response) => {
      await expect(
        inspectTeesnapConfiguration(source(), async () => response()),
      ).rejects.toThrow();
    },
  );
});

const spa = '<!doctype html><html><head><title>Public booking</title></head><body><div id="app"></div><script type="module" src="/booking.js"></script></body></html>';
const publicCourse = () => ({ ...course(), property_id: 91, course_type: null as string | null,
  players_array: [1, 2, 3, 4], holes_array: [9, 18], addons_array: ["on", "off"], min_players: 1, max_players: 4, default_players: 4 });
const publicProperty = () => ({ success: true, data: { id: 91, name: source().venueName, enabled: true,
  address_street: "731 Cedar Dr", address_city: "Fairhaven", address_region: "Massachusetts", address_code: "02719", address_country: "US",
  time_zone: "America/New_York", phone: "555-0100", courses: [publicCourse()] } });
const modernRead = (payload: unknown = publicProperty(), root = spa) => vi.fn(async (url: string) => {
  if (url === source().bookingUrl) return new Response(root, { headers: { "content-type": "text/html" } });
  expect(url).toBe(teesnapPublicPropertyUrl(source().bookingUrl)); return Response.json(payload);
});

describe("modern public property bootstrap", () => {
  it("pins a supported cart-off read even when the public page defaults to cart-on", async () => {
    const payload = publicProperty(), previous = parseTeesnapPublicProperty(source(), payload);
    payload.data.courses[0].addons_default = "on";
    const saved = await inspectTeesnapConfiguration(source(), modernRead(payload));
    expect(saved.defaultAddons).toBe("off");
    expect(saved.catalogHash).not.toBe(previous.catalogHash);
    await expect(revalidateTeesnapConfiguration(source(), saved, modernRead(payload))).resolves.toEqual(saved);
    await expect(revalidateTeesnapConfiguration(source(), saved, modernRead())).rejects.toThrow("ADAPTER_CONFIGURATION_CHANGED");
    payload.data.courses[0].addons_array = ["off"];
    expect(() => parseTeesnapPublicProperty(source(), payload)).toThrow("ADAPTER_CONFIGURATION_UNVERIFIED");
  });
  it("derives only the exact tenant-bound public property role", () => {
    expect(teesnapPublicPropertyUrl(source().bookingUrl)).toBe("https://cedar-fixture.api.teesnap.net/api/bookingsite/property");
    for (const url of ["https://unrelated.example/", "https://cedar-fixture.api.teesnap.net/", source().bookingUrl + "?profileId=7"])
      expect(() => teesnapPublicPropertyUrl(url)).toThrow("UNSUPPORTED_ADAPTER_SOURCE");
  });
  it("uses exactly HTML then public-property GET when legacy bootstrap is absent", async () => {
    const read = modernRead(), metadata = await inspectTeesnapConfiguration(source(), read);
    expect(read.mock.calls.map(call => call[0])).toEqual([source().bookingUrl, teesnapPublicPropertyUrl(source().bookingUrl)]);
    expect(metadata).toEqual({ family: "TEESNAP", tenant: "cedar-fixture", courseId: 731, defaultHoles: 18, defaultAddons: "off", timeZone: "America/New_York",
      publicApiVersion: "BOOKINGSITE_V1", supportedPlayers: [1, 2, 3, 4], catalogHash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  });
  it("requires paired mode and supported-player metadata while preserving legacy shape", () => {
    const legacy = parseTeesnapConfiguration(source(), html()), modern = parseTeesnapPublicProperty(source(), publicProperty());
    expect(legacy).not.toHaveProperty("publicApiVersion"); expect(legacy).not.toHaveProperty("supportedPlayers");
    expect(teesnapMetadataSchema.safeParse({ ...legacy, supportedPlayers: [1, 2] }).success).toBe(false);
    const withoutPlayers = { ...modern } as Record<string, unknown>; delete withoutPlayers.supportedPlayers;
    expect(teesnapMetadataSchema.safeParse(withoutPlayers).success).toBe(false);
    for (const supportedPlayers of [[], [2, 1], [1, 1], [0, 2], [1, 5], ["2"]])
      expect(teesnapMetadataSchema.safeParse({ ...modern, supportedPlayers }).success).toBe(false);
  });
  it("refreshes modern property directly and never rereads its shell on a saved execution", async () => {
    const saved = parseTeesnapPublicProperty(source(), publicProperty()), read = modernRead();
    await expect(revalidateTeesnapConfiguration(source(), saved, read)).resolves.toEqual(saved);
    expect(read).toHaveBeenCalledExactlyOnceWith(teesnapPublicPropertyUrl(source().bookingUrl));
  });
  it("does not upgrade an old legacy saved method when the root changes format", async () => {
    const saved = parseTeesnapConfiguration(source(), html()), read = modernRead();
    await expect(revalidateTeesnapConfiguration(source(), saved, read)).rejects.toThrow("ADAPTER_CONFIGURATION_CHANGED");
    expect(read).toHaveBeenCalledExactlyOnceWith(source().bookingUrl);
  });
  it.each([
    html().replace('"id":731', '"id":"wrong"'), html().replace("window.courses =", "window.courses = loadCourses() ||"),
    html().replace("Cedar Fixture Golf Club | Home", "Wrong Fixture | Home"),
    html().replace("window.courses", "window['courses']"), html().replace("window.courses =", "window.\\u0063ourses = loadCourses() ||"),
    html().replace("</script>", "window.property={};</script>"),
  ])("does not treat malformed/dynamic/identity-failed legacy markup as absent", async root => {
    const read = modernRead(publicProperty(), root); await expect(inspectTeesnapConfiguration(source(), read)).rejects.toThrow();
    expect(read).toHaveBeenCalledExactlyOnceWith(source().bookingUrl);
  });
  it("retains the one-read strict legacy strategy when its bootstrap is present", async () => {
    const read = modernRead(publicProperty(), html()), metadata = await inspectTeesnapConfiguration(source(), read);
    expect(read).toHaveBeenCalledExactlyOnceWith(source().bookingUrl); expect(metadata).toEqual(parseTeesnapConfiguration(source(), html()));
  });
  it.each([{}, { success: false, data: publicProperty().data }, { data: publicProperty().data }, { success: true, data: [] },
    { success: true, data: publicProperty().data, error: "unexpected" }])("requires the actual successful public wrapper (%j)", payload => {
    expect(() => parseTeesnapPublicProperty(source(), payload)).toThrow("ADAPTER_CONFIGURATION_UNVERIFIED");
  });
  it.each(["name", "address_street", "address_city", "address_region", "address_code", "address_country", "time_zone", "id", "enabled"])(
    "never invents missing property %s", key => {
      const payload = publicProperty(); delete (payload.data as Record<string, unknown>)[key];
      expect(() => parseTeesnapPublicProperty(source(), payload)).toThrow();
    });
  it.each([{ name: "Other Fixture Golf" }, { address_street: "732 Cedar Dr" }, { address_city: "Other Town" }, { address_region: "RI" },
    { address_code: "02720" }, { address_country: "Canada" }, { time_zone: "America/Chicago" }, { enabled: false },
    { private: true }, { members_only: true }, { requires_login: true }, { is_logged_in: true }])("rejects conflicting physical/public property facts (%j)", change => {
    const payload = publicProperty(); Object.assign(payload.data, change); expect(() => parseTeesnapPublicProperty(source(), payload)).toThrow();
  });
  it.each([
    [publicCourse(), publicCourse()], [publicCourse(), { ...publicCourse(), id: 732 }], [{ ...publicCourse(), id: 0 }],
    [{ ...publicCourse(), property_id: 92 }], [{ ...publicCourse(), enabled: false }], [{ ...publicCourse(), name: "Wrong Fixture Golf" }],
    [{ ...publicCourse(), private: true }], [{ ...publicCourse(), members_only: true }], [{ ...publicCourse(), requires_login: true }],
    [{ ...publicCourse(), course_type: "simulator" }], [{ ...publicCourse(), course_type: "private" }],
    [{ ...publicCourse(), course_type: "members_only" }], [{ ...publicCourse(), course_type: "login_required" }], [],
  ].map(courses => ({ courses })))("requires a unique enabled exact physical course and property link (%j)", ({ courses }) => {
    const payload = publicProperty(); payload.data.courses = courses;
    expect(() => parseTeesnapPublicProperty(source(), payload)).toThrow();
  });
  it.each([
    { players_array: [] }, { players_array: [1, 1, 2] }, { players_array: [0, 1] }, { players_array: [1, 5] },
    { players_array: ["1", "2"] }, { min_players: 2 }, { max_players: 3 }, { default_players: 5 },
    { players_array: [1, 2, 4], default_players: 3 }, { holes_default: 9 }, { addons_default: "required" },
    { holes_array: [9] }, { holes_array: [18, 18] }, { addons_array: ["on"] }, { addons_array: ["off", "off"] },
  ])("fails closed on malformed or inconsistent party/default support (%j)", change => {
    const payload = publicProperty(); Object.assign(payload.data.courses[0], change);
    expect(() => parseTeesnapPublicProperty(source(), payload)).toThrow("ADAPTER_CONFIGURATION_UNVERIFIED");
  });
  it("never fills a missing player count from min/max", () => {
    const payload = publicProperty(); Object.assign(payload.data.courses[0], { players_array: [2, 4], min_players: 2, max_players: 4, default_players: 4 });
    expect(parseTeesnapPublicProperty(source(), payload).supportedPlayers).toEqual([2, 4]);
  });
  it("normalizes equivalent player presentation order without changing metadata or catalog hash", () => {
    const payload = publicProperty(), original = parseTeesnapPublicProperty(source(), payload);
    payload.data.courses[0].players_array = [4, 3, 2, 1];
    expect(parseTeesnapPublicProperty(source(), payload)).toEqual(original);
  });
  it("binds property identity, selected ID, public support and functional catalog in the digest", async () => {
    const saved = parseTeesnapPublicProperty(source(), publicProperty());
    for (const change of ["course", "property", "players", "catalog"]) {
      const payload = publicProperty();
      if (change === "course") payload.data.courses[0].id = 732;
      if (change === "property") { payload.data.id = 92; payload.data.courses[0].property_id = 92; }
      if (change === "players") Object.assign(payload.data.courses[0], { players_array: [2, 3, 4], min_players: 2 });
      if (change === "catalog") payload.data.courses.push({ ...publicCourse(), id: 732, name: "Other Fixture Golf", enabled: false });
      await expect(revalidateTeesnapConfiguration(source(), saved, modernRead(payload))).rejects.toThrow("ADAPTER_CONFIGURATION_CHANGED");
    }
  });
  it("excludes volatile windows/rates/phone and unneeded private values from the semantic digest", () => {
    const payload = publicProperty(), saved = parseTeesnapPublicProperty(source(), payload);
    Object.assign(payload.data, { phone: "555-0200", private_note: "UNUSED_PRIVATE_SENTINEL" });
    Object.assign(payload.data.courses[0], { advance: 21, start_availability_time: "06:00", date: "2030-05-18", price: 55, private_owner_email: "UNUSED_PRIVATE_SENTINEL" });
    const refreshed = parseTeesnapPublicProperty(source(), payload); expect(refreshed).toEqual(saved);
    expect(JSON.stringify(refreshed)).not.toContain("UNUSED_PRIVATE_SENTINEL");
  });
  it("rejects duplicate JSON keys and never executes a property response", async () => {
    for (const body of [JSON.stringify(publicProperty()).replace('"enabled":true', '"enabled":false,"enabled":true'), 'JSON.parse("{}")', '{"success":true,"data":']) {
      const read = vi.fn(async (url: string) => url === source().bookingUrl ? new Response(spa, { headers: { "content-type": "text/html" } }) : new Response(body, { headers: { "content-type": "application/json" } }));
      await expect(inspectTeesnapConfiguration(source(), read)).rejects.toThrow("ADAPTER_CONFIGURATION_UNVERIFIED"); expect(read).toHaveBeenCalledTimes(2);
    }
  });
  it("does not cross a visible access wall merely because a public API role is known", async () => {
    const read = modernRead(publicProperty(), spa.replace('<div id="app"></div>', '<p>Javascript is required. You are being redirected</p>'));
    await expect(inspectTeesnapConfiguration(source(), read)).rejects.toThrow(); expect(read).toHaveBeenCalledOnce();
  });
});
