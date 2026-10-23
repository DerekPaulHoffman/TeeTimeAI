import { isIP } from "node:net";

const kinds = new Set(["script", "stylesheet"]);
const sensitive = /(?:password|secret|token|cookie|session|credential|authorization|api.?key|email|phone)|^key$/iu;
const safeKey = value => typeof value === "string" && value.length <= 80 && /^[a-zA-Z0-9_\[\].-]+$/u.test(value) && !sensitive.test(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Only metadata already admitted and completed by this trusted controller.
 * This secondary projection grants no request: current schema and replay still
 * apply the unchanged public URL/header/transport policy to every actual read. */
function observedAsset(request) {
  if (!request || typeof request !== "object" || ["url", "method", "resourceType", "status"].some(key => !Object.hasOwn(request, key)) ||
      request.method !== "GET" || !kinds.has(request.resourceType) || !Number.isInteger(request.status) || request.status < 200 || request.status > 299 ||
      "blockedReason" in request || typeof request.url !== "string" || request.url.length > 2048 || /REDACTED|[\u0000-\u0020\u007f{}]/iu.test(request.url)) return null;
  try {
    const url = new URL(request.url), path = decodeURIComponent(url.pathname);
    if (url.href !== request.url || url.protocol !== "https:" || url.username || url.password || url.port || url.hash || isIP(url.hostname) ||
        !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(url.hostname) || !url.hostname.includes(".") || url.hostname.includes("..") ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid)$/iu.test(url.hostname) || url.pathname.length > 1500 ||
        /[?#*{}\u0000-\u0020\u007f\\]/u.test(path) || path.split("/").includes("..") ||
        /(?:^|\/)(?:login|signin|signup|auth|account|checkout|cart|payment|pay|purchase|orders?|confirm|admin)(?:\/|$)/iu.test(path) ||
        [...url.searchParams].some(([key, value]) => !safeKey(key) || /[\u0000-\u001f\u007f]/u.test(value))) return null;
    const queryKeys = [...new Set(url.searchParams.keys())].sort();
    if (queryKeys.length > 30) return null;
    return { origin: url.origin, path: url.pathname, methods: ["GET"], queryKeys, resourceTypes: [request.resourceType] };
  } catch { return null; }
}

/** Browser objects are private lifetime tokens. Nothing here is checkpointed,
 * inherited from another transport, supplied by the model or restored. */
export function createDiscoveryPublicAssetInventory() {
  let owner, transport, overflow = false;
  const routes = new Map();
  const clear = () => { owner = undefined; transport = undefined; overflow = false; routes.clear(); };
  return {
    begin(browser, actualTransport) {
      clear();
      if (!browser || !["NATIVE_CHROME", "PINNED_HTTP"].includes(actualTransport)) return;
      owner = browser; transport = actualTransport;
    },
    clear,
    observe(browser, snapshot) {
      if (browser !== owner || !owner) return;
      if (snapshot?.browserTransport !== transport) { clear(); return; }
      if (snapshot.completedPublicAssetRequestsOverflow === true) overflow = true;
      const completed = snapshot.completedPublicAssetRequests;
      if (completed !== undefined && (!Array.isArray(completed) || completed.length > 128 || Buffer.byteLength(JSON.stringify(completed)) > 64_000)) {
        overflow = true; return;
      }
      const requests = Array.isArray(snapshot.requests) ? snapshot.requests : [];
      if (requests.length > 1024) { overflow = true; return; }
      for (const request of [...(completed ?? []), ...requests]) {
        const route = observedAsset(request);
        if (!route) continue;
        const key = JSON.stringify([route.origin, route.path, route.resourceTypes]);
        const old = routes.get(key);
        const queryKeys = [...new Set([...(old?.queryKeys ?? []), ...route.queryKeys])].sort();
        if (queryKeys.length > 30) { overflow = true; continue; }
        routes.set(key, { ...route, queryKeys });
        if (routes.size > 128 || Buffer.byteLength(JSON.stringify([...routes.values()])) > 64_000) { overflow = true; break; }
      }
    },
    enrich(recipe, browser, actualTransport) {
      if (!["BROWSER_DOM", "BROWSER_JSON"].includes(recipe?.engine)) return recipe;
      if (!owner || owner !== browser || actualTransport !== transport) fail("DISCOVERY_PUBLIC_ASSET_CONTEXT_UNVERIFIED");
      if (overflow) fail("DISCOVERY_PUBLIC_ASSET_ROUTE_LIMIT");
      if (!routes.size) return recipe;
      if (!Array.isArray(recipe.permittedRoutes)) fail("DISCOVERY_PUBLIC_ASSET_ROUTE_INVALID");
      const merged = recipe.permittedRoutes.map(route => ({ ...route,
        ...(Array.isArray(route.methods) ? { methods: [...route.methods] } : {}),
        ...(Array.isArray(route.queryKeys) ? { queryKeys: [...route.queryKeys] } : {}),
        ...(Array.isArray(route.resourceTypes) ? { resourceTypes: [...route.resourceTypes] } : {}) }));
      for (const added of [...routes.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))) {
        // Never widen an unscoped route, a prefix, another resource kind or HEAD.
        const existing = merged.find(route => route.origin === added.origin && route.path === added.path && same(route.methods, ["GET"]) &&
          same(route.resourceTypes, added.resourceTypes) && Array.isArray(route.queryKeys) && route.queryKeys.every(safeKey));
        if (existing) existing.queryKeys = [...new Set([...existing.queryKeys, ...added.queryKeys])].sort();
        else merged.push({ ...added, methods: [...added.methods], queryKeys: [...added.queryKeys], resourceTypes: [...added.resourceTypes] });
      }
      if (merged.length > 168 || merged.filter(route => !Array.isArray(route.resourceTypes)).length > 40 ||
          merged.filter(route => Array.isArray(route.resourceTypes)).length > 128 || merged.some(route => route.queryKeys?.length > 30))
        fail("DISCOVERY_PUBLIC_ASSET_ROUTE_LIMIT");
      return { ...recipe, permittedRoutes: merged };
    },
  };
}
