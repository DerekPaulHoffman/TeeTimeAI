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
    "December"
  ];

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function targetDateLabel(targetDate) {
    const [year, month, day] = targetDate.split("-").map(Number);
    return `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
  }

  function visibleDayNumber(element) {
    const visible = element.querySelector(
      ".day-background-upper[aria-hidden='false']"
    );
    return (visible?.textContent || element.textContent || "").trim();
  }

  async function chooseTargetDate(targetDate) {
    if (document.querySelector(`time[datetime^="${CSS.escape(targetDate)}T"]`)) {
      return;
    }

    if (!document.querySelector(".day-unit")) {
      const dateControl =
        document.querySelector("input[readonly]") ||
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
      if (displayedMonth && displayedMonth !== expectedMonth) {
        throw new Error(
          `Target month ${expectedMonth} is not currently displayed (${displayedMonth}).`
        );
      }

      const dayUnit = Array.from(document.querySelectorAll(".day-unit")).find(
        (element) => visibleDayNumber(element) === targetDay
      );
      const button = dayUnit?.querySelector("button.btn-day-unit, button");
      if (
        button &&
        button.disabled !== true &&
        button.getAttribute("aria-disabled") !== "true"
      ) {
        button.click();
        return;
      }
      await delay(250);
    }
    throw new Error(`Target date ${targetDate} did not become selectable.`);
  }

  async function waitForTargetPage(targetDate) {
    const expectedLabel = targetDateLabel(targetDate);
    const deadline = Date.now() + 20_000;
    let slotCount = 0;
    let slotsStableSince = null;
    let emptyStableSince = null;
    while (Date.now() < deadline) {
      const now = Date.now();
      const currentSlotCount = document.querySelectorAll(
        `button.btn-teesheet time[datetime^="${CSS.escape(targetDate)}T"]`
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
      if (
        body.includes(expectedLabel) &&
        /\b(?:no tee times|no availability|no results)\b/i.test(body)
      ) {
        emptyStableSince ??= now;
        if (now - emptyStableSince >= 5_000) return;
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
    const tabId = String((await chrome.runtime.sendMessage({
      type: "LOCAL_READER_IDENTIFY_TAB"
    }).catch(() => null))?.tabId || "");
    const entries = Object.entries(stored.pendingJobs || {});
    const pending =
      (tabId && stored.pendingJobs?.[tabId]) ||
      (entries.length === 1 ? entries[0][1] : null);
    if (!pending?.job || pending.job.courseKey !== "grassy-hill") return;

    running = true;
    try {
      await chooseTargetDate(pending.job.targetDate);
      await waitForTargetPage(pending.job.targetDate);
      const snapshot = globalThis.TeeTimeSpotGrassyHillReader.readSnapshot(
        document,
        location.href
      );
      await chrome.runtime.sendMessage({
        type: "LOCAL_READER_RESULT",
        result: snapshot
      });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : String(error || "Unknown error");
      await chrome.runtime.sendMessage({
        type: "LOCAL_READER_RESULT",
        result: {
          courseKey: "grassy-hill",
          status: "READER_ERROR",
          observedAt: new Date().toISOString(),
          pageUrl: location.href,
          pageTitle: `Reader error: ${detail}`.slice(0, 200),
          slots: [],
          readerVersion:
            globalThis.TeeTimeSpotGrassyHillReader?.READER_VERSION ||
            "grassy-hill-rendered-v1"
        }
      });
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "LOCAL_READER_WAKE") void readPendingJob();
  });
  void readPendingJob();
})();
