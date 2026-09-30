import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
const mocks = vi.hoisted(() => ({ db: vi.fn(), retain: vi.fn(), read: vi.fn(), start: vi.fn(), after: vi.fn() }));
vi.mock("next/server", async original => ({ ...await original<typeof import("next/server")>(), after: mocks.after }));
vi.mock("@/lib/env", () => ({ hasDatabaseConfig: mocks.db }));
vi.mock("@/lib/course-recovery/service", () => ({ retainRecoveryRequest: mocks.retain, readRecoveryView: mocks.read, RecoveryAdmissionError: class extends Error {} }));
vi.mock("@/lib/course-recovery/scheduler", () => ({ startRecoveryRequest: mocks.start }));
const body = { name: "Harbor Dunes", town: "Harborville CT" };
function request(value: unknown, headers: Record<string,string> = {}) {
  return new Request("https://teetimespot.com/api/courses/recovery", { method: "POST", headers, body: JSON.stringify(value) });
}
describe("durable anonymous recovery admission API", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.db.mockReturnValue(true); mocks.retain.mockResolvedValue({ id: "receipt123456", created: true }); mocks.read.mockResolvedValue({ id: "receipt123456", status: "QUEUED", course: null }); });
  it("retains bounded identity work without account/recipient authority", async () => {
    const response = await POST(request(body));
    expect(response.status).toBe(201);
    expect(mocks.retain).toHaveBeenCalledWith(body, expect.any(String));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.after).toHaveBeenCalledOnce();
  });
  it("returns the same receipt for repeated requests", async () => {
    mocks.retain.mockResolvedValue({ id: "receipt123456", created: false });
    expect((await POST(request(body))).status).toBe(200);
  });
  it.each([{ ...body, userId: "fake-owner" }, { ...body, alertEmail: "attacker@example.test" }, { ...body, latitude: 41 }, { ...body, town: "" }])("rejects authority injection or incomplete location %#", async value => {
    expect((await POST(request(value))).status).toBe(400);
    expect(mocks.retain).not.toHaveBeenCalled();
  });
  it("bounds streamed JSON input before persistence", async () => {
    expect((await POST(request({ ...body, name: "x".repeat(5000) }))).status).toBe(400);
    expect(mocks.retain).not.toHaveBeenCalled();
  });
  it("rejects foreign-origin submissions and unavailable storage", async () => {
    expect((await POST(request(body, { origin: "https://unrelated.example" }))).status).toBe(403);
    mocks.db.mockReturnValue(false);
    expect((await POST(request(body))).status).toBe(503);
    expect(mocks.retain).not.toHaveBeenCalled();
  });
  it("does not expose persistence errors or pretend a request was saved", async () => {
    mocks.retain.mockRejectedValue(new Error("postgres secret connection"));
    const response = await POST(request(body));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
    expect(mocks.after).not.toHaveBeenCalled();
  });
});
