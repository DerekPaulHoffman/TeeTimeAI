import { zonedDateTimeToDate } from "@/lib/timezones";

/** 24:00 is the midnight following the selected local calendar date. */
export function parseCourseLocalWindowEnd(date: string, endTime: string, timeZone: string) {
  if (endTime === "24:00") {
    const next = new Date(`${date}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return zonedDateTimeToDate(`${next.toISOString().slice(0, 10)}T00:00:00`, timeZone);
  }
  return zonedDateTimeToDate(`${date}T${endTime}:00`, timeZone);
}
