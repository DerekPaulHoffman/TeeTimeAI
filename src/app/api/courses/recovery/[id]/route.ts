import { NextResponse } from "next/server";
import { hasDatabaseConfig } from "@/lib/env";
import { readRecoveryView } from "@/lib/course-recovery/service";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!hasDatabaseConfig()) return NextResponse.json({ error: "Course requests are temporarily unavailable." }, { status: 503 });
  const { id } = await context.params;
  if (!/^[a-zA-Z0-9_-]{10,80}$/u.test(id)) return NextResponse.json({ error: "Course request not found." }, { status: 404 });
  try {
    const recovery = await readRecoveryView(id);
    return NextResponse.json(recovery ? { recovery } : { error: "Course request not found." },
      { status: recovery ? 200 : 404, headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "We couldn't refresh this course request. Please try again." }, { status: 503 }); }
}
