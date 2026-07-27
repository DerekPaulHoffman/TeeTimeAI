import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentOperator = vi.hoisted(() => vi.fn());

vi.mock("@/lib/operator/auth", () => ({
  getCurrentOperator
}));

import { GET } from "./route";

describe("GET /api/operator/access", () => {
  beforeEach(() => {
    getCurrentOperator.mockReset();
  });

  it("returns only the current operator membership decision", async () => {
    getCurrentOperator.mockResolvedValue({
      clerkUserId: "user_operator",
      email: "operator@example.com"
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ operator: true });
  });

  it("fails closed without exposing identity details", async () => {
    getCurrentOperator.mockResolvedValue(null);

    const response = await GET();

    await expect(response.json()).resolves.toEqual({ operator: false });
  });
});
