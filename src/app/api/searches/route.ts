import { NextRequest, NextResponse } from "next/server";

import { getRequiredAppUser } from "@/lib/auth/current-user";
import { startSearchSchedule } from "@/lib/automation/search-scheduler";
import { hasClerkConfig, hasDatabaseConfig } from "@/lib/env";
import {
  parseWebsiteTrafficClass,
  WEBSITE_TRAFFIC_CLASS_HEADER
} from "@/lib/engagement/traffic-class";
import { createTeeSearchForUser, listTeeSearchesForUser } from "@/lib/searches/service";
import { teeSearchInputSchema } from "@/lib/validation/search";

export async function GET() {
  if (!hasDatabaseConfig()) {
    return databaseSetupError();
  }

  if (!hasClerkConfig()) {
    return NextResponse.json(
      { error: "Account sign-in is not available yet. Alerts cannot be created or managed." },
      { status: 503 }
    );
  }

  try {
    const user = await getRequiredAppUser();
    const searches = await listTeeSearchesForUser(user.id);
    return NextResponse.json({ searches });
  } catch (error) {
    return handleAppError(error);
  }
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  const requestId = request.headers.get("x-vercel-id");
  console.log(
    JSON.stringify({
      level: "info",
      message: "Search submission started",
      method: "POST",
      requestId,
      route: "/api/searches"
    })
  );

  if (!hasDatabaseConfig()) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Search submission failed",
        method: "POST",
        requestId,
        route: "/api/searches",
        status: 503,
        durationMs: Date.now() - startedAt,
        error: "Database configuration unavailable"
      })
    );
    return databaseSetupError();
  }

  if (!hasClerkConfig()) {
    return accountSetupError();
  }

  try {
    const user = await getRequiredAppUser();
    const submittedInput = teeSearchInputSchema.parse(await request.json());
    const input = { ...submittedInput, alertEmail: user.email };
    const trafficClass = parseWebsiteTrafficClass(
      request.headers.get(WEBSITE_TRAFFIC_CLASS_HEADER)
    );
    const search = await createTeeSearchForUser(user.id, input, trafficClass);
    let schedule: Awaited<ReturnType<typeof startSearchSchedule>> | null = null;
    try {
      schedule = await startSearchSchedule(search.id);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "Initial search workflow did not start",
          method: "POST",
          requestId,
          route: "/api/searches",
          searchId: search.id,
          error: getErrorMessage(error)
        })
      );
    }
    console.log(
      JSON.stringify({
        level: "info",
        message: "Search submission completed",
        method: "POST",
        requestId,
        route: "/api/searches",
        status: 201,
        durationMs: Date.now() - startedAt,
        courseCount: input.courses.length,
        workflowStarted: Boolean(schedule)
      })
    );
    return NextResponse.json({ search, schedule }, { status: 201 });
  } catch (error) {
    const response = handleAppError(error);
    console.error(
      JSON.stringify({
        level: "error",
        message: "Search submission failed",
        method: "POST",
        requestId,
        route: "/api/searches",
        status: response.status,
        durationMs: Date.now() - startedAt,
        error: getErrorMessage(error)
      })
    );
    return response;
  }
}

function databaseSetupError() {
  return NextResponse.json(
    { error: "DATABASE_URL is not configured. Add Neon Postgres before saving searches." },
    { status: 503 }
  );
}

function accountSetupError() {
  return NextResponse.json(
    { error: "Account sign-in is not available yet. Alerts cannot be created or managed." },
    { status: 503 }
  );
}

function handleAppError(error: unknown) {
  const message = getErrorMessage(error);
  const status = message === "Unauthorized" ? 401 : 400;
  return NextResponse.json({ error: message }, { status });
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}
