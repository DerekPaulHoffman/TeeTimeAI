import { expect, test } from "@playwright/test";

test("keeps Tashua's two sheets and Notify me actions separate within the existing card", async ({ page }) => {
  const base = { googlePlaceId: "tashua-place", latitude: 41.24, longitude: -73.2, timeZone: "America/New_York", distanceMeters: 1000, publicAccessStatus: "PUBLIC" };
  const members = [
    { ...base, courseId: "knolls", name: "Tashua Knolls", layoutHoleCounts: [18], website: "https://foreupsoftware.com/index.php/booking/21017/6654#/teetimes" },
    { ...base, courseId: "glen", name: "Tashua Glen", layoutHoleCounts: [9], website: "https://foreupsoftware.com/index.php/booking/21017/6463#/teetimes" },
  ];
  const mutations: string[] = [];
  await page.route("**/api/searches", route => { mutations.push(route.request().method()); return route.abort(); });
  await page.route("**/api/analytics/events", route => route.fulfill({ json: { event: { id: "test" } } }));
  await page.route("**/api/location/geocode?**", route => route.fulfill({ json: { latitude: 41.24, longitude: -73.2 } }));
  await page.route("**/api/courses/discover?**", route => route.fulfill({ json: { courses: [{ ...members[0], name: "Tashua Knolls & Tashua Glen Golf Course", facilityCourses: members }] } }));
  await page.route("**/api/courses/known-times?**", route => route.fulfill({ json: { courses: {} } }));
  await page.route("**/api/courses/check-times?**", route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: params.get("courseId") === "knolls" ? { status: "CHECKED", times: [{
      startsAt: `${params.get("date")}T15:00:00Z`, availableSpots: 4, holes: 9, priceCents: 2700,
      bookingUrl: members[0].website, confirmedAt: "2026-10-28T16:44:55Z",
    }] } : { status: "FAILED", times: [] } });
  });
  await page.goto("/search");
  await page.getByRole("button", { name: "Any", exact: true }).click();
  await page.getByRole("textbox", { name: "Location", exact: true }).fill("Trumbull, CT");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const knolls = page.getByRole("region", { name: "Tashua Knolls", exact: true });
  const glen = page.getByRole("region", { name: "Tashua Glen", exact: true });
  await expect(knolls).toContainText("18-hole course");
  await expect(knolls).toContainText("9-hole round · $27.00");
  await expect(glen).toContainText("couldn't check current tee times");
  await expect(glen).not.toContainText("$27");
  await expect(glen.getByRole("link", { name: "Official booking page", exact: true })).toHaveAttribute("href", members[1].website);
  await expect(page.getByRole("button", { name: /^Notify me for Tashua/ })).toHaveCount(2);
  expect(await glen.getByRole("button", { name: "Notify me for Tashua Glen" }).evaluate(el => Number.parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThan(0);
  await page.getByRole("button", { name: "9-hole", exact: true }).click();
  await expect(glen.getByRole("button", { name: "Notify me for Tashua Glen" })).toBeEnabled();
  await expect(knolls.getByRole("button", { name: "Notify me for Tashua Knolls" })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(mutations).toEqual([]);
  await page.screenshot({ path: `test-results/shared-facility-${test.info().project.name}.png`, fullPage: true });
  await page.locator(".course-row").screenshot({ path: `test-results/shared-facility-card-${test.info().project.name}.png` });
});
