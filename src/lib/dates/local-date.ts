export function formatDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addLocalDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function courseCalendarFormatter(timeZone: string) {
  const options: Intl.DateTimeFormatOptions = {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric"
  };
  try {
    return new Intl.DateTimeFormat("en-US", options);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "America/New_York" });
  }
}

function formattedCalendarDate(formatter: Intl.DateTimeFormat, from: Date) {
  const parts = formatter.formatToParts(from);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function latestCourseCalendarDate(from: Date, courseTimeZones: readonly string[]) {
  return courseTimeZones.reduce(
    (latest, timeZone) => {
      const date = formattedCalendarDate(courseCalendarFormatter(timeZone), from);
      return date > latest ? date : latest;
    },
    ""
  );
}

function addCalendarDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function getNextSaturdayDateInputValue(
  from = new Date(),
  courseTimeZones: readonly string[] = []
) {
  if (courseTimeZones.length > 0) {
    const today = latestCourseCalendarDate(from, courseTimeZones);
    const day = new Date(`${today}T00:00:00.000Z`).getUTCDay();
    return addCalendarDays(today, (6 - day + 7) % 7 || 7);
  }

  const daysUntilSaturday = (6 - from.getDay() + 7) % 7 || 7;
  return formatDateInputValue(addLocalDays(from, daysUntilSaturday));
}

// Candidate timezones guide the picker; the service still validates canonical courses.
export function getMinimumSearchDateInputValue(
  from = new Date(),
  courseTimeZones: readonly string[] = []
) {
  if (courseTimeZones.length > 0) {
    return addCalendarDays(latestCourseCalendarDate(from, courseTimeZones), 1);
  }

  return formatDateInputValue(addLocalDays(from, 1));
}

export function reconcileFutureSearchDateInputValue(
  value: string,
  from = new Date(),
  courseTimeZones: readonly string[] = []
) {
  return value >= getMinimumSearchDateInputValue(from, courseTimeZones)
    ? value
    : getNextSaturdayDateInputValue(from, courseTimeZones);
}

export function getNextSearchDateRolloverAt(
  from = new Date(),
  courseTimeZones: readonly string[] = []
) {
  if (courseTimeZones.length === 0) {
    return new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1, 0, 0, 1);
  }

  const rollovers = [...new Set(courseTimeZones)].map((timeZone) => {
    const formatter = courseCalendarFormatter(timeZone);
    const today = formattedCalendarDate(formatter, from);
    let before = from.getTime();
    let after = before + 48 * 60 * 60 * 1_000;

    // Find the next calendar boundary without assuming a 24-hour day across DST.
    while (after - before > 1_000) {
      const midpoint = Math.floor((before + after) / 2);
      if (formattedCalendarDate(formatter, new Date(midpoint)) === today) {
        before = midpoint;
      } else {
        after = midpoint;
      }
    }
    return after + 1_000;
  });

  return new Date(Math.min(...rollovers));
}
