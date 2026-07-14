import { describe, expect, it } from "vitest";

import {
  isAdditionalAlertEmailValid,
  normalizeAdditionalAlertEmails
} from "@/lib/searches/additional-emails";

describe("additional alert emails", () => {
  it("normalizes, deduplicates, excludes the owner, and keeps at most three recipients", () => {
    expect(
      normalizeAdditionalAlertEmails(
        [
          " FRIEND@example.com ",
          "friend@example.com",
          "owner@example.com",
          "second@example.com",
          "third@example.com",
          "fourth@example.com"
        ],
        "OWNER@example.com"
      )
    ).toEqual(["friend@example.com", "second@example.com", "third@example.com"]);
  });

  it("allows empty fields but rejects malformed recipient addresses", () => {
    expect(isAdditionalAlertEmailValid("")).toBe(true);
    expect(isAdditionalAlertEmailValid("golfer@example.com")).toBe(true);
    expect(isAdditionalAlertEmailValid("not-an-email")).toBe(false);
  });
});
