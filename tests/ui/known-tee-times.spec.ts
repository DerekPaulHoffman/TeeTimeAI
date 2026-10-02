import { expect, test } from "@playwright/test";

test("shows existing times on course results", async ({ page }) => {
  await page.addInitScript(() => window.sessionStorage.setItem("tee-time-spot:traffic-class", "AUTOMATION"));
  await page.route("**/api/analytics/events", (route) => route.fulfill({ json: { event: { id: "test" } } }));
  await page.route("**/api/location/geocode?**", (route) => route.fulfill({ json: { formattedAddress: "Trumbull, CT", latitude: 41.24, longitude: -73.2 } }));
  await page.route("**/api/courses/discover?**", (route) => route.fulfill({ json: { courses: [{
    courseId: "public-course", googlePlaceId: "public-place", name: "Public Golf Course",
    address: "Trumbull, CT", latitude: 41.24, longitude: -73.2, timeZone: "America/New_York"
  }] } }));
  await page.route("**/api/courses/known-times?**", (route) => {
    const date = new URL(route.request().url()).searchParams.get("date");
    return route.fulfill({ json: { courses: { "public-course": [{
      startsAt: `${date}T15:00:00Z`, availableSpots: 4, holes: 18, priceCents: 4500,
      bookingUrl: "https://example.com/official-booking", confirmedAt: `${date}T14:55:00Z`
    }] } } });
  });
  await page.goto("/search");
  await page.getByRole("textbox", { name: "Location", exact: true }).fill("Trumbull, CT");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const times = page.getByRole("region", { name: "Previously checked tee times" });
  await expect(times).toBeVisible();
  await expect(times.getByRole("link")).toHaveAttribute("href", "https://example.com/official-booking");
  await expect(times).toContainText("4 spots · 18 holes · $45.00");
  await expect(times).toContainText("You book direct");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/known-times-${test.info().project.name}.png`, fullPage: true });
});
