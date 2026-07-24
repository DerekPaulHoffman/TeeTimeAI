(function initializeGrassyHillReader(root) {
  "use strict";

  const READER_VERSION = "grassy-hill-rendered-v1";
  const ALLOWED_HOST = "grassyhill.cps.golf";
  const ALLOWED_PATH = /^\/onlineresweb\/search-teetime\/?$/;
  const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
  const CHALLENGE_TEXT =
    /\b(?:just a moment|verify you are human|checking your browser|captcha|turnstile|waiting room)\b/i;

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isAllowedPageUrl(value) {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname === ALLOWED_HOST &&
        ALLOWED_PATH.test(url.pathname) &&
        url.username === "" &&
        url.password === ""
      );
    } catch {
      return false;
    }
  }

  function timeLabelFromLocalDateTime(value) {
    const hours24 = Number(value.slice(11, 13));
    const minutes = value.slice(14, 16);
    const suffix = hours24 >= 12 ? "PM" : "AM";
    const hours12 = hours24 % 12 || 12;
    return `${hours12}:${minutes} ${suffix}`;
  }

  function parseCard(timeElement) {
    const startsAtLocal = normalizeText(timeElement.getAttribute("datetime"));
    if (!LOCAL_DATE_TIME.test(startsAtLocal)) return null;

    const card = timeElement.closest("button.btn-teesheet");
    if (!card) return null;
    const text = normalizeText(card.innerText || card.textContent);
    const holesMatch = /\b(9|18)(?:\s+or\s+(9|18))?\s+HOLES\b/i.exec(text);
    const golfersMatch = /\b([1-4])\s*-\s*([1-4])\s+GOLFERS\b/i.exec(text);
    const priceMatch = /\$(\d{1,4})(?:\.(\d{2}))?\b/.exec(text);
    if (!holesMatch || !golfersMatch) return null;

    const holes = [Number(holesMatch[1])];
    if (holesMatch[2] && Number(holesMatch[2]) !== holes[0]) {
      holes.push(Number(holesMatch[2]));
    }

    return {
      startsAtLocal,
      timeLabel: timeLabelFromLocalDateTime(startsAtLocal),
      holes: holes.sort((left, right) => left - right),
      minimumPlayers: Number(golfersMatch[1]),
      availableSpots: Number(golfersMatch[2]),
      priceCents: priceMatch
        ? Number(priceMatch[1]) * 100 + Number(priceMatch[2] || 0)
        : null,
      cartIncluded: /\bCART INCLUDED\b/i.test(text)
    };
  }

  function readSnapshot(documentRoot, pageUrl) {
    const pageTitle = normalizeText(documentRoot.title);
    if (!isAllowedPageUrl(pageUrl)) {
      return {
        courseKey: "grassy-hill",
        status: "PAGE_MISMATCH",
        observedAt: new Date().toISOString(),
        pageUrl,
        pageTitle: pageTitle || "Unknown page",
        slots: [],
        readerVersion: READER_VERSION
      };
    }

    const bodyText = normalizeText(documentRoot.body?.innerText || documentRoot.body?.textContent);
    if (CHALLENGE_TEXT.test(bodyText)) {
      return {
        courseKey: "grassy-hill",
        status: "ACCESS_CHALLENGE",
        observedAt: new Date().toISOString(),
        pageUrl,
        pageTitle: pageTitle || "Grassy Hill access challenge",
        slots: [],
        readerVersion: READER_VERSION
      };
    }

    const seen = new Set();
    const slots = [];
    for (const timeElement of documentRoot.querySelectorAll("button.btn-teesheet time[datetime]")) {
      const slot = parseCard(timeElement);
      if (!slot) continue;
      const key = `${slot.startsAtLocal}|${slot.holes.join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      slots.push(slot);
    }
    slots.sort((left, right) => left.startsAtLocal.localeCompare(right.startsAtLocal));

    return {
      courseKey: "grassy-hill",
      status: slots.length > 0 ? "AVAILABLE" : "NO_AVAILABILITY",
      observedAt: new Date().toISOString(),
      pageUrl,
      pageTitle: pageTitle || "Grassy Hill Country Club",
      slots,
      readerVersion: READER_VERSION
    };
  }

  root.TeeTimeSpotGrassyHillReader = {
    READER_VERSION,
    isAllowedPageUrl,
    readSnapshot
  };
})(globalThis);
