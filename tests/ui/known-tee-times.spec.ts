import { expect, test } from "@playwright/test";

test("shows existing times on course results", async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.setItem("tee-time-spot:traffic-class", "AUTOMATION"));
  await page.route("**/api/analytics/events", (route) => route.fulfill({ json: { event: { id: "test" } } }));
  await page.route("**/api/location/geocode?**", (route) => route.fulfill({ json: { formattedAddress: "Trumbull, CT", latitude: 41.24, longitude: -73.2 } }));
  await page.route("**/api/courses/discover?**", (route) => route.fulfill({ json: { courses: [{
    courseId: "public-course", googlePlaceId: "public-place", name: "Public Golf Course",
    address: "Trumbull, CT", latitude: 41.24, longitude: -73.2, timeZone: "America/New_York",
    monitoringReadiness: "VERIFYING", monitoringReadinessObservedAt: "2026-08-30T11:55:33.756Z",
  }] } }));
  let finishCheck: (() => void) | undefined;
  await page.route("**/api/courses/check-times?**", async (route) => {
    const date = new URL(route.request().url()).searchParams.get("date");
    await new Promise<void>(resolve => { finishCheck = resolve; });
    return route.fulfill({ json: { status: "CHECKED", times: [{
      startsAt: `${date}T15:00:00Z`, availableSpots: 4, holes: 18, priceCents: 4500,
      bookingUrl: "https://example.com/official-booking", confirmedAt: `${date}T14:55:00Z`
    }] } });
  });
  await page.goto("/search");
  await page.getByRole("textbox", { name: "Location", exact: true }).fill("Trumbull, CT");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("Checking tee times…", { exact: true })).toBeVisible();
  await expect.poll(() => Boolean(finishCheck)).toBe(true);
  finishCheck!();
  const times = page.getByRole("region", { name: "Previously checked tee times" });
  await expect(page.getByText("Tee times checked just now", { exact: true })).toBeVisible();
  await expect(page.getByText("Alert availability after first check", { exact: true })).toHaveCount(0);
  await expect(times).toBeVisible();
  await expect(times.getByRole("link")).toHaveAttribute("href", "https://example.com/official-booking");
  await expect(times.getByRole("link")).toHaveAttribute("title", /4 spots · 18 holes · \$45\.00/);
  await expect(times.getByRole("link")).toHaveText("11:00 AM");
  const pill = await times.getByRole("link").boundingBox();
  expect(pill!.height).toBeLessThanOrEqual(30);
  expect(pill!.width).toBeLessThanOrEqual(100);
  await expect(times).toContainText("You book direct");
  await expect(page.getByRole("button", { name: "Notify me for Public Golf Course" })).toBeVisible();
  await expect(page.getByText("Your courses", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/known-times-${test.info().project.name}.png`, fullPage: true });
});

test("offers notifications when a check has no current times", async ({ page }) => {
  await page.route("**/api/searches", route => route.abort());
  await page.route("**/api/analytics/events", route => route.fulfill({ json: { event: { id: "test" } } }));
  await page.route("**/api/location/geocode?**", route => route.fulfill({ json: { latitude: 41.24, longitude: -73.2 } }));
  await page.route("**/api/courses/discover?**", route => route.fulfill({ json: { courses: [{ courseId: "empty-course", googlePlaceId: "empty-place", name: "Empty Public Course", address: "Trumbull, CT", latitude: 41.24, longitude: -73.2, timeZone: "America/New_York" }] } }));
  await page.route("**/api/courses/known-times?**", route => route.fulfill({ json: { courses: {} } }));
  await page.route("**/api/courses/check-times?**", route => route.fulfill({ json: { status: "CHECKED", times: [] } }));
  await page.goto("/search");
  await page.getByRole("textbox", { name: "Location", exact: true }).fill("Trumbull, CT");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const notify = page.getByRole("button", { name: "Notify me when new times become available for Empty Public Course" });
  await expect(notify).toBeVisible();
  await expect(notify).toHaveText("Notify me when new times become available");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
