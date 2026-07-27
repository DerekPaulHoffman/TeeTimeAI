import { describe, expect, it } from "vitest";

import {
  getOperatorDashboardEmails,
  isOperatorEmail,
  normalizeOperatorEmail
} from "./access";

describe("operator access", () => {
  it("allows only normalized configured emails", () => {
    const configured = "owner@example.com, SECOND@example.com";
    expect(isOperatorEmail(" OWNER@example.com ", configured)).toBe(true);
    expect(isOperatorEmail("second@example.com", configured)).toBe(true);
    expect(isOperatorEmail("owner+test@example.com", configured)).toBe(false);
    expect(isOperatorEmail("someone@example.com", configured)).toBe(false);
    expect(isOperatorEmail(null, configured)).toBe(false);
    expect(isOperatorEmail("owner@example.com", "")).toBe(false);
  });

  it("normalizes an email without treating missing values as authorized", () => {
    expect(normalizeOperatorEmail("  PERSON@EXAMPLE.COM ")).toBe(
      "person@example.com"
    );
    expect(normalizeOperatorEmail(undefined)).toBe("");
    expect(getOperatorDashboardEmails(" A@example.com, a@example.com ")).toEqual(
      new Set(["a@example.com"])
    );
  });

  it("fails closed when any allowlist entry is malformed", () => {
    expect(
      isOperatorEmail(
        "operator@example.com",
        "operator@example.com,not-an-email"
      )
    ).toBe(false);
  });
});
