import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

const enabled = process.env.SIMULATOR_MODE_ENABLED === "true";
const routes = [
  { path: "/golf-simulators", title: "Find Indoor Golf Simulators Near You", type: "WebPage" },
  { path: "/guides/booking-indoor-golf", title: "How to Book Indoor Golf Simulator Bays", type: "Article" }
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("tee-time-spot:traffic-class", "AUTOMATION");
  });
  await page.route("**/api/**", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/analytics/events") {
      await route.fulfill({ status: 201, json: { event: { id: "marketing-fixture" } } });
      return;
    }
    // Marketing checks must never create customer demand or call a provider.
    await route.abort();
  });
});

test("homepage promotion follows activation and opens the shared simulator search", async ({ page }, testInfo) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Golf tee time alerts for the courses you want to play.");
  await expect(page.getByRole("link", { name: "My alerts", exact: true }).first()).toBeVisible();
  const simulatorCta = page.locator(".hero").getByRole("link", { name: "Find a simulator", exact: true });
  await expect(simulatorCta).toHaveCount(enabled ? 1 : 0);
  await checkLayout(page);
  await capture(page, `homepage-${enabled ? "enabled" : "disabled"}-${testInfo.project.name}`);
  if (!enabled) {
    await expect(page.getByText("Now supporting golf simulators", { exact: true })).toHaveCount(0);
    return;
  }
  await expect(simulatorCta).toHaveAttribute("data-analytics-mode", "SIMULATOR");
  await simulatorCta.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/search\?mode=SIMULATOR$/);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Find indoor golf simulators and set a free alert.");
  const layouts = page.getByRole("group", { name: "Course layout", exact: true });
  await expect(layouts.getByRole("button", { name: "Simulator", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://teetimespot.com/search");
  await layouts.getByRole("button", { name: "Any", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Find public golf tee times and set a free alert.");
  await layouts.getByRole("button", { name: "Simulator", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Find indoor golf simulators and set a free alert.");
});

test("keeps search tracking valid in compact navigation", async ({ page }) => {
  const clicks: Array<{ metadata: { label: string; mode?: string } }> = [];
  await page.route("**/api/analytics/events", async (route) => {
    const event = route.request().postDataJSON();
    if (event.name === "start_search_clicked") clicks.push(event);
    await route.fulfill({ status: 201, json: { event: { id: "navigation-fixture" } } });
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("header").getByRole("link", { name: "Find a tee time", exact: true }).click();
  await expect.poll(() => clicks).toContainEqual(expect.objectContaining({
    metadata: { label: "Find a tee time", mode: "OUTDOOR" }
  }));
});

for (const route of routes) {
  test(`publishes crawlable simulator content at ${route.path}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const response = await page.goto(route.path, { waitUntil: "networkidle" });
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(`${route.title} | Tee Time Spot`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `https://teetimespot.com${route.path}`);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /indoor golf/i);
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", `https://teetimespot.com${route.path}`);
    const data = (await page.locator('script[type="application/ld+json"]').allTextContents()).flatMap((text) => JSON.parse(text)["@graph"] ?? []);
    expect(data.map((item: { "@type": string }) => item["@type"])).toEqual(expect.arrayContaining([route.type, "BreadcrumbList"]));
    const ctas = page.locator('main a[href="/search?mode=SIMULATOR"]');
    if (enabled) {
      expect(await ctas.count()).toBeGreaterThan(0);
      await expect(ctas.first()).toHaveAttribute("data-analytics-mode", "SIMULATOR");
    } else {
      await expect(ctas).toHaveCount(0);
      await expect(page.getByText(/Simulator (search and )?alerts are temporarily unavailable/).first()).toBeVisible();
    }
    await checkLayout(page);
    await capture(page, `${route.type.toLowerCase()}-${enabled ? "enabled" : "disabled"}-${testInfo.project.name}`);
    expect(errors).toEqual([]);
  });
}

async function checkLayout(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const link of await page.locator("main .button").all()) {
    const box = await link.boundingBox();
    if (box) expect(box.height).toBeGreaterThanOrEqual(44);
  }
}

async function capture(page: Page, name: string) {
  const output = process.env.SIMULATOR_MARKETING_SCREENSHOT_DIR;
  if (!output) return;
  const repository = path.resolve(process.cwd()).toLowerCase();
  const target = path.resolve(output).toLowerCase();
  expect(target === repository || target.startsWith(`${repository}${path.sep}`), "Screenshots belong outside the repository").toBe(false);
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
}
