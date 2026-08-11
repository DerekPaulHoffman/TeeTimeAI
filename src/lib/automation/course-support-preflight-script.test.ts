import { describe, expect, it } from "vitest";

import {
  launchFailureResult,
  responderInvocation
} from "../../../scripts/automation/course-support-preflight.mjs";

describe("course support preflight process launch", () => {
  it("routes the static responder command through cmd.exe on Windows", () => {
    expect(responderInvocation("win32", "C:\\Windows\\System32\\cmd.exe")).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "npx vercel env run -e production -- npm run automation:course-support -- inspect"
      ]
    });
  });

  it("invokes npx directly on non-Windows platforms", () => {
    expect(responderInvocation("linux")).toEqual({
      command: "npx",
      args: [
        "vercel",
        "env",
        "run",
        "-e",
        "production",
        "--",
        "npm",
        "run",
        "automation:course-support",
        "--",
        "inspect"
      ]
    });
  });

  it("reports spawn errors without exposing their message", () => {
    const result = launchFailureResult({
      error: Object.assign(new Error("sensitive local path"), { code: "EINVAL" }),
      status: null
    });

    expect(result).toMatchObject({
      outcome: "setup_required",
      failureClass: "PROCESS_LAUNCH_FAILED",
      errorCode: "EINVAL"
    });
    expect(JSON.stringify(result)).not.toContain("sensitive local path");
  });

  it("reports a missing exit status even when no spawn error is present", () => {
    expect(launchFailureResult({ error: undefined, status: null })).toMatchObject({
      outcome: "setup_required",
      failureClass: "MISSING_EXIT_STATUS"
    });
  });

  it("leaves normal child exits unchanged", () => {
    expect(launchFailureResult({ error: undefined, status: 0 })).toBeNull();
    expect(launchFailureResult({ error: undefined, status: 2 })).toBeNull();
  });
});
