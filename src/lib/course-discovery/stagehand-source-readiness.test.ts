// @vitest-environment node
import { expect, it } from "vitest";
import { sameStagehandDocumentReadUrl } from "./stagehand-source-browser";
it("readiness correlates only fragment changes of the same native document URL", () => {
  const url = "https://owned.example/public?venue=one&kind=day";
  expect(sameStagehandDocumentReadUrl(url, url + "#teetimes")).toBe(true);
  expect(sameStagehandDocumentReadUrl(url + "#old", url + "#new")).toBe(true);
  for (const other of ["https://foreign.example/public?venue=one&kind=day", "https://owned.example/other?venue=one&kind=day", "https://owned.example/public?venue=two&kind=day", "https://owned.example/public?kind=day&venue=one", undefined, null])
    expect(sameStagehandDocumentReadUrl(url, other)).toBe(false);
});
