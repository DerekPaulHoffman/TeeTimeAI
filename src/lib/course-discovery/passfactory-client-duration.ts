import type { CourseAccessRecipeData } from "./recipe";

// Inspected public client on 2026-10-20: the Duration onChange only sets local
// state, consumed by buildMergedAvailabilities. The date effect clears it.
// Changed code must be inspected again before receiving this capability.
export const PASSFACTORY_DURATION_CLIENTS = [
  { path: "/_next/static/chunks/3rfqtzcmap9jw.js", sha256: "23a569f0a38903ae18636d0e3b4961a72553f74fa2452909de50ed7393d33983" },
  { path: "/_next/static/chunks/2cx_-hvp_1ybh.js", sha256: "aafbab6007de1e490fd0a630336f2a1a6d985a0bd232c94c158fe2def1671aff" },
] as const;
const widgetOrigins = new Set(["https://passfactory.com", "https://www.passfactory.com"]);
const apiOrigin = "https://api.passfactory.io";
const availabilityPaths = new Set(["/api/v1/availability-widget/hall-widget", "/api/v1/availability-widget/facility-widget", "/api/v1/availability/get-month-tickets"]);
type BrowserRecipe = Extract<CourseAccessRecipeData, { engine: "BROWSER_DOM" }>;
export type PublicAvailabilityRequest = { url: string; method: string; body?: string | null };

function widgetIdentity(value: string) {
  try {
    const url = new URL(value), path = /^\/ftbb\/([A-Za-z0-9_-]{1,64})\/?$/u.exec(url.pathname);
    if (!widgetOrigins.has(url.origin) || !path || url.username || url.password || url.searchParams.getAll("sc").length !== 1) return;
    const hall = url.searchParams.get("sc");
    if (hall && /^[A-Za-z0-9_-]{1,64}$/u.test(hall)) return { facility: path[1], hall };
  } catch { return; }
}

export function isInspectedPassfactoryDurationClient(urlValue: string, sha256: string) {
  try {
    const url = new URL(urlValue);
    return isPassfactoryDurationClientUrl(urlValue) && PASSFACTORY_DURATION_CLIENTS.some(client => client.path === url.pathname && client.sha256 === sha256);
  } catch { return false; }
}

export function isPassfactoryDurationClientUrl(urlValue: string) {
  try {
    const url = new URL(urlValue);
    return widgetOrigins.has(url.origin) && !url.search && !url.hash && !url.username && !url.password &&
      PASSFACTORY_DURATION_CLIENTS.some(client => client.path === url.pathname);
  } catch { return false; }
}

export function hasInspectedPassfactoryDurationClients(paths: ReadonlySet<string>) {
  return PASSFACTORY_DURATION_CLIENTS.every(client => paths.has(client.path));
}

export function isPassfactoryAvailabilityRequest(request: PublicAvailabilityRequest) {
  try {
    const url = new URL(request.url);
    return request.method === "POST" && url.origin === apiOrigin && !url.search && !url.hash && availabilityPaths.has(url.pathname);
  } catch { return false; }
}

export function isPassfactoryDurationContext(recipe: BrowserRecipe, pageUrl: string) {
  const fence = recipe.availabilityResponse;
  const source = widgetIdentity(recipe.source.bookingUrl), page = widgetIdentity(pageUrl);
  return recipe.target.kind === "SIMULATOR" && Boolean(recipe.proof.durationMinutes) &&
    Boolean(source && page && source.facility === page.facility && source.hall === page.hall) &&
    fence.url === `${apiOrigin}/api/v1/availability-widget/hall-widget` && fence.method === "POST" &&
    fence.date.source === "JSON_BODY" && fence.date.path === "start_date" && fence.endDatePath === "end_date" &&
    fence.success?.path === "code" && fence.success.equals === 200;
}

export function isPassfactoryDurationRequestBound(recipe: BrowserRecipe, pageUrl: string, date: string, request: PublicAvailabilityRequest | undefined) {
  if (!request || !isPassfactoryDurationContext(recipe, pageUrl) || request.url !== recipe.availabilityResponse.url || request.method !== "POST") return false;
  try {
    const body: unknown = JSON.parse(request.body ?? "");
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    const value = body as Record<string, unknown>;
    return Object.keys(value).length === 4 && value.start_date === date && value.end_date === date && value.type === 2 &&
      typeof value.hall_code === "string" && widgetIdentity(recipe.source.bookingUrl)?.hall === value.hall_code && widgetIdentity(pageUrl)?.hall === value.hall_code;
  } catch { return false; }
}
