import { expect, test } from "@playwright/test";

const discoveredCourses = [
  {
    googlePlaceId: "woodhaven",
    name: "Woodhaven Golf Course",
    address: "275 Miller Rd, Bethany, CT 06524",
    latitude: 41.415596,
    longitude: -73.039627,
    distanceMeters: 1200,
    layoutHoleCounts: [9],
    layoutHolesStatus: "VERIFIED",
    layoutHolesEvidenceUrl: "https://www.woodhavenctgolf.com/"
  },
  {
    googlePlaceId: "verified-eighteen",
    name: "Verified Eighteen Golf Course",
    address: "18 Fairway Dr, Bethany, CT 06524",
    latitude: 41.42,
    longitude: -73.04,
    distanceMeters: 1800,
    layoutHoleCounts: [18],
    layoutHolesStatus: "VERIFIED",
    priceEstimate: {
      currency: "USD",
      observedAt: "2026-07-11T12:00:00.000Z",
      nineHoles: { minPriceCents: 2200, maxPriceCents: 2200, sampleSize: 1 },
      eighteenHoles: { minPriceCents: 3900, maxPriceCents: 4500, sampleSize: 2 }
    }
  },
  {
    googlePlaceId: "unverified-layout",
    name: "Unverified Public Golf Course",
    address: "9 Unknown Ln, Bethany, CT 06524",
    latitude: 41.43,
    longitude: -73.05,
    distanceMeters: 2100,
    layoutHolesStatus: "UNVERIFIED"
  }
];

test.describe("physical course layout filtering", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.sessionStorage.setItem("tee-time-spot:traffic-class", "AUTOMATION");
    });
    await page.route("**/api/analytics/events", async (route) => {
      await route.fulfill({
        body: JSON.stringify({ event: { id: "course-layout-test-event" } }),
        contentType: "application/json",
        status: 201
      });
    });
    await page.route("**/api/courses/discover?**", async (route) => {
      await route.fulfill({
        body: JSON.stringify({ courses: discoveredCourses }),
        contentType: "application/json",
        status: 200
      });
    });
  });

  test("keeps verified nine-hole courses out of an 18-hole search", async ({ page }) => {
    await page.goto("/search");
    await page.getByRole("textbox", { name: "Location", exact: true }).fill("Bethany, CT");
    await page.getByRole("button", { name: "18-hole", exact: true }).click();
    await page.getByRole("button", { name: "Search", exact: true }).click();

    await expect(page.getByText("Verified Eighteen Golf Course", { exact: true })).toBeVisible();
    await expect(page.getByText("Woodhaven Golf Course", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Unverified Public Golf Course", { exact: true })).toBeVisible();
    await expect(page.getByText("Layout unverified", { exact: true })).toBeVisible();
    await expect(page.getByText(/Hiding 1 verified course without an 18-hole layout/)).toBeVisible();
    const verifiedEighteenRow = page.locator(".course-row").filter({
      hasText: "Verified Eighteen Golf Course"
    });
    await expect(verifiedEighteenRow.getByLabel(/Estimated 9-hole price/)).toBeVisible();
    await expect(verifiedEighteenRow.getByLabel(/Estimated 18-hole price/)).toBeVisible();

    await page.getByRole("button", { name: "9-hole", exact: true }).click();
    await expect(page.getByText("Woodhaven Golf Course", { exact: true })).toBeVisible();
    await expect(page.getByText("Verified Eighteen Golf Course", { exact: true })).toHaveCount(0);
    await expect(page.getByText("9-hole course", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Any", exact: true }).click();
    await expect(page.getByText("Woodhaven Golf Course", { exact: true })).toBeVisible();
    await expect(page.getByText("Verified Eighteen Golf Course", { exact: true })).toBeVisible();
  });
});
