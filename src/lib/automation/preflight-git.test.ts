import { describe, expect, it } from "vitest";

import { getCheckoutMode, getPushRef } from "../../../scripts/automation/preflight-git.mjs";

describe("automation preflight git strategy", () => {
  it("rejects main checkouts", () => {
    expect(getCheckoutMode("main")).toBeNull();
  });

  it("rejects detached worktrees until the thread creates a named branch", () => {
    expect(getCheckoutMode("HEAD")).toBeNull();
  });

  it("accepts named thread branches and pushes HEAD to main", () => {
    expect(getCheckoutMode("feature/course-search")).toBe("thread_branch");
    expect(getPushRef("thread_branch")).toBe("HEAD:main");
  });
});
