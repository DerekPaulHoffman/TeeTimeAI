(function initializeTenForeReader(root) {
  "use strict";

  const READER_VERSION = "tenfore-rendered-v1";
  const SKIP_PLAYER_SELECTION = true;
  const TENANT_PATH = /^\/([a-z0-9][a-z0-9-]{0,127})\/?$/;
  const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_PATTERN = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i;
  const CAPACITY_PATTERN = /^([1-4])(?:\s*-\s*([1-4]))?$/;
  const CHALLENGE_TEXT =
    /\b(?:just a moment|verify you are human|checking your browser|captcha|turnstile|waiting room)\b/i;
  const MONTH_SHORT = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isAllowedPageUrl(job, value) {
    try {
      if (
        !/^tenfore:[a-z0-9][a-z0-9-]{0,127}$/u.test(job?.courseKey || "") ||
        !LOCAL_DATE.test(job?.targetDate || "")
      ) {
        return false;
      }
      const expectedTenant = job.courseKey.slice("tenfore:".length);
      const expected = new URL(job.bookingUrl);
      const url = new URL(value);
      return (
        expected.protocol === "https:" &&
        expected.hostname === "fox.tenfore.golf" &&
        TENANT_PATH.exec(expected.pathname)?.[1] === expectedTenant &&
        expected.searchParams.get("date") === job.targetDate &&
        Array.from(expected.searchParams.keys()).every((key) => key === "date") &&
        url.protocol === "https:" &&
        url.hostname === expected.hostname &&
        TENANT_PATH.exec(url.pathname)?.[1] === expectedTenant &&
        url.searchParams.get("date") === job.targetDate &&
        Array.from(url.searchParams.keys()).every((key) => key === "date") &&
        url.username === "" &&
        url.password === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  }

  function targetDateLabel(targetDate) {
    const [year, month, day] = targetDate.split("-").map(Number);
    return `${MONTH_SHORT[month - 1]} ${day}, ${year}`;
  }

  function toLocalDateTime(targetDate, timeLabel) {
    const match = TIME_PATTERN.exec(normalizeText(timeLabel));
    if (!match) return null;
    let hour = Number(match[1]) % 12;
    if (match[3].toUpperCase() === "PM") hour += 12;
    return `${targetDate}T${String(hour).padStart(2, "0")}:${match[2]}:00`;
  }

  function findCard(timeElement) {
    const knownCard = timeElement.closest(
      ".bg-white.text-xl.font-medium.leading-none",
    );
    if (knownCard) return knownCard;

    let candidate = timeElement.parentElement;
    for (let depth = 0; candidate && depth < 6; depth += 1) {
      const text = normalizeText(candidate.textContent || candidate.innerText);
      if (/\bOnline Booking\b/i.test(text) && text.length < 500) {
        return candidate;
      }
      candidate = candidate.parentElement;
    }
    return null;
  }

  function parseCard(timeElement, job) {
    const timeLabel = normalizeText(timeElement.textContent);
    const startsAtLocal = toLocalDateTime(job.targetDate, timeLabel);
    const card = findCard(timeElement);
    if (!startsAtLocal || !card) return null;

    const lines = Array.from(card.querySelectorAll("*"))
      .filter((element) => element.children.length === 0)
      .map((element) => normalizeText(element.textContent))
      .filter(Boolean);
    const timeIndex = lines.findIndex((line) => TIME_PATTERN.test(line));
    const details = timeIndex >= 0 ? lines.slice(timeIndex + 1) : lines;
    const holesIndex = details.findIndex(
      (line) => line === "9" || line === "18",
    );
    const capacityLine = details
      .slice(holesIndex >= 0 ? holesIndex + 1 : 0)
      .find((line) => CAPACITY_PATTERN.test(line));
    const capacity = capacityLine
      ? CAPACITY_PATTERN.exec(capacityLine)
      : null;
    const price = details
      .map((line) => /^\$(\d{1,4})(?:\.(\d{2}))?$/u.exec(line))
      .find(Boolean);
    if (holesIndex < 0 || !capacity) return null;

    return {
      startsAtLocal,
      timeLabel: timeLabel.toUpperCase(),
      holes: [Number(details[holesIndex])],
      minimumPlayers: Number(capacity[1]),
      availableSpots: Number(capacity[2] || capacity[1]),
      priceCents: price
        ? Number(price[1]) * 100 + Number(price[2] || 0)
        : null,
      cartIncluded: false,
    };
  }

  function getTimeElements(documentRoot) {
    const preferred = Array.from(
      documentRoot.querySelectorAll(".text-2xl.font-bold"),
    ).filter((element) => TIME_PATTERN.test(normalizeText(element.textContent)));
    if (preferred.length > 0) return preferred;
    return Array.from(documentRoot.querySelectorAll("body *")).filter(
      (element) =>
        element.children.length === 0 &&
        TIME_PATTERN.test(normalizeText(element.textContent)),
    );
  }

  function countRenderedSlots(documentRoot) {
    return getTimeElements(documentRoot).length;
  }

  function result(courseKey, status, pageUrl, pageTitle, slots) {
    return {
      courseKey,
      status,
      observedAt: new Date().toISOString(),
      pageUrl,
      pageTitle: pageTitle || "TenFore tee times",
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
      documentRoot.body?.textContent || documentRoot.body?.innerText,
    );
    if (CHALLENGE_TEXT.test(bodyText)) {
      return result(
        courseKey,
        "ACCESS_CHALLENGE",
        pageUrl,
        pageTitle || "TenFore access challenge",
        [],
      );
    }

    const displayedDate = normalizeText(
      documentRoot.querySelector(
        ".filter-section[data-filter-key='selectedDate'] .filter-value",
      )?.textContent,
    );
    if (displayedDate !== targetDateLabel(job.targetDate)) {
      return result(courseKey, "PAGE_MISMATCH", pageUrl, pageTitle, []);
    }

    const timeElements = getTimeElements(documentRoot);
    const cards = timeElements.filter((element) => findCard(element));
    const parsed = cards.map((element) => parseCard(element, job));
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
    const status =
      slots.length > 0
        ? "AVAILABLE"
        : (cards.length > 0 && parsed.every((slot) => slot === null)) ||
            (timeElements.length > 0 && cards.length === 0)
          ? "READER_ERROR"
          : "NO_AVAILABILITY";
    return result(courseKey, status, pageUrl, pageTitle, slots);
  }

  root.TeeTimeSpotTenForeReader = {
    READER_VERSION,
    SKIP_PLAYER_SELECTION,
    countRenderedSlots,
    isAllowedPageUrl,
    readSnapshot,
  };
})(globalThis);
