"use server";

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import {
  readEmailStopTokenForOwnerRecovery,
  verifyEmailStopToken
} from "@/lib/email/search-actions";
import {
  stopOwnedTeeSearchFromEmail,
  stopTeeSearchFromEmail
} from "@/lib/searches/email-actions";

export async function confirmEmailAlertStop(formData: FormData) {
  const token = formData.get("token");
  if (typeof token !== "string") {
    redirect("/alerts/stop?invalid=1");
  }

  const action = safelyVerifyToken(token);
  const recoveryAction = action ? null : readEmailStopTokenForOwnerRecovery(token);
  const clerkUserId = recoveryAction ? await getSignedInClerkUserId() : null;
  const result = action
    ? await stopTeeSearchFromEmail(action.searchId, action.reason)
    : recoveryAction && clerkUserId
      ? await stopOwnedTeeSearchFromEmail(
          recoveryAction.searchId,
          recoveryAction.reason,
          clerkUserId
        )
      : null;
  if (!result) {
    redirect("/alerts/stop?invalid=1");
  }

  redirect(`/alerts/stop?done=${(action ?? recoveryAction)?.reason}`);
}

async function getSignedInClerkUserId() {
  try {
    return (await auth()).userId;
  } catch {
    return null;
  }
}

function safelyVerifyToken(token: string) {
  try {
    return verifyEmailStopToken(token);
  } catch {
    return null;
  }
}
