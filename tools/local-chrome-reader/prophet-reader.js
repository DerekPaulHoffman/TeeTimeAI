(function initializeProphetReader(root) {
  "use strict";

  const READER_VERSION = "legacy-prophet-rendered-v4";
  const HOSTNAME = "secure.east.prophetservices.com";
  const COURSE_CONFIGS = Object.freeze({
    "frear-park": {
      courseName: "Frear Park Municipal Golf Course",
      jobPath: "/FrearParkV3/Home/NIndex",
      courseIds: "1,2",
      renderedPath:
        /^\/FrearParkV3\/(?:\(S\([A-Za-z0-9_-]{1,128}\)\)\/)?Home\/NIndex(?:\/Home\/nIndex)?\/?$/i,
      title: "Frear Park"
    },
    "simsbury-farms": {
      courseName: "Simsbury Farms Golf Course",
      jobPath: "/SimsburyFarmsV3/Home/NIndex",
      courseIds: "1",
      renderedPath:
        /^\/SimsburyFarmsV3\/(?:\(S\([A-Za-z0-9_-]{1,128}\)\)\/)?(?:Home\/NIndex(?:\/Home\/nIndex)?)?\/?$/i,
      title: "Simsbury Farms"
    }
  });
  const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const CHALLENGE_TEXT =
    /\b(?:just a moment|verify you are human|checking your browser|captcha|turnstile|waiting room)\b/i;

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeQueryDate(value) {
    const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u.exec(value || "");
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function isExpectedQuery(url, job, config) {
    const allowedKeys = new Set(["CourseId", "Date", "Time", "Player", "Hole"]);
    return (
      url.searchParams.size === allowedKeys.size &&
      Array.from(allowedKeys).every((key) => url.searchParams.has(key)) &&
      Array.from(url.searchParams.keys()).every((key) => allowedKeys.has(key)) &&
      url.searchParams.get("CourseId") === config.courseIds &&
      normalizeQueryDate(url.searchParams.get("Date")) === job.targetDate &&
      url.searchParams.get("Time") === "AnyTime" &&
      url.searchParams.get("Player") === String(job.players) &&
      url.searchParams.get("Hole") === "18" &&
      url.hash === ""
    );
  }

  function isAllowedPageUrl(job, value) {
    try {
      const config = COURSE_CONFIGS[job?.courseKey];
      if (
        !config ||
        job.courseName !== config.courseName ||
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
        expected.pathname === config.jobPath &&
        expected.username === "" &&
        expected.password === "" &&
        isExpectedQuery(expected, job, config) &&
        rendered.protocol === "https:" &&
        rendered.hostname === HOSTNAME &&
        config.renderedPath.test(rendered.pathname) &&
        rendered.username === "" &&
        rendered.password === "" &&
        isExpectedQuery(rendered, job, config)
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
    const playerMatch =
      /\b([1-4])\s*(?:to|[-–—/])\s*([1-4])\s+(?:Players?|Golfers?)\b/i.exec(text);
    const explicitHolesMatch = /\b(9|18)\s*Holes?\b/i.exec(text);
    const standaloneHolesMatches = Array.from(
      text.matchAll(/(?<![$\d])\b(9|18)\b(?![:\d])/gu)
    );
    const holesMatch =
      explicitHolesMatch ?? standaloneHolesMatches[standaloneHolesMatches.length - 1] ?? null;
    const priceMatch = /\$(\d{1,4})(?:\.(\d{2}))?\b/u.exec(text);
    const startsAtLocal = timeMatch ? toLocalDateTime(job.targetDate, timeMatch[1]) : null;
    if (!startsAtLocal || !playerMatch || !holesMatch) return null;

    return {
      startsAtLocal,
      timeLabel: timeMatch[1].toUpperCase(),
      holes: [Number(holesMatch[1])],
      minimumPlayers: Number(playerMatch[1]),
      availableSpots: Number(playerMatch[2]),
      priceCents: priceMatch ? Number(priceMatch[1]) * 100 + Number(priceMatch[2] || 0) : null,
      cartIncluded: /\bCart Price Included\b/i.test(text)
    };
  }

  function countRenderedSlots(documentRoot, targetDate) {
    if (displayedDate(documentRoot) !== targetDate) return 0;
    return documentRoot.querySelectorAll(".teeSheet a.teetime, a.teetime").length;
  }

  function readSnapshot(documentRoot, pageUrl, job) {
    const config = COURSE_CONFIGS[job?.courseKey];
    const pageTitle = normalizeText(documentRoot.title);
    if (!config || !isAllowedPageUrl(job, pageUrl)) {
      return result("PAGE_MISMATCH", job, pageTitle, []);
    }
    const bodyText = normalizeText(documentRoot.body?.innerText || documentRoot.body?.textContent);
    if (CHALLENGE_TEXT.test(bodyText)) {
      return result("ACCESS_CHALLENGE", job, pageTitle || "Frear Park access challenge", []);
    }
    if (displayedDate(documentRoot) !== job.targetDate) {
      return result("PAGE_MISMATCH", job, pageTitle, []);
    }

    const cards = Array.from(documentRoot.querySelectorAll(".teeSheet a.teetime, a.teetime"));
    const parsed = cards.map((card) => parseCard(card, job));
    const slots = parsed
      .filter(Boolean)
      .filter(
        (slot) =>
          Number(job.players) >= slot.minimumPlayers && Number(job.players) <= slot.availableSpots
      )
      .sort((left, right) => left.startsAtLocal.localeCompare(right.startsAtLocal));
    const status =
      slots.length > 0
        ? "AVAILABLE"
        : cards.length > 0 && parsed.every((slot) => slot === null)
          ? "READER_ERROR"
          : "NO_AVAILABILITY";
    return result(status, job, pageTitle || config.title, slots);
  }

  function result(status, job, pageTitle, slots) {
    return {
      courseKey: job.courseKey,
      status,
      observedAt: new Date().toISOString(),
      pageUrl: job.bookingUrl,
      pageTitle: pageTitle || COURSE_CONFIGS[job.courseKey]?.title || job.courseName,
      slots,
      readerVersion: READER_VERSION
    };
  }

  root.TeeTimeSpotProphetReader = {
    READER_VERSION,
    SKIP_DATE_SELECTION: true,
    SKIP_PLAYER_SELECTION: true,
    countRenderedSlots,
    isAllowedPageUrl,
    readSnapshot
  };
})(globalThis);
