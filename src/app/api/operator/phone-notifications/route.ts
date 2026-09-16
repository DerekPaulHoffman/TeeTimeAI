import { createHash, randomUUID } from "node:crypto";
import { getCurrentOperator } from "@/lib/operator/auth";
import { assertSameOriginOperatorMutation } from "@/lib/operator/mutation-security";
import { getOperatorNotificationConfig } from "@/lib/operator-notifications/config";
import { parseOperatorPushSubscription } from "@/lib/operator-notifications/subscription";
import {
  OperatorNotificationSendError,
  sendOperatorNotification,
} from "@/lib/operator-notifications/push";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });

async function access() {
  const operator = await getCurrentOperator();
  const config = getOperatorNotificationConfig();
  return operator && config && operator.email === config.ownerEmail
    ? { operator, config }
    : null;
}

export async function GET() {
  const allowed = await access();
  if (!allowed) return json({ error: "Not available." }, 404);
  try {
    const row = await prisma.operatorPushSubscription.findUnique({
      where: { ownerEmail: allowed.operator.email },
    });
    const active =
      row &&
      row.clerkUserId === allowed.operator.clerkUserId &&
      row.publicKey === allowed.config.publicKey;
    return json({
      publicKey: allowed.config.publicKey,
      endpointHash: active
        ? createHash("sha256").update(row.endpoint).digest("hex")
        : null,
    });
  } catch {
    return json(
      { error: "Phone notifications are temporarily unavailable." },
      503,
    );
  }
}

export async function POST(request: Request) {
  const allowed = await access();
  if (!allowed) return json({ error: "Not available." }, 404);
  try {
    assertSameOriginOperatorMutation(request.headers);
  } catch {
    return json(
      { error: "Open this page on Tee Time Spot to make changes." },
      403,
    );
  }
  let input: { action?: string; subscription?: unknown; endpoint?: string };
  try {
    // Limit streamed bodies as well as requests with Content-Length.
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "Invalid request." }, 400);
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 6000) {
        await reader.cancel();
        return json({ error: "Request too large." }, 413);
      }
      chunks.push(chunk.value);
    }
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!input || typeof input !== "object")
      return json({ error: "Invalid request." }, 400);
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  const { config, operator } = allowed;
  try {
    if (input.action === "subscribe") {
      const subscription = parseOperatorPushSubscription(input.subscription);
      if (!subscription)
        return json(
          {
            error: "Use Chrome on your Android phone to enable notifications.",
          },
          400,
        );
      await prisma.$transaction(async (tx) => {
        const old = await tx.operatorPushSubscription.findUnique({
          where: { ownerEmail: operator.email },
        });
        const unchanged =
          old &&
          old.clerkUserId === operator.clerkUserId &&
          old.endpoint === subscription.endpoint &&
          old.p256dh === subscription.p256dh &&
          old.auth === subscription.auth &&
          old.publicKey === config.publicKey;
        const data = {
          ...subscription,
          clerkUserId: operator.clerkUserId,
          publicKey: config.publicKey,
        };
        // Rotate the identity when replacing a device. Pending notifications
        // must not silently move to a new destination.
        await tx.operatorPushSubscription.upsert({
          where: { ownerEmail: operator.email },
          create: { ...data, ownerEmail: operator.email },
          update: {
            ...data,
            ...(unchanged ? {} : { id: randomUUID(), lastTestAt: null }),
          },
        });
      });
      return json({ enabled: true });
    }
    if (typeof input.endpoint !== "string" || input.endpoint.length > 2048)
      return json({ error: "Invalid device." }, 400);
    const row = await prisma.operatorPushSubscription.findFirst({
      where: {
        ownerEmail: operator.email,
        clerkUserId: operator.clerkUserId,
        endpoint: input.endpoint,
        publicKey: config.publicKey,
      },
    });
    if (input.action === "unsubscribe") {
      if (row)
        await prisma.operatorPushSubscription.deleteMany({
          where: { id: row.id },
        });
      return json({ enabled: false });
    }
    if (input.action !== "test" || !row)
      return json({ error: "Enable notifications on this device first." }, 400);
    const now = new Date();
    const claim = await prisma.operatorPushSubscription.updateMany({
      where: {
        id: row.id,
        OR: [
          { lastTestAt: null },
          { lastTestAt: { lt: new Date(now.getTime() - 30_000) } },
        ],
      },
      data: { lastTestAt: now },
    });
    if (!claim.count)
      return json(
        { error: "Wait 30 seconds before sending another test." },
        429,
      );
    await sendOperatorNotification(config, {
      id: `test-${randomUUID()}`,
      body: "Tee Time Spot: phone notifications ready\nYou can close the website. New customer alerts and their five-minute updates will appear here.",
      subscription: row,
    });
    return json({ accepted: true });
  } catch (error) {
    if (
      error instanceof OperatorNotificationSendError &&
      ["404", "410"].includes(error.code)
    ) {
      await prisma.operatorPushSubscription.deleteMany({
        where: {
          ownerEmail: operator.email,
          clerkUserId: operator.clerkUserId,
          endpoint: input.endpoint,
        },
      });
      return json(
        { error: "This subscription expired. Enable notifications again." },
        410,
      );
    }
    return json(
      { error: "Phone notifications could not be confirmed. Try again later." },
      503,
    );
  }
}
