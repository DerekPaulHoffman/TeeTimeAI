import { createHash } from "node:crypto";
import webpush from "web-push";
import type { OperatorNotificationConfig } from "./config";
import {
  parseOperatorPushSubscription,
  type OperatorPushDetails,
} from "./subscription";

export class OperatorNotificationSendError extends Error {
  constructor(
    public outcome: "retry" | "failed" | "uncertain",
    public code: string,
    public retryAfterSeconds?: number,
  ) {
    super("Phone notification could not be confirmed.");
  }
}

export async function sendOperatorNotification(
  config: OperatorNotificationConfig,
  input: {
    id: string;
    body: string;
    subscription: OperatorPushDetails;
  },
) {
  const subscription = {
    endpoint: input.subscription.endpoint,
    keys: { p256dh: input.subscription.p256dh, auth: input.subscription.auth },
  };
  if (!parseOperatorPushSubscription(subscription))
    throw new OperatorNotificationSendError("failed", "invalid_subscription");
  const [title, ...lines] = input.body.split("\n");
  const payload = JSON.stringify({
    title,
    body: lines
      .filter((line) => line !== `${config.origin}/operator`)
      .join("\n"),
    url: "/operator",
    tag: input.id,
  });
  if (Buffer.byteLength(payload) > 3500)
    throw new OperatorNotificationSendError("failed", "payload_too_large");
  try {
    const result = await webpush.sendNotification(subscription, payload, {
      vapidDetails: {
        subject: config.origin,
        publicKey: config.publicKey,
        privateKey: config.privateKey,
      },
      TTL: 3600,
      urgency: "high",
      timeout: 15_000,
      topic: createHash("sha256")
        .update(input.id)
        .digest("base64url")
        .slice(0, 32),
    });
    if (result.statusCode < 200 || result.statusCode >= 300)
      throw { statusCode: result.statusCode, headers: result.headers };
    // Acceptance by the push service is not proof of display on the phone.
    return { messageId: input.id, status: "accepted" };
  } catch (error) {
    const status = (error as { statusCode?: unknown })?.statusCode;
    if (status === 429) {
      const header = (error as { headers?: Record<string, unknown> }).headers?.[
        "retry-after"
      ];
      const seconds =
        typeof header === "string" && /^\d+$/.test(header)
          ? Number(header)
          : undefined;
      throw new OperatorNotificationSendError(
        "retry",
        "429",
        seconds && Number.isSafeInteger(seconds)
          ? Math.min(seconds, 86400)
          : undefined,
      );
    }
    if (typeof status === "number" && status >= 400 && status < 500)
      throw new OperatorNotificationSendError("failed", String(status));
    // Timeout/5xx can occur after acceptance. Avoid duplicate notifications.
    throw new OperatorNotificationSendError("uncertain", "transport");
  }
}
