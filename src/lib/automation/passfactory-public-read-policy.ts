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
  return /(?:^|\/)(?:favicon(?:[-\w]*)|apple-touch-icon(?:[-\w]*))\.(?:ico|png|svg)$/iu.test(url.pathname) ||
    url.hostname === "js.stripe.com" ||
    url.hostname === "www.googletagmanager.com" && ["/gtag/js", "/gtm.js"].includes(url.pathname) ||
    ["analytics.google.com", "www.google-analytics.com", "region1.google-analytics.com", "stats.g.doubleclick.net"].includes(url.hostname) ||
    url.hostname === "www.google.com" && /^(?:\/g\/collect|\/ccm\/collect|\/rmkt\/collect\/\d+\/)$/u.test(url.pathname) ||
    url.hostname === "ad.doubleclick.net" && url.pathname === "/ccm/s/collect" ||
    url.hostname === "googleads.g.doubleclick.net" && /^\/pagead\/viewthroughconversion\/\d+\/$/u.test(url.pathname) ||
    url.hostname === "r.stripe.com" && url.pathname === "/b" ||
    url.hostname === "m.stripe.com" && url.pathname === "/6" ||
    url.hostname === "track-na2.hubspot.com" && ["/__ptq.gif", "/__ptc.gif"].includes(url.pathname) ||
    url.hostname === "forms-na2.hscollectedforms.net" && url.pathname === "/collected-forms/v1/config/json" ||
    url.hostname === "js-na2.hs-scripts.com" && /^\/\d+\.js$/u.test(url.pathname) ||
    url.hostname === "connect.facebook.net" && /^(?:\/signals\/config\/\d+|\/[a-z]{2}_[A-Z]{2}\/fbevents\.js)$/u.test(url.pathname) ||
    ["e.clarity.ms", "q.clarity.ms"].includes(url.hostname) && url.pathname === "/collect" ||
    /^o\d+\.ingest\.us\.sentry\.io$/u.test(url.hostname) && /^\/api\/\d+\/envelope\/$/u.test(url.pathname) ||
    url.pathname === "/cdn-cgi/zaraz/s.js" ||
    url.hostname === "maps.googleapis.com" && ["/maps/api/js", "/maps/api/js/StaticMapService.GetMapImage",
      "/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/GetViewportInfo"].includes(url.pathname);
}

/** Chrome sometimes reports favicons, preloaded images and fonts as `other`.
 * They are outside text/JSON availability evidence and are always aborted. */
export function isNonEvidenceBrowserResource(value: string, resourceType: string) {
  if (["image", "media", "font"].includes(resourceType)) return true;
  // Deny analytics before native loader correlation, including CDP Ping.
  // This grants no read and cannot hide an application availability request.
  if (isIncidentalBrowserRequest(value)) return true;
  if (["script", "xhr"].includes(resourceType)) {
    try {
      const url = new URL(value);
      // Font Awesome clients supply icons, never tee-sheet evidence. Abort the
      // kit and its two observed icon bundles without granting their routes.
      if (url.href === value && url.protocol === "https:" && !url.port && !url.username && !url.password && !url.search && !url.hash &&
          (resourceType === "script" && url.hostname === "kit.fontawesome.com" && /^\/[a-f0-9]{10}\.js$/u.test(url.pathname) ||
            url.hostname === "ka-p.fontawesome.com" && /^\/releases\/v\d{1,2}\.\d{1,2}\.\d{1,3}\/js\/(?:pro-v4-shims|pro-plus)\.min\.js$/u.test(url.pathname))) return true;
    } catch { /* Unknown resource metadata retains ordinary validation. */ }
  }
  if (resourceType === "script") {
    // This exact optional Google Sign-In client is denied, never executed or
    // treated as inventory evidence. Rendered access gates remain separate.
    if (value === "https://accounts.google.com/gsi/client") return true;
    // The exact Datacap card-tokenization SDK is likewise never needed for
    // reading availability. No payment endpoint or account route is admitted.
    if (value === "https://token.dcap.com/v1/client") return true;
    try {
      const url = new URL(value);
      // Never execute this injected detection script or give it loader/source
      // authority. A rendered access challenge remains a separate outcome.
      if (url.protocol === "https:" && !url.port && !url.username && !url.password &&
          url.pathname === "/cdn-cgi/challenge-platform/scripts/jsd/main.js") return true;
    } catch { /* Unknown resources retain ordinary request validation. */ }
  }
  if (resourceType !== "other") return false;
  try { return /\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot)$/iu.test(new URL(value).pathname); }
  catch { return false; }
}
