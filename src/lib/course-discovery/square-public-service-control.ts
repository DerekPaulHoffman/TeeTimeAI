import type { ElementHandle, Locator, Page } from "@playwright/test";

export type SquareRentalProof = { selector: string; durationMinutes: number; squareService: true; label: string; option: string };
export type SquareRentalSelection = Readonly<{ label: string }>;
const selections = new WeakMap<SquareRentalSelection, { page: Page; document: ElementHandle<Element>; catalogUrl: string; proof: SquareRentalProof; used: boolean }>();

/** Only an undated public Square service configuration, before availability. */
export function inspectSquareRentalAddElement(element: Element): SquareRentalProof | undefined {
  const url = new URL(document.location.href);
  if (url.origin !== "https://book.squareup.com" || url.search || url.hash ||
      !/^\/appointments\/[a-z0-9]{1,64}\/location\/[A-Z0-9]{13}\/services\/[A-Z0-9]{16,32}$/u.test(url.pathname)) return;
  const check = {
    text(node: Element) { return ((node as HTMLElement).innerText ?? node.textContent ?? "").replace(/\s+/gu, " ").trim(); },
    visible(node: Element) {
    const r = node.getBoundingClientRect(); let current: Element | null = node;
    for (let i = 0; current && i < 40; i++) {
      const s = getComputedStyle(current);
      if (current.matches('[hidden],[inert],[aria-hidden="true"]') || s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
      const root = current.getRootNode(); current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    }
    return !current && r.width > 0 && r.height > 0;
    },
  };
  const root = element.getRootNode();
  const host = root instanceof ShadowRoot ? root.host : element;
  if (host.tagName !== "MARKET-BUTTON" || !check.visible(host) || check.text(host) !== "Add" || host.getAttribute("type") !== "button" ||
      host.hasAttribute("disabled") || host.getAttribute("aria-disabled") === "true" || host.hasAttribute("onclick") || host.closest("form,a[href]")) return;
  const section = host.closest('section[aria-label="Main content"]');
  if (!section || document.querySelectorAll('section[aria-label="Main content"]').length !== 1 || section.querySelectorAll("*").length > 1500 ||
      section.querySelector('form,input,select,textarea,[role="grid"],[role="gridcell"],time,[data-slot-id],[data-start-time]')) return;
  const headings = Array.from(section.querySelectorAll("h2")).filter(check.visible);
  if (headings.length !== 1) return;
  const label = check.text(headings[0]);
  if (label.length > 160 || !/\b(?:golf\s+simulator|simulator\s+(?:rental|bay|time|room)|golf\s+(?:rental|bay)|(?:bay|room)\s+rental)\b/iu.test(label) ||
      /\b(?:lesson|coaching|fitting|league|event|member|package|pass|sponsorship|drive)\b/iu.test(label)) return;
  const lists = Array.from(section.querySelectorAll('market-list[role="listbox"]')).filter(check.visible);
  if (lists.length !== 1 || document.getElementById(lists[0].getAttribute("aria-labelledby") ?? "")?.textContent?.trim() !== "Options") return;
  const selected = Array.from(lists[0].querySelectorAll('market-row[role="option"][aria-selected="true"]')).filter(check.visible);
  if (selected.length !== 1 || !selected[0].hasAttribute("selected")) return;
  const options = selected[0].querySelectorAll('label[slot="label"]'), prices = selected[0].querySelectorAll('[slot="subtext"]');
  if (options.length !== 1 || prices.length !== 1) return;
  const option = check.text(options[0]), published = check.text(prices[0]);
  if (!/^(?:Regular|Standard|\d{1,2}\s*(?:hours?|hrs?)(?:\s+\d{1,2}\s*(?:minutes?|mins?))?|\d{1,3}\s*(?:minutes?|mins?))$/iu.test(option)) return;
  const duration = /^\$\d{1,5}(?:\.\d{2})?\s*[・·]\s*(?:(\d{1,2})\s*hr(?:\s+(\d{1,2})\s*min)?|(\d{1,3})\s*min)$/u.exec(published);
  if (!duration || duration[2] && Number(duration[2]) >= 60) return;
  const minutes = Number(duration[1] ?? 0) * 60 + Number(duration[2] ?? duration[3] ?? 0);
  if (minutes < 15 || minutes > 480 || !Number.isInteger(minutes)) return;
  const actions = Array.from(section.querySelectorAll("market-button")).filter(check.visible);
  if (actions.length !== 1 || actions[0] !== host) return;
  return { selector: 'section[aria-label="Main content"]', durationMinutes: minutes, squareService: true, label, option };
}

export async function selectSquareRental(node: Locator, expected: SquareRentalProof): Promise<SquareRentalSelection> {
  if (await node.count() !== 1 || JSON.stringify(await node.evaluate(inspectSquareRentalAddElement)) !== JSON.stringify(expected))
    throw new Error("UNSAFE_SQUARE_RENTAL_SELECTION");
  const page = node.page(), document = (await page.locator("html").elementHandle())!;
  const catalogUrl = page.url().replace(/\/services\/[A-Z0-9]{16,32}$/u, "/services");
  try {
    await node.click();
    const selection = Object.freeze({ label: expected.label });
    selections.set(selection, { page, document, catalogUrl, proof: expected, used: false });
    return selection;
  } catch (error) { await document.dispose(); throw error; }
}

export async function inspectSquareRentalNext(node: Locator, selection: SquareRentalSelection | undefined) {
  const saved = selection && selections.get(selection);
  if (!saved || saved.used || saved.page !== node.page() || saved.page.url() !== saved.catalogUrl || await node.count() !== 1) return false;
  return node.evaluate((element, args) => {
    if (document.documentElement !== args.document) return false;
    const check = {
      text(node: Element) { return ((node as HTMLElement).innerText ?? node.textContent ?? "").replace(/\s+/gu, " ").trim(); },
      visible(node: Element) {
      const r = node.getBoundingClientRect(); let current: Element | null = node;
      for (let i = 0; current && i < 40; i++) {
        const s = getComputedStyle(current);
        if (current.matches('[hidden],[inert],[aria-hidden="true"]') || s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
        const root = current.getRootNode(); current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
      }
      return !current && r.width > 0 && r.height > 0;
      },
    };
    const root = element.getRootNode(), host = root instanceof ShadowRoot ? root.host : element;
    if (host.tagName !== "MARKET-BUTTON" || check.text(host) !== "Next" || host.getAttribute("type") !== "button" || !check.visible(host) ||
        host.hasAttribute("disabled") || host.getAttribute("aria-disabled") === "true" || host.hasAttribute("onclick") || host.closest("form,a[href]")) return false;
    if (Array.from(document.querySelectorAll('form,input,select,textarea,[role="grid"],[role="gridcell"],time,[data-slot-id],[data-start-time],[data-testid="availability-segments"]')).some(check.visible)) return false;
    const carts = Array.from(document.querySelectorAll('[data-testid="desktop-cart"],[data-testid="mobile-cart"]')).filter(check.visible);
    if (carts.length !== 1 || !carts[0].parentElement?.contains(host)) return false;
    const rows = Array.from(carts[0].querySelectorAll('[data-testid="service-staff-row"]')).filter(check.visible);
    if (rows.length !== 1) return false;
    const leaves = Array.from(rows[0].querySelectorAll("span")).filter(n => !n.children.length && check.visible(n)).map(check.text).filter(Boolean);
    if (leaves.length !== 2 || leaves[0] !== args.proof.label || leaves[1] !== args.proof.option) return false;
    const actions = Array.from(carts[0].parentElement!.querySelectorAll("market-button")).filter(check.visible);
    return actions.length === 1 && actions[0] === host;
  }, { document: saved.document, proof: saved.proof }).catch(() => false);
}

export async function continueSquareRental(node: Locator, selection: SquareRentalSelection | undefined) {
  if (!await inspectSquareRentalNext(node, selection)) throw new Error("UNSAFE_SQUARE_SERVICE_CONTINUATION");
  const saved = selections.get(selection!)!;
  saved.used = true;
  await node.click();
}
