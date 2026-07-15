import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

const smokeBaseUrl =
  process.env.UI_SMOKE_BASE_URL ?? `http://127.0.0.1:${process.env.UI_SMOKE_PORT ?? "3100"}`;
const smokeOrigin = new URL(smokeBaseUrl).origin;
const useIsolatedPreviewProviders = process.env.UI_SMOKE_ISOLATED_PROVIDERS === "true";
const smokeHostname = new URL(smokeBaseUrl).hostname;
const useMockedSearchProviders =
  useIsolatedPreviewProviders || smokeHostname === "127.0.0.1" || smokeHostname === "localhost";

const smokeCourses = [
  "Tashua Knolls Golf Course",
  "H. Smith Richardson Golf Course",
  "Longshore Golf Course",
  "Sterling Farms Golf Course",
  "Oak Hills Park Golf Course",
  "Smithtown Landing Golf Course",
  "Fairchild Wheeler Golf Course"
].map((name, index) => ({
  address: `${100 + index} Public Links Rd, Trumbull, CT`,
  bookableHoleCounts: index === 1 ? [9] : index === 0 ? [9, 18] : [18],
  distanceMeters: [3.2, 5.1, 6.4, 8.9, 11.2, 12.7, 14.3][index] * 1_609.344,
  googlePlaceId: `ui-smoke-course-${index + 1}`,
  layoutHoleCounts: [18],
  latitude: 41.24 + index * 0.002,
  longitude: -73.2 - index * 0.002,
  name,
  monitoringSupport: index === 0 ? "AUTOMATIC" : "UNCONFIRMED",
  par: [72, 72, 71, 70, 71, 72, 72][index],
  photoReference: `ui-smoke-photo-${index + 1}`,
  ...(index === 0
    ? { profileUrl: "/courses/tashua-knolls-golf-course-trumbull-ct" }
    : {}),
  priceEstimate: {
    currency: "USD",
    ...(index === 1
      ? {
          nineHoles: {
            maxPriceCents: 2500,
            minPriceCents: 2500,
            sampleSize: 1
          }
        }
      : {
          eighteenHoles: {
            maxPriceCents: [4800, 6200, 4400, 5100, 5700, 4900, 5400][index],
            minPriceCents: [4800, 6200, 4400, 5100, 5700, 4900, 5400][index],
            sampleSize: 1
          }
        }),
    observedAt: "2026-07-15T12:00:00.000Z"
  },
  rating: [4.3, 4.5, 4.1, 4.2, 4.0, 3.9, 4.2][index],
  timeZone: "America/New_York",
  website: `https://example.com/course-${index + 1}`
}));

test.describe("Tee Time Spot UI smoke", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.sessionStorage.setItem("tee-time-spot:traffic-class", "AUTOMATION");
    });
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
    await expect(discordLinks).toHaveCount(3);
    const navDiscordLink = page.locator(
      'a[aria-label="Join Tee Time Spot Discord for feedback and product suggestions"]'
    );
    if (testInfo.project.name.includes("mobile")) {
      await expect(navDiscordLink).toBeHidden();
    } else {
      await expect(navDiscordLink).toBeVisible();
    }
    await expect(
      page.getByRole("heading", { name: "Tee Time Spot finds the opening. You book direct." })
    ).toBeVisible();
    const heroCards = page.locator(".hero-strip-item");
    await expect(heroCards).toHaveCount(3);
    await expect(page.getByText("Tell us your courses", { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        "Pick the public courses you want to play and rank them by priority.",
        { exact: true }
      )
    ).toBeVisible();
    await expect(page.getByText("Book what you can now", { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        "See what's currently available and grab a tee time to hold your day.",
        { exact: true }
      )
    ).toBeVisible();
    await expect(
      page.getByText("We'll alert you when a priority opens", { exact: true })
    ).toBeVisible();
    await expect(
      page.getByText(
        "If your top picks are full, we watch them around the clock and notify you the moment a spot becomes available.",
        { exact: true }
      )
    ).toBeVisible();
    if (testInfo.project.name.includes("mobile")) {
      const [topbarBox, heroHeadingBox] = await Promise.all([
        page.locator(".topbar").boundingBox(),
        page.locator(".hero h1").boundingBox()
      ]);
      expect(topbarBox).not.toBeNull();
      expect(heroHeadingBox).not.toBeNull();
      expect(heroHeadingBox!.y).toBeGreaterThan(
        topbarBox!.y + topbarBox!.height + 24
      );

      const cardRects = await heroCards.evaluateAll((cards) =>
        cards.map((card) => {
          const rect = card.getBoundingClientRect();
          return {
            bottom: rect.bottom,
            top: rect.top,
            width: rect.width
          };
        })
      );
      expect(Math.abs(cardRects[0].top - cardRects[1].top)).toBeLessThanOrEqual(1);
      expect(cardRects[2].top).toBeGreaterThan(cardRects[0].bottom);
      expect(cardRects[2].width).toBeGreaterThan(cardRects[0].width * 1.9);
    }
    await captureUiScreenshot(page, testInfo, "home-viewport");
    await expect(
      page.getByRole("heading", { name: "Built with golfers, not just for them." })
    ).toBeVisible();
    const homeSearchForm = page.locator(".home-search-form");
    const homeLocation = homeSearchForm.locator('input[name="location"]');
    await expect(homeLocation).toHaveValue("");
    await expect(homeLocation).toHaveAttribute(
      "placeholder",
      "City, state, ZIP, or address"
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

    const feedbackLauncher = page.getByRole("button", { name: "Open feedback form" });
    await feedbackLauncher.focus();
    await feedbackLauncher.press("Enter");
    const feedbackDialog = page.getByRole("dialog", { name: "Send feedback" });
    await expect(feedbackDialog).toBeVisible();
    await expect(page.getByRole("button", { name: "Close feedback" })).toBeFocused();
    await expect(page.getByText("Have a product suggestion?", { exact: true })).toBeVisible();
    await expect(page.locator('a[href="https://discord.gg/ThexF85xCd"]')).toHaveCount(4);
    await feedbackDialog.getByRole("button", { name: "Send feedback" }).focus();
    await page.keyboard.press("Tab");
    expect(
      await feedbackDialog.evaluate((dialog) => dialog.contains(document.activeElement)),
      "the intentionally non-modal panel should still close after focus moves back to the page"
    ).toBe(false);
    await page.keyboard.press("Escape");
    await expect(feedbackDialog).toBeHidden();
    await expect(feedbackLauncher).toBeFocused();

    const homeDistance = homeSearchForm.getByRole("slider", { name: "Distance from me" });
    await expect(homeDistance).toHaveAttribute("min", "5");
    await expect(homeDistance).toHaveAttribute("max", "30");
    await expect(homeDistance).toHaveAttribute("step", "5");

    if (testInfo.project.name.includes("mobile")) {
      const actionMetrics = await homeSearchForm.locator(".home-form-actions .button").evaluateAll(
        (buttons) =>
          buttons.map((button) => ({
            clientWidth: button.clientWidth,
            right: button.getBoundingClientRect().right,
            scrollWidth: button.scrollWidth
          }))
      );
      const viewportWidth = page.viewportSize()?.width ?? 0;
      expect(actionMetrics.every((button) => button.scrollWidth <= button.clientWidth + 1)).toBe(
        true
      );
      expect(actionMetrics.every((button) => button.right <= viewportWidth + 1)).toBe(true);
    }

    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = "auto";
      window.scrollTo(0, 0);
    });
    await captureUiScreenshot(page, testInfo, "home", true);

    await expectNoHorizontalOverflow(page, testInfo);
  });

  test("publishes canonical trust and golf guide pages without layout regressions", async ({
    page
  }, testInfo) => {
    const issues = collectPageIssues(page);
    const publicPages = [
      ["/how-it-works", "A tee-time alert, not another booking marketplace."],
      ["/about", "Public golf openings should not require constant refreshing."],
      ["/methodology", "How Tee Time Spot decides what it can responsibly watch."],
      ["/guides", "Book smarter. Refresh less."],
      ["/guides/tee-time-cancellation-alerts", "How public golf tee times come back—and how alerts help."],
      ["/guides/public-golf-booking-windows", "The release clock matters before the cancellation watch begins."],
      ["/guides/tee-time-alerts-vs-auto-booking", "Notification and reservation are fundamentally different jobs."],
      ["/contact", "Questions, corrections, and course tips are welcome."],
      ["/privacy", "A plain-language privacy notice for Tee Time Spot."],
      ["/terms", "Terms for an alert service—not a booking transaction."]
    ] as const;

    for (const [route, heading] of publicPages) {
      await page.goto(route, { waitUntil: "networkidle" });
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        "href",
        `https://teetimespot.com${route}`
      );
      await expectNoHorizontalOverflow(page, testInfo);
    }

    await expectNoPageIssues(issues, testInfo);
  });

  test("keeps compact navigation accessible and prioritizes the search hero", async ({
    page
  }, testInfo) => {
    await page.goto("/search");

    const navigation = page.locator(".nav-actions");
    await expect(navigation.getByRole("link", { name: "My alerts" })).toHaveAttribute(
      "href",
      "/dashboard"
    );
    await expect(navigation.getByRole("link", { name: "Find a tee time" })).toHaveAttribute(
      "href",
      "/search"
    );

    const heroImage = page.locator(".search-page-header-image");
    await expect(heroImage).toHaveAttribute("alt", "");
    await expect(heroImage).toHaveAttribute("fetchpriority", "high");
    await expect(heroImage).toHaveAttribute("loading", "eager");
    await expect(heroImage).toHaveAttribute("sizes", "100vw");

    const headerHeroSeam = await page.evaluate(() => {
      const topbar = document.querySelector<HTMLElement>(".topbar")?.getBoundingClientRect();
      const hero = document
        .querySelector<HTMLElement>(".search-page-header")
        ?.getBoundingClientRect();

      return topbar && hero ? hero.top - topbar.bottom : null;
    });
    expect(headerHeroSeam).not.toBeNull();
    expect(headerHeroSeam ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1);

    if (testInfo.project.name.includes("mobile")) {
      await expect(page.locator(".feedback-widget")).toHaveCSS("position", "static");
    }
  });

  test("transfers homepage search details without putting them in the URL", async ({ page }) => {
    await page.goto("/");
    const homeSearchForm = page.locator(".home-search-form");
    await expect(homeSearchForm.getByLabel("Alert email")).toHaveCount(0);
    await homeSearchForm.getByLabel("Location").fill("06825");
    await homeSearchForm.locator("select").selectOption("2");
    await homeSearchForm.getByRole("button", { name: "Browse courses" }).click();

    await expect(page).toHaveURL(/\/search$/);
    expect(new URL(page.url()).search).toBe("");
    await expect(page.getByRole("textbox", { name: "Location", exact: true })).toHaveValue(
      "06825"
    );
    await expect(page.getByLabel("Players")).toHaveValue("2");
  });

  test("restores an unfinished course search after navigation and refresh", async ({ page }) => {
    test.skip(!useMockedSearchProviders, "This persistence check uses deterministic course fixtures.");
    await page.route("**/api/location/geocode?**", async (route) => {
      await route.fulfill({
        body: JSON.stringify({ latitude: 41.24, longitude: -73.2 }),
        contentType: "application/json",
        status: 200
      });
    });
    await page.route("**/api/courses/discover?**", async (route) => {
      await route.fulfill({
        body: JSON.stringify({ courses: smokeCourses }),
        contentType: "application/json",
        status: 200
      });
    });
    await mockSmokeCoursePhotos(page);

    await page.goto("/search");
    await page.getByRole("textbox", { name: "Location", exact: true }).fill("Trumbull, CT");
    await page.getByRole("button", { name: /^Search$/i }).click();
    await expect(page.getByRole("heading", { name: smokeCourses[0].name }).first()).toBeVisible();
    await page.getByRole("button", { name: `Add ${smokeCourses[0].name}` }).click();
    await page.getByRole("button", { name: `Add ${smokeCourses[1].name}` }).click();
    const moveSecondCourseUp = page.locator(
      `button[aria-label="Move ${smokeCourses[1].name} up"]`
    );
    if (!(await moveSecondCourseUp.isVisible())) {
      await page.locator(".mobile-selection-toggle").click();
    }
    await moveSecondCourseUp.click();

    const selectedCourseNames = page.locator(".selected-list .selected-row h3");
    await expect(selectedCourseNames).toHaveText([smokeCourses[1].name, smokeCourses[0].name]);
    await expect.poll(() =>
      page.evaluate(() => window.sessionStorage.getItem("tee-time-spot:search-draft:v1"))
    ).toContain("ui-smoke-course-2");

    await page.goto("/about");
    await page.goto("/search");
    await expect(page.getByRole("textbox", { name: "Location", exact: true })).toHaveValue(
      "Trumbull, CT"
    );
    await expect(selectedCourseNames).toHaveText([smokeCourses[1].name, smokeCourses[0].name]);

    await page.reload();
    await expect(selectedCourseNames).toHaveText([smokeCourses[1].name, smokeCourses[0].name]);
    await expect(
      page.locator(`button[aria-label="Move ${smokeCourses[1].name} up"]`)
    ).toBeDisabled();
  });

  test("restores validated direct-link search details on the static route", async ({ page }) => {
    const issues = collectPageIssues(page);
    await page.route("**/api/location/geocode?**", async (route) => {
      await route.fulfill({
        body: JSON.stringify({ latitude: 38.9399, longitude: -119.9772 }),
        contentType: "application/json",
        status: 200
      });
    });
    await mockSmokeCoursePhotos(page);
    await page.route("**/api/courses/discover?**", async (route) => {
      await route.fulfill({
        body: JSON.stringify({ courses: smokeCourses }),
        contentType: "application/json",
        status: 200
      });
    });

    const date = nextSaturdayDateInputValue();
    await page.goto(
      `/search?location=South%20Lake%20Tahoe%2C%20CA&players=2&date=${date}&startTime=08%3A30&endTime=12%3A00&holes=18&radius=25&latitude=38.9399&longitude=-119.9772`
    );

    await expect(page.getByRole("textbox", { name: "Location", exact: true })).toHaveValue(
      "South Lake Tahoe, CA"
    );
    await expect(page.locator("#players")).toHaveValue("2");
    await expect(page.locator("#date")).toHaveValue(date);
    await expect(page.locator("#startTime")).toHaveValue("08:30");
    await expect(page.locator("#endTime")).toHaveValue("12:00");
    await expect(page.locator("#searchRadius")).toHaveValue("25");
    await expect(page.getByRole("button", { name: "18-hole" })).toHaveClass(/is-active/);

    const discoveryRequest = page.waitForRequest((request) =>
      request.url().includes("/api/courses/discover?")
    );
    await page.getByRole("button", { name: /^Search$/i }).click();
    const discoveryUrl = new URL((await discoveryRequest).url());
    expect(discoveryUrl.searchParams.get("latitude")).toBe("38.9399");
    expect(discoveryUrl.searchParams.get("longitude")).toBe("-119.9772");
    expect(discoveryUrl.searchParams.get("radiusMeters")).toBe("40234");
    await expectNoPageIssues(issues, test.info());
  });

  test("keeps search labels and supporting copy at AA contrast colors", async ({ page }) => {
    await page.goto("/search");

    await expect(page.locator(".figma-search-field > label").first()).toHaveCSS(
      "color",
      "rgb(69, 103, 93)"
    );
    await expect(page.locator(".figma-hole-options button").filter({ hasText: "9-hole" })).toHaveCSS(
      "color",
      "rgb(69, 103, 93)"
    );
    await expect(page.locator(".figma-distance-filter em").first()).toHaveCSS(
      "color",
      "rgb(76, 106, 97)"
    );
    await expect(page.locator(".missing-course-heading > p")).toHaveCSS(
      "color",
      "rgb(83, 109, 101)"
    );
    await expect(page.locator(".missing-course-form > label")).toHaveCSS(
      "color",
      "rgb(80, 107, 98)"
    );
    await expect(page.locator(".site-footer-bottom p")).toHaveCSS(
      "color",
      "rgba(255, 255, 255, 0.65)"
    );
  });

  test("keeps homepage supporting text at AA contrast colors", async ({ page }) => {
    await page.goto("/");

    await expect(page.locator(".scenario-section .eyebrow")).toHaveCSS(
      "color",
      "rgb(109, 191, 156)"
    );
    await expect(page.locator(".scenario-plan > .scenario-label")).toHaveCSS(
      "color",
      "rgb(163, 170, 167)"
    );
    await expect(page.locator(".scenario-result > .scenario-label")).toHaveCSS(
      "color",
      "rgb(109, 191, 156)"
    );
    await expect(page.locator(".home-form-row-primary label > span")).toHaveCSS(
      "color",
      "rgb(85, 113, 106)"
    );
    await expect(page.locator(".home-distance-filter em").first()).toHaveCSS(
      "color",
      "rgb(95, 116, 110)"
    );
    await expect(page.getByRole("button", { name: "9-hole" })).toHaveCSS(
      "color",
      "rgb(95, 116, 110)"
    );
    await expect(page.locator(".home-course-summary > div")).toHaveCSS(
      "color",
      "rgb(149, 160, 166)"
    );
    await expect(page.locator(".home-course-summary > small")).toHaveCSS(
      "color",
      "rgb(149, 160, 166)"
    );
    await expect(page.locator(".community-eyebrow > p")).toHaveCSS(
      "color",
      "rgb(255, 255, 255)"
    );
    await expect(page.locator(".community-action > span")).toHaveCSS(
      "color",
      "rgb(255, 255, 255)"
    );
  });

  test("shows when the current location has been selected", async ({ context, page }) => {
    await context.grantPermissions(["geolocation"], { origin: smokeOrigin });
    await context.setGeolocation({ latitude: 41.242, longitude: -73.209 });
    let discoveryRequests = 0;
    let geocodeRequests = 0;
    await page.route("**/api/courses/discover?**", async (route) => {
      discoveryRequests += 1;
      await route.fulfill({
        body: JSON.stringify({ courses: [] }),
        contentType: "application/json",
        status: 200
      });
    });
    await page.route("**/api/location/geocode?**", async (route) => {
      geocodeRequests += 1;
      await route.abort();
    });

    await page.goto("/search");
    const searchLocation = page.getByRole("textbox", { name: "Location", exact: true });
    await page.getByRole("button", { name: "Use current location" }).click();
    await expect(searchLocation).toHaveValue("Current location");
    await expect(
      page.getByRole("status").filter({ hasText: "Current location selected" })
    ).toBeVisible();
    expect(discoveryRequests).toBe(0);

    await page.getByLabel("Players").selectOption("2");
    await page.getByRole("button", { name: /^Search$/i }).click();
    await expect.poll(() => discoveryRequests).toBe(1);
    expect(geocodeRequests).toBe(0);

    await page.goto("/");
    await page.getByRole("button", { name: "Use my location" }).click();
    await expect(page).toHaveURL(/\/search$/);
    expect(new URL(page.url()).search).toBe("");
    await expect(page.getByRole("textbox", { name: "Location", exact: true })).toHaveValue(
      "Current location"
    );
    await page.waitForTimeout(200);
    expect(discoveryRequests).toBe(1);

    await page.getByRole("button", { name: /^Search$/i }).click();
    await expect.poll(() => discoveryRequests).toBe(2);
    expect(geocodeRequests).toBe(0);
  });

  test("describes an invalid location without exposing an API payload", async ({ page }) => {
    await page.route("**/api/location/geocode?**", async (route) => {
      await route.fulfill({
        body: JSON.stringify({
          error:
            "We couldn't find that location. Check the city, state, or ZIP code and try again."
        }),
        contentType: "application/json",
        status: 404
      });
    });

    await page.goto("/search");
    const locationInput = page.getByRole("textbox", { name: "Location", exact: true });
    await locationInput.fill("zzzz invalid location 00000");
    await page.getByRole("button", { name: /^Search$/i }).click();

    const error = page.locator("#location-search-error");
    await expect(error).toHaveText(
      "We couldn't find that location. Check the city, state, or ZIP code and try again."
    );
    await expect(error).not.toContainText('{"error"');
    await expect(locationInput).toHaveAttribute("aria-invalid", "true");
    await expect(locationInput).toHaveAttribute("aria-describedby", "location-search-error");
  });

  test("turns a zero-result search into a bounded wider search", async ({ page }) => {
    const requestedRadii: string[] = [];
    let releaseWiderSearch!: () => void;
    const widerSearchRelease = new Promise<void>((resolve) => {
      releaseWiderSearch = resolve;
    });
    await page.route("**/api/location/geocode?**", async (route) => {
      await route.fulfill({
        body: JSON.stringify({ latitude: 45.52, longitude: -109.44 }),
        contentType: "application/json",
        status: 200
      });
    });
    await page.route("**/api/courses/discover?**", async (route) => {
      const requestedRadius = new URL(route.request().url()).searchParams.get("radiusMeters") ?? "";
      requestedRadii.push(requestedRadius);
      if (requestedRadius === "48280") {
        await widerSearchRelease;
      }
      await route.fulfill({
        body: JSON.stringify({ courses: [] }),
        contentType: "application/json",
        status: 200
      });
    });

    await page.goto("/search");
    const distance = page.getByRole("slider", { name: "Distance from me" });
    await expect(distance).toHaveAttribute("min", "5");
    await expect(distance).toHaveAttribute("max", "30");
    await expect(distance).toHaveAttribute("step", "5");
    await expect(distance).toHaveValue("15");

    await page.getByRole("textbox", { name: "Location", exact: true }).fill("59001");
    await page.getByRole("button", { name: /^Search$/i }).click();
    await expect(
      page.getByRole("heading", { name: "No public courses found within 15 miles." })
    ).toBeVisible();

    await page.getByRole("button", { name: "Search 30 miles" }).click();
    await expect(distance).toHaveValue("30");
    await expect(page.getByRole("status")).toHaveText(
      "Searching public courses within 30 miles…"
    );
    await expect(
      page.getByRole("heading", { name: "No public courses found within 30 miles." })
    ).toHaveCount(0);

    releaseWiderSearch();
    await expect(
      page.getByRole("heading", { name: "No public courses found within 30 miles." })
    ).toBeVisible();
    await expect(
      page.getByText("You searched the full 30-mile range.", { exact: false })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Search", exact: true })).toBeEnabled();
    expect(requestedRadii).toEqual(["24140", "48280"]);
  });

  test("uses singular result copy and keeps mobile search controls readable", async ({
    context,
    page
  }, testInfo) => {
    await context.grantPermissions(["geolocation"], { origin: smokeOrigin });
    await context.setGeolocation({ latitude: 43.7667, longitude: -103.5988 });
    await page.route("**/api/courses/discover?**", async (route) => {
      await route.fulfill({
        body: JSON.stringify({
          courses: [
            {
              googlePlaceId: "ui-smoke-single-course",
              name: "Rocky Knolls Golf Course",
              address: "25153 Wazi Ln, Custer, SD 57730",
              latitude: 43.7667,
              longitude: -103.5988,
              distanceMeters: 3100,
              website: "https://example.com/rocky-knolls"
            }
          ]
        }),
        contentType: "application/json",
        status: 200
      });
    });

    await page.goto("/search");

    const filterLayout = await page.locator(".figma-search-toolbar").evaluate((toolbar) => {
      const box = (selector: string) => {
        const element = toolbar.querySelector<HTMLElement>(selector);
        const rect = element?.getBoundingClientRect();
        return rect
          ? { bottom: rect.bottom, height: rect.height, left: rect.left, top: rect.top, width: rect.width }
          : null;
      };

      return {
        dateField: box('label[for="date"]'),
        distance: box(".figma-distance-group"),
        holes: box(".figma-hole-filter"),
        location: box(".figma-location-field"),
        players: box('label[for="players"]'),
        search: box(".figma-search-submit"),
        time: box(".figma-time-field"),
        toolbar: toolbar.getBoundingClientRect().toJSON()
      };
    });

    expect(filterLayout.location).not.toBeNull();
    expect(filterLayout.players).not.toBeNull();
    expect(filterLayout.dateField).not.toBeNull();
    expect(filterLayout.time).not.toBeNull();
    expect(filterLayout.holes).not.toBeNull();
    expect(filterLayout.distance).not.toBeNull();
    expect(filterLayout.search).not.toBeNull();
    expect(Math.abs(filterLayout.players!.top - filterLayout.dateField!.top)).toBeLessThan(2);
    expect(Math.abs(filterLayout.time!.top - filterLayout.holes!.top)).toBeLessThan(2);
    if (testInfo.project.name.includes("mobile")) {
      expect(filterLayout.location!.width).toBeGreaterThan(filterLayout.players!.width * 1.9);
      expect(filterLayout.players!.top).toBeGreaterThan(filterLayout.location!.bottom - 2);
      expect(filterLayout.distance!.top).toBeGreaterThan(filterLayout.time!.bottom - 2);
      expect(filterLayout.search!.top).toBeGreaterThan(filterLayout.distance!.bottom - 2);
      expect(filterLayout.search!.width).toBeGreaterThan(filterLayout.location!.width * 0.9);
    } else {
      expect(Math.abs(filterLayout.location!.top - filterLayout.players!.top)).toBeLessThan(2);
      expect(Math.abs(filterLayout.location!.width - filterLayout.players!.width * 2)).toBeLessThan(2);
      expect(Math.abs(filterLayout.players!.width - filterLayout.dateField!.width)).toBeLessThan(2);
      expect(Math.abs(filterLayout.time!.top - filterLayout.distance!.top)).toBeLessThan(2);
      expect(filterLayout.search!.top).toBeGreaterThanOrEqual(filterLayout.time!.top);
      expect(filterLayout.search!.bottom).toBeLessThanOrEqual(filterLayout.distance!.bottom + 2);
    }
    await expect(page.locator(".figma-search-submit")).toHaveCSS(
      "background-color",
      "rgb(217, 134, 47)"
    );
    await expect(page.locator(".figma-search-submit")).toHaveCSS("color", "rgb(255, 255, 255)");

    await page.getByRole("button", { name: "Use current location" }).click();
    await page.getByRole("button", { name: /^Search$/i }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "1 course near Current location" })
    ).toBeVisible();
  });

  test("matches the Figma card font, photo, and metadata row", async ({ page }, testInfo) => {
    test.skip(!useMockedSearchProviders, "This visual contract uses deterministic course fixtures.");
    const issues = collectPageIssues(page);
    await mockSmokeCourseSearch(page);
    await page.goto("/search");

    const locationInput = page.getByRole("textbox", { name: "Location", exact: true });
    await locationInput.fill("Trumbull, CT");
    await locationInput.press("Enter");

    const firstCourse = page.locator(".course-row").first();
    await expect(firstCourse).toBeVisible();
    await expect.poll(async () =>
      firstCourse.locator("img.course-thumbnail").evaluate((image) => {
        const element = image as HTMLImageElement;
        return element.complete && element.naturalWidth > 0;
      })
    ).toBe(true);
    await expect(firstCourse.getByText("Public", { exact: true })).toBeVisible();
    await expect(firstCourse.getByText("4.3", { exact: true })).toBeVisible();
    await expect(firstCourse.getByText(/3\.2 mi/)).toBeVisible();
    await expect(firstCourse.getByText(/18H/)).toBeVisible();
    await expect(firstCourse.getByText(/9H/)).toHaveCount(0);
    await expect(firstCourse.getByText(/Par 72/)).toBeVisible();
    await expect(firstCourse.getByLabel("Estimated 18-hole course cost $48")).toBeVisible();
    const addButton = firstCourse.getByRole("button", { name: /Add Tashua Knolls/i });
    await expect(addButton).toHaveText("+ Add to my list");
    expect(await addButton.evaluate((button) => ({
      backgroundColor: window.getComputedStyle(button).backgroundColor,
      color: window.getComputedStyle(button).color
    }))).toEqual({
      backgroundColor: "rgb(18, 30, 39)",
      color: "rgb(255, 255, 255)"
    });
    expect(await firstCourse.evaluate((card) => window.getComputedStyle(card).fontFamily)).toMatch(
      /Inter/i
    );
    const verifiedEighteenHoleCourse = page.locator(".course-row").filter({
      hasText: "H. Smith Richardson Golf Course"
    });
    await expect(verifiedEighteenHoleCourse.getByText(/18H/)).toBeVisible();
    await expect(verifiedEighteenHoleCourse.getByText(/9H/)).toHaveCount(0);
    await expect(verifiedEighteenHoleCourse.getByText(/Par 72/)).toBeVisible();
    await expect(verifiedEighteenHoleCourse.locator(".figma-course-pill.is-price")).toHaveCount(0);
    await expectNoPageIssues(issues, testInfo);
  });

  test("onboarding discovery, ranking limit, and controls are usable", async ({
    page
  }, testInfo) => {
    const issues = collectPageIssues(page);
    const isMobile = testInfo.project.name.includes("mobile");
    const usesSelectionDrawer = (page.viewportSize()?.width ?? 1440) <= 920;

    if (useMockedSearchProviders) {
      await mockSmokeCourseSearch(page);
    }

    await page.goto("/search");
    let discoveryAnalyticsPayload: {
      name?: string;
      page?: string;
      trafficClass?: string;
      metadata?: Record<string, unknown>;
    } | null = null;
    let selectionStartedAnalyticsPayload: {
      name?: string;
      page?: string;
      trafficClass?: string;
      metadata?: Record<string, unknown>;
    } | null = null;
    let signInAnalyticsPayload: {
      name?: string;
      page?: string;
      trafficClass?: string;
      metadata?: Record<string, unknown>;
    } | null = null;
    await page.route("**/api/analytics/events", async (route) => {
      const payload = route.request().postDataJSON() as {
        name?: string;
        page?: string;
        trafficClass?: string;
        metadata?: Record<string, unknown>;
      };
      if (payload.name === "course_discovery_completed") {
        discoveryAnalyticsPayload = payload;
      } else if (payload.name === "course_selection_started") {
        selectionStartedAnalyticsPayload = payload;
      } else if (payload.name === "alert_sign_in_clicked") {
        signInAnalyticsPayload = payload;
      }
      await route.fulfill({
        body: JSON.stringify({ event: { id: "ui-smoke-event" } }),
        contentType: "application/json",
        status: 201
      });
    });

    await expect(
      page.getByRole("heading", { name: /Tell us where and when you want to play/i })
    ).toBeVisible();
    const timeWindowGroup = page.getByRole("group", {
      name: "Time window",
      exact: true
    });
    await expect(timeWindowGroup).toBeVisible();
    await expect(timeWindowGroup.locator(".figma-time-label")).toHaveText("Time");
    await expect(page.locator("#time-window-help")).toHaveText(
      "Times use each course's local time zone."
    );
    const alertActionButton = page.locator(".summary-panel > .button-primary");
    await expect(alertActionButton).toContainText(
      /Start getting alerts|Sign in to start sending alerts|Account access unavailable|Checking your account/i
    );
    if (usesSelectionDrawer) {
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
      "City, state, ZIP, or address"
    );
    const courseSearchButton = page.getByRole("button", { name: /^Search$/i });
    await expect(courseSearchButton).toBeDisabled();
    await expect(page.locator("#players")).toHaveValue("4");
    await expect(page.locator("#date")).toHaveValue(nextSaturdayDateInputValue());
    await expect(page.locator("#startTime")).toHaveValue("09:00");
    await expect(page.locator("#endTime")).toHaveValue("18:00");
    await expect(page.locator("#searchRadius")).toHaveValue("15");
    const timeSummary = page.getByRole("button", { name: "9 AM – 6 PM" });
    await expect(timeSummary).toBeVisible();
    await expect(page.locator("#startTime")).toBeHidden();
    await timeSummary.click();
    await expect(page.locator("#startTime")).toBeVisible();
    await expect(page.locator("#endTime")).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.locator("#startTime")).toBeHidden();

    await locationInput.fill("Trumbull, CT");
    await expect(courseSearchButton).toBeEnabled();
    const discoveryRequest = page.waitForRequest((request) =>
      request.url().includes("/api/courses/discover?")
    );
    await locationInput.press("Enter");
    const discoveryUrl = new URL((await discoveryRequest).url());
    expect(discoveryUrl.searchParams.get("radiusMeters")).toBe("24140");
    await expect.poll(() => discoveryAnalyticsPayload).toMatchObject({
      name: "course_discovery_completed",
      page: "/search",
      trafficClass: "AUTOMATION",
      metadata: {
        radiusMiles: 15,
        resultCount: useMockedSearchProviders ? smokeCourses.length : expect.any(Number),
        demo: false
      }
    });
    const discoveryStatus = page.getByRole("status").filter({ hasText: /\d+ courses near Trumbull/i });
    await expect(discoveryStatus).toContainText(/\d+ courses near Trumbull/i);
    await expect
      .poll(async () => {
        const statusBox = await discoveryStatus.boundingBox();
        const topbarBox = await page.locator(".topbar").boundingBox();
        if (!statusBox || !topbarBox) {
          return -1;
        }
        return Math.round(statusBox.y - (topbarBox.y + topbarBox.height));
      })
      .toBeGreaterThanOrEqual(0);
    const firstCourse = page.locator(".course-row").first();
    await expect(firstCourse).toBeVisible();
    await expect(firstCourse.locator(".course-monitoring-status")).toBeVisible();
    if (useMockedSearchProviders) {
      await expect.poll(async () =>
        firstCourse.locator("img.course-thumbnail").evaluate((image) => {
          const element = image as HTMLImageElement;
          return element.complete && element.naturalWidth > 0;
        })
      ).toBe(true);
      await expect(firstCourse.getByText("Public", { exact: true })).toBeVisible();
      await expect(firstCourse.getByText("4.3", { exact: true })).toBeVisible();
      await expect(firstCourse.getByText(/18H/)).toBeVisible();
      await expect(firstCourse.getByText(/Par 72/)).toBeVisible();
      await expect(firstCourse.getByText("Automatic availability alerts", { exact: true })).toBeVisible();
      await expect(
        page.locator(".course-row").nth(1).getByText("Automatic alerts not yet confirmed", {
          exact: true
        })
      ).toBeVisible();
      await expect(
        firstCourse.getByRole("link", { name: /Open official site for/i })
      ).toBeVisible();
      await expect(
        firstCourse.getByRole("link", {
          name: "View course guide for Tashua Knolls Golf Course"
        })
      ).toHaveAttribute("href", "/courses/tashua-knolls-golf-course-trumbull-ct");
      await expect(
        page.locator(".course-row").nth(1).getByRole("link", { name: /View course guide for/i })
      ).toHaveCount(0);
    }
    const firstCourseCardLayout = await firstCourse.evaluate((card) => {
      const thumbnail = card.querySelector<HTMLElement>(".course-thumbnail");
      const copy = card.querySelector<HTMLElement>(".course-copy");
      const actions = card.querySelector<HTMLElement>(".course-actions");
      const cardBox = card.getBoundingClientRect();
      const thumbnailBox = thumbnail?.getBoundingClientRect();
      const copyBox = copy?.getBoundingClientRect();
      const actionsBox = actions?.getBoundingClientRect();
      return {
        actionsDirection: actions ? window.getComputedStyle(actions).flexDirection : "",
        cardHeight: cardBox.height,
        cardTop: cardBox.top,
        copyTop: copyBox?.top ?? -1,
        thumbnailHeight: thumbnailBox?.height ?? -1,
        thumbnailTop: thumbnailBox?.top ?? -1,
        thumbnailWidth: thumbnailBox?.width ?? -1,
        actionsTop: actionsBox?.top ?? -1
      };
    });
    expect(firstCourseCardLayout.actionsDirection).toBe("column");
    expect(firstCourseCardLayout.thumbnailWidth).toBe(isMobile ? 88 : 110);
    expect(firstCourseCardLayout.thumbnailHeight).toBeGreaterThanOrEqual(
      firstCourseCardLayout.cardHeight - 4
    );
    expect(Math.abs(firstCourseCardLayout.thumbnailTop - firstCourseCardLayout.cardTop)).toBeLessThan(3);
    expect(Math.abs(firstCourseCardLayout.copyTop - firstCourseCardLayout.cardTop)).toBeLessThan(3);
    expect(Math.abs(firstCourseCardLayout.actionsTop - firstCourseCardLayout.cardTop)).toBeLessThan(3);
    const resultsLayout = await page.locator(".figma-results-column").evaluate((column) => {
      const status = column.querySelector<HTMLElement>(".figma-results-banner");
      const course = column.querySelector<HTMLElement>(".course-row");
      const statusBox = status?.getBoundingClientRect();
      const courseBox = course?.getBoundingClientRect();
      return {
        courseTop: courseBox?.top ?? -1,
        statusBottom: statusBox?.bottom ?? -1
      };
    });
    expect(resultsLayout.courseTop).toBeGreaterThanOrEqual(resultsLayout.statusBottom);
    expect(resultsLayout.courseTop - resultsLayout.statusBottom).toBeLessThan(120);
    if (usesSelectionDrawer) {
      const firstCourseBox = await page.locator(".course-row").first().boundingBox();
      expect(firstCourseBox).not.toBeNull();
      expect(firstCourseBox!.width).toBeGreaterThan((page.viewportSize()?.width ?? 910) * 0.8);
    }
    await captureUiScreenshot(page, testInfo, "search-results");

    const courseRows = page.locator(".course-row");
    const courseCount = await courseRows.count();
    expect(courseCount, "course discovery should return enough rows to exercise ranking limits").toBeGreaterThanOrEqual(6);
    await expect(page.locator(".course-results-map-shell")).toHaveCount(0);
    await expect(page.locator(".course-results-map-frame")).toHaveCount(0);
    await expect(page.locator(".course-results-map-overlay")).toHaveCount(0);
    await expect(courseRows.nth(0).locator(".course-address-link")).toBeVisible();
    await expect(courseRows.nth(0).getByRole("link", { name: "Google Maps" })).toHaveCount(0);
    await expect(page.getByText(/^Photo:/)).toHaveCount(0);
    if (isMobile) {
      const courseActionHeights = await courseRows
        .first()
        .locator(".course-actions a, .course-actions button")
        .evaluateAll((actions) => actions.map((action) => action.getBoundingClientRect().height));
      expect(courseActionHeights.length).toBeGreaterThan(0);
      expect(courseActionHeights.every((height) => height >= 44)).toBe(true);
    }
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
    await expect.poll(() => selectionStartedAnalyticsPayload).toMatchObject({
      name: "course_selection_started",
      page: "/search",
      trafficClass: "AUTOMATION",
      metadata: {
        selectedCourseCount: 1,
        players: 4,
        requestedLayoutHoles: null
      }
    });
    if (!usesSelectionDrawer) {
      const selectedName = page.locator(".selected-list .selected-row h3");
      await expect(selectedName).toBeVisible();
      expect(
        await selectedName.evaluate(
          (heading) => heading.scrollWidth <= heading.clientWidth + 1
        )
      ).toBe(true);
    }
    if (usesSelectionDrawer) {
      const mobileSelectionBar = page.locator(".mobile-selection-bar");
      await expect(mobileSelectionBar).toBeVisible();
      await expect(mobileSelectionBar).toHaveCSS("background-color", "rgb(17, 26, 34)");
      await expect(page.locator(".mobile-selection-toggle")).toContainText("1 course picked");
      await expect(page.locator(".mobile-selection-toggle")).toContainText("Reorder priority");
      const submitCoursesButton = mobileSelectionBar.getByRole("button", {
        name: "Review alert"
      });
      await expect(submitCoursesButton).toBeVisible();
      await expect(submitCoursesButton).toHaveCSS("background-color", "rgb(255, 205, 77)");
      expect((await submitCoursesButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      await captureUiElementScreenshot(
        mobileSelectionBar,
        testInfo,
        "mobile-selection-bar"
      );
      const mobileBarStyles = await mobileSelectionBar.evaluate((element) => {
        const styles = window.getComputedStyle(element);
        return {
          borderTopColor: styles.borderTopColor,
          borderTopWidth: styles.borderTopWidth,
          boxShadow: styles.boxShadow
        };
      });
      expect(mobileBarStyles.borderTopWidth).toBe("2px");
      expect(mobileBarStyles.borderTopColor).toBe("rgb(226, 138, 47)");
      expect(mobileBarStyles.boxShadow).toContain("rgba(226, 138, 47");
    }
    expect(
      await courseRows.locator("h3").allTextContents(),
      "adding a course should preserve the discovery order so users can keep moving through the list"
    ).toEqual(courseOrderBeforeSelection);
    await laterCourse.getByRole("button", { name: /Remove/i }).click();
    await expect(page.locator(".selected-list .selected-row")).toHaveCount(0);

    await page.route("**/api/courses/lookup?**", async (route) => {
      const lookupQuery = new URL(route.request().url()).searchParams.get("q");
      await route.fulfill({
        contentType: "application/json",
        status: 200,
        body: JSON.stringify({
          courses: lookupQuery === "Known Course, Somewhere CT" ? [] : [
            {
              googlePlaceId: "ui-smoke-missing-course",
              name: "Bethpage Black Course",
              address: "99 Quaker Meeting House Rd, Farmingdale, NY",
              latitude: 40.744,
              longitude: -73.456,
              distanceMeters: 78000,
              profileUrl: "/courses/bethpage-black-course-farmingdale-ny",
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
            },
            {
              googlePlaceId: "ui-smoke-direct-online",
              name: "Yale University Golf Course",
              address: "200 Conrad Dr, New Haven, CT",
              latitude: 41.3187,
              longitude: -72.9854,
              distanceMeters: 32000,
              website: "https://app.whoosh.io/patron/club/yale-golf-course",
              alertSupport: "DIRECT_ONLINE"
            }
          ]
        })
      });
    });
    const missingCourseInput = page.getByRole("searchbox", { name: "Course name", exact: true });
    await missingCourseInput.fill("Bethpage Black, Farmingdale NY");
    await page.getByRole("button", { name: "Find course" }).click();
    await expect(page.getByRole("status").filter({ hasText: "3 matches found" })).toBeVisible();
    const missingCourseResults = page.locator(".missing-course-result");
    await expect(
      missingCourseResults.getByText("Photo unavailable"),
      "photo-less lookup results should show an intentional placeholder instead of an empty media block"
    ).toHaveCount(3);
    await expect(
      missingCourseResults
        .filter({ has: page.getByRole("heading", { name: "Bethpage Black Course" }) })
        .getByRole("link", { name: "View course guide for Bethpage Black Course" })
    ).toHaveAttribute("href", "/courses/bethpage-black-course-farmingdale-ny");
    const blockedCourseResult = missingCourseResults.filter({
      has: page.getByRole("heading", { name: "Fairview Farm Golf Course" })
    });
    await expect(blockedCourseResult).toContainText("Phone only");
    await expect(
      blockedCourseResult.getByRole("link", { name: /Open official site for Fairview Farm/i })
    ).toBeVisible();
    await expect(blockedCourseResult.locator(".figma-course-pill.is-public")).toHaveText("Public");
    const directOnlineCourseResult = missingCourseResults.filter({
      has: page.getByRole("heading", { name: "Yale University Golf Course" })
    });
    await expect(directOnlineCourseResult).toContainText("Book online directly");
    await expect(directOnlineCourseResult).toContainText(
      "official booking page to check availability and book"
    );
    await expect(
      directOnlineCourseResult.getByRole("link", {
        name: /Open official site for Yale University Golf Course/i
      })
    ).toHaveAttribute("href", "https://app.whoosh.io/patron/club/yale-golf-course");
    if (isMobile) {
      const resultBox = await blockedCourseResult.boundingBox();
      const thumbnailBox = await blockedCourseResult.locator(".course-thumbnail").boundingBox();
      expect(resultBox).not.toBeNull();
      expect(thumbnailBox).not.toBeNull();
      expect(resultBox!.height, "manual course results should stay compact on mobile").toBeLessThan(360);
      expect(thumbnailBox!.width).toBeGreaterThan(resultBox!.width - 4);
      expect(Math.abs(thumbnailBox!.y - resultBox!.y)).toBeLessThan(2);
    }
    await blockedCourseResult.getByRole("button", { name: "Add Fairview Farm Golf Course" }).click();
    if (usesSelectionDrawer) {
      await page.locator(".mobile-selection-toggle").click();
    }
    await expect(page.getByText("Choose at least one course Tee Time Spot can monitor automatically.")).toBeVisible();
    if (usesSelectionDrawer) {
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

    await page.route("**/api/feedback", async (route) => {
      await route.fulfill({
        body: JSON.stringify({ feedback: { id: "ui-smoke-course-miss" } }),
        contentType: "application/json",
        status: 201
      });
    });
    const courseMissReport = page.waitForRequest(
      (request) => request.url().includes("/api/feedback") && request.method() === "POST"
    );
    await missingCourseInput.fill("Known Course, Somewhere CT");
    await page.getByRole("button", { name: "Find course" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "We've logged it for review" })
    ).toBeVisible();
    const courseMissPayload = (await courseMissReport).postDataJSON();
    expect(courseMissPayload).toEqual(
      expect.objectContaining({
        sentiment: "broken",
        message: expect.stringContaining("[COURSE_LOOKUP_MISS]")
      })
    );
    expect(courseMissPayload.message).toContain("Known Course, Somewhere CT");
    expect(courseMissPayload.message).toContain("Trumbull, CT");

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

    await captureUiScreenshot(page, testInfo, "search-five-selected");
    if (usesSelectionDrawer) {
      const selectionToggle = page.locator(".mobile-selection-toggle");
      await expect(selectionToggle).toContainText("5 courses picked");
      await expect(selectionToggle).toContainText("Reorder priority");
      await page.getByRole("button", { name: "Review alert" }).click();
      await expect(page.locator(".figma-selected-panel.is-mobile-open")).toBeVisible();
    }

    const alertPreview = page.locator(".figma-alert-preview");
    await expect(alertPreview.getByText("Your alert", { exact: true })).toBeVisible();
    await expect(alertPreview).toContainText("We'll check 5 ranked courses");
    await expect(alertPreview).toContainText("for 4 players");
    await expect(alertPreview).toContainText("You book direct");

    const groupRecipients = page.getByRole("group", { name: "Alert your group too" });
    await expect(groupRecipients).toContainText(
      "Everyone gets the same opening, but only you manage the alert."
    );
    await groupRecipients.getByLabel("Additional recipient 1").fill("friend@example.com");
    await groupRecipients.getByRole("button", { name: "Add another recipient" }).click();
    const secondRecipient = groupRecipients.getByRole("textbox", {
      name: "Additional recipient 2",
      exact: true
    });
    await secondRecipient.fill("not-an-email");
    await expect(page.getByText("Enter a valid email for each additional recipient.")).toBeVisible();
    await expect(alertActionButton).toBeDisabled();
    await secondRecipient.fill("teammate@example.com");
    await expect(alertPreview).toContainText("Your account email + 2 others");

    let saveRequestCount = 0;
    let lastSavePayload: Record<string, unknown> | null = null;
    let lastSaveTrafficClass: string | undefined;
    await page.route("**/api/searches", async (route) => {
      saveRequestCount += 1;
      lastSavePayload = route.request().postDataJSON() as Record<string, unknown>;
      lastSaveTrafficClass = route.request().headers()["x-tee-time-spot-traffic-class"];
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

    const editableTimeSummary = page.locator(".figma-time-summary");
    await editableTimeSummary.evaluate((button: HTMLButtonElement) => button.click());
    await expect(editableTimeSummary).toHaveAttribute("aria-expanded", "true");
    await page.getByLabel("End time").fill("08:00");
    await expect(page.getByText("Choose an end time after the start time.")).toBeVisible();
    await expect(page.getByLabel("End time")).toHaveAttribute("aria-describedby", /search-form-guidance/);
    await expect(alertActionButton).toBeDisabled();
    await page.getByLabel("End time").fill("18:00");
    await page.getByRole("button", { name: "Done" }).click({ force: true });

    const alertActionText = await alertActionButton.innerText();
    if (/Sign in to start sending alerts/i.test(alertActionText)) {
      await expect(alertActionButton).toBeEnabled();
      await alertActionButton.click();
      await expect(page.getByRole("heading", { name: "Sign in to Tee Time Spot" })).toBeVisible();
      await expect.poll(() => signInAnalyticsPayload).toMatchObject({
        name: "alert_sign_in_clicked",
        page: "/search",
        trafficClass: "AUTOMATION",
        metadata: {
          selectedCourseCount: 5,
          players: 4,
          requestedLayoutHoles: null
        }
      });
      await page.getByRole("button", { name: "Close modal" }).click();
      expect(saveRequestCount, "signed-out visitors must not submit alert searches").toBe(0);
    } else if (/Start getting alerts/i.test(alertActionText)) {
      await expect(alertActionButton).toBeEnabled();
      await Promise.all([
        page.waitForURL((url) =>
          url.pathname === "/dashboard" && url.searchParams.get("created") === "ui-smoke-1"
        ),
        alertActionButton.click()
      ]);
      expect(saveRequestCount, "a successful alert save should submit once before redirecting").toBe(1);
      expect(lastSavePayload).toEqual(
        expect.objectContaining({
          additionalEmails: ["friend@example.com", "teammate@example.com"]
        })
      );
      expect(lastSaveTrafficClass).toBe("AUTOMATION");
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

      if (testInfo.project.name.includes("mobile")) {
        await expect(page.locator(".topbar").getByRole("button", { name: "Sign in" })).toBeVisible();
      }
    }

    if (testInfo.project.name.includes("mobile")) {
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

    await expect(page.getByRole("heading", { name: "Morning update" })).toBeVisible();
    await expect(page.getByTitle("Rendered morning update email")).toBeVisible();

    const morningFrame = page.frameLocator("iframe[title='Rendered morning update email']");
    await expect(morningFrame.locator("body")).toContainText("MORNING UPDATE");
    await expect(morningFrame.locator("body")).toContainText("Pinebrook Golf Club");
    await expect(morningFrame.locator("body")).toContainText("Ridgecrest Golf Course");
    await expect(morningFrame.getByText("Pinebrook Golf Club", { exact: true })).toHaveCount(1);
    await expect(morningFrame.getByText("Ridgecrest Golf Course", { exact: true })).toHaveCount(1);
    await expect(morningFrame.locator("body")).toContainText("9H/18H");
    await expect(morningFrame.locator("body")).toContainText("NEW");
    await expect(morningFrame.locator("body")).toContainText("What we're watching for you");
    await expect(morningFrame.locator("body")).toContainText("PRIORITY 5");
    await expect(morningFrame.locator("body")).not.toContainText(/PRIORITY [6-9]/);
    await expect(morningFrame.locator("body")).toContainText(
      /at most one morning status update per day/i
    );
    await expect(morningFrame.locator("body")).toContainText(/first come,\s+first served/i);
    await expect(morningFrame.locator("body")).not.toContainText(/we book/i);

    const morningMetrics = await page
      .locator("iframe[title='Rendered morning update email']")
      .evaluate((element) => {
        const frame = element as HTMLIFrameElement;
        const document = frame.contentDocument;
        return {
          contentHeight: Math.max(
            document?.documentElement.scrollHeight ?? 0,
            document?.body?.scrollHeight ?? 0
          ),
          contentWidth: document?.documentElement.scrollWidth ?? 0,
          frameHeight: frame.getBoundingClientRect().height,
          viewportWidth: document?.documentElement.clientWidth ?? 0
        };
      });
    expect(morningMetrics.frameHeight).toBeGreaterThanOrEqual(morningMetrics.contentHeight - 2);
    expect(morningMetrics.contentWidth).toBeLessThanOrEqual(morningMetrics.viewportWidth + 2);
    await captureUiElementScreenshot(
      page.locator("iframe[title='Rendered morning update email']"),
      testInfo,
      "email-preview-morning"
    );

    await page.getByRole("link", { name: "Instant" }).click();
    await expect(page).toHaveURL(/\/email-preview\?variant=instant$/);
    const instantFrame = page.frameLocator("iframe[title='Rendered instant alert email']");
    await expect(instantFrame.locator("body")).toContainText("NEW TEE TIME ALERT");
    await expect(instantFrame.locator("body")).toContainText("Pinebrook Golf Club");
    await expect(instantFrame.locator("body")).toContainText("9H/18H");
    await expect(
      instantFrame.getByRole("link", { name: "Open official booking page" }).first()
    ).toBeVisible();
    await expect(instantFrame.locator("body")).not.toContainText("What we're watching for you");

    const instantFrameLocator = page.locator("iframe[title='Rendered instant alert email']");
    await expect
      .poll(async () =>
        instantFrameLocator.evaluate((element) => {
          const frame = element as HTMLIFrameElement;
          const document = frame.contentDocument;
          const contentHeight = Math.max(
            document?.documentElement.scrollHeight ?? 0,
            document?.body?.scrollHeight ?? 0
          );
          return frame.getBoundingClientRect().height - contentHeight;
        })
      )
      .toBeGreaterThanOrEqual(-2);
    const instantMetrics = await instantFrameLocator.evaluate((element) => {
        const frame = element as HTMLIFrameElement;
        const document = frame.contentDocument;
        return {
          contentHeight: Math.max(
            document?.documentElement.scrollHeight ?? 0,
            document?.body?.scrollHeight ?? 0
          ),
          contentWidth: document?.documentElement.scrollWidth ?? 0,
          frameHeight: frame.getBoundingClientRect().height,
          viewportWidth: document?.documentElement.clientWidth ?? 0
        };
      });
    expect(instantMetrics.contentWidth).toBeLessThanOrEqual(instantMetrics.viewportWidth + 2);
    await captureUiElementScreenshot(
      instantFrameLocator,
      testInfo,
      "email-preview-instant"
    );

    await captureUiScreenshot(page, testInfo, "email-preview");

    await expectNoHorizontalOverflow(page, testInfo);
    await expectInteractiveElementsAreUsable(page, testInfo);
    await expectNoPageIssues(issues, testInfo);

    await page.goto("/alerts/stop?token=preview-booked");
    await expect(page.getByRole("heading", { name: "Nice—did you book a tee time?" })).toBeVisible();
    await expect(page.getByText(/No alert will be changed from this page/i)).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to email preview" })).toBeVisible();

    await page.goto("/alerts/stop?token=preview-cancelled");
    await expect(page.getByRole("heading", { name: "Cancel this tee-time alert?" })).toBeVisible();
    await expect(page.getByText(/No alert will be changed from this page/i)).toBeVisible();

    await expectNoHorizontalOverflow(page, testInfo);
    await expectInteractiveElementsAreUsable(page, testInfo);
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

async function mockSmokeCourseSearch(page: Page) {
  await page.route("**/api/location/geocode?**", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ latitude: 41.242, longitude: -73.209 }),
      contentType: "application/json",
      status: 200
    });
  });
  await page.route("**/api/courses/discover?**", async (route) => {
    await route.fulfill({
      body: JSON.stringify({ courses: smokeCourses }),
      contentType: "application/json",
      status: 200
    });
  });
  await mockSmokeCoursePhotos(page);
}

async function mockSmokeCoursePhotos(page: Page) {
  await page.route("**/api/courses/photo?**", async (route) => {
    const photoReference = new URL(route.request().url()).searchParams.get("ref") ?? "";
    const photoIndex = Number(photoReference.match(/ui-smoke-photo-(\d+)/)?.[1] ?? "1") - 1;
    await route.fulfill({
      body: getSmokeCoursePhotoSvg(photoIndex),
      contentType: "image/svg+xml",
      status: 200
    });
  });
}

function getSmokeCoursePhotoSvg(index: number) {
  const palettes = [
    ["#b9d7ef", "#507d3a", "#1f5b2c", "#d7c292"],
    ["#9dcbe8", "#6f9d43", "#315e31", "#e3cf9b"],
    ["#7ebee8", "#7fa54a", "#285737", "#d9c48a"],
    ["#b8d8e7", "#476d37", "#234b32", "#ead6a8"],
    ["#a9d0ed", "#789c45", "#355e35", "#d7be80"],
    ["#c2dced", "#5c843d", "#254e31", "#e5ce99"],
    ["#91c4e4", "#6d9746", "#2c5836", "#dcc58b"]
  ];
  const [sky, fairway, tree, sand] = palettes[index % palettes.length];

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 220">
    <rect width="220" height="220" fill="${sky}"/>
    <circle cx="178" cy="38" r="18" fill="#fff4c7" opacity=".9"/>
    <path d="M0 96 C35 72 66 88 104 78 C146 67 181 75 220 58 V220 H0 Z" fill="${tree}"/>
    <path d="M0 126 C55 99 91 111 126 97 C162 83 194 91 220 82 V220 H0 Z" fill="${fairway}"/>
    <path d="M94 101 C127 107 157 132 172 220 H55 C69 165 82 128 94 101 Z" fill="#86b958"/>
    <path d="M143 148 C167 140 189 146 195 159 C184 173 158 176 139 165 Z" fill="${sand}"/>
    <path d="M115 103 V151" stroke="#f6f4ea" stroke-width="3"/>
    <path d="M116 104 L145 113 L116 123 Z" fill="#e36f43"/>
    <ellipse cx="115" cy="153" rx="27" ry="9" fill="#a6cf78"/>
  </svg>`;
}

async function captureUiScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
  fullPage = false
) {
  const outputDirectory = process.env.UI_CAPTURE_SCREENSHOTS_DIR;
  if (!outputDirectory) {
    return;
  }

  await page.screenshot({
    fullPage,
    path: path.join(outputDirectory, `${name}-${testInfo.project.name}.png`)
  });
}

async function captureUiElementScreenshot(
  locator: Locator,
  testInfo: TestInfo,
  name: string
) {
  const outputDirectory = process.env.UI_CAPTURE_SCREENSHOTS_DIR;
  if (!outputDirectory) {
    return;
  }

  await locator.screenshot({
    path: path.join(outputDirectory, `${name}-${testInfo.project.name}.png`)
  });
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
