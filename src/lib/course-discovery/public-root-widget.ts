export type PublicRootWidgetFacts = { overflow: boolean; calendarCount: number; filterGroupCount: number; serviceCatalogCount?: number };
export type NativeRootWidgetWitness = { kind: "NATIVE_ROOT_PUBLIC_WIDGET"; pageUrl: string; observedAt: string; documentHash: string; widgetKind: "CALENDAR" | "PUBLIC_FILTERS" | "SERVICE_CATALOG" };

/** Serialized fixed read-only collector. Return presence counts, never input
 * values, dates, captions, selectors, identity, availability or URL authority. */
export function collectPublicRootWidget(): PublicRootWidgetFacts {
  const result = { overflow: false, calendarCount: 0, filterGroupCount: 0, serviceCatalogCount: 0 };
  const all = document.querySelectorAll("*");
  if (all.length > 10_000) return { ...result, overflow: true };
  const helpers = {
    visible(node: Element) {
      const rect = node.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return false;
      let ancestor: Element | null = node;
      for (let depth = 0; ancestor; depth++, ancestor = ancestor.parentElement) {
        if (depth > 64) { result.overflow = true; return false; }
        const style = getComputedStyle(ancestor);
        if (ancestor.hasAttribute("hidden") || ancestor.hasAttribute("inert") || ancestor.getAttribute("aria-hidden") === "true" ||
            style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
      }
      return true;
    },
    enabled(node: Element) { return !node.hasAttribute("disabled") && node.getAttribute("aria-disabled") !== "true" && getComputedStyle(node).pointerEvents !== "none"; },
    scope(node: Element) { return node.closest('section,article,main,[role="region"]') ?? node.parentElement; },
    eligible(node: Element) {
      return !node.closest("form") && helpers.visible(node) && !node.querySelector('input[type="password"],input[type="email"],input[type="tel"],[autocomplete^="cc-"]');
    },
    publicScope(scope: Element, serviceCatalog = false) {
      if (!helpers.eligible(scope) || scope.querySelectorAll("*").length > 2000) return false;
      const headings = scope.querySelectorAll(serviceCatalog ? "h1,h2,h3,h4,h5,h6,legend" : "h1,h2,h3,h4,legend");
      if (headings.length > 48) { result.overflow = true; return false; }
      const labels = [scope.getAttribute("aria-label") ?? ""];
      for (const heading of headings) if (helpers.visible(heading)) labels.push(heading.textContent ?? "");
      return labels.some(label => label.length <= 200 && /\b(?:availability|tee[ -]?times?|book(?:ing)?|rentals?|schedule|golf)\b/iu.test(label));
    },
    labelText(label: Element) {
      const pending = [...label.childNodes]; let text = "", count = 0;
      while (pending.length) {
        const node = pending.shift()!;
        if (++count > 32) { result.overflow = true; return ""; }
        if (node.nodeType === Node.TEXT_NODE) text += " " + (node.textContent ?? "");
        else if (node instanceof Element && !["INPUT", "SELECT", "TEXTAREA", "OPTION", "BUTTON"].includes(node.tagName)) pending.push(...node.childNodes);
      }
      return text;
    },
    label(node: Element) {
      const parts = [node.getAttribute("aria-label") ?? ""];
      const ids = (node.getAttribute("aria-labelledby") ?? "").trim().split(/\s+/u).filter(Boolean);
      if (ids.length > 4) { result.overflow = true; return ""; }
      for (const id of ids) { const label = document.getElementById(id); if (label) parts.push(helpers.labelText(label)); }
      if (node instanceof HTMLInputElement || node instanceof HTMLSelectElement) for (const label of node.labels ?? []) parts.push(helpers.labelText(label));
      const text = parts.join(" ").replace(/\s+/gu, " ").trim();
      return text.length <= 200 && !/\b(?:password|email|phone|contact|address|checkout|payment|login|account|subscribe)\b/iu.test(text) ? text : "";
    },
    serviceText(node: Element, bound: number) {
      const pending: Node[] = [...node.childNodes]; let text = "", count = 0;
      while (pending.length) {
        const child = pending.shift()!;
        if (++count > 2000) { result.overflow = true; return ""; }
        if (child.nodeType === Node.TEXT_NODE) text += " " + (child.textContent ?? "");
        else if (child instanceof Element && helpers.visible(child) && !["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(child.tagName)) pending.push(...child.childNodes);
        if (text.length > bound) { result.overflow = true; return ""; }
      }
      return text.replace(/\s+/gu, " ").trim();
    },
    serviceSafe(node: Element) {
      const count = node.querySelectorAll("*").length;
      if (count > 2000) { result.overflow = true; return false; }
      if (!helpers.eligible(node) || node.closest('[role="form"]') || node.querySelector('form,[role="form"],input,select,textarea,[role="combobox"],[role="grid"],[role="gridcell"],time[datetime]')) return false;
      const text = helpers.serviceText(node, 8000);
      return !!text && !/\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\b\d{1,2}\s*[ap]\.?m\.?\b|\b(?:slots?|password|email|phone|checkout|payment|purchase|pay|cart|account|login|member|subscribe|confirm|selected|reservation)\b/iu.test(text);
    },
    duration(node: Element) {
      const match = /^(?:(\d{1,2})\s*(?:hrs?|hours?)(?:\s+(\d{1,2})\s*(?:mins?|minutes?))?|(\d{1,3})\s*(?:mins?|minutes?))$/iu.exec(helpers.serviceText(node, 200));
      if (!match) return null;
      if (match[2] !== undefined && Number(match[2]) >= 60) return null;
      const minutes = Number(match[1] ?? 0) * 60 + Number(match[2] ?? match[3] ?? 0);
      return minutes >= 15 && minutes <= 480 ? minutes : null;
    },
    serviceControl(node: Element) {
      const role = node.getAttribute("role") ?? "";
      return !node.hasAttribute("form") && (node.tagName === "BUTTON" ? role === "" || role === "button" : node.tagName === "A" ? ["", "link", "button"].includes(role) : role === "button");
    },
    passiveDisclosure(node: Element) {
      return node.tagName === "SPAN" && node.getAttribute("role") === "button" && node.getAttribute("aria-haspopup") === "menu" &&
        !node.hasAttribute("href") && !node.hasAttribute("form") && helpers.visible(node) && helpers.enabled(node) &&
        /^(?:more)$/iu.test(helpers.serviceText(node, 80)) && (!node.hasAttribute("aria-label") || /^more$/iu.test(node.getAttribute("aria-label") ?? ""));
    },
    hiddenPassiveDisclosure(node: Element) {
      const text = node.textContent ?? "";
      return node.tagName === "SPAN" && node.getAttribute("role") === "button" && node.getAttribute("aria-haspopup") === "menu" &&
        !node.hasAttribute("href") && !node.hasAttribute("form") && !helpers.visible(node) && text.length <= 80 &&
        /^more$/iu.test(text.replace(/\s+/gu, " ").trim()) && (!node.hasAttribute("aria-label") || /^more$/iu.test(node.getAttribute("aria-label") ?? ""));
    },
  };
  const calendarRoots: Element[] = [];
  const calendars = document.querySelectorAll('[role="grid"],table,[class*="calendar"],[class*="datepicker"],[class*="date-picker"],[class*="flatpickr"]');
  if (calendars.length > 128) return { ...result, overflow: true };
  for (const calendar of calendars) {
    const scope = helpers.scope(calendar);
    if (!scope || !helpers.publicScope(scope) || !helpers.eligible(calendar)) continue;
    const cells = calendar.querySelectorAll('[role="gridcell"],td,button,[role="button"],.calendar-day,.flatpickr-day');
    const headers = calendar.querySelectorAll('[role="columnheader"],th,abbr,span');
    if (cells.length > 128 || headers.length > 256) { result.overflow = true; continue; }
    const weekdays = new Set<string>();
    for (const header of headers) if (helpers.visible(header)) {
      const text = (header.textContent ?? "").trim();
      if (/^(?:sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)$/iu.test(text)) weekdays.add(text.toLowerCase().slice(0, 3));
    }
    let days = 0;
    for (const cell of cells) if (helpers.visible(cell) && helpers.enabled(cell) && !cell.closest("form") &&
      /^(?:[1-9]|[12]\d|3[01])$/u.test((cell.textContent ?? "").trim())) days++;
    if (weekdays.size >= 5 && days >= 7 && days <= 42 && !calendarRoots.some(root => root.contains(calendar))) calendarRoots.push(calendar);
  }
  result.calendarCount = calendarRoots.length;
  const controls = document.querySelectorAll('input[type="date"],select,[role="combobox"]');
  if (controls.length > 128) return { ...result, overflow: true };
  const groups = new Map<Element, { date: number; secondary: number }>();
  for (const control of controls) {
    const scope = helpers.scope(control);
    if (!scope || !helpers.publicScope(scope) || !helpers.eligible(control) || !helpers.enabled(control)) continue;
    const label = helpers.label(control);
    if (!label) continue;
    const group = groups.get(scope) ?? { date: 0, secondary: 0 };
    if (/\b(?:date|day)\b/iu.test(label)) group.date++;
    else if (/\b(?:duration|length|players?|party|people|guests?|golfers?|resources?|bays?|suites?|courses?)\b/iu.test(label)) group.secondary++;
    groups.set(scope, group);
  }
  for (const group of groups.values()) if (group.date >= 1 && group.date <= 4 && group.secondary >= 1 && group.secondary <= 8) result.filterGroupCount++;
  if (result.calendarCount !== 0 || result.filterGroupCount !== 0) return result;
  const buttons = [...document.querySelectorAll('button,[role="button"],a')];
  if (buttons.length > 128) return { ...result, overflow: true };
  const cards = new Map<Element, string>();
  const hiddenDisclosures = new Set<Element>();
  for (const button of buttons) {
    if (!helpers.visible(button) || !helpers.enabled(button) || !helpers.serviceControl(button) || (button.textContent ?? "").length > 80 || !/^(?:book|select)$/iu.test(helpers.serviceText(button, 80)) ||
        button.hasAttribute("aria-label") && !/^(?:book|select)$/iu.test(button.getAttribute("aria-label") ?? "")) continue;
    let node = button.parentElement;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      if (!helpers.serviceSafe(node)) continue;
      const headings = [...node.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(item => helpers.visible(item));
      const controls = [...node.querySelectorAll('button,[role="button"],a')];
      const disclosures = controls.filter(item => helpers.passiveDisclosure(item)), hidden = controls.filter(item => helpers.hiddenPassiveDisclosure(item));
      const actions = controls.filter(item => !disclosures.includes(item) && !hidden.includes(item));
      // A responsive hidden copy is passive only beside a valid visible More.
      // It gains no action grant and private fields still fail serviceSafe.
      if (headings.length !== 1 || actions.length !== 1 || actions[0] !== button || disclosures.length + hidden.length > 4 || hidden.length > 0 && disclosures.length === 0 ||
          disclosures.some(item => disclosures.some(other => item !== other && !item.contains(other) && !other.contains(item)))) continue;
      const title = helpers.serviceText(headings[0], 200);
      const durations = new Set([...node.querySelectorAll("p,span,div")].filter(item => !item.contains(headings[0]) && helpers.visible(item)).map(item => helpers.duration(item)).filter(item => item !== null));
      if (!title || durations.size !== 1) continue;
      const duration = [...durations][0]; // Presence only: marketing title may include a separately published reset period.
      cards.set(node, title.toLowerCase() + "|" + duration); for (const disclosure of hidden) hiddenDisclosures.add(disclosure); break;
    }
  }
  if (cards.size > 16) return { ...result, overflow: true };
  const catalogs: Element[] = [];
  for (const card of cards.keys()) {
    let scope = card.parentElement;
    for (let depth = 0; scope && depth < 8; depth++, scope = scope.parentElement) {
      if (!helpers.serviceSafe(scope) || !helpers.publicScope(scope, true)) continue;
      const owned = [...cards].filter(([node]) => scope!.contains(node)), controls = [...scope.querySelectorAll('button,[role="button"],a')];
      if (owned.length < 2 || new Set(owned.map(([, key]) => key)).size !== owned.length ||
          controls.some(control => {
            if (!owned.some(([card]) => card.contains(control))) return true;
            if (hiddenDisclosures.has(control)) return !helpers.hiddenPassiveDisclosure(control);
            return !helpers.passiveDisclosure(control) && (!helpers.visible(control) || !helpers.enabled(control) || !helpers.serviceControl(control) || !/^(?:book|select)$/iu.test(helpers.serviceText(control, 80)));
          })) continue;
      if (!catalogs.includes(scope)) catalogs.push(scope); break;
    }
  }
  result.serviceCatalogCount = catalogs.filter(scope => !catalogs.some(other => other !== scope && scope.contains(other))).length;
  return result;
}

export function publicRootWidgetKind(facts: PublicRootWidgetFacts): NativeRootWidgetWitness["widgetKind"] | null {
  const serviceCatalogCount = facts?.serviceCatalogCount ?? 0;
  if (facts?.overflow !== false || ![facts.calendarCount, facts.filterGroupCount, serviceCatalogCount].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 128)) return null;
  return facts.calendarCount === 1 ? "CALENDAR" : facts.calendarCount === 0 && facts.filterGroupCount === 1 ? "PUBLIC_FILTERS" :
    facts.calendarCount === 0 && facts.filterGroupCount === 0 && serviceCatalogCount === 1 ? "SERVICE_CATALOG" : null;
}

export type NativeRootWidgetCapture = { pageUrl: string; observedAt: number; documentHash: string; documentIdentityHash: string; settled: boolean; widget: PublicRootWidgetFacts };
export function pairedNativeRootWidget(first: NativeRootWidgetCapture, second: NativeRootWidgetCapture,
  clock: { startedAt: number; now: number; deadline: number }): NativeRootWidgetWitness | null {
  const valid = (row: NativeRootWidgetCapture) => row?.settled === true && Number.isFinite(row.observedAt) && row.widget?.overflow === false &&
    Number.isSafeInteger(row.widget.calendarCount) && row.widget.calendarCount >= 0 && row.widget.calendarCount <= 128 &&
    Number.isSafeInteger(row.widget.filterGroupCount) && row.widget.filterGroupCount >= 0 && row.widget.filterGroupCount <= 128 &&
    Number.isSafeInteger(row.widget.serviceCatalogCount ?? 0) && (row.widget.serviceCatalogCount ?? 0) >= 0 && (row.widget.serviceCatalogCount ?? 0) <= 128 &&
    /^[a-f0-9]{64}$/u.test(row.documentHash) && /^[a-f0-9]{64}$/u.test(row.documentIdentityHash);
  if (!valid(first) || !valid(second) || !Number.isFinite(clock.startedAt) || !Number.isFinite(clock.now) || !Number.isFinite(clock.deadline) ||
      clock.now >= clock.deadline || first.observedAt < clock.startedAt || second.observedAt < first.observedAt || second.observedAt > clock.now || clock.now - first.observedAt > 5000 ||
      first.pageUrl !== second.pageUrl || first.documentHash !== second.documentHash || first.documentIdentityHash !== second.documentIdentityHash ||
      JSON.stringify(first.widget) !== JSON.stringify(second.widget)) return null;
  const widgetKind = publicRootWidgetKind(second.widget);
  return widgetKind ? { kind: "NATIVE_ROOT_PUBLIC_WIDGET", pageUrl: second.pageUrl, observedAt: new Date(second.observedAt).toISOString(), documentHash: second.documentHash, widgetKind } : null;
}
