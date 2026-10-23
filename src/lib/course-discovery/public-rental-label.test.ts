import { describe, expect, it } from "vitest";
import { isPublicRentalLabel } from "./public-rental-label";

describe("shared existing public rental label predicate", () => {
  it.each(["Peak Rental", "Happy Hour Rental", "Golf Simulator", "Bay 2", "Private Room", "Golf multisport room", "  Rental  "])("retains existing accepted content %s", label => {
    expect(isPublicRentalLabel(label)).toBe(true);
  });
  it.each(["Happy Hour", "Peak", "Members only rental", "Golf lesson room", "Fitting bay", "League simulator", "Coaching room", "Baseball rental", "Tennis room"])("retains existing rejected content %s", label => {
    expect(isPublicRentalLabel(label)).toBe(false);
  });
});
