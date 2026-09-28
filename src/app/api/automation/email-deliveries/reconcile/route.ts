import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { assertAutomationRequest } from "@/lib/api/automation-auth";
import { reconcileAmbiguousSetupEmail } from "@/lib/email/reconcile-ambiguous-status";
import { hasDatabaseConfig } from "@/lib/env";

export const runtime = "nodejs";

const requestSchema = z.object({
  deliveryId: z.string().regex(/^c[a-z0-9]{20,}$/),
});

export async function POST(request: NextRequest) {
  const authError = assertAutomationRequest(request);
  if (authError) {
    return authError;
  }
  if (!hasDatabaseConfig()) {
    return NextResponse.json({ error: "Email recovery is unavailable." }, { status: 503 });
  }
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "A valid delivery ID is required." }, { status: 400 });
  }
  try {
    const result = await reconcileAmbiguousSetupEmail(parsed.data.deliveryId);
    if (result.outcome === "ineligible") {
      return NextResponse.json({ error: "Delivery is not eligible for recovery." }, { status: 409 });
    }
    return NextResponse.json(result, { status: result.recorded ? 200 : 202 });
  } catch (error) {
    console.error("[email:operator-reconciliation-failed]", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "Email recovery could not be confirmed." }, { status: 503 });
  }
}
