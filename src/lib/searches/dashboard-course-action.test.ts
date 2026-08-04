import { describe, expect, it } from "vitest";

import { getDashboardCourseAction } from "./dashboard-course-action";

describe("dashboard course actions", () => {
  it("turns phone-only access into a direct call instruction", () => {
    expect(getDashboardCourseAction("PHONE_ONLY", "(203) 555-0199")).toEqual({
      emoji: "📞",
      label: "Call the course",
      detail:
        "This course handles tee times by phone. Call (203) 555-0199 to check availability and book."
    });
  });

  it.each([
    ["ACCOUNT_REQUIRED", "🔐", "Sign in on the official site"],
    ["ACCOUNT_STAFF_PROVISIONED", "💬", "Contact the course"],
    ["WALK_IN_ONLY", "🚶", "Check with the course in person"],
    ["DIRECT_ONLINE", "🌐", "Check the official booking page"]
  ] as const)("maps %s to a customer action", (support, emoji, label) => {
    expect(getDashboardCourseAction(support)).toMatchObject({ emoji, label });
  });
});
