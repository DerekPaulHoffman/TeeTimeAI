(function initializeWebTracReader(root) {
  "use strict";

  const READER_VERSION = "webtrac-rendered-v1";
  const TENANT_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myvscloud\.com$/;
  const SEARCH_PATH = /^\/webtrac\/web\/search\.html\/?$/;
  const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const CHALLENGE_TEXT =
    /\b(?:just a moment|verify you are human|checking your browser|captcha|turnstile|waiting room)\b/i;

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function expectedDateLabel(targetDate) {
    const [year, month, day] = String(targetDate || "").split("-");
    return `${month}/${day}/${year}`;
  }

  function hasExactJobQuery(url, job) {
    const allowedKeys = new Set([
      "Action",
      "begindate",
      "begintime",
      "display",
      "grwebsearch_buttonsearch",
      "module",
      "numberofplayers",
      "page",
      "search"
    ]);
    return (
      url.searchParams.size === allowedKeys.size &&
      Array.from(allowedKeys).every((key) => url.searchParams.has(key)) &&
      Array.from(url.searchParams.keys()).every((key) => allowedKeys.has(key)) &&
      url.searchParams.get("Action") === "Start" &&
      url.searchParams.get("begindate") === expectedDateLabel(job.targetDate) &&
      url.searchParams.get("begintime") === "12:00 am" &&
      url.searchParams.get("display") === "Detail" &&
      url.searchParams.get("grwebsearch_buttonsearch") === "yes" &&
      url.searchParams.get("module") === "GR" &&
      url.searchParams.get("numberofplayers") === String(job.players) &&
      url.searchParams.get("page") === "1" &&
      url.searchParams.get("search") === "yes"
    );
  }

  function isAllowedPageUrl(job, value) {
    try {
      if (
        !/^webtrac:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myvscloud\.com$/.test(
          job?.courseKey || ""
        ) ||
        !LOCAL_DATE.test(job.targetDate || "") ||
        !Number.isInteger(job.players) ||
        job.players < 1 ||
        job.players > 4 ||
        !Array.isArray(job.cardTextIncludes) ||
        job.cardTextIncludes.length !== 0
      ) {
        return false;
      }
      const hostname = job.courseKey.slice("webtrac:".length);
      const expected = new URL(job.bookingUrl);
      const rendered = new URL(value);
      return (
        TENANT_HOSTNAME.test(hostname) &&
        expected.protocol === "https:" &&
        expected.hostname === hostname &&
        SEARCH_PATH.test(expected.pathname) &&
        expected.username === "" &&
        expected.password === "" &&
        expected.hash === "" &&
        hasExactJobQuery(expected, job) &&
        rendered.protocol === "https:" &&
        rendered.hostname === hostname &&
        SEARCH_PATH.test(rendered.pathname) &&
        rendered.username === "" &&
        rendered.password === "" &&
        rendered.hash === "" &&
        hasExactJobQuery(rendered, job)
      );
    } catch {
      return false;
    }
  }

  function cellText(row, title) {
    const cell = Array.from(row.querySelectorAll("td")).find(
      (candidate) =>
        normalizeText(candidate.getAttribute("data-title")).toLowerCase() === title.toLowerCase()
    );
    return normalizeText(cell?.innerText || cell?.textContent);
  }

  function toLocalDateTime(targetDate, timeLabel) {
    const match = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(timeLabel);
    if (!match) return null;
    let hour = Number(match[1]) % 12;
    if (match[3].toLowerCase() === "pm") hour += 12;
    return `${targetDate}T${String(hour).padStart(2, "0")}:${match[2]}:00`;
  }

  function parseRow(row, job) {
    if (cellText(row, "Date") !== expectedDateLabel(job.targetDate)) return null;
    const timeLabel = cellText(row, "Time");
    const startsAtLocal = toLocalDateTime(job.targetDate, timeLabel);
    const openSlots = Number.parseInt(cellText(row, "Open Slots"), 10);
    const holesMatch = /\b(9|18)\b/u.exec(cellText(row, "Holes"));
    if (
      !startsAtLocal ||
      !Number.isInteger(openSlots) ||
      openSlots < 1 ||
      openSlots > 4 ||
      !holesMatch
    ) {
      return null;
    }
    return {
      startsAtLocal,
      timeLabel: normalizeText(timeLabel).toUpperCase(),
      holes: [Number(holesMatch[1])],
      minimumPlayers: 1,
      availableSpots: openSlots,
      priceCents: null,
      cartIncluded: false
    };
  }

  function rowsForTargetDate(documentRoot, targetDate) {
    const label = expectedDateLabel(targetDate);
    return Array.from(documentRoot.querySelectorAll("table tr")).filter(
      (row) => cellText(row, "Date") === label
    );
  }

  function countRenderedSlots(documentRoot, targetDate) {
    return rowsForTargetDate(documentRoot, targetDate).length;
  }

  function readSnapshot(documentRoot, pageUrl, job) {
    const pageTitle = normalizeText(documentRoot.title);
    const result = (status, slots) => ({
      courseKey: job.courseKey,
      status,
      observedAt: new Date().toISOString(),
      pageUrl: job.bookingUrl,
      pageTitle: pageTitle || job.courseName,
      slots,
      readerVersion: READER_VERSION
    });
    if (!isAllowedPageUrl(job, pageUrl)) {
      return result("PAGE_MISMATCH", []);
    }
    const bodyText = normalizeText(documentRoot.body?.innerText || documentRoot.body?.textContent);
    if (CHALLENGE_TEXT.test(bodyText)) {
      return result("ACCESS_CHALLENGE", []);
    }

    const rows = rowsForTargetDate(documentRoot, job.targetDate);
    const parsed = rows.map((row) => parseRow(row, job));
    const slots = parsed
      .filter(Boolean)
      .filter((slot) => Number(job.players) <= slot.availableSpots)
      .sort((left, right) => left.startsAtLocal.localeCompare(right.startsAtLocal));
    if (slots.length > 0) return result("AVAILABLE", slots);
    if (rows.length > 0 && parsed.every((slot) => slot === null)) {
      return result("READER_ERROR", []);
    }
    if (bodyText.includes(expectedDateLabel(job.targetDate)) || rows.length > 0) {
      return result("NO_AVAILABILITY", []);
    }
    return result("PAGE_MISMATCH", []);
  }

  root.TeeTimeSpotWebTracReader = {
    READER_VERSION,
    SKIP_DATE_SELECTION: true,
    SKIP_PLAYER_SELECTION: true,
    countRenderedSlots,
    isAllowedPageUrl,
    readSnapshot
  };
})(globalThis);
