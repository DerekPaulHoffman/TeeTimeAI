(function initializeCpsReader(root) {
  "use strict";

  const READER_VERSION = "cps-rendered-v1";
  const ALLOWED_PATH = /^\/onlineresweb\/search-teetime\/?$/;
  const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
  const CHALLENGE_TEXT =
    /\b(?:just a moment|verify you are human|checking your browser|captcha|turnstile|waiting room)\b/i;

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isAllowedPageUrl(job, value) {
    try {
      if (!job?.courseKey || !Array.isArray(job.cardTextIncludes)) return false;
      const expected = new URL(job.bookingUrl);
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname === expected.hostname &&
        url.hostname.endsWith(".cps.golf") &&
        ALLOWED_PATH.test(url.pathname) &&
        url.username === "" &&
        url.password === "" &&
        expected.protocol === "https:" &&
        ALLOWED_PATH.test(expected.pathname) &&
        expected.username === "" &&
        expected.password === ""
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

  function findCard(timeElement) {
    const modernCard = timeElement.closest("button.btn-teesheet");
    if (modernCard) return modernCard;
    const legacyCard = timeElement.closest(".mat-card");
    if (legacyCard) return legacyCard;

    let candidate = timeElement.parentElement;
    for (let depth = 0; candidate && depth < 7; depth += 1) {
      const text = normalizeText(candidate.innerText || candidate.textContent);
      if (
        /\b(?:9|18)(?:\s+or\s+(?:9|18))?\s+HOLES\b/i.test(text) &&
        /\b[1-4](?:\s*-\s*[1-4])?\s+GOLFERS\b/i.test(text) &&
        text.length < 700
      ) {
        return candidate;
      }
      candidate = candidate.parentElement;
    }
    return null;
  }

  function cardMatchesCourse(cardText, cardTextIncludes) {
    if (cardTextIncludes.length === 0) return true;
    const normalized = normalizeText(cardText).toLocaleLowerCase("en-US");
    return cardTextIncludes.some((value) =>
      normalized.includes(normalizeText(value).toLocaleLowerCase("en-US")),
    );
  }

  function parseCard(timeElement, cardTextIncludes) {
    const startsAtLocal = normalizeText(timeElement.getAttribute("datetime"));
    if (!LOCAL_DATE_TIME.test(startsAtLocal)) return null;

    const card = findCard(timeElement);
    if (!card) return null;
    const text = normalizeText(card.innerText || card.textContent);
    if (!cardMatchesCourse(text, cardTextIncludes)) return null;
    const holesMatch = /\b(9|18)(?:\s+or\s+(9|18))?\s+HOLES\b/i.exec(text);
    const golfersMatch = /\b([1-4])(?:\s*-\s*([1-4]))?\s+GOLFERS\b/i.exec(text);
    const priceMatches = [...text.matchAll(/\$(\d{1,4})(?:\.(\d{2}))?\b/g)];
    const priceMatch = priceMatches.at(-1);
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
      availableSpots: Number(golfersMatch[2] || golfersMatch[1]),
      priceCents: priceMatch
        ? Number(priceMatch[1]) * 100 + Number(priceMatch[2] || 0)
        : null,
      cartIncluded: /\bCART INCLUDED\b/i.test(text),
    };
  }

  function readSnapshot(documentRoot, pageUrl, job) {
    const pageTitle = normalizeText(documentRoot.title);
    const courseName = normalizeText(job?.courseName) || "CPS golf course";
    const courseKey = normalizeText(job?.courseKey) || "unknown";
    const cardTextIncludes = Array.isArray(job?.cardTextIncludes)
      ? job.cardTextIncludes
      : [];
    if (!isAllowedPageUrl(job, pageUrl)) {
      return {
        courseKey,
        status: "PAGE_MISMATCH",
        observedAt: new Date().toISOString(),
        pageUrl,
        pageTitle: pageTitle || "Unknown page",
        slots: [],
        readerVersion: READER_VERSION,
      };
    }

    const bodyText = normalizeText(
      documentRoot.body?.innerText || documentRoot.body?.textContent,
    );
    if (CHALLENGE_TEXT.test(bodyText)) {
      return {
        courseKey,
        status: "ACCESS_CHALLENGE",
        observedAt: new Date().toISOString(),
        pageUrl,
        pageTitle: pageTitle || `${courseName} access challenge`,
        slots: [],
        readerVersion: READER_VERSION,
      };
    }

    const seen = new Set();
    const slots = [];
    const timeElements = documentRoot.querySelectorAll("time[datetime]");
    let matchingCardCount = 0;
    let candidateCardCount = 0;
    let parsedCardCount = 0;
    for (const timeElement of timeElements) {
      const card = findCard(timeElement);
      if (!card) continue;
      const cardText = normalizeText(card.innerText || card.textContent);
      if (
        /\b(?:9|18)(?:\s+or\s+(?:9|18))?\s+HOLES\b/i.test(cardText) &&
        /\b[1-4](?:\s*-\s*[1-4])?\s+GOLFERS\b/i.test(cardText)
      ) {
        candidateCardCount += 1;
        if (cardMatchesCourse(cardText, cardTextIncludes)) {
          matchingCardCount += 1;
        }
      }
      const slot = parseCard(timeElement, cardTextIncludes);
      if (!slot) continue;
      parsedCardCount += 1;
      if (
        Number(job.players) < slot.minimumPlayers ||
        Number(job.players) > slot.availableSpots
      ) {
        continue;
      }
      const key = `${slot.startsAtLocal}|${slot.holes.join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      slots.push(slot);
    }
    slots.sort((left, right) =>
      left.startsAtLocal.localeCompare(right.startsAtLocal),
    );
    return {
      courseKey,
      status:
        slots.length > 0
          ? "AVAILABLE"
          : (matchingCardCount > 0 && parsedCardCount === 0) ||
              (candidateCardCount === 0 &&
                documentRoot.querySelectorAll("button.btn-teesheet, .mat-card")
                  .length > 0)
            ? "READER_ERROR"
            : "NO_AVAILABILITY",
      observedAt: new Date().toISOString(),
      pageUrl,
      pageTitle: pageTitle || courseName,
      slots,
      readerVersion: READER_VERSION,
    };
  }

  root.TeeTimeSpotCpsReader = {
    READER_VERSION,
    isAllowedPageUrl,
    readSnapshot,
  };
})(globalThis);
