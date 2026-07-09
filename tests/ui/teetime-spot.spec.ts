import { expect, test, type Page, type TestInfo } from "@playwright/test";

const smokeBaseUrl = process.env.UI_SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
const smokeOrigin = new URL(smokeBaseUrl).origin;

test.describe("Tee Time Spot UI smoke", () => {
  test("onboarding discovery, ranking limit, and controls are usable", async ({
    page
  }, testInfo) => {
    const issues = collectPageIssues(page);

    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Tee Time Spot" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Start a search/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /View dashboard/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /Preview email/i })).toBeVisible();

    await page.getByRole("link", { name: /Start a search/i }).click();
    await expect(page.getByRole("heading", { name: /Tell us where/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Save alert search/i })).toBeDisabled();

    await page.getByLabel("Location").fill("Trumbull, CT");
    await page.getByRole("button", { name: /Find courses/i }).click();
    await expect(
      page.getByText(/Found \d+ nearby golf courses|Loaded demo courses/i)
    ).toBeVisible();

    const courseRows = page.locator(".course-row");
    const courseCount = await courseRows.count();
    expect(courseCount, "course discovery should return enough rows to exercise ranking limits").toBeGreaterThanOrEqual(6);

    for (let index = 0; index < 5; index += 1) {
      await courseRows.nth(index).getByRole("button", { name: /^Add$/i }).click();
    }

    await expect(page.getByText("#5")).toBeVisible();
    await courseRows.nth(5).getByRole("button", { name: /^Add$/i }).click();
    await expect(page.getByText("You can prioritize up to 5 courses.")).toBeVisible();

    await page.getByLabel("Alert email").fill(`ui-smoke-${Date.now()}@example.com`);
    await expect(page.getByRole("button", { name: /Save alert search/i })).toBeEnabled();

    await expectNoHorizontalOverflow(page, testInfo);
    await expectInteractiveElementsAreUsable(page, testInfo);
    await expectNoPageIssues(issues, testInfo);
  });

  test("dashboard access state is clear and layout is stable", async ({ page }, testInfo) => {
    const issues = collectPageIssues(page);

    await page.goto("/dashboard");

    await expect(
      page.getByRole("heading", {
        name: /Your tee time searches|Sign in to manage searches|Connect Neon/i
      })
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /New search|Back to search|Preview intake/i })).toBeVisible();

    const bodyText = await page.locator("body").innerText();
    expect(
      bodyText,
      "dashboard should explain whether searches are manageable, signed out, or setup-blocked"
    ).toMatch(/Automation state|Clerk|DATABASE_URL|Neon|sign in|account/i);

    await expectNoHorizontalOverflow(page, testInfo);
    await expectInteractiveElementsAreUsable(page, testInfo);
    await expectNoPageIssues(issues, testInfo);
  });

  test("alert email preview is accessible and stable", async ({ page }, testInfo) => {
    const issues = collectPageIssues(page);

    await page.goto("/email-preview");

    await expect(page.getByRole("heading", { name: "New tee time alert" })).toBeVisible();
    await expect(page.getByText("Tashua Knolls Golf Course").first()).toBeVisible();
    await expect(page.getByTitle("Rendered tee time alert email")).toBeVisible();

    const emailFrame = page.frameLocator("iframe[title='Rendered tee time alert email']");
    await expect(emailFrame.getByRole("heading", { name: "New tee time found" })).toBeVisible();
    await expect(emailFrame.getByRole("link", { name: "Open official booking page" })).toBeVisible();

    await expectNoHorizontalOverflow(page, testInfo);
    await expectInteractiveElementsAreUsable(page, testInfo);
    await expectNoPageIssues(issues, testInfo);
  });
});

function collectPageIssues(page: Page) {
  const issues: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      issues.push(`console:${message.text()}`);
    }
  });

  page.on("pageerror", (error) => {
    issues.push(`pageerror:${error.message}`);
  });

  page.on("requestfailed", (request) => {
    if (isSameOrigin(request.url())) {
      issues.push(`requestfailed:${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`);
    }
  });

  page.on("response", (response) => {
    if (isSameOrigin(response.url()) && response.status() >= 400) {
      issues.push(`response:${response.status()} ${response.url()}`);
    }
  });

  return issues;
}

async function expectNoPageIssues(issues: string[], testInfo: TestInfo) {
  await testInfo.attach("page-issues.json", {
    body: JSON.stringify(issues, null, 2),
    contentType: "application/json"
  });

  expect(issues).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page, testInfo: TestInfo) {
  const result = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const scrollWidth = document.documentElement.scrollWidth;
    const offenders = Array.from(document.body.querySelectorAll<HTMLElement>("*"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return {
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === "string" ? element.className : "",
          text: element.textContent?.replace(/\s+/g, " ").trim().slice(0, 80) ?? "",
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
        };
      })
      .filter((entry) => entry.visible && (entry.left < -2 || entry.right > viewportWidth + 2))
      .slice(0, 10);

    return { offenders, scrollWidth, viewportWidth };
  });

  await testInfo.attach("horizontal-overflow.json", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json"
  });

  expect(result.scrollWidth, JSON.stringify(result.offenders, null, 2)).toBeLessThanOrEqual(
    result.viewportWidth + 2
  );
  expect(result.offenders).toEqual([]);
}

async function expectInteractiveElementsAreUsable(page: Page, testInfo: TestInfo) {
  const issues = await page.evaluate(() => {
    return Array.from(document.querySelectorAll<HTMLElement>("a, button, input, select, textarea"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const text = element.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const isVisible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0";

        const problems: string[] = [];
        if (isVisible && rect.width < 24) {
          problems.push("too narrow");
        }
        if (isVisible && rect.height < 24) {
          problems.push("too short");
        }
        if (
          isVisible &&
          text &&
          element.scrollWidth > element.clientWidth + 2 &&
          element.clientWidth > 0
        ) {
          problems.push("text overflows");
        }

        return {
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === "string" ? element.className : "",
          text: text.slice(0, 80),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          problems
        };
      })
      .filter((entry) => entry.problems.length > 0)
      .slice(0, 20);
  });

  await testInfo.attach("interactive-element-issues.json", {
    body: JSON.stringify(issues, null, 2),
    contentType: "application/json"
  });

  expect(issues).toEqual([]);
}

function isSameOrigin(url: string) {
  try {
    return new URL(url).origin === smokeOrigin;
  } catch {
    return false;
  }
}
