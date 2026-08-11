"use strict";

const DEFAULT_BACKEND_ORIGIN = "https://teetimespot.com";
const POLL_ALARM = "tee-time-spot-local-reader-poll";
const POLL_PERIOD_MINUTES = 1;
const MAX_CONCURRENT_JOBS = 2;
const BACKEND_FETCH_TIMEOUT_MS = 10_000;
const READER_CAPABILITIES = Object.freeze([
  ["CPS_RENDERED", 1],
  ["CHRONOGOLF_RENDERED", 1],
  ["TENFORE_RENDERED", 1],
  ["EZLINKS_RENDERED", 1],
  ["WEBTRAC_RENDERED", 1],
  ["PROPHET_FREAR_RENDERED", 4]
]);
const PROPHET_COURSES = Object.freeze({
  "frear-park": [
    "Frear Park Municipal Golf Course",
    "/FrearParkV3/Home/NIndex",
    "1,2"
  ],
  "simsbury-farms": [
    "Simsbury Farms Golf Course",
    "/SimsburyFarmsV3/Home/NIndex",
    "1"
  ]
});
let pollInProgress = false;
let pendingJobsOperation = Promise.resolve();
const pendingResultSubmissions = new Map();

function isAllowlistedCpsJob(job) {
  try {
    if (
      !/^cps:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cps\.golf$/u.test(
        job?.courseKey || ""
      ) ||
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
      Array.from(url.searchParams.keys()).every((key) =>
        ["date", "step"].includes(key)
      ) &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function isSafeEzLinksHostname(hostname) {
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ezlinksgolf\.com$/u.test(hostname)
  ) {
    return false;
  }
  const tenant = hostname.slice(0, -".ezlinksgolf.com".length);
  return !new Set([
    "admin",
    "api",
    "auth",
    "blog",
    "careers",
    "config",
    "contact",
    "corporate",
    "dev",
    "help",
    "marketing",
    "shop",
    "store",
    "support"
  ]).has(tenant);
}

function isAllowlistedEzLinksJob(job) {
  try {
    if (
      !/^ezlinks:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ezlinksgolf\.com$/u.test(
        job?.courseKey || ""
      ) ||
      typeof job.courseName !== "string" ||
      job.courseName.trim().length === 0 ||
      job.courseName.length > 160 ||
      !Array.isArray(job.cardTextIncludes) ||
      job.cardTextIncludes.length !== 0 ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(job.targetDate || "")
    ) {
      return false;
    }
    const hostname = job.courseKey.slice("ezlinks:".length);
    const url = new URL(job.bookingUrl);
    return (
      isSafeEzLinksHostname(hostname) &&
      url.protocol === "https:" &&
      url.hostname === hostname &&
      url.pathname === "/index.html" &&
      url.search === "" &&
      url.hash === "#!/search" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function isAllowlistedWebTracJob(job) {
  try {
    if (
      !/^webtrac:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myvscloud\.com$/u.test(
        job?.courseKey || ""
      ) ||
      typeof job.courseName !== "string" ||
      job.courseName.trim().length === 0 ||
      job.courseName.length > 160 ||
      !Array.isArray(job.cardTextIncludes) ||
      job.cardTextIncludes.length !== 0 ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(job.targetDate || "") ||
      !Number.isInteger(job.players) ||
      job.players < 1 ||
      job.players > 4
    ) {
      return false;
    }
    const hostname = job.courseKey.slice("webtrac:".length);
    const url = new URL(job.bookingUrl);
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
    const [year, month, day] = job.targetDate.split("-");
    return (
      url.protocol === "https:" &&
      url.hostname === hostname &&
      url.pathname === "/webtrac/web/search.html" &&
      url.searchParams.size === allowedKeys.size &&
      Array.from(allowedKeys).every((key) => url.searchParams.has(key)) &&
      Array.from(url.searchParams.keys()).every((key) =>
        allowedKeys.has(key)
      ) &&
      url.searchParams.get("Action") === "Start" &&
      url.searchParams.get("begindate") === `${month}/${day}/${year}` &&
      url.searchParams.get("begintime") === "12:00 am" &&
      url.searchParams.get("display") === "Detail" &&
      url.searchParams.get("grwebsearch_buttonsearch") === "yes" &&
      url.searchParams.get("module") === "GR" &&
      url.searchParams.get("numberofplayers") === String(job.players) &&
      url.searchParams.get("page") === "1" &&
      url.searchParams.get("search") === "yes" &&
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
      Array.from(url.searchParams.keys()).every((key) =>
        allowedKeys.has(key)
      ) &&
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
        ([key, parserVersion]) =>
          key === required.key && parserVersion >= required.parserVersion
      )
    ) {
      return false;
    }
    const expectedCapability = [
      [isAllowlistedCpsJob, "CPS_RENDERED", 1],
      [isAllowlistedChronogolfJob, "CHRONOGOLF_RENDERED", 1],
      [isAllowlistedTenForeJob, "TENFORE_RENDERED", 1],
      [isAllowlistedEzLinksJob, "EZLINKS_RENDERED", 1],
      [isAllowlistedWebTracJob, "WEBTRAC_RENDERED", 1],
      [isAllowlistedProphetJob, "PROPHET_FREAR_RENDERED", 4]
    ].find(([isAllowlisted]) => isAllowlisted(job));
    return Boolean(
      expectedCapability &&
        required.key === expectedCapability[1] &&
        required.parserVersion === expectedCapability[2]
    );
  } catch {
    return false;
  }
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
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
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort("Local reader backend request timed out."),
    BACKEND_FETCH_TIMEOUT_MS
  );
  try {
    const response = await fetch(`${settings.backendOrigin}${path}`, {
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
      cache: "no-store",
      signal: controller.signal
    });
    if (options.expectJson === true) {
      return {
        response,
        payload: response.ok ? await response.json() : null
      };
    }
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
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

function withPendingJobsLock(operation) {
  const current = pendingJobsOperation.then(operation);
  pendingJobsOperation = current.then(
    () => undefined,
    () => undefined
  );
  return current;
}

async function readPendingJobsSnapshot() {
  return withPendingJobsLock(() => pendingJobs());
}

async function mutatePendingJobs(mutator) {
  return withPendingJobsLock(async () => {
    const jobs = await pendingJobs();
    const mutation = await mutator(jobs);
    if (mutation.changed) await savePendingJobs(jobs);
    return mutation.value;
  });
}

async function wakePendingTab(tabId) {
  const jobs = await readPendingJobsSnapshot();
  if (!jobs[String(tabId)]) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "LOCAL_READER_WAKE" });
  } catch {
    // The content script also retries while the tab-to-job mapping settles.
  }
}

function isReusableEzLinksTab(job, tab) {
  try {
    if (!isAllowlistedEzLinksJob(job) || !tab?.id || !tab.url) return false;
    const hostname = job.courseKey.slice("ezlinks:".length);
    const url = new URL(tab.url);
    return (
      url.protocol === "https:" &&
      url.hostname === hostname &&
      url.pathname === "/index.html" &&
      url.hash === "#!/search" &&
      url.username === "" &&
      url.password === "" &&
      [...url.searchParams.keys()].every((key) => key.startsWith("__cf_chl_"))
    );
  } catch {
    return false;
  }
}

async function findReusableEzLinksTab(job) {
  if (!isAllowlistedEzLinksJob(job)) return null;
  const hostname = job.courseKey.slice("ezlinks:".length);
  const tabs = await chrome.tabs.query({ url: `https://${hostname}/*` });
  return (
    tabs
      .filter((tab) => isReusableEzLinksTab(job, tab))
      .sort(
        (left, right) => (right.lastAccessed || 0) - (left.lastAccessed || 0)
      )[0] || null
  );
}

async function cleanStalePendingJobs() {
  return mutatePendingJobs(async (jobs) => {
    const now = Date.now();
    let changed = false;
    let removedCount = 0;
    for (const [tabId, pending] of Object.entries(jobs)) {
      const openedAt = Date.parse(pending.openedAt || "");
      const expiresAt = Date.parse(pending.job?.expiresAt || "");
      const leaseExpiresAt = Date.parse(pending.job?.leaseExpiresAt || "");
      let tabExists = true;
      try {
        await chrome.tabs.get(Number(tabId));
      } catch {
        tabExists = false;
      }
      if (
        (!tabExists && !pending.result) ||
        (Number.isFinite(leaseExpiresAt) && leaseExpiresAt <= now) ||
        (!Number.isFinite(leaseExpiresAt) &&
          Number.isFinite(openedAt) &&
          openedAt + 170_000 <= now) ||
        (Number.isFinite(expiresAt) && expiresAt <= now)
      ) {
        delete jobs[tabId];
        changed = true;
        removedCount += 1;
        if (tabExists && pending.closeTabOnFinish !== false) {
          await closePendingTab(Number(tabId));
        }
      }
    }
    return { changed, value: removedCount };
  });
}

async function closePendingTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // The operator may already have closed the worker-created tab.
  }
}

async function submitPendingResult(tabId, pending) {
  const result = pending.result;
  if (!result) return false;
  const jobId = pending.job.id;
  const activeSubmission = pendingResultSubmissions.get(jobId);
  if (activeSubmission) return activeSubmission;

  const submission = (async () => {
    const body = JSON.stringify({ ...result, jobId });
    const path = `/api/local-reader/jobs/${encodeURIComponent(jobId)}/result`;
    const response = await signedFetch(path, {
      method: "POST",
      body,
      leaseToken: pending.job.leaseToken
    });
    if (!response.ok) {
      throw new Error(`Result API returned ${response.status}`);
    }
    await mutatePendingJobs((jobs) => {
      if (jobs[String(tabId)]?.job?.id !== jobId) {
        return { changed: false, value: false };
      }
      delete jobs[String(tabId)];
      return { changed: true, value: true };
    });
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
    return true;
  })();
  pendingResultSubmissions.set(jobId, submission);
  try {
    return await submission;
  } finally {
    if (pendingResultSubmissions.get(jobId) === submission) {
      pendingResultSubmissions.delete(jobId);
    }
  }
}

async function finishJob(tabId, result) {
  const pending = await mutatePendingJobs((jobs) => {
    const current = jobs[String(tabId)];
    if (!current) return { changed: false, value: null };
    if (current.result) return { changed: false, value: current };
    jobs[String(tabId)] = { ...current, result };
    return { changed: true, value: jobs[String(tabId)] };
  });
  if (!pending) return;

  try {
    await submitPendingResult(tabId, pending);
  } catch (error) {
    await setLastStatus(
      "RESULT_FAILED",
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    if (pending.closeTabOnFinish !== false) await closePendingTab(tabId);
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
    const removedStaleJobs = await cleanStalePendingJobs();
    if (removedStaleJobs > 0) {
      await setLastStatus(
        "RETRYING",
        `${removedStaleJobs} expired reader job${removedStaleJobs === 1 ? "" : "s"} cleared; requesting fresh signed work.`
      );
    }
    let jobs = await readPendingJobsSnapshot();
    const pendingSubmissions = Object.entries(jobs).filter(
      ([, pending]) => pending.result
    );
    const submissionResults = await Promise.allSettled(
      pendingSubmissions.map(([tabId, pending]) =>
        submitPendingResult(Number(tabId), pending)
      )
    );
    if (pendingSubmissions.length > 0) {
      for (let index = 0; index < pendingSubmissions.length; index += 1) {
        const result = submissionResults[index];
        if (result?.status === "fulfilled") continue;
        await setLastStatus(
          "RESULT_RETRY_PENDING",
          result?.reason instanceof Error
            ? result.reason.message
            : String(result?.reason)
        );
      }
    }
    jobs = await readPendingJobsSnapshot();
    const readerVersion = chrome.runtime.getManifest().version;
    const capabilities = READER_CAPABILITIES.map(
      ([key, parserVersion]) => `${key}:${parserVersion}`
    ).join(",");
    let claimedAny = false;
    while (Object.keys(jobs).length < MAX_CONCURRENT_JOBS) {
      const path =
        `/api/local-reader/jobs/next?deviceId=${encodeURIComponent(settings.deviceId)}` +
        `&readerVersion=${encodeURIComponent(readerVersion)}` +
        `&buildId=${encodeURIComponent(`chrome-extension-${readerVersion}`)}` +
        `&capabilities=${encodeURIComponent(capabilities)}`;
      const { response, payload } = await signedFetch(path, {
        expectJson: true
      });
      if (!response.ok) {
        throw new Error(`Job API returned ${response.status}`);
      }
      if (!payload.job) break;
      if (!isAllowlistedJob(payload.job)) {
        throw new Error("The backend returned a non-allowlisted reader job.");
      }
      const reusableTab = await findReusableEzLinksTab(payload.job);
      const tab =
        reusableTab ||
        (await chrome.tabs.create({
          url: payload.job.bookingUrl,
          active: false
        }));
      if (!tab.id) throw new Error("Chrome did not create a worker tab.");
      try {
        await mutatePendingJobs((currentJobs) => {
          if (currentJobs[String(tab.id)]) {
            throw new Error("The selected worker tab already has a reader job.");
          }
          currentJobs[String(tab.id)] = {
            job: payload.job,
            openedAt: new Date().toISOString(),
            closeTabOnFinish: reusableTab === null
          };
          return { changed: true, value: true };
        });
      } catch (error) {
        if (reusableTab === null) await closePendingTab(tab.id);
        throw error;
      }
      jobs = await readPendingJobsSnapshot();
      claimedAny = true;
      await setLastStatus(
        "READING",
        `${payload.job.courseKey} ${payload.job.targetDate}`
      );
      await wakePendingTab(tab.id);
    }
    if (!claimedAny && Object.keys(jobs).length === 0) {
      await setLastStatus("IDLE", "No reader job is waiting.");
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") void wakePendingTab(tabId);
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === "LOCAL_READER_IDENTIFY_TAB") {
    return Promise.resolve({ tabId: sender.tab?.id || null });
  }
  if (message?.type === "LOCAL_READER_RESULT" && sender.tab?.id) {
    return finishJob(sender.tab.id, message.result);
  }
  if (message?.type === "LOCAL_READER_POLL_NOW") {
    void poll();
  }
});
