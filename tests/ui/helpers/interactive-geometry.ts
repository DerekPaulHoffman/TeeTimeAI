import { expect, type Page, type TestInfo } from "@playwright/test";

export async function collectInteractiveElementIssues(page: Page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll<HTMLElement>("a, button, input, select, textarea"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const text = element.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const isVisible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0";

        const insideMapAttribution =
          Boolean(element.closest(".course-results-map")) ||
          Boolean(element.closest(".leaflet-container")) ||
          Boolean(element.closest(".gm-style"));
        const problems: string[] = [];
        if (insideMapAttribution) {
          return {
            tag: element.tagName.toLowerCase(),
            className: typeof element.className === "string" ? element.className : "",
            text: text.slice(0, 80),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            problems
          };
        }
        if (isVisible && rect.width < 24) {
          problems.push("too narrow");
        }
        if (isVisible && rect.height < 24) {
          problems.push("too short");
        }
        if (
          isVisible &&
          text &&
          element.scrollWidth > element.clientWidth + 2 &&
          element.clientWidth > 0
        ) {
          problems.push("text overflows");
        }

        return {
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === "string" ? element.className : "",
          text: text.slice(0, 80),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          problems
        };
      })
      .filter((entry) => entry.problems.length > 0)
      .slice(0, 20);
  });
}

export async function expectInteractiveElementsAreUsable(
  page: Page,
  testInfo: Pick<TestInfo, "attach">,
  options: { timeout?: number } = {}
) {
  let issues: Awaited<ReturnType<typeof collectInteractiveElementIssues>> | null = null;
  try {
    // Navigation can expose text before its styles arrive. Keep checking the
    // actual geometry, including persistent failures, within the test timeout.
    await expect.poll(async () => {
      issues = await collectInteractiveElementIssues(page);
      return issues;
    }, options).toEqual([]);
  } finally {
    await testInfo.attach("interactive-element-issues.json", {
      body: JSON.stringify(issues, null, 2),
      contentType: "application/json"
    });
  }
}
