// @vitest-environment node
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { addVerifiedMindbodyReadHeaders, isMindbodyPublicReadPost, MINDBODY_PUBLIC_READ_ACTIONS, isMindbodyClassicPublicBootstrapPost, mindbodyClassicPublicBootstrapSource, mindbodyClassicPublicBootstrapPostDiagnostic, mindbodyClassicBootstrapPostOutcomes,
  mindbodyClassicPublicBootstrapSourceDiagnostic, mindbodyClassicBootstrapSourceOutcomes, mindbodyClassicBootstrapUrlDiagnostic } from "./mindbody-public-read-policy";
import { isAnonymousBrowserReadPost } from "./simulator-interactive-browser";

// Captured with unknown POSTs blocked before transmission. The public client
// SHA256 d7857e7ce0bac662fcfb106ad3582f141dfeb46b80b2e01d05d4fe5ad4dbe5a6
// binds the fixed IDs to price, next-available and service-ID decoder reads.
const source = "https://go.mindbodyonline.com/book/widgets/appointments/view/7530540d715/services";
const service = "asrv_11kU4DMwLJ69aK4P2V";
const prices = { businessId: "5743764", locationId: "1", locationTimezone: "America/New_York", serviceIds: [service] };
const routing = { businessId: "5743764", locationId: "1", appointmentServiceId: "1", includedStaffIds: [], preview: "view", widgetId: "7530540d715", locale: "en" };
const headers = (action: string, url = source) => new Headers({ "content-type": "text/plain;charset=UTF-8", origin: new URL(url).origin,
  referer: url, "next-action": action, accept: "text/x-component" });
const check = (action: string, body: unknown, url = source, requestHeaders = headers(action, url)) =>
  isMindbodyPublicReadPost(new URL(url), requestHeaders, JSON.stringify(body));

describe("Mindbody anonymous classic display bootstrap", () => {
  const entry = "https://clients.mindbodyonline.com/classic/ws?studioid=685163&stype=-9", target = "https://clients.mindbodyonline.com/classic/home";
  const emptyFields = "tg vt lvl qParam view page catid prodid prodGroupId sSU optForwardingLink singleUseToken oAuthToken launchGUID launchUID launchPWDChange launchPWDChangeKey launchLostPWD launchResetPWD launchBizModeLogin launchBizModeLoginWithRedirectLink key consumerModeRedirect extLink giftCardID".split(" ");
  const form = () => new URLSearchParams([...emptyFields.map(key => [key, ""]), ["studioId", "685163"], ["stype", "-9"], ["trn", "0"], ["classid", "0"], ["date", "10/23/2026"]]);
  const readHeaders = () => new Headers({ "content-type": "application/x-www-form-urlencoded", origin: "https://clients.mindbodyonline.com" });
  const allows = (body = form().toString(), sourceUrl = entry, url = target, h = readHeaders()) => isMindbodyClassicPublicBootstrapPost(new URL(url), h, body, sourceUrl);

  it("accepts only the captured anonymous bootstrap and binds public studio routing", () => {
    expect(allows()).toBe(true);
    const other = form(); other.set("studioId", "12345"); other.set("date", "2/29/2028");
    expect(allows(other.toString(), entry.replace("685163", "12345"))).toBe(true);
    expect(allows(other.toString())).toBe(false);
    // A public-shaped body without private native source ownership still
    // cannot pass the generic anonymous POST classifier.
    expect(isAnonymousBrowserReadPost(new URL(target), readHeaders(), form().toString())).toBe(false);
  });
  it.each(emptyFields)("requires the %s launch/contact/forwarding field to remain literally empty", field => {
    const value = form(); value.set(field, "nonempty"); expect(allows(value.toString())).toBe(false);
  });
  it("rejects duplicate/unknown/missing keys and encoded aliases", () => {
    const value = form(); value.delete("tg"); expect(allows(value.toString())).toBe(false);
    expect(allows(form().toString() + "&tg=")).toBe(false);
    expect(allows(form().toString() + "&query=%7Bslots%7D")).toBe(false);
    expect(allows(form().toString().replace("studioId=", "studio%49d="))).toBe(false);
    expect(allows(form().toString().replace("studioId=685163", "studioId=%3685163"))).toBe(false);
  });
  it("rejects unobserved action defaults, date sentinels and invalid calendar dates", () => {
    for (const [key, values] of [["stype", ["-8", "1"]], ["trn", ["1", "false", "true"]], ["classid", ["1", "false"]],
      ["date", ["0", "-1", "null", "2026-10-23", "2/29/2025", "2/30/2026", "13/1/2026", "1/1/1899", "1/1/2101"]]] as const) {
      for (const replacement of values) { const value = form(); value.set(key, replacement); expect(allows(value.toString())).toBe(false); }
    }
  });
  it("requires the exact public source, destination, encoding and anonymous headers", () => {
    for (const bad of [entry + "&studioid=685163", entry + "&other=", entry.replace("studioid=", "studio%69d="), entry + "#private",
      entry.replace("https:", "http:"), entry.replace("/ws?", "/home?"), entry.replace("stype=-9", "stype=1")]) expect(allows(undefined, bad)).toBe(false);
    for (const bad of [target + "?studioid=685163", target + "#view", target.replace("/home", "/checkout"), target.replace("clients.", "evil.")]) expect(allows(undefined, entry, bad)).toBe(false);
    for (const [key, value] of [["origin", "https://other.example"], ["content-type", "application/json"], ["authorization", "Bearer null"], ["next-action", "public-looking"], ["x-auth-token", "opaque"]]) {
      const h = readHeaders(); h.set(key, value); expect(allows(undefined, entry, target, h)).toBe(false);
    }
    expect(mindbodyClassicPublicBootstrapSource(entry, target)).toEqual({ studioId: "685163" });
  });
  it("reports only closed predicate outcomes while preserving the boolean policy", () => {
    const changed = (key: string, value: string) => { const body = form(); body.set(key, value); return body.toString(); };
    const cases: Array<{ outcome: typeof mindbodyClassicBootstrapPostOutcomes[number]; body?: string; source?: string; headers?: Headers }> = [
      { outcome: "VALID" }, { outcome: "SOURCE_BINDING", source: entry.replace("-9", "-8") }, { outcome: "BODY_SIZE", body: "x".repeat(2049) },
      { outcome: "ORIGIN", headers: new Headers({ "content-type": "application/x-www-form-urlencoded" }) },
      { outcome: "CONTENT_TYPE", headers: new Headers({ origin: new URL(target).origin, "content-type": "application/json" }) },
      { outcome: "CREDENTIAL_HEADER", headers: new Headers({ ...Object.fromEntries(readHeaders()), "x-auth-token": "private-header-value" }) },
      { outcome: "FORM_KEYS", body: form().toString() + "&unknown=" }, { outcome: "FORM_ENCODING", body: form().toString().replaceAll("%2F", "%2f") },
      { outcome: "STUDIO", body: changed("studioId", "12345") }, { outcome: "STYPE", body: changed("stype", "-8") },
      { outcome: "DISPLAY_FLAGS", body: changed("trn", "1") }, { outcome: "DATE", body: changed("date", "2/30/2026") },
      { outcome: "NONEMPTY_FIELD", body: changed("singleUseToken", "private-body-value") },
    ];
    expect(cases.map(value => value.outcome)).toEqual(mindbodyClassicBootstrapPostOutcomes);
    for (const value of cases) {
      const h = value.headers ?? readHeaders(), body = value.body ?? form().toString(), sourceUrl = value.source ?? entry;
      const diagnostic = mindbodyClassicPublicBootstrapPostDiagnostic(new URL(target), h, body, sourceUrl);
      expect(diagnostic).toBe(value.outcome); expect(allows(body, sourceUrl, target, h)).toBe(diagnostic === "VALID");
      expect(JSON.stringify(diagnostic)).not.toContain("private-");
    }
  });
  it("classifies every source binding condition without admitting a queried target", () => {
    const cases: Array<[typeof mindbodyClassicBootstrapSourceOutcomes[number], string, string]> = [
      ["VALID", entry, target], ["URL_PARSE", "not-url", target], ["SOURCE_ORIGIN", entry.replace("https:", "http:"), target],
      ["SOURCE_PATH", entry.replace("/ws?", "/other?"), target], ["SOURCE_QUERY_COUNT", entry + "&extra=1", target],
      ["SOURCE_QUERY_KEYS", entry.replace("studioid=", "studio%69d="), target], ["SOURCE_QUERY_VALUES", entry.replace("-9", "-8"), target],
      ["TARGET", entry, target + "?studioid=685163"],
    ];
    expect(cases.map(([outcome]) => outcome)).toEqual(mindbodyClassicBootstrapSourceOutcomes);
    for (const [outcome, sourceUrl, targetUrl] of cases) {
      expect(mindbodyClassicPublicBootstrapSourceDiagnostic(sourceUrl, targetUrl)).toBe(outcome);
      expect(mindbodyClassicPublicBootstrapSource(sourceUrl, targetUrl) !== null).toBe(outcome === "VALID");
    }
    expect(mindbodyClassicPublicBootstrapSource(entry.replace("studioid=685163&stype=-9", "stype=-9&studioid=685163"), target)).not.toBeNull();
  });
  it("projects only closed target routing categories, canonical keys and bounded counts", () => {
    const url = target + "?studioid=685163&stype=-9&trn=0&classid=0&date=10%2F23%2F2026&privateQueryName=privateValue";
    const diagnostic = mindbodyClassicBootstrapUrlDiagnostic(entry, url, form().toString());
    expect(diagnostic).toMatchObject({ knownSourceEndpoint: true, sourceQueryCount: 2, targetOriginMatches: true, targetPathMatches: true,
      targetQueryPresent: true, targetFragmentPresent: false, targetQueryCount: 6 });
    expect(diagnostic.targetQuery).toEqual([
      { key: "studioid", occurrences: 1, canonicalKeys: true, valueClasses: ["MATCHES_SOURCE_STUDIO"] },
      { key: "stype", occurrences: 1, canonicalKeys: true, valueClasses: ["PUBLIC_STYPE_MINUS_NINE"] },
      { key: "trn", occurrences: 1, canonicalKeys: true, valueClasses: ["ZERO"] },
      { key: "classid", occurrences: 1, canonicalKeys: true, valueClasses: ["ZERO"] },
      { key: "date", occurrences: 1, canonicalKeys: true, valueClasses: ["MATCHES_BODY_DATE"] },
      { key: "OTHER", occurrences: 1, canonicalKeys: false, valueClasses: ["OTHER"] },
    ]);
    for (const raw of ["685163", "10/23/2026", "privateQueryName", "privateValue"]) expect(JSON.stringify(diagnostic)).not.toContain(raw);
    expect(mindbodyClassicBootstrapUrlDiagnostic(entry, target + "?%73tudioid=685163").targetQuery).toEqual([{ key: "studioid", occurrences: 1, canonicalKeys: false, valueClasses: ["MATCHES_SOURCE_STUDIO"] }]);
    expect(mindbodyClassicBootstrapUrlDiagnostic(entry, target + "?" + Array(33).fill("private=private").join("&"))).toMatchObject({ targetQueryCount: "OVER_LIMIT", targetQuery: [] });
    expect(mindbodyClassicBootstrapUrlDiagnostic(entry, target + "#private").targetFragmentPresent).toBe(true);
  });
});

describe("Mindbody inspected public server actions", () => {
  it("allows only the four independently inspected read handlers and their argument shapes", () => {
    expect(check(MINDBODY_PUBLIC_READ_ACTIONS.servicePrices, [prices])).toBe(true);
    expect(check(MINDBODY_PUBLIC_READ_ACTIONS.nextAvailable, [{ ...prices, includedStaffIds: [] }])).toBe(true);
    expect(check(MINDBODY_PUBLIC_READ_ACTIONS.decodeServiceId, [service])).toBe(true);
    expect(check(MINDBODY_PUBLIC_READ_ACTIONS.serviceRouting, [routing])).toBe(true);
    expect(isAnonymousBrowserReadPost(new URL(source), headers(MINDBODY_PUBLIC_READ_ACTIONS.decodeServiceId), JSON.stringify([service]))).toBe(true);
  });

  it("binds the routing read to the same public widget and rejects private staff/preview variants", () => {
    for (const change of [{ widgetId: "123456abcde" }, { includedStaffIds: ["1"] }, { preview: "preview" },
      { locale: "private" }, { appointmentServiceId: 1 }, { accountId: "1" }]) {
      expect(check(MINDBODY_PUBLIC_READ_ACTIONS.serviceRouting, [{ ...routing, ...change }])).toBe(false);
    }
  });

  it("generalizes public venue/location/service identifiers without admitting a different widget origin", () => {
    const other = "https://go.mindbodyonline.com/book/widgets/appointments/view/123456abcde/services";
    expect(check(MINDBODY_PUBLIC_READ_ACTIONS.servicePrices, [{ businessId: "8765432", locationId: "23", locationTimezone: "America/Chicago",
      serviceIds: ["asrv_AnotherPublicService123"] }], other)).toBe(true);
    expect(check(MINDBODY_PUBLIC_READ_ACTIONS.decodeServiceId, [service], source, headers(MINDBODY_PUBLIC_READ_ACTIONS.decodeServiceId, other))).toBe(false);
  });

  it.each([
    "http://go.mindbodyonline.com/book/widgets/appointments/view/7530540d715/services",
    "https://go.mindbodyonline.com.evil.example/book/widgets/appointments/view/7530540d715/services",
    "https://private.example/book/widgets/appointments/view/7530540d715/services",
    source.replace("/view/", "/preview/"), source.replace("/services", "/checkout"),
    source + "?token=private", source + "#checkout", source.replace("https://", "https://user:pass@"),
  ])("denies unsafe or unobserved endpoint shape %s", url => {
    expect(check(MINDBODY_PUBLIC_READ_ACTIONS.decodeServiceId, [service], url)).toBe(false);
  });

  it("denies missing/mismatched source, unknown action IDs and transaction routing actions", () => {
    for (const key of ["origin", "referer", "next-action"]) {
      const h = headers(MINDBODY_PUBLIC_READ_ACTIONS.decodeServiceId); h.delete(key);
      expect(check(MINDBODY_PUBLIC_READ_ACTIONS.decodeServiceId, [service], source, h)).toBe(false);
    }
    const wrong = headers(MINDBODY_PUBLIC_READ_ACTIONS.decodeServiceId); wrong.set("origin", "https://untrusted.example");
    expect(check(MINDBODY_PUBLIC_READ_ACTIONS.decodeServiceId, [service], source, wrong)).toBe(false);
    for (const action of ["a".repeat(40), "10a3a84cc7c391c1812dd0672341ca5c5a4d2a58", "createReservation"])
      expect(check(action, [prices])).toBe(false);
  });

  it("denies mutation, contact, auth and unrecognized fields even on the exact read action", () => {
    for (const key of ["reservationId", "cartId", "email", "phone", "token", "customer", "action", "query", "password", "__proto__"]) {
      expect(check(MINDBODY_PUBLIC_READ_ACTIONS.servicePrices, [{ ...prices, [key]: "anything" }])).toBe(false);
    }
    for (const key of ["authorization", "cookie", "x-api-key", "x-auth-token"]) {
      const h = headers(MINDBODY_PUBLIC_READ_ACTIONS.servicePrices); h.set(key, "private");
      expect(check(MINDBODY_PUBLIC_READ_ACTIONS.servicePrices, [prices], source, h)).toBe(false);
    }
  });

  it("enforces the action-specific argument count, identifiers, timezone and collection limits", () => {
    expect(check(MINDBODY_PUBLIC_READ_ACTIONS.servicePrices, prices)).toBe(false);
    expect(check(MINDBODY_PUBLIC_READ_ACTIONS.servicePrices, [prices, prices])).toBe(false);
    expect(check(MINDBODY_PUBLIC_READ_ACTIONS.servicePrices, [{ ...prices, serviceIds: [service, service] }])).toBe(false);
    expect(check(MINDBODY_PUBLIC_READ_ACTIONS.servicePrices, [{ ...prices, serviceIds: Array.from({ length: 41 }, (_, i) => `asrv_Service${String(i).padStart(8, "0")}`) }])).toBe(false);
    expect(check(MINDBODY_PUBLIC_READ_ACTIONS.servicePrices, [{ ...prices, locationTimezone: "America/Unknown" }])).toBe(false);
    expect(check(MINDBODY_PUBLIC_READ_ACTIONS.servicePrices, [{ ...prices, businessId: 5743764 }])).toBe(false);
    expect(check(MINDBODY_PUBLIC_READ_ACTIONS.nextAvailable, [{ ...prices, includedStaffIds: ["private-staff"] }])).toBe(false);
    expect(check(MINDBODY_PUBLIC_READ_ACTIONS.nextAvailable, [prices])).toBe(false);
    expect(check(MINDBODY_PUBLIC_READ_ACTIONS.decodeServiceId, ["checkout"])).toBe(false);
    expect(check(MINDBODY_PUBLIC_READ_ACTIONS.decodeServiceId, [service, "extra"])).toBe(false);
    expect(isMindbodyPublicReadPost(new URL(source), headers(MINDBODY_PUBLIC_READ_ACTIONS.decodeServiceId), " ".repeat(16_385))).toBe(false);
  });

  it("does not let JSON/GraphQL-like data bypass an unknown Next action", () => {
    const h = new Headers({ "content-type": "application/json", "next-action": "a".repeat(40) });
    expect(isAnonymousBrowserReadPost(new URL("https://public.example/graphql"), h, JSON.stringify({ query: "{ slots { time } }" }))).toBe(false);
    h.delete("next-action");
    expect(isAnonymousBrowserReadPost(new URL("https://public.example/graphql"), h, JSON.stringify({ query: "{ slots { time } }" }))).toBe(true);
  });

  it("forwards Next-Action only after validation and rejects the header on GET or other hosts", () => {
    const action = MINDBODY_PUBLIC_READ_ACTIONS.decodeServiceId;
    const original = Object.fromEntries(headers(action));
    const target = new Headers({ "content-type": original["content-type"], origin: original.origin });
    expect(addVerifiedMindbodyReadHeaders(new URL(source), "POST", original, target, JSON.stringify([service]))).toBe(true);
    expect(target.get("next-action")).toBe(action);
    expect(target.get("referer")).toBe(source);
    for (const [url, method] of [[source, "GET"], ["https://public.example/graphql", "POST"]]) {
      const output = new Headers({ "content-type": original["content-type"], origin: original.origin });
      expect(addVerifiedMindbodyReadHeaders(new URL(url), method, original, output, JSON.stringify([service]))).toBe(false);
      expect(output.has("next-action")).toBe(false);
      expect(output.has("referer")).toBe(false);
    }
    expect(addVerifiedMindbodyReadHeaders(new URL(source), "GET", {}, new Headers(), "")).toBe(true);
  });
});

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
it.runIf(existsSync(executablePath))("isolated browser forwards an authorized read and aborts unknown action headers before transport", async () => {
  const { createCourseDiscoveryBrowserSession } = await import("@/lib/course-discovery/browser-session");
  const accepted: Array<{ method: string; action: string | null; referer: string | null }> = [];
  const known = MINDBODY_PUBLIC_READ_ACTIONS.decodeServiceId;
  const html = `<!doctype html><html><body><h1>Public services</h1><script>
    const send = (action, body, type='text/plain;charset=UTF-8') => fetch(location.href, {method:'POST',headers:{'content-type':type,'next-action':action},body:JSON.stringify(body)}).catch(()=>{});
    Promise.all([send('${known}',['${service}']),send('${"a".repeat(40)}',['${service}']),send('${"a".repeat(40)}',{query:'{ slots { time } }'},'application/json')]).then(()=>{document.body.dataset.done='true';});
  </script></body></html>`;
  const session = await createCourseDiscoveryBrowserSession({ initialUrls: [source], deadlineAt: new Date(Date.now() + 20_000) }, {
    launchBrowser: () => chromium.launch({ executablePath, headless: true }),
    requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    fetch: (async (_url, init) => {
      const h = new Headers(init?.headers);
      accepted.push({ method: init?.method ?? "GET", action: h.get("next-action"), referer: h.get("referer") });
      return new Response(init?.method === "POST" ? "{}" : html, { headers: { "content-type": init?.method === "POST" ? "application/json" : "text/html" } });
    }) as typeof fetch,
  });
  try {
    await session.execute({ id: 1, action: "open", url: source });
    const snapshot = await session.execute({ id: 2, action: "observe" });
    expect(accepted.filter(row => row.method === "POST")).toEqual([{ method: "POST", action: known, referer: source }]);
    expect(snapshot.blockedRequests).toBe(2);
  } finally { await session.close(); }
}, 25_000);
