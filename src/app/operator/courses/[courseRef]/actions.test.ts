import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOriginOperatorMutation: vi.fn(),
  getCurrentOperator: vi.fn(),
  revalidatePath: vi.fn(),
  requestOperatorCourseRecheck: vi.fn()
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers())
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn()
}));
vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath
}));
vi.mock("@/lib/operator/auth", () => ({
  getCurrentOperator: mocks.getCurrentOperator
}));
vi.mock("@/lib/operator/mutation-security", () => ({
  assertSameOriginOperatorMutation: mocks.assertSameOriginOperatorMutation
}));
vi.mock("@/lib/operator/course-monitoring", () => ({
  approveOperatorCourseTechnicalFinal: vi.fn(),
  correctOperatorCourseBookingLink: vi.fn(),
  humanReviewReasonSchema: { parse: vi.fn((value: string) => value) },
  reopenOperatorCourseTechnicalFinal: vi.fn(),
  requestOperatorCourseRecheck: mocks.requestOperatorCourseRecheck
}));

import { requestRecheckAction } from "./actions";

const idleState = {
  status: "idle" as const,
  message: ""
};

function recheckFormData() {
  const formData = new FormData();
  formData.set("reference", "cm_123456789012345678901234");
  formData.set("statusRevision", "4");
  formData.set("incidentCycle", "2");
  formData.set("incidentRevision", "7");
  formData.set("note", "Verify the current signed-out booking surface.");
  formData.set("idempotencyKey", "operator-recheck-123456");
  return formData;
}

describe("requestRecheckAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentOperator.mockResolvedValue({
      clerkUserId: "operator-user"
    });
  });

  it("returns success state instead of throwing after queueing", async () => {
    mocks.requestOperatorCourseRecheck.mockResolvedValue({
      action: "request_recheck",
      applied: true
    });

    await expect(requestRecheckAction(idleState, recheckFormData())).resolves.toEqual({
      status: "success",
      message: "The AI recheck was queued with your note."
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/operator");
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/operator/courses/cm_123456789012345678901234"
    );
  });

  it("returns a useful stale-form message instead of a route-level error", async () => {
    mocks.requestOperatorCourseRecheck.mockRejectedValue(
      new Error(
        "Course monitoring changed while this form was open. Refresh and review the newest evidence."
      )
    );

    await expect(requestRecheckAction(idleState, recheckFormData())).resolves.toEqual({
      status: "error",
      message:
        "Course monitoring changed while this form was open. Refresh and review the newest evidence."
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
