import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getRequiredAppUser } from "@/lib/auth/current-user";
import { hasClerkConfig, hasDatabaseConfig } from "@/lib/env";
import { updateTeeSearchStatusForUser } from "@/lib/searches/service";

const updateSearchSchema = z.object({
  status: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"])
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  if (!hasClerkConfig() || !hasDatabaseConfig()) {
    return NextResponse.json({ error: "Clerk and DATABASE_URL are required" }, { status: 503 });
  }

  try {
    const { id } = await context.params;
    const input = updateSearchSchema.parse(await request.json());
    const user = await getRequiredAppUser();
    const search = await updateTeeSearchStatusForUser(user.id, id, input.status);
    return NextResponse.json({ search });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not update search" },
      { status: 400 }
    );
  }
}
