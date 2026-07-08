import { NextRequest, NextResponse } from "next/server";

import { getRequiredAppUser } from "@/lib/auth/current-user";
import { hasClerkConfig, hasDatabaseConfig } from "@/lib/env";
import { createTeeSearchForUser, listTeeSearchesForUser } from "@/lib/searches/service";
import { upsertGuestUser } from "@/lib/users/service";
import { teeSearchInputSchema } from "@/lib/validation/search";

export async function GET() {
  if (!hasDatabaseConfig()) {
    return databaseSetupError();
  }

  if (!hasClerkConfig()) {
    return NextResponse.json(
      { error: "Clerk accounts are not enabled. Use the dashboard POC view or submit by email." },
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
  if (!hasDatabaseConfig()) {
    return databaseSetupError();
  }

  try {
    const input = teeSearchInputSchema.parse(await request.json());
    const user = await getSearchOwner(input.alertEmail);
    const search = await createTeeSearchForUser(user.id, input);
    return NextResponse.json({ search }, { status: 201 });
  } catch (error) {
    return handleAppError(error);
  }
}

function databaseSetupError() {
  return NextResponse.json(
    { error: "DATABASE_URL is not configured. Add Neon Postgres before saving searches." },
    { status: 503 }
  );
}

function getGuestUserForSearch(alertEmail?: string) {
  if (!alertEmail) {
    throw new Error("Alert email is required.");
  }

  return upsertGuestUser(alertEmail);
}

async function getSearchOwner(alertEmail?: string) {
  if (!hasClerkConfig()) {
    return getGuestUserForSearch(alertEmail);
  }

  try {
    return await getRequiredAppUser();
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return getGuestUserForSearch(alertEmail);
    }

    throw error;
  }
}

function handleAppError(error: unknown) {
  const message = error instanceof Error ? error.message : "Request failed";
  const status = message === "Unauthorized" ? 401 : 400;
  return NextResponse.json({ error: message }, { status });
}
