import { expect, test } from "@playwright/test";
import path from "node:path";

test("compact filters preserve mode-specific preferences on desktop and mobile", async ({ page }, testInfo) => {
  const unexpected: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => sessionStorage.setItem("tee-time-spot:traffic-class", "TEST"));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/analytics/events") return route.fulfill({ json: {} });
    if (path === "/api/location/geocode") return route.fulfill({ json: { latitude: 41.14, longitude: -73.25 } });
    if (path === "/api/courses/discover") return route.fulfill({ json: { courses: [] } });
    unexpected.push(path);
    await route.abort();
  });
  await page.goto("/search");
  const form = page.getByRole("form", { name: "Course search filters" });
  await expect(form).toBeVisible();
  const venue = page.getByRole("group", { name: "Venue type", exact: true });
  test.skip(await venue.count() === 0, "Simulator feature must be enabled for this mode-switch test");
  await page.getByLabel("Location", { exact: true }).fill("Fairfield, CT");
  await page.getByRole("combobox", { name: "Players", exact: true }).selectOption("3");
  await page.getByRole("button", { name: "9-hole", exact: true }).click();
  await page.getByRole("slider", { name: "Distance from me" }).fill("25");
  const time = page.getByRole("group", { name: "Time window", exact: true });
  await time.getByRole("button").first().click();
  await page.getByRole("combobox", { name: "From (start time)" }).selectOption("10:00");
  await page.getByRole("combobox", { name: "To (end time)" }).selectOption("17:00");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(time.getByRole("button").first()).toBeFocused();
  const evidence = process.env.SIMULATOR_SCREENSHOT_DIR;
  const capture = async (mode: string) => {
    if (!evidence) return;
    const directory = path.resolve(evidence);
    expect(path.relative(process.cwd(), directory).startsWith(`..${path.sep}`)).toBe(true);
    await form.screenshot({ path: path.join(directory, `${testInfo.project.name}-${mode}.png`),
      style: ".topbar { visibility: hidden !important; }" });
  };
  await capture("golf");
  await venue.getByRole("button", { name: "Simulator", exact: true }).click();
  await expect(page.getByRole("group", { name: "Course layout", exact: true })).toHaveCount(0);
  const hours = page.getByRole("combobox", { name: "Number of hours", exact: true });
  await expect(hours).toHaveValue("any");
  await expect(page.getByRole("combobox", { name: "Players", exact: true })).toHaveValue("3");
  await expect(page.getByRole("slider", { name: "Distance from me" })).toHaveValue("25");
  await capture("simulator");
  await hours.selectOption("120");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Number of hours", exact: true })).toHaveValue("120");
  await venue.getByRole("button", { name: "Golf", exact: true }).click();
  await expect(page.getByRole("button", { name: "9-hole", exact: true })).toHaveAttribute("aria-pressed", "true");
  await venue.getByRole("button", { name: "Simulator", exact: true }).click();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(hours).toHaveValue("any");
  await expect(venue.getByRole("button", { name: "Simulator", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("slider", { name: "Distance from me" })).toHaveValue("15");
  await expect(page.getByRole("combobox", { name: "Players", exact: true })).toHaveValue("3");
  await time.getByRole("button").first().click();
  await page.getByRole("combobox", { name: "From (start time)" }).selectOption("12:15");
  await page.getByRole("combobox", { name: "To (end time)" }).selectOption("23:45");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(time.getByRole("button").first()).toHaveText("12:15 – 11:45 PM");
  expect(await time.getByRole("button").first().evaluate(button => button.scrollWidth <= button.clientWidth)).toBe(true);
  const geometry = await form.evaluate(element => ({
    viewport: innerWidth,
    page: document.documentElement.scrollWidth,
    controls: [...element.querySelectorAll<HTMLElement>("button, select, input")]
      .filter(control => control.getClientRects().length > 0 && control.getAttribute("type") !== "range")
      .map(control => ({ label: control.getAttribute("aria-label") ?? control.id ?? control.textContent,
        x: control.getBoundingClientRect().x, right: control.getBoundingClientRect().right,
        height: control.getBoundingClientRect().height })),
  }));
  expect(geometry.page).toBeLessThanOrEqual(geometry.viewport + 1);
  expect(geometry.controls.every(control => control.x >= 0 && control.right <= geometry.viewport)).toBe(true);
  if (geometry.viewport <= 620) expect(geometry.controls.filter(control => control.height < 40)).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
