import type { BookingMethod } from "@/lib/courses/intelligence";
import type { EmailStopUrls } from "@/lib/email/search-actions";
import {
  DEFAULT_TIME_ZONE,
  normalizeTimeZone,
  zonedDateTimeToDate
} from "@/lib/timezones";

export type SearchStatusEmailKind = "setup" | "weekly";

export type SearchStatusAvailability = {
  visibleSlotCount: number;
  playerEligibleSlotCount: number;
  closestBefore?: string;
  closestAfter?: string;
};

export type SearchStatusCourseReport = {
  courseId: string;
  courseName: string;
  timeZone?: string;
  outcome: "MATCH_FOUND" | "NO_MATCH" | "BLOCKED_POLICY" | "NEEDS_ADAPTER" | "FETCH_FAILED";
  availableMatches: number;
  message?: string;
  bookingUrl?: string;
  phone?: string;
  bookingMethod?: BookingMethod;
  supportStatus?: "TEAM_ALERTED" | "PENDING_ALERT";
  bookingAccess?:
    | "BOOKING_PAGE"
    | "OFFICIAL_SITE"
    | "PHONE_ONLY"
    | "CONTACT_COURSE"
    | "WALK_IN";
  availability?: SearchStatusAvailability;
  bookingWindow?: {
    releaseDate: string;
    releaseTimeLocal?: string;
    opensAt: string;
    timeZone: string;
    exactTime: boolean;
  };
  matchingTimes?: Array<{
    startsAt: string;
    availableSpots: number;
    priceCents?: number;
    holes?: number;
  }>;
};

export type SearchStatusSnapshot = Array<{
  courseId: string;
  courseName: string;
  state: string;
}>;

export type SearchStatusEmailInput = {
  searchId: string;
  to: string;
  kind: SearchStatusEmailKind;
  targetDate: string;
  startTime: string;
  endTime: string;
  players: number;
  requestedLayoutHoles?: 9 | 18 | null;
  userTimeZone?: string;
  checkedAt: Date;
  courses: SearchStatusCourseReport[];
  previousSnapshot?: unknown;
  idempotencyKey?: string;
  stopUrls?: EmailStopUrls;
};

export const MORNING_STATUS_EMAIL_HOUR = 8;
export const WEEKLY_STATUS_EMAIL_INTERVAL_DAYS = 7;

export function summarizeSearchStatusAvailability(
  search: {
    date: string;
    startTime: string;
    endTime: string;
    players: number;
  },
  slots: Array<{ startsAt: string; availableSpots: number }>
): SearchStatusAvailability {
  const dateSlots = slots.filter((slot) => slot.startsAt.slice(0, 10) === search.date);
  const eligibleSlots = dateSlots
    .filter((slot) => slot.availableSpots >= search.players)
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  const before = eligibleSlots
    .filter((slot) => slot.startsAt.slice(11, 16) < search.startTime)
    .at(-1);
  const after = eligibleSlots.find(
    (slot) => slot.startsAt.slice(11, 16) >= search.endTime
  );

  return {
    visibleSlotCount: dateSlots.length,
    playerEligibleSlotCount: eligibleSlots.length,
    closestBefore: before?.startsAt,
    closestAfter: after?.startsAt
  };
}

export function getSearchStatusEmailKind(
  lastSentAt: Date | null,
  now = new Date(),
  timeZone = DEFAULT_TIME_ZONE
): SearchStatusEmailKind | null {
  if (!lastSentAt) {
    return "setup";
  }

  const normalizedTimeZone = normalizeTimeZone(timeZone, DEFAULT_TIME_ZONE);
  const currentLocalTime = getLocalDateAndHour(now, normalizedTimeZone);
  const lastSentLocalTime = getLocalDateAndHour(lastSentAt, normalizedTimeZone);

  if (currentLocalTime.hour < MORNING_STATUS_EMAIL_HOUR) {
    return null;
  }

  const localDaysSinceLastEmail = Math.floor(
    (Date.parse(`${currentLocalTime.date}T00:00:00Z`) -
      Date.parse(`${lastSentLocalTime.date}T00:00:00Z`)) /
      (24 * 60 * 60 * 1000)
  );
  return localDaysSinceLastEmail >= WEEKLY_STATUS_EMAIL_INTERVAL_DAYS ? "weekly" : null;
}

export function buildSearchStatusSnapshot(
  courses: SearchStatusCourseReport[]
): SearchStatusSnapshot {
  return courses.map((course) => ({
    courseId: course.courseId,
    courseName: course.courseName,
    state: getCourseState(course)
  }));
}

export function getChangedCourseNames(
  current: SearchStatusSnapshot,
  previous: unknown
) {
  const previousSnapshot = parseSearchStatusSnapshot(previous);
  if (!previousSnapshot) {
    return current.map((course) => course.courseName);
  }

  const previousStateByCourse = new Map(
    previousSnapshot.map((course) => [course.courseId, course.state])
  );
  return current
    .filter((course) => previousStateByCourse.get(course.courseId) !== course.state)
    .map((course) => course.courseName);
}

export function renderSearchStatusHtml(input: SearchStatusEmailInput) {
  const currentSnapshot = buildSearchStatusSnapshot(input.courses);
  const changedCourses = getChangedCourseNames(currentSnapshot, input.previousSnapshot);
  const targetDate = formatDate(input.targetDate);
  const window = `${formatTime(input.startTime)}–${formatTime(input.endTime)} course local`;
  const courseLayout = input.requestedLayoutHoles
    ? `${input.requestedLayoutHoles}-hole`
    : "Any layout";
  const checkedAt = input.checkedAt.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: normalizeTimeZone(input.userTimeZone, DEFAULT_TIME_ZONE),
    timeZoneName: "short"
  });
  const heading = input.kind === "setup" ? "Your tee-time alert is active" : "Your weekly tee-time update";
  const badge = input.kind === "setup" ? "Search is active" : "Weekly update";
  const hasDirectOnlyCourse = input.courses.some(
    (course) => course.outcome === "BLOCKED_POLICY"
  );
  const hasWorkInProgressCourse = input.courses.some(
    (course) => course.outcome === "NEEDS_ADAPTER"
  );
  const intro =
    input.kind === "setup"
      ? hasDirectOnlyCourse
        ? "Your alert is set. We’ll keep checking supported courses; courses marked Official site only or Phone only are not automatically monitored."
        : hasWorkInProgressCourse
          ? "Your alert is set. We checked every selected course. Use the official link for courses marked Official site while we continue watching the courses we can monitor automatically."
        : "Your alert is set. We checked every selected course and will keep watching automatically."
      : changedCourses.length > 0
        ? `Changed since your last email: ${changedCourses.join(", ")}.`
        : hasDirectOnlyCourse
          ? "No course status changed since your last email. We’re still checking supported courses."
          : "No course status changed since your last email. We’re still checking.";
  const courseRows = input.courses
    .map((course, index) => renderCourseReport(course, input.players, index + 1))
    .join("");
  const stopControls = renderEmailStopControls(input.stopUrls);

  return `
    <div style="background:#f4efe5;padding:24px;font-family:Inter,Arial,sans-serif;color:#14231d;line-height:1.5">
      <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #d9e3dc;border-radius:12px;overflow:hidden">
        <div style="background:#111d18;color:#ffffff;padding:18px 22px">
          <div style="font-weight:800;font-size:18px">Tee Time Spot</div>
          <div style="color:rgba(255,255,255,.68);font-size:13px">teetimespot.com</div>
        </div>
        <div style="background:#19372b;color:#ffffff;padding:30px 22px">
          <div style="display:inline-block;background:#e28a2f;color:#1d1309;border-radius:999px;padding:7px 11px;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase">${badge}</div>
          <h1 style="font-size:29px;line-height:1.1;margin:16px 0 10px">${heading}</h1>
          <p style="margin:0;color:rgba(255,255,255,.82)">${escapeHtml(intro)}</p>
        </div>
        <div style="padding:22px">
          <table role="presentation" style="width:100%;border-collapse:collapse;table-layout:fixed;margin-bottom:20px">
            <tr>
              <td style="width:50%;background:#f5f7f2;border-radius:8px;padding:12px;vertical-align:top">
                <div style="font-size:11px;font-weight:800;text-transform:uppercase;color:#5c6c64">Date</div>
                <div style="font-weight:800">${escapeHtml(targetDate)}</div>
              </td>
              <td style="width:8px"></td>
              <td style="width:50%;background:#f5f7f2;border-radius:8px;padding:12px;vertical-align:top">
                <div style="font-size:11px;font-weight:800;text-transform:uppercase;color:#5c6c64">Window</div>
                <div style="font-weight:800">${escapeHtml(window)}</div>
              </td>
            </tr>
            <tr>
              <td colspan="3" style="height:8px;font-size:0;line-height:0">&nbsp;</td>
            </tr>
            <tr>
              <td style="width:50%;background:#f5f7f2;border-radius:8px;padding:12px;vertical-align:top">
                <div style="font-size:11px;font-weight:800;text-transform:uppercase;color:#5c6c64">Course layout</div>
                <div style="font-weight:800">${escapeHtml(courseLayout)}</div>
              </td>
              <td style="width:8px"></td>
              <td style="width:50%;background:#f5f7f2;border-radius:8px;padding:12px;vertical-align:top">
                <div style="font-size:11px;font-weight:800;text-transform:uppercase;color:#5c6c64">Golfers</div>
                <div style="font-weight:800">${input.players}</div>
              </td>
            </tr>
          </table>
          <h2 style="font-size:20px;line-height:1.2;margin:0 0 5px">What we’re watching for you</h2>
          <p style="color:#53645c;font-size:14px;margin:0 0 18px">Here’s what we found at each course. We’ll keep watching supported courses and always link you to the official booking surface.</p>
          ${courseRows}
          <div style="background:#e6f3f7;border-radius:10px;color:#174152;padding:14px 16px;font-size:14px;margin-top:18px">
            We only send an instant email when a newly opened tee time matches your exact date, time window, and player count. Otherwise, you’ll receive at most one morning status update per day.
          </div>
          <p style="color:#5c6c64;font-size:13px;margin:16px 0 0">Last checked ${escapeHtml(checkedAt)}.</p>
          ${stopControls}
        </div>
        <div style="background:#111d18;color:rgba(255,255,255,.72);padding:18px 22px;font-size:13px">
          Tee Time Spot sends you to the course’s official booking page. We never book, hold, or pay for tee times.
        </div>
      </div>
    </div>
  `;
}

function getLocalDateAndHour(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year") ?? "0000";
  const month = values.get("month") ?? "00";
  const day = values.get("day") ?? "00";
  const hour = Number(values.get("hour") ?? "0");

  return {
    date: `${year}-${month}-${day}`,
    hour: hour === 24 ? 0 : hour
  };
}

function renderCourseReport(course: SearchStatusCourseReport, players: number, rank: number) {
  const description = describeCourse(course, players);
  const timeZone = normalizeTimeZone(course.timeZone, DEFAULT_TIME_ZONE);
  const matchingTimes = renderMatchingTimes(course.matchingTimes, timeZone);
  const bookingAccess = getBookingAccess(course);
  const bookingLinkLabel = bookingAccess === "BOOKING_PAGE"
    ? "Open official booking page"
    : "Open official site";
  const bookingLink = course.bookingUrl
    ? `<a href="${escapeHtml(course.bookingUrl)}" style="color:#087746;display:inline-block;font-size:14px;font-weight:800;margin:0 18px 0 0;text-decoration:none">${bookingLinkLabel} →</a>`
    : "";
  const phoneHref = course.phone ? formatTelephoneHref(course.phone) : "";
  const phoneLink = phoneHref
    ? `<a href="${escapeHtml(phoneHref)}" style="color:#087746;display:inline-block;font-size:14px;font-weight:800;margin:0;text-decoration:none">Call ${escapeHtml(course.phone ?? "the course")} →</a>`
    : "";
  const actions = bookingLink || phoneLink
    ? `<p style="margin:18px 0 0">${bookingLink}${phoneLink}</p>`
    : "";

  return `
    <div style="background:#fbfaf4;border:1px solid ${description.borderColor};border-left:4px solid ${description.color};border-radius:14px;padding:17px 17px 18px;margin-bottom:12px">
      <p style="margin:0 0 9px"><span style="background:${description.badgeBackground};border-radius:999px;color:${description.color};display:inline-block;font-size:10px;font-weight:800;letter-spacing:.08em;padding:5px 8px;text-transform:uppercase">Priority ${rank} · ${escapeHtml(description.monitoringLabel)}</span></p>
      <p style="color:#10231b;font-size:16px;font-weight:800;margin:0 0 3px">${escapeHtml(course.courseName)}</p>
      <p style="color:#829087;font-size:12px;margin:0 0 11px">Times use the course timezone: ${escapeHtml(timeZone)}</p>
      <div style="background:${description.calloutBackground};border:1px solid ${description.calloutBorder};border-radius:10px;color:${description.calloutText};font-size:14px;line-height:1.45;padding:11px 13px">
        <strong>${description.icon} ${escapeHtml(description.stateLabel)}.</strong> ${escapeHtml(description.detail)}
      </div>
      ${matchingTimes}
      ${actions}
    </div>
  `;
}

function describeCourse(course: SearchStatusCourseReport, players: number) {
  if (course.outcome === "MATCH_FOUND") {
    return {
      monitoringLabel: "Fully monitored ✓",
      stateLabel: "Matching time visible",
      icon: "✓",
      color: "#147a52",
      badgeBackground: "#e8f4ec",
      borderColor: "#b8ddc8",
      calloutBackground: "#eef8f1",
      calloutBorder: "#c6e5d2",
      calloutText: "#285c43",
      detail: `${course.availableMatches} tee time${course.availableMatches === 1 ? " matches" : "s match"} your search right now.`
    };
  }

  if (course.outcome === "NO_MATCH" && course.bookingWindow) {
    const release = formatBookingWindowRelease(course.bookingWindow);
    return {
      monitoringLabel: "Scheduled",
      stateLabel: course.bookingWindow.exactTime
        ? `Booking opens ${release}`
        : `Booking expected to open ${release}`,
      icon: "◷",
      color: "#17647a",
      badgeBackground: "#e6f3f7",
      borderColor: "#b8dbe5",
      calloutBackground: "#eef8fb",
      calloutBorder: "#c5e2ea",
      calloutText: "#174152",
      detail: course.bookingWindow.exactTime
        ? "The course has not released tee times for your date yet. We’ll start checking at that time and email you when a matching spot appears."
        : "The course has not published an exact release time. We’ll begin checking that day and email you when a matching spot appears."
    };
  }

  if (course.outcome === "NEEDS_ADAPTER") {
    return {
      monitoringLabel: "Official site",
      stateLabel: "Check this course directly for now",
      icon: "↗",
      color: "#c75c0a",
      badgeBackground: "#fff0e4",
      borderColor: "#f1c79e",
      calloutBackground: "#fff8f2",
      calloutBorder: "#f3cfad",
      calloutText: "#713706",
      detail: course.bookingUrl
        ? "We checked this course’s official booking surface. Live availability is not currently available inside Tee Time Spot, so use the official link while we keep working to add monitoring."
        : course.phone
          ? "We checked this course’s public booking information. Call the course directly while we keep working to add monitoring."
          : "We checked the public course information, but no direct availability source was available."
    };
  }

  if (course.outcome === "FETCH_FAILED") {
    return {
      monitoringLabel: "Official site · retry scheduled",
      stateLabel: "Latest check incomplete",
      icon: "↻",
      color: "#a23a32",
      badgeBackground: "#fbeae7",
      borderColor: "#ecc4bf",
      calloutBackground: "#fff5f3",
      calloutBorder: "#efc9c4",
      calloutText: "#7f302a",
      detail: "This course’s latest availability check did not finish. We’ll retry automatically; its official page is available in the meantime."
    };
  }

  if (course.outcome === "BLOCKED_POLICY") {
    const bookingAccess = getBookingAccess(course);
    const monitoringLabel = bookingAccess === "PHONE_ONLY"
      ? "Phone only"
      : bookingAccess === "CONTACT_COURSE"
        ? "Contact course"
        : bookingAccess === "WALK_IN"
          ? "Walk-in only"
          : "Official site only";
    const detail = bookingAccess === "PHONE_ONLY"
      ? "We can’t automatically monitor this course. Call the course to check availability and book directly."
      : bookingAccess === "CONTACT_COURSE"
        ? "We can’t automatically monitor this course. Contact the course directly to check availability and book."
        : bookingAccess === "WALK_IN"
          ? "We can’t automatically monitor this course. Check with the course in person for availability and booking."
          : `We can’t automatically monitor this course and won’t bypass its restrictions. Check the official site${course.phone ? " or call the course" : ""} to book directly.`;
    return {
      monitoringLabel,
      stateLabel: "Direct booking required",
      icon: "⚠",
      color: "#b66500",
      badgeBackground: "#fff0d6",
      borderColor: "#e8c987",
      calloutBackground: "#fff9eb",
      calloutBorder: "#edd39a",
      calloutText: "#734500",
      detail
    };
  }

  const availability = course.availability;
  if (!availability || availability.visibleSlotCount === 0) {
    return {
      ...fullyMonitoredDescription("Nothing visible for this date yet"),
      detail: "The course returned no public times for this date. Its booking window may not be open yet, or the visible inventory may currently be full. We’ll keep checking."
    };
  }

  if (availability.playerEligibleSlotCount === 0) {
    return {
      ...fullyMonitoredDescription("Not enough open spots"),
      detail: `Times are visible, but none currently have room for ${players} player${players === 1 ? "" : "s"}.`
    };
  }

  const timeZone = normalizeTimeZone(course.timeZone, DEFAULT_TIME_ZONE);
  const before = availability.closestBefore
    ? formatStartsAtTime(availability.closestBefore, timeZone)
    : null;
  const after = availability.closestAfter
    ? formatStartsAtTime(availability.closestAfter, timeZone)
    : null;
  const closest =
    before && after
      ? `The closest visible times are ${before} before your window and ${after} after it.`
      : before
        ? `The closest visible time is ${before}, before your window.`
        : after
          ? `The closest visible time is ${after}, after your window.`
          : "Times are visible, but none match your exact window.";

  return {
    ...fullyMonitoredDescription("No time in your window"),
    detail: closest
  };
}

function fullyMonitoredDescription(stateLabel: string) {
  return {
    monitoringLabel: "Fully monitored ✓",
    stateLabel,
    icon: "✓",
    color: "#147a52",
    badgeBackground: "#e8f4ec",
    borderColor: "#b8ddc8",
    calloutBackground: "#eef8f1",
    calloutBorder: "#c6e5d2",
    calloutText: "#285c43"
  };
}

function getBookingAccess(course: SearchStatusCourseReport) {
  if (course.bookingMethod === "PHONE_ONLY") {
    return "PHONE_ONLY";
  }
  if (course.bookingMethod === "CONTACT_COURSE") {
    return "CONTACT_COURSE";
  }
  if (course.bookingMethod === "WALK_IN") {
    return "WALK_IN";
  }
  if (
    course.bookingMethod === "PUBLIC_ONLINE" ||
    course.bookingMethod === "ONLINE_OR_PHONE"
  ) {
    return course.bookingUrl ? "BOOKING_PAGE" : course.bookingAccess;
  }
  if (course.bookingAccess) {
    return course.bookingAccess;
  }
  if (course.bookingUrl) {
    return "BOOKING_PAGE";
  }
  return course.phone ? "PHONE_ONLY" : undefined;
}

function formatTelephoneHref(phone: string) {
  const normalized = phone.trim().replace(/(?!^\+)[^\d]/g, "");
  return normalized ? `tel:${normalized}` : "";
}

function renderMatchingTimes(
  times: SearchStatusCourseReport["matchingTimes"],
  timeZone: string
) {
  if (!times?.length) {
    return "";
  }

  const rows = [...times]
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt))
    .map((time) => {
      const details = [
        `${time.availableSpots} spot${time.availableSpots === 1 ? "" : "s"}`,
        time.priceCents != null ? formatPrice(time.priceCents) : null,
        time.holes ? `${time.holes} holes` : null
      ].filter(Boolean);

      return `
        <tr>
          <td style="border-top:1px solid #d9e3dc;padding:10px 0;font-size:18px;font-weight:800;color:#14231d">${escapeHtml(formatStartsAtTime(time.startsAt, timeZone))}</td>
          <td style="border-top:1px solid #d9e3dc;padding:10px 0;text-align:right;color:#4e5d56;font-size:13px">${escapeHtml(details.join(" · "))}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <div style="margin-top:13px">
      <p style="font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#147a52;margin:0 0 4px">Available now</p>
      <table role="presentation" style="border-collapse:collapse;width:100%">
        ${rows}
      </table>
    </div>
  `;
}

export function renderEmailStopControls(stopUrls?: EmailStopUrls) {
  if (!stopUrls) {
    return "";
  }

  return `
    <div style="border-top:1px solid #d9e3dc;margin-top:22px;padding-top:20px">
      <p style="font-size:16px;font-weight:800;margin:0 0 4px">Done with this alert?</p>
      <p style="color:#5c6c64;font-size:13px;margin:0 0 12px">Turn it off and we’ll stop checking and emailing for this search.</p>
      <p style="margin:0 0 8px">
        <a href="${escapeHtml(stopUrls.booked)}" style="background:#147a52;border-radius:999px;color:#ffffff;display:block;font-weight:800;padding:12px 16px;text-align:center;text-decoration:none">I booked — stop these emails</a>
      </p>
      <p style="margin:0">
        <a href="${escapeHtml(stopUrls.cancelled)}" style="border:1px solid #d9e3dc;border-radius:999px;color:#a33b35;display:block;font-weight:800;padding:11px 16px;text-align:center;text-decoration:none">Cancel this alert</a>
      </p>
      <p style="color:#6b766f;font-size:11px;margin:9px 0 0;text-align:center">Each button opens a confirmation page before anything is turned off.</p>
    </div>
  `;
}

function getCourseState(course: SearchStatusCourseReport) {
  if (course.outcome !== "NO_MATCH") {
    if (course.outcome === "MATCH_FOUND") {
      return `${course.outcome}:${course.availableMatches}`;
    }
    return [
      course.outcome,
      course.bookingMethod ?? getBookingAccess(course) ?? "UNKNOWN"
    ].join(":");
  }
  if (!course.availability || course.availability.visibleSlotCount === 0) {
    if (course.bookingWindow) {
      return `NO_MATCH:BOOKING_WINDOW:${course.bookingWindow.opensAt}:${course.bookingWindow.exactTime}`;
    }
    return "NO_MATCH:DATE_NOT_VISIBLE";
  }
  if (course.availability.playerEligibleSlotCount === 0) {
    return `NO_MATCH:PLAYER_COUNT:${course.availability.visibleSlotCount}`;
  }
  return [
    "NO_MATCH:OUTSIDE_WINDOW",
    course.availability.closestBefore ?? "none",
    course.availability.closestAfter ?? "none"
  ].join(":");
}

function formatBookingWindowRelease(
  bookingWindow: NonNullable<SearchStatusCourseReport["bookingWindow"]>
) {
  if (!bookingWindow.exactTime) {
    return new Date(`${bookingWindow.releaseDate}T12:00:00.000Z`).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric"
    });
  }

  return new Date(bookingWindow.opensAt).toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: normalizeTimeZone(bookingWindow.timeZone, DEFAULT_TIME_ZONE),
    timeZoneName: "short"
  });
}

function parseSearchStatusSnapshot(value: unknown): SearchStatusSnapshot | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const snapshot = value.filter(
    (entry): entry is SearchStatusSnapshot[number] =>
      Boolean(
        entry &&
          typeof entry === "object" &&
          typeof (entry as SearchStatusSnapshot[number]).courseId === "string" &&
          typeof (entry as SearchStatusSnapshot[number]).courseName === "string" &&
          typeof (entry as SearchStatusSnapshot[number]).state === "string"
      )
  );
  return snapshot.length === value.length ? snapshot : null;
}

function formatDate(value: string) {
  return new Date(`${value}T12:00:00.000Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
}

function formatStartsAtTime(value: string, timeZone: string) {
  return zonedDateTimeToDate(value, timeZone).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short"
  });
}

function formatTime(value: string) {
  const [hours = 0, minutes = 0] = value.split(":").map(Number);
  const suffix = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 || 12;
  return `${displayHour}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function formatPrice(priceCents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: priceCents % 100 === 0 ? 0 : 2
  }).format(priceCents / 100);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}
