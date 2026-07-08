import { NextRequest, NextResponse } from "next/server";

import { getRequiredAppUser } from "@/lib/auth/current-user";
import { hasClerkConfig, hasDatabaseConfig } from "@/lib/env";
import { createTeeSearchForUser, listTeeSearchesForUser } from "@/lib/searches/service";
import { teeSearchInputSchema } from "@/lib/validation/search";

export async function GET() {
  const setupError = assertAppSetup();
  if (setupError) {
    return setupError;
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
  const setupError = assertAppSetup();
  if (setupError) {
    return setupError;
  }

  try {
    const input = teeSearchInputSchema.parse(await request.json());
    const user = await getRequiredAppUser();
    const search = await createTeeSearchForUser(user.id, input);
    return NextResponse.json({ search }, { status: 201 });
  } catch (error) {
    return handleAppError(error);
  }
}

function assertAppSetup() {
  if (!hasClerkConfig()) {
    return NextResponse.json(
      { error: "Clerk is not configured. Add Clerk keys before saving searches." },
      { status: 503 }
    );
  }

  if (!hasDatabaseConfig()) {
    return NextResponse.json(
      { error: "DATABASE_URL is not configured. Add Neon Postgres before saving searches." },
      { status: 503 }
    );
  }

  return null;
}

function handleAppError(error: unknown) {
  const message = error instanceof Error ? error.message : "Request failed";
  const status = message === "Unauthorized" ? 401 : 400;
  return NextResponse.json({ error: message }, { status });
}
