import { describe, expect, it } from "vitest";

import { getCheckoutMode, getPushRef } from "../../../scripts/automation/preflight-git.mjs";

describe("automation preflight git strategy", () => {
  it("accepts main checkouts and pushes main", () => {
    expect(getCheckoutMode("main")).toBe("main");
    expect(getPushRef("main")).toBe("main");
  });

  it("accepts Codex detached worktrees and pushes HEAD to main", () => {
    expect(getCheckoutMode("HEAD")).toBe("detached");
    expect(getPushRef("detached")).toBe("HEAD:main");
  });

  it("rejects named non-main branches", () => {
    expect(getCheckoutMode("feature/course-search")).toBeNull();
  });
});
