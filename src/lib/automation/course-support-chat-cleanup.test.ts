// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { inspectCourseChatCleanup } from "../../../scripts/automation/course-support-chat-cleanup.mjs";

const threadId = "01a1894d-933d-7192-911a-093e0cb1a741";
const turnId = "01a1894d-933d-7192-911a-093e0cb1a742";
const now = new Date("2026-10-29T22:00:00Z");
const completedAt = Math.floor(now.getTime() / 1000) - 3600;
function fixture() {
  const receipt = { threadId, turnId, cwd: process.cwd(), completedAt: new Date(completedAt * 1000).toISOString() };
  const thread = { id: threadId, cwd: receipt.cwd, status: { type: "notLoaded" } };
  const turn = { id: turnId, status: "completed", error: null, itemsView: "notLoaded", items: [], completedAt };
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "thread/list") return { data: params.ancestorThreadId ? [] : [thread], nextCursor: null };
    if (method === "thread/read") return { thread };
    if (method === "thread/turns/list") return { data: [turn], nextCursor: null };
    throw new Error("Unexpected mutation or item-history read");
  });
  return { receipt, thread, turn, request, run: (protectedThreadIds: string[] = [], limit = 10) =>
    inspectCourseChatCleanup({ client: { request }, candidates: [receipt], protectedThreadIds, now, limit }) };
}

describe("generated course chat cleanup", () => {
  it("uses native metadata and omitted-item turn history to select an old completed worker", async () => {
    const { run, request } = fixture();
    expect(await run()).toMatchObject({ inspected: 1, retained: 0, eligible: [{ threadId, turnId, completedAt }] });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/list", "thread/read", "thread/turns/list", "thread/list"]);
    expect(request).toHaveBeenCalledWith("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
  });

  it("does not inspect pinned/current chats or workers younger than thirty minutes", async () => {
    const { run, request, receipt } = fixture();
    expect((await run([threadId])).eligible).toEqual([]);
    receipt.completedAt = now.toISOString();
    expect((await run()).eligible).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["active", "error", "pending", "followup", "failed", "recent", "missingTime", "loadedItems", "wrongCheckout", "archived", "descendants", "unavailable"])("retains a worker with %s evidence", async failure => {
    const { run, request, thread, turn } = fixture();
    if (failure === "active") thread.status.type = "active";
    if (failure === "pending") Object.assign(thread, { pendingApproval: true });
    if (failure === "error") Object.assign(thread, { error: { message: "retained" } });
    if (failure === "followup") turn.id = "01a1894d-933d-7192-911a-093e0cb1a743";
    if (failure === "failed") turn.status = "failed";
    if (failure === "recent") turn.completedAt = Math.floor(now.getTime() / 1000);
    if (failure === "missingTime") turn.completedAt = null as unknown as number;
    if (failure === "loadedItems") turn.itemsView = "full";
    if (failure === "wrongCheckout") thread.cwd = process.cwd() + "/another";
    if (failure === "archived") request.mockResolvedValue({ data: [], nextCursor: null });
    if (failure === "descendants") {
      const original = request.getMockImplementation()!;
      request.mockImplementation(async (method, params) => params.ancestorThreadId ? { data: [thread], nextCursor: null } : original(method, params));
    }
    if (failure === "unavailable") request.mockRejectedValue(new Error("thread/items/list is not supported yet"));
    if (failure === "unavailable") await expect(run()).rejects.toThrow();
    else expect((await run()).eligible).toEqual([]);
    expect(request.mock.calls.every(([method]) => ["thread/list", "thread/read", "thread/turns/list"].includes(method))).toBe(true);
  });

  it("requires an explicit complete protected-chat inventory", async () => {
    const { run } = fixture();
    await expect(run(["not-a-thread"])).rejects.toThrow("INVALID_CLEANUP_SCOPE");
  });

  it("does not let old archived receipts consume the active inspection budget", async () => {
    const { receipt, request } = fixture();
    const archived = Array.from({ length: 15 }, (_, index) => ({ ...receipt, threadId: `01a1894d-933d-7192-911a-${String(index).padStart(12, "0")}` }));
    const result = await inspectCourseChatCleanup({ client: { request }, candidates: [...archived, receipt], protectedThreadIds: [], now, limit: 1 });
    expect(result).toMatchObject({ inspected: 1, eligible: [{ threadId }] });
  });
});
