"use strict";

async function load() {
  const settings = await chrome.storage.local.get([
    "backendOrigin",
    "deviceId",
    "deviceToken",
    "enabled",
    "lastStatus",
    "lastDetail",
    "lastStatusAt"
  ]);
  document.querySelector("#backendOrigin").value =
    settings.backendOrigin || "https://teetimespot.com";
  document.querySelector("#deviceId").value =
    settings.deviceId || `chrome-${crypto.randomUUID()}`;
  document.querySelector("#deviceToken").value =
    (settings.deviceToken || "").replace(/^\uFEFF/u, "").trim();
  document.querySelector("#enabled").checked = settings.enabled === true;
  document.querySelector("#status").textContent = settings.lastStatus
    ? `${settings.lastStatusAt || ""} ${settings.lastStatus}: ${settings.lastDetail || ""}`
    : "Not configured yet.";
}

document.querySelector("#save").addEventListener("click", async () => {
  const backendOrigin = document.querySelector("#backendOrigin").value.trim().replace(/\/+$/u, "");
  const deviceId = document.querySelector("#deviceId").value.trim();
  const deviceToken = document
    .querySelector("#deviceToken")
    .value.replace(/^\uFEFF/u, "")
    .trim();
  const enabled = document.querySelector("#enabled").checked;
  const status = document.querySelector("#status");
  if (
    backendOrigin !== "https://teetimespot.com" &&
    backendOrigin !== "http://127.0.0.1:4317"
  ) {
    status.textContent =
      "Use https://teetimespot.com or the exact loopback proof backend.";
    return;
  }
  if (!/^[a-zA-Z0-9._-]{3,100}$/u.test(deviceId) || deviceToken.length < 16) {
    status.textContent = "Enter a valid device ID and a token of at least 16 characters.";
    return;
  }
  await chrome.storage.local.set({
    backendOrigin,
    deviceId,
    deviceToken,
    enabled
  });
  status.textContent = enabled ? "Saved. Polling now…" : "Saved. Polling is disabled.";
  if (enabled) {
    await chrome.runtime.sendMessage({ type: "LOCAL_READER_POLL_NOW" });
  }
  setTimeout(load, 1000);
});

void load();
