// @vitest-environment node
import { expect, it } from "vitest";
import { sameStagehandDocumentReadUrl, createGuardedStagehandSourceBrowser } from "./stagehand-source-browser";
it("readiness correlates only fragment changes of the same native document URL", () => {
  const url = "https://owned.example/public?venue=one&kind=day";
  expect(sameStagehandDocumentReadUrl(url, url + "#teetimes")).toBe(true);
  expect(sameStagehandDocumentReadUrl(url + "#old", url + "#new")).toBe(true);
  for (const other of ["https://foreign.example/public?venue=one&kind=day", "https://owned.example/other?venue=one&kind=day", "https://owned.example/public?venue=two&kind=day", "https://owned.example/public?kind=day&venue=one", undefined, null])
    expect(sameStagehandDocumentReadUrl(url, other)).toBe(false);
});
it("rejects an expired or over-four-minute source context before starting proxy/browser work", async () => {
  for (const remaining of [-1, 240001]) {
    const now = Date.now;
    Date.now = () => 2000000;
    try {
      await expect(createGuardedStagehandSourceBrowser({ initialUrl: "https://owned.example/public", timeZone: "UTC", deadlineAt: new Date(2000000 + remaining) },
        { requestLease: async () => { throw Error("NO_PROVIDER_WORK"); } })).rejects.toThrow();
    } finally { Date.now = now; }
  }
});
