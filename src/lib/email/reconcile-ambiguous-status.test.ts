import { beforeEach, describe, expect, it, vi } from "vitest";

import { reconcileAmbiguousSetupEmail } from "./reconcile-ambiguous-status";

const mocks = vi.hoisted(() => ({
  findDelivery: vi.fn(),
  transaction: vi.fn(),
  updateDelivery: vi.fn(),
  findSearch: vi.fn(),
  countDeliveries: vi.fn(),
  findMonitoring: vi.fn(),
  send: vi.fn(),
  enabled: vi.fn(),
  parse: vi.fn(),
  safe: vi.fn(),
  hydrate: vi.fn(),
  finalize: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    searchEmailDelivery: {
      findUnique: mocks.findDelivery,
      updateMany: mocks.updateDelivery,
    },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/email/alerts", () => ({ sendSearchStatusEmail: mocks.send }));
vi.mock("@/lib/email/delivery-policy", () => ({ isSearchEmailDeliveryEnabled: mocks.enabled }));
vi.mock("@/lib/email/search-delivery-outbox", () => ({
  assertSafeSearchEmailPayload: mocks.safe,
  hydrateSearchStatusEmailPayload: mocks.hydrate,
  finalizeSearchEmailDeliveryGroup: mocks.finalize,
}));
vi.mock("@/lib/email/search-delivery-payload", () => ({
  parseSearchEmailPayload: mocks.parse,
  normalizeSearchEmailRecipient: (email: string) => email.trim().toLowerCase(),
  getStableSearchEmailDeliveryIdempotencyKey: () => "original-request-key",
}));

const now = new Date("2026-09-28T16:30:00.000Z");
const delivery = {
  id: "delivery-1",
  teeSearchId: "search-1",
  alertGeneration: 8,
  kind: "SETUP",
  groupKey: "setup-original",
  recipient: "golfer@example.com",
  isOwnerRecipient: true,
  payload: { stored: true },
  status: "SUPPRESSED",
  attemptCount: 1,
  sentAt: null,
  lastError: "STATUS_CONTENT_STALE_REPLACED_AMBIGUOUS",
  createdAt: new Date("2026-09-28T15:58:00.000Z"),
  updatedAt: new Date("2026-09-28T16:00:00.000Z"),
};
const report = {
  kind: "setup",
  targetDate: "2026-10-03",
  courses: [
    { courseId: "course-1", outcome: "NO_MATCH" },
    { courseId: "course-2", outcome: "NO_MATCH" },
  ],
};
const search = {
  id: "search-1",
  status: "ACTIVE",
  syntheticMultiCycle: false,
  checkStatus: "WAITING",
  alertGeneration: 8,
  alertEmail: null,
  user: { email: "Golfer@example.com", pendingEmail: null },
  lastCheckedAt: new Date("2026-09-28T16:25:00.000Z"),
  lastCheckOutcome: JSON.stringify({ availableMatches: 0, failedCourses: [] }),
  preferences: [{ courseId: "course-1" }, { courseId: "course-2" }],
};

describe("operator reconciliation of an ambiguous setup email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled.mockReturnValue(true);
    mocks.findDelivery.mockResolvedValue({ ...delivery });
    mocks.parse.mockReturnValue({ checkedAt: "2026-09-28T15:58:00.000Z", matchIds: [] });
    mocks.hydrate.mockResolvedValue(report);
    mocks.findSearch.mockResolvedValue({ ...search });
    mocks.countDeliveries.mockResolvedValue(0);
    mocks.findMonitoring.mockResolvedValue(
      ["course-1", "course-2"].map((courseId) => ({
        courseId,
        state: "HEALTHY",
        lastSuccessfulAt: new Date("2026-09-28T16:25:00.000Z"),
        lastFailureAt: null,
      })),
    );
    mocks.transaction.mockImplementation(async (worker) =>
      worker({
        $queryRaw: vi.fn().mockResolvedValue([{ id: "search-1" }]),
        teeSearch: { findUnique: mocks.findSearch },
        searchEmailDelivery: {
          findUnique: mocks.findDelivery,
          count: mocks.countDeliveries,
        },
        courseMonitoringStatus: { findMany: mocks.findMonitoring },
      }),
    );
    mocks.send.mockResolvedValue({ deliveryStatus: "sent", id: "provider-1" });
    mocks.updateDelivery.mockResolvedValue({ count: 1 });
    mocks.finalize.mockResolvedValue({ finalized: true, ownerSent: true });
  });

  it("retries the immutable owner request with its original idempotency key and records acceptance", async () => {
    await expect(reconcileAmbiguousSetupEmail(delivery.id, now)).resolves.toEqual({
      outcome: "accepted",
      recorded: true,
    });
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        searchId: delivery.teeSearchId,
        to: delivery.recipient,
        stableIdempotencyKey: "original-request-key",
      }),
    );
    expect(mocks.updateDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: delivery.id,
          status: "SUPPRESSED",
          lastError: delivery.lastError,
          attemptCount: 1,
        }),
        data: expect.objectContaining({ status: "SENT", lastError: null }),
      }),
    );
    expect(mocks.finalize).toHaveBeenCalledWith({
      searchId: delivery.teeSearchId,
      alertGeneration: 8,
      kind: "SETUP",
      groupKey: delivery.groupKey,
    });
  });

  it("refuses a changed owner before transport", async () => {
    mocks.findSearch.mockResolvedValue({
      ...search,
      user: { email: "different@example.com", pendingEmail: null },
    });
    await expect(reconcileAmbiguousSetupEmail(delivery.id, now)).resolves.toEqual({
      outcome: "ineligible",
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("refuses stale monitoring evidence and an already accepted owner delivery", async () => {
    mocks.findSearch.mockResolvedValue({
      ...search,
      lastCheckedAt: new Date("2026-09-28T15:00:00.000Z"),
    });
    await expect(reconcileAmbiguousSetupEmail(delivery.id, now)).resolves.toEqual({
      outcome: "ineligible",
    });
    mocks.findSearch.mockResolvedValue({ ...search });
    mocks.countDeliveries.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    await expect(reconcileAmbiguousSetupEmail(delivery.id, now)).resolves.toEqual({
      outcome: "ineligible",
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("refuses replays after Resend's 24-hour idempotency window", async () => {
    mocks.findDelivery.mockResolvedValue({
      ...delivery,
      createdAt: new Date("2026-09-27T15:00:00.000Z"),
    });
    await expect(reconcileAmbiguousSetupEmail(delivery.id, now)).resolves.toEqual({
      outcome: "ineligible",
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
