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
    };
    if (!(element instanceof HTMLElement) || element.children.length || !check.visible(element) || element.closest("form") ||
        element.hasAttribute("href") || element.hasAttribute("form") || element.hasAttribute("aria-labelledby") || element.hasAttribute("aria-describedby")) return null;
    for (let parent: Element | null = element, depth = 0; parent; parent = parent.parentElement, depth++) {
      const style = getComputedStyle(parent);
      if (depth >= 40 || style.display === "none" || style.visibility === "hidden" || style.opacity === "0" ||
          parent.hasAttribute("hidden") || parent.hasAttribute("inert") || parent.getAttribute("aria-hidden") === "true") return null;
      if (parent.hasAttribute("contenteditable") && parent.getAttribute("contenteditable")?.toLowerCase() !== "false" ||
          parent.tagName !== "BODY" && check.privateContext(
            `${parent.getAttribute("aria-label") ?? ""} ${parent.getAttribute("name") ?? ""} ${parent.getAttribute("title") ?? ""}`)) return null;
    }
    const parent = element.parentElement;
    if (!parent || parent.children.length !== 2 || !check.visible(parent)) return null;
    const icon = [...parent.children].find(child => child !== element);
    if (!(icon instanceof HTMLElement) || icon.getAttribute("role") !== "img" || icon.innerText.trim() !== "person" ||
        !check.visible(icon) || icon.hasAttribute("href") || icon.querySelector("input,button,select,textarea,a[href]")) return null;
    const iconLabel = [icon.getAttribute("aria-label"), icon.getAttribute("title"), icon.getAttribute("name"),
      ...(icon.getAttribute("aria-labelledby") ?? "").split(/\s+/u).filter(Boolean).map(id => document.getElementById(id)?.textContent ?? "unresolved")]
      .filter(Boolean).join(" ").replace(/\s+/gu, " ").trim();
    if (iconLabel && !/^(?:person|players?)$/iu.test(iconLabel)) return null;
    const range = /^([1-4])\s*-\s*([1-4])$/u.exec(element.innerText.trim());
    return range && Number(range[1]) <= Number(range[2]) ? `${range[1]} to ${range[2]} players` : null;
  });
  return proof ?? undefined;
}
