// @vitest-environment node
import { randomUUID } from "node:crypto";
import webpush from "web-push";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { prisma } from "@/lib/prisma";
import { enqueueOperatorNotification } from "./queue";
import {
  listOperatorNotificationForRecovery,
  processOperatorNotification,
} from "./service";
import { OperatorNotificationSendError } from "./push";
const transport = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("./push", async (original) => ({
  ...(await original<typeof import("./push")>()),
  sendOperatorNotification: transport.send,
}));

const testUrl = process.env.OPERATOR_NOTIFICATIONS_TEST_DATABASE_URL;
const keys = webpush.generateVAPIDKeys();
describe.skipIf(!testUrl)(
  "operator push durable delivery (isolated Postgres)",
  () => {
    beforeAll(() => {
      const url = new URL(testUrl!);
      if (
        !["localhost", "127.0.0.1"].includes(url.hostname) ||
        url.pathname !== "/operator_notifications_test"
      )
        throw new Error(
          "Notification tests require an isolated local operator_notifications_test database",
        );
      vi.stubEnv("DATABASE_URL", testUrl!);
      for (const [key, value] of Object.entries({
        VERCEL_ENV: "production",
        OPERATOR_NOTIFICATIONS_ENABLED: "true",
        OPERATOR_PUSH_VAPID_PUBLIC_KEY: keys.publicKey,
        OPERATOR_PUSH_VAPID_PRIVATE_KEY: keys.privateKey,
        OPERATOR_NOTIFICATIONS_OWNER_EMAIL: "owner@realmail.com",
        OPERATOR_NOTIFICATIONS_EXCLUDED_EMAILS: "owner@realmail.com",
        NEXT_PUBLIC_SITE_URL: "https://teetimespot.com",
      }))
        vi.stubEnv(key, value);
    });
    beforeEach(async () => {
      await prisma.operatorPushSubscription.deleteMany({
        where: { ownerEmail: "owner@realmail.com" },
      });
      await prisma.operatorPushSubscription.create({
        data: {
          ownerEmail: "owner@realmail.com",
          clerkUserId: "notification-test-owner",
          endpoint: "https://fcm.googleapis.com/fcm/send/test",
          p256dh: keys.publicKey,
          auth: Buffer.alloc(16, 1).toString("base64url"),
          publicKey: keys.publicKey,
        },
      });
      transport.send.mockReset().mockImplementation(async () => ({
        messageId: randomUUID(),
        status: "accepted",
      }));
    });
    afterAll(async () => {
      await prisma.operatorPushSubscription.deleteMany({
        where: { ownerEmail: "owner@realmail.com" },
      });
      await prisma.operatorNotificationDelivery.deleteMany({
        where: { sourceSearchId: { startsWith: "notification-test-" } },
      });
      await prisma.user.deleteMany({
        where: { id: { startsWith: "notification-test-" } },
      });
      await prisma.course.deleteMany({
        where: { id: { startsWith: "notification-test-" } },
      });
      await prisma.$disconnect();
      vi.unstubAllEnvs();
    });
    async function fixture(
      email = "golfer@realmail.com",
      trafficClass: "PUBLIC" | "TEST" = "PUBLIC",
    ) {
      const id = `notification-test-${randomUUID()}`;
      return prisma.$transaction(async (tx) => {
        await tx.user.create({ data: { id, clerkUserId: id, email } });
        const search = await tx.teeSearch.create({
          data: {
            id,
            userId: id,
            date: new Date("2080-09-20T00:00:00Z"),
            startTime: "08:00",
            endTime: "10:00",
            players: 4,
            trafficClass,
            preferences: {
              create: {
                rank: 1,
                course: {
                  create: {
                    id,
                    name: "Test Public Course",
                    latitude: 41,
                    longitude: -73,
                  },
                },
              },
            },
          },
          include: { preferences: { include: { course: true } } },
        });
        await enqueueOperatorNotification(tx, search);
        await enqueueOperatorNotification(tx, search);
        return search;
      });
    }
    async function initial(id: string) {
      return prisma.operatorNotificationDelivery.findUniqueOrThrow({
        where: { sourceSearchId_kind: { sourceSearchId: id, kind: "CREATED" } },
      });
    }
    async function followup(id: string) {
      return prisma.operatorNotificationDelivery.findUniqueOrThrow({
        where: {
          sourceSearchId_kind: { sourceSearchId: id, kind: "FOLLOWUP" },
        },
      });
    }

    it("saves one initial delivery, sends once under concurrency, then schedules exactly five minutes later", async () => {
      const search = await fixture();
      const row = await initial(search.id);
      expect(
        await prisma.operatorNotificationDelivery.count({
          where: { sourceSearchId: search.id },
        }),
      ).toBe(1);
      await Promise.all([
        processOperatorNotification(row.id),
        processOperatorNotification(row.id),
      ]);
      expect(transport.send).toHaveBeenCalledTimes(1);
      const accepted = await initial(search.id);
      const next = await followup(search.id);
      expect(next.dueAt.getTime() - accepted.acceptedAt!.getTime()).toBe(
        300_000,
      );
      await processOperatorNotification(next.id);
      expect(transport.send).toHaveBeenCalledTimes(1);
      await prisma.operatorNotificationDelivery.update({
        where: { id: next.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await processOperatorNotification(next.id);
      expect(transport.send).toHaveBeenCalledTimes(2);
      expect(transport.send.mock.calls[1][1].body).toContain("NEEDS ATTENTION");
      await processOperatorNotification(row.id);
      await processOperatorNotification(next.id);
      expect(transport.send).toHaveBeenCalledTimes(2);
    });
    it("excludes owner and test saves before writing an outbox row", async () => {
      for (const search of [
        await fixture("OWNER+golf@realmail.com"),
        await fixture("golfer@realmail.com", "TEST"),
      ])
        expect(
          await prisma.operatorNotificationDelivery.count({
            where: { sourceSearchId: search.id },
          }),
        ).toBe(0);
    });
    it("retains a removal follow-up when the customer deletes an announced alert", async () => {
      const search = await fixture();
      await processOperatorNotification((await initial(search.id)).id);
      await prisma.teeSearch.delete({ where: { id: search.id } });
      const next = await followup(search.id);
      expect(next.teeSearchId).toBeNull();
      await prisma.operatorNotificationDelivery.update({
        where: { id: next.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await processOperatorNotification(next.id);
      expect(transport.send.mock.calls[1][1].body).toContain("Alert removed");
    });
    it("does not resend an ambiguous timeout or falsely schedule an accepted follow-up", async () => {
      const search = await fixture();
      const row = await initial(search.id);
      transport.send.mockRejectedValueOnce(
        new OperatorNotificationSendError("uncertain", "transport"),
      );
      await processOperatorNotification(row.id);
      await processOperatorNotification(row.id);
      expect(transport.send).toHaveBeenCalledTimes(1);
      const uncertain = await initial(search.id);
      expect(uncertain.status).toBe("UNCERTAIN");
      expect(uncertain.providerMessageId).toBeNull();
      expect(
        await prisma.operatorNotificationDelivery.count({
          where: { sourceSearchId: search.id },
        }),
      ).toBe(1);
    });
    it("retries definite rate limits but leaves permanent rejections failed", async () => {
      const search = await fixture();
      const row = await initial(search.id);
      transport.send.mockRejectedValueOnce(
        new OperatorNotificationSendError("retry", "429", 600),
      );
      const attemptStartedAt = Date.now();
      expect(await processOperatorNotification(row.id)).toMatchObject({
        id: row.id,
      });
      expect((await initial(search.id)).status).toBe("PENDING");
      expect(
        (await initial(search.id)).nextAttemptAt.getTime(),
      ).toBeGreaterThanOrEqual(attemptStartedAt + 600_000);
      await prisma.operatorNotificationDelivery.update({
        where: { id: row.id },
        data: { nextAttemptAt: new Date(0) },
      });
      transport.send.mockRejectedValueOnce(
        new OperatorNotificationSendError("failed", "403"),
      );
      await processOperatorNotification(row.id);
      expect((await initial(search.id)).status).toBe("FAILED");
    });
    it("sends a healthy five-minute update using the customer's latest alert details", async () => {
      const search = await fixture();
      await processOperatorNotification((await initial(search.id)).id);
      const observedAt = new Date();
      await prisma.teeSearch.update({
        where: { id: search.id },
        data: {
          players: 2,
          checkStatus: "WAITING",
          lastCheckedAt: observedAt,
          nextCheckAt: new Date(observedAt.getTime() + 900_000),
        },
      });
      await prisma.courseProbe.create({
        data: {
          teeSearchId: search.id,
          courseId: search.preferences[0].courseId,
          outcome: "NO_MATCH",
          observedAt,
          rawSummary: {
            providerExecution: "RUNNABLE_PROVIDER_CHECK",
            providerObservedAt: observedAt.toISOString(),
          },
        },
      });
      const next = await followup(search.id);
      await prisma.operatorNotificationDelivery.update({
        where: { id: next.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await processOperatorNotification(next.id);
      expect(transport.send.mock.calls[1][1].body).toContain(
        "No action needed",
      );
      expect(transport.send.mock.calls[1][1].body).toContain("2 players");
    });
    it("recovers due deliveries while fencing abandoned sends as uncertain", async () => {
      const search = await fixture();
      const row = await initial(search.id);
      expect(
        (await listOperatorNotificationForRecovery()).map((r) => r.id),
      ).toContain(row.id);
      await prisma.operatorNotificationDelivery.update({
        where: { id: row.id },
        data: {
          status: "SENDING",
          claimToken: "old",
          claimExpiresAt: new Date(0),
        },
      });
      await listOperatorNotificationForRecovery();
      expect((await initial(search.id)).status).toBe("UNCERTAIN");
      await processOperatorNotification(row.id);
      expect(transport.send).not.toHaveBeenCalled();
    });
    it("suppresses queued data when the configured owner changes", async () => {
      const search = await fixture();
      const row = await initial(search.id);
      vi.stubEnv(
        "OPERATOR_NOTIFICATIONS_OWNER_EMAIL",
        "different@realmail.com",
      );
      try {
        await processOperatorNotification(row.id);
        expect((await initial(search.id)).status).toBe("SUPPRESSED");
        expect(transport.send).not.toHaveBeenCalled();
      } finally {
        vi.stubEnv("OPERATOR_NOTIFICATIONS_OWNER_EMAIL", "owner@realmail.com");
      }
    });
    it("drops an expired phone subscription after a definite push rejection", async () => {
      const search = await fixture();
      transport.send.mockRejectedValueOnce(
        new OperatorNotificationSendError("failed", "410"),
      );
      await processOperatorNotification((await initial(search.id)).id);
      expect(await prisma.operatorPushSubscription.count()).toBe(0);
      expect((await initial(search.id)).status).toBe("FAILED");
    });
    it("does not redirect a queued notification when another phone is enabled", async () => {
      const search = await fixture();
      await prisma.operatorPushSubscription.update({
        where: { ownerEmail: "owner@realmail.com" },
        data: {
          id: randomUUID(),
          endpoint: "https://fcm.googleapis.com/fcm/send/new-phone",
        },
      });
      await processOperatorNotification((await initial(search.id)).id);
      expect((await initial(search.id)).status).toBe("SUPPRESSED");
      expect(transport.send).not.toHaveBeenCalled();
    });
    it("does not enqueue alerts before a phone opts in", async () => {
      await prisma.operatorPushSubscription.deleteMany({
        where: { ownerEmail: "owner@realmail.com" },
      });
      const search = await fixture();
      expect(
        await prisma.operatorNotificationDelivery.count({
          where: { sourceSearchId: search.id },
        }),
      ).toBe(0);
    });
    it("does not announce a deleted alert before its initial notification", async () => {
      const search = await fixture();
      const row = await initial(search.id);
      await prisma.teeSearch.delete({ where: { id: search.id } });
      await processOperatorNotification(row.id);
      expect((await initial(search.id)).status).toBe("SUPPRESSED");
      expect(transport.send).not.toHaveBeenCalled();
    });
  },
);
