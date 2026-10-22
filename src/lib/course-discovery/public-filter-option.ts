import type { Locator } from "@playwright/test";
import { publicRentalDurationMinutes } from "./recipe";

function optionProof(element: Element) {
  const check = {
    visible(node: Element) {
      const box = node.getBoundingClientRect(), style = getComputedStyle(node);
      return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden" &&
        !node.closest('[hidden],[inert],[aria-hidden="true"]');
    },
    unsafe(node: Element) {
      for (let parent: Element | null = node, depth = 0; parent; parent = parent.parentElement, depth++) {
        if (parent.hasAttribute("contenteditable") && parent.getAttribute("contenteditable")?.toLowerCase() !== "false") return true;
        if (depth < 8 && parent.tagName !== "BODY" && /password|secret|credential|email|phone|contact|account|member|profile|birth|bday|dob|checkout|payment|purchase|confirm|reserve/iu.test(
          `${parent.getAttribute("aria-label") ?? ""} ${parent.getAttribute("name") ?? ""} ${parent.getAttribute("title") ?? ""}`)) return true;
      }
      if (node instanceof HTMLElement && node.isContentEditable || [...node.querySelectorAll("[contenteditable]")]
        .some(child => child.getAttribute("contenteditable")?.toLowerCase() !== "false")) return true;
      return Boolean(node.closest('form,a[href],[contenteditable="true"]') || node.hasAttribute("form") || node.hasAttribute("href") ||
        node.querySelector('input,textarea,select,a[href],button[type="submit"],[contenteditable="true"]')) ||
        node.getAttribute("aria-disabled") === "true" || node.hasAttribute("disabled") || node.classList.contains("disabled");
    },
  };
  if (!(element instanceof HTMLElement) || element.getAttribute("role") !== "option" ||
      !check.visible(element) || check.unsafe(element)) return null;
  const menu = element.closest('[role="listbox"]');
  if (!menu?.id || !/^[A-Za-z][\w:-]{0,127}$/u.test(menu.id) ||
      document.querySelectorAll(`[id="${CSS.escape(menu.id)}"]`).length !== 1 ||
      !check.visible(menu) || check.unsafe(menu) || menu.querySelectorAll('[role="option"]').length > 80) return null;
  const triggers = [...document.querySelectorAll('[role="combobox"],[aria-haspopup="listbox"]')].filter(node =>
    node.getAttribute("aria-controls") === menu.id && node.getAttribute("aria-expanded") === "true" && check.visible(node));
  if (triggers.length !== 1 || check.unsafe(triggers[0])) return null;
  const trigger = triggers[0];
  const labelled = (trigger.getAttribute("aria-labelledby") ?? "").split(/\s+/u)
    .map(id => document.getElementById(id)?.textContent ?? "").join(" ");
  const label = `${trigger.getAttribute("aria-label") ?? ""} ${labelled} ${(trigger as HTMLElement).innerText ?? ""}`.replace(/\s+/gu, " ").trim();
  if (!label || label.length > 200 || /\b(?:book|reserve|checkout|pay|purchase|login|contact|confirm|account|member|email|phone|birth|bday|dob)\b|\d{1,2}:\d{2}/iu.test(label)) return null;
  const players = /\b(?:players?|people|party|guests?|group|bays?)\b/iu.test(label);
  const duration = /\b(?:duration|length)\b/iu.test(label);
  if (players === duration) return null;
  const text = element.innerText.replace(/\s+/gu, " ").trim();
  if (!text || text.length > 80 || /\b(?:book|reserve|checkout|pay|purchase|login|contact|confirm)\b|\d{1,2}:\d{2}/iu.test(text)) return null;
  return { text, menuId: menu.id, label, purpose: players ? "PLAYERS" : "DURATION" };
}

/** An already open, explicitly related public filter menu. Exact text narrows
 * the saved selector before uniqueness; neither a custom tag nor data-value
 * supplies authority. Legacy controls stay with their existing interpreter. */
export async function trySelectPublicFilterOption(nodes: Locator, expected: string, input: { simulator: boolean }) {
  if (await nodes.count() > 80) throw new Error("AMBIGUOUS_CONTROL");
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const candidates = nodes.filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`, "u") });
  const options: Locator[] = [];
  for (const node of await candidates.all())
    if (await node.isVisible() && await node.getAttribute("role") === "option") options.push(node);
  if (!options.length) return false;
  if (options.length !== 1) throw new Error("AMBIGUOUS_CONTROL");
  const node = options[0], proof = await node.evaluate(optionProof);
  if (!proof || proof.text !== expected) throw new Error("UNSAFE_CONTROL");
  const players = /^(?:[1-9]|1\d|20)(?:\s+(?:players?|people|guests?|bays?))?$/iu.exec(expected);
  if (proof.purpose === "PLAYERS" ? !players || input.simulator && Number.parseInt(expected, 10) !== 1
    : !/^\d+(?:\.\d+)?\s*(?:hours?|hrs?|hr|minutes?|mins?|min)$/iu.test(expected) ||
      publicRentalDurationMinutes(expected) === undefined) throw new Error("UNSAFE_CONTROL");
  if (!await node.isEnabled() || JSON.stringify(await node.evaluate(optionProof)) !== JSON.stringify(proof)) throw new Error("UNSAFE_CONTROL");
  await node.click();
  return true;
}
