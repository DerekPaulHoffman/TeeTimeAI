import type { Locator, Page } from "@playwright/test";

/** A dated calendar choice is a complete date, never a dated time/product card. */
export function inspectPublicDateChoiceElement(value: Element | string): { date: string } | undefined {
  const helpers = {
    parse(text: string) {
      const match = /^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2})(?:\s+(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday))?$/iu.exec(text.replace(/\s+/gu, " ").trim());
      if (!match) return undefined;
      const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(match[1].slice(0, 3).toLowerCase());
      const day = Number(match[2]), year = Number(match[3]), parsed = new Date(Date.UTC(year, month, day));
      if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month || parsed.getUTCDate() !== day ||
          match[4] && ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][parsed.getUTCDay()] !== match[4].toLowerCase()) return undefined;
      return parsed.toISOString().slice(0, 10);
    },
    visible(element: Element) {
      let ancestor: Element | null = element;
      for (let depth = 0; ancestor && depth < 40; depth++, ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (ancestor.hasAttribute("hidden") || ancestor.hasAttribute("inert") || ancestor.getAttribute("aria-hidden") === "true" ||
            style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      const rect = element.getBoundingClientRect();
      return !ancestor && rect.width > 0 && rect.height > 0;
    },
    text(element: Element) { return ((element as HTMLElement).innerText ?? element.textContent ?? "").replace(/\s+/gu, " ").trim(); },
  };
  if (typeof value === "string") { const date = helpers.parse(value); return date ? { date } : undefined; }
  const date = helpers.parse(helpers.text(value));
  if (!date || value.tagName !== "BUTTON" || value.matches(":disabled") || value.getAttribute("aria-disabled") === "true" || !helpers.visible(value) ||
      value.closest("form") || value.querySelector("input,select,textarea,a")) return undefined;
  const parent = value.parentElement;
  if (!parent || ["BODY", "HTML", "FORM"].includes(parent.tagName) || parent.querySelector("input,select,textarea") || parent.querySelectorAll("*").length > 620) return undefined;
  const choices = Array.from(parent.children).filter(node => node.tagName === "BUTTON" && helpers.visible(node));
  if (choices.length < 2 || choices.length > 62) return undefined;
  const dates = choices.map(node => helpers.parse(helpers.text(node)));
  if (dates.some(date => !date) || new Set(dates).size !== dates.length) return undefined;
  let ancestor: Element | null = parent;
  for (let depth = 0; ancestor && depth < 16; depth++, ancestor = ancestor.parentElement) {
    if (/\b(?:checkout|payment|purchase|confirm|cart|password|login|contact|email|phone)\b/iu.test(`${ancestor.getAttribute("aria-label") ?? ""} ${ancestor.getAttribute("title") ?? ""}`)) return undefined;
  }
  return { date };
}

export function parsePublicDateChoice(value: string) { return inspectPublicDateChoiceElement(value)?.date; }

export async function isPublicDateChoice(node: Locator, date: string): Promise<boolean> {
  return await node.count() === 1 && (await node.evaluate(inspectPublicDateChoiceElement, undefined, { timeout: 1000 }))?.date === date;
}

export async function observedPublicDateChoices(page: Page): Promise<Array<{ locator: Locator; date: string }>> {
  const nodes = page.locator("button");
  const candidates = await nodes.evaluateAll(elements => elements.slice(0, 3000).map((node, index) => ({ index, text: (node as HTMLElement).innerText ?? "" }))
    .filter(node => /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/u.test(node.text.trim()) && node.text.length < 100).map(node => node.index).slice(0, 100));
  const choices: Array<{ locator: Locator; date: string }> = [];
  for (const index of candidates) {
    const locator = nodes.nth(index), proof = await locator.evaluate(inspectPublicDateChoiceElement, undefined, { timeout: 1000 });
    if (proof) choices.push({ locator, date: proof.date });
  }
  return choices;
}

export async function selectPublicDateChoice(page: Page, selector: string, date: string): Promise<Locator> {
  const candidates = page.locator(selector);
  if (await candidates.count() > 1000) throw new Error("AMBIGUOUS_DATE_CHOICE");
  const text = await candidates.evaluateAll(elements => elements.map((element, index) => ({ index,
    text: ((element as HTMLElement).innerText ?? "").slice(0, 100) })));
  const indexes = text.filter(value => parsePublicDateChoice(value.text) === date).map(value => value.index);
  if (indexes.length > 62) throw new Error("AMBIGUOUS_DATE_CHOICE");
  const matching: Locator[] = [];
  for (const index of indexes) {
    const node = candidates.nth(index);
    if ((await node.evaluate(inspectPublicDateChoiceElement, undefined, { timeout: 1000 }))?.date === date) matching.push(node);
  }
  if (matching.length !== 1) throw new Error("AMBIGUOUS_DATE_CHOICE");
  await matching[0].click();
  return matching[0];
}
