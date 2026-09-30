import { beforeEach, describe, expect, it, vi } from "vitest";

import { SearchEmailDeliveryInProgressError } from "@/lib/users/pending-email";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({ user: vi.fn(), database: vi.fn(), clerk: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/auth/current-user", () => ({ getRequiredAppUser: mocks.user }));
vi.mock("@/lib/env", () => ({ hasDatabaseConfig: mocks.database, hasClerkConfig: mocks.clerk }));
vi.mock("@/lib/course-recovery/demand", () => ({ listPendingRecoveryDemandsForUser: mocks.list }));

const pending = { id: "demand-1", status: "WAITING", revision: 1, teeSearchId: null,
  expiresAt: "2027-01-03T00:00:00.000Z", message: "Your alert settings are saved.",
  requestId: "request-1", courseName: "Harbor Dunes", town: "Harborville, CT",
  date: "2027-01-01", startTime: "08:00", endTime: "12:00", players: 2 };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.database.mockReturnValue(true); mocks.clerk.mockReturnValue(true);
  mocks.user.mockResolvedValue({ id: "owner-1", email: "owner@example.test" });
  mocks.list.mockResolvedValue([pending]);
});

describe("owner pending recovery list API", () => {
  it("derives exact owner authority from Clerk and returns private uncached display fields", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ demands: [pending] });
    expect(mocks.list).toHaveBeenCalledWith("owner-1");
    expect(JSON.stringify(await GET().then(result => result.json()))).not.toMatch(/owner@example|additionalEmails|alertEmail|userId/);
  });

  it("returns an empty owner-scoped list without a global fallback", async () => {
    mocks.list.mockResolvedValue([]);
    expect(await (await GET()).json()).toEqual({ demands: [] });
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("requires account authentication before reading any pending demand", async () => {
    mocks.user.mockRejectedValue(new Error("Unauthorized"));
    const response = await GET();
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it.each(["database", "clerk"] as const)("fails closed when %s setup is unavailable", async setup => {
    mocks[setup].mockReturnValue(false);
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.user).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled();
  });

  it("returns generic uncached errors for persistence or corrupt-settings failures", async () => {
    mocks.list.mockRejectedValue(new Error("layoutHoleCounts query failed: postgresql://owner:secret@private.example/database"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.stringify(await response.json())).not.toMatch(/secret|postgresql|private|layoutHoleCounts/);
  });

  it("preserves the account primary-email transition fence without listing older authority", async () => {
    mocks.user.mockRejectedValue(new SearchEmailDeliveryInProgressError());
    const response = await GET();
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(expect.objectContaining({ retryable: true }));
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
