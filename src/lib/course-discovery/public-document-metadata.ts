/** Fixed computed-visible metadata read. It performs no form action or network call. */
export function collectNativeOfficialPublicMetadata(expectedVenueName: string) {
  const labels = { name(v: string) { return v.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase().replace(/^welcome to\s+/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\bgolf (?:club|course)$/u, "golf course"); } };
  const expected = labels.name(expectedVenueName);
  const forms = Array.from(document.forms);
  const formRules = { eligible(form: HTMLFormElement) {
    try {
      const action = new URL(form.getAttribute("action") ?? "", document.URL);
      return expected.length >= 8 && forms.length === 1 && form.parentElement === document.body && form.method.toLowerCase() === "post" &&
        action.href === new URL(document.URL).href && Boolean(form.querySelector('footer,[role="contentinfo"]')) &&
        Array.from(form.querySelectorAll("h1,h2")).some(h => {
          if (!(h instanceof HTMLElement) || h.closest('[hidden],[inert],[aria-hidden="true"]') || h.querySelector('input,textarea,select,button,label,[contenteditable]')) return false;
          let node: HTMLElement | null = h, depth = 0;
          while (node && depth++ < 32) { const style = getComputedStyle(node); if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false; node = node.parentElement; }
          const rect = h.getBoundingClientRect(); return !node && rect.width > 0 && rect.height > 0 && labels.name(h.innerText) === expected;
        });
    } catch { return false; }
  } };
  const headings: string[] = [], linkUrls: string[] = [], addressTexts: string[] = [], phoneTexts: string[] = [], publicRentalTexts: string[] = [];
  const brandLinks: Array<{ href: string; text: string }> = [];
  for (const node of Array.from(document.querySelectorAll('h1,h2,a[href],address,p,div,li,td')).slice(0, 3000)) {
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
    if (/^H[12]$/u.test(node.tagName) && value.length <= 300 && headings.length < 80) headings.push(value);
    if (node instanceof HTMLAnchorElement && linkUrls.length < 120) linkUrls.push(node.href);
    if (node instanceof HTMLAnchorElement && !form && value.length <= 200 && brandLinks.length < 20 &&
        [node, node.parentElement].some(v => v?.classList.contains("site-title"))) brandLinks.push({ href: node.href, text: value });
    if (node instanceof HTMLAnchorElement && /^tel:/u.test(node.getAttribute("href") ?? "") && !form && value.length <= 40 && phoneTexts.length < 20) {
      let context: HTMLElement | null = node, publicContact = true;
      while (context) {
        if (/(?:account|member|profile|customer|checkout|payment|billing|corporate|mailing|fax)/iu.test(
          ['id','class','aria-label','title','name'].map(k => context!.getAttribute(k) ?? '').join(' '))) publicContact = false;
        context = context.parentElement;
      }
      if (publicContact) phoneTexts.push(value);
    }
    if (value.length >= 15 && value.length <= 500 && addressTexts.length < 160 && /\b\d{5}(?:-\d{4})?\b/u.test(value)) addressTexts.push(value);
    if (value.length <= 500 && publicRentalTexts.length < 40 && /\bpublic simulator rental\b/iu.test(value) &&
        /\bper bay\b/iu.test(value) && /\b(?:up to|max(?:imum)?(?: of)?)\s+[1-4]\s+(?:golfers|players|people)\b/iu.test(value)) publicRentalTexts.push(value);
  }
  return { title: document.title.slice(0, 500), headings, linkUrls, addressTexts, phoneTexts, brandLinks, publicRentalTexts };
}
