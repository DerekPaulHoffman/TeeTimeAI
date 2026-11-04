// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const browserRuntime = vi.hoisted(() => ({ loads: vi.fn() }));
vi.mock("@playwright/test", () => {
  browserRuntime.loads();
  throw new Error("Cannot find module playwright-core/browsers.json");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("loads the real verification route and rejects unauthorized requests without the local browser runtime", async () => {
  vi.stubEnv("AUTOMATION_API_KEY", "fixture-automation-authority");
  const fetch = vi.fn().mockRejectedValue(new Error("Unexpected outbound request"));
  vi.stubGlobal("fetch", fetch);

  // Import the actual ownership/verification dependency tree, without mocking it.
  const { POST } = await import("./route");
  const response = await POST(new NextRequest("https://teetimespot.com/api/automation/simulator-support/verify", {
    method: "POST",
  }));

  expect(response.status).toBe(401);
  expect(browserRuntime.loads).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
}, 30_000);
