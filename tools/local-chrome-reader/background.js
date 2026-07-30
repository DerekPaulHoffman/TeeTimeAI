"use strict";

const DEFAULT_BACKEND_ORIGIN = "https://teetimespot.com";
const POLL_ALARM = "tee-time-spot-local-reader-poll";
const POLL_PERIOD_MINUTES = 1;
const READER_CAPABILITIES = Object.freeze([
  ["CPS_RENDERED", 1],
  ["CHRONOGOLF_RENDERED", 1],
  ["TENFORE_RENDERED", 1],
  ["PROPHET_FREAR_RENDERED", 4]
]);
const ALLOWED_COURSES = Object.freeze({
  "grassy-hill": [
    "Grassy Hill Country Club",
    "grassyhill.cps.golf",
    "/onlineresweb/search-teetime",
    []
  ],
  overpeck: ["Overpeck Golf Course", "overpeckgc.cps.golf", "/onlineresweb/search-teetime", []],
  "glen-mills": [
    "The Golf Course at Glen Mills",
    "golfatglenmills.cps.golf",
    "/onlineresweb/search-teetime",
    []
  ],
  "bayberry-hills": [
    "Bayberry Hills Golf Course",
    "yarmouthpublic.cps.golf",
    "/onlineresweb/search-teetime",
    []
  ],
  "oak-lane": [
    "The Tradition Golf Club at Oak Lane",
    "traditionoaklane.cps.golf",
    "/onlineresweb/search-teetime",
    []
  ],
  "candia-woods": [
    "Candia Woods Golf Links",
    "candiawoods.cps.golf",
    "/onlineresweb/search-teetime",
    []
  ],
  "oxford-greens": [
    "The Golf Club at Oxford Greens",
    "oxfordgreens.cps.golf",
    "/onlineresweb/search-teetime",
    []
  ],
  shennecossett: [
    "Shennecossett Golf Course",
    "shennecossett.cps.golf",
    "/onlineresweb/search-teetime",
    []
  ],
  stanley: ["Stanley Golf Course SGC", "stanleygolf.cps.golf", "/onlineresweb/search-teetime", []],
  colonie: ["Colonie Golf Course", "colonie.cps.golf", "/onlineresweb/search-teetime", []],
  "springfield-township": [
    "Springfield Twp Golf Course",
    "springfield.cps.golf",
    "/onlineresweb/search-teetime",
    []
  ],
  "pine-hollow": [
    "Pine Hollow Golf Club",
    "pinehollow.cps.golf",
    "/onlineresweb/search-teetime",
    []
  ],
  "capital-hills": [
    "Capital Hills at Albany",
    "capitalhillsny.cps.golf",
    "/onlineresweb/search-teetime",
    []
  ],
  crestbrook: [
    "Crestbrook Golf Course",
    "www.chronogolf.com",
    "/club/crestbrook-park-golf-course",
    []
  ],
  "crystal-lake": [
    "crystal lake golf",
    "www.chronogolf.com",
    "/club/crystal-lake-golf-club-rhode-island-mapleville",
    []
  ],
  chanticlair: ["Chanticlair Golf Course", "www.chronogolf.com", "/club/chanticlair-golf-club", []],
  "lyman-orchards": [
    "Lyman Orchards Golf Club",
    "www.chronogolf.com",
    "/club/lyman-orchards-golf-club",
    []
  ],
  "hyde-park": ["Hyde Park Golf Club", "www.chronogolf.com", "/club/hyde-park-golf-club", []],
  "frear-park": [
    "Frear Park Municipal Golf Course",
    "secure.east.prophetservices.com",
    "/FrearParkV3/Home/NIndex",
    []
  ],
  "simsbury-farms": [
    "Simsbury Farms Golf Course",
    "secure.east.prophetservices.com",
    "/SimsburyFarmsV3",
    []
  ]
});
const PROPHET_COURSES = Object.freeze({
  "frear-park": ["Frear Park Municipal Golf Course", "/FrearParkV3/Home/NIndex", "1,2"],
  "simsbury-farms": ["Simsbury Farms Golf Course", "/SimsburyFarmsV3", "1"]
});
let pollInProgress = false;

function isAllowlistedCpsJob(job) {
  try {
    if (
      !/^cps:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cps\.golf$/u.test(job?.courseKey || "") ||
      typeof job.courseName !== "string" ||
      job.courseName.trim().length === 0 ||
      job.courseName.length > 160 ||
      !Array.isArray(job.cardTextIncludes) ||
      job.cardTextIncludes.length !== 0
    ) {
      return false;
    }
    const hostname = job.courseKey.slice("cps:".length);
    const url = new URL(job.bookingUrl);
    return (
      url.protocol === "https:" &&
      url.hostname === hostname &&
      /^\/onlineresweb\/search-teetime\/?$/u.test(url.pathname) &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function isAllowlistedTenForeJob(job) {
  try {
    if (
      !/^tenfore:[a-z0-9][a-z0-9-]{0,127}$/u.test(job?.courseKey || "") ||
      typeof job.courseName !== "string" ||
      job.courseName.trim().length === 0 ||
      job.courseName.length > 160 ||
      !Array.isArray(job.cardTextIncludes) ||
      job.cardTextIncludes.length !== 0 ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(job.targetDate || "")
    ) {
      return false;
    }
    const tenant = job.courseKey.slice("tenfore:".length);
    const url = new URL(job.bookingUrl);
    return (
      url.protocol === "https:" &&
      url.hostname === "fox.tenfore.golf" &&
      url.pathname === `/${tenant}` &&
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

function isAllowlistedChronogolfJob(job) {
  try {
    if (
      !/^chronogolf:[a-z0-9][a-z0-9-]{0,127}$/u.test(job?.courseKey || "") ||
      typeof job.courseName !== "string" ||
      job.courseName.trim().length === 0 ||
      job.courseName.length > 160 ||
      !Array.isArray(job.cardTextIncludes) ||
      job.cardTextIncludes.length !== 0 ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(job.targetDate || "")
    ) {
      return false;
    }
    const slug = job.courseKey.slice("chronogolf:".length);
    const url = new URL(job.bookingUrl);
    return (
      url.protocol === "https:" &&
      url.hostname === "www.chronogolf.com" &&
      url.pathname === `/club/${slug}` &&
      url.searchParams.get("date") === job.targetDate &&
      url.searchParams.get("step") === "teetimes" &&
      Array.from(url.searchParams.keys()).every((key) => ["date", "step"].includes(key)) &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function isAllowlistedProphetJob(job) {
  try {
    const config = PROPHET_COURSES[job?.courseKey];
    if (
      !config ||
      job.courseName !== config[0] ||
      !Array.isArray(job.cardTextIncludes) ||
      job.cardTextIncludes.length !== 0 ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(job.targetDate || "") ||
      !Number.isInteger(job.players) ||
      job.players < 1 ||
      job.players > 4
    ) {
      return false;
    }
    const url = new URL(job.bookingUrl);
    const allowedKeys = new Set(["CourseId", "Date", "Time", "Player", "Hole"]);
    return (
      url.protocol === "https:" &&
      url.hostname === "secure.east.prophetservices.com" &&
      url.pathname === config[1] &&
      url.searchParams.size === allowedKeys.size &&
      Array.from(allowedKeys).every((key) => url.searchParams.has(key)) &&
      Array.from(url.searchParams.keys()).every((key) => allowedKeys.has(key)) &&
      url.searchParams.get("CourseId") === config[2] &&
      url.searchParams.get("Date") === job.targetDate &&
      url.searchParams.get("Time") === "AnyTime" &&
      url.searchParams.get("Player") === String(job.players) &&
      url.searchParams.get("Hole") === "18" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function isAllowlistedJob(job) {
  try {
    const required = job?.requiredCapability;
    if (
      !required ||
      typeof required.key !== "string" ||
      !Number.isInteger(required.parserVersion) ||
      !READER_CAPABILITIES.some(
        ([key, parserVersion]) => key === required.key && parserVersion >= required.parserVersion
      )
    ) {
      return false;
    }
    if (isAllowlistedCpsJob(job)) return true;
    if (isAllowlistedChronogolfJob(job)) return true;
    if (isAllowlistedTenForeJob(job)) return true;
    if (isAllowlistedProphetJob(job)) return true;
    const allowed = ALLOWED_COURSES[job?.courseKey];
    if (!allowed) return false;
    const [courseName, hostname, pathname, cardTextIncludes] = allowed;
    const url = new URL(job.bookingUrl);
    const isChronogolf = hostname === "www.chronogolf.com";
    const date = url.searchParams.get("date");
    const step = url.searchParams.get("step");
    return (
      job.courseName === courseName &&
      JSON.stringify(job.cardTextIncludes) === JSON.stringify(cardTextIncludes) &&
      url.protocol === "https:" &&
      url.hostname === hostname &&
      url.pathname === pathname &&
      url.username === "" &&
      url.password === "" &&
      (!isChronogolf || (/^\d{4}-\d{2}-\d{2}$/u.test(date || "") && step === "teetimes"))
    );
  } catch {
    return false;
  }
}

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
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)))
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
      ...(options.leaseToken ? { "x-local-reader-lease": options.leaseToken } : {})
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

async function wakePendingTab(tabId) {
  const jobs = await pendingJobs();
  if (!jobs[String(tabId)]) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "LOCAL_READER_WAKE" });
  } catch {
    // The content script also retries while the tab-to-job mapping settles.
  }
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
    await setLastStatus("RESULT_FAILED", error instanceof Error ? error.message : String(error));
  } finally {
    await closePendingTab(tabId);
  }
}

async function poll() {
  if (pollInProgress) return;
  pollInProgress = true;
  try {
    const settings = await getSettings();
    if (!settings.enabled || !settings.deviceId || settings.deviceToken.length < 16) {
      return;
    }
    const jobs = await pendingJobs();
    await cleanStalePendingJobs(jobs);
    if (Object.keys(jobs).length > 0) return;

    const readerVersion = chrome.runtime.getManifest().version;
    const capabilities = READER_CAPABILITIES.map(
      ([key, parserVersion]) => `${key}:${parserVersion}`
    ).join(",");
    const path =
      `/api/local-reader/jobs/next?deviceId=${encodeURIComponent(settings.deviceId)}` +
      `&readerVersion=${encodeURIComponent(readerVersion)}` +
      `&buildId=${encodeURIComponent(`chrome-extension-${readerVersion}`)}` +
      `&capabilities=${encodeURIComponent(capabilities)}`;
    const response = await signedFetch(path);
    if (!response.ok) {
      throw new Error(`Job API returned ${response.status}`);
    }
    const payload = await response.json();
    if (!payload.job) {
      await setLastStatus("IDLE", "No reader job is waiting.");
      return;
    }
    if (!isAllowlistedJob(payload.job)) {
      throw new Error("The backend returned a non-allowlisted reader job.");
    }
    const tab = await chrome.tabs.create({
      url: payload.job.bookingUrl,
      active: false
    });
    if (!tab.id) throw new Error("Chrome did not create a worker tab.");
    jobs[String(tab.id)] = {
      job: payload.job,
      openedAt: new Date().toISOString()
    };
    await savePendingJobs(jobs);
    await setLastStatus("READING", `${payload.job.courseKey} ${payload.job.targetDate}`);
    await wakePendingTab(tab.id);
  } catch (error) {
    await setLastStatus("POLL_FAILED", error instanceof Error ? error.message : String(error));
  } finally {
    pollInProgress = false;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await chrome.storage.local.get(["backendOrigin", "deviceId", "enabled"]);
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") void wakePendingTab(tabId);
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
