import { NextRequest, NextResponse } from "next/server";

import { getRequiredAppUser } from "@/lib/auth/current-user";
import { startSearchSchedule } from "@/lib/automation/search-scheduler";
import { hasClerkConfig, hasDatabaseConfig } from "@/lib/env";
import { getTeeSearchForUser } from "@/lib/searches/service";

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  if (!hasDatabaseConfig()) {
    return NextResponse.json({ error: "DATABASE_URL is required" }, { status: 503 });
  }
  if (!hasClerkConfig()) {
    return NextResponse.json(
      { error: "Account sign-in is required to check saved alerts." },
      { status: 503 }
    );
  }

  try {
    const { id } = await context.params;
    const search = await getOwnedSearch(id);
    if (!search) {
      return NextResponse.json({ error: "Search not found" }, { status: 404 });
    }
    if (search.status !== "ACTIVE") {
      return NextResponse.json({ error: "Resume this search before checking" }, { status: 409 });
    }

    const schedule = await startSearchSchedule(id, { reuseIfRecent: true });
    return NextResponse.json(
      { status: schedule.reused ? "already_running" : "queued", ...schedule },
      { status: 202 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not start search check" },
      { status: 400 }
    );
  }
}

async function getOwnedSearch(searchId: string) {
  const user = await getRequiredAppUser();
  return getTeeSearchForUser(user.id, searchId);
}
