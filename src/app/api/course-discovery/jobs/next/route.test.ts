// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signLocalReaderPayload } from "@/lib/local-reader/contracts";

const mocks = vi.hoisted(() => ({ next: vi.fn(), activate: vi.fn(), queue: vi.fn() }));
vi.mock("@/lib/env", () => ({ hasDatabaseConfig: () => true }));
vi.mock("@/lib/course-discovery/service", () => ({ claimNextDiscoveryJob: mocks.next, activateDiscoveryRecipe: mocks.activate,
  DiscoveryConflictError: class DiscoveryConflictError extends Error {} }));
vi.mock("@/lib/course-discovery/integration", () => ({ queueDiscoveryTargetRechecks: mocks.queue }));
import { POST } from "./route";
import { POST as activate } from "../[id]/activate/route";

const secret = "test-only-local-discovery-key-123456";
function request(path: string, value: unknown, signed = true, token = secret) {
  const body = JSON.stringify(value);
  const timestamp = String(Date.now());
  return new NextRequest(`https://teetimespot.com${path}`, { method: "POST", body, headers: {
    "content-type": "application/json", "x-local-reader-timestamp": timestamp,
    "x-local-reader-signature": signed ? signLocalReaderPayload(token, `POST\n${path}\n${timestamp}\n${body}`) : "invalid",
  } });
}
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("LOCAL_READER_DEVICE_TOKEN", secret); vi.stubEnv("COURSE_DISCOVERY_DEVICE_TOKEN", undefined); });
afterEach(() => vi.unstubAllEnvs());

describe("private discovery API boundary", () => {
  it("does not claim anything for an unsigned caller", async () => {
    const response = await POST(request("/api/course-discovery/jobs/next", { workerId: "worker-one" }, false));
    expect(response.status).toBe(401);
    expect(mocks.next).not.toHaveBeenCalled();
  });
  it("uses the dedicated learning credential when configured", async () => {
    const dedicated = "dedicated-course-discovery-fixture-token";
    vi.stubEnv("COURSE_DISCOVERY_DEVICE_TOKEN", dedicated);
    const rejected = await POST(request("/api/course-discovery/jobs/next", { workerId: "worker-one" }));
    expect(rejected.status).toBe(401); expect(mocks.next).not.toHaveBeenCalled();
    mocks.next.mockResolvedValue(null);
    const accepted = await POST(request("/api/course-discovery/jobs/next", { workerId: "worker-one" }, true, dedicated));
    expect(accepted.status).toBe(200); expect(mocks.next).toHaveBeenCalledWith("worker-one");
  });
  it("rejects unknown fields instead of letting callers supply job authority", async () => {
    const response = await POST(request("/api/course-discovery/jobs/next", { workerId: "worker-one", deadlineAt: "later" }));
    expect(response.status).toBe(400);
    expect(mocks.next).not.toHaveBeenCalled();
  });
  it("claims through the authenticated controller and disables response caching", async () => {
    mocks.next.mockResolvedValue({ id: "job1" });
    const response = await POST(request("/api/course-discovery/jobs/next", { workerId: "worker-one" }));
    expect(await response.json()).toEqual({ job: { id: "job1" } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.next).toHaveBeenCalledWith("worker-one");
  });
  it("does not accept caller-supplied verification when activating", async () => {
    const response = await activate(request("/api/course-discovery/jobs/job1/activate", { leaseToken: "11111111-1111-4111-8111-111111111111", verification: { passed: true } }), { params: Promise.resolve({ id: "job1" }) });
    expect(response.status).toBe(400);
    expect(mocks.activate).not.toHaveBeenCalled();
  });
  it("retains successful adoption when the deployed recheck start is unavailable", async () => {
    const adopted = { jobId: "job1", recipeId: "recipe1", version: 1, hash: "a".repeat(64), target: { courseId: "course1", kind: "OUTDOOR" } };
    mocks.activate.mockResolvedValue(adopted);
    mocks.queue.mockRejectedValue(new Error("Do not expose private runtime diagnostics"));
    const response = await activate(request("/api/course-discovery/jobs/job1/activate", { leaseToken: "11111111-1111-4111-8111-111111111111" }), { params: Promise.resolve({ id: "job1" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...adopted, recheckQueued: false });
  });
});
