import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getRequiredAppUser } from "@/lib/auth/current-user";
import {
  cancelRecoveryDemandForUser,
  getRecoveryDemandForUser,
  recoveryDemandInputSchema,
  RecoveryDemandInputError,
  RecoveryDemandNotFoundError,
  saveRecoveryDemandForUser,
} from "@/lib/course-recovery/demand";
import { isRecoverySameOrigin, readRecoveryJson } from "@/lib/course-recovery/http";
import { parseWebsiteTrafficClass, WEBSITE_TRAFFIC_CLASS_HEADER } from "@/lib/engagement/traffic-class";
import { hasClerkConfig, hasDatabaseConfig } from "@/lib/env";
import { SearchQueueCapacityError } from "@/lib/searches/service";
import { SearchEmailDeliveryInProgressError } from "@/lib/users/pending-email";

type Context = { params: Promise<{ id: string }> };
const recoveryDemandPostSchema = z.object({ settings: recoveryDemandInputSchema }).strict();

function setupError() {
  return !hasDatabaseConfig() || !hasClerkConfig()
    ? NextResponse.json({ error: "Account alerts are temporarily unavailable. Please try again later." }, { status: 503 })
    : null;
}

function handleError(error: unknown) {
  const message = error instanceof Error ? error.message : "Request failed";
  if (message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (error instanceof SearchEmailDeliveryInProgressError) {
    return NextResponse.json({ error: error.message, retryable: true }, { status: 409,
      headers: error.retryAt ? { "Retry-After": String(Math.max(1, Math.ceil((error.retryAt.getTime() - Date.now()) / 1000))) } : undefined });
  }
  if (error instanceof RecoveryDemandNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
  if (error instanceof RecoveryDemandInputError || error instanceof SearchQueueCapacityError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError ||
      message === "The course request is too large." || message === "Enter the course name and town.") {
    return NextResponse.json({ error: "Check the date, time window, players, and recipient settings and try again." }, { status: 400 });
  }
  return NextResponse.json({ error: "Pending alerts are temporarily unavailable. Please try again later." }, { status: 503 });
}

export async function GET(_request: NextRequest, context: Context) {
  const unavailable = setupError();
  if (unavailable) return unavailable;
  try {
    const user = await getRequiredAppUser();
    const { id } = await context.params;
    return NextResponse.json({ demand: await getRecoveryDemandForUser(id, user.id) });
  } catch (error) { return handleError(error); }
}

export async function POST(request: NextRequest, context: Context) {
  if (!isRecoverySameOrigin(request)) return NextResponse.json({ error: "Use this site's pending alert form." }, { status: 403 });
  const unavailable = setupError();
  if (unavailable) return unavailable;
  try {
    const user = await getRequiredAppUser();
    const { settings } = recoveryDemandPostSchema.parse(await readRecoveryJson(request));
    const { id } = await context.params;
    const demand = await saveRecoveryDemandForUser(id, user, settings,
      parseWebsiteTrafficClass(request.headers.get(WEBSITE_TRAFFIC_CLASS_HEADER)));
    return NextResponse.json({ demand }, { status: 201 });
  } catch (error) { return handleError(error); }
}

export async function DELETE(_request: NextRequest, context: Context) {
  if (!isRecoverySameOrigin(_request)) return NextResponse.json({ error: "Use this site's pending alert controls." }, { status: 403 });
  const unavailable = setupError();
  if (unavailable) return unavailable;
  try {
    const user = await getRequiredAppUser();
    const { id } = await context.params;
    return NextResponse.json({ demand: await cancelRecoveryDemandForUser(id, user.id) });
  } catch (error) { return handleError(error); }
}
