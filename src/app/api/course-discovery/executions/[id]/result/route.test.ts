// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signLocalReaderPayload } from "@/lib/local-reader/contracts";

const mocks = vi.hoisted(() => ({ complete: vi.fn(), queue: vi.fn(), degrade: vi.fn() }));
vi.mock("@/lib/env", () => ({ hasDatabaseConfig: () => true }));
vi.mock("@/lib/course-discovery/runtime", () => ({ completeRecipeExecution: mocks.complete,
  recipeExecutionNeedsRepair: () => true }));
vi.mock("@/lib/course-discovery/integration", () => ({ queueDiscoverySearchRecheck: mocks.queue }));
vi.mock("@/lib/course-discovery/service", () => ({ degradeRecipe: mocks.degrade,
  DiscoveryConflictError: class DiscoveryConflictError extends Error {} }));
import { DiscoveryConflictError } from "@/lib/course-discovery/service";
import { POST } from "./route";

const secret = "test-only-saved-recipe-result-key-123456";
const leaseToken = "11111111-1111-4111-8111-111111111111";
const path = "/api/course-discovery/executions/execution1/result";
const result = { status: "INCOMPLETE", complete: false, observedAt: "2030-01-02T12:00:00.000Z",
  sourceUrl: "https://golf.example.com/times", slots: [], evidence: { recipeHash: "a".repeat(64), reason: "INVALID_SOURCE",
    venueVerified: false, dateVerified: false, capacityVerified: false, durationVerified: false, completeVerified: false } };
const context = { params: Promise.resolve({ id: "execution1" }) };
function request(value: unknown, signed = true) {
  const body = JSON.stringify(value), timestamp = String(Date.now());
  return new NextRequest(`https://teetimespot.com${path}`, { method: "POST", body, headers: { "content-type": "application/json",
    "x-local-reader-timestamp": timestamp, "x-local-reader-signature": signed ? signLocalReaderPayload(secret, `POST\n${path}\n${timestamp}\n${body}`) : "invalid" } });
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("LOCAL_READER_DEVICE_TOKEN", secret); vi.stubEnv("COURSE_DISCOVERY_DEVICE_TOKEN", undefined);
  mocks.complete.mockResolvedValue({ searchId: "search1", recipeId: "recipe1", target: { courseId: "course1", kind: "OUTDOOR" } });
  mocks.queue.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe("saved method execution result", () => {
  it("persists a failed read and schedules its normal recheck without clearing the verified method", async () => {
    const response = await POST(request({ leaseToken, result }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ completed: true, recheckQueued: true });
    expect(mocks.complete).toHaveBeenCalledWith("execution1", leaseToken, result);
    expect(mocks.queue).toHaveBeenCalledWith("search1", "execution1");
    expect(mocks.complete.mock.invocationCallOrder[0]).toBeLessThan(mocks.queue.mock.invocationCallOrder[0]);
    expect(mocks.degrade).not.toHaveBeenCalled();
  });
  it("retains failed evidence if recheck dispatch is unavailable", async () => {
    mocks.queue.mockRejectedValue(new Error("private failure details"));
    const response = await POST(request({ leaseToken, result }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ completed: true, recheckQueued: false });
    expect(mocks.degrade).not.toHaveBeenCalled();
  });
  it("preserves completion conflicts before any recheck or pointer change", async () => {
    mocks.complete.mockRejectedValue(new DiscoveryConflictError());
    expect((await POST(request({ leaseToken, result }), context)).status).toBe(409);
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(mocks.degrade).not.toHaveBeenCalled();
  });
  it("does not accept unsigned results", async () => {
    expect((await POST(request({ leaseToken, result }, false), context)).status).toBe(401);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.queue).not.toHaveBeenCalled();
  });
  it("rejects expanded result authority before completion", async () => {
    expect((await POST(request({ leaseToken, result, failedRecipeId: "another-recipe" }), context)).status).toBe(400);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.queue).not.toHaveBeenCalled();
  });
});
