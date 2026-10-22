import type { Locator } from "@playwright/test";

export type PublicDatePickerInputProof = { label: string; currentValue: string };

/** DOM-only opener proof, shared by discovery and replay. A displayed value is
 * returned verbatim, never parsed as the requested date or used as date proof. */
export function inspectPublicDatePickerInputElement(element: Element): PublicDatePickerInputProof | undefined {
  if (!(element instanceof HTMLInputElement) || !element.isConnected ||
      !["text", "date"].includes(element.type) || !element.readOnly || element.disabled || element.matches(":disabled") ||
      element.getAttribute("aria-haspopup") !== "dialog" || element.getAttribute("aria-disabled") === "true" ||
      element.hasAttribute("form") || element.form !== element.closest("form") ||
      element.closest('a[href],button,[contenteditable]:not([contenteditable="false"])')) return;
  const unsafe = /\b(?:book|booking|reserve|reservation|checkout|payment|pay|purchase|confirm|continue|login|log in|sign in|account|password|contact|email|phone|telephone|credit|card|billing|birth|birthday|dob|membership)\b/iu;
  // Object methods remain self-contained when tsx keepNames compiles this DOM
  // callback; named arrow bindings would reference its module-only __name helper.
  const helpers = {
    privatePurpose(value: string) {
      const normalized = value.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/[_-]/gu, " ");
      return unsafe.test(normalized) || /\b(?:birthdate|dateofbirth|bday|tel|cc|given name|family name|username|current password|new password|street address|postal code)\b/iu.test(normalized);
    },
    privateAutocomplete(value: string) { return /(?:^|\s)(?:name|given-name|family-name|username|current-password|new-password|email|tel(?:-\w+)?|cc-\w+|street-address|address-line\d|postal-code)(?:\s|$)/iu.test(value); },
    clean(value: string) { return value.replace(/\s+/gu, " ").trim(); },
    safeText(value: string, maximum: number) { return value.length <= maximum && !/[\u0000-\u001f\u007f<>@]|https?:|www\./iu.test(value); },
    visible(node: Element) {
      let parent: Element | null = node;
      for (let depth = 0; parent && depth < 40; depth++, parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (parent.hasAttribute("hidden") || parent.hasAttribute("inert") || parent.getAttribute("aria-hidden") === "true" ||
            style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
      }
      const rect = node.getBoundingClientRect();
      return !parent && rect.width > 0 && rect.height > 0;
    },
  };
  if (helpers.privatePurpose(`${element.getAttribute("name") ?? ""} ${element.getAttribute("autocomplete") ?? ""}`) ||
      helpers.privateAutocomplete(element.getAttribute("autocomplete") ?? "")) return;
  if (!helpers.visible(element)) return;
  let ancestor: Element | null = element;
  for (let depth = 0; ancestor && depth < 40; depth++, ancestor = ancestor.parentElement) {
    if (ancestor.getAttribute("aria-disabled") === "true") return;
    const hints = `${ancestor.getAttribute("aria-label") ?? ""} ${ancestor.getAttribute("title") ?? ""}`;
    if (hints.length > 400 || unsafe.test(hints)) return;
  }
  if (ancestor) return;
  const form = element.closest("form");
  if (form) {
    if (unsafe.test(`${form.getAttribute("action") ?? ""} ${form.getAttribute("name") ?? ""}`)) return;
    const controls = form.querySelectorAll("input,select,textarea,button,[contenteditable]");
    if (controls.length > 100) return;
    for (const control of controls) {
      const autocomplete = control.getAttribute("autocomplete") ?? "";
      const hints = `${control.getAttribute("name") ?? ""} ${control.getAttribute("aria-label") ?? ""} ${control.getAttribute("placeholder") ?? ""}`;
      if (control.matches('input[type="password"],input[type="email"],input[type="tel"],textarea,[contenteditable]:not([contenteditable="false"])') ||
          helpers.privateAutocomplete(autocomplete) || helpers.privatePurpose(`${hints} ${autocomplete}`) ||
          control.tagName === "BUTTON" && unsafe.test(control.textContent ?? "")) return;
    }
  }
  const labels: string[] = [];
  const aria = element.getAttribute("aria-label");
  if (aria !== null) labels.push(aria);
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    const ids = labelledBy.trim().split(/\s+/u);
    if (!labelledBy.trim() || labelledBy.length > 400 || ids.length > 4 || new Set(ids).size !== ids.length) return;
    for (const id of ids) {
      const label = element.ownerDocument.getElementById(id);
      if (!label || !helpers.visible(label)) return;
      labels.push(label.textContent ?? "");
    }
  }
  if (element.labels && element.labels.length > 4) return;
  for (const label of element.labels ?? []) {
    if (!helpers.visible(label)) return;
    labels.push(label.textContent ?? "");
  }
  const placeholder = element.getAttribute("placeholder");
  if (placeholder !== null) labels.push(placeholder);
  // Every supplied semantic label must be safe. A safe placeholder cannot hide
  // a conflicting transaction/contact label on the same input.
  if (!labels.length || labels.some(value => !helpers.safeText(value, 100) || unsafe.test(value))) return;
  const label = labels.find(value => /\b(?:date|calendar)\b|\bchoose\s+day\b/iu.test(helpers.clean(value)));
  if (label === undefined) return;
  const currentValue = element.value;
  const month = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
  const weekday = "(?:(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?),?\\s+)?";
  const displayedDate = new RegExp(`^${weekday}${month}\\s+\\d{1,2},?\\s+\\d{4}$|^\\d{1,2}\\s+${month},?\\s+\\d{4}$`, "iu");
  if (!helpers.safeText(currentValue, 100) || currentValue && !/^\d{4}-\d{2}-\d{2}$|^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/u.test(currentValue) && !displayedDate.test(currentValue)) return;
  return { label, currentValue };
}

export async function inspectPublicDatePickerInput(node: Locator): Promise<PublicDatePickerInputProof | undefined> {
  if (await node.count() !== 1) return;
  return node.evaluate(inspectPublicDatePickerInputElement);
}

/** Opens only an inspected calendar trigger, with a fresh DOM check before the
 * normal Playwright click. It neither fills the readonly field nor picks a day. */
export async function openPublicDatePickerInput(node: Locator, expected?: PublicDatePickerInputProof) {
  const proof = await inspectPublicDatePickerInput(node);
  if (!proof || expected && (proof.label !== expected.label || proof.currentValue !== expected.currentValue))
    throw new Error("UNVERIFIED_PUBLIC_DATE_PICKER_INPUT");
  await node.click();
  return proof;
}
