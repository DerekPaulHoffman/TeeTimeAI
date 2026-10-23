import type { Locator } from "@playwright/test";
import { publicRentalDurationMinutes } from "./recipe";

function optionProof(element: Element) {
  const check = {
    visible(node: Element) {
      const box = node.getBoundingClientRect(), style = getComputedStyle(node);
      return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden" &&
        !node.closest('[hidden],[inert],[aria-hidden="true"]');
    },
    publicFilterForm(node: Element) {
      const form = node.closest("form");
      if (!form) return true;
      if (!(form instanceof HTMLFormElement) || form.ownerDocument !== document || form.parentElement?.closest("form") ||
          (form.getAttribute("action") ?? "").trim() || !["", "get"].includes((form.getAttribute("method") ?? "").trim().toLowerCase()) ||
          !["", "_self"].includes((form.getAttribute("target") ?? "").trim().toLowerCase()) ||
          form.getAttributeNames().some(name => /^(?:enctype|accept-charset|rel|onsubmit|onreset|formaction|formmethod|formtarget|formenctype|formnovalidate)$/iu.test(name))) return false;
      const nodes = [form, ...form.querySelectorAll("*")];
      if (nodes.length > 250 || Array.from(form.elements).some(control => !form.contains(control) || control.hasAttribute("form"))) return false;
      for (const child of nodes) {
        const staticSvg = child instanceof SVGElement && ["svg", "path"].includes(child.localName);
        if (!(child instanceof HTMLElement) && !staticSvg || child.ownerDocument !== document ||
            child instanceof HTMLElement && child.isContentEditable ||
            child.hasAttribute("contenteditable") || child.hasAttribute("form") ||
            child.getAttributeNames().some(name => /^(?:formaction|formmethod|formtarget|formenctype|formnovalidate)$/iu.test(name) ||
              name === "autocomplete" && child.getAttribute(name) !== "off") ||
            child.matches("textarea,a[href],iframe,object,embed,script,style") || child !== form && child.tagName === "FORM") return false;
        if (staticSvg && (child.getAttributeNames().some(name => /^on|(?:^|:)href$/iu.test(name)) ||
            child.hasAttribute("tabindex") || ![null, "false"].includes(child.getAttribute("focusable")) ||
            ![null, "img", "presentation", "none"].includes(child.getAttribute("role")))) return false;
        const attributes = ["aria-labelledby", "aria-describedby"];
        if (attributes.some(name => child.hasAttribute(name) && !(child.getAttribute(name) ?? "").trim())) return false;
        const references = attributes.flatMap(name => (child.getAttribute(name) ?? "").split(/\s+/u).filter(Boolean));
        if (references.length > 8 || new Set(references).size !== references.length ||
            references.some(id => id.length > 128 || document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length !== 1)) return false;
        const hints = `${child.getAttribute("id") ?? ""} ${child.getAttribute("name") ?? ""} ${child.getAttribute("aria-label") ?? ""} ${child.getAttribute("title") ?? ""} ${child.getAttribute("placeholder") ?? ""} ` +
          references.map(id => document.getElementById(id)?.textContent ?? "").join(" ") +
          (/^(?:LABEL|LEGEND|BUTTON)$/u.test(child.tagName) || child.getAttribute("role") === "button" ? child.textContent ?? "" : "");
        if (hints.length > 500 || /password|secret|credential|email|phone|contact|customer|account|member|profile|birth|bday|dob|checkout|payment|purchase|confirm|reserve|\b(?:login|logon|sign[ -]?(?:in|up)|auth(?:entication|orization)?|book|pay|submit|continue|credit|debit|card|cc|cvv|cvc|expiry|expiration|ssn)\b/iu.test(
          hints.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/[_-]/gu, " "))) return false;
        // Passive siblings supply no selection, date, party or request authority.
        // In particular, neither input.value nor radio.checked is read here.
        if (child instanceof HTMLInputElement &&
            (!["date", "number", "range", "radio"].includes(child.type) && !(child.type === "text" && child.readOnly) ||
              child.type !== "radio" && (!check.visible(child) || getComputedStyle(child).opacity === "0"))) return false;
        if (child instanceof HTMLButtonElement && child.type !== "button" &&
            (child.type !== "submit" || child.innerText.replace(/\s+/gu, " ").trim() !== "Search" ||
              ["aria-label", "title"].some(name => child.hasAttribute(name) && child.getAttribute(name) !== "Search") ||
              references.some(id => document.getElementById(id)?.textContent?.trim() !== "Search") ||
              child.querySelector("input,textarea,select,button,a,[role],[contenteditable]"))) return false;
      }
      return true;
    },
    unsafe(node: Element) {
      for (let parent: Element | null = node, depth = 0; parent; parent = parent.parentElement, depth++) {
        if (parent.hasAttribute("contenteditable") && parent.getAttribute("contenteditable")?.toLowerCase() !== "false") return true;
        if (depth < 8 && parent.tagName !== "BODY" && /password|secret|credential|email|phone|contact|account|member|profile|birth|bday|dob|checkout|payment|purchase|confirm|reserve|\b(?:login|logon|sign[ -]?(?:in|up)|auth(?:entication|orization)?)\b/iu.test(
          `${parent.getAttribute("aria-label") ?? ""} ${parent.getAttribute("name") ?? ""} ${parent.getAttribute("title") ?? ""}`)) return true;
      }
      if (node instanceof HTMLElement && node.isContentEditable || [...node.querySelectorAll("[contenteditable]")]
        .some(child => child.getAttribute("contenteditable")?.toLowerCase() !== "false")) return true;
      return Boolean(node instanceof HTMLButtonElement && node.form && node.type !== "button" ||
        node.closest('a[href],[contenteditable="true"]') || !check.publicFilterForm(node) || node.hasAttribute("form") || node.hasAttribute("href") ||
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
