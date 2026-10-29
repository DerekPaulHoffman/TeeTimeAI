import { parseCourseLocalDateTime } from "@/lib/tee-times/matching";
import { parseCourseLocalWindowEnd } from "@/lib/searches/window-end";
import { simulatorDurationMatches } from "@/lib/searches/simulator-duration";

/** Public projection: no saved-search, recipient, resource or provider configuration. */
export type PublicSimulatorSession = {
  startsAt: string;
  endsAt: string;
  bookingUrl: string;
  confirmedAt: string;
};

export function filterVisibleSimulatorSessions(sessions: PublicSimulatorSession[], timeZone: string,
  date: string, startTime: string, endTime: string, durationMinutes: number | null) {
  const start = parseCourseLocalDateTime(`${date}T${startTime}`, timeZone).getTime();
  const end = parseCourseLocalWindowEnd(date, endTime, timeZone).getTime();
  return sessions.filter(session => {
    const begins = Date.parse(session.startsAt), finishes = Date.parse(session.endsAt);
    return begins >= start && finishes <= end &&
      simulatorDurationMatches(durationMinutes, (finishes - begins) / 60_000);
  });
}
