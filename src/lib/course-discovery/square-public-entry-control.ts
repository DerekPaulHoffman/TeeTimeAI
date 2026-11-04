/** A Square Online calendar entry is navigation before a service or time is
 * selected. This DOM observation alone grants no request capability. */
export function inspectSquarePublicEntryElement(element: Element): boolean {
  if (location.protocol !== "https:" || !/^\/s\/appointments\/?$/u.test(location.pathname) || location.search || location.hash ||
      document.readyState !== "complete" || element.getRootNode() !== document) return false;
  const check = { visible(node: Element) {
    const bounds = node.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return false;
    let current: Element | null = node;
    for (let depth = 0; current && depth < 32; depth++, current = current.parentElement) {
      const style = getComputedStyle(current);
      if (current.matches('form,[hidden],[inert],[aria-hidden="true"],template,script,noscript,iframe') ||
          style.display === "none" || ["hidden", "collapse"].includes(style.visibility) || Number(style.opacity) === 0) return false;
    }
    return current === null;
  }, text(node: Element) { return ((node as HTMLElement).innerText ?? "").replace(/\s+/gu, " ").trim(); } };
  if ([...document.querySelectorAll('[data-slot],[data-slot-id],[data-start-time],[data-booking-id],[data-reservation-id],[data-testid="availability-segments"]')].some(check.visible)) return false;
  const candidates = document.querySelectorAll(".book-button > button");
  if (candidates.length !== 1 || candidates[0] !== element || !(element instanceof HTMLButtonElement) ||
      !check.visible(element) || element.disabled || element.form || element.type !== "submit" ||
      ["form", "formaction", "onclick", "href"].some(name => element.hasAttribute(name)) ||
      element.getAttribute("aria-disabled") === "true" || check.text(element) !== "Book" ||
      !element.classList.contains("w-button") || !element.parentElement?.classList.contains("w-wrapper")) return false;
  const widget = element.parentElement.parentElement?.parentElement;
  if (!widget?.matches(".w-container.row") || !check.visible(widget) || widget.querySelectorAll("*").length > 120 ||
      widget.querySelector('form,input,select,textarea,[contenteditable],[role="grid"],[role="dialog"],time,[datetime],[data-time],[data-slot],[data-slot-id],[data-start-time],[data-booking-id],[data-reservation-id]')) return false;
  const buttons = [...widget.querySelectorAll("button")], headings = [...widget.querySelectorAll("h1,h2,h3,h4,h5,h6")];
  return buttons.length === 2 && buttons.every(button => check.visible(button) && !button.disabled && !button.form) &&
    buttons.filter(button => check.text(button) === "My bookings").length === 1 && headings.length === 1 &&
    check.visible(headings[0]) && /^book a tee time$/iu.test(check.text(headings[0]));
}

/** A projected MARKET-ROW label belongs to its real shadow anchor. Opening a
 * public service variant is navigation; it selects neither duration nor time. */
export function inspectSquarePublicCatalogLinkElement(element: Element): { selector: string; name: string; href: string } | undefined {
  const current = new URL(location.href);
  if (window.top !== window || current.origin !== "https://book.squareup.com" || current.hash ||
      !/^\/appointments\/[a-z0-9]{1,64}\/location\/[A-Z0-9]{13}\/services$/u.test(current.pathname)) return;
  for (const [key, value] of current.searchParams) if (current.searchParams.getAll(key).length !== 1 ||
      !((key === "color" || key === "buttonTextColor") && /^[a-fA-F0-9]{6}$/u.test(value) ||
        key === "locale" && /^[a-z]{2}(?:-[A-Z]{2})?$/u.test(value) || key === "referrer" && /^[a-z]{1,16}$/u.test(value))) return;
  const root = element.getRootNode(); if (!(root instanceof ShadowRoot)) return;
  const host = root.host;
  if (!(element instanceof HTMLAnchorElement) || !host.matches("market-row.service-row[interactive][transient]") ||
      element.hasAttribute("download") || element.hasAttribute("onclick") || host.hasAttribute("onclick") ||
      host.hasAttribute("disabled") || host.getAttribute("aria-disabled") === "true" || element.getAttribute("aria-disabled") === "true" ||
      ![null, "", "_self"].includes(element.getAttribute("target")) || ![null, "", "link"].includes(element.getAttribute("role")) ||
      host.closest("form") || host.querySelectorAll("*").length > 200 || host.querySelector('input,select,textarea,[contenteditable],time,[data-slot-id],[data-start-time]')) return;
  const section = host.closest('section[aria-label="Main content"]');
  if (!section || document.querySelectorAll('section[aria-label="Main content"]').length !== 1 ||
      section.querySelector('form,input,select,textarea,[role="grid"],[role="gridcell"],time,[data-slot-id],[data-start-time]')) return;
  const check = { visible(node: Element) {
    const bounds = node.getBoundingClientRect(); if (!bounds.width || !bounds.height) return false;
    let parent: Element | null = node;
    for (let depth = 0; parent && depth < 40; depth++, parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (parent.matches('[hidden],[inert],[aria-hidden="true"]') || style.display === "none" ||
          ["hidden", "collapse"].includes(style.visibility) || Number(style.opacity) === 0) return false;
    }
    return parent === null;
  } };
  if (!check.visible(host)) return;
  const labels = host.querySelectorAll('label[slot="label"]'), anchors = root.querySelectorAll("a[href]");
  if (labels.length !== 1 || !check.visible(labels[0]) || anchors.length !== 1 || anchors[0] !== element) return;
  const name = ((labels[0] as HTMLElement).innerText ?? "").replace(/\s+/gu, " ").trim();
  if (!name || name.length > 160 || !/\b(?:golf\s+simulator|simulator\s+(?:rental|bay|room|time)|(?:golf|bay|room)\s+rental)\b/iu.test(name) ||
      /\b(?:lesson|coaching|fitting|league|event|member|private|package|pass|sponsorship)\b|\b\d{1,2}:\d{2}|\b\d{1,2}\s*(?:am|pm)\b|\b\d{4}-\d{2}-\d{2}\b/iu.test(name)) return;
  const raw = host.getAttribute("href") ?? "", target = new URL(element.href);
  if (element.getAttribute("href") !== raw || target.origin !== current.origin || target.search || target.hash ||
      !new RegExp(`^${current.pathname}/[A-Z0-9]{16,32}$`, "u").test(target.pathname) ||
      ![target.pathname, target.href].includes(raw)) return;
  if (document.querySelectorAll(`market-row.service-row[href="${raw}"]`).length !== 1) return;
  const parts: string[] = []; let node: Element | null = host;
  for (let depth = 0; node && node !== section && depth < 12; depth++, node = node.parentElement) {
    const parent = node.parentElement; if (!parent) return;
    const siblings = [...parent.children].filter(sibling => sibling.tagName === node!.tagName);
    parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
  }
  if (node !== section) return;
  const hostSelector = `section[aria-label="Main content"] > ${parts.join(" > ")}`;
  if (document.querySelectorAll(hostSelector).length !== 1 || document.querySelector(hostSelector) !== host) return;
  const selector = `${hostSelector} a[href]`; if (selector.length > 240) return;
  return { selector, name, href: target.href };
}
