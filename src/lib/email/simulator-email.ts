import { normalizeTimeZone } from "@/lib/timezones";

type SimulatorMatch = {
  offeringId?: string;
  courseName: string;
  courseTimeZone?: string;
  startsAt: Date;
  endsAt?: Date | null;
  bookingUrl: string;
  capacity?: number;
};

function uniqueDisplaySessions(matches: SimulatorMatch[]) {
  const sessions = new Map<string, SimulatorMatch>();
  for (const match of matches) {
    const key = [match.offeringId ?? match.courseName, match.startsAt.toISOString(),
      match.endsAt?.toISOString() ?? "", match.bookingUrl].join("\u0000");
    if (!sessions.has(key)) sessions.set(key, match);
  }
  return [...sessions.values()];
}

export type SimulatorEmailInput = {
  matches: SimulatorMatch[];
  durationMinutes: number;
  players?: number;
  targetDate?: string;
  startTime?: string;
  endTime?: string;
  userTimeZone?: string;
  stopUrl?: string;
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function localDateTime(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeTimeZone(timeZone), dateStyle: "medium", timeStyle: "short",
  }).format(date);
}

export function getSimulatorAlertSubject(matches: SimulatorMatch[]) {
  const unique = uniqueDisplaySessions(matches);
  return unique.length === 1
    ? `A simulator session opened at ${unique[0].courseName}`
    : "Simulator sessions match your Tee Time Spot alert";
}

export function renderSimulatorAlertHtml(input: SimulatorEmailInput) {
  const unique = uniqueDisplaySessions(input.matches);
  const sessions = unique.slice(0, 20).map((match) => {
    const zone = normalizeTimeZone(match.courseTimeZone);
    const end = match.endsAt ?? new Date(match.startsAt.getTime() + input.durationMinutes * 60_000);
    const userZone = input.userTimeZone ? normalizeTimeZone(input.userTimeZone) : zone;
    const userTime = userZone === zone ? "" : `Your time: ${escapeHtml(localDateTime(match.startsAt, userZone))}–${escapeHtml(localDateTime(end, userZone))} (${escapeHtml(userZone)})<br>`;
    return `<li style="margin:0 0 20px"><strong>${escapeHtml(match.courseName)}</strong><br>` +
      `${escapeHtml(localDateTime(match.startsAt, zone))}–${escapeHtml(localDateTime(end, zone))} (${escapeHtml(zone)})<br>` +
      userTime +
      `${input.durationMinutes} minutes · one simulator bay<br>` +
      `<a href="${escapeHtml(match.bookingUrl)}">Open the official booking page</a></li>`;
  }).join("");
  return `<!doctype html><html lang="en"><body style="font:16px Arial,sans-serif;color:#123124;max-width:620px;margin:auto;padding:28px">` +
    `<h1>Simulator time opened</h1><p>A session matches your alert. Availability can change; you book direct with the venue on its official site.</p>` +
    `<ul style="padding-left:22px">${sessions}</ul>` +
    (unique.length > 20 ? `<p>And ${unique.length - 20} more matching session times. Open an official booking page above to see current availability.</p>` : "") +
    `<p>Requested: ${escapeHtml(input.targetDate ?? "your date")}, ${escapeHtml(input.startTime ?? "")}–${escapeHtml(input.endTime ?? "")}. Confirm your group's fit with the venue before booking.</p>` +
    (input.stopUrl ? `<p><a href="${escapeHtml(input.stopUrl)}">Stop this alert</a></p>` : "") +
    `</body></html>`;
}

export type SimulatorStatusInput = {
  kind: "setup" | "daily";
  targetDate: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  players: number;
  venues: Array<{ courseName: string; bookingUrl: string; availability: string }>;
  stopUrl?: string;
};

export function renderSimulatorStatusHtml(input: SimulatorStatusInput) {
  const rows = input.venues.map((venue) => {
    const line = venue.availability === "BOOKING_NOT_OPEN"
      ? "Booking has not opened yet."
      : venue.availability === "NO_MATCH"
        ? "No matching session is available right now."
        : venue.availability === "UNAVAILABLE"
          ? "We could not verify current sessions yet."
          : "We are checking current sessions.";
    return `<li><strong>${escapeHtml(venue.courseName)}</strong>: ${line} ` +
      `<a href="${escapeHtml(venue.bookingUrl)}">Official booking page</a></li>`;
  }).join("");
  return `<!doctype html><html lang="en"><body style="font:16px Arial,sans-serif;color:#123124;max-width:620px;margin:auto;padding:28px">` +
    `<h1>${input.kind === "setup" ? "Your simulator alert is saved" : "Your simulator alert update"}</h1>` +
    `<p>We are watching for a ${input.durationMinutes}-minute simulator session on ${escapeHtml(input.targetDate)} between ${escapeHtml(input.startTime)} and ${escapeHtml(input.endTime)}. Confirm your group's fit with the venue before booking.</p>` +
    `<ul>${rows}</ul><p>When an opening matches, we will send its official booking link. You book direct with the venue.</p>` +
    (input.stopUrl ? `<p><a href="${escapeHtml(input.stopUrl)}">Stop this alert</a></p>` : "") +
    `</body></html>`;
}
