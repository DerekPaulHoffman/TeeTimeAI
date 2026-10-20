import type { Locator, Page } from "@playwright/test";

export type PublicDropdownProof = { purpose: "DURATION" | "PLAYERS"; label: string; text: string };
function inspectDropdownNodes(value: Element | Element[]) {
  const nodes = Array.isArray(value) ? value.slice(0, 300) : [value];
  const found: Array<PublicDropdownProof & { index: number }> = [];
  const check = {
    visible(node: Element) { const rect = node.getBoundingClientRect(), style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"; },
  };
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index], text = ((node as HTMLElement).innerText ?? "").replace(/\s+/gu, " ").trim();
    if (!["DIV", "SPAN"].includes(node.tagName) || node.getAttribute("tabindex") !== "0" || !check.visible(node) || text.length > 50 ||
        node.getAttribute("aria-disabled") === "true" || node.closest('a[href],button,[hidden],[aria-hidden="true"]') ||
        node.closest("form")?.querySelector('input[type=password],input[type=email],input[type=tel],[autocomplete^="cc-"]') ||
        /\b(?:book|reserve|checkout|pay|purchase|login|contact|confirm)\b|\d{1,2}:\d{2}/iu.test(text)) continue;
    if (node.getAttribute("aria-haspopup") !== "listbox" && !node.querySelector('[aria-label="Chevron Down"],[aria-label="chevron_down"],[data-testid="chevron-icon"]')) continue;
    let parent = node.parentElement;
    for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
      if (parent.tagName === "FORM" || ((parent as HTMLElement).innerText ?? "").length > 250) break;
      const labels = [...parent.children].filter(child => !child.contains(node) && check.visible(child))
        .map(child => ((child as HTMLElement).innerText ?? "").replace(/\s+/gu, " ").trim())
        .filter(label => /^(?:Duration|Length|Players?|Party size|Group size|Guests?|Bays?)$/iu.test(label));
      const inputs = [...parent.querySelectorAll('[tabindex="0"],select,[role="combobox"]')].filter(child => check.visible(child));
      if (labels.length !== 1 || inputs.length !== 1 || inputs[0] !== node) continue;
      found.push({ index, purpose: /duration|length/iu.test(labels[0]) ? "DURATION" : "PLAYERS", label: labels[0], text }); break;
    }
  }
  return found;
}

export async function inspectPublicDropdown(node: Locator): Promise<PublicDropdownProof | undefined> {
  const proof = await node.evaluate(inspectDropdownNodes);
  return proof.length === 1 ? proof[0] : undefined;
}
export async function observedPublicDropdowns(page: Page) {
  const nodes = page.locator('[tabindex="0"]');
  return (await nodes.evaluateAll(inspectDropdownNodes)).map(proof => ({ locator: nodes.nth(proof.index), proof }));
}

function optionValue(text: string, purpose: PublicDropdownProof["purpose"]) {
  if (purpose === "DURATION") {
    const duration = /^(?:(\d{1,2})\s*(?:hours?|hrs?)\s*)?(?:(\d{1,3})\s*(?:minutes?|mins?))?$/iu.exec(text);
    if (!duration || !duration[1] && !duration[2] || duration[1] && Number(duration[2] ?? 0) >= 60) return undefined;
    const minutes = Number(duration[1] ?? 0) * 60 + Number(duration[2] ?? 0);
    return minutes >= 15 && minutes <= 480 ? minutes : undefined;
  }
  const match = /^(\d{1,2})(?:\s+(?:players?|people|guests?|bays?))?$/iu.exec(text);
  return match && Number(match[1]) >= 1 && Number(match[1]) <= 20 ? Number(match[1]) : undefined;
}
async function visibleOptions(node: Locator, purpose: PublicDropdownProof["purpose"], controlledId: string | null) {
  const candidates = node.page().locator('[role="option"],[data-testid^="dropdown-select-"]');
  if (await candidates.count() > 80) throw new Error("AMBIGUOUS_CONTROL");
  const options: Array<{ locator: Locator; value: number; label: string }> = [];
  for (const candidate of await candidates.all()) {
    if (!await candidate.isVisible() || !await candidate.isEnabled()) continue;
    const label = (await candidate.innerText()).replace(/\s+/gu, " ").trim();
    if (/^(?:Any|All)$/iu.test(label)) continue;
    const value = optionValue(label, purpose);
    const unsafe = await candidate.evaluate(element => Boolean(element.closest("a[href]")) || Boolean(element.querySelector('a[href],input,button[type="submit"]')) || element.getAttribute("aria-disabled") === "true" ||
      Boolean(element.closest("form")?.querySelector('input[type=password],input[type=email],input[type=tel],[autocomplete^="cc-"]')));
    if (!value || unsafe || label.length > 60) throw new Error("UNSAFE_CONTROL_VALUE");
    options.push({ locator: candidate, value, label });
  }
  if (!options.length || options.length > 40 || new Set(options.map(option => option.value)).size !== options.length) throw new Error("AMBIGUOUS_CONTROL");
  const groups = await Promise.all(options.map(option => option.locator.evaluate((element, controlledId) => {
    const controlled = controlledId ? document.getElementById(controlledId) : null;
    if (controlledId && (!controlled || !controlled.contains(element))) return null;
    let parent = element.parentElement;
    for (let depth = 0; parent && depth < 3; depth++, parent = parent.parentElement) {
      if (["BODY", "HTML", "FORM"].includes(parent.tagName) ||
          /\b(?:book|reserve|checkout|pay|purchase|login|contact|confirm)\b|\d{1,2}:\d{2}/iu.test(`${parent.getAttribute("aria-label") ?? ""} ${parent.getAttribute("title") ?? ""}`) ||
          parent.querySelector('a[href],input,button[type="submit"]')) return null;
      if (parent.querySelectorAll(':scope > [role="option"],:scope > [data-testid^="dropdown-select-"]').length > 1) {
        if (((parent as HTMLElement).innerText ?? "").length > 2000) return null;
        let context: Element | null = parent;
        for (let depth = 0; context && depth < 8; depth++, context = context.parentElement) {
          if (context.tagName === "FORM" || /\b(?:book|reserve|checkout|pay|purchase|login|contact|confirm)\b/iu.test(
            `${context.getAttribute("aria-label") ?? ""} ${context.getAttribute("title") ?? ""}`)) return null;
        }
        return [...document.querySelectorAll("body *")].indexOf(parent);
      }
    }
    return null;
  }, controlledId)));
  // Separate detached menus must never be merged into one choice list.
  if (groups.some(group => group === null || group < 0) || new Set(groups).size !== 1) throw new Error("AMBIGUOUS_CONTROL");
  return options;
}

/** A focusable, visibly labelled public dropdown; options must be individually
 * observed and safe, and selection must be reflected by the original control. */
export async function selectPublicDropdown(node: Locator, input: { value: string; purpose: string; simulator: boolean }) {
  const proof = await inspectPublicDropdown(node);
  if (!proof || proof.purpose !== input.purpose || !/^[1-9]\d{0,2}$/u.test(input.value) ||
      Number(input.value) > (proof.purpose === "DURATION" ? 480 : 20) || input.simulator && proof.purpose === "PLAYERS" && input.value !== "1") throw new Error("UNSAFE_CONTROL");
  const candidates = node.page().locator('[role="option"],[data-testid^="dropdown-select-"]');
  // An already open menu has no demonstrated relationship to this trigger.
  // Do not click it even if its value happens to match the field's current text.
  if (await candidates.filter({ visible: true }).count()) throw new Error("UNOWNED_FILTER_OPTIONS");
  await node.click();
  await candidates.filter({ visible: true }).first().waitFor({ state: "visible" });
  const controlledId = await node.getAttribute("aria-controls");
  const matches = (await visibleOptions(node, proof.purpose, controlledId)).filter(option => option.value === Number(input.value));
  if (matches.length !== 1) throw new Error("AMBIGUOUS_CONTROL");
  await matches[0].locator.click();
  const expires = Date.now() + 2000;
  do {
    const selected = await inspectPublicDropdown(node);
    if (selected?.purpose === proof.purpose && optionValue(selected.text, proof.purpose) === Number(input.value)) return;
    await node.page().waitForTimeout(50);
  } while (Date.now() < expires);
  throw new Error("FILTER_SELECTION_UNCONFIRMED");
}
