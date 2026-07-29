(function initializeProphetReader(root) {
  "use strict";

  const READER_VERSION = "legacy-prophet-rendered-v1";
  const COURSE_KEY = "frear-park";
  const HOSTNAME = "secure.east.prophetservices.com";
  const JOB_PATH = "/FrearParkV3/Home/NIndex";
  const RENDERED_PATH =
    /^\/FrearParkV3\/(?:\(S\([A-Za-z0-9_-]{1,128}\)\)\/)?Home\/NIndex(?:\/Home\/nIndex)?\/?$/i;
  const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const CHALLENGE_TEXT =
    /\b(?:just a moment|verify you are human|checking your browser|captcha|turnstile|waiting room)\b/i;

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isExpectedQuery(url, job) {
    const allowedKeys = new Set([
      "CourseId",
      "Date",
      "Time",
      "Player",
      "Hole",
    ]);
    return (
      url.searchParams.size === allowedKeys.size &&
      Array.from(allowedKeys).every((key) => url.searchParams.has(key)) &&
      Array.from(url.searchParams.keys()).every((key) =>
        allowedKeys.has(key),
      ) &&
      url.searchParams.get("CourseId") === "1,2" &&
      url.searchParams.get("Date") === job.targetDate &&
      url.searchParams.get("Time") === "AnyTime" &&
      url.searchParams.get("Player") === String(job.players) &&
      url.searchParams.get("Hole") === "18" &&
      url.hash === ""
    );
  }

  function isAllowedPageUrl(job, value) {
    try {
      if (
        job?.courseKey !== COURSE_KEY ||
        job.courseName !== "Frear Park Municipal Golf Course" ||
        !LOCAL_DATE.test(job.targetDate || "") ||
        !Number.isInteger(job.players) ||
        job.players < 1 ||
        job.players > 4 ||
        !Array.isArray(job.cardTextIncludes) ||
        job.cardTextIncludes.length !== 0
      ) {
        return false;
      }
      const expected = new URL(job.bookingUrl);
      const rendered = new URL(value);
      return (
        expected.protocol === "https:" &&
        expected.hostname === HOSTNAME &&
        expected.pathname === JOB_PATH &&
        expected.username === "" &&
        expected.password === "" &&
        isExpectedQuery(expected, job) &&
        rendered.protocol === "https:" &&
        rendered.hostname === HOSTNAME &&
        RENDERED_PATH.test(rendered.pathname) &&
        rendered.username === "" &&
        rendered.password === "" &&
        isExpectedQuery(rendered, job)
      );
    } catch {
      return false;
    }
  }

  function displayedDate(documentRoot) {
    const value =
      documentRoot.querySelector("#txtFromDateLarge")?.value ||
      documentRoot.querySelector("#txtFromDate")?.value ||
      "";
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/u.exec(value);
    return match ? `${match[3]}-${match[1]}-${match[2]}` : null;
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
    const playerMatch = /\b([1-4])\s+to\s+([1-4])\s+Players\b/i.exec(text);
    const holesMatch = /\b(9|18)\s*$/u.exec(text);
    const priceMatch = /\$(\d{1,4})(?:\.(\d{2}))?\b/u.exec(text);
    const startsAtLocal = timeMatch
      ? toLocalDateTime(job.targetDate, timeMatch[1])
      : null;
    if (!startsAtLocal || !playerMatch || !holesMatch) return null;

    return {
      startsAtLocal,
      timeLabel: timeMatch[1].toUpperCase(),
      holes: [Number(holesMatch[1])],
      minimumPlayers: Number(playerMatch[1]),
      availableSpots: Number(playerMatch[2]),
      priceCents: priceMatch
        ? Number(priceMatch[1]) * 100 + Number(priceMatch[2] || 0)
        : null,
      cartIncluded: /\bCart Price Included\b/i.test(text),
    };
  }

  function countRenderedSlots(documentRoot, targetDate) {
    if (displayedDate(documentRoot) !== targetDate) return 0;
    return documentRoot.querySelectorAll(".teeSheet a.teetime, a.teetime")
      .length;
  }

  function readSnapshot(documentRoot, pageUrl, job) {
    const pageTitle = normalizeText(documentRoot.title);
    if (!isAllowedPageUrl(job, pageUrl)) {
      return result("PAGE_MISMATCH", job, pageTitle, []);
    }
    const bodyText = normalizeText(
      documentRoot.body?.innerText || documentRoot.body?.textContent,
    );
    if (CHALLENGE_TEXT.test(bodyText)) {
      return result(
        "ACCESS_CHALLENGE",
        job,
        pageTitle || "Frear Park access challenge",
        [],
      );
    }
    if (displayedDate(documentRoot) !== job.targetDate) {
      return result("PAGE_MISMATCH", job, pageTitle, []);
    }

    const cards = Array.from(
      documentRoot.querySelectorAll(".teeSheet a.teetime, a.teetime"),
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
    return result(status, job, pageTitle || job.courseName, slots);
  }

  function result(status, job, pageTitle, slots) {
    return {
      courseKey: COURSE_KEY,
      status,
      observedAt: new Date().toISOString(),
      pageUrl: job.bookingUrl,
      pageTitle: pageTitle || "Frear Park",
      slots,
      readerVersion: READER_VERSION,
    };
  }

  root.TeeTimeSpotProphetReader = {
    READER_VERSION,
    SKIP_DATE_SELECTION: true,
    SKIP_PLAYER_SELECTION: true,
    countRenderedSlots,
    isAllowedPageUrl,
    readSnapshot,
  };
})(globalThis);
