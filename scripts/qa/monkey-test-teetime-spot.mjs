import { chromium } from "playwright";

const baseUrl = process.env.MONKEY_BASE_URL ?? "http://127.0.0.1:3000";
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const email = `codex-monkey-${Date.now()}@example.com`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const actions = [];
const issues = [];
const responses = [];
const requests = [];

function record(step, result, data = {}) {
  actions.push({ step, result, ...data });
}

page.on("console", (message) => {
  if (message.type() === "error") {
    issues.push({ type: "console-error", message: message.text() });
  }
});

page.on("pageerror", (error) => {
  issues.push({ type: "pageerror", message: error.message });
});

page.on("requestfailed", (request) => {
  if (request.url().startsWith(baseUrl)) {
    issues.push({
      type: "requestfailed",
      method: request.method(),
      url: request.url(),
      failure: request.failure()?.errorText
    });
  }
});

page.on("request", (request) => {
  if (request.url().startsWith(baseUrl) && request.method() !== "GET") {
    requests.push({
      method: request.method(),
      url: request.url(),
      postData: request.postData()?.slice(0, 500)
    });
  }
});

page.on("response", async (response) => {
  const url = response.url();
  if (!url.startsWith(baseUrl)) {
    return;
  }

  if (response.status() >= 400) {
    let body = "";
    try {
      body = (await response.text()).slice(0, 700);
    } catch {
      body = "";
    }
    issues.push({ type: "bad-response", status: response.status(), url, body });
  }

  if (
    url.includes("/api/searches") ||
    url.includes("/api/feedback") ||
    url.includes("/api/analytics")
  ) {
    responses.push({ status: response.status(), url });
  }
});

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Tee Time Spot" }).waitFor();
  record("open home page", "ok", { url: page.url() });

  await page.getByRole("button", { name: "Feedback" }).click();
  await page.getByRole("button", { name: "Broken" }).click();
  await page.getByLabel("Details").fill("Monkey test: the add/unadd flow needs checking.");
  await page.getByLabel("Email optional").fill(email);
  await page.getByRole("button", { name: "Send feedback" }).click();

  let feedbackStatus = "unknown";
  try {
    await page.getByText("Thanks. Your feedback was saved.").waitFor({ timeout: 5000 });
    feedbackStatus = "saved";
  } catch {
    const visibleError = await page
      .locator(".feedback-panel .alert-error")
      .textContent()
      .catch(() => null);
    feedbackStatus = visibleError ? `error: ${visibleError.trim()}` : "no success/error surfaced";
  }
  record("submit broken feedback", feedbackStatus);
  await page.getByLabel("Close feedback").click().catch(() => undefined);

  await page.getByRole("link", { name: "Start a search" }).click();
  await page.getByRole("heading", { name: /Tell us where/i }).waitFor();
  record("jump to search form", "ok");

  await page.getByLabel("Location").fill("Trumbull, CT");
  await page.getByRole("button", { name: "Find courses" }).click();
  await page.getByText(/Found \d+ nearby golf courses|Loaded demo courses/i).waitFor({
    timeout: 20000
  });
  const courseCount = await page.locator(".course-row").count();
  record("find courses for Trumbull CT", courseCount >= 1 ? "ok" : "no courses", { courseCount });

  const selectedCounts = [];
  for (let index = 0; index < Math.min(5, courseCount); index += 1) {
    const row = page.locator(".course-row").nth(index);
    await row.getByRole("button", { name: /^Add$/ }).click();
    selectedCounts.push(await page.locator(".selected-row.selected-card").count());
  }
  record("add first five courses", "ok", { selectedCounts });

  const firstAddedRowButton = page.locator(".course-row").nth(0).getByRole("button").last();
  const firstAddedRowButtonText = await firstAddedRowButton
    .innerText()
    .catch((error) => `error: ${error.message}`);
  const firstAddedRowButtonEnabled = await firstAddedRowButton.isEnabled().catch(() => null);
  record(
    "inspect added course row unadd affordance",
    firstAddedRowButtonEnabled ? "button still enabled" : "row button disabled after add",
    { firstAddedRowButtonText, firstAddedRowButtonEnabled }
  );

  if (courseCount > 5) {
    await page.locator(".course-row").nth(5).getByRole("button", { name: /^Add$/ }).click();
    const rankLimitError = await page
      .getByText("You can prioritize up to 5 courses.")
      .isVisible()
      .catch(() => false);
    record("try adding sixth course", rankLimitError ? "limit error shown" : "limit error missing");
  }

  const selectedBeforeRemove = await page.locator(".selected-row.selected-card").count();
  await page.locator(".selected-row.selected-card").nth(0).getByRole("button").click();
  const selectedAfterRemove = await page.locator(".selected-row.selected-card").count();
  record(
    "remove selected course from summary X button",
    selectedAfterRemove === selectedBeforeRemove - 1 ? "ok" : "failed",
    { selectedBeforeRemove, selectedAfterRemove }
  );

  let readdResult = "not attempted";
  try {
    await page.locator(".course-row").nth(0).getByRole("button", { name: /^Add$/ }).click({
      timeout: 3000
    });
    readdResult = "clicked Add";
  } catch (error) {
    readdResult = `failed: ${error.message.slice(0, 220)}`;
  }
  const selectedAfterReadd = await page.locator(".selected-row.selected-card").count();
  record("re-add removed course from course list", readdResult, { selectedAfterReadd });

  const saveButton = page.getByRole("button", {
    name: /Start getting alerts|Search saved|Starting alerts/
  });
  await page.getByLabel("Alert email").fill(email);
  await page.getByLabel("Date").fill(new Date().toISOString().slice(0, 10));
  const sameDayDisabled = !(await saveButton.isEnabled());
  record("same-day date validation", sameDayDisabled ? "save disabled" : "save still enabled");

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const yyyy = tomorrow.getFullYear();
  const mm = String(tomorrow.getMonth() + 1).padStart(2, "0");
  const dd = String(tomorrow.getDate()).padStart(2, "0");
  await page.getByLabel("Date").fill(`${yyyy}-${mm}-${dd}`);
  await page.getByLabel("End").fill("13:00");
  const badTimeDisabled = !(await saveButton.isEnabled());
  record("end-before-start validation", badTimeDisabled ? "save disabled" : "save still enabled");
  await page.getByLabel("End").fill("16:00");

  const saveEnabled = await saveButton.isEnabled();
  record("save button ready after valid form", saveEnabled ? "enabled" : "disabled");
  if (saveEnabled) {
    await saveButton.click();
    let saveResult = "unknown";
    try {
      await page
        .getByText("You're all set. We'll email you the moment a matching tee time opens up.")
        .waitFor({ timeout: 15000 });
      saveResult = "saved";
    } catch {
      const alertText = await page.locator(".alert-error").textContent().catch(() => null);
      saveResult = alertText ? `error: ${alertText.trim()}` : "no success/error surfaced";
    }
    record("submit real alert search", saveResult, { email });
  }

  await page.getByRole("link", { name: "View dashboard" }).click();
  await page.waitForLoadState("domcontentloaded");
  const dashboardHeading = await page
    .locator("main h1, main h2")
    .first()
    .textContent()
    .catch(() => null);
  record("open dashboard after submit", dashboardHeading ? "ok" : "missing heading", {
    dashboardHeading
  });

  await page.goto(`${baseUrl}/email-preview`, { waitUntil: "domcontentloaded" });
  const frameVisible = await page
    .locator("iframe[title='Rendered tee time alert email']")
    .isVisible()
    .catch(() => false);
  record("open email preview", frameVisible ? "iframe visible" : "iframe missing");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Feedback" }).click();
  const mobileOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  const feedbackPanelVisible = await page.locator(".feedback-panel").isVisible().catch(() => false);
  record("mobile feedback panel", feedbackPanelVisible && mobileOverflow <= 2 ? "ok" : "layout issue", {
    feedbackPanelVisible,
    mobileOverflow
  });
} finally {
  await browser.close();
}

console.log(
  JSON.stringify(
    {
      runId,
      baseUrl,
      email,
      actions,
      responses,
      requests,
      issues
    },
    null,
    2
  )
);
