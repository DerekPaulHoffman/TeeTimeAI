import { expect, test, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

const simulatorDraftKey = "tee-time-spot:search-draft:simulator:v1";
const outdoorDraftKey = "tee-time-spot:search-draft:v1";
const futureDate = "2080-06-02";
const simulatorVenue = {
  mode: "SIMULATOR",
  courseId: "shared-hybrid-venue",
  offeringId: "simulator-ui-proof",
  googlePlaceId: "shared-hybrid-place",
  name: "Connecticut Simulator",
  address: "10 Main St, Fairfield, CT",
  latitude: 41.14,
  longitude: -73.25,
  timeZone: "America/New_York",
  website: "https://official.example/simulator",
  publicAccessStatus: "PUBLIC",
  maxPartySize: 2,
  supportedDurationsMinutes: [60],
  simulatorEvidenceUrl: "https://official.example/public-simulator-rentals",
  simulatorVerifiedAt: "2026-10-05T12:00:00Z",
  monitoringSupport: "UNCONFIRMED",
  monitoringReadiness: "VERIFYING",
  distanceMeters: 1_000,
};
const outdoorVenue = {
  ...simulatorVenue,
  mode: "OUTDOOR",
  offeringId: undefined,
  name: "Hybrid Outdoor Golf",
  website: "https://official.example/outdoor-golf",
  layoutHoleCounts: [9],
};
const eighteenHoleVenue = {
  ...outdoorVenue,
  courseId: "outdoor-eighteen-hole-course",
  googlePlaceId: "outdoor-eighteen-hole-place",
  name: "Eighteen Hole Outdoor Golf",
  layoutHoleCounts: [18],
};

async function mockPublicReads(page: Page, simulatorCourses: Record<string, unknown>[] = [simulatorVenue]) {
  const state = {
    discoveryModes: [] as string[],
    outdoorReads: [] as string[],
    unexpectedRequests: [] as string[],
  };
  await page.addInitScript(() => {
    sessionStorage.setItem("tee-time-spot:traffic-class", "AUTOMATION");
    const observedWindow = window as Window & { simulatorOutdoorReads: string[] };
    observedWindow.simulatorOutdoorReads = [];
    const publicFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      const activeButton = document.querySelector<HTMLButtonElement>(".figma-hole-options button[aria-pressed='true']");
      if (/known-times|check-times|local-reader/.test(url.pathname) && activeButton?.textContent?.trim() === "Simulator") {
        observedWindow.simulatorOutdoorReads.push(url.pathname);
      }
      return publicFetch(input, options);
    };
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (/known-times|check-times|local-reader/.test(url.pathname)) {
      state.outdoorReads.push(url.pathname);
      if (url.pathname.endsWith("known-times")) {
        await route.fulfill({ json: { courses: {} } });
      } else {
        await route.fulfill({ json: { status: "CHECKED", times: [] } });
      }
      return;
    }
    if (url.pathname === "/api/location/geocode") {
      await route.fulfill({ json: { latitude: 41.14, longitude: -73.25 } });
      return;
    }
    if (url.pathname === "/api/courses/discover" || url.pathname === "/api/courses/lookup") {
      const mode = url.searchParams.get("mode") ?? "OUTDOOR";
      state.discoveryModes.push(mode);
      // Mixed provider results exercise the intake's mode boundary, including a hybrid venue.
      await route.fulfill({ json: { mode, courses: mode === "SIMULATOR"
        ? [...simulatorCourses, eighteenHoleVenue]
        : [outdoorVenue, eighteenHoleVenue, simulatorVenue] } });
      return;
    }
    if (url.pathname === "/api/analytics/events") {
      await route.fulfill({ status: 201, json: { event: { id: "simulator-ui-event" } } });
      return;
    }
    // No demand, provider checks, workflow starts, or notification transports run in this fixture.
    state.unexpectedRequests.push(`${route.request().method()} ${url.pathname}`);
    await route.abort();
  });
  return state;
}

async function expectSharedControls(page: Page) {
  const layout = page.getByRole("group", { name: "Course layout", exact: true });
  for (const label of ["Any", "9-hole", "18-hole", "Simulator"]) {
    await expect(layout.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Outdoor golf", exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Session length", exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Players", exact: true }).locator("option")).toHaveText([
    "1 player", "2 players", "3 players", "4 players",
  ]);
}

async function expectPreservedValues(page: Page) {
  await expect(page.getByLabel("Location", { exact: true })).toHaveValue("Fairfield, CT");
  await expect(page.getByLabel("Date", { exact: true })).toHaveValue(futureDate);
  await expect(page.getByRole("combobox", { name: "Players", exact: true })).toHaveValue("4");
}

async function expectNoHorizontalOverflow(page: Page) {
  const geometry = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    width: document.documentElement.scrollWidth,
    buttons: [...document.querySelectorAll<HTMLElement>(".figma-hole-options button")].map((button) => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    }),
  }));
  expect(geometry.width).toBeLessThanOrEqual(geometry.viewport + 2);
  for (const button of geometry.buttons) {
    expect(button.left).toBeGreaterThanOrEqual(-1);
    expect(button.right).toBeLessThanOrEqual(geometry.viewport + 1);
  }
}

async function expectNoOutdoorReadsInSimulator(page: Page) {
  expect(await page.evaluate(() => (window as Window & { simulatorOutdoorReads: string[] }).simulatorOutdoorReads)).toEqual([]);
}

async function captureSimulatorScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const directory = process.env.SIMULATOR_SCREENSHOT_DIR;
  if (!directory) return;
  const outputDirectory = path.resolve(directory);
  const relativeDirectory = path.relative(process.cwd(), outputDirectory);
  expect(relativeDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDirectory),
    "Simulator screenshots belong outside the repository").toBe(true);
  await page.screenshot({ path: path.join(outputDirectory, `${name}-${testInfo.project.name}.png`), fullPage: true });
}

test.describe("simulator mode", () => {
  test.skip(process.env.SIMULATOR_MODE_ENABLED !== "true", "Simulator pilot is explicitly gated");

  test("uses the normal form, cards and notification dialog while switching between golf and simulator discovery", async ({ page }, testInfo) => {
    const requests = await mockPublicReads(page);
    await page.goto("/search?mode=SIMULATOR");
    await expectSharedControls(page);
    const layout = page.getByRole("group", { name: "Course layout", exact: true });
    await expect(layout.getByRole("button", { name: "Simulator", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByLabel("Location", { exact: true }).fill("Fairfield, CT");
    await page.getByLabel("Date", { exact: true }).fill(futureDate);
    await page.getByRole("combobox", { name: "Players", exact: true }).selectOption("4");
    await page.getByRole("button", { name: "Search", exact: true }).click();

    const simulatorCard = page.locator(".course-row").filter({ has: page.getByRole("heading", { name: simulatorVenue.name, exact: true }) });
    await expect(simulatorCard).toBeVisible();
    await expect(page.getByRole("heading", { name: eighteenHoleVenue.name, exact: true })).toHaveCount(0);
    await expect(simulatorCard.locator(".course-monitoring-status")).not.toContainText("Simulator alerts available");
    await expect(simulatorCard.getByRole("link", { name: `Open official site for ${simulatorVenue.name}` })).toHaveAttribute("href", simulatorVenue.website);
    const notify = simulatorCard.getByRole("button", { name: `Notify me for ${simulatorVenue.name}`, exact: true });
    await expect(notify).toBeEnabled();
    await notify.click();
    const dialog = page.getByRole("dialog", { name: "Notify me", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(simulatorVenue.name);
    await expect(dialog).toContainText("4 players");
    await dialog.getByRole("button", { name: "Close notification setup", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expectNoHorizontalOverflow(page);
    await captureSimulatorScreenshot(page, testInfo, "simulator-unified-form");

    await layout.getByRole("button", { name: "9-hole", exact: true }).click();
    await expect(layout.getByRole("button", { name: "9-hole", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { name: outdoorVenue.name, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: simulatorVenue.name, exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: eighteenHoleVenue.name, exact: true })).toHaveCount(0);
    await expectPreservedValues(page);
    await layout.getByRole("button", { name: "Any", exact: true }).click();
    await expect(page.getByRole("heading", { name: eighteenHoleVenue.name, exact: true })).toBeVisible();
    await expectPreservedValues(page);

    await layout.getByRole("button", { name: "Simulator", exact: true }).click();
    await expect(simulatorCard).toBeVisible();
    await expect(page.getByRole("heading", { name: outdoorVenue.name, exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: eighteenHoleVenue.name, exact: true })).toHaveCount(0);
    await expectPreservedValues(page);
    await expectSharedControls(page);
    await expectNoHorizontalOverflow(page);
    await expectNoOutdoorReadsInSimulator(page);
    expect(requests.discoveryModes).toEqual(["SIMULATOR", "OUTDOOR", "SIMULATOR"]);
    expect(requests.unexpectedRequests).toEqual([]);
  });

  test("restores the matching simulator draft from a mode-only reload and discards stale readiness", async ({ page }, testInfo) => {
    const requests = await mockPublicReads(page);
    await page.addInitScript(({ simulatorDraftKey, outdoorDraftKey, venue, outdoor, date }) => {
      if (!sessionStorage.getItem(simulatorDraftKey)) sessionStorage.setItem(simulatorDraftKey, JSON.stringify({
        mode: "SIMULATOR", location: "Fairfield, CT", players: 4, date, startTime: "09:00", endTime: "18:00", radius: 25,
        courses: [venue], selectedCourses: [venue],
      }));
      if (!sessionStorage.getItem(outdoorDraftKey)) sessionStorage.setItem(outdoorDraftKey, JSON.stringify({
        location: "Other outdoor town", players: 1, date, holes: "9", courses: [outdoor], selectedCourses: [outdoor],
      }));
    }, {
      simulatorDraftKey, outdoorDraftKey, date: futureDate, outdoor: outdoorVenue,
      venue: { ...simulatorVenue, monitoringSupport: "AUTOMATIC", monitoringReadiness: "READY", monitoringReadinessObservedAt: "2026-10-05T12:00:00Z" },
    });
    await page.goto("/search?mode=SIMULATOR");
    await expectSharedControls(page);
    await expectPreservedValues(page);
    const dialog = page.getByRole("dialog", { name: "Notify me", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(simulatorVenue.name);
    await dialog.getByRole("button", { name: "Close notification setup", exact: true }).click();
    const status = page.locator(".course-row .course-monitoring-status");
    await expect(status).toBeVisible();
    await expect(status).not.toContainText("Simulator alerts available");
    await expect(page.getByRole("heading", { name: outdoorVenue.name, exact: true })).toHaveCount(0);
    await expectNoOutdoorReadsInSimulator(page);

    await page.reload();
    await expectPreservedValues(page);
    await expect(page.getByRole("group", { name: "Course layout", exact: true }).getByRole("button", { name: "Simulator", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(simulatorVenue.name);
    await dialog.getByRole("button", { name: "Close notification setup", exact: true }).click();
    await expect(status).not.toContainText("Simulator alerts available");
    await expectNoHorizontalOverflow(page);
    await expectNoOutdoorReadsInSimulator(page);
    await captureSimulatorScreenshot(page, testInfo, "simulator-restored-form");
    expect(requests.discoveryModes).toEqual([]);
    expect(requests.outdoorReads).toEqual([]);
    expect(requests.unexpectedRequests).toEqual([]);
  });

  test("lets every simulator use Notify me while unknown venues have neutral first-check copy", async ({ page }, testInfo) => {
    const unreviewed = { ...simulatorVenue, name: "Unreviewed Simulator", googlePlaceId: "unreviewed-simulator-place",
      courseId: undefined, offeringId: undefined, publicAccessStatus: "UNVERIFIED", simulatorVerifiedAt: undefined, simulatorEvidenceUrl: undefined };
    const unsupportedHour = { ...simulatorVenue, name: "Two-hour Simulator", googlePlaceId: "two-hour-simulator-place",
      offeringId: "two-hour-simulator-offering", supportedDurationsMinutes: [120] };
    const requests = await mockPublicReads(page, [simulatorVenue, unreviewed, unsupportedHour]);
    await page.goto("/search?mode=SIMULATOR");
    await page.getByLabel("Location", { exact: true }).fill("Fairfield, CT");
    await page.getByLabel("Date", { exact: true }).fill(futureDate);
    await page.getByRole("button", { name: "Search", exact: true }).click();

    await expect(page.getByText("3 simulators", { exact: true })).toBeVisible();
    await expect(page.getByText("3 simulator locations found", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Other nearby venues|Alerts unavailable/ })).toHaveCount(0);
    for (const venue of [unreviewed, unsupportedHour]) {
      const card = page.locator(".course-row").filter({ has: page.getByRole("heading", { name: venue.name, exact: true }) });
      await expect(card.getByRole("link", { name: `Open official site for ${venue.name}` })).toHaveAttribute("href", venue.website);
      await expect(card.getByText("We’ll check this venue when you set up an alert.", { exact: true })).toBeVisible();
      const notify = card.getByRole("button", { name: `Notify me for ${venue.name}`, exact: true });
      await expect(notify).toBeEnabled();
      await notify.click();
      const dialog = page.getByRole("dialog", { name: "Notify me", exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(venue.name);
      await dialog.getByRole("button", { name: "Close notification setup", exact: true }).click();
    }
    const notify = page.getByRole("button", { name: `Notify me for ${simulatorVenue.name}`, exact: true });
    await expect(notify).toBeEnabled();
    await notify.click();
    await expect(page.getByRole("dialog", { name: "Notify me", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close notification setup", exact: true }).click();
    await expectNoHorizontalOverflow(page);
    await captureSimulatorScreenshot(page, testInfo, "simulator-all-venues");
    await expectNoOutdoorReadsInSimulator(page);
    expect(requests.unexpectedRequests).toEqual([]);
  });

  test("lists every simulator by distance with ordinary pagination and stable selection", async ({ page }, testInfo) => {
    const supported = [12_000, 18_000, 22_000, 24_000].map((distanceMeters, index) => ({ ...simulatorVenue,
      courseId: `supported-course-${index}`, offeringId: `supported-offering-${index}`, googlePlaceId: `supported-place-${index}`,
      name: `Supported Simulator ${index + 1}`, distanceMeters }));
    const other = Array.from({ length: 5 }, (_, index) => ({ ...simulatorVenue,
      courseId: undefined, offeringId: undefined, publicAccessStatus: "UNVERIFIED", googlePlaceId: `other-place-${index}`,
      name: `Other Simulator ${index + 1}`, distanceMeters: (index + 1) * 1_000 }));
    const requests = await mockPublicReads(page, [...other, ...supported]);
    await page.goto("/search?mode=SIMULATOR");
    await page.getByLabel("Location", { exact: true }).fill("Monroe, CT");
    await page.getByLabel("Date", { exact: true }).fill(futureDate);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const mainList = page.getByRole("list", { name: "Nearby simulators", exact: true });
    const allVenues = [...other, ...supported];
    await expect(mainList.getByRole("heading")).toHaveText(allVenues.slice(0, 6).map((venue) => venue.name));
    await expect(page.getByText("9 simulators", { exact: true })).toBeVisible();
    await expect(page.getByText("9 simulator locations found", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "See more locations", exact: true }).click();
    await expect(mainList.getByRole("heading")).toHaveText(allVenues.map((venue) => venue.name));
    await expect(mainList.getByText("Session alerts supported", { exact: true })).toHaveCount(4);
    await expect(mainList.getByText("We’ll check this venue when you set up an alert.", { exact: true })).toHaveCount(5);
    await expect(mainList.getByText("Alert availability after first check", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "See more locations", exact: true })).toHaveCount(0);
    await mainList.getByRole("button", { name: `Notify me for ${other[2].name}`, exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Notify me", exact: true })).toBeVisible();
    await expect(mainList.getByRole("heading")).toHaveText(allVenues.map((venue) => venue.name));
    await page.getByRole("button", { name: "Close notification setup", exact: true }).click();
    await expect(page.getByRole("button", { name: /Other nearby venues|Alerts unavailable/ })).toHaveCount(0);
    await captureSimulatorScreenshot(page, testInfo, "simulator-distance-list");
    await expectNoHorizontalOverflow(page);
    await expectNoOutdoorReadsInSimulator(page);
    expect(requests.unexpectedRequests).toEqual([]);
  });

  test("shows one empty state after reducing the radius and expands only to 30 miles", async ({ page }, testInfo) => {
    const unreviewed = { ...simulatorVenue, name: "Site-only Simulator", courseId: undefined, offeringId: undefined,
      publicAccessStatus: "UNVERIFIED", googlePlaceId: "site-only-place", distanceMeters: 10_000 };
    const requests = await mockPublicReads(page, [unreviewed]);
    await page.goto("/search?mode=SIMULATOR");
    await page.getByLabel("Location", { exact: true }).fill("Monroe, CT");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByRole("heading", { name: unreviewed.name, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `Notify me for ${unreviewed.name}`, exact: true })).toBeEnabled();
    await page.getByRole("slider", { name: "Distance from me", exact: true }).fill("5");
    await expect(page.getByRole("heading", { name: "No simulators found within 5 miles.", exact: true })).toBeVisible();
    await expect(page.locator(".figma-empty-results")).toHaveCount(1);
    await expect(page.getByText("No courses match these filters.", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Expand search", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Search 30 miles", exact: true }).click();
    await expect(page.getByRole("heading", { name: unreviewed.name, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Search (30|50) miles/ })).toHaveCount(0);
    await expect(page.getByText(/No public courses|sold out|no matching session/i)).toHaveCount(0);
    await expect(page.getByRole("link", { name: `Open official site for ${unreviewed.name}` })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await captureSimulatorScreenshot(page, testInfo, "simulator-radius-recovery");
    await expectNoOutdoorReadsInSimulator(page);
    expect(requests.unexpectedRequests).toEqual([]);
  });

  test("lets a simulator found by name open the normal notification dialog and map", async ({ page }) => {
    const unreviewed = { ...simulatorVenue, name: "Searched Simulator", courseId: undefined, offeringId: undefined,
      publicAccessStatus: "UNVERIFIED", googlePlaceId: "searched-site-only-place" };
    const requests = await mockPublicReads(page, [unreviewed]);
    await page.goto("/search?mode=SIMULATOR");
    await page.getByLabel("Simulator name and town", { exact: true }).fill("Searched Simulator Monroe");
    await page.getByRole("button", { name: "Find simulator", exact: true }).click();
    const directList = page.getByRole("list", { name: "Direct simulator matches", exact: true });
    await expect(directList.getByRole("heading", { name: unreviewed.name, exact: true })).toBeVisible();
    await expect(directList.getByRole("link", { name: `Open official site for ${unreviewed.name}` })).toHaveAttribute("href", unreviewed.website);
    await expect(directList.getByText("We’ll check this venue when you set up an alert.", { exact: true })).toBeVisible();
    await expect(page.getByText("1 simulator location found", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Other nearby venues/ })).toHaveCount(0);
    await directList.getByRole("button", { name: `Notify me for ${unreviewed.name}`, exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Notify me", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close notification setup", exact: true }).click();
    await expectNoHorizontalOverflow(page);
    await expectNoOutdoorReadsInSimulator(page);
    expect(requests.unexpectedRequests).toEqual([]);
  });
});
