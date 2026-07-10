"use server";

import { redirect } from "next/navigation";

import { verifyEmailStopToken } from "@/lib/email/search-actions";
import { stopTeeSearchFromEmail } from "@/lib/searches/email-actions";

export async function confirmEmailAlertStop(formData: FormData) {
  const token = formData.get("token");
  const action = typeof token === "string" ? safelyVerifyToken(token) : null;

  if (!action) {
    redirect("/alerts/stop?invalid=1");
  }

  const result = await stopTeeSearchFromEmail(action.searchId, action.reason);
  if (!result) {
    redirect("/alerts/stop?invalid=1");
  }

  redirect(`/alerts/stop?done=${action.reason}`);
}

function safelyVerifyToken(token: string) {
  try {
    return verifyEmailStopToken(token);
  } catch {
    return null;
  }
}
