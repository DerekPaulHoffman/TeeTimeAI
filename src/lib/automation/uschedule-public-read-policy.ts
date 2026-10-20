import { parse, type DefaultTreeAdapterMap } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const publicId = /^(?:0|[1-9]\d{0,9})$/u;
const rental = /\b(?:simulators?|bays?)\b.*\brentals?\b/iu;
const excluded = /\b(?:lessons?|coaching|fitting|leagues?|classes?|members?|membership|package)\b/iu;
export function isUSchedulePublicRentalLabel(value: string) { return rental.test(value) && !excluded.test(value); }
function elements(node: Node): Element[] {
  return "childNodes" in node ? node.childNodes.flatMap(child => "tagName" in child ? [child, ...elements(child)] : elements(child)) : [];
}
function attr(node: Element, name: string) { return node.attrs.find(value => value.name === name)?.value; }
function text(node: Node): string {
  return "value" in node ? node.value : "childNodes" in node ? node.childNodes.map(text).join(" ") : "";
}
function bookingUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "clients.uschedule.com" && !url.port && !url.username && !url.password &&
      !url.search && !url.hash && /^\/[a-z][a-z0-9-]{2,62}\/booking$/u.test(url.pathname) ? url : undefined;
  } catch { return undefined; }
}
function validDate(value: string, format: "US" | "ISO") {
  const match = format === "US" ? /^(\d{2})\/(\d{2})\/(20\d{2})$/u.exec(value) : /^(20\d{2})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const iso = format === "US" ? `${match[3]}-${match[1]}-${match[2]}` : value;
  const date = new Date(`${iso}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso;
}

/** Public bookingBS5 client observed 2026-10-20:
 * https://clients.uschedule.com/bundles/js/bookingBS5
 * SHA256 569c4665e02740090f39df0a016d0f6087edafce318836e62f876db5f9865a0e.
 * Its explicit filter handlers call changefield and reload the public listing.
 * The same endpoint also accepts time/payment/addon transaction fields: those
 * are never authorized. Each instance is bound to successfully read public HTML
 * and its current rental options; it does not store or forward session cookies.
 */
export function createUSchedulePublicReadPolicy() {
  const sources = new Map<string, Map<string, Set<string>>>();
  return {
    observeResponse(value: string, method: string, status: number, contentType: string, body: string) {
      const url = bookingUrl(value);
      if (!url || method !== "GET" || status !== 200 || !/^text\/html(?:;|$)/iu.test(contentType) || Buffer.byteLength(body) > 2_000_000) return false;
      sources.delete(url.href);
      const nodes = elements(parse(body));
      if (nodes.length > 20_000) return false;
      const options = (id: string) => {
        const selects = nodes.filter(node => node.tagName === "select" && attr(node, "id") === id);
        return selects.length === 1 ? elements(selects[0]).filter(node => node.tagName === "option") : [];
      };
      const services = options("select_service").filter(node => isUSchedulePublicRentalLabel(text(node)) && publicId.test(attr(node, "value") ?? "") && attr(node, "value") !== "0");
      const lengths = options("select_length").filter(node => /^(?:[1-9]\d{0,2})$/u.test(attr(node, "value") ?? "") && Number(attr(node, "value")) >= 15 && Number(attr(node, "value")) <= 480);
      if (!services.length || !lengths.length) return false;
      const filters = new Map<string, Set<string>>([
        ["service_id", new Set(services.map(node => attr(node, "value")!))],
        ["length", new Set(lengths.map(node => attr(node, "value")!))],
        ["group_size", new Set(options("select_group_size").some(node => (attr(node, "value") ?? text(node).trim()) === "1") ? ["1"] : [])],
      ]);
      // The public service-type handler is a catalog filter, never a booking.
      filters.set("service_type_id", new Set(options("select_service_type").filter(node => publicId.test(attr(node, "value") ?? "") &&
        (attr(node, "value") === "0" || isUSchedulePublicRentalLabel(text(node)))).map(node => attr(node, "value")!)));
      sources.set(url.href, filters);
      return true;
    },
    allows(url: URL, headers: Headers, body: string) {
      if (Buffer.byteLength(body) > 2048 || !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(headers.get("content-type") ?? "") ||
          headers.get("origin") !== url.origin || headers.has("next-action") ||
          [...headers.keys()].some(key => /^(?:authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token)$/iu.test(key))) return false;
      const source = bookingUrl(headers.get("referer") ?? "");
      if (!source || !sources.has(source.href) || url.origin !== source.origin || url.search || url.hash || url.port || url.username || url.password) return false;
      let value: unknown;
      try { value = JSON.parse(body); } catch { return false; }
      if (url.pathname === `${source.pathname}/getavailabledates`) {
        return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 &&
          "date" in value && typeof value.date === "string" && validDate(value.date, "ISO") && value.date.endsWith("-01"));
      }
      if (url.pathname !== `${source.pathname}/changefield` || !Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== "object") return false;
      const item = value[0] as Record<string, unknown>;
      if (Object.keys(item).length !== 2 || typeof item.Name !== "string" || typeof item.Value !== "string") return false;
      return item.Name === "start_date" ? validDate(item.Value, "US") : sources.get(source.href)!.get(item.Name)?.has(item.Value) === true;
    },
    addReadHeaders(url: URL, method: string, original: Record<string, string>, headers: Headers, body: string) {
      if (url.hostname !== "clients.uschedule.com" || method !== "POST") return true;
      const proposed = new Headers(headers);
      proposed.set("referer", original.referer ?? "");
      if (!this.allows(url, proposed, body)) return false;
      headers.set("referer", proposed.get("referer")!);
      if (original["x-requested-with"] === "XMLHttpRequest") headers.set("x-requested-with", "XMLHttpRequest");
      return true;
    },
  };
}
