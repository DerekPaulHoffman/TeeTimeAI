"use strict";
(() => {
  let running = false;
  let finished = false;
  const startedAt = Date.now();
  let retryTimer;
  function retry() {
    if (finished || retryTimer || Date.now() - startedAt >= 20_000) return;
    retryTimer = setTimeout(() => { retryTimer = undefined; void read(); }, 500);
  }
  async function read() {
    if (running || finished) return;
    running = true;
    try {
      const { tabId } = await chrome.runtime.sendMessage({ type: "LOCAL_READER_IDENTIFY_TAB" });
      const { pendingJobs = {} } = await chrome.storage.local.get("pendingJobs");
      const job = pendingJobs[String(tabId)]?.job;
      if (!job) { retry(); return; }
      if (job.purpose !== "OFFICIAL_SOURCE_DISCOVERY" || Date.parse(job.expiresAt) <= Date.now()) return;
      const page = globalThis.TeeTimeOfficialSourceReader.readPage(document, location.href, job.course);
      // A document_idle injection may see a redirect/intermediate document or
      // an unfinished client render. Do not permanently submit that empty page.
      if (page.status === "OBSERVED" && !page.bookingLinks.length && !page.nextUrls.length &&
        Date.now() - startedAt < 19_500 && Date.parse(job.expiresAt) - Date.now() > 1_000) {
        retry(); return;
      }
      await chrome.runtime.sendMessage({ type: "LOCAL_READER_SOURCE_PAGE", jobId: job.id, page });
      finished = true;
      clearTimeout(retryTimer);
    } finally { running = false; }
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === "LOCAL_READER_WAKE") void read();
  });
  void read();
})();
