import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOriginOperatorMutation: vi.fn(),
  getCurrentOperator: vi.fn(),
  revalidatePath: vi.fn(),
  applyOperatorCourseDecision: vi.fn(),
  requestOperatorCourseRecheck: vi.fn(),
  updateOperatorCourseOfficialLinks: vi.fn()
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
  applyOperatorCourseDecision: mocks.applyOperatorCourseDecision,
  approveOperatorCourseTechnicalFinal: vi.fn(),
  correctOperatorCourseBookingLink: vi.fn(),
  humanReviewReasonSchema: { parse: vi.fn((value: string) => value) },
  operatorCourseDecisionSchema: { parse: vi.fn((value: string) => value) },
  reopenOperatorCourseTechnicalFinal: vi.fn(),
  requestOperatorCourseRecheck: mocks.requestOperatorCourseRecheck,
  updateOperatorCourseOfficialLinks: mocks.updateOperatorCourseOfficialLinks
}));

import {
  requestRecheckAction,
  setCourseOutcomeAction,
  updateOfficialLinksAction
} from "./actions";

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

function officialLinksFormData() {
  const formData = new FormData();
  formData.set("reference", "cm_123456789012345678901234");
  formData.set("statusRevision", "4");
  formData.set("incidentCycle", "2");
  formData.set("incidentRevision", "7");
  formData.set("providerFamilyKey", "FOREUP");
  formData.set("website", "https://course.example");
  formData.set("bookingUrl", "https://course.example/book");
  formData.set("idempotencyKey", "operator-links-123456");
  return formData;
}

function temporaryOutcomeFormData() {
  const formData = new FormData();
  formData.set("reference", "cm_123456789012345678901234");
  formData.set("statusRevision", "4");
  formData.set("incidentCycle", "2");
  formData.set("incidentRevision", "7");
  formData.set("decision", "WEBSITE_TEMPORARILY_UNAVAILABLE");
  formData.set("idempotencyKey", "operator-temporary-123456");
  return formData;
}

function localReaderOutcomeFormData() {
  const formData = temporaryOutcomeFormData();
  formData.set("decision", "LOCAL_READER");
  formData.set("idempotencyKey", "operator-local-reader-123456");
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

describe("updateOfficialLinksAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentOperator.mockResolvedValue({
      clerkUserId: "operator-user"
    });
  });

  it("saves the provider with the links and queues verification", async () => {
    mocks.updateOperatorCourseOfficialLinks.mockResolvedValue({
      action: "update_official_links",
      applied: true
    });

    await expect(
      updateOfficialLinksAction(idleState, officialLinksFormData())
    ).resolves.toEqual({
      status: "success",
      message:
        "Provider and official links saved. Verification and a fresh monitoring check are queued."
    });
    expect(mocks.updateOperatorCourseOfficialLinks).toHaveBeenCalledWith(
      expect.objectContaining({
        providerFamilyKey: "FOREUP",
        website: "https://course.example",
        bookingUrl: "https://course.example/book"
      }),
      expect.objectContaining({
        apply: true,
        dispatchSearches: true
      })
    );
  });
});

describe("setCourseOutcomeAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentOperator.mockResolvedValue({
      clerkUserId: "operator-user"
    });
  });

  it("confirms the temporary website status without calling it final", async () => {
    mocks.applyOperatorCourseDecision.mockResolvedValue({
      action: "set_course_outcome",
      applied: true
    });

    await expect(
      setCourseOutcomeAction(idleState, temporaryOutcomeFormData())
    ).resolves.toEqual({
      status: "success",
      message:
        "The course website is marked temporarily unavailable. Golfers will see that their alert remains active while Tee Time Spot checks back."
    });
    expect(mocks.applyOperatorCourseDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "WEBSITE_TEMPORARILY_UNAVAILABLE"
      }),
      expect.objectContaining({
        apply: true,
        dispatchSearches: false
      })
    );
  });

  it("explains when the booking page has no compatible local reader", async () => {
    mocks.applyOperatorCourseDecision.mockRejectedValue(
      new Error(
        "The official booking page is not supported by the local tee-time reader yet. Engineering still owns this course, and no monitoring state was changed."
      )
    );

    await expect(
      setCourseOutcomeAction(idleState, localReaderOutcomeFormData())
    ).resolves.toEqual({
      status: "error",
      message:
        "The official booking page is not supported by the local tee-time reader yet. Engineering still owns this course, and no monitoring state was changed."
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
