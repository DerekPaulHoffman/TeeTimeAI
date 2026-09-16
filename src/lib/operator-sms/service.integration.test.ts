// @vitest-environment node
import { randomUUID } from "node:crypto";
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
import { enqueueOperatorSms } from "./queue";
import {
  listOperatorSmsForRecovery,
  processOperatorSms,
  recordOperatorSmsCallback,
} from "./service";
import { SmsSendError } from "./twilio";
const transport = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("./twilio", async (original) => ({
  ...(await original<typeof import("./twilio")>()),
  sendOperatorSms: transport.send,
}));

const testUrl = process.env.OPERATOR_SMS_TEST_DATABASE_URL;
describe.skipIf(!testUrl)(
  "operator SMS durable delivery (isolated Postgres)",
  () => {
    beforeAll(() => {
      const url = new URL(testUrl!);
      if (
        !["localhost", "127.0.0.1"].includes(url.hostname) ||
        url.pathname !== "/operator_sms_test"
      )
        throw new Error(
          "SMS integration tests require an isolated local operator_sms_test database",
        );
      vi.stubEnv("DATABASE_URL", testUrl!);
      for (const [key, value] of Object.entries({
        VERCEL_ENV: "production",
        OPERATOR_SMS_ENABLED: "true",
        TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
        TWILIO_AUTH_TOKEN: "fake-test-token",
        TWILIO_SMS_FROM: "+12025550100",
        OPERATOR_SMS_TO: "+12025550101",
        OPERATOR_SMS_EXCLUDED_EMAILS: "owner@realmail.com",
        NEXT_PUBLIC_SITE_URL: "https://teetimespot.com",
      }))
        vi.stubEnv(key, value);
    });
    beforeEach(() => {
      transport.send.mockReset().mockImplementation(async () => ({
        sid: `SM${randomUUID().replaceAll("-", "")}`,
        status: "queued",
      }));
    });
    afterAll(async () => {
      await prisma.operatorSmsDelivery.deleteMany({
        where: { sourceSearchId: { startsWith: "sms-test-" } },
      });
      await prisma.user.deleteMany({
        where: { id: { startsWith: "sms-test-" } },
      });
      await prisma.course.deleteMany({
        where: { id: { startsWith: "sms-test-" } },
      });
      await prisma.$disconnect();
      vi.unstubAllEnvs();
    });
    async function fixture(
      email = "golfer@realmail.com",
      trafficClass: "PUBLIC" | "TEST" = "PUBLIC",
    ) {
      const id = `sms-test-${randomUUID()}`;
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
        await enqueueOperatorSms(tx, search);
        await enqueueOperatorSms(tx, search);
        return search;
      });
    }
    async function initial(id: string) {
      return prisma.operatorSmsDelivery.findUniqueOrThrow({
        where: { sourceSearchId_kind: { sourceSearchId: id, kind: "CREATED" } },
      });
    }
    async function followup(id: string) {
      return prisma.operatorSmsDelivery.findUniqueOrThrow({
        where: {
          sourceSearchId_kind: { sourceSearchId: id, kind: "FOLLOWUP" },
        },
      });
    }

    it("saves one initial delivery, sends once under concurrency, then schedules exactly five minutes later", async () => {
      const search = await fixture();
      const row = await initial(search.id);
      expect(
        await prisma.operatorSmsDelivery.count({
          where: { sourceSearchId: search.id },
        }),
      ).toBe(1);
      await Promise.all([
        processOperatorSms(row.id),
        processOperatorSms(row.id),
      ]);
      expect(transport.send).toHaveBeenCalledTimes(1);
      const accepted = await initial(search.id);
      const next = await followup(search.id);
      expect(next.dueAt.getTime() - accepted.acceptedAt!.getTime()).toBe(
        300_000,
      );
      await processOperatorSms(next.id);
      expect(transport.send).toHaveBeenCalledTimes(1);
      await prisma.operatorSmsDelivery.update({
        where: { id: next.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await processOperatorSms(next.id);
      expect(transport.send).toHaveBeenCalledTimes(2);
      expect(transport.send.mock.calls[1][1].body).toContain("NEEDS ATTENTION");
      await processOperatorSms(row.id);
      await processOperatorSms(next.id);
      expect(transport.send).toHaveBeenCalledTimes(2);
    });
    it("excludes owner and test saves before writing an outbox row", async () => {
      for (const search of [
        await fixture("OWNER+golf@realmail.com"),
        await fixture("golfer@realmail.com", "TEST"),
      ])
        expect(
          await prisma.operatorSmsDelivery.count({
            where: { sourceSearchId: search.id },
          }),
        ).toBe(0);
    });
    it("retains a removal follow-up when the customer deletes an announced alert", async () => {
      const search = await fixture();
      await processOperatorSms((await initial(search.id)).id);
      await prisma.teeSearch.delete({ where: { id: search.id } });
      const next = await followup(search.id);
      expect(next.teeSearchId).toBeNull();
      await prisma.operatorSmsDelivery.update({
        where: { id: next.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await processOperatorSms(next.id);
      expect(transport.send.mock.calls[1][1].body).toContain("Alert removed");
    });
    it("does not resend an ambiguous timeout, but reconciles the signed callback once", async () => {
      const search = await fixture();
      const row = await initial(search.id);
      transport.send.mockRejectedValueOnce(
        new SmsSendError("uncertain", "transport"),
      );
      await processOperatorSms(row.id);
      await processOperatorSms(row.id);
      expect(transport.send).toHaveBeenCalledTimes(1);
      const uncertain = await initial(search.id);
      expect(uncertain.status).toBe("UNCERTAIN");
      const callback = {
        id: row.id,
        token: uncertain.claimToken!,
        sid: `SM${randomUUID().replaceAll("-", "")}`,
        status: "delivered",
      };
      await recordOperatorSmsCallback(callback);
      const next = await followup(search.id);
      await recordOperatorSmsCallback(callback);
      await recordOperatorSmsCallback({ ...callback, status: "queued" });
      expect((await initial(search.id)).providerStatus).toBe("delivered");
      expect((await followup(search.id)).dueAt).toEqual(next.dueAt);
      expect(
        await prisma.operatorSmsDelivery.count({
          where: { sourceSearchId: search.id },
        }),
      ).toBe(2);
    });
    it("retries definite rate limits but leaves permanent rejections failed", async () => {
      const search = await fixture();
      const row = await initial(search.id);
      transport.send.mockRejectedValueOnce(new SmsSendError("retry", "20429"));
      expect(await processOperatorSms(row.id)).toMatchObject({ id: row.id });
      expect((await initial(search.id)).status).toBe("PENDING");
      await prisma.operatorSmsDelivery.update({
        where: { id: row.id },
        data: { nextAttemptAt: new Date(0) },
      });
      transport.send.mockRejectedValueOnce(new SmsSendError("failed", "21610"));
      await processOperatorSms(row.id);
      expect((await initial(search.id)).status).toBe("FAILED");
    });
    it("sends a healthy five-minute update using the customer's latest alert details", async () => {
      const search = await fixture();
      await processOperatorSms((await initial(search.id)).id);
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
      await prisma.operatorSmsDelivery.update({
        where: { id: next.id },
        data: { nextAttemptAt: new Date(0) },
      });
      await processOperatorSms(next.id);
      expect(transport.send.mock.calls[1][1].body).toContain(
        "No action needed",
      );
      expect(transport.send.mock.calls[1][1].body).toContain("2 players");
    });
    it("recovers due deliveries while fencing abandoned sends as uncertain", async () => {
      const search = await fixture();
      const row = await initial(search.id);
      expect((await listOperatorSmsForRecovery()).map((r) => r.id)).toContain(
        row.id,
      );
      await prisma.operatorSmsDelivery.update({
        where: { id: row.id },
        data: {
          status: "SENDING",
          claimToken: "old",
          claimExpiresAt: new Date(0),
        },
      });
      await listOperatorSmsForRecovery();
      expect((await initial(search.id)).status).toBe("UNCERTAIN");
      await processOperatorSms(row.id);
      expect(transport.send).not.toHaveBeenCalled();
    });
  },
);
