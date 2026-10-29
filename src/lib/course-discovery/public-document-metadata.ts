/** Fixed computed-visible metadata read. It performs no form action or network call. */
export function collectNativeOfficialPublicMetadata(input: string | { venueName: string; venueAddress: string; canonicalCoursePhone: string }) {
  const expectedVenueName = typeof input === "string" ? input : input.venueName;
  const labels = { name(v: string) { return v.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase().replace(/^welcome to\s+/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\bgolf (?:club|course)$/u, "golf course"); } };
  const expected = labels.name(expectedVenueName);
  const forms = Array.from(document.forms);
  const cms = {
    visible(node: Element) {
      if (!(node instanceof HTMLElement) || node.closest('script,style,template,noscript,iframe,input,textarea,select,button,label,[contenteditable],[hidden],[inert],[aria-hidden="true"]') ||
          node.querySelector('input,textarea,select,button,label,[contenteditable]')) return false;
      const rect = node.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) return false;
      let parent: Element | null = node, depth = 0;
      while (parent && depth++ < 32) {
        const style = getComputedStyle(parent);
        const box = parent.getBoundingClientRect();
        if (style.display === "none" || ["hidden", "collapse"].includes(style.visibility) || style.opacity === "0" ||
            ([style.overflowX,style.overflow].some(value => value === "hidden" || value === "clip") && box.width <= 0) ||
            ([style.overflowY,style.overflow].some(value => value === "hidden" || value === "clip") && box.height <= 0) ||
            /\b(?:account|members?|profile|customer|checkout|payment|billing|mailing|corporate|fax|login|sign-in)\b/iu.test(
              ["id", "class", "aria-label", "title"].map(k => parent!.getAttribute(k) ?? "").join(" "))) return false;
        parent = parent.parentElement;
      }
      return parent === null;
    },
    logo(anchor: HTMLAnchorElement) {
      try {
        const href = new URL(anchor.href), current = new URL(document.URL);
        if (current.protocol !== "https:" || href.protocol !== "https:" || href.origin !== current.origin || href.pathname !== "/" ||
            href.search || href.hash || href.username || href.password || anchor.hasAttribute("onclick") || anchor.hasAttribute("download") || !this.visible(anchor)) return undefined;
        const images = Array.from(anchor.querySelectorAll("img[alt]"));
        return images.length === 1 && this.visible(images[0]) && (images[0].getAttribute("alt") ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase() ===
          expectedVenueName.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase() ? images[0].getAttribute("alt")! : undefined;
      } catch { return undefined; }
    },
    contact(form: HTMLFormElement) {
      if (typeof input === "string" || input.venueAddress.length > 500 || !/^\+1\d{10}$/u.test(input.canonicalCoursePhone)) return false;
      const house = /^\s*(\d+[A-Z]?)\s+([\p{L}\p{N}]+)/iu.exec(input.venueAddress), zip = Array.from(input.venueAddress.matchAll(/\b(\d{5})(?:-\d{4})?\b/gu)).at(-1);
      const nodes = Array.from(form.querySelectorAll("p,address,div,li,td"));
      if (!house || !zip || nodes.length > 3000 || !Array.from(form.querySelectorAll("a[href]")).some(a => a instanceof HTMLAnchorElement && this.logo(a) !== undefined)) return false;
      return nodes.some(node => {
        if (!(node instanceof HTMLElement) || !this.visible(node)) return false;
        const text = node.innerText.replace(/\s+/gu, " ").trim();
        if (text.length > 500 || text.length < 15) return false;
        const phoneNodes = [node, ...Array.from(node.querySelectorAll("p,span,a"))];
        const addressNodes = [node, ...Array.from(node.querySelectorAll("p,address,span"))];
        return phoneNodes.some(p => p instanceof HTMLElement && this.visible(p) && /^(?:\+?1[ .()-]*)?\(?\d{3}\)?[ .-]*\d{3}[ .-]*\d{4}$/u.test(p.innerText.trim()) &&
          p.innerText.replace(/\D/gu, "").replace(/^1(?=\d{10}$)/u, "") === input.canonicalCoursePhone.slice(2)) &&
          addressNodes.some(a => a instanceof HTMLElement && /^(?:P|ADDRESS|SPAN)$/u.test(a.tagName) && !a.querySelector("p,address") && this.visible(a) &&
            new RegExp("\\b" + house[1] + "\\s+" + house[2] + "\\b", "iu").test(a.innerText) && Array.from(a.innerText.matchAll(/\b(\d{5})(?:-\d{4})?\b/gu)).at(-1)?.[1] === zip[1]);
      });
    },
  };
  const formEligibility = new Map<HTMLFormElement, boolean>();
  const formRules = { eligible(form: HTMLFormElement) {
    if (formEligibility.has(form)) return formEligibility.get(form)!;
    try {
      const action = new URL(form.getAttribute("action") ?? "", document.URL);
      const current = new URL(document.URL);
      // Metadata comparison only: observed HTTPS root redirects may retain a second slash.
      // Never change the form action, navigation URL, path/query evidence, or POST permission.
      const sameRootDocument = action.protocol === "https:" && current.protocol === "https:" && action.origin === current.origin &&
        !action.username && !action.password && !current.username && !current.password &&
        /^\/{1,2}$/u.test(action.pathname) && /^\/{1,2}$/u.test(current.pathname) &&
        !action.search && !current.search && !action.hash && !current.hash;
      const eligible = expected.length >= 8 && forms.length === 1 && form.parentElement === document.body && form.method.toLowerCase() === "post" &&
        (action.href === current.href || sameRootDocument) && Boolean(form.querySelector('footer,[role="contentinfo"]')) &&
        (Array.from(form.querySelectorAll("h1,h2")).some(h => {
          if (!(h instanceof HTMLElement) || h.closest('[hidden],[inert],[aria-hidden="true"]') || h.querySelector('input,textarea,select,button,label,[contenteditable]')) return false;
          let node: HTMLElement | null = h, depth = 0;
          while (node && depth++ < 32) { const style = getComputedStyle(node); if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false; node = node.parentElement; }
          const rect = h.getBoundingClientRect(); return !node && rect.width > 0 && rect.height > 0 && labels.name(h.innerText) === expected;
        }) || current.protocol === "https:" && !current.username && !current.password && cms.contact(form));
      formEligibility.set(form, eligible); return eligible;
    } catch { return false; }
  } };
  const headings: string[] = [], linkUrls: string[] = [], addressTexts: string[] = [], phoneTexts: string[] = [], publicRentalTexts: string[] = [], publicBusinessLabels: string[] = [], officialContactBusinessNames: string[] = [];
  let phoneTextsOmitted = false;
  const service = /\s(?:and|&)\s+([\p{L}][\p{L} -]{1,39})$/iu.exec(expectedVenueName)?.[1];
  const serviceWords = service?.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/u) ?? [];
  const brandLinks: Array<{ href: string; text: string }> = [];
  const publicNodes = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,a[href],address,p,div,li,td,span,strong'));
  if (publicNodes.length > 3000) phoneTextsOmitted = true;
  for (const node of publicNodes.slice(0, 3000)) {
    if (!(node instanceof HTMLElement) || node.closest('script,template,noscript,iframe,input,textarea,select,button,label,[contenteditable],[hidden],[inert],[aria-hidden="true"]') ||
        node.querySelector('input,textarea,select,button,label,[contenteditable]')) continue;
    const form = node.closest("form");
    if (form && !formRules.eligible(form)) continue;
    const rect = node.getBoundingClientRect();
    let ancestor: HTMLElement | null = node, visible = Boolean(rect.width && rect.height), depth = 0;
    while (ancestor && visible && depth++ < 32) {
      const style = getComputedStyle(ancestor);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' ||
          /\b(?:account|profile|checkout|payment|billing|login|sign-in|members-only)\b/iu.test(
            ['id','class','aria-label','title'].map(k => ancestor!.getAttribute(k) ?? '').join(' '))) visible = false;
      ancestor = ancestor.parentElement;
    }
    if (!visible || ancestor) continue;
    const value = node.innerText.replace(/\n+/gu, ', ').replace(/\s+/gu, ' ').trim();
    if (!form && /^(?:P|SPAN|STRONG|DIV|ADDRESS)$/u.test(node.tagName) && value === expectedVenueName && officialContactBusinessNames.length < 20)
      officialContactBusinessNames.push(value);
    if (/^H[1-6]$/u.test(node.tagName) && value.length <= 300 && headings.length < 80) headings.push(value);
    if (node instanceof HTMLAnchorElement && linkUrls.length < 120) linkUrls.push(node.href);
    if (node instanceof HTMLAnchorElement && !form && value.length <= 120 && publicBusinessLabels.length < 20 && serviceWords.length) {
      const words = value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/u);
      if (words.length <= 8 && words.some((_, index) => serviceWords.every((word, offset) => words[index + offset] === word))) publicBusinessLabels.push(value);
    }
    if (node instanceof HTMLAnchorElement && !form && value.length <= 200 && brandLinks.length < 20 &&
        [node, node.parentElement].some(v => v?.classList.contains("site-title"))) brandLinks.push({ href: node.href, text: value });
    if (node instanceof HTMLAnchorElement && form && typeof input !== "string" && brandLinks.length < 20) {
      const alt = cms.logo(node); if (alt !== undefined) brandLinks.push({ href: node.href, text: alt });
    }
    if (node instanceof HTMLAnchorElement && /^tel:/u.test(node.getAttribute("href") ?? "") && !form && value.length <= 40) {
      let context: HTMLElement | null = node, publicContact = true;
      while (context) {
        if (/(?:account|member|profile|customer|checkout|payment|billing|corporate|mailing|fax)/iu.test(
          ['id','class','aria-label','title','name'].map(k => context!.getAttribute(k) ?? '').join(' '))) publicContact = false;
        context = context.parentElement;
      }
      if (publicContact) {
        if (phoneTexts.length < 20) phoneTexts.push(value);
        else phoneTextsOmitted = true;
      }
    }
    if (form && typeof input !== "string" && phoneTexts.length < 20 && value.length <= 40 &&
        /^(?:\+?1[ .()-]*)?\(?\d{3}\)?[ .-]*\d{3}[ .-]*\d{4}$/u.test(value) &&
        value.replace(/\D/gu, "").replace(/^1(?=\d{10}$)/u, "") === input.canonicalCoursePhone.slice(2)) phoneTexts.push(value);
    if (value.length >= 15 && value.length <= 500 && addressTexts.length < 160 && /\b\d{5}(?:-\d{4})?\b/u.test(value)) addressTexts.push(value);
    if (value.length <= 500 && publicRentalTexts.length < 40 && /\bpublic simulator rental\b/iu.test(value) &&
        /\bper bay\b/iu.test(value) && /\b(?:up to|max(?:imum)?(?: of)?)\s+[1-4]\s+(?:golfers|players|people)\b/iu.test(value)) publicRentalTexts.push(value);
  }
  const contacts = {
    clean(v: string) { return v.normalize("NFKC").replace(/\s+/gu, " ").trim(); },
    visible(node: Element) {
      if (!(node instanceof HTMLElement) || node.closest('form,script,style,template,noscript,iframe,[hidden],[inert],[aria-hidden="true"],[contenteditable]')) return false;
      const rect = node.getBoundingClientRect(); if (!rect.width || !rect.height) return false;
      let parent: Element | null = node, depth = 0;
      while (parent && depth++ < 64) {
        const style = getComputedStyle(parent);
        if (style.display === "none" || ["hidden","collapse"].includes(style.visibility) || style.opacity === "0" ||
          /\b(?:account|members?|profile|customer|checkout|payment|billing|mailing|corporate|headquarters|fax|login|sign-in)\b/iu.test(["id","class","title","aria-label"].map(k => parent!.getAttribute(k) ?? "").join(" ")) ||
          Array.from(parent.children).some(c => /^H[1-6]$/u.test(c.tagName) && /\b(?:mailing|corporate|billing|headquarters|fax)\b/iu.test(c.textContent ?? ""))) return false;
        parent = parent.parentElement;
      }
      return parent === null;
    },
  };
  const namedContactBlocks: Array<{ name: string; addressText: string; phones: Array<{ href: string; text: string }> }> = [];
  const contactPhoneLinks: Array<{ href: string; text: string }> = [];
  const telAnchors = Array.from(document.querySelectorAll('a[href^="tel:"]'));
  let contactPhoneLinksOmitted = telAnchors.length > 100;
  if (!contactPhoneLinksOmitted) for (const anchor of telAnchors) {
    if (!(anchor instanceof HTMLAnchorElement) || anchor.closest('form') || !cms.visible(anchor)) continue;
    let group: Element | null = anchor.parentElement, depth = 0, contactGroup = false;
    while (group && group !== document.body && depth++ < 8) {
      if (Array.from(group.querySelectorAll('h1,h2,h3,h4,h5,h6')).some(heading => cms.visible(heading) &&
          heading.textContent?.replace(/\s+/gu, ' ').trim().toLowerCase() === 'contact us')) { contactGroup = true; break; }
      group = group.parentElement;
    }
    if (!contactGroup) continue;
    const value = anchor.innerText.replace(/\s+/gu, ' ').trim(), href = anchor.getAttribute('href') ?? '';
    if (value.length > 47 || href.length > 64) { contactPhoneLinksOmitted = true; continue; }
    if (contactPhoneLinks.length >= 20) { contactPhoneLinksOmitted = true; break; }
    contactPhoneLinks.push({ href, text: value });
  }
  const publicLinkLabels: Array<{ href: string; text: string }> = [];
  const publicBookingEntryLinks: Array<{ href: string; text: string }> = [];
  let publicBookingEntryLinksOmitted = false;
  const allPublicAnchors = Array.from(document.querySelectorAll('a[href]'));
  const officialContactLinkLabels: Array<{ href: string; text: string }> = [];
  let officialContactLinkLabelsOmitted = allPublicAnchors.length > 3000;
  let publicLinkLabelsOmitted = allPublicAnchors.length > 3000;
  if (!publicLinkLabelsOmitted) for (const anchor of allPublicAnchors) {
    if (!(anchor instanceof HTMLAnchorElement) || anchor.closest('form') || !cms.visible(anchor)) continue;
    const text = anchor.innerText.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    let href: URL; try { href = new URL(anchor.href); } catch { continue; }
    if (/^(?:book(?:\s+a)?\s+tee\s*time|tee\s*times?|online\s+reservations)$/iu.test(text) &&
        href.protocol === "https:" && href.origin === new URL(document.URL).origin && !href.search && !href.hash &&
        !href.username && !href.password && !href.port && !anchor.hasAttribute("onclick") && !anchor.hasAttribute("download")) {
      if (publicBookingEntryLinks.length < 120) publicBookingEntryLinks.push({ href: href.href, text });
      else { publicBookingEntryLinksOmitted = true; publicBookingEntryLinks.length = 0; }
    }
    if (!officialContactLinkLabelsOmitted && text.length <= 160 && href.protocol === 'https:' && !href.username && !href.password && !href.port && !href.hash &&
        !anchor.hasAttribute('onclick') && !anchor.hasAttribute('download') &&
        (/^contact(?:\s+us)?$/iu.test(text) && href.origin === new URL(document.URL).origin && !href.search ||
          /\b(?:tee\s*times?|book|reservations?)\b/iu.test(text) && /^[a-z0-9-]+\.book\.teeitup\.(?:com|golf)$/u.test(href.hostname) && href.pathname === '/')) {
      if (officialContactLinkLabels.length < 120) officialContactLinkLabels.push({ href: href.href, text });
      else { officialContactLinkLabelsOmitted = true; officialContactLinkLabels.length = 0; }
    }
    if (!text || text.length > 160 || /[\u0000-\u001f\u007f]/u.test(text) || href.protocol !== 'https:' || href.username || href.password || href.port || href.hash ||
        !/^[a-z][a-z0-9-]*\.cps\.golf$/u.test(href.hostname) || !['/','/onlineresweb/search-teetime'].includes(href.pathname)) continue;
    if (href.pathname === '/' && href.search) continue;
    if (href.pathname === '/onlineresweb/search-teetime') {
      const fields = href.search.slice(1).split('&');
      let validFields = fields.length === 2;
      for (const field of fields) if (!/^(?:TeeOffTimeMin|TeeOffTimeMax)=(?:0|[1-9]\d?)(?:\.\d{1,15})?$/u.test(field)) validFields = false;
      if (!validFields || new Set([...href.searchParams.keys()]).size !== 2) continue;
      const min=Number(href.searchParams.get('TeeOffTimeMin')), max=Number(href.searchParams.get('TeeOffTimeMax'));
      if (min < 0 || min > max || max >= 24) continue;
    }
    if (publicLinkLabels.length >= 120) { publicLinkLabelsOmitted = true; publicLinkLabels.length = 0; break; }
    publicLinkLabels.push({ href: href.href, text });
  }
  const contactCandidates: Array<{ node: Element; data: typeof namedContactBlocks[number] }> = [];
  let namedContactBlocksOmitted = false;
  const containers = Array.from(document.querySelectorAll('div,section,footer,p,li,td'));
  if (containers.length > 3000) namedContactBlocksOmitted = true;
  else for (const node of containers) {
    if (!(node instanceof HTMLElement) || !contacts.visible(node) || node.querySelector('form,input,textarea,select,button,label,[contenteditable]') || contacts.clean(node.innerText).length > 600) continue;
    const names = Array.from(node.children).filter(c => c instanceof HTMLElement && contacts.visible(c) && /^(?:P|SPAN|STRONG|A|H[1-6])$/u.test(c.tagName) && contacts.clean(c.innerText).toLowerCase() === contacts.clean(expectedVenueName).toLowerCase());
    const addresses = Array.from(node.querySelectorAll('address')).filter(c => contacts.visible(c));
    if (!names.length || !addresses.length) continue;
    if (names.length !== 1 || addresses.length !== 1) { namedContactBlocksOmitted = true; continue; }
    const phones = Array.from(node.querySelectorAll('a[href^="tel:"]')).filter(c => contacts.visible(c));
    if (!phones.length || phones.length > 8) { namedContactBlocksOmitted = true; continue; }
    contactCandidates.push({ node, data: { name: contacts.clean((names[0] as HTMLElement).innerText), addressText: contacts.clean((addresses[0] as HTMLElement).innerText.replace(/\n+/gu, ', ')),
      phones: phones.map(c => ({ href: c.getAttribute('href')!, text: contacts.clean((c as HTMLElement).innerText) })) } });
    if (contactCandidates.length > 40) { namedContactBlocksOmitted = true; break; }
  }
  if (!namedContactBlocksOmitted) for (const candidate of contactCandidates) if (!contactCandidates.some(other => other.node !== candidate.node && candidate.node.contains(other.node))) namedContactBlocks.push(candidate.data);
  const frameNodes = Array.from(document.querySelectorAll('iframe[src]'));
  const delegatedFrameSources: { rows: Array<{ src: string; visible: boolean; srcdoc: boolean; inForm: boolean }>; omitted: boolean } = { rows: [], omitted: frameNodes.length > 24 };
  if (!delegatedFrameSources.omitted) for (const node of frameNodes) {
    const src = node.getAttribute("src") ?? "";
    if (src.length > 2048) { delegatedFrameSources.omitted = true; continue; }
    const rect = node.getBoundingClientRect(); let parent: Element | null = node, visible = rect.width > 0 && rect.height > 0, depth = 0;
    while (parent && depth++ < 64) {
      const style = getComputedStyle(parent);
      if (parent.hasAttribute("hidden") || parent.hasAttribute("inert") || parent.getAttribute("aria-hidden") === "true" ||
          style.display === "none" || ["hidden","collapse"].includes(style.visibility) || style.opacity === "0") visible = false;
      parent = parent.parentElement;
    }
    delegatedFrameSources.rows.push({ src, visible: visible && parent === null, srcdoc: node.hasAttribute("srcdoc"), inForm: Boolean(node.closest("form")) });
  }
  const cpsBookingWidgets: Array<{ configuration: string; fields: Array<{ name: string; tag: string; type: string }> }> = [];
  let cpsBookingWidgetsOmitted = false;
  const entryVisibility = { visible(node: HTMLElement) {
    const rect = node.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) return false;
    let current: HTMLElement | null = node, depth = 0;
    while (current && depth++ < 40) {
      const style = getComputedStyle(current);
      if (current.hasAttribute("hidden") || current.hasAttribute("inert") || current.getAttribute("aria-hidden") === "true" ||
          style.display === "none" || ["hidden", "collapse"].includes(style.visibility) || style.opacity !== "" && Number(style.opacity) === 0 ||
          /\b(?:account|member|profile|customer|checkout|payment|billing|login|password)\b/iu.test(
            ["id", "class", "aria-label", "title"].map(key => current!.getAttribute(key) ?? "").join(" "))) return false;
      current = current.parentElement;
    }
    return current === null;
  } };
  const widgetForms = Array.from(document.querySelectorAll('form.tee-time-form'));
  if (widgetForms.length > 20) cpsBookingWidgetsOmitted = true;
  else for (const candidate of widgetForms) {
    if (!(candidate instanceof HTMLFormElement) || !entryVisibility.visible(candidate)) continue;
    if (candidate.method.toLowerCase() !== "get" || candidate.hasAttribute("onsubmit") || candidate.hasAttribute("action") || candidate.closest('form form')) {
      cpsBookingWidgetsOmitted = true; continue;
    }
    const widget = candidate.parentElement, configuration = widget?.getAttribute("data-widget-config");
    if (!widget || !entryVisibility.visible(widget) || !configuration || configuration.length > 20000 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(configuration)) {
      cpsBookingWidgetsOmitted = true; continue;
    }
    try {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(configuration), character => character.charCodeAt(0))));
      const url = new URL(value.baseURL);
      if (!value || Array.isArray(value) || value.newBookingEngine !== true || url.protocol !== "https:" ||
          !/^[a-z][a-z0-9-]*\.cps\.golf$/u.test(url.hostname) || url.pathname !== "/onlineresweb/search-teetime" ||
          url.search || url.hash || url.username || url.password || url.port ||
          Object.keys(value).some(key => /password|secret|token|cookie|session|credential|authorization|api.?key|email|phone|customer|profile|account/iu.test(key))) { cpsBookingWidgetsOmitted = true; continue; }
      const controls = Array.from(candidate.querySelectorAll("input,textarea,select,button"));
      if (controls.length > 10) { cpsBookingWidgetsOmitted = true; continue; }
      const fields = controls.map(node => ({ name: node.getAttribute("name") ?? "", tag: node.tagName,
        type: node.getAttribute("type") ?? "" }));
      if (fields.some(field => !["course-id", "date", "time", "holes", "players", "submit"].includes(field.name)) ||
          [widget, candidate, ...controls].some(node => node.getAttributeNames().some(name => name.startsWith("on")))) { cpsBookingWidgetsOmitted = true; continue; }
      cpsBookingWidgets.push({ configuration, fields });
    } catch { cpsBookingWidgetsOmitted = true; }
  }
  return { title: document.title.slice(0, 500), headings, linkUrls, addressTexts, phoneTexts, phoneTextsOmitted, contactPhoneLinks, contactPhoneLinksOmitted,
    publicBookingEntryLinks, publicBookingEntryLinksOmitted, cpsBookingWidgets, cpsBookingWidgetsOmitted,
    publicLinkLabels, publicLinkLabelsOmitted, officialContactLinkLabels, officialContactLinkLabelsOmitted,
    brandLinks, publicRentalTexts, publicBusinessLabels, officialContactBusinessNames, namedContactBlocks, namedContactBlocksOmitted, delegatedFrameSources };
}
