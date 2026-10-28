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
  const finishChecks: Record<string, () => void> = {};
  await page.route("**/api/courses/check-times?**", async route => {
    const params = new URL(route.request().url()).searchParams;
    await new Promise<void>(resolve => { finishChecks[params.get("courseId")!] = resolve; });
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
  await expect(knolls.locator(".course-check-spinner")).toBeVisible();
  await expect(glen.locator(".course-check-spinner")).toBeVisible();
  await page.locator(".course-row").screenshot({ path: `test-results/shared-facility-loading-${test.info().project.name}.png` });
  finishChecks.knolls();
  await expect(knolls).toContainText("9-hole round · $27.00");
  await expect(knolls.locator(".course-check-spinner")).toHaveCount(0);
  await expect(glen.locator(".course-check-spinner")).toBeVisible();
  finishChecks.glen();
  await expect(glen).toContainText("couldn't check current tee times");
  await expect(glen.locator(".course-check-spinner")).toHaveCount(0);
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

test("discovers course rows during the ordinary check and offers Notify me for the new course", async ({ page }) => {
  const base = { googlePlaceId: "cedar-place", latitude: 41.24, longitude: -73.2, timeZone: "America/New_York", publicAccessStatus: "PUBLIC" };
  const members = [
    { ...base, courseId: "north", name: "Cedar Ridge North Course", layoutHoleCounts: [18], website: "https://official.example/north" },
    { ...base, courseId: "south", name: "Cedar Ridge South Course", layoutHoleCounts: [], publicAccessStatus: "UNVERIFIED", website: "https://official.example/south" },
  ];
  const checked: string[] = [], writes: string[] = [];
  await page.route("**/api/**", route => {
    const request = route.request(), url = new URL(request.url());
    if (["/api/analytics/events", "/api/feedback"].includes(url.pathname)) return route.fulfill({ json: { ok: true } });
    if (request.method() !== "GET") { writes.push(url.pathname); return route.abort(); }
    if (url.pathname === "/api/location/geocode") return route.fulfill({ json: { latitude: 41.24, longitude: -73.2 } });
    if (url.pathname === "/api/courses/discover") return route.fulfill({ json: { courses: [members[0]] } });
    if (url.pathname === "/api/courses/known-times") return route.fulfill({ json: { courses: {} } });
    if (url.pathname === "/api/courses/check-times") {
      checked.push(url.searchParams.get("courseId")!);
      return route.fulfill({ json: url.searchParams.get("courseId") === "north" ? { status: "CHECKED", times: [], facilityCourses: members } : { status: "UNAVAILABLE", times: [] } });
    }
    return route.abort();
  });
  await page.goto("/search");
  await page.getByRole("button", { name: "Any", exact: true }).click();
  await page.getByRole("textbox", { name: "Location", exact: true }).fill("Trumbull, CT");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const south = page.getByRole("region", { name: members[1].name, exact: true });
  await expect(south).toContainText("Physical layout unverified");
  await expect(south).not.toContainText("No tee times");
  await expect.poll(() => checked.includes("south")).toBe(true);
  await south.getByRole("button", { name: `Notify me for ${members[1].name}` }).click();
  const dialog = page.getByRole("dialog", { name: "Notify me", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(members[1].name);
  await expect(dialog).not.toContainText(members[0].name);
  expect(writes).toEqual([]);
  expect(checked.filter(id => id === "north").length).toBeLessThanOrEqual(3);
});
