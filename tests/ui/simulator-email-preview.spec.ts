import { expect, test } from "@playwright/test";

test("simulator emails keep the branded design and complete session controls", async ({ page }, testInfo) => {
  await page.route("**/api/**", (route) => route.abort());
  await page.goto("/email-preview?mode=SIMULATOR");
  const instant = page.frameLocator("iframe[title='Rendered instant alert email']");
  await expect(instant.locator("body")).toContainText("NEW SIMULATOR ALERT");
  await expect(instant.locator("body")).toContainText("Golf Lounge 18 Fairfield");
  await expect(instant.locator("body")).toContainText("60 minutes");
  await expect(instant.locator("body")).toContainText("One simulator bay");
  await expect(instant.locator("body")).toContainText("9:00 AM");
  await expect(instant.locator("body")).toContainText("10:00 AM");
  await expect(instant.locator("body")).not.toContainText("4 golfers");
  await expect(instant.locator("body")).not.toContainText("18 holes");
  await expect(instant.getByRole("link", { name: "I booked — stop these results" }))
    .toHaveAttribute("href", "/alerts/stop?token=preview-booked");
  await expect(instant.getByRole("link", { name: "Cancel this alert", exact: true }))
    .toHaveAttribute("href", "/alerts/stop?token=preview-cancelled");
  const frame = page.locator("iframe[title='Rendered instant alert email']");
  const overflow = await frame.evaluate((element) => {
    const document = (element as HTMLIFrameElement).contentDocument!;
    return document.documentElement.scrollWidth - document.documentElement.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(2);
  await frame.screenshot({ path: testInfo.outputPath("simulator-match-email.png") });

  await page.getByRole("link", { name: "Alert setup", exact: true }).click();
  await expect(page).toHaveURL(/variant=setup&mode=SIMULATOR$/);
  const setup = page.frameLocator("iframe[title='Rendered alert setup email']");
  await expect(setup.locator("body")).toContainText("Your simulator alert is saved");
  await expect(setup.locator("body")).toContainText("X-Golf Stratford");
  await expect(setup.locator("body")).toContainText("No matching session is available right now");
  await expect(setup.getByRole("link", { name: "Cancel this alert", exact: true })).toBeVisible();
  await page.locator("iframe[title='Rendered alert setup email']")
    .screenshot({ path: testInfo.outputPath("simulator-setup-email.png") });

  await page.getByRole("link", { name: "View course emails", exact: true }).click();
  await expect(page).toHaveURL(/variant=setup$/);
  await expect(page.frameLocator("iframe[title='Rendered alert setup email']").locator("body"))
    .toContainText("Pinebrook Golf Club");
});
