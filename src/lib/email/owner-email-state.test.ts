import { describe, expect, it } from "vitest";

import { buildAlertGenerationStartMarker } from "@/lib/searches/generation-clock";
import { getOwnerEmailState } from "./owner-email-state";

const createdAt = new Date("2026-09-27T10:00:00.000Z");
const generationStartedAt = new Date("2026-09-28T10:00:00.000Z");
const currentGeneration = {
  status: "ACTIVE",
  previouslySent: false,
  alertGeneration: 2,
  createdAt,
  statusEmailSnapshot: buildAlertGenerationStartMarker({
    alertGeneration: 2,
    generationStartedAt,
  }),
};

describe("owner email dashboard state", () => {
  it("keeps an edited alert pending until its new generation has been checked", () => {
    expect(getOwnerEmailState({
      ...currentGeneration,
      statuses: undefined,
      lastCheckedAt: new Date("2026-09-27T11:00:00.000Z"),
    })).toBe("FIRST_CHECK_PENDING");
  });

  it("shows a missing email after the current generation has been checked", () => {
    expect(getOwnerEmailState({
      ...currentGeneration,
      statuses: new Set(["SUPPRESSED"]),
      lastCheckedAt: new Date("2026-09-28T10:01:00.000Z"),
    })).toBe("NOT_SENT");
  });

  it("does not treat a suppressed delivery as proof of sending", () => {
    expect(getOwnerEmailState({
      ...currentGeneration,
      statuses: new Set(["SUPPRESSED", "SENT"]),
      lastCheckedAt: new Date("2026-09-28T10:01:00.000Z"),
    })).toBe("SENT");
  });

  it("shows a completed alert with no accepted email as not sent", () => {
    expect(getOwnerEmailState({
      ...currentGeneration,
      status: "COMPLETED",
      statuses: new Set(["SUPPRESSED"]),
      lastCheckedAt: new Date("2026-09-27T11:00:00.000Z"),
    })).toBe("NOT_SENT");
  });

  it("shows prior delivery after pausing without claiming the paused generation sent", () => {
    expect(getOwnerEmailState({
      ...currentGeneration,
      status: "PAUSED",
      previouslySent: true,
      statuses: undefined,
      lastCheckedAt: new Date("2026-09-28T10:01:00.000Z"),
    })).toBe("PREVIOUSLY_SENT");
  });

  it("does not leave a completed failed delivery pending", () => {
    expect(getOwnerEmailState({
      ...currentGeneration,
      status: "COMPLETED",
      statuses: new Set(["FAILED"]),
      lastCheckedAt: new Date("2026-09-28T10:01:00.000Z"),
    })).toBe("NOT_SENT");
  });

  it("does not use a previous generation's sent email for an active edited alert", () => {
    expect(getOwnerEmailState({
      ...currentGeneration,
      previouslySent: true,
      statuses: new Set(["FAILED"]),
      lastCheckedAt: new Date("2026-09-28T10:01:00.000Z"),
    })).toBe("PENDING");
  });
});
