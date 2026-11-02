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
  try {
    const result = await (deps.lease ?? runWithProviderRequestLease)(host, async () => {
      const response = await transport(root.href, { method: "GET", credentials: "omit", redirect: "follow",
        headers: { accept: "text/html", "user-agent": "TeeTimeSpot/1.0 (public simulator identity check)" },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(6_000)]) : AbortSignal.timeout(6_000) });
      try {
        if (!response.ok || !/text\/html/iu.test(response.headers.get("content-type") ?? "")) return "UNAVAILABLE" as const;
        const html = await response.text();
        if (Buffer.byteLength(html) > 2_000_000) return "UNAVAILABLE" as const;
        const visible = text(parse(html)).replace(/\s+/gu, " ");
        return /\b(?:golf(?:\s*(?:&|and)\s*sports)?\s+simulators?|simulator\s+golf)\b/iu.test(visible) &&
          /\b(?:book(?:ing)?|rent(?:als?)?|reserve|hourly|per\s+hour)\b/iu.test(visible) ? "LIKELY" as const : "ABSENT" as const;
      } finally { await response.body?.cancel().catch(() => {}); }
    });
    return result.acquired ? result.value : "UNAVAILABLE";
  } catch { return "UNAVAILABLE"; }
}
