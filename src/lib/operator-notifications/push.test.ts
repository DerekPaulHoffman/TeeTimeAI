// @vitest-environment node
import { createECDH, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const send = vi.hoisted(() => vi.fn());
vi.mock("web-push", () => ({ default: { sendNotification: send } }));
import { parseOperatorPushSubscription } from "./subscription";
import { sendOperatorNotification } from "./push";

const key = createECDH("prime256v1");
key.generateKeys();
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/device-token:abc",
  p256dh: key.getPublicKey().toString("base64url"),
  auth: randomBytes(16).toString("base64url"),
};
const browserSubscription = {
  endpoint: subscription.endpoint,
  keys: { p256dh: subscription.p256dh, auth: subscription.auth },
};
const config = {
  publicKey: "public",
  privateKey: "private",
  ownerEmail: "owner@realmail.com",
  origin: "https://teetimespot.com",
  excludedEmails: [],
};
describe("encrypted phone push", () => {
  beforeEach(() =>
    send.mockReset().mockResolvedValue({ statusCode: 201, headers: {} }),
  );
  it("accepts a valid Chrome subscription", () =>
    expect(parseOperatorPushSubscription(browserSubscription)).toEqual(
      subscription,
    ));
  it.each([
    "http://fcm.googleapis.com/fcm/send/a",
    "https://localhost/fcm/send/a",
    "https://127.0.0.1/fcm/send/a",
    "https://fcm.googleapis.com.evil.test/fcm/send/a",
    "https://user@fcm.googleapis.com/fcm/send/a",
    "https://fcm.googleapis.com:444/fcm/send/a",
    "https://fcm.googleapis.com/other/a",
    "https://fcm.googleapis.com/fcm/send/a?redirect=localhost",
  ])(
    "rejects untrusted endpoints before contacting them: %s",
    async (endpoint) => {
      expect(
        parseOperatorPushSubscription({ ...browserSubscription, endpoint }),
      ).toBeNull();
      await expect(
        sendOperatorNotification(config, {
          id: "one",
          body: "Hello",
          subscription: { ...subscription, endpoint },
        }),
      ).rejects.toMatchObject({ code: "invalid_subscription" });
      expect(send).not.toHaveBeenCalled();
    },
  );
  it("rejects invalid elliptic-curve keys", () =>
    expect(
      parseOperatorPushSubscription({
        ...browserSubscription,
        keys: {
          ...browserSubscription.keys,
          p256dh: Buffer.alloc(65, 4).toString("base64url"),
        },
      }),
    ).toBeNull());
  it("uses encrypted web push, a bounded lifetime and stable topic", async () => {
    const input = {
      id: "delivery-one",
      body: "Tee Time Spot: new customer alert\ngolfer@realmail.com\nhttps://teetimespot.com/operator",
      subscription,
    };
    expect(await sendOperatorNotification(config, input)).toEqual({
      messageId: "delivery-one",
      status: "accepted",
    });
    const [destination, payload, options] = send.mock.calls[0];
    expect(destination).toEqual(browserSubscription);
    expect(JSON.parse(payload)).toEqual({
      title: "Tee Time Spot: new customer alert",
      body: "golfer@realmail.com",
      url: "/operator",
      tag: "delivery-one",
    });
    expect(options).toMatchObject({
      TTL: 3600,
      urgency: "high",
      timeout: 15000,
      vapidDetails: {
        subject: "https://teetimespot.com",
        publicKey: "public",
        privateKey: "private",
      },
    });
    expect(options.topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
  it.each([404, 410, 403])(
    "treats definite rejection %s as failed",
    async (statusCode) => {
      send.mockRejectedValueOnce({ statusCode });
      await expect(
        sendOperatorNotification(config, {
          id: "one",
          body: "Hello",
          subscription,
        }),
      ).rejects.toMatchObject({ outcome: "failed", code: String(statusCode) });
    },
  );
  it("honors rate-limit retry delay", async () => {
    send.mockRejectedValueOnce({
      statusCode: 429,
      headers: { "retry-after": "600" },
    });
    await expect(
      sendOperatorNotification(config, {
        id: "one",
        body: "Hello",
        subscription,
      }),
    ).rejects.toMatchObject({ outcome: "retry", retryAfterSeconds: 600 });
  });
  it.each([{}, { statusCode: 503 }])(
    "does not assume that an ambiguous failure means undelivered",
    async (failure) => {
      send.mockRejectedValueOnce(failure);
      await expect(
        sendOperatorNotification(config, {
          id: "one",
          body: "Hello",
          subscription,
        }),
      ).rejects.toMatchObject({ outcome: "uncertain" });
    },
  );
});
