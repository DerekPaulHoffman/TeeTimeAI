import type { Locator, Page } from "@playwright/test";

export type PublicDurationButtonProof = { purpose: "DURATION"; label: string; text: string; minutes: number };
export type PublicPlayersButtonProof = { purpose: "PLAYERS"; label: string; text: string; players: number };
export type PublicMenuButtonProof = PublicDurationButtonProof | PublicPlayersButtonProof;

// These callbacks are serialized into the page. Object methods keep their
// helpers self-contained under the production tsx keepNames compiler.
function durationButtonNodes(nodes: Element[], purpose: "DURATION" | "PLAYERS") {
  const check = {
    visible(node: Element) {
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      for (let parent: Element | null = node, depth = 0; parent; parent = parent.parentElement, depth++) {
        if (depth >= 32) return false;
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    },
    safe(node: Element) {
      if (!(node instanceof HTMLButtonElement) || node.form || node.disabled || node.getAttribute("aria-disabled") === "true" ||
          node.querySelector('a[href],input,select,textarea,button,[contenteditable]')) return false;
      for (let parent: Element | null = node, depth = 0; parent; parent = parent.parentElement, depth++) {
        if (depth >= 32 || ["FORM", "A"].includes(parent.tagName) || (parent as HTMLElement).isContentEditable ||
            parent.hasAttribute("contenteditable") && parent.getAttribute("contenteditable") !== "false" ||
            /\b(?:account|login|password|email|phone|contact|customer|payments?|checkout|purchase|credit|creditcard|billing|birth|birthdate|dateofbirth|dob|reserve|confirm|submit)\b/iu.test(
              `${parent.getAttribute("aria-label") ?? ""} ${parent.getAttribute("title") ?? ""} ${parent.id} ${[...parent.children].filter(child => /^(?:H[1-6]|LABEL)$/u.test(child.tagName)).map(child => child.textContent ?? "").join(" ")}`
                .replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/[_-]/gu, " "))) return false;
      }
      return this.visible(node);
    },
    minutes(value: string) {
      const match = /^(?:(\d{1,2})\s*(?:hours?|hrs?)\s*)?(?:(\d{1,3})\s*(?:minutes?|mins?))?$/iu.exec(value);
      if (!match || !match[1] && !match[2] || match[1] && Number(match[2] ?? 0) >= 60) return undefined;
      const minutes = Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
      return minutes >= 15 && minutes <= 480 ? minutes : undefined;
    },
    players(value: string) {
      return /^(?:[1-9]|1\d|20)$/u.test(value) ? Number(value) : undefined;
    },
  };
  const result: Array<PublicMenuButtonProof & { index: number }> = [];
  for (let index = 0; index < Math.min(nodes.length, 500); index++) {
    const node = nodes[index];
    if (!check.safe(node)) continue;
    const text = ((node as HTMLElement).innerText ?? "").replace(/\s+/gu, " ").trim();
    if (text.length > 100) continue;
    const children = [...node.children].filter(child => check.visible(child))
      .map(child => ((child as HTMLElement).innerText ?? "").replace(/\s+/gu, " ").trim()).filter(Boolean);
    const labels = children.filter(value => (purpose === "DURATION" ? /^(?:duration|length)$/iu : /^players$/iu).test(value));
    const values = children.filter(value => (purpose === "DURATION" ? check.minutes(value) : check.players(value)) !== undefined);
    if (labels.length !== 1 || values.length !== 1 || children.length !== 2 ||
        text !== `${values[0]} ${labels[0]}` && text !== `${labels[0]} ${values[0]}`) continue;
    result.push(purpose === "DURATION" ? { index, purpose, label: labels[0], text, minutes: check.minutes(values[0])! }
      : { index, purpose, label: labels[0], text, players: check.players(values[0])! });
  }
  return result;
}

function durationMenuNodes(nodes: Element[], purpose: "DURATION" | "PLAYERS") {
  const check = {
    visible(node: Element) {
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      for (let parent: Element | null = node, depth = 0; parent; parent = parent.parentElement, depth++) {
        if (depth >= 32) return false;
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    },
    safe(node: Element) {
      for (let parent: Element | null = node, depth = 0; parent; parent = parent.parentElement, depth++) {
        if (depth >= 32 || ["FORM", "A"].includes(parent.tagName) || (parent as HTMLElement).isContentEditable ||
            parent.hasAttribute("contenteditable") && parent.getAttribute("contenteditable") !== "false" ||
            /\b(?:account|login|password|email|phone|contact|customer|payments?|checkout|purchase|credit|creditcard|billing|birth|birthdate|dateofbirth|dob|reserve|confirm|submit)\b/iu.test(
              `${parent.getAttribute("aria-label") ?? ""} ${parent.getAttribute("title") ?? ""} ${parent.id} ${[...parent.children].filter(child => /^(?:H[1-6]|LABEL)$/u.test(child.tagName)).map(child => child.textContent ?? "").join(" ")}`
                .replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/[_-]/gu, " "))) return false;
      }
      return true;
    },
    minutes(value: string) {
      const match = /^(?:(\d{1,2})\s*(?:hours?|hrs?)\s*)?(?:(\d{1,3})\s*(?:minutes?|mins?))?$/iu.exec(value);
      if (!match || !match[1] && !match[2] || match[1] && Number(match[2] ?? 0) >= 60) return undefined;
      const minutes = Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
      return minutes >= 15 && minutes <= 480 ? minutes : undefined;
    },
    players(value: string) {
      return /^(?:[1-9]|1\d|20)$/u.test(value) ? Number(value) : undefined;
    },
    emptyAuxiliary(node: HTMLButtonElement) {
      return node.getAttribute("tabindex") === "-1" && node.children.length === 0 &&
        (node.textContent ?? "").length === 0 && (node.innerText ?? "").length === 0 &&
        (node.getAttribute("aria-label") ?? "").length === 0 && (node.getAttribute("title") ?? "").length === 0 &&
        !["value", "data-value", "name", "content", "form", "formaction", "formmethod", "formenctype", "formtarget", "role", "aria-labelledby", "aria-describedby"]
          .some(name => node.hasAttribute(name)) &&
        ![...node.attributes].some(attribute => /^on/iu.test(attribute.name) ||
          !["aria-label", "title"].includes(attribute.name) && /label|description|details|content|credential|secret|token|password|authorization|cookie|session|api.?key|email|phone|contact|customer|account|payments?|credit|billing/iu.test(attribute.name)) &&
        (!node.hasAttribute("type") || node.getAttribute("type") === "button");
    },
  };
  const found: Array<{ anchor: number; depth: number; label: string; options: Array<{ index: number; value: number; text: string }> }> = [];
  const seen = new Set<Element>();
  if (nodes.length > 500) return found;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (!(node instanceof HTMLButtonElement) || !check.safe(node) || !check.visible(node) ||
        (purpose === "DURATION" ? check.minutes((node.innerText ?? "").trim()) : check.players((node.innerText ?? "").trim())) === undefined) continue;
    let group = node.parentElement;
    for (let depth = 1; group && depth <= 4; depth++, group = group.parentElement) {
      if (["BODY", "HTML", "FORM"].includes(group.tagName) || !check.safe(group) ||
          group.querySelector('input,select,textarea,form,a[href],[contenteditable],[role="textbox"]')) break;
      const descendants = [...group.querySelectorAll("*")];
      if (descendants.length > 120 || (group.innerText ?? "").length > 1000) break;
      const headings = descendants.filter(child => !child.children.length && check.visible(child) &&
        (purpose === "DURATION" ? /^(?:select\s+(?:desired\s+)?)?(?:duration|length)$/iu : /^SELECT DESIRED PARTY SIZE$/iu)
          .test((child.textContent ?? "").trim()));
      if (headings.length !== 1) continue;
      const buttons = [...group.querySelectorAll("button")].filter(child => check.visible(child));
      let remaining = (group.innerText ?? "").replace(/\s+/gu, " ").trim()
        .replace((headings[0].textContent ?? "").replace(/\s+/gu, " ").trim(), "");
      for (const button of buttons) remaining = remaining.replace((button.innerText ?? "").replace(/\s+/gu, " ").trim(), "");
      if (remaining.trim()) break;
      const options: Array<{ index: number; value: number; text: string }> = [];
      let invalid = false, dismissals = 0, auxiliaries = 0;
      for (const button of buttons) {
        const text = (button.innerText ?? "").replace(/\s+/gu, " ").trim();
        if (!check.safe(button) || button.form || button.disabled || button.getAttribute("aria-disabled") === "true" ||
            button.querySelector('a[href],input,select,textarea,button,[contenteditable]')) { invalid = true; break; }
        if (check.emptyAuxiliary(button) && ++auxiliaries <= 5) continue;
        const value = purpose === "DURATION" ? check.minutes(text) : check.players(text);
        if (value === undefined) {
          if (/^(?:close|[x×✕])$/iu.test(text || button.getAttribute("aria-label") || "") && ++dismissals <= 1) continue;
          invalid = true; break;
        }
        if (purpose === "PLAYERS" && (button.tabIndex !== 0 || button.getAttribute("aria-label") !== text)) { invalid = true; break; }
        const optionIndex = nodes.indexOf(button);
        if (optionIndex < 0) { invalid = true; break; }
        options.push({ index: optionIndex, value, text });
      }
      if (!invalid && options.length >= 2 && options.length <= 16 && new Set(options.map(option => option.value)).size === options.length && !seen.has(group)) {
        seen.add(group); found.push({ anchor: index, depth, label: purpose === "PLAYERS" ? "PLAYERS" : /length/iu.test(headings[0].textContent ?? "") ? "LENGTH" : "DURATION", options });
      }
      break;
    }
  }
  return found;
}

export async function inspectPublicDurationButton(node: Locator): Promise<PublicDurationButtonProof | undefined> {
  const proof = await inspectPublicMenuButton(node, "DURATION");
  return proof?.purpose === "DURATION" ? proof : undefined;
}
export async function inspectPublicMenuButton(node: Locator, purpose: "DURATION" | "PLAYERS"): Promise<PublicMenuButtonProof | undefined> {
  if (await node.count() !== 1) return undefined;
  const result = await node.evaluateAll(durationButtonNodes, purpose);
  return result.length === 1 ? result[0] : undefined;
}
export async function observedPublicDurationButtons(page: Page) {
  return (await observedPublicMenuButtons(page)).filter((value): value is { locator: Locator; proof: PublicDurationButtonProof } => value.proof.purpose === "DURATION");
}
export async function observedPublicMenuButtons(page: Page) {
  const buttons = page.locator("button");
  const proofs = [...await buttons.evaluateAll(durationButtonNodes, "DURATION" as const), ...await buttons.evaluateAll(durationButtonNodes, "PLAYERS" as const)];
  return proofs.map(({ index, ...proof }) => ({ locator: buttons.nth(index), proof }));
}
async function menus(page: Page, purpose: "DURATION" | "PLAYERS") {
  const buttons = page.locator("button");
  return (await buttons.evaluateAll(durationMenuNodes, purpose)).map(proof => ({ ...proof, buttons,
    group: buttons.nth(proof.anchor).locator(Array.from({ length: proof.depth }, () => "..").join("/")) }));
}

/** One displayed duration filter, never a slot, product, reservation or form. */
export async function selectPublicDurationButton(node: Locator, value: string) {
  return selectPublicMenuButton(node, value, "DURATION");
}
export async function selectPublicMenuButton(node: Locator, value: string, purpose: "DURATION" | "PLAYERS") {
  if (!/^[1-9]\d{0,2}$/u.test(value) || Number(value) < (purpose === "DURATION" ? 15 : 1) || Number(value) > (purpose === "DURATION" ? 480 : 20)) throw new Error("UNSAFE_CONTROL_VALUE");
  const errors = purpose === "DURATION" ? { unowned: "UNOWNED_DURATION_MENU", ambiguous: "AMBIGUOUS_DURATION_MENU", stale: "STALE_DURATION_CONTROL", unconfirmed: "DURATION_SELECTION_UNCONFIRMED" }
    : { unowned: "UNSAFE_CONTROL", ambiguous: "AMBIGUOUS_CONTROL", stale: "STALE_OR_UNKNOWN_CONTROL", unconfirmed: "UNSAFE_CONTROL" };
  const initial = await inspectPublicMenuButton(node, purpose);
  if (!initial || !await node.isEnabled()) throw new Error("UNSAFE_CONTROL");
  const page = node.page(), original = await node.elementHandle();
  if (!original || (await menus(page, purpose)).length) throw new Error(errors.unowned);
  const controlled = await node.getAttribute("aria-controls");
  await node.click();
  let opened = await menus(page, purpose);
  const until = Date.now() + 2000;
  while (!opened.length && Date.now() < until) { await page.waitForTimeout(50); opened = await menus(page, purpose); }
  if (opened.length !== 1 || opened[0].label !== initial.label.toUpperCase()) throw new Error(errors.ambiguous);
  const current = await inspectPublicMenuButton(node, purpose);
  if (!current || current.label !== initial.label || !await node.evaluate((element, previous) => element === previous, original)) throw new Error(errors.stale);
  const menu = opened[0], group = await menu.group.elementHandle();
  if (!group || controlled && !await group.evaluate((element, id) => {
    const controller = document.getElementById(id); return Boolean(controller && (controller === element || controller.contains(element)));
  }, controlled)) throw new Error(errors.unowned);
  const matching = menu.options.filter(option => option.value === Number(value));
  if (matching.length !== 1) throw new Error(errors.ambiguous);
  const choice = menu.buttons.nth(matching[0].index), choiceHandle = await choice.elementHandle();
  if (!choiceHandle || !await group.evaluate((element, option) => element.contains(option), choiceHandle)) throw new Error(errors.stale);
  const fresh = await menus(page, purpose);
  if (fresh.length !== 1 || JSON.stringify(fresh[0].options) !== JSON.stringify(menu.options) ||
      !await fresh[0].group.evaluate((element, previous) => element === previous, group)) throw new Error(errors.stale);
  await choiceHandle.click();
  let selected = await inspectPublicMenuButton(node, purpose);
  const closedBy = Date.now() + 2000;
  while (Date.now() < closedBy && ((selected?.purpose === "DURATION" ? selected.minutes : selected?.players) !== Number(value) || await group.isVisible())) {
    await page.waitForTimeout(50); selected = await inspectPublicMenuButton(node, purpose);
  }
  if (!selected || selected.label !== initial.label || (selected.purpose === "DURATION" ? selected.minutes : selected.players) !== Number(value) || await group.isVisible() ||
      !await node.evaluate((element, previous) => element === previous, original)) throw new Error(errors.unconfirmed);
}
