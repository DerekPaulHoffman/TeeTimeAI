// @vitest-environment node
import { expect, it } from "vitest";
import { parseCpsCourseNameComparisonEvidence } from "./cps-course-name-comparison-evidence";
import { safePrivateCourseNameComparison } from "../../../scripts/automation/course-discovery-worker.mjs";

const fixture = () => ({ schemaVersion: 1, kind: "CPS_NAMED_COURSE_COMPARISON", observedAt: "2030-01-01T00:00:00.000Z",
  canonicalName: "harbor pointe", officialNames: ["north", "south"], providerNames: ["harbor north", "harbor south"] });
it("retains only bounded normalized comparison inputs across the real TS/worker boundary", () => {
  const input = fixture();
  expect(parseCpsCourseNameComparisonEvidence(input)).toEqual(input);
  expect(safePrivateCourseNameComparison(input)).toEqual(input);
  const returned = safePrivateCourseNameComparison(input)!;
  returned.providerNames[0] = "changed";
  expect(input.providerNames[0]).toBe("harbor north");
});
it.each(["unknown-field", "url", "email", "control", "case", "spaces", "timestamp", "count", "size"])("rejects unsafe private comparison shape: %s", change => {
  const value = fixture();
  if (change === "unknown-field") Object.assign(value, { headers: "PRIVATE" });
  if (change === "url") value.providerNames[0] = "https://private.example/";
  if (change === "email") value.providerNames[0] = "private@example.test";
  if (change === "control") value.providerNames[0] = "north\nprivate";
  if (change === "case") value.providerNames[0] = "North";
  if (change === "spaces") value.providerNames[0] = " north  course ";
  if (change === "timestamp") value.observedAt = "2030-01-01T00:00:00Z";
  if (change === "count") value.providerNames = ["north"];
  if (change === "size") value.providerNames = Array.from({ length: 40 }, () => "a".repeat(240));
  expect(parseCpsCourseNameComparisonEvidence(value)).toBeUndefined();
  expect(safePrivateCourseNameComparison(value)).toBeUndefined();
});
