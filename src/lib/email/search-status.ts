export type SearchStatusEmailKind = "setup" | "daily";

export type SearchStatusAvailability = {
  visibleSlotCount: number;
  playerEligibleSlotCount: number;
  closestBefore?: string;
  closestAfter?: string;
};

export type SearchStatusCourseReport = {
  courseId: string;
  courseName: string;
  outcome: "MATCH_FOUND" | "NO_MATCH" | "BLOCKED_POLICY" | "NEEDS_ADAPTER" | "FETCH_FAILED";
  availableMatches: number;
  message?: string;
  bookingUrl?: string;
  availability?: SearchStatusAvailability;
};

export type SearchStatusSnapshot = Array<{
  courseId: string;
  courseName: string;
  state: string;
}>;

export type SearchStatusEmailInput = {
  to: string;
  kind: SearchStatusEmailKind;
  targetDate: string;
  startTime: string;
  endTime: string;
  players: number;
  checkedAt: Date;
  courses: SearchStatusCourseReport[];
  previousSnapshot?: unknown;
  idempotencyKey?: string;
};

const DAILY_STATUS_EMAIL_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
  now = new Date()
): SearchStatusEmailKind | null {
  if (!lastSentAt) {
    return "setup";
  }

  return now.getTime() - lastSentAt.getTime() >= DAILY_STATUS_EMAIL_INTERVAL_MS
    ? "daily"
    : null;
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
  const window = `${formatTime(input.startTime)}–${formatTime(input.endTime)}`;
  const checkedAt = input.checkedAt.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
    timeZoneName: "short"
  });
  const heading = input.kind === "setup" ? "We’re working on your tee times" : "Your daily tee-time update";
  const badge = input.kind === "setup" ? "Search is active" : "Daily update";
  const intro =
    input.kind === "setup"
      ? "Your alert is set. We checked every selected course and will keep watching automatically."
      : changedCourses.length > 0
        ? `Changed since your last email: ${changedCourses.join(", ")}.`
        : "No course status changed since your last email. We’re still checking.";
  const courseRows = input.courses
    .map((course, index) => renderCourseReport(course, input.players, index + 1))
    .join("");

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
          <table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:20px">
            <tr>
              <td style="background:#f5f7f2;border-radius:8px;padding:12px">
                <div style="font-size:11px;font-weight:800;text-transform:uppercase;color:#5c6c64">Date</div>
                <div style="font-weight:800">${escapeHtml(targetDate)}</div>
              </td>
              <td style="width:8px"></td>
              <td style="background:#f5f7f2;border-radius:8px;padding:12px">
                <div style="font-size:11px;font-weight:800;text-transform:uppercase;color:#5c6c64">Window</div>
                <div style="font-weight:800">${escapeHtml(window)}</div>
              </td>
              <td style="width:8px"></td>
              <td style="background:#f5f7f2;border-radius:8px;padding:12px">
                <div style="font-size:11px;font-weight:800;text-transform:uppercase;color:#5c6c64">Golfers</div>
                <div style="font-weight:800">${input.players}</div>
              </td>
            </tr>
          </table>
          <h2 style="font-size:19px;margin:0 0 12px">What each course is showing</h2>
          ${courseRows}
          <div style="background:#e6f3f7;border-radius:10px;color:#174152;padding:14px 16px;font-size:14px;margin-top:18px">
            We only send an instant email when a newly opened tee time matches your exact date, time window, and player count. Otherwise, you’ll receive at most one status update per day.
          </div>
          <p style="color:#5c6c64;font-size:13px;margin:16px 0 0">Last checked ${escapeHtml(checkedAt)}.</p>
        </div>
        <div style="background:#111d18;color:rgba(255,255,255,.72);padding:18px 22px;font-size:13px">
          Tee Time Spot sends you to the course’s official booking page. We never book, hold, or pay for tee times.
        </div>
      </div>
    </div>
  `;
}

function renderCourseReport(course: SearchStatusCourseReport, players: number, rank: number) {
  const description = describeCourse(course, players);
  const bookingLink = course.bookingUrl
    ? `<p style="margin:10px 0 0"><a href="${escapeHtml(course.bookingUrl)}" style="color:#105338;font-weight:800;text-decoration:none">Open official booking page →</a></p>`
    : "";

  return `
    <div style="border:1px solid #d9e3dc;border-left:4px solid ${description.color};border-radius:10px;padding:15px 16px;margin-bottom:10px">
      <p style="font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:${description.color};margin:0 0 5px">Priority ${rank} · ${escapeHtml(description.label)}</p>
      <p style="font-size:16px;font-weight:800;margin:0 0 5px">${escapeHtml(course.courseName)}</p>
      <p style="margin:0;color:#4e5d56;font-size:14px">${escapeHtml(description.detail)}</p>
      ${bookingLink}
    </div>
  `;
}

function describeCourse(course: SearchStatusCourseReport, players: number) {
  if (course.outcome === "MATCH_FOUND") {
    return {
      label: "Matching time visible",
      color: "#147a52",
      detail: `${course.availableMatches} matching tee time${course.availableMatches === 1 ? " is" : "s are"} visible. New openings trigger a separate instant alert.`
    };
  }

  if (course.outcome === "NEEDS_ADAPTER") {
    return {
      label: "We’re working on it",
      color: "#9a5a16",
      detail: "We found the official booking page, but automatic availability checking is not ready yet. We’re working on connecting this course."
    };
  }

  if (course.outcome === "FETCH_FAILED") {
    return {
      label: "Latest check incomplete",
      color: "#a23a32",
      detail: "This course’s latest check did not finish. We’ll retry automatically; its official page is available in the meantime."
    };
  }

  if (course.outcome === "BLOCKED_POLICY") {
    return {
      label: "Official site only",
      color: "#6b5a45",
      detail: "We can’t automatically monitor this course and won’t bypass its restrictions. Please check the official booking page directly."
    };
  }

  const availability = course.availability;
  if (!availability || availability.visibleSlotCount === 0) {
    return {
      label: "Nothing visible for this date yet",
      color: "#52685e",
      detail: "The course returned no public times for this date. Its booking window may not be open yet, or the visible inventory may currently be full. We’ll keep checking."
    };
  }

  if (availability.playerEligibleSlotCount === 0) {
    return {
      label: "Not enough open spots",
      color: "#52685e",
      detail: `Times are visible, but none currently have room for ${players} player${players === 1 ? "" : "s"}.`
    };
  }

  const before = availability.closestBefore ? formatStartsAtTime(availability.closestBefore) : null;
  const after = availability.closestAfter ? formatStartsAtTime(availability.closestAfter) : null;
  const closest =
    before && after
      ? `The closest visible times are ${before} before your window and ${after} after it.`
      : before
        ? `The closest visible time is ${before}, before your window.`
        : after
          ? `The closest visible time is ${after}, after your window.`
          : "Times are visible, but none match your exact window.";

  return {
    label: "No time in your window",
    color: "#52685e",
    detail: closest
  };
}

function getCourseState(course: SearchStatusCourseReport) {
  if (course.outcome !== "NO_MATCH") {
    return course.outcome === "MATCH_FOUND"
      ? `${course.outcome}:${course.availableMatches}`
      : course.outcome;
  }
  if (!course.availability || course.availability.visibleSlotCount === 0) {
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

function formatStartsAtTime(value: string) {
  return formatTime(value.slice(11, 16));
}

function formatTime(value: string) {
  const [hours = 0, minutes = 0] = value.split(":").map(Number);
  const suffix = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 || 12;
  return `${displayHour}:${String(minutes).padStart(2, "0")} ${suffix}`;
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
