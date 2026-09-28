import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  database: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock("@/lib/api/automation-auth", () => ({ assertAutomationRequest: mocks.auth }));
vi.mock("@/lib/env", () => ({ hasDatabaseConfig: mocks.database }));
vi.mock("@/lib/email/reconcile-ambiguous-status", () => ({
  reconcileAmbiguousSetupEmail: mocks.reconcile,
}));

const url = "http://localhost/api/automation/email-deliveries/reconcile";
const deliveryId = "cmulfmzd3000i04jtbeaflw2z";

describe("POST /api/automation/email-deliveries/reconcile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockReturnValue(null);
    mocks.database.mockReturnValue(true);
    mocks.reconcile.mockResolvedValue({ outcome: "accepted", recorded: true });
  });

  it("requires automation authority before reading the request", async () => {
    mocks.auth.mockReturnValue(new Response(null, { status: 401 }));
    const response = await POST(new NextRequest(url, { method: "POST" }));
    expect(response.status).toBe(401);
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it("rejects malformed IDs and refuses ineligible deliveries", async () => {
    const invalid = await POST(
      new NextRequest(url, { method: "POST", body: JSON.stringify({ deliveryId: "x" }) }),
    );
    expect(invalid.status).toBe(400);
    mocks.reconcile.mockResolvedValue({ outcome: "ineligible" });
    const refused = await POST(
      new NextRequest(url, { method: "POST", body: JSON.stringify({ deliveryId }) }),
    );
    expect(refused.status).toBe(409);
  });

  it("reports accepted and recorded provider delivery without recipient data", async () => {
    const response = await POST(
      new NextRequest(url, { method: "POST", body: JSON.stringify({ deliveryId }) }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ outcome: "accepted", recorded: true });
    expect(mocks.reconcile).toHaveBeenCalledWith(deliveryId);
  });
});
