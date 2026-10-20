import type { Locator } from "@playwright/test";
import { isSafeRecipeUrl } from "./recipe";
import { canonicalCpsPublicUrl } from "./cps-public-navigation";

/** Navigation into a public availability page never carries a selected time. */
export function isPublicAvailabilityNavigation(url: string, text: string): boolean {
  url = canonicalCpsPublicUrl(url);
  if (!isSafeRecipeUrl(url) || !text.trim() || text.length > 160 ||
      /\b(?:checkout|pay|payment|purchase|buy|confirm|submit|cancel|delete|login|log in|sign in|sign up|register|password|contact|email|phone)\b|\b\d{1,2}:\d{2}|\b\d{1,2}\s*(?:am|pm)\b/iu.test(text)) return false;
  const parsed = new URL(url);
  return !/(?:^|\/)(?:review|account|profile|confirmation|checkout|cart|payment|pay|purchase|login|signin|signup)(?:\/|$)/iu.test(decodeURIComponent(parsed.pathname)) &&
    ![...parsed.searchParams].some(([key, value]) => /^(?:time|start)$/iu.test(key) ? !/^(?:AnyTime|Any|All)$/iu.test(value) :
      /^(?:time_?id|start_?time|end_?time|tee_?time(?:_?id)?|slot(?:_?id)?|booking_?id|reservation_?id)$/iu.test(key) ||
      /^(?:action|step)$/iu.test(key) && /^(?:review|checkout|confirm|pay|login|account)$/iu.test(value));
}

export async function followPublicAvailabilityLink(node: Locator, expectedText: string, allowsUrl: (url: string) => boolean): Promise<void> {
  if (await node.count() !== 1 || !await node.isVisible() || !await node.isEnabled()) throw new Error("UNSAFE_PUBLIC_LINK");
  const observed = await node.evaluate(element => {
    let ancestor: Element | null = element, hidden = false;
    for (let depth = 0; ancestor && depth < 40; depth++, ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (ancestor.hasAttribute("hidden") || ancestor.hasAttribute("inert") || ancestor.getAttribute("aria-hidden") === "true" ||
          style.display === "none" || style.visibility === "hidden" || style.opacity === "0") hidden = true;
    }
    return { tag: element.tagName, text: ((element as HTMLElement).innerText ?? "").replace(/\s+/gu, " ").trim(),
      href: element instanceof HTMLAnchorElement ? element.href : "", target: element.getAttribute("target") ?? "",
      unsafe: hidden || Boolean(ancestor) || Boolean(element.closest("form")?.querySelector('input,select,textarea')) || Boolean(element.querySelector('input,select,textarea')),
    };
  });
  if (observed.tag !== "A" || observed.text !== expectedText.replace(/\s+/gu, " ").trim() || observed.unsafe ||
      observed.target && !["_self", "_top", "_parent"].includes(observed.target.toLowerCase()) ||
      !isPublicAvailabilityNavigation(observed.href, observed.text) || !allowsUrl(canonicalCpsPublicUrl(observed.href))) throw new Error("UNSAFE_PUBLIC_LINK");
  await node.click();
}
