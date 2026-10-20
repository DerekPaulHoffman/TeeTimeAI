import type { ElementHandle, Locator } from "@playwright/test";

export type PublicRentalServiceProof = { label: string; selectedText: string; options: Array<{ label: string; value?: string }> };
export type PublicServiceContinuationMode = "SERVICE" | "SKIP_PACKAGES";
export type PublicRentalServiceSelection = Readonly<{ label: string }>;
type SelectionState = { trigger: Locator; field: ElementHandle<Element>; document: ElementHandle<Element>; url: string; selectedName: string;
  phase: "SELECTED" | "SERVICE_DONE" | "PACKAGES_DONE"; inFlight?: boolean };
const selections = new WeakMap<PublicRentalServiceSelection, SelectionState>();
const clean = (value: string) => value.replace(/\s+/gu, " ").trim();
const serviceName = (value: string) => clean(value).replace(/\s*(?:\$\s*\d{1,5}(?:\.\d{2})?|USD\s*\d{1,5}(?:\.\d{2})?)$/iu, "").trim();

/** This is a product selector, never a time, lesson, event, or paid package. */
export function isPublicRentalServiceLabel(value: string) {
  const text = serviceName(value);
  return text.length >= 4 && text.length <= 160 &&
    /\b(?:golf\s+simulator|simulator\s+(?:rental|bay|time)|golf\s+(?:rental|bay)|(?:bay|room)\s+rental)\b/iu.test(text) &&
    !/\b(?:lessons?|coaching|fittings?|leagues?|tournaments?|events?|members?|membership|passes?|packages?|checkout|pay(?:ment)?|purchase|reserve|reservation|contact|email|phone|cart|login|sign\s*(?:in|up)|confirm|submit)\b|\d{1,2}:\d{2}|\b\d{1,2}\s*(?:am|pm)\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d/iu.test(text);
}

// Self-contained browser predicate; methods avoid transpiler-injected closures.
function serviceElement(node: Element) {
  const check = {
    text(element: Element) { return ((element as HTMLElement).innerText ?? "").replace(/\s+/gu, " ").trim(); },
    visible(element: Element) {
      const bounds = element.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return false;
      let current: Element | null = element;
      for (let depth = 0; current && depth < 32; depth++, current = current.parentElement) {
        const style = getComputedStyle(current);
        if (current.matches('[hidden],[inert],[aria-hidden="true"]') || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return !current;
    },
  };
  const native = node.tagName === "SELECT";
  if (!check.visible(node) || node.matches(":disabled") || node.getAttribute("aria-disabled") === "true" || node.closest("a[href]")) return undefined;
  let context: Element | null = node;
  for (let depth = 0; context && depth < 32; depth++, context = context.parentElement)
    if (/checkout|payment|contact|account|login|review|confirm|cart|reserve|purchase/iu.test(
      `${context.getAttribute("aria-label") ?? ""} ${context.getAttribute("title") ?? ""} ${context.getAttribute("name") ?? ""}`)) return undefined;
  if (!native && (!/^(?:INPUT|DIV|SPAN|BUTTON)$/u.test(node.tagName) || node.getAttribute("role") !== "combobox" ||
      node.getAttribute("aria-haspopup") !== "listbox" || !node.getAttribute("aria-controls") ||
      node.tagName === "INPUT" && !["text", "search"].includes(node.getAttribute("type") ?? "text"))) return undefined;
  if (!native && !/^[A-Za-z_][A-Za-z0-9_:-]{0,100}$/u.test(node.getAttribute("aria-controls") ?? "")) return undefined;
  let field = node.parentElement;
  for (let depth = 0; field && depth < 10; depth++, field = field.parentElement) {
    if (["BODY", "HTML"].includes(field.tagName) || check.text(field).length > 1200) break;
    const labels = Array.from(field.querySelectorAll("label,legend")).filter(element => check.visible(element) &&
      /^(?:Select\s+)?(?:Service|Activity|Product):?$/iu.test(check.text(element)));
    const triggers = Array.from(field.querySelectorAll('select,[role="combobox"]')).filter(element => check.visible(element));
    if (labels.length !== 1 || triggers.length !== 1 || triggers[0] !== node) continue;
    const form = field.closest("form") ?? field;
    if (form.querySelectorAll("*").length > 1500) return undefined;
    const unsafeFields = Array.from(form.querySelectorAll("input,select,textarea,button")).filter(element => check.visible(element) && element !== node && !node.contains(element));
    if (unsafeFields.some(element => element.tagName !== "BUTTON" ||
        !/^(?:Continue|Next|Back|Previous)$/iu.test(check.text(element)) || element.getAttribute("type") !== "button")) return undefined;
    const metadata = `${form.getAttribute("aria-label") ?? ""} ${form.getAttribute("title") ?? ""}`;
    if (/checkout|payment|contact|account|login|review|confirm|cart/iu.test(metadata)) return undefined;
    const selectedText = native ? (node as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? "" :
      Array.from(field.querySelectorAll("*")).filter(element => !element.children.length && element !== node && check.visible(element) &&
        !labels[0].contains(element) && !element.closest('[role="listbox"],[role="option"]'))
        .map(element => check.text(element)).filter(Boolean).join(" ") || (node as HTMLInputElement).value || "";
    return { label: check.text(labels[0]), selectedText, native, menuId: native ? null : node.getAttribute("aria-controls"),
      field, options: native ? Array.from((node as HTMLSelectElement).options).slice(0, 41).map(option => ({ label: option.textContent?.trim() ?? "", value: option.value,
        disabled: option.disabled || option.matches(":disabled") || option.hidden || option.getAttribute("aria-disabled") === "true" ||
          Boolean(option.parentElement?.matches("optgroup[hidden],optgroup:disabled")) || getComputedStyle(option).display === "none" })) : [] };
  }
  return undefined;
}

// Element objects cannot cross jsonValue. Keep the field identity in a separate
// handle; public metadata contains only observed labels/options.
async function serviceState(node: Locator) {
  if (await node.count() !== 1) return undefined;
  const handle = await node.evaluateHandle(serviceElement, undefined, { timeout: 1000 });
  const data = await handle.evaluate(value => value ? ({ label: value.label, selectedText: value.selectedText,
    native: value.native, menuId: value.menuId, options: value.options }) : undefined);
  const field = data ? (await handle.getProperty("field")).asElement() : null;
  await handle.dispose();
  return data && field ? { ...data, field } : undefined;
}

async function publicOptions(node: Locator, state: NonNullable<Awaited<ReturnType<typeof serviceState>>>) {
  if (state.native) {
    if (state.options.length > 40) throw new Error("AMBIGUOUS_SERVICE_OPTIONS");
    return state.options.filter(option => !option.disabled && isPublicRentalServiceLabel(option.label));
  }
  const menuId = state.menuId!;
  if (!/^[A-Za-z_][A-Za-z0-9_:-]{0,100}$/u.test(menuId)) throw new Error("UNOWNED_SERVICE_OPTIONS");
  const menu = node.page().locator(`[id="${menuId}"]`);
  if (await menu.count() !== 1 || !await menu.isVisible()) return [];
  const candidates = menu.getByRole("option").filter({ visible: true });
  if (await candidates.count() > 40) throw new Error("AMBIGUOUS_SERVICE_OPTIONS");
  const options: Array<{ label: string; value?: string }> = [];
  for (const option of await candidates.all()) {
    const safe = await option.evaluate(element => {
      if (element.closest('a[href],form') || element.querySelector("a[href],button,input,select,textarea") ||
          element.getAttribute("aria-disabled") === "true" || element.matches(":disabled")) return false;
      let ancestor: Element | null = element;
      for (let depth = 0; ancestor && depth < 32; depth++, ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (ancestor.matches('[hidden],[inert],[aria-hidden="true"]') || style.display === "none" || style.visibility === "hidden" || style.opacity === "0" ||
            /checkout|payment|contact|account|login|review|confirm|cart|reserve|purchase/iu.test(
              `${ancestor.getAttribute("aria-label") ?? ""} ${ancestor.getAttribute("title") ?? ""} ${ancestor.getAttribute("name") ?? ""}`)) return false;
      }
      return !ancestor;
    });
    const label = clean(await option.innerText());
    if (safe && await option.isEnabled() && isPublicRentalServiceLabel(label)) options.push({ label });
  }
  if (new Set(options.map(option => serviceName(option.label).toLowerCase())).size !== options.length) throw new Error("AMBIGUOUS_SERVICE_OPTIONS");
  return options;
}

export async function inspectPublicRentalService(node: Locator): Promise<PublicRentalServiceProof | undefined> {
  const state = await serviceState(node);
  if (!state) return undefined;
  try { return { label: state.label, selectedText: state.selectedText, options: await publicOptions(node, state) }; }
  finally { await state.field.dispose(); }
}

export async function openPublicRentalService(node: Locator): Promise<void> {
  const state = await serviceState(node);
  if (!state) throw new Error("UNSAFE_SERVICE_CONTROL");
  try {
    if (state.native) return;
    const ownedMenu = node.page().locator(`[id="${state.menuId}"]`);
    if (await ownedMenu.count() !== 1 || !await ownedMenu.evaluate(element => {
      let ancestor: Element | null = element;
      for (let depth = 0; ancestor && depth < 32; depth++, ancestor = ancestor.parentElement)
        if (/checkout|payment|contact|account|login|review|confirm|cart|reserve|purchase/iu.test(
          `${ancestor.getAttribute("aria-label") ?? ""} ${ancestor.getAttribute("title") ?? ""} ${ancestor.getAttribute("name") ?? ""}`)) return false;
      return !ancestor;
    })) throw new Error("UNOWNED_SERVICE_OPTIONS");
    const foreign = await node.page().getByRole("listbox").filter({ visible: true }).evaluateAll((menus, id) => menus.some(menu => menu.id !== id), state.menuId);
    if (foreign) throw new Error("UNOWNED_SERVICE_OPTIONS");
    if (await node.getAttribute("aria-expanded") !== "true") await node.click();
    await ownedMenu.waitFor({ state: "visible", timeout: 2000 });
  } finally { await state.field.dispose(); }
}

export async function selectPublicRentalService(node: Locator, optionText: string): Promise<PublicRentalServiceSelection> {
  if (!isPublicRentalServiceLabel(optionText)) throw new Error("UNSAFE_RENTAL_SERVICE");
  await openPublicRentalService(node);
  const state = await serviceState(node);
  if (!state) throw new Error("UNSAFE_SERVICE_CONTROL");
  try {
    const options = (await publicOptions(node, state)).filter(option => clean(option.label) === clean(optionText));
    if (options.length !== 1) throw new Error("UNOBSERVED_RENTAL_SERVICE");
    if (state.native) await node.selectOption(options[0].value!);
    else await node.page().locator(`[id="${state.menuId}"]`).getByRole("option", { name: options[0].label, exact: true }).click();
    const selectedName = serviceName(options[0].label);
    const expires = Date.now() + 2000;
    do {
      const selected = await serviceState(node);
      if (selected) {
        const matches = serviceName(selected.selectedText).toLowerCase() === selectedName.toLowerCase();
        await selected.field.dispose();
        if (matches) {
          const token = Object.freeze({ label: selectedName });
          const document = (await node.page().locator("html").elementHandle())!;
          selections.set(token, { trigger: node, field: state.field, document, url: node.page().url(), selectedName, phase: "SELECTED" });
          return token;
        }
      }
      await node.page().waitForTimeout(50);
    } while (Date.now() < expires);
    throw new Error("SERVICE_SELECTION_UNCONFIRMED");
  } catch (error) { await state.field.dispose(); throw error; }
}

export async function inspectPublicServiceContinuation(node: Locator, selection: PublicRentalServiceSelection | undefined, mode: PublicServiceContinuationMode): Promise<boolean> {
  const saved = selection && selections.get(selection);
  if (!saved || saved.inFlight || saved.phase !== (mode === "SERVICE" ? "SELECTED" : "SERVICE_DONE") ||
      saved.trigger.page() !== node.page() || node.page().url() !== saved.url || await node.count() !== 1) return false;
  const state = await serviceState(saved.trigger).catch(() => undefined);
  if (!state) return false;
  try {
    if (serviceName(state.selectedText).toLowerCase() !== saved.selectedName.toLowerCase()) return false;
    return await node.evaluate((button, args) => {
      const check = {
        visible(element: Element) { const r = element.getBoundingClientRect(); let ancestor: Element | null = element;
          for (let i = 0; ancestor && i < 32; i++, ancestor = ancestor.parentElement) { const s = getComputedStyle(ancestor);
            if (ancestor.matches('[hidden],[inert],[aria-hidden="true"]') || s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false; }
          return !ancestor && r.width > 0 && r.height > 0; },
        text(element: Element) { return ((element as HTMLElement).innerText ?? "").replace(/\s+/gu, " ").trim(); },
      };
      if (document.documentElement !== args.document || !args.trigger || !args.field.isConnected || !args.field.contains(args.trigger) ||
          button.tagName !== "BUTTON" || button.getAttribute("type") !== "button" || !check.visible(button) || button.matches(":disabled") ||
          button.getAttribute("aria-disabled") === "true" || button.closest("a[href]") || button.querySelector("a[href],input,select,textarea") ||
          button.hasAttribute("formaction") || /checkout|payment|contact|account|login|review|confirm|cart|reserve|purchase/iu.test(
            `${button.getAttribute("aria-label") ?? ""} ${button.getAttribute("title") ?? ""} ${button.getAttribute("name") ?? ""}`)) return false;
      const text = check.text(button);
      if (args.mode === "SERVICE" ? !/^(?:Continue|Next)$/iu.test(text) :
          !/^Skip packages and continue with (?:the )?selected service(?:\s+\$\d{1,5}(?:\.\d{2})?(?:\s*-\s*\$\d{1,5}(?:\.\d{2})?)?)?$/iu.test(text)) return false;
      let root = button.parentElement;
      for (let depth = 0; root && depth < 8 && !["BODY", "HTML"].includes(root.tagName); depth++, root = root.parentElement) {
        if (!root.contains(args.field)) continue;
        // A form's immediate widget wrapper also contains sibling stages. Do
        // not certify a still-visible old form while its calendar is active.
        if (root.tagName === "FORM" && root.parentElement && !["BODY", "HTML"].includes(root.parentElement.tagName)) root = root.parentElement;
        if (root.querySelectorAll("*").length > 1500 || check.text(root).length > 6000) return false;
        const sameActions = Array.from(root.querySelectorAll('button[type="button"]')).filter(element => check.visible(element) &&
          (args.mode === "SERVICE" ? /^(?:Continue|Next)$/iu.test(check.text(element)) : /^Skip packages and continue with (?:the )?selected service\b/iu.test(check.text(element))));
        if (sameActions.length !== 1 || sameActions[0] !== button) return false;
        const visible = Array.from(root.querySelectorAll("input,select,textarea,[role=combobox]"))
          .filter(element => check.visible(element) && element !== args.trigger && !args.trigger.contains(element));
        if (visible.length) return false;
        let ancestor: Element | null = root;
        for (let depth = 0; ancestor && depth < 32; depth++, ancestor = ancestor.parentElement)
          if (/checkout|payment|contact|account|login|review|confirm|cart/iu.test(`${ancestor.getAttribute("aria-label") ?? ""} ${ancestor.getAttribute("title") ?? ""}`)) return false;
        if (args.mode === "SKIP_PACKAGES" && !/packages with this service/iu.test(check.text(root))) return false;
        // This stage can only configure a product, before any visible time/date
        // controls, appointment card or contact/payment entry has appeared.
        if (Array.from(root.querySelectorAll('button,[role=button],[role=option],[role=gridcell]')).some(element => check.visible(element) &&
            /\d{1,2}:\d{2}|\b\d{1,2}\s*(?:am|pm)\b/u.test(check.text(element)))) return false;
        if (Array.from(root.querySelectorAll('[role="grid"],[role="gridcell"],input[type="date"],input[type="time"],time[datetime],[data-slot-id],[data-start-time],[class*="calendar" i],[class*="datepicker" i],[aria-label*="calendar" i]'))
          .some(element => check.visible(element))) return false;
        const leaves = Array.from(root.querySelectorAll('span,div,h1,h2,h3,h4,p,th')).filter(element => !element.children.length && check.visible(element));
        const monthYear = leaves.some(element => /^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2}$/iu.test(check.text(element)));
        if (monthYear && Array.from(root.querySelectorAll('button,td,[role=button]')).filter(element => check.visible(element) && /^(?:[1-9]|[12]\d|3[01])$/u.test(check.text(element))).length >= 7) return false;
        return true;
      }
      return false;
    }, { field: saved.field, document: saved.document, trigger: await saved.trigger.elementHandle(), mode });
  } catch { return false; }
  finally { await state.field.dispose(); }
}

export async function continuePublicRentalService(node: Locator, selection: PublicRentalServiceSelection | undefined, mode: PublicServiceContinuationMode): Promise<void> {
  if (!await inspectPublicServiceContinuation(node, selection, mode)) throw new Error("UNSAFE_SERVICE_CONTINUATION");
  const state = selection && selections.get(selection);
  if (!state || state.inFlight || state.phase !== (mode === "SERVICE" ? "SELECTED" : "SERVICE_DONE")) throw new Error("UNSAFE_SERVICE_CONTINUATION");
  state.inFlight = true;
  try { await node.click(); state.phase = mode === "SERVICE" ? "SERVICE_DONE" : "PACKAGES_DONE"; }
  finally { state.inFlight = false; }
}
