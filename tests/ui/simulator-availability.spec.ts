import { expect, test } from "@playwright/test";

test("shows session availability and honest result states on every simulator card", async ({ page }, testInfo) => {
  test.skip(process.env.SIMULATOR_MODE_ENABLED !== "true", "Simulator mode is gated");
  const requests: URL[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const venue = (id: string, name: string) => ({ mode: "SIMULATOR", courseId: `venue-${id}`, offeringId: id,
    googlePlaceId: id === "oasis" ? "ChIJZZ8iPY_j54kRc_dEf6j6Brc" : `place-${id}`, name,
    address: "695 Main St, Monroe, CT", latitude: 41.3, longitude: -73.2, timeZone: "America/New_York",
    publicAccessStatus: "PUBLIC", supportedDurationsMinutes: [60, 120], maxPartySize: 1,
    website: "https://example.com/official-simulator", distanceMeters: 3_862 });
  let finish: (() => void) | undefined;
  let first = true;
  await page.addInitScript(() => sessionStorage.setItem("tee-time-spot:traffic-class", "AUTOMATION"));
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/analytics/events") return route.fulfill({ json: { event: { id: "test" } } });
    if (url.pathname === "/api/location/geocode") return route.fulfill({ json: { latitude: 41.3, longitude: -73.2 } });
    if (url.pathname === "/api/courses/discover") return route.fulfill({ json: { courses: [
      venue("oasis", "Golf Oasis CT"), venue("empty", "Full Simulator"), venue("failed", "Unavailable Simulator"),
      { ...venue("unknown", "New Simulator"), offeringId: undefined, courseId: undefined, publicAccessStatus: "UNVERIFIED" },
    ] } });
    if (url.pathname === "/api/courses/lookup") return route.fulfill({ json: { courses: [venue("lookup", "Lookup Simulator")] } });
    if (url.pathname === "/api/courses/check-sessions") {
      requests.push(url);
      if (url.searchParams.get("offeringId") === "oasis" && first) {
        first = false;
        await new Promise<void>(resolve => { finish = resolve; });
      }
      const id = url.searchParams.get("offeringId");
      const date = url.searchParams.get("date");
      const durations = url.searchParams.has("durationMinutes") ? [Number(url.searchParams.get("durationMinutes"))] : [60, 120];
      return route.fulfill({ json: { status: id === "failed" ? "FAILED" : "CHECKED", times: [],
        sessions: id === "empty" || id === "failed" ? [] : durations.map(duration => ({ startsAt: `${date}T14:00:00Z`,
          endsAt: `${date}T${String(14 + duration / 60).padStart(2, "0")}:00:00Z`,
          bookingUrl: "https://example.com/official-simulator", confirmedAt: `${date}T13:59:00Z` })) } });
    }
    unexpected.push(`${route.request().method()} ${url.pathname}`);
    return route.abort();
  });
  await page.goto("/search?mode=SIMULATOR");
  await page.getByLabel("Location", { exact: true }).fill("Monroe, CT");
  await page.getByLabel("Date", { exact: true }).fill("2080-06-02");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const oasis = page.locator(".course-row").filter({ has: page.getByRole("heading", { name: "Golf Oasis CT", exact: true }) });
  await expect(oasis.getByText("Checking latest sessions…", { exact: true })).toBeVisible();
  await expect(oasis.locator(".course-check-spinner")).toBeVisible();
  await expect.poll(() => Boolean(finish)).toBe(true);
  finish!();
  await expect(oasis.getByRole("region", { name: "Available simulator sessions" }).getByRole("link")).toHaveCount(2);
  await expect(oasis.getByRole("link", { name: "10:00 AM – 11:00 AM", exact: true })).toHaveAttribute("href", "https://example.com/official-simulator");
  await expect(oasis.getByRole("link", { name: "10:00 AM – 12:00 PM", exact: true })).toBeVisible();
  await expect(oasis).not.toContainText(/Session alerts supported|holes|spots|green fees/);
  await expect(page.getByText("No matching sessions found for this date, time window, and session length.", { exact: true })).toBeVisible();
  await expect(page.getByText("We couldn't check current sessions. Use the official site.", { exact: true })).toBeVisible();
  await expect(page.getByText("Live sessions aren't available here yet. Check the official site.", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Number of hours", exact: true }).selectOption("120");
  await expect(oasis.getByRole("region", { name: "Available simulator sessions" }).getByRole("link")).toHaveCount(1);
  await expect(oasis.getByRole("link", { name: "10:00 AM – 12:00 PM", exact: true })).toBeVisible();
  await page.getByLabel("Date", { exact: true }).fill("2080-06-03");
  await expect(oasis.getByRole("region", { name: "Available simulator sessions" })).toContainText("2080-06-03");
  await page.getByLabel("Simulator name and town", { exact: true }).fill("Lookup Simulator Monroe");
  await page.getByRole("button", { name: "Find simulator", exact: true }).click();
  const lookup = page.locator(".course-row").filter({ has: page.getByRole("heading", { name: "Lookup Simulator", exact: true }) });
  await expect(lookup.getByRole("region", { name: "Available simulator sessions" }).getByRole("link")).toHaveCount(1);
  expect(requests.some(url => url.searchParams.get("offeringId") === "lookup" && url.searchParams.get("durationMinutes") === "120")).toBe(true);
  expect(requests.every(url => !url.searchParams.has("courseId") && !url.searchParams.has("players"))).toBe(true);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const timeLink = oasis.getByRole("region", { name: "Available simulator sessions" }).getByRole("link");
  expect(await timeLink.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  if (page.viewportSize()!.width < 768) expect((await timeLink.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await oasis.screenshot({ path: `test-results/simulator-availability-${testInfo.project.name}.png` });
});
