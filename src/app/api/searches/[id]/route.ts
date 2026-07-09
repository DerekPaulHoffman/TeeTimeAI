import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getRequiredAppUser } from "@/lib/auth/current-user";
import { hasClerkConfig, hasDatabaseConfig } from "@/lib/env";
import {
  deleteTeeSearchForPoc,
  deleteTeeSearchForUser,
  updateTeeSearchForPoc,
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

  try {
    const { id } = await context.params;
    const input = updateSearchSchema.parse(await request.json());
    const search = hasClerkConfig()
      ? await updateOwnedSearch(id, input)
      : await updateTeeSearchForPoc(id, input);
    return NextResponse.json({ search });
  } catch (error) {
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

  try {
    const { id } = await context.params;
    if (hasClerkConfig()) {
      const user = await getRequiredAppUser();
      await deleteTeeSearchForUser(user.id, id);
    } else {
      await deleteTeeSearchForPoc(id);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
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
