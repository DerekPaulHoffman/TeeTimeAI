import type { Locator, Page } from "@playwright/test";

/** A dated calendar choice is a complete date, never a dated time/product card. */
export function inspectPublicDateChoiceElement(value: Element | string,
  currentChoice?: { selector: string; date: string }): { date: string; alreadySelected?: true } | undefined {
  const helpers = {
    parse(text: string) {
      if (text.length > 100 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return undefined;
      const match = /^(?:(Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?),?\s+)?(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2})(?:\s+(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday))?$/iu.exec(text.replace(/\s+/gu, " ").trim());
      if (!match) return undefined;
      const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(match[2].slice(0, 3).toLowerCase());
      const day = Number(match[3]), year = Number(match[4]), parsed = new Date(Date.UTC(year, month, day));
      const weekday = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][parsed.getUTCDay()];
      if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month || parsed.getUTCDate() !== day ||
          match[1] && weekday !== match[1].slice(0, 3).toLowerCase() || match[5] && weekday !== match[5].slice(0, 3).toLowerCase()) return undefined;
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
    parseAvailable(text: string): string | undefined {
      const match = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2})(st|nd|rd|th) (20\d{2}), Available$/u.exec(text);
      if (!match) return undefined;
      const day = Number(match[3]);
      const ordinal = day % 100 >= 11 && day % 100 <= 13 ? "th" : day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
      return match[4] === ordinal ? helpers.parse(`${match[1]}, ${match[2]} ${day}, ${match[5]}`) : undefined;
    },
    privateContext(text: string): boolean {
      const normalized = text.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/[_-]/gu, " ");
      return text.length > 400 || /\b(?:book|booking|reserve|reservation|checkout|payment|pay|purchase|confirm|continue|cart|password|login|contact|email|phone|birth|birthday|birthdate|dateofbirth|dob|account|membership)\b/iu.test(normalized);
    },
    presentationDate(element: Element): { date: string } | undefined {
      const table = element.closest('table[role="presentation"]');
      if (!table || element.tagName !== "TD" || element.getAttribute("role") !== "button" || element.getAttribute("tabindex") !== "0" ||
          element.closest("form") || element.hasAttribute("form") || table.querySelector('input,select,textarea,a,button,form,[contenteditable]:not([contenteditable="false"])') ||
          table.querySelectorAll("*").length > 620 || helpers.text(table).length > 5000) return undefined;
      let ancestor: Element | null = element;
      for (let depth = 0; ancestor && depth < 40; depth++, ancestor = ancestor.parentElement) {
        const hints = `${ancestor.getAttribute("aria-label") ?? ""} ${ancestor.getAttribute("title") ?? ""} ${ancestor.getAttribute("name") ?? ""}`;
        if (ancestor.getAttribute("aria-disabled") === "true" || helpers.privateContext(hints) ||
            ancestor instanceof HTMLElement && ancestor.isContentEditable ||
            ancestor.hasAttribute("contenteditable") && ancestor.getAttribute("contenteditable")?.toLowerCase() !== "false") return undefined;
      }
      if (ancestor || table.children.length !== 1 || table.children[0].tagName !== "TBODY") return undefined;
      const rows = Array.from(table.children[0].children);
      if (rows.length < 2 || rows.length > 7 || rows.some(row => row.tagName !== "TR" || row.children.length !== 7)) return undefined;
      const weekdays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
      if (Array.from(rows[0].children).some((cell, index) => cell.tagName !== "TH" || cell.childElementCount !== 0 || helpers.text(cell) !== weekdays[index])) return undefined;
      const dates: string[] = [];
      let selected: string | undefined;
      for (const row of rows.slice(1)) {
        for (const [column, cell] of Array.from(row.children).entries()) {
          if (cell.tagName !== "TD" || cell.childElementCount !== 0 || cell.hasAttribute("form") ||
              helpers.privateContext(`${cell.getAttribute("title") ?? ""} ${cell.getAttribute("name") ?? ""}`)) return undefined;
          const text = helpers.text(cell);
          if (!cell.hasAttribute("role") && !cell.hasAttribute("tabindex")) {
            if (cell.getAttribute("aria-label") || text && (!/^\d{1,2}$/u.test(text) || Number(text) < 1 || Number(text) > 31)) return undefined;
            continue;
          }
          const date = helpers.parseAvailable(cell.getAttribute("aria-label") ?? "");
          if (cell.getAttribute("role") !== "button" || cell.getAttribute("tabindex") !== "0" || cell.hasAttribute("disabled") ||
              cell.getAttribute("aria-disabled") === "true" || !helpers.visible(cell) || !date || !/^\d{1,2}$/u.test(text) ||
              Number(text) !== Number(date.slice(8)) || new Date(`${date}T00:00:00Z`).getUTCDay() !== column) return undefined;
          if (dates.length && Date.parse(`${date}T00:00:00Z`) - Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) !== 86_400_000) return undefined;
          dates.push(date);
          if (cell === element) selected = date;
        }
      }
      return selected && dates.length >= 2 && dates.length <= 42 && new Set(dates).size === dates.length ? { date: selected } : undefined;
    },
  };
  if (currentChoice) {
    if (typeof value === "string") return undefined;
    const candidates = Array.from(value.ownerDocument.querySelectorAll(currentChoice.selector));
    if (candidates.length > 1000) return undefined;
    const matching = candidates.filter(node => [node.getAttribute("aria-label") ?? "", helpers.text(node)]
      .some(text => (helpers.parse(text) ?? helpers.parseAvailable(text)) === currentChoice.date));
    if (matching.length !== 1 || matching[0] !== value) return undefined;
  }
  if (typeof value === "string") { const date = helpers.parse(value) ?? helpers.parseAvailable(value); return date ? { date } : undefined; }
  if (value.tagName === "TD") return helpers.presentationDate(value);
  const numericDay = /^\d{1,2}$/u.test(helpers.text(value));
  const date = helpers.parse(numericDay ? value.getAttribute("aria-label") ?? "" : helpers.text(value));
  if (!date || value.tagName !== "BUTTON" || value.matches(":disabled") || value.getAttribute("aria-disabled") === "true" || !helpers.visible(value) ||
      (value as HTMLButtonElement).form || value.hasAttribute("form") || value.closest("form") || value.querySelector("input,select,textarea,a")) return undefined;
  if (numericDay) {
    const grid = value.closest('[role="grid"]'), cell = value.closest('[role="gridcell"]');
    if (!grid || !cell || !grid.contains(cell) || cell.closest('[role="grid"]') !== grid || Number(helpers.text(value)) !== Number(date.slice(8)) ||
        grid.querySelector('input,select,textarea,a,form,[contenteditable]:not([contenteditable="false"])') || grid.querySelectorAll("*").length > 620) return undefined;
    const choices = Array.from(grid.querySelectorAll("button")).filter(node => helpers.visible(node));
    if (choices.length < 2 || choices.length > 62) return undefined;
    const dates = choices.map(node => {
      const explicit = helpers.parse(node.getAttribute("aria-label") ?? ""), cell = node.closest('[role="gridcell"]');
      return explicit && /^\d{1,2}$/u.test(helpers.text(node)) && Number(helpers.text(node)) === Number(explicit.slice(8)) &&
        !(node as HTMLButtonElement).form && !node.hasAttribute("form") &&
        !/\b(?:book|booking|reserve|reservation|checkout|payment|purchase|confirm|cart|password|login|contact|email|phone|birth|birthday|dob|account|membership)\b/iu.test(node.getAttribute("title") ?? "") &&
        cell && grid.contains(cell) && node.closest('[role="grid"]') === grid ? explicit : undefined;
    });
    if (dates.some(date => !date) || new Set(dates).size !== dates.length ||
        helpers.text(grid).length > 5000 || /\b(?:book|booking|reserve|reservation|checkout|payment|purchase|confirm|cart|password|login|contact|email|phone|birth|birthday|dob|account|membership)\b/iu.test(helpers.text(grid))) return undefined;
    let ancestor: Element | null = grid;
    for (let depth = 0; ancestor && depth < 40; depth++, ancestor = ancestor.parentElement) {
      if (ancestor.getAttribute("aria-disabled") === "true" || /\b(?:book|booking|reserve|reservation|checkout|payment|purchase|confirm|cart|password|login|contact|email|phone|birth|birthday|dob|account|membership)\b/iu.test(
        `${ancestor.getAttribute("aria-label") ?? ""} ${ancestor.getAttribute("title") ?? ""}`)) return undefined;
    }
    return ancestor ? undefined : { date, ...(value.getAttribute("aria-pressed") === "true" ? { alreadySelected: true as const } : {}) };
  }
  const parent = value.parentElement;
  if (!parent || ["BODY", "HTML", "FORM"].includes(parent.tagName) || parent.querySelector("input,select,textarea") || parent.querySelectorAll("*").length > 620) return undefined;
  const choices = Array.from(parent.children).filter(node => node.tagName === "BUTTON" && helpers.visible(node));
  if (choices.length < 2 || choices.length > 62) return undefined;
  const dates = choices.map(node => helpers.parse(helpers.text(node)));
  if (dates.some(date => !date) || new Set(dates).size !== dates.length) return undefined;
  let ancestor: Element | null = parent;
  for (let depth = 0; ancestor && depth < 16; depth++, ancestor = ancestor.parentElement) {
    if (/\b(?:checkout|payment|purchase|confirm|cart|password|login|contact|email|phone|birth|birthday|dob|account|membership)\b/iu.test(`${ancestor.getAttribute("aria-label") ?? ""} ${ancestor.getAttribute("title") ?? ""}`)) return undefined;
  }
  return { date, ...(value.getAttribute("aria-pressed") === "true" ? { alreadySelected: true as const } : {}) };
}

export function parsePublicDateChoice(value: string) { return inspectPublicDateChoiceElement(value)?.date; }

export async function isPublicDateChoice(node: Locator, date: string): Promise<boolean> {
  return await node.count() === 1 && (await node.evaluate(inspectPublicDateChoiceElement, undefined, { timeout: 1000 }))?.date === date;
}

export async function observedPublicDateChoices(page: Page): Promise<Array<{ locator: Locator; date: string }>> {
  const nodes = page.locator('button,td[role="button"][tabindex="0"]');
  const candidates = await nodes.evaluateAll(elements => elements.slice(0, 3000).map((node, index) => ({ index,
    text: (node as HTMLElement).innerText ?? "", ariaLabel: node.getAttribute("aria-label") ?? "" }))
    .filter(node => [node.ariaLabel, node.text].some(text => /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/iu.test(text.trim()) && text.length <= 100))
    .map(node => node.index).slice(0, 100));
  const choices: Array<{ locator: Locator; date: string }> = [];
  for (const index of candidates) {
    const locator = nodes.nth(index), proof = await locator.evaluate(inspectPublicDateChoiceElement, undefined, { timeout: 1000 });
    if (proof) choices.push({ locator, date: proof.date });
  }
  return choices;
}

export async function selectPublicDateChoice(page: Page, selector: string, date: string,
  beforeClick?: (proof: { date: string; alreadySelected: boolean }) => void): Promise<Locator> {
  const candidates = page.locator(selector);
  if (await candidates.count() > 1000) throw new Error("AMBIGUOUS_DATE_CHOICE");
  const text = await candidates.evaluateAll(elements => elements.map((element, index) => ({ index,
    text: ((element as HTMLElement).innerText ?? "").slice(0, 101), ariaLabel: (element.getAttribute("aria-label") ?? "").slice(0, 101) })));
  const indexes = text.filter(value => parsePublicDateChoice(value.ariaLabel ?? "") === date || parsePublicDateChoice(value.text) === date).map(value => value.index);
  if (indexes.length > 62) throw new Error("AMBIGUOUS_DATE_CHOICE");
  const matching: Locator[] = [];
  for (const index of indexes) {
    const node = candidates.nth(index);
    if ((await node.evaluate(inspectPublicDateChoiceElement, undefined, { timeout: 1000 }))?.date === date) matching.push(node);
  }
  if (matching.length !== 1 || (await matching[0].evaluate(inspectPublicDateChoiceElement, undefined, { timeout: 1000 }))?.date !== date) throw new Error("AMBIGUOUS_DATE_CHOICE");
  if (beforeClick) {
    const handle = await matching[0].elementHandle();
    if (!handle) throw new Error("AMBIGUOUS_DATE_CHOICE");
    try {
      const proof = await handle.evaluate(inspectPublicDateChoiceElement, { selector, date });
      if (proof?.date !== date) throw new Error("AMBIGUOUS_DATE_CHOICE");
      // Synchronous controller work runs after the same handle's full proof.
      // Never resolve the selector again after deciding whether to carry a read.
      beforeClick({ date: proof.date, alreadySelected: proof.alreadySelected === true });
      await handle.click();
    } finally { await handle.dispose(); }
  } else await matching[0].click();
  return matching[0];
}
