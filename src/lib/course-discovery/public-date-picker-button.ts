import type { Locator } from "@playwright/test";

// Self-contained: Playwright serializes this callback, including under tsx.
function datePickerButtonProof(element: Element) {
  if (!(element instanceof HTMLButtonElement) || element.children.length !== 2 ||
      Array.from(element.children).some(child => child.tagName !== "DIV")) return null;
  const descendants = Array.from(element.querySelectorAll("*"));
  if (descendants.length > 12 || descendants.some(child => !["DIV", "SPAN"].includes(child.tagName))) throw new Error("UNSAFE_CONTROL");
  const check = {
    unsafe(text: string) {
      return /\b(?:book|booking|reserve|reservation|checkout|pay|payment|purchase|confirm|continue|login|logon|sign[ -]?(?:in|up)|auth(?:entication)?|account|profile|password|secret|credential|contact|email|phone|birth|birthday|birthdate|dateofbirth|dob|member|membership)\b/iu
        .test(text.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/[_-]/gu, " "));
    },
    text(node: Element) { return ((node as HTMLElement).innerText ?? "").replace(/\s+/gu, " ").trim(); },
    visible(node: Element) {
      const box = node.getBoundingClientRect(), style = getComputedStyle(node);
      return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" &&
        !node.closest('[hidden],[inert],[aria-hidden="true"]');
    },
    display(text: string) {
      const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12]\d|3[01])$/u.exec(text);
      if (!match) return false;
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      // No year is displayed. This bounds the token without pretending it
      // verifies the requested date or a weekday/year relationship.
      return Number(match[3]) <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][months.indexOf(match[2])];
    },
  };
  if (!element.isConnected || element.form || element.hasAttribute("form") || element.disabled || element.matches(":disabled") ||
      element.hasAttribute("href") || element.hasAttribute("value") || element.hasAttribute("data-value") || element.hasAttribute("formaction") ||
      element.hasAttribute("aria-labelledby") || element.hasAttribute("aria-describedby") ||
      ![null, "button"].includes(element.getAttribute("role")) || ![null, "dialog"].includes(element.getAttribute("aria-haspopup")) ||
      element.querySelector("input,select,textarea,a,button,iframe,[contenteditable]")) throw new Error("UNSAFE_CONTROL");
  let ancestor: Element | null = element;
  for (let depth = 0; ancestor && depth < 40; depth++, ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (ancestor.tagName === "FORM" || ancestor.hasAttribute("hidden") || ancestor.hasAttribute("inert") ||
        ancestor.getAttribute("aria-hidden") === "true" || ancestor.getAttribute("aria-disabled") === "true" || ancestor.hasAttribute("disabled") ||
        ancestor instanceof HTMLElement && ancestor.isContentEditable ||
        ancestor.hasAttribute("contenteditable") && ancestor.getAttribute("contenteditable")?.toLowerCase() !== "false" ||
        style.display === "none" || style.visibility === "hidden" || style.opacity === "0" || style.pointerEvents === "none" ||
        check.unsafe(`${ancestor.getAttribute("aria-label") ?? ""} ${ancestor.getAttribute("title") ?? ""} ${ancestor.getAttribute("name") ?? ""}`)) throw new Error("UNSAFE_CONTROL");
  }
  if (ancestor || !check.visible(element)) throw new Error("UNSAFE_CONTROL");
  const children = Array.from(element.children);
  if (descendants.some(child => !check.visible(child) || child instanceof HTMLElement && child.isContentEditable ||
      ["href", "form", "value", "data-value", "tabindex", "role", "contenteditable", "aria-controls", "aria-haspopup", "aria-labelledby", "aria-describedby"].some(name => child.hasAttribute(name)) ||
      Array.from(child.attributes).some(attribute => /^on/iu.test(attribute.name)) ||
      check.unsafe(`${child.getAttribute("aria-label") ?? ""} ${child.getAttribute("title") ?? ""} ${child.getAttribute("name") ?? ""}`)))
    throw new Error("UNSAFE_CONTROL");
  const parts = children.map(check.text), dates = parts.filter(check.display), labels = parts.filter(text => text === "Date");
  if (dates.length !== 1 || labels.length !== 1 || check.text(element) !== parts.join(" ")) return null;
  if ([element.getAttribute("aria-label"), element.getAttribute("title")].some(value => value !== null && value.trim() !== "" && value.trim() !== "Date")) return null;
  return { label: "Date", displayedDate: dates[0] };
}

/** Opens only the observed Date button. Its changing, yearless display is never
 * date proof: the subsequent dated-choice action must prove the full date. */
export async function tryOpenPublicDatePickerButton(node: Locator, expectedLabel: string): Promise<boolean> {
  if (expectedLabel !== "Date" || await node.count() !== 1 || !await node.isVisible() || !await node.isEnabled()) return false;
  const proof = await node.evaluate(datePickerButtonProof);
  if (!proof) return false;
  if (!await node.isEnabled() || JSON.stringify(await node.evaluate(datePickerButtonProof)) !== JSON.stringify(proof)) throw new Error("UNSAFE_CONTROL");
  await node.click({ timeout: 3000 });
  return true;
}
