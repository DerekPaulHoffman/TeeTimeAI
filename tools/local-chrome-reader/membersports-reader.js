(function initializeMemberSportsReader(root) {
  "use strict";

  const READER_VERSION = "membersports-rendered-v1";
  const SKIP_PLAYER_SELECTION = true;
  const COURSE_KEY = /^membersports:([1-9]\d{0,9}):([1-9]\d{0,9})$/u;
  const TEE_TIME_PATH =
    /^\/tee-times\/([1-9]\d{0,9})\/([1-9]\d{0,9})\/(0|[1-9]\d{0,9})(?:\/(0|[1-9]\d{0,9})\/(0|[1-9]\d{0,9}))?\/?$/u;
  const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;
  const TIME_PATTERN = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/iu;
  const CAPACITY_PATTERN = /^([1-4])\s*-\s*([1-4])$/u;
  const PRICE_PATTERN = /^\$(\d{1,4})(?:\.(\d{2}))?$/u;
  const CHALLENGE_TEXT =
    /\b(?:just a moment|verify you are human|checking your browser|captcha|turnstile|waiting room)\b/iu;
  const MONTHS = [
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
      .replace(/\s+/gu, " ")
      .trim();
  }

  function normalizedCourseName(value) {
    return normalizeText(value)
      .toLocaleLowerCase("en-US")
      .replace(/\bgolf course\b/gu, "")
      .replace(/[^a-z0-9]+/gu, " ")
      .trim();
  }

  function readScope(value) {
    try {
      const url = new URL(value);
      const match = TEE_TIME_PATH.exec(url.pathname);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "app.membersports.com" ||
        url.username !== "" ||
        url.password !== "" ||
        url.search !== "" ||
        url.hash !== "" ||
        !match ||
        match.slice(1).some((part) => part && Number(part) > 2_147_483_647)
      ) {
        return null;
      }
      return { clubId: match[1], courseId: match[2] };
    } catch {
      return null;
    }
  }

  function isAllowedPageUrl(job, value) {
    const key = COURSE_KEY.exec(job?.courseKey || "");
    const expected = readScope(job?.bookingUrl || "");
    const actual = readScope(value);
    return Boolean(
      key &&
      expected &&
      actual &&
      key[1] === expected.clubId &&
      key[2] === expected.courseId &&
      key[1] === actual.clubId &&
      key[2] === actual.courseId,
    );
  }

  function displayedDate(documentRoot) {
    const label = normalizeText(
      documentRoot.querySelector(".dateFormat")?.textContent,
    );
    const match =
      /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{4})$/u.exec(
        label,
      );
    if (!match) return null;
    return `${match[3]}-${String(MONTHS.indexOf(match[1]) + 1).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;
  }

  function toLocalDateTime(targetDate, value) {
    const match = TIME_PATTERN.exec(normalizeText(value));
    if (!match) return null;
    let hour = Number(match[1]) % 12;
    if (match[3].toUpperCase() === "PM") hour += 12;
    return `${targetDate}T${String(hour).padStart(2, "0")}:${match[2]}:00`;
  }

  function getCards(documentRoot) {
    return Array.from(
      documentRoot.querySelectorAll(".teeTime .teeTimeCard[role='button']"),
    );
  }

  function countRenderedSlots(documentRoot) {
    return getCards(documentRoot).length;
  }

  function parseCard(card, job) {
    const row = card.closest(".teeTime");
    const startsAtLocal = toLocalDateTime(
      job.targetDate,
      row?.querySelector(".timeCol")?.textContent,
    );
    const visibleCourse = normalizedCourseName(
      card.querySelector(".name")?.textContent,
    );
    const expectedCourse = normalizedCourseName(job.courseName);
    const capacity = CAPACITY_PATTERN.exec(
      normalizeText(card.querySelector(".iconCell.first span")?.textContent),
    );
    const price = PRICE_PATTERN.exec(
      normalizeText(card.querySelector(".amount")?.textContent),
    );
    if (
      !startsAtLocal ||
      !visibleCourse ||
      visibleCourse !== expectedCourse ||
      !capacity ||
      !price
    ) {
      return null;
    }
    return {
      startsAtLocal,
      timeLabel: normalizeText(
        row.querySelector(".timeCol")?.textContent,
      ).toUpperCase(),
      holes: [9, 18],
      minimumPlayers: Number(capacity[1]),
      availableSpots: Number(capacity[2]),
      priceCents: Number(price[1]) * 100 + Number(price[2] || 0),
      cartIncluded: false,
    };
  }

  function result(courseKey, status, pageUrl, pageTitle, slots) {
    return {
      courseKey,
      status,
      observedAt: new Date().toISOString(),
      pageUrl,
      pageTitle: pageTitle || "MemberSports tee times",
      slots,
      readerVersion: READER_VERSION,
    };
  }

  function readSnapshot(documentRoot, pageUrl, job) {
    const pageTitle = normalizeText(documentRoot.title);
    const courseKey = normalizeText(job?.courseKey) || "unknown";
    if (
      !isAllowedPageUrl(job, pageUrl) ||
      !LOCAL_DATE.test(job?.targetDate || "")
    ) {
      return result(courseKey, "PAGE_MISMATCH", pageUrl, pageTitle, []);
    }
    const bodyText = normalizeText(
      documentRoot.body?.innerText || documentRoot.body?.textContent,
    );
    if (CHALLENGE_TEXT.test(bodyText)) {
      return result(courseKey, "ACCESS_CHALLENGE", pageUrl, pageTitle, []);
    }
    if (displayedDate(documentRoot) !== job.targetDate) {
      return result(courseKey, "PAGE_MISMATCH", pageUrl, pageTitle, []);
    }
    const cards = getCards(documentRoot);
    const matchingCards = cards.filter(
      (card) =>
        normalizedCourseName(card.querySelector(".name")?.textContent) ===
        normalizedCourseName(job.courseName),
    );
    const parsed = matchingCards.map((card) => parseCard(card, job));
    const seen = new Set();
    const slots = parsed
      .filter(Boolean)
      .filter(
        (slot) =>
          Number(job.players) >= slot.minimumPlayers &&
          Number(job.players) <= slot.availableSpots,
      )
      .filter((slot) => {
        if (seen.has(slot.startsAtLocal)) return false;
        seen.add(slot.startsAtLocal);
        return true;
      })
      .sort((left, right) =>
        left.startsAtLocal.localeCompare(right.startsAtLocal),
      );
    const status =
      slots.length > 0
        ? "AVAILABLE"
        : matchingCards.length > 0 && parsed.every((slot) => slot === null)
          ? "READER_ERROR"
          : "NO_AVAILABILITY";
    return result(courseKey, status, pageUrl, pageTitle, slots);
  }

  root.TeeTimeSpotMemberSportsReader = {
    READER_VERSION,
    SKIP_PLAYER_SELECTION,
    countRenderedSlots,
    isAllowedPageUrl,
    readSnapshot,
  };
})(globalThis);
