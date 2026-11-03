import type { Page } from "@playwright/test";

type Cue = { kind: "HEADING"; name: string } | { kind: "ADDRESS"; house: string; street: string; postal: string };

/** A private read may reveal one offscreen identity field by scrolling.
 * CSS, forms and source data are never changed; fresh rendered proof is still
 * collected by the caller after this action. No selector comes from a model. */
async function revealNativeVenueField(page: Page, cue: Cue, deadlineAt: Date) {
  if (!Number.isFinite(deadlineAt.getTime()) || deadlineAt.getTime() - Date.now() < 500) return false;
  const headings = page.locator(cue.kind === "HEADING" ? "h1,h2,h3,h4,h5,h6" : "h1,h2,h3,h4,h5,h6,p,address");
  const indexes = await headings.evaluateAll((nodes, cue) => {
    const labels = { name(value: string) { return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
      .replace(/^welcome to\s+/u, "").replace(/\bgolf (?:club|course)$/u, "golf course"); },
      matches(value: string) {
        if (cue.kind === "HEADING") return labels.name(value) === labels.name(cue.name);
        // This coarse cue only chooses where to scroll. It cannot attest an
        // address: the caller still requires complete exact raw/rendered proof.
        if (value.length < 15 || value.length > 500) return false;
        const words = labels.name(value).split(/\s+/u), { house, street, postal } = cue;
        return words.some((word, index) => word === house && words[index + 1] === street) &&
          [...value.matchAll(/\b(\d{5})(?:-\d{4})?\b/gu)].some(match => match[1] === postal);
      } };
    if (nodes.length > 160) return [];
    return nodes.flatMap((node, index) => {
      if (!(node instanceof HTMLElement) || !labels.matches(node.innerText) ||
          node.closest("form,input,textarea,select,button,label,[contenteditable],[hidden],[inert],[aria-hidden='true']") ||
          node.querySelector("input,textarea,select,button,label,[contenteditable]")) return [];
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom > 0 && rect.top < document.documentElement.clientHeight) return [];
      let parent: HTMLElement | null = node, count = 0;
      while (parent && count++ < 32) {
        const style = getComputedStyle(parent);
        if (style.display === "none" || ["hidden", "collapse"].includes(style.visibility) ||
            /\b(?:account|profile|checkout|payment|billing|login|sign-in|members-only)\b/iu.test(
              ["id", "class", "aria-label", "title"].map(key => parent!.getAttribute(key) ?? "").join(" "))) return [];
        parent = parent.parentElement;
      }
      return parent ? [] : [index];
    });
  }, cue);
  if (indexes.length !== 1) return false;
  const url = page.url(), timeOrigin = await page.evaluate(() => performance.timeOrigin), heading = headings.nth(indexes[0]);
  const end = Math.min(deadlineAt.getTime(), Date.now() + 2500);
  await heading.scrollIntoViewIfNeeded({ timeout: Math.max(1, end - Date.now()) });
  while (Date.now() < end) {
    if (page.url() !== url || await page.evaluate(() => performance.timeOrigin) !== timeOrigin) return false;
    const visible = await heading.evaluate(node => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      let parent: HTMLElement | null = node, count = 0;
      while (parent && count++ < 32) {
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return false;
        parent = parent.parentElement;
      }
      return !parent && rect.width > 0 && rect.height > 0;
    });
    if (visible) return true;
    await page.waitForTimeout(Math.min(100, Math.max(1, end - Date.now())));
  }
  return false;
}

export async function revealNativeVenueHeading(page: Page, venueName: string, deadlineAt: Date) {
  if (!venueName || venueName.length > 200) return false;
  return revealNativeVenueField(page, { kind: "HEADING", name: venueName }, deadlineAt);
}

export async function revealNativeVenueAddress(page: Page, venueAddress: string, deadlineAt: Date) {
  if (!venueAddress || venueAddress.length > 1024) return false;
  const house = /^\s*(\d+[A-Z]?)\s+([\p{L}\p{N}]+)/iu.exec(venueAddress);
  const postal = [...venueAddress.matchAll(/\b(\d{5})(?:-\d{4})?\b/gu)].at(-1)?.[1];
  if (!house || !postal) return false;
  return revealNativeVenueField(page, { kind: "ADDRESS", house: house[1].toLowerCase(), street: house[2].toLowerCase(), postal }, deadlineAt);
}
