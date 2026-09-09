"use strict";
(() => {
  let running = false;
  let finished = false;
  async function read() {
    if (running || finished) return;
    running = true;
    try {
      const { tabId } = await chrome.runtime.sendMessage({ type: "LOCAL_READER_IDENTIFY_TAB" });
      const { pendingJobs = {} } = await chrome.storage.local.get("pendingJobs");
      const job = pendingJobs[String(tabId)]?.job;
      if (!job || job.purpose !== "OFFICIAL_SOURCE_DISCOVERY" || Date.parse(job.expiresAt) <= Date.now()) return;
      const page = globalThis.TeeTimeOfficialSourceReader.readPage(document, location.href, job.course);
      await chrome.runtime.sendMessage({ type: "LOCAL_READER_SOURCE_PAGE", jobId: job.id, page });
      finished = true;
    } finally { running = false; }
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === "LOCAL_READER_WAKE") void read();
  });
  void read();
})();
