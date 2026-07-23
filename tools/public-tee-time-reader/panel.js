import {
  analyzePublicResponse,
  buildShareableReport
} from "./parser.js";

const records = [];
let isReading = false;

const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const clearButton = document.querySelector("#clear");
const copyButton = document.querySelector("#copy");
const readerStatus = document.querySelector("#reader-status");
const teeTimeCount = document.querySelector("#tee-time-count");
const slotCount = document.querySelector("#slot-count");
const challengeCount = document.querySelector("#challenge-count");
const emptyState = document.querySelector("#empty-state");
const results = document.querySelector("#results");
const template = document.querySelector("#result-template");

chrome.devtools.network.onRequestFinished.addListener((request) => {
  if (!isReading) {
    return;
  }

  request.getContent((content, encoding) => {
    const body = decodeContent(content, encoding);
    const record = analyzePublicResponse({
      method: request.request.method,
      url: request.request.url,
      status: request.response.status,
      mimeType: request.response.content?.mimeType,
      headers: request.response.headers,
      body
    });

    if (record.kind === "ignored" || record.kind === "irrelevant") {
      return;
    }

    records.unshift({
      ...record,
      observedAt: new Date().toISOString()
    });
    if (records.length > 200) {
      records.length = 200;
    }
    render();
  });
});

startButton.addEventListener("click", () => {
  isReading = true;
  startButton.disabled = true;
  stopButton.disabled = false;
  render();
});

stopButton.addEventListener("click", () => {
  isReading = false;
  startButton.disabled = false;
  stopButton.disabled = true;
  render();
});

clearButton.addEventListener("click", () => {
  records.length = 0;
  render();
});

copyButton.addEventListener("click", async () => {
  const inspectedUrl = await inspectedPageUrl();
  const report = buildShareableReport(records, inspectedUrl);
  await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
  const original = copyButton.textContent;
  copyButton.textContent = "Copied";
  setTimeout(() => {
    copyButton.textContent = original;
  }, 1200);
});

function render() {
  readerStatus.textContent = isReading ? "Reading" : "Stopped";
  const teeTimeRecords = records.filter((record) => record.kind === "tee_times");
  const challenges = records.filter((record) => record.kind === "challenge");
  const slots = teeTimeRecords.reduce(
    (total, record) => total + (record.slots?.length || 0),
    0
  );
  teeTimeCount.textContent = String(teeTimeRecords.length);
  slotCount.textContent = String(slots);
  challengeCount.textContent = String(challenges.length);
  emptyState.hidden = records.length > 0;
  results.replaceChildren(...records.map(renderRecord));
}

function renderRecord(record) {
  const fragment = template.content.cloneNode(true);
  const card = fragment.querySelector(".result-card");
  const badge = fragment.querySelector(".badge");
  const observedAt = fragment.querySelector("time");
  const title = fragment.querySelector(".result-title");
  const url = fragment.querySelector(".result-url");
  const detail = fragment.querySelector(".result-detail");
  const slots = fragment.querySelector(".slots");

  card.classList.add(record.kind.replace("_", "-"));
  badge.textContent = record.kind.replace("_", " ");
  observedAt.textContent = new Date(record.observedAt).toLocaleTimeString();
  title.textContent = `${record.method} ${record.status || "—"} · ${record.title}`;
  url.textContent = record.url;
  detail.textContent = record.detail || "";

  for (const slot of record.slots || []) {
    const item = document.createElement("div");
    item.className = "slot";
    item.textContent = formatSlot(slot);
    slots.append(item);
  }
  return fragment;
}

function formatSlot(slot) {
  return [
    slot.time,
    slot.course !== undefined ? `course ${formatValue(slot.course)}` : "",
    slot.startingTee !== undefined ? `tee ${formatValue(slot.startingTee)}` : "",
    slot.holes !== undefined ? `${formatValue(slot.holes)} holes` : "",
    slot.available !== undefined ? `${formatValue(slot.available)} available` : "",
    slot.price !== undefined ? `price ${formatValue(slot.price)}` : ""
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatValue(value) {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function decodeContent(content, encoding) {
  if (!content) {
    return "";
  }
  if (encoding !== "base64") {
    return content;
  }
  try {
    const bytes = Uint8Array.from(atob(content), (character) =>
      character.charCodeAt(0)
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

async function inspectedPageUrl() {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.eval(
      "location.href",
      (value, exception) => resolve(exception ? "" : String(value || ""))
    );
  });
}

render();
