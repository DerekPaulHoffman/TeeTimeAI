import type { Locator, Page } from "@playwright/test";

export type PublicDurationButtonProof = { purpose: "DURATION"; label: string; text: string; minutes: number };

// These callbacks are serialized into the page. Object methods keep their
// helpers self-contained under the production tsx keepNames compiler.
function durationButtonNodes(nodes: Element[]) {
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
  };
  const result: Array<PublicDurationButtonProof & { index: number }> = [];
  for (let index = 0; index < Math.min(nodes.length, 500); index++) {
    const node = nodes[index];
    if (!check.safe(node)) continue;
    const text = ((node as HTMLElement).innerText ?? "").replace(/\s+/gu, " ").trim();
    if (text.length > 100) continue;
    const children = [...node.children].filter(child => check.visible(child))
      .map(child => ((child as HTMLElement).innerText ?? "").replace(/\s+/gu, " ").trim()).filter(Boolean);
    const labels = children.filter(value => /^(?:duration|length)$/iu.test(value));
    const values = children.filter(value => check.minutes(value) !== undefined);
    if (labels.length !== 1 || values.length !== 1 || children.length !== 2 ||
        text !== `${values[0]} ${labels[0]}` && text !== `${labels[0]} ${values[0]}`) continue;
    result.push({ index, purpose: "DURATION", label: labels[0], text, minutes: check.minutes(values[0])! });
  }
  return result;
}

function durationMenuNodes(nodes: Element[]) {
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
  };
  const found: Array<{ anchor: number; depth: number; label: string; options: Array<{ index: number; minutes: number; text: string }> }> = [];
  const seen = new Set<Element>();
  if (nodes.length > 500) return found;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (!(node instanceof HTMLButtonElement) || !check.safe(node) || !check.visible(node) ||
        check.minutes((node.innerText ?? "").trim()) === undefined) continue;
    let group = node.parentElement;
    for (let depth = 1; group && depth <= 4; depth++, group = group.parentElement) {
      if (["BODY", "HTML", "FORM"].includes(group.tagName) || !check.safe(group) ||
          group.querySelector('input,select,textarea,form,a[href],[contenteditable],[role="textbox"]')) break;
      const descendants = [...group.querySelectorAll("*")];
      if (descendants.length > 120 || (group.innerText ?? "").length > 1000) break;
      const headings = descendants.filter(child => !child.children.length && check.visible(child) &&
        /^(?:select\s+(?:desired\s+)?)?(?:duration|length)$/iu.test((child.textContent ?? "").trim()));
      if (headings.length !== 1) continue;
      const buttons = [...group.querySelectorAll("button")].filter(child => check.visible(child));
      let remaining = (group.innerText ?? "").replace(/\s+/gu, " ").trim()
        .replace((headings[0].textContent ?? "").replace(/\s+/gu, " ").trim(), "");
      for (const button of buttons) remaining = remaining.replace((button.innerText ?? "").replace(/\s+/gu, " ").trim(), "");
      if (remaining.trim()) break;
      const options: Array<{ index: number; minutes: number; text: string }> = [];
      let invalid = false, dismissals = 0;
      for (const button of buttons) {
        const text = (button.innerText ?? "").replace(/\s+/gu, " ").trim();
        if (!check.safe(button) || button.form || button.disabled || button.getAttribute("aria-disabled") === "true" ||
            button.querySelector('a[href],input,select,textarea,button,[contenteditable]')) { invalid = true; break; }
        const minutes = check.minutes(text);
        if (minutes === undefined) {
          if (/^(?:close|[x×✕])$/iu.test(text || button.getAttribute("aria-label") || "") && ++dismissals <= 1) continue;
          invalid = true; break;
        }
        const optionIndex = nodes.indexOf(button);
        if (optionIndex < 0) { invalid = true; break; }
        options.push({ index: optionIndex, minutes, text });
      }
      if (!invalid && options.length >= 2 && options.length <= 16 && new Set(options.map(option => option.minutes)).size === options.length && !seen.has(group)) {
        seen.add(group); found.push({ anchor: index, depth, label: /length/iu.test(headings[0].textContent ?? "") ? "LENGTH" : "DURATION", options });
      }
      break;
    }
  }
  return found;
}

export async function inspectPublicDurationButton(node: Locator): Promise<PublicDurationButtonProof | undefined> {
  if (await node.count() !== 1) return undefined;
  const result = await node.evaluateAll(durationButtonNodes);
  return result.length === 1 ? result[0] : undefined;
}
export async function observedPublicDurationButtons(page: Page) {
  const buttons = page.locator("button");
  return (await buttons.evaluateAll(durationButtonNodes)).map(({ index, ...proof }) => ({ locator: buttons.nth(index), proof }));
}
async function menus(page: Page) {
  const buttons = page.locator("button");
  return (await buttons.evaluateAll(durationMenuNodes)).map(proof => ({ ...proof, buttons,
    group: buttons.nth(proof.anchor).locator(Array.from({ length: proof.depth }, () => "..").join("/")) }));
}

/** One displayed duration filter, never a slot, product, reservation or form. */
export async function selectPublicDurationButton(node: Locator, value: string) {
  if (!/^[1-9]\d{0,2}$/u.test(value) || Number(value) < 15 || Number(value) > 480) throw new Error("UNSAFE_CONTROL_VALUE");
  const initial = await inspectPublicDurationButton(node);
  if (!initial || !await node.isEnabled()) throw new Error("UNSAFE_CONTROL");
  const page = node.page(), original = await node.elementHandle();
  if (!original || (await menus(page)).length) throw new Error("UNOWNED_DURATION_MENU");
  const controlled = await node.getAttribute("aria-controls");
  await node.click();
  let opened = await menus(page);
  const until = Date.now() + 2000;
  while (!opened.length && Date.now() < until) { await page.waitForTimeout(50); opened = await menus(page); }
  if (opened.length !== 1 || opened[0].label !== initial.label.toUpperCase()) throw new Error("AMBIGUOUS_DURATION_MENU");
  const current = await inspectPublicDurationButton(node);
  if (!current || current.label !== initial.label || !await node.evaluate((element, previous) => element === previous, original)) throw new Error("STALE_DURATION_CONTROL");
  const menu = opened[0], group = await menu.group.elementHandle();
  if (!group || controlled && !await group.evaluate((element, id) => {
    const controller = document.getElementById(id); return Boolean(controller && (controller === element || controller.contains(element)));
  }, controlled)) throw new Error("UNOWNED_DURATION_MENU");
  const matching = menu.options.filter(option => option.minutes === Number(value));
  if (matching.length !== 1) throw new Error("AMBIGUOUS_DURATION_MENU");
  const choice = menu.buttons.nth(matching[0].index), choiceHandle = await choice.elementHandle();
  if (!choiceHandle || !await group.evaluate((element, option) => element.contains(option), choiceHandle)) throw new Error("STALE_DURATION_CONTROL");
  const fresh = await menus(page);
  if (fresh.length !== 1 || JSON.stringify(fresh[0].options) !== JSON.stringify(menu.options) ||
      !await fresh[0].group.evaluate((element, previous) => element === previous, group)) throw new Error("STALE_DURATION_CONTROL");
  await choiceHandle.click();
  let selected = await inspectPublicDurationButton(node);
  const closedBy = Date.now() + 2000;
  while (Date.now() < closedBy && (selected?.minutes !== Number(value) || await group.isVisible())) {
    await page.waitForTimeout(50); selected = await inspectPublicDurationButton(node);
  }
  if (!selected || selected.label !== initial.label || selected.minutes !== Number(value) || await group.isVisible() ||
      !await node.evaluate((element, previous) => element === previous, original)) throw new Error("DURATION_SELECTION_UNCONFIRMED");
}
