export const OPERATOR_TIME_ZONE = "America/New_York";

type CalendarDate = {
  year: number;
  month: number;
  day: number;
};

export type OperatorDateRange = {
  days: 7 | 30;
  start: Date;
  end: Date;
  todayStart: Date;
  dayKeys: string[];
};

const datePartFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: OPERATOR_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

const dateTimePartFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: OPERATOR_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

export function parseOperatorRange(value: string | undefined): 7 | 30 {
  return value === "30d" ? 30 : 7;
}

export function getOperatorDateRange(
  days: 7 | 30,
  now = new Date()
): OperatorDateRange {
  const today = getCalendarDate(now);
  const firstDay = addCalendarDays(today, -(days - 1));
  const tomorrow = addCalendarDays(today, 1);
  const dayKeys = Array.from({ length: days }, (_, index) =>
    formatCalendarDate(addCalendarDays(firstDay, index))
  );

  return {
    days,
    start: calendarMidnightToUtc(firstDay),
    end: calendarMidnightToUtc(tomorrow),
    todayStart: calendarMidnightToUtc(today),
    dayKeys
  };
}

export function formatOperatorDayKey(date: Date) {
  return formatCalendarDate(getCalendarDate(date));
}

function getCalendarDate(date: Date): CalendarDate {
  const parts = readParts(datePartFormatter, date);
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day
  };
}

function calendarMidnightToUtc(date: CalendarDate) {
  const target = Date.UTC(date.year, date.month - 1, date.day);
  let candidate = target;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = readParts(dateTimePartFormatter, new Date(candidate));
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second
    );
    const correction = target - observedAsUtc;
    candidate += correction;
    if (correction === 0) {
      break;
    }
  }

  return new Date(candidate);
}

function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  };
}

function formatCalendarDate(date: CalendarDate) {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(
    date.day
  ).padStart(2, "0")}`;
}

function readParts(formatter: Intl.DateTimeFormat, date: Date) {
  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0
  };
}
