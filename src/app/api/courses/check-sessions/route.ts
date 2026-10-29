import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hasDatabaseConfig } from "@/lib/env";
import { isSimulatorModeEnabled } from "@/lib/simulators/config";
import { getSimulatorBookingOpening } from "@/lib/simulators/booking-window";
import { getSimulatorOfferingSourceFingerprint } from "@/lib/simulators/source-fingerprint";
import { fetchSimulatorAvailability, RUNNABLE_SIMULATOR_PROVIDER_FAMILIES } from "@/lib/simulators/providers";
import { simulatorDurationsForSearch } from "@/lib/searches/simulator-duration";
import { filterVisibleSimulatorSessions, type PublicSimulatorSession } from "@/lib/simulators/public-sessions";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { getSafeOfficialBookingUrl } from "@/lib/email/search-delivery-outbox";

export const maxDuration = 60;
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const inputSchema = z.object({
  offeringId: z.string().min(1).max(100), date: z.iso.date(),
  startTime: clock, endTime: z.union([clock, z.literal("24:00")]),
  durationMinutes: z.coerce.number().int().min(30).max(480).multipleOf(15).optional(),
}).refine(input => input.endTime > input.startTime);
const reply = (status: string, sessions: PublicSimulatorSession[] = []) =>
  NextResponse.json({ status, times: [], sessions }, { headers: { "Cache-Control": "no-store" } });

// Browsing uses public rental readers only: no demand, jobs, workflows, or email.
export async function GET(request: NextRequest) {
  const input = inputSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!input.success) return NextResponse.json({ error: "Choose a venue, date, and session window." }, { status: 400 });
  if (!isSimulatorModeEnabled()) return reply("UNAVAILABLE");
  const { offeringId, date, startTime, endTime } = input.data;
  const durationMinutes = input.data.durationMinutes ?? null;
  const day = Date.parse(`${date}T00:00:00Z`);
  if (day < Date.now() - 86400000 || day > Date.now() + 90 * 86400000) return reply("UNAVAILABLE");
  if (!hasDatabaseConfig()) return reply("FAILED");
  try {
    const load = () => prisma.courseOffering.findUnique({ where: { id: offeringId }, include: { course: { select: { timeZone: true } } } });
    const offering = await load();
    const eligible = (row: typeof offering) => row && row.kind === "SIMULATOR" && row.active &&
      row.publicAccessStatus === "PUBLIC" && row.verifiedAt && row.verifiedAt <= new Date() &&
      row.evidenceUrl && row.bookingUrl && row.automationEligibility === "ALLOWED" &&
      row.monitoringMode !== "LOCAL_READER_ONLY" &&
      row.monitoringState !== "FINAL_TECHNICAL" && row.monitoringState !== "FINAL_IDENTITY";
    if (!offering || !eligible(offering) ||
      !RUNNABLE_SIMULATOR_PROVIDER_FAMILIES.some(family => family === offering.providerFamilyKey)) return reply("UNAVAILABLE");
    if (offering.observationToken) return reply("BUSY");
    const bookingUrl = getSafeOfficialBookingUrl(offering.bookingUrl!);
    if (!bookingUrl) return reply("UNAVAILABLE");
    const opening = getSimulatorBookingOpening(date, offering, offering.course.timeZone);
    if (opening && opening > new Date()) return reply("NOT_OPEN");
    const durations = simulatorDurationsForSearch(durationMinutes, offering.supportedDurationsMinutes, startTime, endTime);
    // Unsupported intent cannot establish an empty calendar.
    if (!durations.length) return reply("UNSUPPORTED_DURATION");
    const fingerprint = getSimulatorOfferingSourceFingerprint(offering);
    const deadline = Date.now() + 45_000;
    const boundedFetch: typeof fetch = (url, init) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Public session check timed out");
      return fetch(url, { ...init, signal: AbortSignal.any([
        request.signal, AbortSignal.timeout(Math.min(remaining, 15_000)), ...(init?.signal ? [init.signal] : []),
      ]) });
    };
    const read = await runWithProviderRequestLease(new URL(bookingUrl).hostname, async () => {
      const sessions: PublicSimulatorSession[] = [];
      for (const duration of durations) {
        const result = await fetchSimulatorAvailability({ offering: { ...offering, bookingUrl },
          date, durationMinutes: duration, partySize: 1, timeZone: offering.course.timeZone }, boundedFetch);
        if (!result.complete || !Number.isFinite(result.observedAt.getTime()) || result.observedAt > new Date() ||
          Date.now() - result.observedAt.getTime() > 30 * 60_000) throw new Error("Incomplete public session check");
        for (const slot of result.slots) {
          if (slot.offeringId !== offeringId || !slot.resourceId || !slot.sourceId ||
            slot.bookingUrl !== bookingUrl || !offering.supportedDurationsMinutes.includes((slot.endsAt.getTime() - slot.startsAt.getTime()) / 60_000) ||
            (slot.endsAt.getTime() - slot.startsAt.getTime()) / 60_000 !== duration) throw new Error("Invalid public session proof");
          if (slot.startsAt > new Date()) sessions.push({ startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString(),
            bookingUrl, confirmedAt: result.observedAt.toISOString() });
        }
      }
      return sessions;
    });
    if (!read.acquired) return reply("BUSY");
    const current = await load();
    if (!eligible(current) || !current || current.observationToken ||
      fingerprint !== getSimulatorOfferingSourceFingerprint(current) || current.course.timeZone !== offering.course.timeZone) return reply("UNAVAILABLE");
    const visible = filterVisibleSimulatorSessions(read.value, offering.course.timeZone, date, startTime, endTime, durationMinutes);
    const unique = new Map(visible.map(session => [`${session.startsAt}|${session.endsAt}`, session]));
    return reply("CHECKED", [...unique.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.endsAt.localeCompare(b.endsAt)));
  } catch { return reply("FAILED"); }
}
