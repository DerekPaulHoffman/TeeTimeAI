import { expect, test, type Page, type TestInfo } from "@playwright/test";

const smokeBaseUrl =
  process.env.UI_SMOKE_BASE_URL ?? `http://127.0.0.1:${process.env.UI_SMOKE_PORT ?? "3100"}`;
const smokeOrigin = new URL(smokeBaseUrl).origin;

test.describe("Tee Time Spot UI smoke", () => {
  test("publishes the Discord community for feedback and product suggestions", async ({
    page
  }, testInfo) => {
    await page.goto("/");

    const discordLinks = page.locator('a[href="https://discord.gg/ThexF85xCd"]');
    await expect(discordLinks).toHaveCount(2);
    const navDiscordLink = page.locator(
      'a[aria-label="Join Tee Time Spot Discord for feedback and product suggestions"]'
    );
    if (testInfo.project.name.includes("mobile")) {
      await expect(navDiscordLink).toBeHidden();
    } else {
      await expect(navDiscordLink).toBeVisible();
    }
    await expect(
      page.getByRole("heading", { name: "Stop settling for your backup course." })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Built with golfers, not just for them." })
    ).toBeVisible();
    await expect(
      page.getByText(
        "Share feedback, suggest features, swap public-course tips, and help us make Tee Time Spot more useful.",
        { exact: true }
      )
    ).toBeVisible();

    await page.getByRole("button", { name: "Open feedback form" }).click();
    await expect(page.getByText("Have a product suggestion?", { exact: true })).toBeVisible();
    await expect(page.locator('a[href="https://discord.gg/ThexF85xCd"]')).toHaveCount(3);
  });

  test("onboarding discovery, ranking limit, and controls are usable", async ({
    page
  }, testInfo) => {
    const issues = collectPageIssues(page);
    const isMobile = testInfo.project.name.includes("mobile");

    await page.goto("/search");

    await expect(
      page.getByRole("heading", { name: /Tell us where and when you want to play/i })
    ).toBeVisible();
    if (isMobile) {
      await expect(page.getByText("Start getting alerts")).toBeHidden();
    } else {
      await expect(page.getByText("Start getting alerts")).toBeVisible();
    }
    await expect(page.locator(".summary-panel button")).toBeDisabled();
    await expect(page.getByLabel("Players").locator("option")).toHaveCount(4);
    await expect(page.locator("#searchRadius")).toHaveValue("15");

    await page.getByRole("textbox", { name: "Location", exact: true }).fill("Trumbull, CT");
    const discoveryRequest = page.waitForRequest((request) =>
      request.url().includes("/api/courses/discover?")
    );
    await page.getByRole("button", { name: /^Search$/i }).click();
    const discoveryUrl = new URL((await discoveryRequest).url());
    expect(discoveryUrl.searchParams.get("radiusMeters")).toBe("24140");
    const discoveryStatus = page.getByRole("status").filter({ hasText: /\d+ courses near Trumbull/i });
    await expect(discoveryStatus).toContainText(/\d+ courses near Trumbull/i);

    const courseRows = page.locator(".course-row");
    const courseCount = await courseRows.count();
    expect(courseCount, "course discovery should return enough rows to exercise ranking limits").toBeGreaterThanOrEqual(6);
    await expect(page.locator(".course-results-map-shell")).toHaveCount(0);
    await expect(page.locator(".course-results-map-frame")).toHaveCount(0);
    await expect(page.locator(".course-results-map-overlay")).toHaveCount(0);
    await expect(courseRows.nth(0).locator(".course-address-link")).toBeVisible();
    await expect(courseRows.nth(0).getByRole("link", { name: "Google Maps" })).toHaveCount(0);
    await expect(page.getByText(/^Photo:/)).toHaveCount(0);
    const seeMoreLocations = page.getByRole("button", { name: /See more locations/i });
    if ((await seeMoreLocations.count()) > 0) {
      await expect(page.getByText(/Showing \d+ of \d+ locations/i)).toBeVisible();
      await seeMoreLocations.click();
      expect(await courseRows.count()).toBeGreaterThan(courseCount);
    }

    await courseRows.nth(0).getByRole("button", { name: /Add/i }).click();
    await expect(page.locator(".selected-list .selected-row")).toHaveCount(1);
    await expect(courseRows.nth(0).getByRole("button", { name: /Remove/i })).toBeVisible();
    await courseRows.nth(0).getByRole("button", { name: /Remove/i }).click();
    await expect(page.locator(".selected-list .selected-row")).toHaveCount(0);

    for (let index = 0; index < 5; index += 1) {
      await courseRows.nth(index).getByRole("button", { name: /Add/i }).click();
    }

    await expect(page.locator(".selected-list .selected-row")).toHaveCount(5);
    await courseRows.nth(5).getByRole("button", { name: /Add/i }).click();
    await expect(page.getByText("You can prioritize up to 5 courses.")).toBeVisible();
    await expect(page.locator(".alert-error[role='alert']")).toContainText(
      "You can prioritize up to 5 courses."
    );

    if (isMobile) {
      const selectionToggle = page.locator(".mobile-selection-toggle");
      await expect(selectionToggle).toContainText("5 courses selected");
      await selectionToggle.click();
      await expect(page.locator(".figma-selected-panel.is-mobile-open")).toBeVisible();
    }

    let saveRequestCount = 0;
    await page.route("**/api/searches", async (route) => {
      saveRequestCount += 1;
      await route.fulfill({
        contentType: "application/json",
        status: 201,
        body: JSON.stringify({ search: { id: `ui-smoke-${saveRequestCount}` } })
      });
    });

    await page.getByLabel("Alert email").fill(`ui-smoke-${Date.now()}@example.com`);
    const saveButton = page.getByRole("button", { name: /Start getting alerts|Search saved/i });
    await expect(saveButton).toBeEnabled();

    await page.getByLabel("Date").fill(formatLocalDate(new Date()));
    await expect(page.getByText("Choose a future date for alerts.")).toBeVisible();
    await expect(page.getByLabel("Date")).toHaveAttribute("aria-describedby", /search-form-guidance/);
    await expect(saveButton).toBeDisabled();
    await page.getByLabel("Date").fill(formatLocalDate(addLocalDays(new Date(), 1)));

    await page.getByLabel("End time").fill("13:00");
    await expect(page.getByText("Choose an end time after the start time.")).toBeVisible();
    await expect(page.getByLabel("End time")).toHaveAttribute("aria-describedby", /search-form-guidance/);
    await expect(saveButton).toBeDisabled();
    await page.getByLabel("End time").fill("16:00");

    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(
      page.getByText("You're all set. We'll email you the moment a matching tee time opens up.")
    ).toBeVisible();
    await expect(saveButton).toBeDisabled();
    await saveButton.click({ force: true });
    expect(saveRequestCount, "unchanged saved searches should not submit more than once").toBe(1);

    const bodyText = await page.locator("body").innerText();
    expect(bodyText, "onboarding should avoid implementation jargon").not.toMatch(
      /\b(Codex|Postgres|Clerk|Neon|adapter|Google Places)\b/i
    );

    await expectNoHorizontalOverflow(page, testInfo);
    await expectInteractiveElementsAreUsable(page, testInfo);
    await expectNoPageIssues(issues, testInfo);
  });

  test("dashboard access state is clear and layout is stable", async ({ page }, testInfo) => {
    const issues = collectPageIssues(page);

    await page.goto("/dashboard");

    await expect(
      page.getByRole("heading", {
        name: /My Alerts Dashboard|Sign in to manage searches|Dashboard setup needed/i
      })
    ).toBeVisible();
    await expect(
      page
        .getByRole("main")
        .getByRole("link", {
          name: /Find a tee time|Add another search|Back to search|Preview intake/i
        })
        .first()
    ).toBeVisible();

    const bodyText = await page.locator("body").innerText();
    expect(
      bodyText,
      "dashboard should explain whether searches are manageable, signed out, or setup-blocked"
    ).toMatch(/Watching now|Matches found|sign in|account|setup needed|Pause and resume/i);
    expect(bodyText, "dashboard should avoid implementation jargon").not.toMatch(
      /\b(Codex|Postgres|Clerk|Neon|DATABASE_URL|Prisma|POC)\b/i
    );
    expect(bodyText, "dashboard should not imply Tee Time Spot completes tee times itself").not.toMatch(
      /Tee Time Spot books|we book|books tee times/i
    );

    await expectNoHorizontalOverflow(page, testInfo);
    await expectInteractiveElementsAreUsable(page, testInfo);
    await expectNoPageIssues(issues, testInfo);
  });

  test("alert email preview is accessible and stable", async ({ page }, testInfo) => {
    const issues = collectPageIssues(page);

    await page.goto("/email-preview");

    await expect(
      page.getByRole("heading", { name: "Useful updates, without inbox noise." })
    ).toBeVisible();
    await expect(page.getByTitle("Rendered search status email")).toBeVisible();
    await expect(page.getByTitle("Rendered tee time alert email")).toBeVisible();

    const statusFrame = page.frameLocator("iframe[title='Rendered search status email']");
    await expect(statusFrame.locator("body")).toContainText("We’re working on your tee times");
    await expect(statusFrame.locator("body")).toContainText("No time in your window");
    await expect(statusFrame.locator("body")).toContainText("Nothing visible for this date yet");
    await expect(statusFrame.locator("body")).toContainText("We’re working on it");
    await expect(statusFrame.locator("body")).toContainText(/at most one status update per day/i);

    const emailFrame = page.frameLocator("iframe[title='Rendered tee time alert email']");
    await expect(emailFrame.locator("body")).toContainText("Tashua Knolls Golf Course");
    await expect(emailFrame.locator("body")).toContainText("A spot just opened up!");
    await expect(emailFrame.getByRole("link", { name: "Book this tee time" })).toBeVisible();
    await expect(emailFrame.locator("body")).toContainText(/first come,\s+first served/i);
    await expect(emailFrame.locator("body")).not.toContainText(/we book/i);

    await expectNoHorizontalOverflow(page, testInfo);
    await expectInteractiveElementsAreUsable(page, testInfo);
    await expectNoPageIssues(issues, testInfo);
  });
});

function collectPageIssues(page: Page) {
  const issues: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      if (message.text().includes("Google Maps JavaScript API error: ApiNotActivatedMapError")) {
        return;
      }
      if (message.text().includes("/_next/webpack-hmr") && message.text().includes("WebSocket")) {
        return;
      }

      issues.push(`console:${message.text()}`);
    }
  });

  page.on("pageerror", (error) => {
    issues.push(`pageerror:${error.message}`);
  });

  page.on("requestfailed", (request) => {
    const failureText = request.failure()?.errorText ?? "";
    if (request.url().includes("/api/analytics/events") && failureText.includes("ERR_ABORTED")) {
      return;
    }
    if (request.url().includes("?_rsc=") && failureText.includes("ERR_ABORTED")) {
      return;
    }

    if (isSameOrigin(request.url())) {
      issues.push(`requestfailed:${request.method()} ${request.url()} ${failureText}`);
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
        const insideGoogleMap =
          Boolean(element.closest(".course-results-map")) ||
          Boolean(element.closest(".gm-style")) ||
          Boolean(element.closest("gmp-map")) ||
          Boolean(element.closest("gmp-advanced-marker")) ||
          Boolean(element.closest(".leaflet-container"));
        return {
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === "string" ? element.className : "",
          text: element.textContent?.replace(/\s+/g, " ").trim().slice(0, 80) ?? "",
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          insideGoogleMap,
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
        };
      })
      .filter(
        (entry) =>
          entry.visible &&
          !entry.insideGoogleMap &&
          (entry.left < -2 || entry.right > viewportWidth + 2)
      )
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

        const insideMapAttribution =
          Boolean(element.closest(".course-results-map")) ||
          Boolean(element.closest(".leaflet-container")) ||
          Boolean(element.closest(".gm-style"));
        const problems: string[] = [];
        if (insideMapAttribution) {
          return {
            tag: element.tagName.toLowerCase(),
            className: typeof element.className === "string" ? element.className : "",
            text: text.slice(0, 80),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            problems
          };
        }
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

function addLocalDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatLocalDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
