import type { Locator } from "@playwright/test";

/** Interpret a bare range only beside its current public player icon. */
export async function readPublicPartyRangeField(node: Locator): Promise<string | undefined> {
  const proof = await node.evaluate(element => {
    const check = {
      privateContext(text: string) {
        return /password|secret|credential|email|phone|contact|account|member|profile|checkout|payment|purchase|reserve|\b(?:login|sign[ -]?in|auth(?:entication)?|birth|birthday|birthdate|date of birth|dateofbirth|dob)\b/iu
          .test(text.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/[_-]/gu, " "));
      },
      visible(value: Element) {
        const box = value.getBoundingClientRect(), style = getComputedStyle(value);
        return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" &&
          !value.closest('[hidden],[inert],[aria-hidden="true"]');
      },
      readonlyFilterForm(value: Element) {
        const form = value.closest("form");
        if (!form) return true;
        if (!(form instanceof HTMLFormElement) || form.ownerDocument !== document || form.parentElement?.closest("form") ||
            (form.getAttribute("action") ?? "").trim() || !["", "get"].includes((form.getAttribute("method") ?? "").trim().toLowerCase()) ||
            !["", "_self"].includes((form.getAttribute("target") ?? "").trim().toLowerCase()) ||
            form.getAttributeNames().some(name => /^(?:enctype|accept-charset|rel|onsubmit|onreset|formaction|formmethod|formtarget|formenctype|formnovalidate)$/iu.test(name))) return false;
        const nodes = [form, ...form.querySelectorAll("*")], controls = Array.from(form.elements);
        if (nodes.length > 250 || controls.length > 80 || controls.some(control => !form.contains(control) ||
            control.ownerDocument !== document || control.hasAttribute("form") || !control.matches("input,select,textarea,button,fieldset,output"))) return false;
        for (const child of nodes) {
          const native = child === form || controls.includes(child);
          const svg = child instanceof SVGElement && ["svg", "path"].includes(child.localName);
          if (!(child instanceof HTMLElement) && !svg || child.ownerDocument !== document ||
              child instanceof HTMLElement && child.isContentEditable || child.hasAttribute("contenteditable") || child.hasAttribute("form") ||
              child.getAttributeNames().some(name => /^(?:formaction|formmethod|formtarget|formenctype|formnovalidate)$/iu.test(name) ||
                name === "autocomplete" && child.getAttribute(name) !== "off") ||
              child.matches("textarea,a[href],iframe,object,embed,script,style") || child !== form && child.tagName === "FORM") return false;
          if (svg && (child.getAttributeNames().some(name => /^on|(?:^|:)href$/iu.test(name)) || child.hasAttribute("tabindex") ||
              ![null, "false"].includes(child.getAttribute("focusable")) || ![null, "img", "presentation", "none"].includes(child.getAttribute("role")))) return false;
          const referenceAttributes = ["aria-labelledby", "aria-describedby"];
          if (referenceAttributes.some(name => child.hasAttribute(name) && !(child.getAttribute(name) ?? "").trim())) return false;
          const references = referenceAttributes.flatMap(name => (child.getAttribute(name) ?? "").split(/\s+/u).filter(Boolean));
          if (references.length > 8 || new Set(references).size !== references.length ||
              references.some(id => id.length > 128 || document.querySelectorAll('[id="' + CSS.escape(id) + '"]').length !== 1)) return false;
          // Layout identifiers are not private-field evidence. Native control
          // metadata and semantic labels remain strict; values/state stay unread.
          const hints = `${native ? child.getAttribute("id") ?? "" : ""} ${child.getAttribute("name") ?? ""} ${child.getAttribute("aria-label") ?? ""} ${child.getAttribute("title") ?? ""} ${child.getAttribute("placeholder") ?? ""} ` +
            references.map(id => document.getElementById(id)?.textContent ?? "").join(" ") +
            (/^(?:LABEL|LEGEND|BUTTON|OPTION)$/u.test(child.tagName) || child.getAttribute("role") === "button" ? child.textContent ?? "" : "");
          if (hints.length > 500 || check.privateContext(hints) ||
              /\b(?:customer|confirm|book|pay|submit|continue|credit|debit|card|cc|cvv|cvc|expiry|expiration|ssn|token|authorization|api\s*key)\b/iu.test(
                hints.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/[_-]/gu, " "))) return false;
          if (child instanceof HTMLInputElement &&
              (!["date", "number", "range", "radio"].includes(child.type) && !(child.type === "text" && child.readOnly) ||
                child.type !== "radio" && !check.visible(child))) return false;
          if (child instanceof HTMLButtonElement && child.type !== "button" &&
              (child.type !== "submit" || child.innerText.replace(/\s+/gu, " ").trim() !== "Search" ||
                ["aria-label", "title"].some(name => child.hasAttribute(name) && child.getAttribute(name) !== "Search") ||
                references.some(id => document.getElementById(id)?.textContent?.trim() !== "Search") ||
                child.querySelector("input,textarea,select,button,a,[role],[contenteditable]"))) return false;
        }
        return true;
      },
    };
    if (!(element instanceof HTMLElement) || element.children.length || !check.visible(element) ||
        element.hasAttribute("href") || element.hasAttribute("form") || element.hasAttribute("aria-labelledby") || element.hasAttribute("aria-describedby"))
      return { reason: "LEAF_CONTEXT" as const };
    if (!check.readonlyFilterForm(element)) return { reason: "FORM_CONTEXT" as const };
    for (let parent: Element | null = element, depth = 0; parent; parent = parent.parentElement, depth++) {
      const style = getComputedStyle(parent);
      if (depth >= 40 || style.display === "none" || style.visibility === "hidden" || style.opacity === "0" ||
          parent.hasAttribute("hidden") || parent.hasAttribute("inert") || parent.getAttribute("aria-hidden") === "true")
        return { reason: "LEAF_CONTEXT" as const };
      if (parent.hasAttribute("contenteditable") && parent.getAttribute("contenteditable")?.toLowerCase() !== "false" ||
          parent.tagName !== "BODY" && check.privateContext(
            `${parent.getAttribute("aria-label") ?? ""} ${parent.getAttribute("name") ?? ""} ${parent.getAttribute("title") ?? ""}`))
        return { reason: "LEAF_CONTEXT" as const };
    }
    const parent = element.parentElement;
    if (!parent || parent.children.length !== 2 || !check.visible(parent)) return { reason: "PARENT_SHAPE" as const };
    const icon = [...parent.children].find(child => child !== element);
    if (!(icon instanceof HTMLElement) || icon.getAttribute("role") !== "img" || icon.innerText.trim() !== "person" ||
        !check.visible(icon) || icon.hasAttribute("href") || icon.querySelector("input,button,select,textarea,a[href]"))
      return { reason: "ICON_CONTEXT" as const };
    const iconLabel = [icon.getAttribute("aria-label"), icon.getAttribute("title"), icon.getAttribute("name"),
      ...(icon.getAttribute("aria-labelledby") ?? "").split(/\s+/u).filter(Boolean).map(id => document.getElementById(id)?.textContent ?? "unresolved")]
      .filter(Boolean).join(" ").replace(/\s+/gu, " ").trim();
    if (iconLabel && !/^(?:person|players?)$/iu.test(iconLabel)) return { reason: "ICON_CONTEXT" as const };
    const range = /^([1-4])\s*-\s*([1-4])$/u.exec(element.innerText.trim());
    return range && Number(range[1]) <= Number(range[2]) ? `${range[1]} to ${range[2]} players` : { reason: "RANGE_INVALID" as const };
  });
  if (typeof proof !== "string") throw new Error(`PUBLIC_PARTY_RANGE_${proof.reason}`);
  return proof;
}
