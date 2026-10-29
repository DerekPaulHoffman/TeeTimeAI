import type { Locator } from "@playwright/test";
import { isSafeRecipeUrl, recipeSelectorSchema } from "./recipe";
import { isPublicAvailabilityNavigation } from "./public-navigation-control";

export type PublicRentalProductProof = { selector: string; durationMinutes: number };

/** Self-contained so the same predicate can run in the browser and in DOM tests. */
export function inspectPublicRentalProductElement(node: Element): PublicRentalProductProof | undefined {
  const helpers = {
    text(element: Element) {
      return ((element as HTMLElement).innerText ?? element.textContent ?? "")
        .replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/([A-Za-z])(\d)/gu, "$1 $2").replace(/\s+/gu, " ").trim();
    },
    visible(element: Element) {
      let parent: Element | null = element;
      for (let depth = 0; parent && depth < 40; depth++, parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (parent.hasAttribute("hidden") || parent.hasAttribute("inert") || parent.getAttribute("aria-hidden") === "true" ||
            style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      const rect = element.getBoundingClientRect();
      return !parent && rect.width > 0 && rect.height > 0;
    },
    duration(text: string) {
      const match = /^(?:(\d{1,2}(?:\.\d{1,2})?)\s*(?:hours?|hrs?|hr|h)(?:\s+(\d{1,2})\s*(?:minutes?|mins?|min|m))?|(\d{1,3})\s*(?:minutes?|mins?|min))$/iu.exec(text);
      if (!match || match[2] && Number(match[2]) >= 60) return undefined;
      const value = Number(match[1] ?? 0) * 60 + Number(match[2] ?? match[3] ?? 0);
      return Number.isInteger(value) && value >= 15 && value <= 480 ? value : undefined;
    },
    pricedDuration(text: string) {
      const match = /^(.+?)\s+(?:\$\s*\d{1,5}(?:\.\d{2})?|USD\s+\d{1,5}(?:\.\d{2})?)$/iu.exec(text);
      return match ? this.duration(match[1]) : undefined;
    },
    selector(element: Element) {
      const parts: string[] = [];
      let current: Element | null = element;
      for (let depth = 0; current && depth < 16 && current.tagName !== "HTML"; depth++, current = current.parentElement) {
        if (/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/u.test(current.id) && document.querySelectorAll(`[id="${current.id}"]`).length === 1)
          return [`[id="${current.id}"]`, ...parts].join(" > ");
        const siblings = current.parentElement ? Array.from(current.parentElement.children).filter(child => child.tagName === current!.tagName) : [current];
        parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`);
        const value = parts.join(" > ");
        if (document.querySelectorAll(value).length === 1 && document.querySelector(value) === element) return value;
      }
      return undefined;
    },
  };
  if (!["BUTTON", "A"].includes(node.tagName) || !helpers.visible(node) || node.matches(":disabled") ||
      node.getAttribute("aria-disabled") === "true" || node.closest("form") || node.querySelector("input,select,textarea")) return undefined;
  if (node.tagName === "A") {
    try {
      const url = new URL((node as HTMLAnchorElement).href);
      if (url.protocol !== "https:" || url.username || url.password ||
          /(?:^|\/)(?:login|signin|signup|auth|account|profile|review|checkout|cart|payment|pay|purchase|orders?|confirm|admin)(?:\/|$)/iu.test(decodeURIComponent(url.pathname)) ||
          [...url.searchParams].some(([key, value]) => /password|secret|token|cookie|session|credential|authorization|api.?key|email|phone/iu.test(key) ||
            /^(?:time(?:_?id)?|start(?:_?time)?|end_?time|tee_?time(?:_?id)?|slot(?:_?id)?|booking_?id|reservation_?id)$/iu.test(key) ||
            /^(?:action|step)$/iu.test(key) && /^(?:review|checkout|confirm|pay|login|account)$/iu.test(value))) return undefined;
    } catch { return undefined; }
  }
  // This public catalogue uses the whole rental card as its button. Opening
  // that card, or its undated Overview, reveals a calendar; neither operation
  // selects a time. Keep this distinct from dated slot buttons and checkout.
  const swiftCatalogue = /^https:\/\/book\.runswiftapp\.com\/facilities\/[a-z0-9][a-z0-9-]{0,99}\/rentals$/u.test(document.location.href);
  if (swiftCatalogue && node.tagName === "BUTTON" && node.getAttribute("type") === "button" && !node.hasAttribute("onclick")) {
    const datedOrTransactional = /\b(?:checkout|check out|pay|payment|purchase|buy|reserve|confirm|submit|cancel|delete|password|sign in|sign up|log in|login|contact|email|phone|cart|membership)\b|\b\d{1,2}:\d{2}|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d/iu;
    const oneGolfBay = /^golf sim(?:ulator)?(?: bay)? [1-9]\d?(?: \((?:off )?peak\))?$/iu;
    const dialog = node.closest('[role="dialog"]');
    let container: Element | null = null;
    if (dialog) {
      const title = dialog.querySelector("h2"), names = Array.from(dialog.querySelectorAll("h5")).filter(helpers.visible);
      const buttons = Array.from(dialog.querySelectorAll("button")).filter(helpers.visible);
      if (/^book now$/iu.test(helpers.text(node)) && title && helpers.text(title) === "Overview" && names.length === 1 && oneGolfBay.test(helpers.text(names[0])) &&
          buttons.length === 3 && buttons.every(button => button === node || /^(?:Back|Close)$/u.test(button.getAttribute("aria-label") ?? "")) &&
          !dialog.querySelector('input,select,textarea,[role="combobox"],form')) container = dialog;
    } else {
      const titles = Array.from(node.querySelectorAll("h6")).filter(helpers.visible), prices = Array.from(node.querySelectorAll("h5")).filter(helpers.visible);
      if (titles.length === 1 && oneGolfBay.test(helpers.text(titles[0])) && prices.length === 1 && /^\$\d{1,5}(?:\.\d{2})?$/u.test(helpers.text(prices[0])) &&
          Array.from(document.querySelectorAll("h5")).some(heading => helpers.visible(heading) && helpers.text(heading) === "Rentals")) container = node;
    }
    if (container) {
      const text = helpers.text(container), leaves = Array.from(container.querySelectorAll("p,span,div")).filter(element => element.childElementCount === 0 && helpers.visible(element));
      if (text.length <= 2400 && leaves.length <= 128 && !datedOrTransactional.test(text) &&
          !leaves.some(element => datedOrTransactional.test(helpers.text(element))) &&
          !container.querySelector('input,select,textarea,[role="combobox"],form')) {
        const durations = [...new Set(leaves.flatMap(element => {
          const value = helpers.text(element).replace(/\s*[-–]\s*(?=\$)/u, " ");
          const duration = helpers.duration(value) ?? helpers.pricedDuration(value);
          return duration === undefined ? [] : [duration];
        }))];
        const selector = helpers.selector(node);
        if (durations.length === 1 && durations[0] === 60 && selector) return { selector, durationMinutes: 60 };
      }
    }
  }
  const selectedText = helpers.text(node), action = /^(?:book|select)$/iu.test(selectedText);
  const selectedDuration = helpers.pricedDuration(selectedText);
  if (!action && selectedDuration === undefined) return undefined;
  // A product option is not a dated start time, booking confirmation, or contact step.
  const unsafe = /\b(?:checkout|check out|pay|payment|purchase|buy|reserve|confirm|submit|cancel|delete|password|sign in|sign up|log in|login|contact|email|phone|cart|membership|members?|lessons?|fittings?|leagues?)\b|\b\d{1,2}:\d{2}|\b\d{1,2}\s*(?:am|pm)\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d/iu;
  let context: Element | null = node;
  for (let depth = 0; context && depth < 16; depth++, context = context.parentElement) {
    if (context.tagName === "FORM" || unsafe.test(`${context.getAttribute("aria-label") ?? ""} ${context.getAttribute("title") ?? ""}`)) return undefined;
  }
  let card = node.parentElement;
  for (let depth = 0; card && depth < 6 && !["BODY", "HTML", "FORM"].includes(card.tagName); depth++, card = card.parentElement) {
    const text = helpers.text(card);
    if (text.length > 2000 || unsafe.test(text) || card.querySelector("input,select,textarea")) continue;
    const controls = Array.from(card.querySelectorAll("button,a")).filter(element => helpers.visible(element));
    if (controls.length === 0 || controls.length > 32 || !controls.includes(node)) continue;
    if (action) {
      if (controls.length !== 1) continue;
      const headings = Array.from(card.querySelectorAll("h1,h2,h3,h4,h5,h6")).filter(element => helpers.visible(element));
      const publishedNodes = Array.from(card.querySelectorAll("p,span,div"));
      let unique: number[] = [];
      if (headings.length === 1 && publishedNodes.length <= 128) {
        // A standalone advertised duration describes the rental. Heading text
        // and narrative play/reset minutes do not redefine that interval.
        unique = [...new Set(publishedNodes.filter(element => !element.contains(headings[0]) && !headings[0].contains(element) && helpers.visible(element) &&
          !element.closest('button,a,[role="button"],[role="combobox"]') && !element.querySelector('button,a,[role="button"],input,select,textarea,[role="combobox"]'))
          .map(element => helpers.text(element)).filter(value => value.length <= 200)
          .map(value => helpers.duration(value)).filter((value): value is number => value !== undefined))];
        if (unique.length > 1) continue;
      }
      if (!unique.length) {
        const durations = Array.from(text.matchAll(/\b(\d+(?:\.\d+)?)\s*(hours?|hrs?|hr|minutes?|mins?|min)\b/giu))
          .map(match => Number(match[1]) * (/^h/iu.test(match[2]) ? 60 : 1));
        unique = [...new Set(durations)];
      }
      if (unique.length !== 1 || !Number.isInteger(unique[0]) || unique[0] < 15 || unique[0] > 480) continue;
      const selector = helpers.selector(card);
      if (selector) return { selector, durationMinutes: unique[0] };
      continue;
    }
    // Duration/price buttons need one independently visible rental-resource label.
    // A wrapper containing several resources must never become the product card.
    const candidates = Array.from(card.querySelectorAll("h1,h2,h3,h4,h5,h6,legend,[role=heading],[data-resource-name],[data-product-name]"));
    for (const child of Array.from(card.children)) if (!child.contains(node) && !candidates.includes(child) && !child.querySelector("h1,h2,h3,h4,h5,h6,legend,[role=heading]")) candidates.push(child);
    const labels = candidates.filter(element => helpers.visible(element) && !element.closest("button,a") &&
      helpers.text(element).length <= 160 && /\b(?:bays?|simulators?|rental|golf time|golf session)\b/iu.test(helpers.text(element)));
    if (labels.length !== 1) continue;
    const durations = controls.map(element => helpers.pricedDuration(helpers.text(element)));
    if (durations.some(value => value === undefined) || new Set(durations).size !== durations.length) continue;
    const selector = helpers.selector(card);
    if (selector) return { selector, durationMinutes: selectedDuration! };
  }
  return undefined;
}

export async function inspectPublicRentalProduct(node: Locator): Promise<PublicRentalProductProof | undefined> {
  if (await node.count() !== 1) return undefined;
  const proof = await node.evaluate(inspectPublicRentalProductElement, undefined, { timeout: 1000 });
  if (proof) {
    const href = await node.evaluate(element => element.tagName === "A" ? (element as HTMLAnchorElement).href : undefined, undefined, { timeout: 1000 });
    if (href && (!isSafeRecipeUrl(href) || !isPublicAvailabilityNavigation(href, "Select"))) return undefined;
  }
  return proof && recipeSelectorSchema.safeParse(proof.selector).success ? proof : undefined;
}

/** Revalidate the same public card immediately before clicking a recipe product. */
export async function selectPublicRentalProduct(node: Locator, card: Locator, durationMinutes: number): Promise<void> {
  if (await card.count() !== 1 || !await card.isVisible()) throw new Error("UNSAFE_PRODUCT_SELECTION");
  const proof = await inspectPublicRentalProduct(node);
  if (!proof || proof.durationMinutes !== durationMinutes) throw new Error("UNSAFE_PRODUCT_SELECTION");
  // Compare actual DOM identity, not two selectors' spelling or their text.
  const handle = await card.elementHandle();
  try {
    if (!handle || !await node.page().locator(proof.selector).evaluate((element, selectedCard) => element === selectedCard, handle))
      throw new Error("UNSAFE_PRODUCT_SELECTION");
    await node.click();
  } finally { await handle?.dispose(); }
}
