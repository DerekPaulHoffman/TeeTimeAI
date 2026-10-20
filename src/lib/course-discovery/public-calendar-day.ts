import type { Locator, Page } from "@playwright/test";

/** This function is serialized into the page. Keep every helper self-contained. */
function inspectCalendarDayNodes(value: Element | Element[]) {
  const nodes = Array.isArray(value) ? value.slice(0, 3000) : [value];
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const forbidden = /\b(?:login|sign\s*in|sign\s*up|checkout|payment|purchase|reserve|confirm|submit|contact|subscribe|password|email|phone)\b|\b\d{1,2}:\d{2}\b/iu;
  const helpers = {
    visible(node: Element) {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none" && !node.closest('[hidden],[aria-hidden="true"]');
    },
    sensitive(node: Element) {
      return Boolean(node.closest("form")?.querySelector('input[type=password],input[type=email],input[type=tel],[autocomplete^="cc-"]'));
    },
    month(root: Element) {
      const text = (root as HTMLElement).innerText ?? "";
      if (text.length > 12000 || root.querySelectorAll("*").length > 700 || helpers.sensitive(root)) return null;
      const weekdays = new Set([...text.matchAll(/\b(?:sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|su|mo|tu|we|th|fr|sa)\b/giu)].map(match => match[0].toLowerCase().slice(0, 2)));
      if (weekdays.size < 5) return null;
      const values = new Set<string>();
      for (const match of text.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/giu)) {
        values.add(`${match[2]}-${String(months.indexOf(match[1].toLowerCase()) + 1).padStart(2, "0")}`);
      }
      const monthSelects = [...root.querySelectorAll("select")].filter(node => helpers.visible(node));
      const years = [...root.querySelectorAll("input")].filter(node => helpers.visible(node) && /year/iu.test(`${node.className} ${node.getAttribute("aria-label") ?? ""}`) && /^(?:19|20|21|22)\d{2}$/u.test(node.value));
      for (const select of monthSelects) {
        const name = select.selectedOptions[0]?.textContent?.trim().toLowerCase() ?? "";
        const month = months.indexOf(name);
        if (month >= 0) for (const year of years) values.add(`${year.value}-${String(month + 1).padStart(2, "0")}`);
      }
      return values.size === 1 ? [...values][0] : null;
    },
    explicit(node: Element) {
      return /(?:^|\s)(?:flatpickr-day|calendar-day|datepicker-day)(?:\s|$)/iu.test(node.className) ||
        /\b\d{4}-\d{2}-\d{2}\b/u.test([node.getAttribute("aria-label"), node.getAttribute("data-date"), node.getAttribute("data-testid")].join(" "));
    },
    day(node: Element, root: Element, month: string) {
      if (!["DIV", "SPAN"].includes(node.tagName) || !helpers.visible(node) || helpers.sensitive(node) ||
          node.getAttribute("aria-disabled") === "true" || node.hasAttribute("disabled") ||
          /(?:^|\s)(?:disabled|flatpickr-disabled|prevMonthDay|nextMonthDay|outside-month|other-month)(?:\s|$)/iu.test(node.className)) return null;
      const text = ((node as HTMLElement).innerText ?? "").trim();
      if (!/^(?:[1-9]|[12]\d|3[01])$/u.test(text)) return null;
      const date = `${month}-${text.padStart(2, "0")}`;
      if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return null;
      const labels = [node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("data-date"), node.getAttribute("data-testid")].filter(Boolean).join(" ");
      if (forbidden.test(labels)) return null;
      const dates = [...labels.matchAll(/\b\d{4}-\d{2}-\d{2}\b/gu)].map(match => match[0]);
      for (const match of labels.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/giu))
        dates.push(`${match[3]}-${String(months.indexOf(match[1].toLowerCase()) + 1).padStart(2, "0")}-${match[2].padStart(2, "0")}`);
      if (dates.some(value => value !== date)) return null;
      let parent = node.parentElement;
      while (parent && parent !== root) {
        if (helpers.explicit(parent) || ["A", "BUTTON", "INPUT", "SELECT"].includes(parent.tagName) ||
            forbidden.test(`${parent.getAttribute("aria-label") ?? ""} ${parent.getAttribute("title") ?? ""}`)) return null;
        parent = parent.parentElement;
      }
      const children = [...node.querySelectorAll("div,span")].filter(child => helpers.visible(child));
      if (!helpers.explicit(node) && children.some(child => helpers.explicit(child) || ((child as HTMLElement).innerText ?? "").trim() === text)) return null;
      if (node.querySelector('a[href],button,input,select,[role="button"]')) return null;
      return date;
    },
  };
  const contexts = new Map<Element, { month: string; days: Map<Element, string>; counts: Map<string, number> } | null>();
  const result: Array<{ index: number; date: string }> = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (!/^(?:[1-9]|[12]\d|3[01])$/u.test(((node as HTMLElement).innerText ?? "").trim())) continue;
    let root: Element | null = node.parentElement;
    for (let depth = 0; root && depth < 8; depth++, root = root.parentElement) {
      if (!["grid", "dialog"].includes(root.getAttribute("role") ?? "") &&
          !/calendar|date.?picker|flatpickr/iu.test(`${root.id} ${root.className} ${root.getAttribute("data-testid") ?? ""}`)) continue;
      if (!contexts.has(root)) {
        const month = helpers.month(root);
        if (!month) contexts.set(root, null);
        else {
          const days = new Map<Element, string>(), counts = new Map<string, number>();
          for (const candidate of root.querySelectorAll("div,span")) {
            const date = helpers.day(candidate, root, month);
            if (date) { days.set(candidate, date); counts.set(date, (counts.get(date) ?? 0) + 1); }
          }
          contexts.set(root, { month, days, counts });
        }
      }
      const context = contexts.get(root);
      const date = context?.days.get(node);
      if (date && context?.counts.get(date) === 1) result.push({ index, date });
      if (context) break;
    }
    if (result.length >= 93) break;
  }
  return result;
}

/** Exposes distinct dates inside an observed month/year and weekday calendar. */
export async function observedPublicCalendarDays(page: Page): Promise<Array<{ locator: Locator; date: string }>> {
  const candidates = page.locator("div,span");
  return (await candidates.evaluateAll(inspectCalendarDayNodes)).map(proof => ({ locator: candidates.nth(proof.index), date: proof.date }));
}

/** Rechecks the calendar and uniqueness immediately before a public date click. */
export async function isObservedPublicCalendarDay(node: Locator, expected: string) {
  const proof = await node.evaluate(inspectCalendarDayNodes);
  return proof.length === 1 && proof[0].date === expected;
}
