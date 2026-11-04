import type { ElementHandle, Locator, Page } from "@playwright/test";

export type SquareRentalProof = { selector: string; durationMinutes: number; squareService: true; label: string; option: string };
export type SquareRentalSelection = Readonly<{ label: string }>;
export type SquareRentalVariantProof = Omit<SquareRentalProof, "squareService"> & { squareVariant: true };
const selections = new WeakMap<SquareRentalSelection, { page: Page; document: ElementHandle<Element>; catalogUrl: string; proof: SquareRentalProof; used: boolean }>();

/** A selector is evidence, not permission. Scope the already-proved public
 * control to its real host so unrelated header/cookie shadow buttons do not
 * turn a discovery control into an ambiguous saved recipe. */
export function squarePublicControlSelector(element: Element): string | undefined {
  const root = element.getRootNode(), host = root instanceof ShadowRoot ? root.host : element;
  const section = host.closest('section[aria-label="Main content"]'), anchor = section ?? document.getElementById("root");
  if (!anchor || !anchor.contains(host)) return;
  const base = section ? 'section[aria-label="Main content"]' : "#root";
  if (document.querySelectorAll(base).length !== 1) return;
  const parts: string[] = []; let node: Element | null = host;
  for (let depth = 0; node && node !== anchor && depth < 12; depth++, node = node.parentElement) {
    const parent = node.parentElement; if (!parent) return;
    const siblings = [...parent.children].filter(sibling => sibling.tagName === node!.tagName);
    parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
  }
  if (node !== anchor) return;
  const hostSelector = base + (parts.length ? " > " + parts.join(" > ") : "");
  if (document.querySelectorAll(hostSelector).length !== 1 || document.querySelector(hostSelector) !== host) return;
  if (root instanceof ShadowRoot && (!(element instanceof HTMLButtonElement) || root.querySelectorAll('button[type="button"]').length !== 1)) return;
  const selector = hostSelector + (root instanceof ShadowRoot ? ' button[type="button"]' : "");
  if (selector.length <= 240) return selector;
}

/** An undated, explicitly priced variant inside one public rental service. */
export function inspectSquareRentalVariantElement(element: Element): SquareRentalVariantProof | undefined {
  const url = new URL(location.href);
  if (url.origin !== "https://book.squareup.com" || url.search || url.hash ||
      !/^\/appointments\/[a-z0-9]{1,64}\/location\/[A-Z0-9]{13}\/services\/[A-Z0-9]{16,32}$/u.test(url.pathname) ||
      element.tagName !== "MARKET-ROW" || element.getAttribute("role") !== "option" ||
      element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true" ||
      element.hasAttribute("href") || element.hasAttribute("onclick") || element.closest("form")) return;
  const check = { text(node: Element) { return ((node as HTMLElement).innerText ?? "").replace(/\s+/gu, " ").trim(); },
    visible(node: Element) {
      const r = node.getBoundingClientRect(); if (!r.width || !r.height) return false;
      let parent: Element | null = node;
      for (let depth = 0; parent && depth < 40; depth++, parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (parent.matches('[hidden],[inert],[aria-hidden="true"]') || style.display === "none" ||
            ["hidden", "collapse"].includes(style.visibility) || Number(style.opacity) === 0) return false;
      }
      return parent === null;
    } };
  const section = element.closest('section[aria-label="Main content"]'), list = element.closest('market-list[role="listbox"]');
  if (!section || !list || !check.visible(element) || document.querySelectorAll('section[aria-label="Main content"]').length !== 1 ||
      section.querySelectorAll("*").length > 1500 || section.querySelector('form,input,select,textarea,[contenteditable],[role="grid"],[role="gridcell"],time,[data-slot-id],[data-start-time]') ||
      section.querySelectorAll('market-list[role="listbox"]').length !== 1 ||
      check.text(document.getElementById(list.getAttribute("aria-labelledby") ?? "") ?? list) !== "Options") return;
  const headings = [...section.querySelectorAll("h2")].filter(check.visible), rows = [...list.querySelectorAll('market-row[role="option"]')];
  if (headings.length !== 1 || rows.length < 1 || rows.length > 40 || !rows.includes(element)) return;
  const label = check.text(headings[0]);
  if (label.length > 160 || !/\b(?:golf\s+simulator|simulator\s+(?:rental|bay|time|room)|golf\s+(?:rental|bay)|(?:bay|room)\s+rental)\b/iu.test(label) ||
      /\b(?:lesson|coaching|fitting|league|event|member|package|pass|sponsorship|drive)\b/iu.test(label)) return;
  const labels = element.querySelectorAll('label[slot="label"]'), prices = element.querySelectorAll('[slot="subtext"]');
  if (labels.length !== 1 || prices.length !== 1 || !check.visible(labels[0]) || !check.visible(prices[0])) return;
  const option = check.text(labels[0]), published = check.text(prices[0]);
  if (!/^(?:Regular|Standard|\d{1,2}\s*(?:hours?|hrs?)(?:\s+\d{1,2}\s*(?:minutes?|mins?))?|\d{1,3}\s*(?:minutes?|mins?))$/iu.test(option) ||
      rows.filter(row => row.querySelector('label[slot="label"]')?.textContent?.trim() === option).length !== 1) return;
  const duration = /^\$\d{1,5}(?:\.\d{2})?\s*[・·]\s*(?:(\d{1,2})\s*hr(?:\s+(\d{1,2})\s*min)?|(\d{1,3})\s*min)$/u.exec(published);
  if (!duration || duration[2] && Number(duration[2]) >= 60) return;
  const minutes = Number(duration[1] ?? 0) * 60 + Number(duration[2] ?? duration[3] ?? 0);
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 480) return;
  return { selector: 'section[aria-label="Main content"]', durationMinutes: minutes, squareVariant: true, label, option };
}

export async function selectSquareRentalVariant(node: Locator, expected: SquareRentalVariantProof): Promise<undefined> {
  if (await node.count() !== 1 || !await node.isEnabled() ||
      JSON.stringify(await node.evaluate(inspectSquareRentalVariantElement)) !== JSON.stringify(expected)) throw new Error("UNSAFE_SQUARE_RENTAL_VARIANT");
  const page = node.page(), url = page.url(), origin = await page.evaluate(() => performance.timeOrigin);
  const add = page.locator('section[aria-label="Main content"] market-button').filter({ hasText: /^Add$/u }).locator('button[type="button"]');
  const readback = async () => {
    if (page.url() !== url || await page.evaluate(() => performance.timeOrigin) !== origin || await add.count() !== 1) return false;
    const value = await add.evaluate(inspectSquareRentalAddElement);
    return value?.label === expected.label && value.option === expected.option && value.durationMinutes === expected.durationMinutes;
  };
  if (await readback()) return undefined;
  await node.click();
  const until = Date.now() + 2000;
  while (Date.now() < until) { if (await readback()) return undefined; await page.waitForTimeout(50); }
  throw new Error("SQUARE_RENTAL_VARIANT_READBACK_FAILED");
}

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
  if (lists.length !== 1 || check.text(document.getElementById(lists[0].getAttribute("aria-labelledby") ?? "") ?? lists[0]) !== "Options") return;
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

/** Square renders one selected rental's identity in a sibling summary and its
 * times in day-part groups. Only the private, consumed Add/Next selection can
 * bind this exact layout; a recipe cannot declare a page wrapper a resource. */
export async function inspectSquareAvailabilityScope(card: Locator, selection: SquareRentalSelection | undefined,
  labelSelector: string, rowsSelector: string, durationMinutes: number | undefined): Promise<boolean> {
  const saved = selection && selections.get(selection);
  if (!saved?.used || saved.page !== card.page() || saved.proof.durationMinutes !== durationMinutes ||
      saved.page.url() !== saved.catalogUrl.replace(/\/services$/u, "/availability") || await card.count() !== 1) return false;
  return card.evaluate((node, args) => {
    if (document.documentElement !== args.document || !node.matches('div[data-testid="availability-page"]') ||
        document.querySelectorAll('[data-testid="availability-page"]').length !== 1 || node.querySelectorAll("*").length > 2000) return false;
    const check = { text(n: Element) { return ((n as HTMLElement).innerText ?? "").replace(/\s+/gu, " ").trim(); }, visible(n: Element) {
      const rect = n.getBoundingClientRect(); if (!rect.width || !rect.height) return false;
      let parent: Element | null = n;
      for (let i = 0; parent && i < 40; i++, parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (parent.matches('[hidden],[inert],[aria-hidden="true"]') || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      }
      return parent === null;
    } };
    if (!check.visible(node) || [...node.querySelectorAll('form,input,select,textarea,[contenteditable],[aria-busy="true"],[data-slot-id],[data-start-time]')].some(check.visible)) return false;
    const carts = [...node.querySelectorAll('[data-testid="desktop-cart"],[data-testid="mobile-cart"]')].filter(check.visible);
    if (carts.length !== 1) return false;
    const services = [...carts[0].querySelectorAll('[data-testid="service-staff-row"]')].filter(check.visible);
    if (services.length !== 1) return false;
    const identity = [...services[0].querySelectorAll("span")].filter(n => !n.children.length && check.visible(n) && check.text(n));
    const labels = node.querySelectorAll(args.label);
    if (identity.length !== 2 || check.text(identity[0]) !== args.proof.label || check.text(identity[1]) !== args.proof.option ||
        labels.length !== 1 || labels[0] !== identity[0]) return false;
    const sections = [...node.querySelectorAll('section[aria-label="Main content"]')].filter(check.visible);
    const segments = sections.length === 1 ? sections[0].querySelectorAll('[data-testid="availability-segments"]') : [];
    if (segments.length !== 1 || !check.visible(segments[0])) return false;
    const all = [...segments[0].querySelectorAll('[data-testid="time-slot"]')].filter(check.visible), chosen = [...node.querySelectorAll(args.rows)].filter(check.visible);
    if (all.length > 500 || all.length !== chosen.length || all.some((slot, index) => slot !== chosen[index] ||
        !slot.matches('market-button[type="button"][role="listitem"]') || slot.hasAttribute("disabled") ||
        slot.getAttribute("aria-disabled") === "true" || slot.hasAttribute("href") || slot.hasAttribute("onclick") ||
        !/^(?:[1-9]|1[0-2]):[0-5]\d\s*[AP]M$/u.test(check.text(slot)))) return false;
    const groups = [...segments[0].querySelectorAll('[role="list"]')].filter(check.visible);
    return groups.length > 0 && groups.length <= 3 && new Set(groups.map(group => group.getAttribute("aria-label"))).size === groups.length &&
      groups.every(group => /^Available time slots, (?:Morning|Afternoon|Evening), select a time to proceed$/u.test(group.getAttribute("aria-label") ?? "")) &&
      all.every(slot => groups.includes(slot.parentElement!));
  }, { document: saved.document, proof: saved.proof, label: labelSelector, rows: rowsSelector }).catch(() => false);
}
