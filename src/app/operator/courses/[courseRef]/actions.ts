"use server";

import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";

import { getCurrentOperator } from "@/lib/operator/auth";
import {
  approveOperatorCourseTechnicalFinal,
  correctOperatorCourseBookingLink,
  humanReviewReasonSchema,
  reopenOperatorCourseTechnicalFinal,
  requestOperatorCourseRecheck
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

export async function requestRecheckAction(formData: FormData) {
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
