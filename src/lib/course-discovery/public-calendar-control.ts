import type { Locator, Page } from "@playwright/test";

const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export function observedCalendarMonth(value: string): number | undefined {
  const match = /^([A-Za-z]+)\s+(\d{4})$/u.exec(value.replace(/\s+/gu, " ").trim());
  if (!match) return undefined;
  const month = monthNames.indexOf(match[1].toLowerCase());
  return month < 0 ? undefined : Number(match[2]) * 12 + month;
}

async function uniqueVisible(page: Page, selector: string, exactDay?: number) {
  let candidates = page.locator(selector);
  if (exactDay !== undefined) candidates = candidates.filter({ hasText: new RegExp(`^\\s*${exactDay}\\s*$`, "u") });
  if (await candidates.count() > 128) throw new Error("AMBIGUOUS_CALENDAR_CONTROL");
  const visible: Locator[] = [];
  for (const candidate of await candidates.all()) if (await candidate.isVisible()) visible.push(candidate);
  if (visible.length !== 1) throw new Error("AMBIGUOUS_CALENDAR_CONTROL");
  return visible[0];
}

async function assertCalendarControl(node: Locator, direction?: number) {
  const observed = await node.evaluate(element => {
    let parent: Element | null = element;
    let calendar = false;
    for (let depth = 0; parent && depth < 7; depth++, parent = parent.parentElement) {
      if (["grid", "dialog"].includes(parent.getAttribute("role") ?? "") || /calendar|date.?picker/iu.test(parent.getAttribute("class") ?? "")) calendar = true;
    }
    return { calendar, tag: element.tagName.toLowerCase(),
      label: (element.getAttribute("aria-label") || (element as HTMLElement).innerText || "").replace(/\s+/gu, " ").trim(),
      disabled: element.getAttribute("aria-disabled") === "true" || /(?:^|\s)(?:disabled|Mui-disabled)(?:\s|$)/u.test(element.className),
      sensitive: Boolean(element.closest("form")?.querySelector('input[type=password],input[type=email],input[type=tel],[autocomplete^="cc-"]')) };
  });
  if (!observed.calendar || !["button", "div", "span", "td", "th"].includes(observed.tag) || observed.disabled || observed.sensitive || !await node.isEnabled()) throw new Error("UNSAFE_CALENDAR_CONTROL");
  if (direction !== undefined && !(direction > 0 ? /^(?:next(?: month)?|>|›|»|chevron_right)$/iu : /^(?:previous(?: month)?|prev|<|‹|«|chevron_left)$/iu).test(observed.label)) throw new Error("UNSAFE_CALENDAR_CONTROL");
}

/** Move only through observed adjacent public calendar months, then select one
 * visible day. This does not supply or substitute the result's date proof. */
export async function selectPublicCalendarDate(page: Page, input: {
  date: string; monthYearSelector: string; nextSelector: string; previousSelector: string; daySelector: string;
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.date)) throw new Error("INVALID_CALENDAR_DATE");
  const checked = new Date(`${input.date}T00:00:00Z`);
  if (!Number.isFinite(checked.getTime()) || checked.toISOString().slice(0, 10) !== input.date) throw new Error("INVALID_CALENDAR_DATE");
  const [year, month, day] = input.date.split("-").map(Number), target = year * 12 + month - 1;
  const readMonth = async () => observedCalendarMonth(await (await uniqueVisible(page, input.monthYearSelector)).innerText());
  const initial = await readMonth();
  if (initial === undefined) throw new Error("CALENDAR_MONTH_UNPROVEN");
  let current: number = initial;
  if (Math.abs(target - current) > 12) throw new Error("CALENDAR_MONTH_LIMIT");
  for (let count = 0; current !== target && count < 12; count++) {
    const direction = target > current ? 1 : -1, expected = current + direction;
    const button = await uniqueVisible(page, direction > 0 ? input.nextSelector : input.previousSelector);
    await assertCalendarControl(button, direction);
    await button.click();
    const expires = Date.now() + 5_000;
    let observed = await readMonth();
    while (observed === current && Date.now() < expires) { await page.waitForTimeout(50); observed = await readMonth(); }
    if (observed !== expected) throw new Error("CALENDAR_MONTH_DID_NOT_ADVANCE");
    current = observed;
  }
  if (current !== target) throw new Error("CALENDAR_MONTH_LIMIT");
  const button = await uniqueVisible(page, input.daySelector, day);
  await assertCalendarControl(button);
  await button.click();
}
