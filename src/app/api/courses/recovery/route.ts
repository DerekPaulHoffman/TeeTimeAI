import { after, NextResponse } from "next/server";
import { ZodError } from "zod";
import { hasDatabaseConfig } from "@/lib/env";
import { recoveryInputSchema } from "@/lib/course-recovery/contracts";
import { readRecoveryJson, recoverySourceBucket, isRecoverySameOrigin } from "@/lib/course-recovery/http";
import { retainRecoveryRequest, readRecoveryView, RecoveryAdmissionError } from "@/lib/course-recovery/service";
import { startRecoveryRequest } from "@/lib/course-recovery/scheduler";

export async function POST(request: Request) {
  if (!hasDatabaseConfig()) return NextResponse.json({ error: "Course requests are temporarily unavailable." }, { status: 503 });
  if (!isRecoverySameOrigin(request)) return NextResponse.json({ error: "Use the course search to submit this request." }, { status: 403 });
  let input;
  try { input = recoveryInputSchema.parse(await readRecoveryJson(request)); }
  catch (error) { return NextResponse.json({ error: error instanceof ZodError
    ? "Enter a course name and town, with both coordinates if provided."
    : "Enter a valid, bounded course request." }, { status: 400 }); }
  try {
    const retained = await retainRecoveryRequest(input, recoverySourceBucket(request));
    const recovery = await readRecoveryView(retained.id);
    after(async () => { try { await startRecoveryRequest(retained.id); } catch { /* Durable row remains due. */ } });
    return NextResponse.json({ recovery }, { status: retained.created ? 201 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof RecoveryAdmissionError ? error.message : "We couldn't save the course request. Please try again." },
      { status: error instanceof RecoveryAdmissionError ? 429 : 503 });
  }
}
