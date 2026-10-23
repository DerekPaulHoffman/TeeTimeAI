import type { Locator } from "@playwright/test";
import { trySelectPublicFilterOption } from "./public-filter-option";

// Kept self-contained because Playwright serializes this function into Chrome.
function playerTriggerProof(element: Element) {
  const check = {
    visible(node: Element) {
      const box = node.getBoundingClientRect(), style = getComputedStyle(node);
      return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden" &&
        !node.closest('[hidden],[inert],[aria-hidden="true"]');
    },
    unsafe(node: Element) {
      for (let parent: Element | null = node, depth = 0; parent; parent = parent.parentElement, depth++) {
        if (parent.hasAttribute("contenteditable") && parent.getAttribute("contenteditable")?.toLowerCase() !== "false") return true;
        if (depth < 8 && parent.tagName !== "BODY" && /password|secret|credential|email|phone|contact|account|member|profile|birth|bday|dob|checkout|payment|purchase|confirm|reserve|\b(?:login|logon|sign[ -]?(?:in|up)|auth(?:entication|orization)?)\b/iu.test(
          `${parent.getAttribute("aria-label") ?? ""} ${parent.getAttribute("name") ?? ""} ${parent.getAttribute("title") ?? ""}`)) return true;
      }
      return Boolean(node.closest("form,a[href]") || node.hasAttribute("form") || node.hasAttribute("href") ||
        node.querySelector("input,textarea,select,button,a[href],[contenteditable]")) ||
        node.getAttribute("aria-disabled") === "true" || node.hasAttribute("disabled") || node.classList.contains("disabled");
    },
  };
  if (!(element instanceof HTMLElement) || element.getAttribute("role") !== "combobox") return null;
  if (check.unsafe(element)) throw new Error("UNSAFE_CONTROL");
  if (element.tabIndex !== 0 || ![null, "listbox"].includes(element.getAttribute("aria-haspopup")) || !check.visible(element)) return null;
  const text = element.innerText.replace(/\s+/gu, " ").trim();
  const party = /^([1-9]|1\d|20)\s+Players?$/iu.exec(text);
  if (!party) return null;
  const labelled = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/u)
    .map(id => document.getElementById(id)?.textContent ?? "").join(" ");
  const label = `${element.getAttribute("aria-label") ?? ""} ${labelled} ${text}`.replace(/\s+/gu, " ").trim();
  if (label.length > 200 || /\b(?:book|reserve|checkout|pay|purchase|login|password|contact|confirm|account|member|email|phone|duration|hours?|minutes?|birth|bday|dob)\b|\d{1,2}:\d{2}/iu.test(label)) return null;
  const expanded = element.getAttribute("aria-expanded");
  if (expanded !== "true" && expanded !== "false") return null;
  const menuId = element.getAttribute("aria-controls");
  if (menuId && (!/^[A-Za-z][\w:-]{0,127}$/u.test(menuId) || document.querySelectorAll(`[id="${CSS.escape(menuId)}"]`).length > 1)) return null;
  if (expanded === "true") {
    const menu = menuId ? document.getElementById(menuId) : null;
    if (!menu || menu.getAttribute("role") !== "listbox" || !check.visible(menu) || check.unsafe(menu) ||
        menu.querySelectorAll('[role="option"]').length > 80) return null;
    const triggers = [...document.querySelectorAll('[role="combobox"],[aria-haspopup="listbox"]')].filter(node =>
      node.getAttribute("aria-controls") === menuId && node.getAttribute("aria-expanded") === "true" && check.visible(node));
    if (triggers.length !== 1 || triggers[0] !== element) return null;
  } else if (menuId && document.getElementById(menuId) && check.visible(document.getElementById(menuId)!)) return null;
  return { text, label, players: Number(party[1]), expanded: expanded === "true", menuId };
}

async function currentPlayerProof(node: Locator) {
  const proof = await node.evaluate(playerTriggerProof);
  // A recognized party combobox that failed its proof must not fall through to
  // the older, unrelated custom-control interpreter and get clicked there.
  if (!proof && await node.evaluate(element => element.getAttribute("role") === "combobox" &&
      /^\d{1,3}\s+Players?$/iu.test((element as HTMLElement).innerText.replace(/\s+/gu, " ").trim()) &&
      ((element as HTMLElement).tabIndex === 0 || !["DIV", "SPAN", "BUTTON"].includes(element.tagName))))
    throw new Error("UNSAFE_CONTROL");
  return proof;
}

/** Open only an observed party-count combobox. Its custom tag supplies no authority. */
export async function tryOpenPublicPlayerCombobox(node: Locator, expected: string) {
  if (await node.count() !== 1 || !await node.isVisible() || !await node.isEnabled()) return false;
  const proof = await currentPlayerProof(node);
  if (!proof) return false;
  if (proof.expanded || proof.text !== expected || JSON.stringify(await node.evaluate(playerTriggerProof)) !== JSON.stringify(proof))
    throw new Error("UNSAFE_CONTROL");
  await node.click();
  await node.page().getByRole("listbox").filter({ visible: true }).waitFor({ state: "visible", timeout: 3000 });
  const opened = await node.evaluate(playerTriggerProof);
  if (!opened?.expanded || opened.text !== proof.text || opened.label !== proof.label) throw new Error("UNSAFE_CONTROL");
  return true;
}

export async function trySelectPublicPlayerCombobox(node: Locator, value: string, simulator: boolean) {
  const proof = await currentPlayerProof(node);
  if (!proof) return false;
  if (!/^(?:[1-9]|1\d|20)$/u.test(value) || simulator && value !== "1") throw new Error("UNSAFE_CONTROL");
  if (proof.expanded) throw new Error("UNSAFE_CONTROL");
  await tryOpenPublicPlayerCombobox(node, proof.text);
  const opened = await node.evaluate(playerTriggerProof);
  if (!opened?.expanded || !opened.menuId || opened.text !== proof.text || opened.label !== proof.label) throw new Error("UNSAFE_CONTROL");
  const options = node.page().locator(`[id="${opened.menuId}"] [role="option"]`);
  const matches: string[] = [];
  if (await options.count() > 80) throw new Error("AMBIGUOUS_CONTROL");
  for (const option of await options.all()) {
    if (!await option.isVisible()) continue;
    const text = (await option.innerText()).replace(/\s+/gu, " ").trim();
    if (new RegExp(`^${value}\\s+Players?$`, "iu").test(text)) matches.push(text);
  }
  if (JSON.stringify(await node.evaluate(playerTriggerProof)) !== JSON.stringify(opened)) throw new Error("UNSAFE_CONTROL");
  if (matches.length !== 1 || !await trySelectPublicFilterOption(options, matches[0], { simulator })) throw new Error("AMBIGUOUS_CONTROL");
  const selected = await node.evaluate(playerTriggerProof);
  if (!selected || selected.expanded || selected.players !== Number(value)) throw new Error("UNSAFE_CONTROL");
  return true;
}
