"use strict";

// This reader only observes course information and link destinations. It never
// activates a booking control. The worker owns navigation and the signed job.
globalThis.TeeTimeOfficialSourceReader = (() => {
  const ORIGIN = "https://parks.cityofomaha.org";
  const normalize = (value) => String(value || "").normalize("NFKC")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const nameCore = (value) => normalize(value)
    .replace(/\b(?:9|18|nine|eighteen)\s*holes?\b/gu, " ")
    .replace(/golf|\bgc\b|\bcourse\b|\bclub\b/gu, " ")
    .replace(/\s+/gu, " ").trim();

  function sourceUrl(value) {
    try {
      const url = new URL(value);
      if (url.origin !== ORIGIN || url.username || url.password || url.search ||
        url.hash || !/^\/[a-z0-9/-]*$/u.test(url.pathname) ||
        /(?:login|signin|account|checkout|reserve|payment|captcha|challenge)/iu.test(url.pathname)) return null;
      return url.href;
    } catch { return null; }
  }

  function bookingUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.book\.teeitup\.(?:com|golf)$/u.test(url.hostname) ||
        url.pathname !== "/" || [...url.searchParams.keys()].some(key => key !== "course") ||
        url.searchParams.getAll("course").length > 1 ||
        (url.searchParams.has("course") && !/^[1-9]\d*(?:,[1-9]\d*){0,19}$/u.test(url.searchParams.get("course")))) return null;
      return url.href;
    } catch { return null; }
  }

  function visible(node) {
    if (!node || node.closest("[hidden], [aria-hidden='true'], script, style, template, noscript")) return false;
    const view = node.ownerDocument?.defaultView;
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = view?.getComputedStyle(parent);
      if (style?.display === "none" || style?.visibility === "hidden") return false;
    }
    return true;
  }

  function pageText(document) {
    // innerText omits hidden content in Chrome. The fallback is for DOM-only
    // fixtures, and still removes hidden/script content before inspecting text.
    if (typeof document.body?.innerText === "string") return document.body.innerText;
    const clone = document.body?.cloneNode(true);
    if (!clone) return "";
    clone.querySelectorAll("script,style,template,noscript,[hidden],[aria-hidden='true']")
      .forEach(node => node.remove());
    const walker = document.createTreeWalker(clone, 4);
    const parts = [];
    while (walker.nextNode()) parts.push(walker.currentNode.textContent || "");
    return parts.join(" ");
  }

  function readPage(document, pageUrl, expected) {
    const url = sourceUrl(pageUrl);
    if (!url) throw new Error("Official source origin or route is not allowed");
    const raw = pageText(document);
    const text = ` ${normalize(raw)} `;
    const blocked = /\b(?:access denied|verify you are human|checking your browser|just a moment|security verification|sign in to continue|log in to continue)\b/iu.test(raw);
    if (blocked || [...document.querySelectorAll('iframe[src*="challenges.cloudflare"],input[type="password"]')].some(visible)) {
      return { pageUrl: url, status: "ACCESS_RESTRICTED", courseName: null,
        street: null, city: null, stateCode: null, bookingLinks: [], nextUrls: [] };
    }
    const core = nameCore(expected.name);
    if (!core) throw new Error("Official source course identity is missing");
    const names = [...document.querySelectorAll("h1,h2,h3")].filter(visible)
      .map(node => (node.innerText || node.textContent || "").replace(/\s+/gu, " ").trim())
      .filter(name => name.length <= 160 && nameCore(name) === core);
    const uniqueNames = [...new Set(names)];
    const observed = (value) => {
      const key = normalize(value);
      return key && text.includes(` ${key} `) ? key : null;
    };
    const street = observed(expected.address.split(",")[0]);
    const city = observed(expected.city);
    const stateCode = observed(expected.stateCode);
    const courseName = uniqueNames.length === 1 ? uniqueNames[0] : null;
    const bookingLinks = [];
    const nextUrls = [];
    for (const link of [...document.querySelectorAll("a[href]")].filter(visible)) {
      let href;
      try { href = new URL(link.getAttribute("href"), pageUrl).href; }
      catch { continue; }
      const label = (link.innerText || link.textContent || link.getAttribute("aria-label") ||
        link.querySelector("img")?.getAttribute("alt") || "").replace(/\s+/gu, " ").trim();
      const booking = bookingUrl(href);
      if (courseName && street && city && stateCode && booking && /\b(?:book|reserve|tee\s*times?)\b/iu.test(label)) {
        // Persist a category, never arbitrary link text or query parameters.
        bookingLinks.push({ url: booking, label: "Book tee time" });
      }
      const next = sourceUrl(href);
      // Name the destination explicitly; never follow a directory's generic
      // Learn More control by inheriting another row's course identity.
      if (next && next !== url && nameCore(label) === core) nextUrls.push(next);
    }
    return {
      pageUrl: url, status: "OBSERVED", courseName, street, city, stateCode,
      bookingLinks: [...new Map(bookingLinks.map(link => [link.url, link])).values()].slice(0, 20),
      nextUrls: [...new Set(nextUrls)].slice(0, 12),
    };
  }

  return Object.freeze({ sourceUrl, bookingUrl, readPage });
})();
