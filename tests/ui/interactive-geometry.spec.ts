import { expect, test, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";

import {
  collectInteractiveElementIssues,
  expectInteractiveElementsAreUsable
} from "./helpers/interactive-geometry";

test("waits for delayed styles before accepting interactive geometry", async ({ page }, testInfo) => {
  let releaseStyles!: () => void;
  const stylesReleased = new Promise<void>((resolve) => { releaseStyles = resolve; });
  let requestStarted!: () => void;
  const styleRequested = new Promise<void>((resolve) => { requestStarted = resolve; });
  let unexpectedRequests = 0;
  let stylesheetDelivered = false;

  await page.route("**/*", async (route) => {
    if (route.request().url() !== "https://geometry.invalid/fixture.css") {
      unexpectedRequests += 1;
      await route.abort();
      return;
    }
    requestStarted();
    await stylesReleased;
    await route.fulfill({
      status: 200,
      contentType: "text/css",
      body: ".control { display: inline-block; width: 100px; height: 44px; }"
    });
    stylesheetDelivered = true;
  });
  await page.setContent('<a class="control" href="#target">Open</a>');
  await page.evaluate(() => {
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = "https://geometry.invalid/fixture.css";
    document.head.append(stylesheet);
  });
  await styleRequested;
  expect(await collectInteractiveElementIssues(page)).toEqual([
    expect.objectContaining({ problems: ["too short"] })
  ]);

  const delayedStyles = page.waitForTimeout(250).then(releaseStyles);
  try {
    await expectInteractiveElementsAreUsable(page, testInfo);
  } finally {
    releaseStyles();
    await delayedStyles;
  }

  expect(stylesheetDelivered).toBe(true);
  expect(await readGeometryAttachment(testInfo)).toEqual([]);
  expect(unexpectedRequests).toBe(0);
});

test("still rejects a permanently undersized control and attaches final geometry", async ({ page }, testInfo) => {
  let requests = 0;
  await page.route("**/*", async (route) => {
    requests += 1;
    await route.abort();
  });
  await page.setContent(
    '<a href="#target" style="display:inline-block;width:100px;height:17px">Open</a>'
  );

  await expect(
    expectInteractiveElementsAreUsable(page, testInfo, { timeout: 300 })
  ).rejects.toThrow("Timeout 300ms exceeded while waiting on the predicate");

  expect(await readGeometryAttachment(testInfo)).toEqual([
    expect.objectContaining({ height: 17, width: 100, problems: ["too short"] })
  ]);
  expect(requests).toBe(0);
});

async function readGeometryAttachment(testInfo: TestInfo) {
  const attachment = testInfo.attachments.find(
    (entry) => entry.name === "interactive-element-issues.json"
  );
  expect(attachment).toBeDefined();
  const body = attachment?.body ?? await readFile(attachment!.path!);
  return JSON.parse(body.toString("utf8"));
}
