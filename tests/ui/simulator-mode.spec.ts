import { expect, test } from "@playwright/test";

test.describe("simulator mode", () => {
  test.skip(process.env.SIMULATOR_MODE_ENABLED !== "true", "Simulator pilot is explicitly gated");
  test("discovers and ranks simulator rentals without outdoor availability requests", async ({ page }) => {
    const outdoorRequests: string[] = [];
    const venue = { mode: "SIMULATOR", offeringId: "simulator-ui-proof", googlePlaceId: "simulator-ui-place", name: "Connecticut Simulator", address: "10 Main St, Fairfield, CT",
      latitude: 41.14, longitude: -73.25, timeZone: "America/New_York", website: "https://official.example/simulator", publicAccessStatus: "PUBLIC", maxPartySize: 6,
      supportedDurationsMinutes: [60, 90, 120, 180], monitoringReadiness: "VERIFYING", distanceMeters: 1000 };
    await page.addInitScript(() => sessionStorage.setItem("tee-time-spot:traffic-class", "AUTOMATION"));
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      if (/known-times|check-times|local-reader/.test(url.pathname)) { outdoorRequests.push(url.pathname); await route.abort(); return; }
      if (url.pathname === "/api/location/geocode") { await route.fulfill({ json: { latitude: 41.14, longitude: -73.25 } }); return; }
      if (url.pathname === "/api/courses/discover" || url.pathname === "/api/courses/lookup") {
        expect(url.searchParams.get("mode")).toBe("SIMULATOR");
        await route.fulfill({ json: { courses: [venue] } }); return;
      }
      if (url.pathname === "/api/analytics/events") { await route.fulfill({ status: 201, json: { event: { id: "simulator-ui-event" } } }); return; }
      await route.abort();
    });
    await page.goto("/search?mode=SIMULATOR");
    await expect(page.getByRole("button", { name: "Simulator", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("combobox", { name: "Session length" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: /holes/i })).toHaveCount(0);
    await page.getByPlaceholder("City, state, ZIP, or address").fill("Fairfield, CT");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Connecticut Simulator" })).toBeVisible();
    await page.getByRole("button", { name: "Add to alert" }).click();
    await expect(page.getByRole("complementary", { name: "Ranked simulator venues" })).toContainText("Connecticut Simulator");
    await page.getByRole("combobox", { name: "Session length" }).selectOption("120");
    await expect(page.getByRole("complementary", { name: "Ranked simulator venues" })).toContainText("120 minutes");
    expect(outdoorRequests).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (process.env.SIMULATOR_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SIMULATOR_SCREENSHOT_DIR}/simulator-${test.info().project.name}.png`, fullPage: true });
    await page.getByRole("button", { name: "Outdoor golf", exact: true }).click();
    await expect(page.getByPlaceholder("City, state, ZIP, or address")).toHaveValue("Fairfield, CT");
    await page.getByRole("button", { name: "Simulator", exact: true }).click();
    await expect(page.getByPlaceholder("City, state, ZIP, or address")).toHaveValue("Fairfield, CT");
    await expect(page.getByRole("combobox", { name: "Session length" })).toHaveValue("120");
  });
});
