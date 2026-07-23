import { describe, expect, it } from "vitest";

import {
  OPERATOR_EMAIL,
  isOperatorEmail,
  normalizeOperatorEmail
} from "./access";

describe("operator access", () => {
  it("allows only the normalized primary operator email", () => {
    expect(isOperatorEmail(OPERATOR_EMAIL)).toBe(true);
    expect(isOperatorEmail("  DerekPaulHoffman@GMAIL.COM ")).toBe(true);
    expect(isOperatorEmail("derekpaulhoffman+test@gmail.com")).toBe(false);
    expect(isOperatorEmail("someone@example.com")).toBe(false);
    expect(isOperatorEmail(null)).toBe(false);
  });

  it("normalizes an email without treating missing values as authorized", () => {
    expect(normalizeOperatorEmail("  PERSON@EXAMPLE.COM ")).toBe(
      "person@example.com"
    );
    expect(normalizeOperatorEmail(undefined)).toBe("");
  });
});
