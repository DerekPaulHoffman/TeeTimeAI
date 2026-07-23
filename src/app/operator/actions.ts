"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";

import { getCurrentOperator } from "@/lib/operator/auth";
import {
  requestOperatorIncidentRetry,
  resolveOperatorFeedback
} from "@/lib/operator/mutations";

export type OperatorActionState = {
  status: "idle" | "success" | "error";
  message: string;
};

export async function resolveFeedbackAction(
  _previousState: OperatorActionState,
  formData: FormData
): Promise<OperatorActionState> {
  await requireOperator();
  const feedbackId = readIdentifier(formData, "feedbackId");
  if (!feedbackId) {
    return { status: "error", message: "Feedback item was not found." };
  }

  const result = await resolveOperatorFeedback(feedbackId);
  revalidatePath("/operator");
  return {
    status: "success",
    message:
      result === "resolved"
        ? "Feedback resolved."
        : "Feedback was already resolved."
  };
}

export async function retryIncidentAction(
  _previousState: OperatorActionState,
  formData: FormData
): Promise<OperatorActionState> {
  await requireOperator();
  const incidentId = readIdentifier(formData, "incidentId");
  if (!incidentId) {
    return { status: "error", message: "Incident was not found." };
  }

  const result = await requestOperatorIncidentRetry(incidentId);
  revalidatePath("/operator");

  const messages = {
    queued: { status: "success", message: "Retry moved to the front of the queue." },
    already_due: { status: "success", message: "This incident is already queued." },
    in_progress: { status: "success", message: "A responder already owns this incident." },
    manual_review: {
      status: "error",
      message: "This incident needs manual review and cannot be auto-retried."
    },
    resolved: { status: "success", message: "This incident is already resolved." },
    not_found: { status: "error", message: "Incident was not found." },
    busy: {
      status: "error",
      message: "The responder is updating the queue. Try again in a moment."
    }
  } as const;

  return messages[result];
}

async function requireOperator() {
  const operator = await getCurrentOperator();
  if (!operator) {
    notFound();
  }
  return operator;
}

function readIdentifier(formData: FormData, key: string) {
  const value = formData.get(key);
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128 ? normalized : null;
}
