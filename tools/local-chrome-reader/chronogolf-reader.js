(function initializeChronogolfReader(root) {
  "use strict";

  const READER_VERSION = "chronogolf-rendered-v1";
  const PROFILE_PATHS = new Set([
    "/club/crestbrook-park-golf-course",
    "/club/crystal-lake-golf-club-rhode-island-mapleville",
  ]);
  const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const CHALLENGE_TEXT =
    /\b(?:just a moment|verify you are human|checking your browser|captcha|turnstile|waiting room)\b/i;

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isAllowedPageUrl(job, value) {
    try {
      if (!job?.courseKey || !LOCAL_DATE.test(job.targetDate)) return false;
      const expected = new URL(job.bookingUrl);
      const url = new URL(value);
      return (
        expected.protocol === "https:" &&
        expected.hostname === "www.chronogolf.com" &&
        PROFILE_PATHS.has(expected.pathname) &&
        url.protocol === "https:" &&
        url.hostname === expected.hostname &&
        url.pathname === expected.pathname &&
        url.username === "" &&
        url.password === ""
      );
    } catch {
      return false;
    }
  }

  function toLocalDateTime(targetDate, timeLabel) {
    const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(timeLabel);
    if (!match) return null;
    let hour = Number(match[1]) % 12;
    if (match[3].toUpperCase() === "PM") hour += 12;
    return `${targetDate}T${String(hour).padStart(2, "0")}:${match[2]}:00`;
  }

  function parseCard(card, job) {
    const text = normalizeText(card.innerText || card.textContent);
    const timeMatch = /\b(\d{1,2}:\d{2}\s*(?:AM|PM))\b/i.exec(text);
    const startsAtLocal = timeMatch
      ? toLocalDateTime(job.targetDate, timeMatch[1])
      : null;
    const playerText = normalizeText(
      card.querySelector(
        "[title*='player available' i], [title='# of players available']",
      )?.textContent,
    );
    const playersMatch = /^([1-4])(?:\s*-\s*([1-4]))?$/u.exec(playerText);
    const holesText = normalizeText(
      card.querySelector("[title='Hole count']")?.textContent,
    );
    const holes = [...holesText.matchAll(/\b(9|18)\b/gu)].map((match) =>
      Number(match[1]),
    );
    const priceMatch = /\$(\d{1,4})(?:\.(\d{2}))?\b/u.exec(text);
    if (!startsAtLocal || !playersMatch || holes.length === 0) return null;

    return {
      startsAtLocal,
      timeLabel: timeMatch[1].toUpperCase(),
      holes: [...new Set(holes)].sort((left, right) => left - right),
      minimumPlayers: Number(playersMatch[1]),
      availableSpots: Number(playersMatch[2] || playersMatch[1]),
      priceCents: priceMatch
        ? Number(priceMatch[1]) * 100 + Number(priceMatch[2] || 0)
        : null,
      cartIncluded: false,
    };
  }

  function readSnapshot(documentRoot, pageUrl, job) {
    const pageTitle = normalizeText(documentRoot.title);
    const courseName = normalizeText(job?.courseName) || "Chronogolf course";
    const courseKey = normalizeText(job?.courseKey) || "unknown";
    if (!isAllowedPageUrl(job, pageUrl)) {
      return result(courseKey, "PAGE_MISMATCH", pageUrl, pageTitle, []);
    }
    const bodyText = normalizeText(
      documentRoot.body?.innerText || documentRoot.body?.textContent,
    );
    if (CHALLENGE_TEXT.test(bodyText)) {
      return result(
        courseKey,
        "ACCESS_CHALLENGE",
        pageUrl,
        pageTitle || `${courseName} access challenge`,
        [],
      );
    }

    const cards = Array.from(
      documentRoot.querySelectorAll(
        "[data-testid='teeTimeCard'][role='button']",
      ),
    );
    const parsed = cards.map((card) => parseCard(card, job));
    const slots = parsed
      .filter(Boolean)
      .filter(
        (slot) =>
          Number(job.players) >= slot.minimumPlayers &&
          Number(job.players) <= slot.availableSpots,
      )
      .sort((left, right) =>
        left.startsAtLocal.localeCompare(right.startsAtLocal),
      );
    const status =
      slots.length > 0
        ? "AVAILABLE"
        : cards.length > 0 && parsed.every((slot) => slot === null)
          ? "READER_ERROR"
          : "NO_AVAILABILITY";
    return result(courseKey, status, pageUrl, pageTitle || courseName, slots);
  }

  function result(courseKey, status, pageUrl, pageTitle, slots) {
    return {
      courseKey,
      status,
      observedAt: new Date().toISOString(),
      pageUrl,
      pageTitle: pageTitle || "Unknown page",
      slots,
      readerVersion: READER_VERSION,
    };
  }

  root.TeeTimeSpotChronogolfReader = {
    READER_VERSION,
    isAllowedPageUrl,
    readSnapshot,
  };
})(globalThis);
