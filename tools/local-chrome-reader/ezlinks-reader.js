(function initializeEzLinksReader(root) {
  "use strict";

  const READER_VERSION = "ezlinks-rendered-v1";
  const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const TENANT_HOSTNAME =
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ezlinksgolf\.com$/;
  const TIME_PATTERN = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i;
  const PLAYERS_PATTERN = /^([1-4])(?:\s*[–-]\s*([1-4]))?\s+Players?$/i;
  const CHALLENGE_TEXT =
    /\b(?:just a moment|verify you are human|checking your browser|performing security verification|security verification|captcha|turnstile|waiting room)\b/i;
  const BLOCKED_TENANTS = new Set([
    "admin",
    "api",
    "auth",
    "blog",
    "careers",
    "config",
    "contact",
    "corporate",
    "dev",
    "help",
    "marketing",
    "shop",
    "store",
    "support",
  ]);

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isSafeTenant(hostname) {
    if (!TENANT_HOSTNAME.test(hostname)) return false;
    return !BLOCKED_TENANTS.has(
      hostname.slice(0, -".ezlinksgolf.com".length),
    );
  }

  function isSearchLanding(url) {
    return (
      url.pathname === "/index.html" &&
      url.search === "" &&
      url.hash === "#!/search"
    );
  }

  function isAllowedPageUrl(job, value) {
    try {
      if (
        !/^ezlinks:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ezlinksgolf\.com$/u.test(
          job?.courseKey || "",
        ) ||
        !LOCAL_DATE.test(job?.targetDate || "")
      ) {
        return false;
      }
      const hostname = job.courseKey.slice("ezlinks:".length);
      const expected = new URL(job.bookingUrl);
      const url = new URL(value);
      return (
        isSafeTenant(hostname) &&
        expected.protocol === "https:" &&
        expected.hostname === hostname &&
        isSearchLanding(expected) &&
        url.protocol === "https:" &&
        url.hostname === hostname &&
        isSearchLanding(url) &&
        url.username === "" &&
        url.password === ""
      );
    } catch {
      return false;
    }
  }

  function parseDisplayedDate(value) {
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(
      normalizeText(value),
    );
    if (!match) return null;
    return `${match[3]}-${String(Number(match[1])).padStart(2, "0")}-${String(
      Number(match[2]),
    ).padStart(2, "0")}`;
  }

  function toLocalDateTime(targetDate, timeLabel) {
    const match = TIME_PATTERN.exec(normalizeText(timeLabel));
    if (!match) return null;
    let hour = Number(match[1]) % 12;
    if (match[3].toUpperCase() === "PM") hour += 12;
    return `${targetDate}T${String(hour).padStart(2, "0")}:${match[2]}:00`;
  }

  function parseCard(card, job) {
    const timeLabel = normalizeText(card.querySelector(".time")?.textContent);
    const startsAtLocal = toLocalDateTime(job.targetDate, timeLabel);
    const players = PLAYERS_PATTERN.exec(
      normalizeText(card.querySelector(".players")?.textContent),
    );
    const price = /\$(\d{1,4})(?:\.(\d{2}))?\b/u.exec(
      normalizeText(card.querySelector(".price")?.textContent),
    );
    const featureText = Array.from(
      card.querySelectorAll("[title], img[alt]"),
    )
      .flatMap((element) => [
        normalizeText(element.getAttribute("title")),
        normalizeText(element.getAttribute("alt")),
      ])
      .filter(Boolean)
      .join(" ");
    const holes = [...featureText.matchAll(/\b(9|18)\s+holes?\b/giu)].map(
      (match) => Number(match[1]),
    );
    if (!startsAtLocal || !players || holes.length === 0) return null;
    return {
      startsAtLocal,
      timeLabel: timeLabel.toUpperCase(),
      holes: [...new Set(holes)].sort((left, right) => left - right),
      minimumPlayers: Number(players[1]),
      availableSpots: Number(players[2] || players[1]),
      priceCents: price
        ? Number(price[1]) * 100 + Number(price[2] || 0)
        : null,
      cartIncluded: /\b(?:include|included)\s+cart\b/i.test(featureText),
    };
  }

  function countRenderedSlots(documentRoot) {
    return documentRoot.querySelectorAll(".tee-time-block > li").length;
  }

  function advertisedSlotCount(documentRoot) {
    const header = normalizeText(
      documentRoot.querySelector(".search-result-data")?.textContent,
    );
    const match = /\b(\d{1,4})\s+tee\s+times?\b/iu.exec(header);
    return match ? Number(match[1]) : null;
  }

  async function prepareRenderedResults(documentRoot, windowRoot = root) {
    const deadline = Date.now() + 10_000;
    let previousCount = -1;
    let unchangedRounds = 0;
    while (Date.now() < deadline) {
      const advertised = advertisedSlotCount(documentRoot);
      const rendered = countRenderedSlots(documentRoot);
      if (advertised === null || rendered >= advertised) return;
      unchangedRounds = rendered === previousCount ? unchangedRounds + 1 : 0;
      if (unchangedRounds >= 4) return;
      previousCount = rendered;
      windowRoot.scrollTo?.(
        0,
        documentRoot.documentElement?.scrollHeight ||
          documentRoot.body?.scrollHeight ||
          0,
      );
      await new Promise((resolve) => windowRoot.setTimeout(resolve, 500));
    }
  }

  function result(courseKey, status, pageUrl, pageTitle, slots) {
    return {
      courseKey,
      status,
      observedAt: new Date().toISOString(),
      pageUrl,
      pageTitle: pageTitle || "EZLinks tee times",
      slots,
      readerVersion: READER_VERSION,
    };
  }

  function readSnapshot(documentRoot, pageUrl, job) {
    const pageTitle = normalizeText(documentRoot.title);
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
        pageTitle || "EZLinks access challenge",
        [],
      );
    }
    const displayedDate = parseDisplayedDate(
      documentRoot.querySelector("#pickerDate")?.value,
    );
    if (displayedDate !== job.targetDate) {
      return result(courseKey, "PAGE_MISMATCH", pageUrl, pageTitle, []);
    }
    const resultHeader = normalizeText(
      documentRoot.querySelector(".search-result-data")?.textContent,
    );
    if (/\bplease wait\.\.\./iu.test(bodyText)) {
      return result(courseKey, "READER_ERROR", pageUrl, pageTitle, []);
    }
    const courseReadout = /\bCourse:\s*(.+)$/iu.exec(resultHeader)?.[1];
    if (
      !courseReadout ||
      normalizeText(courseReadout).toLocaleLowerCase("en-US") !==
        normalizeText(job.courseName).toLocaleLowerCase("en-US")
    ) {
      return result(courseKey, "PAGE_MISMATCH", pageUrl, pageTitle, []);
    }

    const cards = Array.from(
      documentRoot.querySelectorAll(".tee-time-block > li"),
    );
    const advertised = advertisedSlotCount(documentRoot);
    if (advertised !== null && cards.length < advertised) {
      return result(courseKey, "READER_ERROR", pageUrl, pageTitle, []);
    }
    const parsed = cards.map((card) => parseCard(card, job));
    const seen = new Set();
    const slots = parsed
      .filter(Boolean)
      .filter(
        (slot) =>
          Number(job.players) >= slot.minimumPlayers &&
          Number(job.players) <= slot.availableSpots,
      )
      .filter((slot) => {
        const key = `${slot.startsAtLocal}|${slot.holes.join(",")}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((left, right) =>
        left.startsAtLocal.localeCompare(right.startsAtLocal),
      );
    const explicitEmpty =
      /\b0\s+tee\s+times?\b/iu.test(resultHeader) ||
      /\b(?:no tee times|no reservations available|no availability|no results)\b/iu.test(
        bodyText,
      );
    const status =
      slots.length > 0
        ? "AVAILABLE"
        : cards.length > 0 && parsed.every((slot) => slot === null)
          ? "READER_ERROR"
          : cards.length > 0 || explicitEmpty
            ? "NO_AVAILABILITY"
            : "READER_ERROR";
    return result(courseKey, status, pageUrl, pageTitle, slots);
  }

  root.TeeTimeSpotEzLinksReader = {
    READER_VERSION,
    countRenderedSlots,
    isAllowedPageUrl,
    prepareRenderedResults,
    readSnapshot,
  };
})(globalThis);
