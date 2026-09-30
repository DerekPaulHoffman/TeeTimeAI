import { NextResponse } from "next/server";

import { getRequiredAppUser } from "@/lib/auth/current-user";
import { listPendingRecoveryDemandsForUser } from "@/lib/course-recovery/demand";
import { hasClerkConfig, hasDatabaseConfig } from "@/lib/env";
import { SearchEmailDeliveryInProgressError } from "@/lib/users/pending-email";

const headers = { "Cache-Control": "private, no-store" };

export async function GET() {
  if (!hasDatabaseConfig() || !hasClerkConfig()) {
    return NextResponse.json({ error: "Account alerts are temporarily unavailable. Please try again later." },
      { status: 503, headers });
  }
  try {
    const user = await getRequiredAppUser();
    return NextResponse.json({ demands: await listPendingRecoveryDemandsForUser(user.id) }, { headers });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
    }
    if (error instanceof SearchEmailDeliveryInProgressError) {
      return NextResponse.json({ error: error.message, retryable: true }, { status: 409,
        headers: { ...headers, ...(error.retryAt ? { "Retry-After": String(Math.max(1,
          Math.ceil((error.retryAt.getTime() - Date.now()) / 1000))) } : {}) } });
    }
    return NextResponse.json({ error: "Pending alerts are temporarily unavailable. Please try again later." },
      { status: 503, headers });
  }
}
