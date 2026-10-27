import { expect, test } from "@playwright/test";

import { CUSTOMER_EMAIL_STATES, getCustomerStatusCopy } from "../../src/lib/email/customer-status-copy";

for (const simulator of [false, true]) {
  test(`every ${simulator ? "simulator" : "course"} email state is readable and honest`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", route => route.abort());
    for (const state of CUSTOMER_EMAIL_STATES) {
      await page.goto(`/email-preview?variant=setup&state=${state}${simulator ? "&mode=SIMULATOR" : ""}`);
      const frame = page.locator("iframe[title='Rendered venue status email']");
      const email = page.frameLocator("iframe[title='Rendered venue status email']");
      await expect(email.locator(`[data-email-state='${state}']`)).toBeVisible();
      const copy = getCustomerStatusCopy(state, { simulator });
      await expect(email.locator("body")).toContainText(copy.heading);
      await expect(email.locator("body")).toContainText(copy.userActionNeeded ? "Your next step" : "What we’ll do next");
      await expect(email.locator("body")).not.toContainText("PRIORITY");
      if (simulator) await expect(email.locator("body")).not.toContainText(/tee times|golfers|holes|course layout/i);
      if (state === "retrying") {
        await expect(email.locator("body")).toContainText("We couldn’t confirm openings on our last check.");
        await expect(email.locator("body")).toContainText("You don’t need to do anything.");
      }
      const geometry = await frame.evaluate(element => {
        const doc = (element as HTMLIFrameElement).contentDocument!;
        return {
          overflow: doc.documentElement.scrollWidth - doc.documentElement.clientWidth,
          extraHeight: Math.abs(element.getBoundingClientRect().height - doc.body.getBoundingClientRect().height),
          clipped: [...doc.querySelectorAll("a")].filter(a => a.scrollWidth > a.clientWidth + 2).map(a => a.textContent),
          small: [...doc.querySelectorAll("a")].filter(a => a.getBoundingClientRect().height < 43).map(a => a.textContent)
        };
      });
      expect(geometry.overflow, state).toBe(0);
      expect(geometry.extraHeight, state).toBeLessThanOrEqual(2);
      expect(geometry.clipped, state).toEqual([]);
      expect(geometry.small, state).toEqual([]);
      if (["retrying", "window", "account"].includes(state)) await frame.screenshot({ path: testInfo.outputPath(`${simulator ? "simulator" : "course"}-${state}.png`) });
    }
    await page.getByLabel("Sample venue state").selectOption("retrying");
    await page.getByRole("button", { name: "Show sample" }).click();
    await expect(page).toHaveURL(/state=retrying/);
    await page.getByRole("link", { name: simulator ? "View course emails" : "View simulator emails", exact: true }).click();
    await expect(page).toHaveURL(/state=retrying/);
    await expect(page.frameLocator("iframe[title='Rendered venue status email']").locator("body"))
      .toContainText("WE’RE CHECKING ON IT");
    expect(errors).toEqual([]);
  });
}
