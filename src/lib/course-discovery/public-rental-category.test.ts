import { describe, expect, it } from "vitest";
import { interactiveControlKind } from "@/lib/automation/simulator-interactive-browser";

describe("public rental category selection", () => {
  const button = { tag: "button", role: "button", name: "Rentals", label: "", sensitiveForm: false };
  it("exposes the rental catalogue without a session or time selection", () => {
    expect(interactiveControlKind(button)).toBe("filter");
    expect(interactiveControlKind({ ...button, label: "Rentals" })).toBe("filter");
    expect(interactiveControlKind({ ...button, name: "Rentals\nRent a space and practice your own way.", label: "Rentals" })).toBe("filter");
  });
  it.each([
    { sensitiveForm: true }, { name: "Reserve Rentals" }, { name: "Rentals 10:00 AM" },
    { label: "Confirm" }, { name: "Memberships" }, { tag: "input" },
    { name: "Other category", label: "Rentals" }, { name: "Rentals\nReserve 10:00 AM", label: "Rentals" },
  ])("keeps transactions, sensitive forms and unrelated controls excluded: %j", change => {
    expect(interactiveControlKind({ ...button, ...change })).toBeNull();
  });
});
