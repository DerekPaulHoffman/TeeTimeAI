// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ run: vi.fn(), database: vi.fn(() => true), runtime: vi.fn(() => "a".repeat(40)) }));
vi.mock("@/lib/env", () => ({ hasDatabaseConfig: mocks.database }));
vi.mock("@/lib/automation/runtime-version", () => ({ getAutomationRuntimeVersion: mocks.runtime }));
vi.mock("@/lib/automation/simulator-support-engineering-verification", () => ({ runSimulatorEngineeringVerification: mocks.run }));
import { POST } from "./route";

function request(body: unknown = { assignmentRef: "assignment", token: "original_token", revision: 3 }, key = "private_test_key", host = "teetimespot.com") {
  return new NextRequest(`https://${host}/api/automation/simulator-support/verify`, { method: "POST",
    headers: { "content-type": "application/json", "x-automation-key": key }, body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.stubEnv("AUTOMATION_API_KEY", "private_test_key"); vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_current"); vi.stubEnv("VERCEL_URL", "current.vercel.app");
  mocks.run.mockReset(); mocks.database.mockReturnValue(true); mocks.runtime.mockReturnValue("a".repeat(40));
  mocks.run.mockResolvedValue({ revision: 5, engineeringOnly: true, customerAcceptance: false, outcome: "NO_MATCH" });
});
afterEach(() => vi.unstubAllEnvs());

describe("private deployed engineering verification route", () => {
  it("requires its separate automation authority before reading the body or dispatching a provider", async () => {
    expect((await POST(request(undefined, "wrong"))).status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
    vi.stubEnv("AUTOMATION_API_KEY", "");
    expect((await POST(request())).status).toBe(503);
  });
  it("accepts only original assignment/token/revision, never caller URLs/dates/recipients or identity", async () => {
    for (const extra of [{ date: "2026-10-09" }, { url: "https://other.example" }, { ownerThreadId: "other" },
      { email: "golfer@example.test" }, { durationMinutes: 30 }, { releaseSha: "b".repeat(40) }]) {
      expect((await POST(request({ assignmentRef: "assignment", token: "original_token", revision: 3, ...extra }))).status).toBe(400);
    }
    expect((await POST(request({ assignmentRef: "assignment", token: "original_token", revision: 0 }))).status).toBe(400);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("fails closed on missing database, preview/local runtime, missing deployment or noncanonical host", async () => {
    mocks.database.mockReturnValue(false);
    expect((await POST(request())).status).toBe(503); mocks.database.mockReturnValue(true);
    vi.stubEnv("VERCEL_ENV", "preview"); expect((await POST(request())).status).toBe(503);
    vi.stubEnv("VERCEL_ENV", "production"); mocks.runtime.mockReturnValue("local"); expect((await POST(request())).status).toBe(503);
    mocks.runtime.mockReturnValue("a".repeat(40)); vi.stubEnv("VERCEL_DEPLOYMENT_ID", ""); expect((await POST(request())).status).toBe(503);
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_current"); expect((await POST(request(undefined, undefined, "current.vercel.app"))).status).toBe(503);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("derives runtime proof from deployed environment and preserves independent customer acceptance", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ customerAcceptance: false, engineeringOnly: true });
    expect(mocks.run).toHaveBeenCalledWith({ assignmentRef: "assignment", token: "original_token", revision: 3 }, {
      runtimeVersion: "a".repeat(40), deploymentId: "dpl_current", deploymentUrl: "https://current.vercel.app", environment: "production", host: "teetimespot.com" });
  });
  it("returns typed normal customer authority and never leaks stale token or provider failure prose", async () => {
    mocks.run.mockRejectedValue(new Error("SIMULATOR_ENGINEERING_CUSTOMER_CHECK_REQUIRED"));
    const response = await POST(request()); expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "NORMAL_CUSTOMER_CHECK_REQUIRED" });
    mocks.run.mockRejectedValue(new Error("private token and provider raw body"));
    const failed = await POST(request()); expect(failed.status).toBe(503);
    const failure = await failed.json(); expect(failure).toMatchObject({ code: "VERIFICATION_FAILED" });
    expect(JSON.stringify(failure)).not.toContain("private token");
    for (const [message, code] of [["SIMULATOR_ENGINEERING_BOOKING_NOT_OPEN", "BOOKING_NOT_OPEN"],
      ["SIMULATOR_ENGINEERING_WRITER_BUSY", "WRITER_BUSY"], ["SIMULATOR_ENGINEERING_EVIDENCE_LIMIT", "EVIDENCE_LIMIT"],
      ["SIMULATOR_ENGINEERING_VERIFICATION_READ_IN_FLIGHT", "READ_IN_FLIGHT"]]) {
      mocks.run.mockRejectedValue(new Error(message)); expect(await (await POST(request())).json()).toMatchObject({ code });
    }
  });
});
