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
        const rawId = child.getAttribute("id") ?? "";
        const normalizedId = rawId.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/[_-]/gu, " ");
        const layoutId = child instanceof HTMLElement && child !== form &&
          !child.matches("input,select,textarea,button,option,optgroup,output,label,legend,a,area,summary,details,audio,video") &&
          child.tabIndex < 0 && !child.hasAttribute("tabindex") && !child.hasAttribute("href") &&
          [null, "presentation", "none"].includes(child.getAttribute("role")) &&
          !child.getAttributeNames().some(name => /^on/iu.test(name) ||
            /^aria-(?:haspopup|controls|owns|expanded|pressed|checked|selected)$/iu.test(name));
        const privateHint = /password|secret|credential|email|phone|contact|customer|account|member|profile|birth|bday|dob|checkout|payment|purchase|confirm|reserve|\b(?:login|logon|sign[ -]?(?:in|up)|auth(?:entication|orization)?|book|pay|submit|continue|credit|debit|card|cc|cvv|cvc|expiry|expiration|ssn)\b/iu;
        // A passive layout ID can name a card view; field/label/context hints
        // still use the full privacy pattern, as do card-number/input IDs.
        const privateLayoutId = /password|secret|credential|email|phone|contact|customer|account|member|profile|birth|bday|dob|checkout|payment|purchase|confirm|reserve|\b(?:login|logon|sign[ -]?(?:in|up)|auth(?:entication|orization)?|book|pay|submit|continue|credit|debit|cc|cvv|cvc|expiry|expiration|ssn)\b|\bcard\s+(?:number|input)\b/iu;
        const hints = `${child.getAttribute("name") ?? ""} ${child.getAttribute("aria-label") ?? ""} ${child.getAttribute("title") ?? ""} ${child.getAttribute("placeholder") ?? ""} ` +
          references.map(id => document.getElementById(id)?.textContent ?? "").join(" ") +
          (/^(?:LABEL|LEGEND|BUTTON)$/u.test(child.tagName) || child.getAttribute("role") === "button" ? child.textContent ?? "" : "");
        if (rawId.length + 1 + hints.length > 500 || (layoutId ? privateLayoutId : privateHint).test(normalizedId) || privateHint.test(
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
      return Boolean(node instanceof HTMLButtonElement && node.form && node.type !== "button" ||
        node.closest("a[href]") || !check.publicFilterForm(node) || node.hasAttribute("form") || node.hasAttribute("href") ||
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
