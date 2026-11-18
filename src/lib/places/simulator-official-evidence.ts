import { parse, type DefaultTreeAdapterMap } from "parse5";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";

type Node = DefaultTreeAdapterMap["node"];
function text(node: Node): string {
  if ("tagName" in node && (["script", "style", "template", "noscript", "nav"].includes(node.tagName) ||
    node.attrs.some(a => a.name === "hidden" || a.name === "aria-hidden" && a.value === "true"))) return "";
  return "value" in node ? node.value : "childNodes" in node ? node.childNodes.map(text).join(" ") : "";
}

function aboutPage(document: Node, root: URL): URL | undefined {
  const links = new Map<string, URL>();
  function visit(node: Node) {
    if ("tagName" in node) {
      if (["script", "style", "template", "noscript"].includes(node.tagName) ||
        node.attrs.some(attr => attr.name === "hidden" || attr.name === "aria-hidden" && attr.value === "true")) return;
      if (node.tagName === "a" && /^(?:about|about us)$/iu.test(text(node).trim())) {
        const href = node.attrs.find(attr => attr.name === "href")?.value;
        try {
          const url = href && new URL(href, root);
          if (url && url.origin === root.origin && !url.username && !url.password && !url.search && !url.hash &&
            /^\/(?:about|about-us)\/?$/iu.test(url.pathname) && url.href !== root.href) links.set(url.href, url);
        } catch { /* An invalid link cannot establish official identity. */ }
      }
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  }
  visit(document);
  return links.size === 1 ? links.values().next().value : undefined;
}

/** Intake evidence only. This never verifies public rental, capacity or inventory. */
export async function readOfficialSimulatorEvidence(website: string, signal?: AbortSignal,
  deps: { fetch?: typeof fetch; lease?: typeof runWithProviderRequestLease } = {}): Promise<"LIKELY" | "ABSENT" | "UNAVAILABLE"> {
  const safe = getSafeCustomerBookingUrl(website);
  if (!safe) return "ABSENT";
  const root = new URL(safe), host = root.hostname.replace(/^www\./u, "");
  if (root.search || root.hash) return "ABSENT";
  const transport = deps.fetch ?? createAddressPinnedPublicFetchTransport({
    parseUrl: value => {
      const u = new URL(value);
      if (!getSafeCustomerBookingUrl(value) || u.hostname.replace(/^www\./u, "") !== host || u.search || u.hash ||
        root.protocol === "https:" && u.protocol !== "https:") throw Error("OFFICIAL_SITE_SCOPE_CHANGED");
      return u;
    }, maxResponseBytes: 2_000_000, timeoutMs: 6_000, redirectLimit: 2,
  });
  const readSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(6_000)]) : AbortSignal.timeout(6_000);
  try {
    const result = await (deps.lease ?? runWithProviderRequestLease)(host, async () => {
      const read = async (url: URL) => {
        readSignal.throwIfAborted();
        const response = await transport(url.href, { method: "GET", credentials: "omit", redirect: "follow",
          headers: { accept: "text/html", "user-agent": "TeeTimeSpot/1.0 (public simulator identity check)" },
          signal: readSignal });
        try {
          if (!response.ok || !/text\/html/iu.test(response.headers.get("content-type") ?? "")) return "UNAVAILABLE" as const;
          const html = await response.text();
          if (Buffer.byteLength(html) > 2_000_000) return "UNAVAILABLE" as const;
          const document = parse(html);
          const visible = text(document).replace(/\s+/gu, " ");
          return { document, likely: /\b(?:golf(?:\s*(?:&|and)\s*sports)?\s+simulators?|simulator\s+golf)\b/iu.test(visible) &&
            /\b(?:book(?:ing)?|rent(?:als?)?|reserve|hourly|per\s+hour)\b/iu.test(visible) };
        } finally { await response.body?.cancel().catch(() => {}); }
      };
      const home = await read(root);
      if (home === "UNAVAILABLE") return home;
      if (home.likely) return "LIKELY" as const;
      const about = root.pathname === "/" ? aboutPage(home.document, root) : undefined;
      if (!about) return "ABSENT" as const;
      const evidence = await read(about);
      return evidence === "UNAVAILABLE" ? evidence : evidence.likely ? "LIKELY" as const : "ABSENT" as const;
    });
    return result.acquired ? result.value : "UNAVAILABLE";
  } catch { return "UNAVAILABLE"; }
}
