// @vitest-environment node
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { addVerifiedMindbodyReadHeaders, isMindbodyPublicReadPost, MINDBODY_PUBLIC_READ_ACTIONS } from "./mindbody-public-read-policy";
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
