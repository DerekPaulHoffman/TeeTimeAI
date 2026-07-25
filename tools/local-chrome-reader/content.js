"use strict";

(function startLocalReader() {
  let running = false;
  const MONTH_NAMES = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const MONTH_INDEX = Object.fromEntries(
    MONTH_NAMES.map((month, index) => [month.toLowerCase(), index + 1]),
  );
  const CHALLENGE_TEXT =
    /\b(?:just a moment|verify you are human|checking your browser|captcha|turnstile|waiting room)\b/i;

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function targetDateLabel(targetDate) {
    const [year, month, day] = targetDate.split("-").map(Number);
    return `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function parseDisplayedDate(value) {
    const normalized = String(value || "")
      .replace(/\s+/g, " ")
      .trim();
    const numeric = /\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/u.exec(normalized);
    if (numeric) {
      const year =
        numeric[3].length === 2
          ? 2000 + Number(numeric[3])
          : Number(numeric[3]);
      return `${year}-${pad(Number(numeric[1]))}-${pad(Number(numeric[2]))}`;
    }
    const written =
      /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/iu.exec(
        normalized,
      );
    if (!written) return null;
    return `${written[3]}-${pad(MONTH_INDEX[written[1].toLowerCase()])}-${pad(
      Number(written[2]),
    )}`;
  }

  function getDisplayedDate() {
    const renderedSlot = document.querySelector("time[datetime]");
    const renderedDate = renderedSlot
      ?.getAttribute("datetime")
      ?.match(/^\d{4}-\d{2}-\d{2}/u)?.[0];
    if (renderedDate) return renderedDate;

    for (const input of document.querySelectorAll("input")) {
      const parsed = parseDisplayedDate(input.value);
      if (parsed) return parsed;
    }
    const bodyText =
      document.body?.innerText || document.body?.textContent || "";
    return parseDisplayedDate(bodyText);
  }

  function findDateStepButton(direction) {
    const expectedText =
      direction > 0
        ? new Set([">", "arrow_forward", "chevron_right"])
        : new Set(["<", "arrow_back", "chevron_left"]);
    const expectedLabel =
      direction > 0 ? /\bnext\b/i : /\bprevious\b|\bprev\b/i;
    return Array.from(document.querySelectorAll("button")).find((button) => {
      const text = String(button.innerText || button.textContent || "").trim();
      const ariaLabel = button.getAttribute("aria-label") || "";
      return (
        expectedText.has(text) ||
        expectedLabel.test(ariaLabel) ||
        (direction > 0
          ? button.querySelector(".fa-chevron-right, .bi-chevron-right")
          : button.querySelector(".fa-chevron-left, .bi-chevron-left"))
      );
    });
  }

  function visibleDayNumber(element) {
    const dayNumbers = element.querySelectorAll(".day-background-upper");
    const visible = element.querySelector(
      ".day-background-upper[aria-hidden='false']",
    );
    if (dayNumbers.length > 0) return (visible?.textContent || "").trim();
    return (element.textContent || "").trim();
  }

  async function chooseWithDateArrows(targetDate) {
    let displayedDate = getDisplayedDate();
    if (!displayedDate) return false;
    for (
      let attempt = 0;
      attempt < 62 && displayedDate !== targetDate;
      attempt += 1
    ) {
      const direction = displayedDate < targetDate ? 1 : -1;
      const button = findDateStepButton(direction);
      if (
        !button ||
        button.disabled === true ||
        button.getAttribute("aria-disabled") === "true"
      ) {
        return false;
      }
      button.click();
      const previousDate = displayedDate;
      const changeDeadline = Date.now() + 3_000;
      while (Date.now() < changeDeadline) {
        await delay(100);
        displayedDate = getDisplayedDate();
        if (displayedDate && displayedDate !== previousDate) break;
      }
      if (!displayedDate || displayedDate === previousDate) return false;
    }
    return displayedDate === targetDate;
  }

  async function chooseWithCalendar(targetDate) {
    if (!document.querySelector(".day-unit")) {
      const dateControl =
        Array.from(document.querySelectorAll("input")).find((input) =>
          parseDisplayedDate(input.value),
        ) ||
        document.querySelector(".date-picker input") ||
        document.querySelector("button[aria-label*='date' i]");
      dateControl?.click();
      await delay(500);
    }

    const [targetYear, targetMonth, targetDayNumber] = targetDate
      .split("-")
      .map(Number);
    const expectedMonth = `${MONTH_NAMES[targetMonth - 1]} ${targetYear}`;
    const targetDay = String(targetDayNumber);
    const selectionDeadline = Date.now() + 10_000;
    while (Date.now() < selectionDeadline) {
      const displayedMonth = document
        .querySelector(".topbar-title")
        ?.textContent?.trim();
      if (displayedMonth && displayedMonth !== expectedMonth) return false;

      const dayUnit = Array.from(document.querySelectorAll(".day-unit")).find(
        (element) => visibleDayNumber(element) === targetDay,
      );
      const button = dayUnit?.querySelector("button.btn-day-unit, button");
      if (
        button &&
        button.disabled !== true &&
        button.getAttribute("aria-disabled") !== "true"
      ) {
        button.click();
        return true;
      }
      await delay(250);
    }
    return false;
  }

  async function chooseTargetDate(targetDate) {
    try {
      const currentUrl = new URL(location.href);
      if (
        currentUrl.hostname === "www.chronogolf.com" &&
        currentUrl.searchParams.get("date") === targetDate
      ) {
        return;
      }
    } catch {
      // Continue with the rendered date controls.
    }
    if (
      document.querySelector(`time[datetime^="${CSS.escape(targetDate)}T"]`)
    ) {
      return;
    }
    if (getDisplayedDate() === targetDate) return;
    if (await chooseWithDateArrows(targetDate)) return;
    if (await chooseWithCalendar(targetDate)) return;
    throw new Error(`Target date ${targetDate} did not become selectable.`);
  }

  function matchesCourseText(value, expectedValues) {
    const normalized = String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    return expectedValues.some((expected) =>
      normalized.includes(String(expected).trim().toLowerCase()),
    );
  }

  async function chooseCourse(job) {
    const expectedValues = Array.isArray(job.cardTextIncludes)
      ? job.cardTextIncludes
      : [];
    if (expectedValues.length === 0) return;

    const selectedControl = Array.from(
      document.querySelectorAll("select, [role='combobox'], mat-select"),
    ).find((control) =>
      matchesCourseText(
        control instanceof HTMLSelectElement
          ? control.selectedOptions[0]?.textContent
          : control.textContent,
        expectedValues,
      ),
    );
    if (selectedControl) return;

    for (const select of document.querySelectorAll("select")) {
      const option = Array.from(select.options).find((candidate) =>
        matchesCourseText(candidate.textContent, expectedValues),
      );
      if (!option) continue;
      select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await delay(1_000);
      return;
    }

    const courseControl = Array.from(
      document.querySelectorAll(
        "[role='combobox'], mat-select, .mat-select-trigger, .ng-select-container",
      ),
    ).find(
      (control) =>
        /\bcourse\b/i.test(control.getAttribute("aria-label") || "") ||
        /\bcourse\b/i.test(
          control.closest("label, form, section, aside")?.textContent || "",
        ),
    );
    courseControl?.click();
    if (courseControl) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const option = Array.from(
          document.querySelectorAll(
            "[role='option'], mat-option, .mat-option, .ng-option",
          ),
        ).find((candidate) =>
          matchesCourseText(candidate.textContent, expectedValues),
        );
        if (option) {
          option.click();
          await delay(1_000);
          return;
        }
        await delay(100);
      }
    }
    throw new Error(`Course ${job.courseName} did not become selectable.`);
  }

  async function choosePlayers(players) {
    const button = Array.from(
      document.querySelectorAll(
        "button.mat-button-toggle-button[name='fontStyle']",
      ),
    ).find(
      (candidate) =>
        String(candidate.textContent || "").trim() === String(players),
    );
    if (button) {
      if (button.getAttribute("aria-pressed") !== "true") {
        button.click();
        await delay(500);
      }
      return;
    }

    const expectedLabel = `${players} ${players === 1 ? "player" : "players"}`;
    const radio = Array.from(
      document.querySelectorAll("input[type='radio'], [role='radio']"),
    ).find((candidate) =>
      String(
        candidate.getAttribute("aria-label") ||
          candidate.closest("label")?.textContent ||
          document.querySelector(`label[for="${candidate.id}"]`)?.textContent ||
          "",
      )
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
        .includes(expectedLabel),
    );
    if (!radio)
      throw new Error(`Group size ${players} did not become selectable.`);
    if (
      radio.getAttribute("aria-checked") !== "true" &&
      radio.checked !== true
    ) {
      radio.click();
      await delay(1_000);
    }
  }

  async function waitForTargetPage(targetDate) {
    const expectedLabel = targetDateLabel(targetDate);
    const deadline = Date.now() + 25_000;
    let slotCount = 0;
    let slotsStableSince = null;
    let emptyStableSince = null;
    while (Date.now() < deadline) {
      const now = Date.now();
      const currentSlotCount = document.querySelectorAll(
        `time[datetime^="${CSS.escape(targetDate)}T"], [data-testid='teeTimeCard'][role='button']`,
      ).length;
      if (currentSlotCount > 0) {
        if (currentSlotCount !== slotCount) {
          slotCount = currentSlotCount;
          slotsStableSince = now;
        } else if (slotsStableSince !== null && now - slotsStableSince >= 750) {
          return;
        }
      } else {
        slotCount = 0;
        slotsStableSince = null;
      }
      const body = document.body?.innerText || "";
      if (CHALLENGE_TEXT.test(body)) {
        throw new Error("The public page displayed an access challenge.");
      }
      const targetDateVisible =
        body.includes(expectedLabel) || getDisplayedDate() === targetDate;
      if (
        targetDateVisible &&
        /\b(?:no tee times|no availability|no results)\b/i.test(body)
      ) {
        emptyStableSince ??= now;
        if (now - emptyStableSince >= 5_000) return;
      } else if (targetDateVisible && currentSlotCount === 0) {
        emptyStableSince ??= now;
        if (now - emptyStableSince >= 8_000) return;
      } else {
        emptyStableSince = null;
      }
      await delay(250);
    }
    throw new Error(`The public page did not render ${targetDate} in time.`);
  }

  async function readPendingJob() {
    if (running) return;
    const stored = await chrome.storage.local.get("pendingJobs");
    const tabId = String(
      (
        await chrome.runtime
          .sendMessage({ type: "LOCAL_READER_IDENTIFY_TAB" })
          .catch(() => null)
      )?.tabId || "",
    );
    const entries = Object.entries(stored.pendingJobs || {});
    const pending =
      (tabId && stored.pendingJobs?.[tabId]) ||
      (entries.length === 1 ? entries[0][1] : null);
    const reader = [
      globalThis.TeeTimeSpotCpsReader,
      globalThis.TeeTimeSpotChronogolfReader,
    ].find((candidate) =>
      candidate?.isAllowedPageUrl(pending?.job, location.href),
    );
    if (!pending?.job || !reader) {
      return;
    }

    running = true;
    try {
      await chooseCourse(pending.job);
      await choosePlayers(pending.job.players);
      await chooseTargetDate(pending.job.targetDate);
      await waitForTargetPage(pending.job.targetDate);
      const snapshot = reader.readSnapshot(
        document,
        location.href,
        pending.job,
      );
      await chrome.runtime.sendMessage({
        type: "LOCAL_READER_RESULT",
        result: snapshot,
      });
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : String(error || "Unknown error");
      const body = document.body?.innerText || "";
      const status = CHALLENGE_TEXT.test(body)
        ? "ACCESS_CHALLENGE"
        : location.pathname.includes("/auth/")
          ? "PAGE_MISMATCH"
          : "READER_ERROR";
      await chrome.runtime.sendMessage({
        type: "LOCAL_READER_RESULT",
        result: {
          courseKey: pending.job.courseKey,
          status,
          observedAt: new Date().toISOString(),
          pageUrl: location.href,
          pageTitle: `Reader error: ${detail}`.slice(0, 200),
          slots: [],
          readerVersion: reader?.READER_VERSION || "rendered-reader-v1",
        },
      });
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "LOCAL_READER_WAKE") void readPendingJob();
  });
  void readPendingJob();
})();
