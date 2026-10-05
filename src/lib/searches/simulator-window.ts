import { parseCourseLocalDateTime } from "@/lib/tee-times/matching";

export function assertSimulatorSessionFitsWindow(input: {
  date: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  timeZones: readonly string[];
}) {
  for (const timeZone of input.timeZones) {
    const start = parseCourseLocalDateTime(`${input.date}T${input.startTime}`, timeZone);
    const end = parseCourseLocalDateTime(`${input.date}T${input.endTime}`, timeZone);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) ||
        end.getTime() - start.getTime() < input.durationMinutes * 60_000) {
      throw new Error("Choose a time window long enough for the complete simulator session at every venue.");
    }
  }
}
