(function initializeTeeItUpReader(root) {
  "use strict";

  const READER_VERSION = "teeitup-rendered-v1";
  const COURSE_KEY =
    /^teeitup:([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.book\.teeitup\.(?:com|golf)):(root|[1-9]\d{0,9})$/u;
  const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;
  const CHALLENGE_TEXT =
    /\b(?:just a moment|verify you are human|checking your browser|security verification|captcha|turnstile|waiting room)\b/i;
  const EMPTY_TEXT = /\b(?:no tee times available|no tee times|no results)\b/i;

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeCourseName(value) {
    const primaryName = normalizeText(value).split(/\s+:\s+/u)[0];
    return primaryName
      .toLowerCase()
      .replace(/&/gu, " and ")
      .replace(/\b(?:18|9)\s*-?\s*hole\b/gu, " ")
      .replace(/\b(?:golf|course|club)\b/gu, " ")
      .replace(/[^a-z0-9]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  }

  function getScope(value) {
    try {
      const url = new URL(value);
      const allowedKeys = new Set(["course", "date", "max"]);
      const entries = [...url.searchParams.entries()];
      const keys = new Set(entries.map(([key]) => key));
      const courseId = url.searchParams.get("course");
      const date = url.searchParams.get("date");
      const max = url.searchParams.get("max");
      if (
        url.protocol !== "https:" ||
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.book\.teeitup\.(?:com|golf)$/u.test(
          url.hostname,
        ) ||
        url.pathname !== "/" ||
        url.username !== "" ||
        url.password !== "" ||
        url.hash !== "" ||
        keys.size !== entries.length ||
        entries.some(([key]) => !allowedKeys.has(key)) ||
        (courseId &&
          (!/^[1-9]\d{0,9}$/u.test(courseId) ||
            Number(courseId) > 2_147_483_647)) ||
        (date && !LOCAL_DATE.test(date)) ||
        (max && max !== "999999")
      ) {
        return null;
      }
      return { hostname: url.hostname, courseId, date };
    } catch {
      return null;
    }
  }

  function isAllowedPageUrl(job, value) {
    const keyMatch = COURSE_KEY.exec(job?.courseKey || "");
    const expected = getScope(job?.bookingUrl || "");
    const observed = getScope(value);
    if (
      !keyMatch ||
      !LOCAL_DATE.test(job?.targetDate || "") ||
      !expected ||
      !observed
    ) {
      return false;
    }
    const expectedCourse = keyMatch[2];
    return (
      expected.hostname === keyMatch[1] &&
      observed.hostname === keyMatch[1] &&
      observed.date === job.targetDate &&
      (expectedCourse === "root" || observed.courseId === expectedCourse)
    );
  }

  function toLocalDateTime(targetDate, timeLabel) {
    const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/iu.exec(
      normalizeText(timeLabel),
    );
    if (!match) return null;
    let hour = Number(match[1]) % 12;
    if (match[3].toUpperCase() === "PM") hour += 12;
    return `${targetDate}T${String(hour).padStart(2, "0")}:${match[2]}:00`;
  }

  function findCard(button) {
    let current = button;
    for (let depth = 0; current && depth < 8; depth += 1) {
      if (
        current.querySelector?.("[data-testid='teetimes-tile-time']") &&
        current.querySelector?.("[data-testid='teetimes-tile-course-name']")
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function parsePlayers(value) {
    const text = normalizeText(value)
      .replace(/\bplayers?\b/giu, "")
      .trim();
    const match = /^([1-4])(?:\s*(?:-|or|to)\s*([1-4]))?$/iu.exec(text);
    if (!match) return null;
    const minimumPlayers = Number(match[1]);
    const availableSpots = Number(match[2] || match[1]);
    if (availableSpots < minimumPlayers) return null;
    return { minimumPlayers, availableSpots };
  }

  function parseCard(button, job) {
    const card = findCard(button);
    if (!card) return null;
    const timeLabel = normalizeText(
      card.querySelector("[data-testid='teetimes-tile-time']")?.textContent,
    );
    const players = parsePlayers(
      card.querySelector("[data-testid='teetimes-tile-available-players']")
        ?.textContent,
    );
    const holesText = normalizeText(
      card.querySelector("[data-testid='teetimes-tile-hole-verbiage']")
        ?.textContent,
    );
    const courseName = normalizeText(
      card.querySelector("[data-testid='teetimes-tile-course-name']")
        ?.textContent,
    );
    const holes = [...holesText.matchAll(/\b(9|18)\b/gu)].map((match) =>
      Number(match[1]),
    );
    const startsAtLocal = toLocalDateTime(job.targetDate, timeLabel);
    const expectedCourse = normalizeCourseName(job.courseName);
    const observedCourse = normalizeCourseName(courseName);
    const ariaLabel = normalizeText(button.getAttribute("aria-label"));
    const priceMatch =
      /minimum price\s*-?\s*\$(\d{1,4})(?:\.(\d{2}))?\b/iu.exec(ariaLabel);
    if (
      !startsAtLocal ||
      !players ||
      holes.length === 0 ||
      !expectedCourse ||
      observedCourse !== expectedCourse ||
      !priceMatch
    ) {
      return null;
    }
    return {
      startsAtLocal,
      timeLabel: timeLabel.toUpperCase(),
      holes: [...new Set(holes)].sort((left, right) => left - right),
      minimumPlayers: players.minimumPlayers,
      availableSpots: players.availableSpots,
      priceCents: Number(priceMatch[1]) * 100 + Number(priceMatch[2] || 0),
      cartIncluded: false,
    };
  }

  function countRenderedSlots(documentRoot, targetDate) {
    const pageUrl = documentRoot.location?.href || "";
    const scope = getScope(pageUrl);
    if (!scope || scope.date !== targetDate) return 0;
    return documentRoot.querySelectorAll(
      "[data-testid='teetimes_choose_rate_button']",
    ).length;
  }

  function readSnapshot(documentRoot, pageUrl, job) {
    const pageTitle = normalizeText(documentRoot.title);
    const courseName = normalizeText(job?.courseName) || "TeeItUp course";
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
    const buttons = Array.from(
      documentRoot.querySelectorAll(
        "[data-testid='teetimes_choose_rate_button']",
      ),
    );
    const parsed = buttons.map((button) => parseCard(button, job));
    if (parsed.some((slot) => slot === null)) {
      return result(
        courseKey,
        "READER_ERROR",
        pageUrl,
        pageTitle || courseName,
        [],
      );
    }
    const slots = parsed
      .filter(
        (slot) =>
          Number(job.players) >= slot.minimumPlayers &&
          Number(job.players) <= slot.availableSpots,
      )
      .sort((left, right) =>
        left.startsAtLocal.localeCompare(right.startsAtLocal),
      );
    if (slots.length > 0) {
      return result(
        courseKey,
        "AVAILABLE",
        pageUrl,
        pageTitle || courseName,
        slots,
      );
    }
    if (buttons.length > 0 || EMPTY_TEXT.test(bodyText)) {
      return result(
        courseKey,
        "NO_AVAILABILITY",
        pageUrl,
        pageTitle || courseName,
        [],
      );
    }
    return result(
      courseKey,
      "READER_ERROR",
      pageUrl,
      pageTitle || courseName,
      [],
    );
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

  root.TeeTimeSpotTeeItUpReader = {
    READER_VERSION,
    SKIP_DATE_SELECTION: true,
    SKIP_PLAYER_SELECTION: true,
    countRenderedSlots,
    isAllowedPageUrl,
    readSnapshot,
  };
})(globalThis);
