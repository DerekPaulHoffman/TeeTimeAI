import { isSquarePublicServiceCatalogUrl } from "./square-public-read-policy";

export type SquarePublicServiceChoice = { catalogUrl: string; serviceId: string; name: string; nextUsed: boolean };
export type SquarePublicServiceControl = Omit<SquarePublicServiceChoice, "nextUsed"> & { operation: "ADD" | "NEXT" };
const normalize = (text: string) => text.normalize("NFKC").replace(/[\u200b-\u200d\ufeff]/gu, "").replace(/\s+/gu, " ").trim();
const publicPractice = (name: string) => name.length > 0 && name.length <= 200 &&
  /\b(?:practice|play|simulator|bay|rental)\b/iu.test(name) &&
  !/\b(?:members?|membership|subscription|package|lesson|fitting|class|camp|checkout|payment|purchase|reservation)\b/iu.test(name.replace(/\bnon[ -]?members?\b/giu, "public"));

function source(value: string) {
  try {
    const url = new URL(value);
    const match = /^(\/appointments\/[a-z0-9]{1,64}\/location\/[A-Z0-9]{13}\/services)(?:\/([A-Z0-9]{16,32}))?$/u.exec(url.pathname);
    if (!match) return null;
    const catalog = new URL(url); catalog.pathname = match[1];
    if (!isSquarePublicServiceCatalogUrl(catalog.href)) return null;
    return { catalogUrl: `${catalog.origin}${catalog.pathname}`, serviceId: match[2] ?? null };
  } catch { return null; }
}

/** Local service/date filters only. No caller URL or page assertion grants
 * network authority: the existing anonymous Square read contract remains final.
 * NEXT additionally requires an ADD observed in this same owned browser read.
 */
export function observedSquarePublicServiceControl(url: string, item: {
  tag: string; name: string; label: string; sensitiveForm?: boolean; insideForm?: boolean;
  publicHeading?: string; selectionSummary?: string;
}, choice: SquarePublicServiceChoice | null): SquarePublicServiceControl | null {
  const page = source(url);
  if (!page || item.tag !== "button" || item.sensitiveForm || item.insideForm ||
      item.label.trim() && normalize(item.label) !== normalize(item.name)) return null;
  const name = normalize(item.name);
  if (name === "Add" && page.serviceId && !choice) {
    const heading = normalize(item.publicHeading ?? "");
    return publicPractice(heading) ? { operation: "ADD", catalogUrl: page.catalogUrl, serviceId: page.serviceId, name: heading } : null;
  }
  if (name !== "Next" || page.serviceId || !choice || choice.nextUsed || choice.catalogUrl !== page.catalogUrl || !publicPractice(choice.name)) return null;
  const summary = normalize(item.selectionSummary ?? "");
  return summary.length <= 4000 && /^Appointment summary\b/u.test(summary) && summary.includes(choice.name) &&
    !/\b(?:no services added|members?|membership|lesson|checkout|customer details|payment|confirm appointment)\b/iu.test(summary)
    ? { operation: "NEXT", catalogUrl: choice.catalogUrl, serviceId: choice.serviceId, name: choice.name } : null;
}
