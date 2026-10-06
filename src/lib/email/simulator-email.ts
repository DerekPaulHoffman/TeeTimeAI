import {
  renderCustomerEmail,
  type CustomerEmailAvailabilityCourse,
  type CustomerEmailMonitoringCourse,
  type CustomerEmailStopUrls
} from "@/lib/email/customer-email";
import type { EmailStopUrls } from "@/lib/email/search-actions";
import { DEFAULT_TIME_ZONE, normalizeTimeZone } from "@/lib/timezones";

type SimulatorMatch = {
  offeringId?: string;
  courseId?: string;
  courseName: string;
  courseRank?: number;
  courseAddress?: string;
  courseTimeZone?: string;
  startsAt: Date;
  endsAt?: Date | null;
  bookingUrl: string;
  capacity?: number;
  isNew?: boolean;
};

function uniqueDisplaySessions(matches: SimulatorMatch[]) {
  const sessions = new Map<string, SimulatorMatch>();
  for (const match of matches) {
    const key = [match.offeringId ?? match.courseId ?? match.courseName, match.startsAt.toISOString(),
      match.endsAt?.toISOString() ?? "", match.bookingUrl].join("\u0000");
    const existing = sessions.get(key);
    sessions.set(key, existing
      ? { ...existing, isNew: existing.isNew === true || match.isNew === true }
      : match);
  }
  return [...sessions.values()].sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
}

export type SimulatorEmailInput = {
  matches: SimulatorMatch[];
  durationMinutes: number;
  players?: number;
  targetDate?: string;
  startTime?: string;
  endTime?: string;
  userTimeZone?: string;
  checkedAt?: Date;
  assetBaseUrl?: string;
  stopUrls?: EmailStopUrls;
  /** Legacy cancellation URL; current callers should pass both bounded stop URLs. */
  stopUrl?: string;
};

export function getSimulatorAlertSubject(matches: SimulatorMatch[]) {
  const unique = uniqueDisplaySessions(matches);
  return unique.length === 1
    ? `A simulator session opened at ${unique[0].courseName}`
    : "Simulator sessions match your Tee Time Spot alert";
}

export function renderSimulatorAlertHtml(input: SimulatorEmailInput) {
  const durationMinutes = normalizeDuration(input.durationMinutes);
  const sessions = uniqueDisplaySessions(input.matches.map((match) => ({
    ...match,
    endsAt: match.endsAt ?? new Date(match.startsAt.getTime() + durationMinutes * 60_000)
  })));
  const groups = new Map<string, typeof sessions>();
  for (const match of sessions) {
    const key = match.offeringId ?? match.courseId ?? `${match.courseRank ?? "x"}:${match.courseName}`;
    const group = groups.get(key) ?? [];
    group.push(match);
    groups.set(key, group);
  }
  const availabilityCourses: CustomerEmailAvailabilityCourse[] = [...groups.entries()]
    .map(([courseId, matches], index) => {
      const first = matches[0];
      return {
        courseId,
        courseName: first.courseName,
        rank: first.courseRank ?? index + 1,
        courseAddress: first.courseAddress,
        courseTimeZone: first.courseTimeZone,
        bookingUrl: first.bookingUrl,
        times: matches.map((match) => ({
          startsAt: match.startsAt,
          endsAt: match.endsAt,
          availableSpots: 1,
          isNew: match.isNew === true
        }))
      };
    });
  const first = sessions[0];
  const last = sessions.at(-1);
  const timeZone = normalizeTimeZone(first?.courseTimeZone, DEFAULT_TIME_ZONE);
  const venueCount = availabilityCourses.length;
  return renderCustomerEmail({
    mode: "SIMULATOR",
    variant: "instant",
    heading: sessions.length === 1 ? "A simulator session just opened!" : "New simulator sessions just opened!",
    intro: sessions.length === 1
      ? "We found a simulator session matching your search. Open the venue's official booking page before it's gone. You book direct with the venue."
      : venueCount === 1
        ? "We found simulator sessions matching your search. Open the venue's official booking page before they're gone. You book direct with the venue."
      : `We found matching simulator sessions across ${venueCount} venues. Open their official booking pages to see current availability. You book direct with the venue.`,
    preheader: "A new simulator session matches your Tee Time Spot search.",
    summary: {
      targetDate: input.targetDate ?? (first ? dateKey(first.startsAt, timeZone) : "1970-01-01"),
      startTime: input.startTime ?? (first ? clockTime(first.startsAt, timeZone) : "00:00"),
      endTime: input.endTime ?? (last?.endsAt ? clockTime(last.endsAt, timeZone) : "00:00"),
      durationMinutes,
      players: input.players ?? 1
    },
    availabilityCourses,
    checkedAt: input.checkedAt,
    userTimeZone: input.userTimeZone,
    stopUrls: resolveStopUrls(input),
    assetBaseUrl: input.assetBaseUrl
  });
}

export type SimulatorStatusInput = {
  kind: "setup" | "daily";
  targetDate: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  players: number;
  userTimeZone?: string;
  checkedAt?: Date;
  assetBaseUrl?: string;
  venues: Array<{
    courseId?: string;
    courseName: string;
    courseRank?: number;
    courseAddress?: string;
    courseTimeZone?: string;
    bookingUrl: string;
    availability: string;
  }>;
  stopUrls?: EmailStopUrls;
  /** Legacy cancellation URL; current callers should pass both bounded stop URLs. */
  stopUrl?: string;
};

export function renderSimulatorStatusHtml(input: SimulatorStatusInput) {
  const durationMinutes = normalizeDuration(input.durationMinutes);
  const monitoringCourses: CustomerEmailMonitoringCourse[] = input.venues.map((venue, index) => ({
    courseName: venue.courseName,
    rank: venue.courseRank ?? index + 1,
    courseAddress: venue.courseAddress,
    bookingUrl: venue.bookingUrl,
    bookingLinkLabel: "Open official booking page",
    ...monitoringStatus(venue.availability)
  }));
  return renderCustomerEmail({
    mode: "SIMULATOR",
    variant: input.kind === "setup" ? "setup" : "morning",
    heading: input.kind === "setup" ? "Your simulator alert is saved" : "Your simulator alert update",
    intro: `We are watching for a ${durationMinutes}-minute simulator session in your requested window. When an opening matches, we will send its official booking link. You book direct with the venue.`,
    preheader: input.kind === "setup"
      ? "Your simulator alert is saved. Here's the status of each venue."
      : "Here's the latest status of your Tee Time Spot simulator alert.",
    summary: {
      targetDate: input.targetDate,
      startTime: input.startTime,
      endTime: input.endTime,
      durationMinutes,
      players: input.players
    },
    availabilityCourses: [],
    monitoringCourses,
    checkedAt: input.checkedAt,
    userTimeZone: input.userTimeZone,
    stopUrls: resolveStopUrls(input),
    assetBaseUrl: input.assetBaseUrl
  });
}

function monitoringStatus(availability: string): Pick<CustomerEmailMonitoringCourse, "badgeLabel" | "detail" | "tone"> {
  if (availability === "BOOKING_NOT_OPEN") {
    return { badgeLabel: "BOOKING NOT OPEN", tone: "scheduled", detail: "Booking has not opened yet. We will check when sessions are released." };
  }
  if (availability === "NO_MATCH") {
    return { badgeLabel: "CHECKED", tone: "monitored", detail: "No matching session is available right now. We will keep checking your requested window." };
  }
  if (availability === "UNAVAILABLE") {
    return { badgeLabel: "CHECKS RETRYING", tone: "retrying", detail: "We could not verify current sessions yet. We will retry; you can also check the venue's official booking page." };
  }
  if (availability === "VERIFIED" || availability === "MATCH_FOUND") {
    return { badgeLabel: "CHECKED", tone: "monitored", detail: "Current sessions were verified on the official booking page. Matching openings are included in your session alert." };
  }
  return { badgeLabel: "CHECKING SESSIONS", tone: "adding", detail: "We are checking current sessions. We have not verified availability for your requested window yet." };
}

function resolveStopUrls(input: { stopUrls?: EmailStopUrls; stopUrl?: string }): CustomerEmailStopUrls | undefined {
  return input.stopUrls ?? (input.stopUrl ? { cancelled: input.stopUrl } : undefined);
}

function normalizeDuration(value: number) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error("Simulator email needs a valid session duration");
  }
  return value;
}

function dateKey(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function clockTime(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("hour")}:${values.get("minute")}`;
}
