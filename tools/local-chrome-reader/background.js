"use strict";

const DEFAULT_BACKEND_ORIGIN = "https://teetimespot.com";
const POLL_ALARM = "tee-time-spot-local-reader-poll";
const POLL_PERIOD_MINUTES = 1;
let pollInProgress = false;

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))
    )
  );
}

async function getSettings() {
  const settings = await chrome.storage.local.get([
    "enabled",
    "backendOrigin",
    "deviceId",
    "deviceToken"
  ]);
  return {
    enabled: settings.enabled === true,
    backendOrigin: settings.backendOrigin || DEFAULT_BACKEND_ORIGIN,
    deviceId: settings.deviceId || "",
    deviceToken: (settings.deviceToken || "").replace(/^\uFEFF/u, "").trim()
  };
}

async function signedFetch(path, options = {}) {
  const settings = await getSettings();
  const method = options.method || "GET";
  const body = options.body || "";
  const timestamp = String(Date.now());
  const signature = await hmacHex(
    settings.deviceToken,
    `${method}\n${path}\n${timestamp}\n${body}`
  );
  return fetch(`${settings.backendOrigin}${path}`, {
    method,
    body: body || undefined,
    headers: {
      "content-type": "application/json",
      "x-local-reader-timestamp": timestamp,
      "x-local-reader-signature": signature,
      ...(options.leaseToken
        ? { "x-local-reader-lease": options.leaseToken }
        : {})
    },
    cache: "no-store"
  });
}

async function setLastStatus(status, detail) {
  await chrome.storage.local.set({
    lastStatus: status,
    lastDetail: detail,
    lastStatusAt: new Date().toISOString()
  });
}

async function pendingJobs() {
  const stored = await chrome.storage.local.get("pendingJobs");
  return stored.pendingJobs || {};
}

async function savePendingJobs(jobs) {
  await chrome.storage.local.set({ pendingJobs: jobs });
}

async function cleanStalePendingJobs(jobs) {
  const now = Date.now();
  let changed = false;
  for (const [tabId, pending] of Object.entries(jobs)) {
    const openedAt = Date.parse(pending.openedAt || "");
    const expiresAt = Date.parse(pending.job?.expiresAt || "");
    let tabExists = true;
    try {
      await chrome.tabs.get(Number(tabId));
    } catch {
      tabExists = false;
    }
    if (
      !tabExists ||
      (Number.isFinite(openedAt) && openedAt + 2 * 60_000 <= now) ||
      (Number.isFinite(expiresAt) && expiresAt <= now)
    ) {
      delete jobs[tabId];
      changed = true;
      if (tabExists) await closePendingTab(Number(tabId));
    }
  }
  if (changed) await savePendingJobs(jobs);
}

async function closePendingTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // The operator may already have closed the worker-created tab.
  }
}

async function finishJob(tabId, result) {
  const jobs = await pendingJobs();
  const pending = jobs[String(tabId)];
  if (!pending) return;
  delete jobs[String(tabId)];
  await savePendingJobs(jobs);

  try {
    const body = JSON.stringify({ ...result, jobId: pending.job.id });
    const path = `/api/local-reader/jobs/${encodeURIComponent(pending.job.id)}/result`;
    const response = await signedFetch(path, {
      method: "POST",
      body,
      leaseToken: pending.job.leaseToken
    });
    if (!response.ok) {
      throw new Error(`Result API returned ${response.status}`);
    }
    const resultDetail =
      result.status === "AVAILABLE" || result.status === "NO_AVAILABILITY"
        ? `${pending.job.courseKey} ${pending.job.targetDate}: ${result.slots.length} slots`
        : `${pending.job.courseKey} ${pending.job.targetDate}: ${result.pageTitle}`;
    await setLastStatus(
      result.status === "AVAILABLE" || result.status === "NO_AVAILABILITY"
        ? "COMPLETED"
        : result.status,
      resultDetail
    );
  } catch (error) {
    await setLastStatus(
      "RESULT_FAILED",
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    await closePendingTab(tabId);
  }
}

async function poll() {
  if (pollInProgress) return;
  pollInProgress = true;
  try {
    const settings = await getSettings();
    if (
      !settings.enabled ||
      !settings.deviceId ||
      settings.deviceToken.length < 16
    ) {
      return;
    }
    const jobs = await pendingJobs();
    await cleanStalePendingJobs(jobs);
    if (Object.keys(jobs).length > 0) return;

    const path = `/api/local-reader/jobs/next?deviceId=${encodeURIComponent(settings.deviceId)}`;
    const response = await signedFetch(path);
    if (!response.ok) {
      throw new Error(`Job API returned ${response.status}`);
    }
    const payload = await response.json();
    if (!payload.job) {
      await setLastStatus("IDLE", "No reader job is waiting.");
      return;
    }
    if (payload.job.courseKey !== "grassy-hill") {
      throw new Error("The backend returned a non-allowlisted course.");
    }
    const tab = await chrome.tabs.create({
      url: payload.job.bookingUrl,
      active: false
    });
    if (!tab.id) throw new Error("Chrome did not create a worker tab.");
    jobs[String(tab.id)] = { job: payload.job, openedAt: new Date().toISOString() };
    await savePendingJobs(jobs);
    await setLastStatus(
      "READING",
      `${payload.job.courseKey} ${payload.job.targetDate}`
    );
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "LOCAL_READER_WAKE" });
    } catch {
      // The content script also starts itself when the page finishes loading.
    }
  } catch (error) {
    await setLastStatus(
      "POLL_FAILED",
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    pollInProgress = false;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await chrome.storage.local.get([
    "backendOrigin",
    "deviceId",
    "enabled"
  ]);
  await chrome.storage.local.set({
    backendOrigin: settings.backendOrigin || DEFAULT_BACKEND_ORIGIN,
    deviceId: settings.deviceId || `chrome-${crypto.randomUUID()}`,
    enabled: settings.enabled === true
  });
  await chrome.alarms.create(POLL_ALARM, {
    delayInMinutes: 0.1,
    periodInMinutes: POLL_PERIOD_MINUTES
  });
  await chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create(POLL_ALARM, {
    delayInMinutes: 0.1,
    periodInMinutes: POLL_PERIOD_MINUTES
  });
  await poll();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) void poll();
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "LOCAL_READER_IDENTIFY_TAB") {
    return Promise.resolve({ tabId: sender.tab?.id || null });
  }
  if (message?.type === "LOCAL_READER_RESULT" && sender.tab?.id) {
    void finishJob(sender.tab.id, message.result);
  }
  if (message?.type === "LOCAL_READER_POLL_NOW") {
    void poll();
  }
});
