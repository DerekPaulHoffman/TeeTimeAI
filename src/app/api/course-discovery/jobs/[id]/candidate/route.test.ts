// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signLocalReaderPayload } from "@/lib/local-reader/contracts";
const mocks = vi.hoisted(() => ({ propose: vi.fn() }));
vi.mock("@/lib/env", () => ({ hasDatabaseConfig: () => true }));
vi.mock("@/lib/course-discovery/service", async original => ({ ...await original<object>(), proposeDiscoveryRecipe: mocks.propose }));
import { POST } from "./route";

const secret = "test-only-discovery-source-key-123456";
const leaseToken = "11111111-1111-4111-8111-111111111111";
const path = "/api/course-discovery/jobs/job1/candidate";
const sourceEvidence = { officialUrl: "https://course.example.com/", observedBookingUrl: "https://booking.example.com/venue" };
function request(value: unknown, signed = true) {
  const body = JSON.stringify(value); const timestamp = String(Date.now());
  return new NextRequest(`https://teetimespot.com${path}`, { method: "POST", body, headers: { "content-type": "application/json",
    "x-local-reader-timestamp": timestamp, "x-local-reader-signature": signed ? signLocalReaderPayload(secret, `POST\n${path}\n${timestamp}\n${body}`) : "invalid" } });
}
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("LOCAL_READER_DEVICE_TOKEN", secret); mocks.propose.mockResolvedValue({ recipeHash: "a".repeat(64), challenges: [] }); });
afterEach(() => vi.unstubAllEnvs());
const context = { params: Promise.resolve({ id: "job1" }) };
describe("trusted observed-source candidate input", () => {
  it("accepts exact safe source evidence only through an authenticated request", async () => {
    const response = await POST(request({ leaseToken, recipe: {}, sourceEvidence }), context);
    expect(response.status).toBe(200);
    expect(mocks.propose).toHaveBeenCalledWith("job1", leaseToken, {}, sourceEvidence);
    expect((await POST(request({ leaseToken, recipe: {}, sourceEvidence }, false), context)).status).toBe(401);
    expect(mocks.propose).toHaveBeenCalledOnce();
  });
  it.each([
    { ...sourceEvidence, observedBookingUrl: "http://127.0.0.1/" },
    { ...sourceEvidence, observedBookingUrl: "https://user:password@booking.example.com/" },
    { ...sourceEvidence, passed: true },
  ])("rejects unsafe or expanded source evidence", async evidence => {
    expect((await POST(request({ leaseToken, recipe: {}, sourceEvidence: evidence }), context)).status).toBe(400);
    expect(mocks.propose).not.toHaveBeenCalled();
  });
});
