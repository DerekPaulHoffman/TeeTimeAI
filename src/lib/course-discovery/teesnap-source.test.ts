import { describe, expect, it, vi } from "vitest";
import {
  inspectTeesnapConfiguration,
  parseTeesnapConfiguration,
  parseTeesnapRecipeSource,
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
    ).rejects.toThrow("UNSUPPORTED_ADAPTER_SOURCE");
    await expect(
      inspectTeesnapConfiguration(
        { ...source(), officialUrl: "https://other-fixture.teesnap.net/" },
        scopedRead,
      ),
    ).rejects.toThrow("UNSUPPORTED_ADAPTER_SOURCE");
    expect(scopedRead).not.toHaveBeenCalled();
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
