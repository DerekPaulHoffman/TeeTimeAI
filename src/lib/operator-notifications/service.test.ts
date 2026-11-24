// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  probe: vi.fn(),
  send: vi.fn(),
  delivery: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  subscription: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  teeSearch: { findUnique: mocks.search },
  operatorNotificationDelivery: { findUnique: mocks.delivery, updateMany: mocks.update },
  operatorPushSubscription: { findUnique: mocks.subscription },
  $transaction: async (callback: (tx: unknown) => unknown) => callback({
    teeSearch: { findUnique: mocks.search }, courseProbe: { findFirst: mocks.probe },
    operatorNotificationDelivery: {
      updateMany: mocks.update,
      findUniqueOrThrow: mocks.delivery,
      createMany: mocks.create,
    },
  }),
} }));
vi.mock("./push", async (importOriginal) => ({
  ...await importOriginal<typeof import("./push")>(),
  sendOperatorNotification: mocks.send,
}));

import { getOperatorNotificationDeliveryConfig } from "./config";
import { enqueueOperatorNotification } from "./queue";
import { loadOperatorNotificationSearch, processOperatorNotification } from "./service";

describe("operator notification search evidence", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("reads only the selected simulator offering on the same search", async () => {
    const offering = { id: "simulator-offering", kind: "SIMULATOR" };
    mocks.search.mockResolvedValue({ id: "search-1", mode: "SIMULATOR", alertGeneration: 2,
      preferences: [{ courseId: "hybrid", offeringId: offering.id, offering }], emailDeliveries: [],
    });
    const correctProbe = { teeSearchId: "search-1", courseId: "hybrid", offeringId: offering.id, outcome: "NO_MATCH" };
    mocks.probe.mockImplementation(async (query) => query.where.teeSearchId === "search-1" && query.where.offeringId === offering.id
      ? correctProbe : { ...correctProbe, offeringId: "outdoor-offering", outcome: "FETCH_FAILED" });
    const result = await loadOperatorNotificationSearch("search-1");
    expect(result?.probes).toEqual([correctProbe]);
    expect(mocks.search.mock.calls[0][0].include.preferences.include.offering).toBe(true);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("preserves outdoor probe reads after legacy offering backfill", async () => {
    mocks.search.mockResolvedValue({ id: "search-1", mode: "OUTDOOR", alertGeneration: 0,
      preferences: [{ courseId: "course-1", offeringId: "outdoor-offering" }], emailDeliveries: [],
    });
    mocks.probe.mockResolvedValue({ courseId: "course-1", offeringId: "outdoor-offering", outcome: "NO_MATCH" });
    expect((await loadOperatorNotificationSearch("search-1"))?.probes).toHaveLength(1);
    expect(mocks.probe.mock.calls[0][0].where).toEqual({ teeSearchId: "search-1", courseId: "course-1" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe("ntfy alert delivery", () => {
  const topic = "a".repeat(48);
  let recipient: string;
  let delivery: Record<string, unknown>;
  const publish = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("OPERATOR_NTFY_TOPIC", topic);
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("OPERATOR_NOTIFICATIONS_ENABLED", "true");
    vi.stubEnv("OPERATOR_NOTIFICATIONS_OWNER_EMAIL", "owner@realmail.com");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://teetimespot.com");
    vi.stubGlobal("fetch", publish);
    const config = getOperatorNotificationDeliveryConfig();
    if (!config || !("topic" in config)) throw new Error("Expected ntfy configuration");
    recipient = config.recipient;
    delivery = {
      id: "delivery-1",
      sourceSearchId: "search-1",
      teeSearchId: "search-1",
      status: "PENDING",
      kind: "CREATED",
      recipient,
      summary: "customer@realmail.com",
      body: "customer@realmail.com",
      nextAttemptAt: new Date(0),
      attemptCount: 0,
    };
    mocks.delivery.mockResolvedValue(delivery);
    mocks.update.mockResolvedValue({ count: 1 });
    mocks.search.mockResolvedValue({ user: { email: "customer@realmail.com" }, trafficClass: "PUBLIC" });
    publish.mockResolvedValue(Response.json({ event: "message", id: "ntfy-receipt" }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("enqueues only eligible alerts and stores no customer details for ntfy", async () => {
    const user = vi.fn()
      .mockResolvedValueOnce({ email: "owner+testing@realmail.com" })
      .mockResolvedValue({ email: "customer@realmail.com" });
    const transaction = {
      user: { findUniqueOrThrow: user },
      operatorPushSubscription: { findUnique: mocks.subscription },
      operatorNotificationDelivery: { createMany: mocks.create },
    } as unknown as Parameters<typeof enqueueOperatorNotification>[0];
    const search = {
      id: "search-1",
      userId: "user-1",
      trafficClass: "PUBLIC",
      syntheticMultiCycle: false,
      createdAt: new Date(),
      date: new Date(),
      startTime: "09:00",
      endTime: "12:00",
      players: 2,
      preferences: [{ rank: 1, course: { name: "Private request details" } }],
    };
    await enqueueOperatorNotification(transaction, search);
    await enqueueOperatorNotification(transaction, { ...search, trafficClass: "TEST" });
    await enqueueOperatorNotification(transaction, search);
    expect(mocks.subscription).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      data: [{
        sourceSearchId: search.id,
        teeSearchId: search.id,
        kind: "CREATED",
        recipient,
        summary: "New Tee Time Spot alert",
        dueAt: search.createdAt,
        nextAttemptAt: search.createdAt,
      }],
      skipDuplicates: true,
    });
  });

  it("accepts a single generic push with no Chrome subscription or follow-up", async () => {
    await expect(processOperatorNotification("delivery-1")).resolves.toBeNull();
    expect(publish).toHaveBeenCalledOnce();
    const [url, request] = publish.mock.calls[0];
    expect(url).toBe("https://ntfy.sh/");
    expect(JSON.parse(request.body)).toEqual({
      topic,
      message: "New Tee Time Spot alert",
      click: "https://teetimespot.com/operator",
    });
    expect(mocks.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "ACCEPTED", providerMessageId: "ntfy:ntfy-receipt" }),
    }));
    expect(mocks.subscription).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([
    { recipient: "old-topic-or-chrome-device" },
    { kind: "FOLLOWUP" },
    { teeSearchId: null },
  ])("suppresses an obsolete delivery %o", async (override) => {
    mocks.delivery.mockResolvedValue({ ...delivery, ...override });
    await expect(processOperatorNotification("delivery-1")).resolves.toBeNull();
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: "SUPPRESSED" },
    }));
    expect(publish).not.toHaveBeenCalled();
  });

  it("skips a delivery claimed by another worker", async () => {
    mocks.update.mockResolvedValue({ count: 0 });
    await expect(processOperatorNotification("delivery-1")).resolves.toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });

  it("leaves a rate-limited delivery pending for retry", async () => {
    publish.mockResolvedValue(new Response(null, { status: 429, headers: { "Retry-After": "120" } }));
    await expect(processOperatorNotification("delivery-1")).resolves.toMatchObject({ id: "delivery-1" });
    expect(mocks.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "PENDING", lastError: "ntfy_429" }),
    }));
  });

  it("records an ambiguous provider response without scheduling a resend", async () => {
    publish.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(processOperatorNotification("delivery-1")).resolves.toBeNull();
    expect(mocks.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "UNCERTAIN", lastError: "ntfy_transport" }),
    }));
  });
});
