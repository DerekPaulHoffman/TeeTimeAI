// @vitest-environment node
import { createECDH } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  config: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
  updateMany: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@/lib/operator/auth", () => ({ getCurrentOperator: mocks.auth }));
vi.mock("@/lib/operator-notifications/config", () => ({
  getOperatorNotificationConfig: mocks.config,
}));
vi.mock("@/lib/operator-notifications/push", async (original) => ({
  ...(await original<typeof import("@/lib/operator-notifications/push")>()),
  sendOperatorNotification: mocks.send,
}));
vi.mock("@/lib/prisma", () => {
  const db = {
    operatorPushSubscription: {
      findUnique: mocks.findUnique,
      findFirst: mocks.findFirst,
      upsert: mocks.upsert,
      deleteMany: mocks.deleteMany,
      updateMany: mocks.updateMany,
    },
  };
  return {
    prisma: {
      ...db,
      $transaction: (callback: (value: typeof db) => unknown) => callback(db),
    },
  };
});
import { GET, POST } from "./route";
import { OperatorNotificationSendError } from "@/lib/operator-notifications/push";

const key = createECDH("prime256v1");
key.generateKeys();
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/a",
  keys: {
    p256dh: key.getPublicKey().toString("base64url"),
    auth: Buffer.alloc(16, 1).toString("base64url"),
  },
};
const row = {
  id: "old-phone",
  ownerEmail: "owner@realmail.com",
  clerkUserId: "owner",
  publicKey: "public-key",
  endpoint: subscription.endpoint,
  ...subscription.keys,
};
const req = (data: unknown, origin = "https://teetimespot.com") =>
  new Request("https://teetimespot.com/api/operator/phone-notifications", {
    method: "POST",
    headers: {
      host: "teetimespot.com",
      origin,
      "content-type": "application/json",
    },
    body: JSON.stringify(data),
  });

describe("private operator phone setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      email: row.ownerEmail,
      clerkUserId: row.clerkUserId,
    });
    mocks.config.mockReturnValue({
      publicKey: row.publicKey,
      ownerEmail: row.ownerEmail,
    });
    mocks.findUnique.mockResolvedValue(row);
    mocks.findFirst.mockResolvedValue(row);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.send.mockResolvedValue({ status: "accepted" });
  });
  it.each([null, { email: "other@realmail.com", clerkUserId: "other" }])(
    "denies guests and other operators",
    async (operator) => {
      mocks.auth.mockResolvedValue(operator);
      expect((await GET()).status).toBe(404);
      expect(
        (await POST(req({ action: "test", endpoint: row.endpoint }))).status,
      ).toBe(404);
      expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.findUnique).not.toHaveBeenCalled();
    },
  );
  it("fails closed when the feature is disabled", async () => {
    mocks.config.mockReturnValue(null);
    expect((await GET()).status).toBe(404);
  });
  it("returns only a public key and device fingerprint", async () => {
    const result = await GET();
    const body = await result.json();
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(Object.keys(body).sort()).toEqual(["endpointHash", "publicKey"]);
    expect(body.endpointHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(body)).not.toContain(row.endpoint);
  });
  it("rejects cross-origin mutation before touching the subscription", async () => {
    expect(
      (
        await POST(
          req({ action: "subscribe", subscription }, "https://evil.test"),
        )
      ).status,
    ).toBe(403);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("rejects oversized streamed payloads", async () => {
    expect(
      (await POST(req({ action: "subscribe", padding: "x".repeat(6100) })))
        .status,
    ).toBe(413);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("binds subscription ownership to Clerk and preserves the same device identity", async () => {
    expect(
      (
        await POST(
          req({
            action: "subscribe",
            subscription,
            ownerEmail: "attacker@realmail.com",
          }),
        )
      ).status,
    ).toBe(200);
    expect(mocks.upsert.mock.calls[0][0]).toMatchObject({
      where: { ownerEmail: row.ownerEmail },
      create: { ownerEmail: row.ownerEmail, clerkUserId: "owner" },
    });
    expect(mocks.upsert.mock.calls[0][0].update.id).toBeUndefined();
  });
  it("replaces the identity for a different phone", async () => {
    expect(
      (
        await POST(
          req({
            action: "subscribe",
            subscription: {
              ...subscription,
              endpoint: "https://fcm.googleapis.com/fcm/send/new",
            },
          }),
        )
      ).status,
    ).toBe(200);
    expect(mocks.upsert.mock.calls[0][0].update.id).not.toBe(row.id);
    expect(mocks.upsert.mock.calls[0][0].update.id).toBeTruthy();
  });
  it("does not disable a different device", async () => {
    mocks.findFirst.mockResolvedValue(null);
    expect(
      (await POST(req({ action: "unsubscribe", endpoint: "different" })))
        .status,
    ).toBe(200);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    expect(mocks.findFirst.mock.calls[0][0].where).toMatchObject({
      ownerEmail: row.ownerEmail,
      clerkUserId: "owner",
      endpoint: "different",
    });
  });
  it("sends only an explicit test and rate limits repeated tests", async () => {
    expect(
      (await POST(req({ action: "test", endpoint: row.endpoint }))).status,
    ).toBe(200);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][1].body).toContain(
      "You can close the website",
    );
    mocks.updateMany.mockResolvedValue({ count: 0 });
    expect(
      (await POST(req({ action: "test", endpoint: row.endpoint }))).status,
    ).toBe(429);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it("identifies a missing device so the page can return to setup", async () => {
    mocks.findFirst.mockResolvedValue(null);
    const response = await POST(req({ action: "test", endpoint: row.endpoint }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "DEVICE_NOT_REGISTERED" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("removes an expired subscription without exposing provider details", async () => {
    mocks.send.mockRejectedValueOnce(
      new OperatorNotificationSendError("failed", "410"),
    );
    const response = await POST(req({ action: "test", endpoint: row.endpoint }));
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ code: "SUBSCRIPTION_EXPIRED" });
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: {
        ownerEmail: row.ownerEmail,
        clerkUserId: "owner",
        endpoint: row.endpoint,
      },
    });
  });
});
