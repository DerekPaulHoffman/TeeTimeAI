import type { Locator } from "@playwright/test";

/** Apply is a date-filter action only inside a real visible month/day picker.
 * A generic dialog or an Apply button beside checkout/contact fields is not
 * sufficient evidence. Replay additionally binds the current selected day. */
export async function isPublicCalendarApply(node: Locator, selection?: { day: Locator; date: string }) {
  if (selection && (await selection.day.count() !== 1 || !await selection.day.isVisible())) return false;
  const selected = selection ? await selection.day.elementHandle() : null;
  const parts = selection?.date.split("-");
  if (selection && (!parts || !/^\d{4}-\d{2}-\d{2}$/u.test(selection.date))) return false;
  try {
    return await node.evaluate((element, args) => {
      const dom = {
        visible(candidate: Element) { return Boolean((candidate as HTMLElement).offsetWidth || (candidate as HTMLElement).offsetHeight || candidate.getClientRects().length); },
        text(candidate: Element) { return ((candidate as HTMLElement).innerText ?? "").replace(/\s+/gu, " ").trim(); },
      };
      if (element.tagName !== "BUTTON" || !/^(?:Apply|Apply dates)$/iu.test(dom.text(element)) || !dom.visible(element) ||
          element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") return false;
      const boundaries = [element.closest('[role="dialog"]'), element.closest("form")].filter((item): item is Element => Boolean(item));
      if (boundaries.some(boundary => boundary.querySelector('input[type=password],input[type=email],input[type=tel],[autocomplete^="cc-"]') ||
          /\b(?:checkout|payment|credit card|cart total|confirm booking)\b/iu.test(dom.text(boundary)))) return false;
      const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
      for (let parent = element.parentElement, depth = 0; parent && depth < 8 && parent.tagName !== "BODY"; parent = parent.parentElement, depth++) {
        if (parent.querySelector('input[type=password],input[type=email],input[type=tel],[autocomplete^="cc-"]') ||
            /\b(?:checkout|payment|credit card|cart total|confirm booking)\b/iu.test(dom.text(parent))) return false;
        if (!parent.querySelector('[role="grid"],[role="gridcell"],table')) continue;
        const all = Array.from(parent.querySelectorAll("*"));
        if (all.length > 1000) return false;
        const days = new Set(Array.from(parent.querySelectorAll('button,[role="gridcell"]')).filter(candidate => dom.visible(candidate)).map(candidate => dom.text(candidate))
          .filter(value => /^(?:[1-9]|[12]\d|3[01])$/u.test(value)));
        if (days.size < 7) continue;
        const displayedMonths = all.filter(candidate => dom.visible(candidate)).flatMap(candidate => {
          const match = /^([a-z]+)\s+(\d{4})$/iu.exec(dom.text(candidate));
          const month = match ? months.indexOf(match[1].toLowerCase()) + 1 : 0;
          return match && month > 0 ? [`${match[2]}-${String(month).padStart(2, "0")}`] : [];
        });
        if (!displayedMonths.length) continue;
        if (!args.expectedMonth) return true;
        const day = args.selected;
        if (!day || !parent.contains(day) || !dom.visible(day) || dom.text(day) !== args.expectedDay || !displayedMonths.includes(args.expectedMonth)) return false;
        return day.getAttribute("aria-selected") === "true" || day.getAttribute("aria-pressed") === "true" ||
          /(?:^|\s)(?:selected|active|Mui-selected)(?:\s|$)/u.test(day.getAttribute("class") ?? "");
      }
      return false;
    }, { selected, expectedMonth: parts?.slice(0, 2).join("-") ?? null, expectedDay: parts ? String(Number(parts[2])) : null });
  } finally { await selected?.dispose(); }
}

export async function applyPublicCalendarDate(node: Locator, selection: { day: Locator; date: string }) {
  if (!await isPublicCalendarApply(node, selection)) throw new Error("UNSAFE_CALENDAR_APPLY");
  await node.click();
}
