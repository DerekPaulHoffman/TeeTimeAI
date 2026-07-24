"use strict";

(function startLocalReader() {
  let running = false;

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function targetDateLabel(targetDate) {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: "UTC"
    }).format(new Date(`${targetDate}T12:00:00Z`));
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

    const target = new Date(`${targetDate}T12:00:00Z`);
    const expectedMonth = new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC"
    }).format(target);
    const displayedMonth = document.querySelector(".topbar-title")?.textContent?.trim();
    if (displayedMonth && displayedMonth !== expectedMonth) {
      throw new Error(
        `Target month ${expectedMonth} is not currently displayed (${displayedMonth}).`
      );
    }

    const targetDay = String(target.getUTCDate());
    const dayUnit = Array.from(document.querySelectorAll(".day-unit")).find(
      (element) => visibleDayNumber(element) === targetDay
    );
    const button = dayUnit?.querySelector("button.btn-day-unit, button");
    if (!button || button.disabled) {
      throw new Error(`Target date ${targetDate} is not selectable.`);
    }
    button.click();
  }

  async function waitForTargetPage(targetDate) {
    const expectedLabel = targetDateLabel(targetDate);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (document.querySelector(`time[datetime^="${CSS.escape(targetDate)}T"]`)) {
        return;
      }
      const body = document.body?.innerText || "";
      if (
        body.includes(expectedLabel) &&
        /\b(?:no tee times|no availability|no results)\b/i.test(body)
      ) {
        return;
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
    } catch {
      await chrome.runtime.sendMessage({
        type: "LOCAL_READER_RESULT",
        result: {
          courseKey: "grassy-hill",
          status: "READER_ERROR",
          observedAt: new Date().toISOString(),
          pageUrl: location.href,
          pageTitle: document.title || "Grassy Hill Country Club",
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
