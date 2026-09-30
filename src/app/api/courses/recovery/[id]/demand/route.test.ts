import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, POST } from "./route";

const mocks = vi.hoisted(() => ({ user: vi.fn(), database: vi.fn(), clerk: vi.fn(), get: vi.fn(), save: vi.fn(), cancel: vi.fn() }));
vi.mock("@/lib/auth/current-user", () => ({ getRequiredAppUser: mocks.user }));
vi.mock("@/lib/env", () => ({ hasDatabaseConfig: mocks.database, hasClerkConfig: mocks.clerk }));
vi.mock("@/lib/course-recovery/demand", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/course-recovery/demand")>(),
  getRecoveryDemandForUser: mocks.get, saveRecoveryDemandForUser: mocks.save, cancelRecoveryDemandForUser: mocks.cancel,
}));
const context = { params: Promise.resolve({ id: "request-1" }) };
const settings = { date: "2027-01-01", startTime: "09:00", endTime: "15:00", players: 2, additionalEmails: ["FRIEND@example.com"] };
function request(body = settings) { return new NextRequest("http://localhost/api/courses/recovery/request-1/demand", { method: "POST", body: JSON.stringify({ settings: body }), headers: { "content-type": "application/json" } }); }
beforeEach(() => {
  vi.clearAllMocks();
  mocks.database.mockReturnValue(true); mocks.clerk.mockReturnValue(true);
  mocks.user.mockResolvedValue({ id: "owner", email: "owner@example.com" });
  mocks.save.mockResolvedValue({ id: "demand-1", status: "WAITING", teeSearchId: null });
});
describe("owner pending recovery demand API", () => {
  it("derives owner authority from Clerk and normalizes settings", async () => {
    expect((await POST(request(), context)).status).toBe(201);
    expect(mocks.save).toHaveBeenCalledWith("request-1", { id: "owner", email: "owner@example.com" },
      expect.objectContaining({ additionalEmails: ["friend@example.com"], cadenceMinutes: 5 }), "UNCLASSIFIED");
  });
  it("accepts the actual strict settings envelope submitted by the recovery panel", async () => {
    const uiPayload = { settings: { date: "2027-01-01", startTime: "09:00", endTime: "15:00", userTimeZone: "America/New_York",
      players: 2, cadenceMinutes: 5, additionalEmails: ["friend@example.com"] } };
    const uiRequest = new NextRequest("http://localhost/api/courses/recovery/request-1/demand", {
      method: "POST", body: JSON.stringify(uiPayload), headers: { "content-type": "application/json" },
    });
    expect((await POST(uiRequest, context)).status).toBe(201);
    expect(mocks.save).toHaveBeenCalledWith("request-1", { id: "owner", email: "owner@example.com" }, uiPayload.settings, "UNCLASSIFIED");
  });
  it.each([{ alertEmail: "other@example.com" }, { userId: "other" }, { ownerId: "other" }])("rejects client recipient or owner authority %s", async field => {
    expect((await POST(request({ ...settings, ...field }), context)).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each([{ alertEmail: "other@example.com" }, { userId: "other" }, { ownerId: "other" }])("rejects authority injected outside the settings envelope %s", async field => {
    const injected = new NextRequest("http://localhost/api/courses/recovery/request-1/demand", {
      method: "POST", body: JSON.stringify({ settings, ...field }), headers: { "content-type": "application/json" },
    });
    expect((await POST(injected, context)).status).toBe(400); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("rejects reversed windows before persistence", async () => {
    expect((await POST(request({ ...settings, endTime: "08:00" }), context)).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("reads only this owner's demand and safely represents absence", async () => {
    mocks.get.mockResolvedValue(null);
    expect(await (await GET(request(), context)).json()).toEqual({ demand: null });
    expect(mocks.get).toHaveBeenCalledWith("request-1", "owner");
  });
  it("cancels only this owner's demand", async () => {
    mocks.cancel.mockResolvedValue({ status: "CANCELLED" });
    expect((await DELETE(request(), context)).status).toBe(200);
    expect(mocks.cancel).toHaveBeenCalledWith("request-1", "owner");
  });
  it("requires authentication for every action", async () => {
    mocks.user.mockRejectedValue(new Error("Unauthorized"));
    for (const action of [GET, POST, DELETE]) expect((await action(request(), context)).status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it("fails closed when account or database setup is unavailable", async () => {
    mocks.database.mockReturnValue(false);
    expect((await POST(request(), context)).status).toBe(503);
    expect(mocks.user).not.toHaveBeenCalled();
  });
  it("does not disclose unexpected database or credential-bearing errors", async () => {
    mocks.save.mockRejectedValue(new Error("postgresql://owner:secret@private.example/database"));
    const response = await POST(request(), context);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toMatch(/secret|postgresql|private/);
  });
  it("rejects cross-origin mutation before using account authority", async () => {
    const crossOrigin = new NextRequest("http://localhost/api/courses/recovery/request-1/demand", {
      method: "POST", body: JSON.stringify(settings), headers: { origin: "https://other.example" },
    });
    expect((await POST(crossOrigin, context)).status).toBe(403);
    expect((await DELETE(crossOrigin, context)).status).toBe(403);
    expect(mocks.user).not.toHaveBeenCalled();
  });
  it("rejects an oversized body without persisting demand", async () => {
    const oversized = new NextRequest("http://localhost/api/courses/recovery/request-1/demand", { method: "POST", body: "x".repeat(4097) });
    expect((await POST(oversized, context)).status).toBe(400); expect(mocks.save).not.toHaveBeenCalled();
  });
});
