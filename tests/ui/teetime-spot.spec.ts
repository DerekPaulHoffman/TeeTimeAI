import { expect, test, type Page, type TestInfo } from "@playwright/test";

const smokeBaseUrl =
  process.env.UI_SMOKE_BASE_URL ?? `http://127.0.0.1:${process.env.UI_SMOKE_PORT ?? "3100"}`;
const smokeOrigin = new URL(smokeBaseUrl).origin;

test.describe("Tee Time Spot UI smoke", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/analytics/events", async (route) => {
      await route.fulfill({
        body: JSON.stringify({ event: { id: "ui-smoke-event" } }),
        contentType: "application/json",
        status: 201
      });
    });
  });

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
    const homeSearchForm = page.locator(".home-search-form");
    const homeLocation = homeSearchForm.locator('input[name="location"]');
    await expect(homeLocation).toHaveValue("");
    await expect(homeLocation).toHaveAttribute(
      "placeholder",
      "City and state, ZIP code, or street address"
    );
    await expect(homeLocation).toHaveAttribute("required", "");
    await expect(homeSearchForm.locator("select")).toHaveValue("4");
    await expect(homeSearchForm.locator('input[type="date"]')).toHaveValue(
      nextSaturdayDateInputValue()
    );
    await expect(homeSearchForm.locator('input[type="time"]').nth(0)).toHaveValue("09:00");
    await expect(homeSearchForm.locator('input[type="time"]').nth(1)).toHaveValue("18:00");
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

  test("shows when the current location has been selected", async ({ context, page }) => {
    await context.grantPermissions(["geolocation"], { origin: smokeOrigin });
    await context.setGeolocation({ latitude: 41.242, longitude: -73.209 });
    await page.route("**/api/courses/discover?**", async (route) => {
      await route.fulfill({
        body: JSON.stringify({ courses: [] }),
        contentType: "application/json",
        status: 200
      });
    });

    await page.goto("/search");
    const searchLocation = page.getByRole("textbox", { name: "Location", exact: true });
    await page.getByRole("button", { name: "Use current location" }).click();
    await expect(searchLocation).toHaveValue("Current location");

    await page.goto("/");
    await page.getByRole("button", { name: "Use my location" }).click();
    await expect(page).toHaveURL(/\/search\?/);
    await expect(page.getByRole("textbox", { name: "Location", exact: true })).toHaveValue(
      "Current location"
    );
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
    const alertActionButton = page.locator(".summary-panel > .button-primary");
    await expect(alertActionButton).toContainText(
      /Start getting alerts|Sign in to start sending alerts|Account access unavailable|Checking your account/i
    );
    if (isMobile) {
      await expect(alertActionButton).toBeHidden();
    } else {
      await expect(alertActionButton).toBeVisible();
    }
    await expect(alertActionButton).toBeDisabled();
    await expect(page.getByLabel("Players").locator("option")).toHaveCount(4);
    const locationInput = page.getByRole("textbox", { name: "Location", exact: true });
    await expect(locationInput).toHaveValue("");
    await expect(locationInput).toHaveAttribute(
      "placeholder",
      "City and state, ZIP code, or street address"
    );
    const courseSearchButton = page.getByRole("button", { name: /^Search$/i });
    await expect(courseSearchButton).toBeDisabled();
    await expect(page.locator("#players")).toHaveValue("4");
    await expect(page.locator("#date")).toHaveValue(nextSaturdayDateInputValue());
    await expect(page.locator("#startTime")).toHaveValue("09:00");
    await expect(page.locator("#endTime")).toHaveValue("18:00");
    await expect(page.locator("#searchRadius")).toHaveValue("15");

    await locationInput.fill("Trumbull, CT");
    await expect(courseSearchButton).toBeEnabled();
    const discoveryRequest = page.waitForRequest((request) =>
      request.url().includes("/api/courses/discover?")
    );
    await courseSearchButton.click();
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

    const courseOrderBeforeSelection = await courseRows.locator("h3").allTextContents();
    const laterCourse = courseRows.nth(4);
    await laterCourse.getByRole("button", { name: /Add/i }).click();
    await expect(page.locator(".selected-list .selected-row")).toHaveCount(1);
    expect(
      await courseRows.locator("h3").allTextContents(),
      "adding a course should preserve the discovery order so users can keep moving through the list"
    ).toEqual(courseOrderBeforeSelection);
    await laterCourse.getByRole("button", { name: /Remove/i }).click();
    await expect(page.locator(".selected-list .selected-row")).toHaveCount(0);

    await page.route("**/api/courses/lookup?**", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({
          courses: [
            {
              googlePlaceId: "ui-smoke-missing-course",
              name: "Bethpage Black Course",
              address: "99 Quaker Meeting House Rd, Farmingdale, NY",
              latitude: 40.744,
              longitude: -73.456,
              distanceMeters: 78000,
              website: "https://parks.ny.gov/golf/11/details.aspx"
            },
            {
              googlePlaceId: "ui-smoke-official-site-only",
              name: "Fairview Farm Golf Course",
              address: "300 Hill Rd, Harwinton, CT",
              latitude: 41.815,
              longitude: -73.071,
              distanceMeters: 44000,
              website: "https://fairviewfarmgc.com/",
              alertSupport: "PHONE_ONLY"
            }
          ]
        })
      });
    });
    await page.getByLabel("Course name").fill("Bethpage Black, Farmingdale NY");
    await page.getByRole("button", { name: "Find course" }).click();
    await expect(page.getByRole("status").filter({ hasText: "2 matches found" })).toBeVisible();
    const missingCourseResults = page.locator(".missing-course-result");
    const blockedCourseResult = missingCourseResults.filter({
      has: page.getByRole("heading", { name: "Fairview Farm Golf Course" })
    });
    await expect(blockedCourseResult).toContainText(
      "Phone only - not checked automatically"
    );
    await blockedCourseResult.getByRole("button", { name: "Add Fairview Farm Golf Course" }).click();
    if (isMobile) {
      await page.locator(".mobile-selection-toggle").click();
    }
    await expect(page.getByText("Choose at least one course Tee Time Spot can monitor automatically.")).toBeVisible();
    if (isMobile) {
      await page.locator(".selected-list").getByRole("button", { name: "Remove Fairview Farm Golf Course" }).click();
    } else {
      await blockedCourseResult.getByRole("button", { name: "Remove Fairview Farm Golf Course" }).click();
    }

    const missingCourseResult = missingCourseResults.filter({
      has: page.getByRole("heading", { name: "Bethpage Black Course" })
    });
    await expect(missingCourseResult.getByRole("heading", { name: "Bethpage Black Course" })).toBeVisible();
    await missingCourseResult.getByRole("button", { name: "Add Bethpage Black Course" }).click();
    await expect(page.locator(".selected-list .selected-row")).toHaveCount(1);
    await missingCourseResult.getByRole("button", { name: "Remove Bethpage Black Course" }).click();
    await expect(page.locator(".selected-list .selected-row")).toHaveCount(0);

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

    await page.getByLabel("Date").fill(formatLocalDate(new Date()));
    await expect(page.getByText("Choose a future date for alerts.")).toBeVisible();
    await expect(page.getByLabel("Date")).toHaveAttribute("aria-describedby", /search-form-guidance/);
    await expect(alertActionButton).toBeDisabled();
    await page.getByLabel("Date").fill(formatLocalDate(addLocalDays(new Date(), 1)));

    await page.getByLabel("End time").fill("08:00");
    await expect(page.getByText("Choose an end time after the start time.")).toBeVisible();
    await expect(page.getByLabel("End time")).toHaveAttribute("aria-describedby", /search-form-guidance/);
    await expect(alertActionButton).toBeDisabled();
    await page.getByLabel("End time").fill("18:00");

    const alertActionText = await alertActionButton.innerText();
    if (/Sign in to start sending alerts/i.test(alertActionText)) {
      await expect(alertActionButton).toBeEnabled();
      await alertActionButton.click();
      await expect(page.getByRole("heading", { name: "Sign in to Tee Time Spot" })).toBeVisible();
      await page.getByRole("button", { name: "Close modal" }).click();
      expect(saveRequestCount, "signed-out visitors must not submit alert searches").toBe(0);
    } else if (/Start getting alerts/i.test(alertActionText)) {
      await expect(alertActionButton).toBeEnabled();
      await alertActionButton.click();
      await expect(
        page.getByText("You're all set. We'll email you the moment a matching tee time opens up.")
      ).toBeVisible();
      await expect(alertActionButton).toBeDisabled();
      await alertActionButton.click({ force: true });
      expect(saveRequestCount, "unchanged saved searches should not submit more than once").toBe(1);
    } else {
      await expect(alertActionButton).toBeDisabled();
      await expect(
        page.getByText("Account access is temporarily unavailable, so alerts cannot be created.")
      ).toBeVisible();
      expect(saveRequestCount, "alerts must stay blocked while account access is unavailable").toBe(0);
    }

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
        name: /My Alerts Dashboard|Sign in to manage searches|Dashboard setup needed|Account access is temporarily unavailable/i
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

    const signedOutHeading = page.getByRole("heading", { name: "Sign in to manage searches" });
    if (await signedOutHeading.isVisible()) {
      await expect(page.getByRole("main").getByRole("button", { name: "Sign in" })).toBeVisible();
      await expect(
        page.getByRole("main").getByRole("link", { name: "Back to search" })
      ).toBeVisible();

      if (testInfo.project.name === "chromium-mobile") {
        await expect(page.locator(".topbar").getByRole("button", { name: "Sign in" })).toBeVisible();
      }
    }

    if (testInfo.project.name === "chromium-mobile") {
      await expect(
        page.getByRole("button", { name: "Open feedback form" }).getByText("Feedback")
      ).toBeVisible();
    }

    const bodyText = await page.locator("body").innerText();
    expect(
      bodyText,
      "dashboard should explain whether searches are manageable, signed out, or setup-blocked"
    ).toMatch(/Watching now|Matches found|sign in|account|setup needed|Pause and resume/i);
    expect(bodyText, "dashboard should avoid implementation jargon").not.toMatch(
      /\b(Codex|Postgres|Clerk|Neon|DATABASE_URL|Prisma|POC)\b/i
    );
    expect(bodyText, "public dashboard should not expose recipient email addresses").not.toMatch(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
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
    await expect(statusFrame.locator("body")).toContainText("Fairview Farm Golf Course");
    await expect(statusFrame.locator("body")).toContainText("Phone only");
    await expect(statusFrame.getByRole("link", { name: "Call (860) 689-1000" })).toBeVisible();
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

function nextSaturdayDateInputValue(from = new Date()) {
  const date = new Date(from);
  const daysUntilSaturday = (6 - date.getDay() + 7) % 7 || 7;
  date.setDate(date.getDate() + daysUntilSaturday);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

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
