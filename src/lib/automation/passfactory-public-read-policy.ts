const apiOrigin = "https://api.passfactory.io";
const widgetOrigins = new Set(["https://passfactory.com", "https://www.passfactory.com"]);
const resourceCode = /^[A-Za-z0-9_-]{1,64}$/u;
const calendarPaths = new Set([
  "/api/v1/availability/get-month-tickets",
  "/api/v1/availability-widget/facility-widget",
  "/api/v1/availability-widget/hall-widget",
]);

function day(value: unknown) {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}$/u.test(value)) return null;
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value ? milliseconds : null;
}

/** Exact anonymous display-data calls observed in the official PassFactory widget
 * client: business branding, calendar dates and public facility/hall times.
 * No account, reservation, checkout, coupon or payment endpoint is admitted.
 */
export function createPassfactoryPublicReadPolicy() {
  const facilities = new Set<string>();
  const halls = new Set<string>();
  const origins = new Set<string>();
  return {
    observeWidgetUrl(value: string) {
      let url: URL;
      try { url = new URL(value); } catch { return; }
      if (!widgetOrigins.has(url.origin) || url.username || url.password) return;
      const match = /^\/ftbb\/([A-Za-z0-9_-]{1,64})\/?$/u.exec(url.pathname);
      if (!match || url.searchParams.getAll("sc").length > 1) return;
      facilities.add(match[1]);
      const hall = url.searchParams.get("sc");
      if (hall && resourceCode.test(hall)) halls.add(hall);
      origins.add(url.origin);
    },
    allows(url: URL, headers: Headers, body: string) {
      if (url.origin !== apiOrigin || url.username || url.password || url.search || url.hash ||
          !origins.has(headers.get("origin") ?? "") ||
          [...headers.keys()].some(key => /authorization|cookie|token|api.?key|secret|credential/iu.test(key)) ||
          !/^application\/json(?:\s*;|$)/iu.test(headers.get("content-type") ?? "") || Buffer.byteLength(body) > 2_048) return false;
      let value: Record<string, unknown>;
      try { value = JSON.parse(body); } catch { return false; }
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const keys = Object.keys(value);
      // All permitted values are scalars without quotes: reject duplicate keys.
      if ((body.match(/"[^"\\]*"\s*:/gu) ?? []).length !== keys.length) return false;
      const key = keys.includes("facility_code") ? "facility_code" : "hall_code";
      const code = value[key];
      if (typeof code !== "string" || !resourceCode.test(code) || !(key === "facility_code" ? facilities : halls).has(code)) return false;
      if (url.pathname === "/api/v1/availability-widget/get-business-info") return keys.length === 1;
      if (!calendarPaths.has(url.pathname) || keys.length !== 4 ||
          !keys.every(k => [key, "start_date", "end_date", "type"].includes(k)) || value.type !== 2 ||
          url.pathname.endsWith("/facility-widget") && key !== "facility_code" ||
          url.pathname.endsWith("/hall-widget") && key !== "hall_code") return false;
      const start = day(value.start_date), end = day(value.end_date);
      return start !== null && end !== null && end >= start && end - start <= 62 * 86_400_000;
    },
  };
}

/** Known telemetry and decorative maps do not determine calendar completeness.
 * This classifies denied requests only; it grants no network authority.
 */
export function isIncidentalBrowserRequest(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return false;
  return ["analytics.google.com", "www.google-analytics.com", "region1.google-analytics.com", "stats.g.doubleclick.net"].includes(url.hostname) && url.pathname === "/g/collect" ||
    url.hostname === "www.google.com" && /^(?:\/g\/collect|\/ccm\/collect|\/rmkt\/collect\/\d+\/)$/u.test(url.pathname) ||
    url.hostname === "ad.doubleclick.net" && url.pathname === "/ccm/s/collect" ||
    url.hostname === "googleads.g.doubleclick.net" && /^\/pagead\/viewthroughconversion\/\d+\/$/u.test(url.pathname) ||
    url.hostname === "r.stripe.com" && url.pathname === "/b" ||
    url.hostname === "m.stripe.com" && url.pathname === "/6" ||
    url.hostname === "track-na2.hubspot.com" && ["/__ptq.gif", "/__ptc.gif"].includes(url.pathname) ||
    url.hostname === "forms-na2.hscollectedforms.net" && url.pathname === "/collected-forms/v1/config/json" ||
    url.hostname === "connect.facebook.net" && /^\/signals\/config\/\d+$/u.test(url.pathname) ||
    url.hostname === "maps.googleapis.com" && ["/maps/api/js/StaticMapService.GetMapImage",
      "/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/GetViewportInfo"].includes(url.pathname);
}
