import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentOperator: vi.fn(),
  resolveFeedback: vi.fn(),
  retryIncident: vi.fn(),
  revalidatePath: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  })
}));

vi.mock("@/lib/operator/auth", () => ({
  getCurrentOperator: mocks.getCurrentOperator
}));
vi.mock("@/lib/operator/mutations", () => ({
  resolveOperatorFeedback: mocks.resolveFeedback,
  requestOperatorIncidentRetry: mocks.retryIncident
}));
vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath
}));
vi.mock("next/navigation", () => ({
  notFound: mocks.notFound
}));

import {
  resolveFeedbackAction,
  retryIncidentAction,
  type OperatorActionState
} from "./actions";

const initial: OperatorActionState = { status: "idle", message: "" };

describe("operator server actions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getCurrentOperator.mockResolvedValue({
      clerkUserId: "clerk-operator",
      email: "derekpaulhoffman@gmail.com"
    });
  });

  it("rechecks access before any mutation", async () => {
    mocks.getCurrentOperator.mockResolvedValue(null);
    const formData = new FormData();
    formData.set("feedbackId", "feedback-1");

    await expect(resolveFeedbackAction(initial, formData)).rejects.toThrow(
      "NEXT_NOT_FOUND"
    );
    expect(mocks.resolveFeedback).not.toHaveBeenCalled();
  });

  it("resolves feedback and refreshes the private page", async () => {
    mocks.resolveFeedback.mockResolvedValue("resolved");
    const formData = new FormData();
    formData.set("feedbackId", "feedback-1");

    await expect(resolveFeedbackAction(initial, formData)).resolves.toEqual({
      status: "success",
      message: "Feedback resolved."
    });
    expect(mocks.resolveFeedback).toHaveBeenCalledWith("feedback-1");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/operator");
  });

  it("returns the guarded incident retry result", async () => {
    mocks.retryIncident.mockResolvedValue("manual_review");
    const formData = new FormData();
    formData.set("incidentId", "incident-1");

    await expect(retryIncidentAction(initial, formData)).resolves.toEqual({
      status: "error",
      message: "This incident needs manual review and cannot be auto-retried."
    });
    expect(mocks.retryIncident).toHaveBeenCalledWith("incident-1");
  });
});
