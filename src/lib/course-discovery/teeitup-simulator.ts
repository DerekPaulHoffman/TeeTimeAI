import type { AccessExecutionInput, AccessExecutionResult } from "./recipe";
import type { TeeItUpRecipeFacility } from "./teeitup-recipe-source";
import { teeItUpRecipeBookingUrl } from "./teeitup-recipe-source";

const fail = (): never => { throw new Error("ADAPTER_AVAILABILITY_SCHEMA_CHANGED"); };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647;
export function teeItUpSimulatorDuration(value: unknown) {
  if (typeof value !== "string" || value.length > 100) return undefined;
  const match = /^simulator\s*[-:]\s*(\d{1,3}(?:\.\d{1,2})?)\s*(hours?|hrs?|hr|minutes?|mins?|min)$/iu.exec(value.trim());
  if (!match) return undefined;
  const duration = Number(match[1]) * (/^h/iu.test(match[2]) ? 60 : 1);
  return Number.isInteger(duration) && duration >= 15 && duration <= 480 ? duration : undefined;
}

/** The directory proves a simulator; per-rate isSimulator/holes do not describe
 * rental duration or human capacity. allowedPlayers=[1] denotes one bay. */
export function parseTeeItUpSimulatorAvailability(value: unknown, facilities: TeeItUpRecipeFacility[],
  input: AccessExecutionInput, bookingSource: string): AccessExecutionResult["slots"] {
  if (facilities.length !== 1 || facilities[0].isSimulator !== true || facilities[0].timeZone !== input.timeZone || !input.durationMinutes ||
      !Array.isArray(value) || value.length > 100) return fail();
  const facility = facilities[0], result: AccessExecutionResult["slots"] = [], seen = new Set<string>();
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: input.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  let count = 0;
  for (const day of value) {
    if (!object(day) || !Array.isArray(day.teetimes) || day.message || day.courseId !== undefined && day.courseId !== facility.courseId) return fail();
    if (day.totalAvailableTeetimes !== undefined && (!Number.isSafeInteger(day.totalAvailableTeetimes) ||
        Number(day.totalAvailableTeetimes) < 0 || Number(day.totalAvailableTeetimes) > 500 || day.totalAvailableTeetimes !== day.teetimes.length)) return fail();
    for (const slot of day.teetimes) {
      if (++count > 500 || !object(slot) || slot.courseId !== facility.courseId || typeof slot.teetime !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/u.test(slot.teetime) ||
          !Number.isFinite(Date.parse(slot.teetime)) || localDate.format(new Date(slot.teetime)) !== input.date ||
          !Array.isArray(slot.rates) || slot.rates.length > 100 ||
          slot.minPlayers !== undefined && slot.minPlayers !== 1 || slot.maxPlayers !== undefined && slot.maxPlayers !== 1) return fail();
      for (const rate of slot.rates) {
        if (!object(rate) || !Array.isArray(rate.allowedPlayers) || rate.allowedPlayers.length !== 1 || rate.allowedPlayers[0] !== 1 ||
            !object(rate.golfnow) || !positiveId(rate.golfnow.GolfCourseId) || rate.golfnow.GolfFacilityId !== facility.id ||
            rate.isSimulator !== undefined && typeof rate.isSimulator !== "boolean") return fail();
        const duration = teeItUpSimulatorDuration(rate.name);
        if (!duration) return fail();
        const startsAt = new Date(slot.teetime).toISOString(), resource = rate.golfnow.GolfCourseId;
        const key = `${resource}:${duration}:${startsAt}`;
        if (seen.has(key)) return fail();
        seen.add(key);
        if (duration !== input.durationMinutes) continue;
        if (result.length >= 500) return fail();
        result.push({ sourceId: `teeitup-${facility.id}-simulator-${resource}-duration-${duration}-${startsAt}`,
          resourceId: `teeitup-facility:${facility.id}:simulator:${resource}`, productId: `teeitup-duration:${duration}`,
          startsAt, endsAt: new Date(Date.parse(startsAt) + duration * 60_000).toISOString(), availableSpots: 1, capacity: null,
          bookingUrl: teeItUpRecipeBookingUrl(bookingSource, input.date, facility.id) });
      }
    }
  }
  return result;
}
