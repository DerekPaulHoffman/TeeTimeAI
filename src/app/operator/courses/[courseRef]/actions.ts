"use server";

import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";

import { getCurrentOperator } from "@/lib/operator/auth";
import {
  applyOperatorCourseDecision,
  approveOperatorCourseTechnicalFinal,
  correctOperatorCourseBookingLink,
  humanReviewReasonSchema,
  operatorCourseDecisionSchema,
  reopenOperatorCourseTechnicalFinal,
  requestOperatorCourseRecheck,
  updateOperatorCourseOfficialLinks
} from "@/lib/operator/course-monitoring";
import { assertSameOriginOperatorMutation } from "@/lib/operator/mutation-security";

export async function correctBookingLinkAction(formData: FormData) {
  const operator = await requireOperatorMutation();
  const reference = readField(formData, "reference");
  await correctOperatorCourseBookingLink(
    {
      reference,
      statusRevision: readInteger(formData, "statusRevision"),
      incidentCycle: readOptionalInteger(formData, "incidentCycle"),
      incidentRevision: readOptionalRevision(formData, "incidentRevision"),
      bookingUrl: readField(formData, "bookingUrl"),
      evidenceUrl: readField(formData, "evidenceUrl"),
      note: readField(formData, "note"),
      idempotencyKey: readField(formData, "idempotencyKey")
    },
    {
      actorId: operator.clerkUserId,
      source: "OPERATOR_DASHBOARD",
      apply: true,
      dispatchSearches: true
    }
  );
  revalidateOperatorCourse(reference);
}

export type OperatorActionState = {
  status: "idle" | "error" | "success";
  message: string;
};

export type OperatorRecheckActionState = OperatorActionState;

export async function updateOfficialLinksAction(
  previousState: OperatorActionState,
  formData: FormData
): Promise<OperatorActionState> {
  void previousState;
  try {
    const operator = await requireOperatorMutation();
    const reference = readField(formData, "reference");
    await updateOperatorCourseOfficialLinks(
      {
        reference,
        statusRevision: readInteger(formData, "statusRevision"),
        incidentCycle: readOptionalInteger(formData, "incidentCycle"),
        incidentRevision: readOptionalRevision(formData, "incidentRevision"),
        providerFamilyKey: readField(formData, "providerFamilyKey"),
        website: readOptionalField(formData, "website"),
        bookingUrl: readOptionalField(formData, "bookingUrl"),
        idempotencyKey: readField(formData, "idempotencyKey")
      },
      {
        actorId: operator.clerkUserId,
        source: "OPERATOR_DASHBOARD",
        apply: true,
        dispatchSearches: true
      }
    );
    revalidateOperatorCourse(reference);
    return {
      status: "success",
      message:
        "Provider and official links saved. Verification and a fresh monitoring check are queued."
    };
  } catch (error) {
    console.error("[operator:update-official-links]", {
      category: getOperatorActionErrorCategory(error)
    });
    return {
      status: "error",
      message: getOperatorActionErrorMessage(error)
    };
  }
}

export async function setCourseOutcomeAction(
  previousState: OperatorActionState,
  formData: FormData
): Promise<OperatorActionState> {
  void previousState;
  try {
    const operator = await requireOperatorMutation();
    const reference = readField(formData, "reference");
    const decision = operatorCourseDecisionSchema.parse(readField(formData, "decision"));
    await applyOperatorCourseDecision(
      {
        reference,
        statusRevision: readInteger(formData, "statusRevision"),
        incidentCycle: readOptionalInteger(formData, "incidentCycle"),
        incidentRevision: readOptionalRevision(formData, "incidentRevision"),
        decision,
        idempotencyKey: readField(formData, "idempotencyKey")
      },
      {
        actorId: operator.clerkUserId,
        source: "OPERATOR_DASHBOARD",
        apply: true,
        dispatchSearches: decision === "LOCAL_READER"
      }
    );
    revalidateOperatorCourse(reference);
    return {
      status: "success",
      message:
        decision === "LOCAL_READER"
          ? "This course now uses the local tee-time reader. A fresh check is queued."
          : decision === "WEBSITE_TEMPORARILY_UNAVAILABLE"
            ? "The course website is marked temporarily unavailable. Golfers will see that their alert remains active while Tee Time Spot checks back."
          : "The final course outcome was saved."
    };
  } catch (error) {
    console.error("[operator:set-course-outcome]", {
      category: getOperatorActionErrorCategory(error)
    });
    return {
      status: "error",
      message: getOperatorActionErrorMessage(error)
    };
  }
}

export async function requestRecheckAction(
  previousState: OperatorRecheckActionState,
  formData: FormData
): Promise<OperatorRecheckActionState> {
  void previousState;
  try {
    const operator = await requireOperatorMutation();
    const reference = readField(formData, "reference");
    await requestOperatorCourseRecheck(
      {
        reference,
        statusRevision: readInteger(formData, "statusRevision"),
        incidentCycle: readOptionalInteger(formData, "incidentCycle"),
        incidentRevision: readOptionalRevision(formData, "incidentRevision"),
        note: readField(formData, "note"),
        idempotencyKey: readField(formData, "idempotencyKey")
      },
      {
        actorId: operator.clerkUserId,
        source: "OPERATOR_DASHBOARD",
        apply: true,
        dispatchSearches: true
      }
    );
    revalidateOperatorCourse(reference);
    return {
      status: "success",
      message: "The AI recheck was queued with your note."
    };
  } catch (error) {
    console.error("[operator:request-recheck]", {
      category: getRecheckErrorCategory(error)
    });
    return {
      status: "error",
      message: getRecheckErrorMessage(error)
    };
  }
}

export async function approveTechnicalFinalAction(formData: FormData) {
  const operator = await requireOperatorMutation();
  const reference = readField(formData, "reference");
  await approveOperatorCourseTechnicalFinal(
    {
      reference,
      statusRevision: readInteger(formData, "statusRevision"),
      incidentCycle: readOptionalInteger(formData, "incidentCycle"),
      incidentRevision: readOptionalRevision(formData, "incidentRevision"),
      reason: humanReviewReasonSchema.parse(readField(formData, "reason")),
      evidenceUrl: readField(formData, "evidenceUrl"),
      note: readField(formData, "note"),
      idempotencyKey: readField(formData, "idempotencyKey")
    },
    {
      actorId: operator.clerkUserId,
      source: "OPERATOR_DASHBOARD",
      apply: true
    }
  );
  revalidateOperatorCourse(reference);
}

export async function reopenTechnicalFinalAction(formData: FormData) {
  const operator = await requireOperatorMutation();
  const reference = readField(formData, "reference");
  await reopenOperatorCourseTechnicalFinal(
    {
      reference,
      statusRevision: readInteger(formData, "statusRevision"),
      incidentCycle: readOptionalInteger(formData, "incidentCycle"),
      incidentRevision: readOptionalRevision(formData, "incidentRevision"),
      evidenceUrl: readField(formData, "evidenceUrl"),
      note: readField(formData, "note"),
      idempotencyKey: readField(formData, "idempotencyKey")
    },
    {
      actorId: operator.clerkUserId,
      source: "OPERATOR_DASHBOARD",
      apply: true,
      dispatchSearches: true
    }
  );
  revalidateOperatorCourse(reference);
}

async function requireOperatorMutation() {
  assertSameOriginOperatorMutation(await headers());
  const operator = await getCurrentOperator();
  if (!operator) {
    notFound();
  }
  return operator;
}

function revalidateOperatorCourse(reference: string) {
  revalidatePath("/operator");
  revalidatePath(`/operator/courses/${reference}`);
}

function readField(formData: FormData, name: string) {
  const value = formData.get(name);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function readOptionalField(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readInteger(formData: FormData, name: string) {
  const value = Number(readField(formData, name));
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be an integer.`);
  }
  return value;
}

function readOptionalInteger(formData: FormData, name: string) {
  const value = formData.get(name);
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function readOptionalRevision(formData: FormData, name: string) {
  const value = formData.get(name);
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function getRecheckErrorMessage(error: unknown) {
  if (error instanceof ZodError) {
    return "Enter a note between 3 and 500 characters. Sensitive details will be redacted.";
  }
  return getOperatorActionErrorMessage(error);
}

function getOperatorActionErrorMessage(error: unknown) {
  if (error instanceof ZodError) {
    return "Check the highlighted values and try again.";
  }
  if (error instanceof Error && error.message.includes("changed while")) {
    return "Course monitoring changed while this form was open. Refresh and review the newest evidence.";
  }
  if (error instanceof Error && error.message.includes("already been applied")) {
    return "This recheck was already queued. Refresh to see the newest course state.";
  }
  if (error instanceof Error && error.message.includes("not found")) {
    return "This course monitoring record is no longer available.";
  }
  if (
    error instanceof Error &&
    (error.message.includes("official course site") ||
      error.message.includes("official booking page") ||
      error.message.includes("official link") ||
      error.message.includes("local tee-time reader") ||
      error.message.includes("provider") ||
      error.message.includes("Change at least one"))
  ) {
    return error.message;
  }
  return "Nothing was changed. Please try again.";
}

function getRecheckErrorCategory(error: unknown) {
  return getOperatorActionErrorCategory(error);
}

function getOperatorActionErrorCategory(error: unknown) {
  if (error instanceof ZodError) return "VALIDATION";
  if (error instanceof Error && error.message.includes("changed while")) return "STALE_STATE";
  if (error instanceof Error && error.message.includes("already been applied")) return "REPLAY";
  if (error instanceof Error && error.message.includes("not found")) return "NOT_FOUND";
  return "UNKNOWN";
}
