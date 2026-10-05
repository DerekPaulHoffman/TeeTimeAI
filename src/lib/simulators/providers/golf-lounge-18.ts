import { parse, type DefaultTreeAdapterMap } from "parse5";

import { fetchWithProviderTimeout } from "@/lib/adapters/fetch-with-timeout";
import { parseProviderComputedSlots } from "./computed-slots";

import {
  SimulatorAvailabilityError,
  type SimulatorAvailabilityInput,
  type SimulatorAvailabilityResult,
  type SimulatorAvailabilitySlot
} from "./types";

const PORTAL_ORIGIN = "https://portal.golflounge18.com";
const MAX_RESPONSE_BYTES = 400_000;
const PUBLIC_SESSION_COOKIES = new Set(["XSRF-TOKEN", "golf_lounge_18_session"]);
const PUBLIC_ID = /^[1-9]\d{0,9}$/u;
type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];

type PublicProduct = {
  id: string;
  calendarId: string;
  durationMinutes: number;
};

type PublicLanding = {
  locationId: string;
  locationName: string;
  maxPartySize: number | null;
  products: PublicProduct[];
  requestNonce: string;
};

export function isGolfLounge18PublicBookingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === PORTAL_ORIGIN &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/appointment\/book\/[1-9]\d{0,9}\/?$/u.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * Reads the same anonymous, duration-specific calendar used by the official
 * scheduler. The request-scoped public session/CSRF nonce is never persisted.
 * This adapter has no operation for selecting, holding or creating a booking.
 */
export async function fetchGolfLounge18Availability(
  input: SimulatorAvailabilityInput,
  fetchImpl: typeof fetch = fetch
): Promise<SimulatorAvailabilityResult> {
  validateInput(input);
  const landingUrl = new URL(input.offering.bookingUrl);
  landingUrl.pathname = landingUrl.pathname.replace(/\/$/u, "");
  const locationId = landingUrl.pathname.split("/").at(-1)!;
  const metadata = input.offering.providerMetadata;
  if (metadata && typeof metadata === "object" && "locationId" in metadata) {
    if (String(metadata.locationId) !== locationId) {
      throw sourceError("Simulator location metadata conflicts with its official booking source");
    }
  }

  const landingResponse = await fetchPublicResponse(
    landingUrl,
    {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      headers: { Accept: "text/html" }
    },
    fetchImpl
  );
  assertResponse(landingResponse, landingUrl, "text/html");
  const landing = parsePublicLanding(await readBoundedText(landingResponse), locationId);
  const maxPartySize = landing.maxPartySize === null
    ? input.offering.maxPartySize
    : Math.min(input.offering.maxPartySize ?? landing.maxPartySize, landing.maxPartySize);
  const product = landing.products.find((item) => item.durationMinutes === input.durationMinutes);
  if (!product) {
    throw new SimulatorAvailabilityError("UNSUPPORTED_DURATION", "The official simulator scheduler does not offer the requested session length");
  }

  const cookies = publicSessionCookies(landingResponse.headers);
  if (!cookies) {
    throw new SimulatorAvailabilityError("PUBLIC_SESSION_REQUIRED", "The public simulator calendar did not establish its anonymous request session", true);
  }
  const readUrl = new URL("/proxy_request", PORTAL_ORIGIN);
  const availabilityUrl = new URL("https://acuityscheduling.com/api/v1/availability/times");
  availabilityUrl.searchParams.set("appointmentTypeID", product.id);
  availabilityUrl.searchParams.set("calendarID", product.calendarId);
  availabilityUrl.searchParams.set("date", input.date);
  availabilityUrl.searchParams.set("admin", "false");

  // The proxy route is fixed; its only permitted upstream operation is this
  // exact public availability GET. No caller-supplied URL or method is used.
  const availabilityResponse = await fetchPublicResponse(
    readUrl,
    {
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: cookies,
        "X-CSRF-TOKEN": landing.requestNonce,
        "X-Requested-With": "XMLHttpRequest",
        Origin: PORTAL_ORIGIN,
        Referer: landingUrl.toString()
      },
      body: JSON.stringify({
        proxyMethod: "GET",
        proxyUrl: availabilityUrl.toString(),
        proxyBody: { location: landing.locationName, locationId }
      })
    },
    fetchImpl
  );
  assertResponse(availabilityResponse, readUrl, "application/json");
  let payload: unknown;
  try {
    payload = JSON.parse(await readBoundedText(availabilityResponse));
  } catch (error) {
    if (error instanceof SimulatorAvailabilityError) throw error;
    throw schemaError("The public simulator calendar returned an invalid availability response");
  }
  const slots = parseGolfLounge18Slots({ input, payload, productId: product.id, maxPartySize });
  return { slots, complete: true, observedAt: new Date(), evidenceUrl: landingUrl.toString() };
}

export function parseGolfLounge18Slots({ input, payload, productId, maxPartySize }: {
  input: SimulatorAvailabilityInput;
  payload: unknown;
  productId: string;
  maxPartySize: number | null;
}): SimulatorAvailabilitySlot[] {
  return parseProviderComputedSlots({ input, payload, productId, maxPartySize, sourcePrefix: "golf-lounge-18" });
}

function parsePublicLanding(html: string, expectedLocationId: string): PublicLanding {
  const document = parse(html);
  const elements: HtmlElement[] = [];
  function visit(node: HtmlNode) {
    if ("tagName" in node) elements.push(node);
    if ("childNodes" in node) node.childNodes.forEach(visit);
  }
  visit(document);
  const locationInput = elements.filter((element) => attr(element, "id") === "locationName");
  const locationMarker = elements.filter((element) => attr(element, "id") === "locationId");
  if (locationInput.length !== 1 || locationMarker.length !== 1 ||
    attr(locationInput[0], "data-location-id") !== expectedLocationId ||
    textContent(locationMarker[0]).trim() !== expectedLocationId) {
    throw sourceError("The public simulator calendar did not confirm the requested location");
  }
  const locationName = attr(locationInput[0], "value").trim();
  if (!locationName || locationName.length > 100) throw schemaError("The simulator location name is missing");
  const nonceInputs = elements.filter((element) => element.tagName === "input" && attr(element, "name") === "_token");
  const requestNonce = attr(nonceInputs[0], "value");
  if (!nonceInputs.length || !/^[a-zA-Z0-9_-]{10,200}$/u.test(requestNonce)) {
    throw schemaError("The public simulator calendar request session is missing");
  }
  const capacity = textContent(document).match(/Maximum\s+up\s+to\s+(\d{1,2})\s+guests\s+per\s+bay\./iu);
  const maxPartySize = capacity ? Number(capacity[1]) : null;
  if (capacity && (!Number.isInteger(maxPartySize) || maxPartySize! < 1 || maxPartySize! > 20)) {
    throw schemaError("The official simulator bay capacity is invalid");
  }
  const products: PublicProduct[] = [];
  for (const element of elements) {
    if (element.tagName !== "button" || !attr(element, "class").split(/\s/u).includes("btn-apt-type-pre")) continue;
    const name = attr(element, "data-appt-name");
    const match = name.match(/^(\d+(?:\.5)?)\s+hours?\s+bay\s+time\s+at\s+(.+)$/iu);
    if (!match) continue; // Lessons, memberships and league products are ineligible.
    if (match[2] !== locationName) throw sourceError("The simulator rental product belongs to a different location");
    const id = attr(element, "data-appt-id");
    const calendarId = attr(element, "data-calender-id");
    const durationMinutes = Number(match[1]) * 60;
    if (!PUBLIC_ID.test(id) || !PUBLIC_ID.test(calendarId) || !Number.isInteger(durationMinutes) ||
      durationMinutes < 30 || durationMinutes > 1440 || durationMinutes % 30 !== 0) {
      throw schemaError("The official simulator rental product is ambiguous or invalid");
    }
    // Some tenants also offer five-hour sessions. They must not invalidate the
    // shorter supported rentals, or expand this product's bounded input range.
    if (durationMinutes > 240) continue;
    if (products.some((product) => product.durationMinutes === durationMinutes)) {
      throw schemaError("The official simulator rental product is ambiguous or invalid");
    }
    products.push({ id, calendarId, durationMinutes });
  }
  if (!products.length) throw schemaError("The official calendar has no verified public simulator rental products");
  return { locationId: expectedLocationId, locationName, requestNonce, maxPartySize, products };
}

function validateInput(input: SimulatorAvailabilityInput) {
  if (!isGolfLounge18PublicBookingUrl(input.offering.bookingUrl)) throw sourceError("The simulator booking source is not an official public calendar");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.date) || !Number.isFinite(Date.parse(`${input.date}T12:00:00Z`)) ||
    new Date(`${input.date}T12:00:00Z`).toISOString().slice(0, 10) !== input.date ||
    !Number.isInteger(input.durationMinutes) || input.durationMinutes < 30 || input.durationMinutes > 240 || input.durationMinutes % 30 !== 0 ||
    !Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > 8 ||
    !input.offering.id || input.offering.id.length > 200 ||
    (input.offering.maxPartySize !== null && (!Number.isInteger(input.offering.maxPartySize) || input.offering.maxPartySize < 1))) {
    throw new SimulatorAvailabilityError("INVALID_REQUEST", "The simulator availability request is invalid");
  }
  try { new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }).format(); }
  catch { throw new SimulatorAvailabilityError("INVALID_REQUEST", "The simulator venue timezone is invalid"); }
  if (input.offering.supportedDurationsMinutes.length && !input.offering.supportedDurationsMinutes.includes(input.durationMinutes)) {
    throw new SimulatorAvailabilityError("UNSUPPORTED_DURATION", "This simulator offering does not support the requested session length");
  }
}

function assertResponse(response: Response, expectedUrl: URL, contentType: string) {
  if (!response.ok) {
    throw new SimulatorAvailabilityError(
      response.status === 419 ? "PUBLIC_SESSION_REQUIRED" : "HTTP_ERROR",
      "The public simulator calendar could not be read",
      response.status === 419 || response.status === 429 || response.status >= 500,
      response.status,
      response.headers.get("retry-after")
    );
  }
  if (response.url && response.url !== expectedUrl.toString()) throw sourceError("The simulator calendar changed its requested destination");
  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type !== contentType) throw schemaError("The public simulator calendar returned an unexpected response type");
}

async function fetchPublicResponse(url: URL, request: RequestInit, fetchImpl: typeof fetch) {
  try {
    return await fetchWithProviderTimeout(url, request, fetchImpl);
  } catch {
    throw new SimulatorAvailabilityError("HTTP_ERROR", "The public simulator calendar could not be reached", true);
  }
}

async function readBoundedText(response: Response): Promise<string> {
  const declaredSize = Number(response.headers.get("content-length"));
  if (declaredSize > MAX_RESPONSE_BYTES) throw schemaError("The simulator calendar response exceeds its supported size");
  if (!response.body) throw schemaError("The simulator calendar response is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw schemaError("The simulator calendar response exceeds its supported size");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SimulatorAvailabilityError) throw error;
    throw new SimulatorAvailabilityError("HTTP_ERROR", "The public simulator calendar response could not be read", true);
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(result);
}

function publicSessionCookies(headers: Headers): string {
  const values = headers.getSetCookie();
  const accepted: string[] = [];
  for (const value of values) {
    const pair = value.split(";")[0];
    const name = pair.slice(0, pair.indexOf("="));
    if (!PUBLIC_SESSION_COOKIES.has(name) || /[\r\n]/u.test(pair)) continue;
    const domain = value.match(/;\s*domain=([^;]+)/iu)?.[1]?.replace(/^\./u, "").toLowerCase();
    if (domain && domain !== "portal.golflounge18.com") continue;
    accepted.push(pair);
  }
  return accepted.some((value) => value.startsWith("golf_lounge_18_session=")) ? accepted.join("; ") : "";
}

function attr(element: HtmlElement | undefined, name: string) { return element?.attrs.find((item) => item.name === name)?.value ?? ""; }
function textContent(node: HtmlNode): string {
  if ("nodeName" in node && (node.nodeName === "script" || node.nodeName === "style")) return "";
  if ("value" in node) return node.value;
  return "childNodes" in node ? node.childNodes.map(textContent).join(" ") : "";
}
function schemaError(message: string) { return new SimulatorAvailabilityError("SCHEMA_CHANGED", message); }
function sourceError(message: string) { return new SimulatorAvailabilityError("INVALID_SOURCE", message); }
