import { afterEach, describe, expect, it } from "vitest";

import { getAutomationRuntimeVersion } from "./runtime-version";

const originalSha = process.env.VERCEL_GIT_COMMIT_SHA;
const originalDeployment = process.env.VERCEL_DEPLOYMENT_ID;

afterEach(() => {
  process.env.VERCEL_GIT_COMMIT_SHA = originalSha;
  process.env.VERCEL_DEPLOYMENT_ID = originalDeployment;
});

describe("getAutomationRuntimeVersion", () => {
  it("prefers the Git commit SHA", () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "abc123";
    process.env.VERCEL_DEPLOYMENT_ID = "deployment-1";

    expect(getAutomationRuntimeVersion()).toBe("abc123");
  });

  it("does not expose unsafe environment text", () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "secret value with spaces";
    delete process.env.VERCEL_DEPLOYMENT_ID;

    expect(getAutomationRuntimeVersion()).toMatch(/^opaque:[a-f0-9]{24}$/);
    expect(getAutomationRuntimeVersion()).not.toContain("secret value");
  });
});
