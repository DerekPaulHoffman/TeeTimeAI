import { chromium } from "playwright";

const baseUrl = process.env.MONKEY_BASE_URL ?? "http://127.0.0.1:3000";
const email = `codex-fivecourse-${Date.now()}@example.com`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const requests = [];
const issues = [];

page.on("response", async (response) => {
  if (response.url().startsWith(baseUrl) && response.status() >= 400) {
    let body = "";
    try {
      body = (await response.text()).slice(0, 500);
    } catch {
      body = "";
    }
    issues.push({ status: response.status(), url: response.url(), body });
  }
});

page.on("request", (request) => {
  if (request.url().startsWith(baseUrl) && request.method() !== "GET") {
    requests.push({
      method: request.method(),
      url: request.url(),
      postData: request.postData()?.slice(0, 700)
    });
  }
});

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "Start a search" }).click();
  await page.getByLabel("Location").fill("Trumbull, CT");
  await page.getByRole("button", { name: "Find courses" }).click();
  await page.getByText(/Found \d+ nearby golf courses|Loaded demo courses/i).waitFor({
    timeout: 20_000
  });

  const courseCount = await page.locator(".course-row").count();
  for (let index = 0; index < Math.min(5, courseCount); index += 1) {
    await page.locator(".course-row").nth(index).getByRole("button", { name: /^Add$/ }).click();
  }

  const selectedCount = await page.locator(".selected-row.selected-card").count();
  await page.getByLabel("Alert email").fill(email);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  await page
    .getByLabel("Date")
    .fill(
      `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(
        tomorrow.getDate()
      ).padStart(2, "0")}`
    );
  await page.getByLabel("End").fill("16:00");

  const saveButton = page.getByRole("button", {
    name: /Start getting alerts|Search saved|Starting alerts/
  });
  const saveEnabled = await saveButton.isEnabled();
  if (!saveEnabled) {
    throw new Error("Save button was not enabled for valid five-course search");
  }

  await saveButton.click();
  await page
    .getByText("You're all set. We'll email you the moment a matching tee time opens up.")
    .waitFor({ timeout: 15_000 });

  console.log(
    JSON.stringify(
      {
        email,
        courseCount,
        selectedCount,
        requests,
        issues
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
}
