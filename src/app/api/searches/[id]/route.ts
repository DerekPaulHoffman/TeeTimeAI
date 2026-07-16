import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getRequiredAppUser } from "@/lib/auth/current-user";
import { startSearchSchedule } from "@/lib/automation/search-scheduler";
import { stopSearchSchedule } from "@/lib/automation/db-service";
import { hasClerkConfig, hasDatabaseConfig } from "@/lib/env";
import { SearchEmailDeliveryInProgressError } from "@/lib/email/search-delivery-outbox";
import {
  deleteTeeSearchForUser,
  updateTeeSearchForUser
} from "@/lib/searches/service";
import {
  MAX_COURSE_PREFERENCES,
  teeSearchDetailsSchema
} from "@/lib/validation/search";

const searchStatusSchema = z.enum(["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"]);
const coursePreferenceRankUpdatesSchema = z
  .array(
    z.object({
      id: z.string().trim().min(1),
      rank: z.number().int().min(1).max(MAX_COURSE_PREFERENCES)
    })
  )
  .min(1)
  .max(MAX_COURSE_PREFERENCES)
  .superRefine((value, context) => {
    const ids = new Set(value.map((preference) => preference.id));
    if (ids.size !== value.length) {
      context.addIssue({
        code: "custom",
        path: ["coursePreferences"],
        message: "Course preferences must be unique"
      });
    }

    const ranks = new Set(value.map((preference) => preference.rank));
    if (ranks.size !== value.length) {
      context.addIssue({
        code: "custom",
        path: ["coursePreferences"],
        message: "Course preference ranks must be unique"
      });
    }
  });

const updateSearchSchema = z.union([
  z.object({ status: searchStatusSchema }).strict(),
  teeSearchDetailsSchema.extend({
    coursePreferences: coursePreferenceRankUpdatesSchema.optional(),
    status: searchStatusSchema.optional()
  }),
  z.object({ coursePreferences: coursePreferenceRankUpdatesSchema }).strict()
]);

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  if (!hasDatabaseConfig()) {
    return NextResponse.json({ error: "DATABASE_URL is required" }, { status: 503 });
  }

  if (!hasClerkConfig()) {
    return NextResponse.json(
      { error: "Account sign-in is required to manage alerts." },
      { status: 503 }
    );
  }

  try {
    const { id } = await context.params;
    const input = updateSearchSchema.parse(await request.json());
    const search = await updateOwnedSearch(id, input);
    let schedule = null;
    if (search.status === "ACTIVE") {
      schedule = await startSearchSchedule(search.id);
    } else {
      await stopSearchSchedule(search.id);
    }
    return NextResponse.json({ search, schedule });
  } catch (error) {
    if (error instanceof SearchEmailDeliveryInProgressError) {
      return NextResponse.json(
        { error: error.message, retryable: true },
        {
          status: 409,
          headers: error.retryAt
            ? {
                "Retry-After": String(
                  Math.max(
                    1,
                    Math.ceil((error.retryAt.getTime() - Date.now()) / 1000)
                  )
                )
              }
            : undefined
        }
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not update search" },
      { status: 400 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  if (!hasDatabaseConfig()) {
    return NextResponse.json({ error: "DATABASE_URL is required" }, { status: 503 });
  }

  if (!hasClerkConfig()) {
    return NextResponse.json(
      { error: "Account sign-in is required to manage alerts." },
      { status: 503 }
    );
  }

  try {
    const { id } = await context.params;
    const user = await getRequiredAppUser();
    await deleteTeeSearchForUser(user.id, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof SearchEmailDeliveryInProgressError) {
      return NextResponse.json(
        { error: error.message, retryable: true },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not remove search" },
      { status: 400 }
    );
  }
}

async function updateOwnedSearch(
  searchId: string,
  input: z.infer<typeof updateSearchSchema>
) {
  const user = await getRequiredAppUser();
  return updateTeeSearchForUser(user.id, searchId, input);
}
