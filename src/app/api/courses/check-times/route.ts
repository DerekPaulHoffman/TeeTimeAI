import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseConfig } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { fetchCourseTeeSheet } from "@/lib/automation/course-provider-read";
import { resolveProviderCapability } from "@/lib/automation/provider-capabilities";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { evaluateMonitoringGate } from "@/lib/automation/policy";
import { parseCourseLocalDateTime } from "@/lib/tee-times/matching";
import { selectKnownTeeTimes } from "@/lib/courses/known-tee-times";
import { getSafeOfficialBookingUrl } from "@/lib/email/search-delivery-outbox";

export const maxDuration = 60;
const inputSchema = z.object({ courseId: z.string().min(1).max(100), date: z.iso.date(), players: z.coerce.number().int().min(1).max(4) });
const reply = (status: string, times: unknown[] = []) => NextResponse.json({ status, times }, { headers: { "Cache-Control": "no-store" } });

// Public availability only. This path never creates demand, starts a workflow, or sends email.
export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.has("mode") && request.nextUrl.searchParams.get("mode") !== "OUTDOOR") {
    return NextResponse.json({ error: "This availability view supports outdoor golf." }, { status: 400 });
  }
  const input = inputSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!input.success) return NextResponse.json({ error: "Choose a course, date, and player count." }, { status: 400 });
  const day = new Date(`${input.data.date}T00:00:00Z`);
  if (day.getTime() < Date.now() - 86400000 || day.getTime() > Date.now() + 90 * 86400000) return reply("UNAVAILABLE");
  if (!hasDatabaseConfig()) return reply("FAILED");
  try {
    const course = await prisma.course.findUnique({ where: { id: input.data.courseId } });
    if (!course || course.isPublic !== true || !evaluateMonitoringGate(course).adapterAllowed) return reply("UNAVAILABLE");
    const capability = resolveProviderCapability(course);
    if (!capability.isRunnable) return reply("UNAVAILABLE");
    const result = await runWithProviderRequestLease(capability.providerFamilyKey, () => fetchCourseTeeSheet(course, day, input.data.players, false));
    if (!result.acquired) return reply("BUSY");
    if (result.value.targetDateStatus === "NOT_OPEN") return reply("NOT_OPEN");
    const confirmedAt = new Date();
    const safeSlots = result.value.slots.flatMap(slot => {
      const bookingUrl = getSafeOfficialBookingUrl(slot.bookingUrl);
      return bookingUrl ? [{ ...slot, bookingUrl }] : [];
    });
    if (result.value.slots.length > 0 && safeSlots.length === 0) return reply("FAILED");
    const times = selectKnownTeeTimes(safeSlots.map(slot => ({
      startsAt: parseCourseLocalDateTime(slot.startsAt, course.timeZone), availableSpots: slot.availableSpots,
      holes: slot.holes ?? null, priceCents: slot.priceCents ?? null, bookingUrl: slot.bookingUrl,
      lastSeenAt: confirmedAt, lastConfirmedAt: confirmedAt, availabilityStatus: "AVAILABLE",
    })), course.timeZone, input.data.date, confirmedAt);
    return reply("CHECKED", times);
  } catch { return reply("FAILED"); }
}
