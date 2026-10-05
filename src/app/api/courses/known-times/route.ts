import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseConfig } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { selectKnownCourseTimes } from "@/lib/courses/known-tee-times";

const inputSchema = z.object({
  courseIds: z.array(z.string().min(1).max(100)).min(1).max(60),
  date: z.iso.date()
});

export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.has("mode") && request.nextUrl.searchParams.get("mode") !== "OUTDOOR") {
    return NextResponse.json({ error: "This availability view supports outdoor golf." }, { status: 400 });
  }
  const input = inputSchema.safeParse({
    courseIds: request.nextUrl.searchParams.getAll("courseId"),
    date: request.nextUrl.searchParams.get("date")
  });
  if (!input.success) return NextResponse.json({ error: "Choose valid courses and a date." }, { status: 400 });
  if (!hasDatabaseConfig()) return NextResponse.json({ error: "Previously checked times are temporarily unavailable." }, { status: 503 });
  const now = new Date();
  const day = new Date(`${input.data.date}T00:00:00Z`).getTime();
  try {
    const courses = await prisma.course.findMany({
      where: { id: { in: [...new Set(input.data.courseIds)] }, isPublic: true },
      select: {
        id: true, timeZone: true,
        probes: {
          where: { teeSearch: { mode: "OUTDOOR" }, rawSummary: { path: ["publicAvailability", "date"], equals: input.data.date } },
          orderBy: [{ observedAt: "desc" }, { id: "desc" }], take: 1,
          select: { rawSummary: true },
        },
        matches: {
          where: { teeSearch: { mode: "OUTDOOR" }, startsAt: { gt: now, gte: new Date(day - 86400000), lt: new Date(day + 2 * 86400000) } },
          orderBy: { lastSeenAt: "desc" }, take: 500,
          select: { startsAt: true, availableSpots: true, holes: true, priceCents: true,
            bookingUrl: true, lastConfirmedAt: true, lastSeenAt: true, unavailableAt: true, availabilityStatus: true }
        }
      }
    });
    // Explicit projection: no saved-search, owner, recipient, or delivery information.
    return NextResponse.json({ courses: Object.fromEntries(courses.map((course) => [
      // A truncated history cannot establish which observation is newest for every slot.
      course.id, course.matches.length === 500 ? [] : selectKnownCourseTimes(course.matches, course.probes?.[0]?.rawSummary, course.timeZone, input.data.date, now)
    ])) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Previously checked times are temporarily unavailable." }, { status: 503 });
  }
}
