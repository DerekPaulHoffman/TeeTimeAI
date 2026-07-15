import { expect, test, type Page } from "@playwright/test";

const coursePath = "/courses/tashua-knolls-golf-course-trumbull-ct";
const knownBookingWindowCoursePath = "/courses/cedar-ridge-golf-course-east-lyme-ct";
const locationPaths = [
  "/locations/connecticut",
  "/locations/connecticut/fairfield-county",
  "/locations/connecticut/new-haven-county"
] as const;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("tee-time-spot:traffic-class", "TEST");
  });
});

test("renders a facility-first supported course guide without browser errors", async ({ page }, testInfo) => {
  const errors = watchForBrowserErrors(page);
  const response = await page.goto(coursePath, { waitUntil: "networkidle" });

  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Tashua Knolls Golf Course" })).toBeVisible();
  await expect(page.getByText("Golf course guide", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "About Tashua Knolls Golf Course" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Facility highlights" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Booking at Tashua Knolls Golf Course" })).toBeVisible();
  await expect(page.getByText("Advance booking schedule", { exact: true })).toBeVisible();
  await expect(page.getByText("Confirm on the official booking page.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tee time alerts for Tashua Knolls Golf Course" })).toBeVisible();
  await expect(page.getByText("Get notified when a public tee time matches your date, time, group size, and course preference.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "References" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "At a glance" })).toBeVisible();
  await expect(page.locator(".course-hero").getByRole("link", { name: "Official course website" })).toBeVisible();
  await expect(page.locator(".course-hero").getByRole("button", { name: "Create an alert here" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Tee time alerts for Tashua Knolls Golf Course" }).locator("xpath=ancestor::section").getByRole("button", { name: "Create an alert here" })).toBeVisible();
  await expect(page.getByRole("link", { name: /About Tashua Knolls/ }).last()).toBeVisible();
  const publicCopy = await page.locator("main").innerText();
  for (const forbidden of ["Source-backed profile", "supporting source", "What Tee Time Spot understands", "Where these course facts come from", "supports these profile claims", "accessed Jul", "not enough evidence"]) {
    expect(publicCopy).not.toContain(forbidden);
  }
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", new RegExp(`${coursePath}$`));
  expect(await structuredDataTypes(page)).toEqual(expect.arrayContaining(["GolfCourse", "WebPage", "BreadcrumbList"]));
  await expectNoOverflowOrOverlay(page);
  await expectPrimaryTargetsAreUsable(page);
  await page.screenshot({ path: testInfo.outputPath("tashua-profile.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("course CTA transfers the selected course through session storage", async ({ page }) => {
  const errors = watchForBrowserErrors(page);
  await page.goto(coursePath, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Create an alert here" }).first().click();

  await expect(page).toHaveURL(/\/search$/);
  await expect(page.getByRole("heading", { level: 3, name: "Tashua Knolls Golf Course" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove Tashua Knolls Golf Course" }).first()).toBeVisible();
  expect(new URL(page.url()).searchParams.has("course")).toBe(false);
  expect(errors).toEqual([]);
});

test("renders a verified booking window as a direct course fact", async ({ page }) => {
  const errors = watchForBrowserErrors(page);
  const response = await page.goto(knownBookingWindowCoursePath, { waitUntil: "networkidle" });

  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Cedar Ridge Golf Course" })).toBeVisible();
  await expect(page.getByText("14-day booking window", { exact: true })).toBeVisible();
  await expect(page.getByText(/Public tee times open up to 14 days ahead/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open the official booking page" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("renders the exact three qualified Connecticut location hubs", async ({ page }, testInfo) => {
  const errors = watchForBrowserErrors(page);
  for (const path of locationPaths) {
    const response = await page.goto(path, { waitUntil: "networkidle" });
    expect(response?.status(), path).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: /Public golf alerts in/ })).toBeVisible();
    await expect(page.getByText(/\d+ supported courses/).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Supported public courses" })).toBeVisible();
    expect(await structuredDataTypes(page)).toEqual(expect.arrayContaining(["CollectionPage", "ItemList", "BreadcrumbList"]));
    await expectNoOverflowOrOverlay(page);
  }
  await page.screenshot({ path: testInfo.outputPath("new-haven-location.png"), fullPage: true });
  expect(errors).toEqual([]);

  const missing = await page.goto("/locations/connecticut/hartford-county", { waitUntil: "networkidle" });
  expect(missing?.status()).toBe(404);
});

async function structuredDataTypes(page: Page) {
  return page.locator('script[type="application/ld+json"]').evaluateAll((scripts) =>
    scripts.flatMap((script) => {
      const value = JSON.parse(script.textContent || "{}") as { "@type"?: string; "@graph"?: Array<{ "@type"?: string }> };
      return [value["@type"], ...(value["@graph"]?.map((item) => item["@type"]) ?? [])].filter(Boolean);
    })
  );
}

function watchForBrowserErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("response", (response) => {
    if (response.url().startsWith(page.context().pages()[0]?.url().split("/").slice(0, 3).join("/") ?? "") && response.status() >= 400) {
      errors.push(`response: ${response.status()} ${response.url()}`);
    }
  });
  return errors;
}

async function expectNoOverflowOrOverlay(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await expect(page.locator("[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay")).toHaveCount(0);
  expect((await page.locator("body").innerText()).trim().length).toBeGreaterThan(300);
}

async function expectPrimaryTargetsAreUsable(page: Page) {
  const targets = page.locator(".knowledge-actions .button, .knowledge-final-cta .button");
  for (let index = 0; index < await targets.count(); index += 1) {
    const box = await targets.nth(index).boundingBox();
    if (box) expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(40);
  }
}
