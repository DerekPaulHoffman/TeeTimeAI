import { parseCourseLocalDateTime } from "@/lib/tee-times/matching";
import { parseCourseLocalWindowEnd } from "@/lib/searches/window-end";
import { isValidSearchCalendarDate } from "@/lib/validation/search-date";

export function assertSimulatorSessionFitsWindow(input: {
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  timeZones: readonly string[];
}, now = new Date()) {
  if (!isValidSearchCalendarDate(input.date) || input.startTime === "24:00" ||
      (input.endTime !== "24:00" && input.endTime <= input.startTime)) {
    throw new Error("Choose a valid simulator date and time window.");
  }
  for (const timeZone of input.timeZones) {
    const start = parseCourseLocalDateTime(`${input.date}T${input.startTime}`, timeZone);
    const end = parseCourseLocalWindowEnd(input.date, input.endTime, timeZone);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) ||
        end.getTime() - start.getTime() < input.durationMinutes * 60_000) {
      throw new Error("Choose a time window long enough for the complete simulator session at every venue.");
    }
    if (Math.max(start.getTime(), now.getTime()) + input.durationMinutes * 60_000 > end.getTime()) {
      throw new Error("Choose a future simulator window with a complete session still available at every venue.");
    }
  }
}
