import { z } from "zod";

import { isValidSearchCalendarDate } from "@/lib/validation/search-date";
import { MAX_SIMULATOR_PLAYERS, SEARCH_MODES } from "@/lib/searches/search-mode";

import {
  COURSE_LAYOUT_HOLE_OPTIONS,
  DEFAULT_SEARCH_CADENCE_MINUTES,
  MAX_ADDITIONAL_ALERT_EMAILS,
  MAX_COURSE_PREFERENCES,
  MAX_PLAYERS_PER_SEARCH,
  MIN_COURSE_PREFERENCES,
  SEARCH_CADENCE_OPTIONS_MINUTES
} from "@/lib/validation/search-constraints";

export {
  COURSE_LAYOUT_HOLE_OPTIONS,
  DEFAULT_SEARCH_CADENCE_MINUTES,
  MAX_ADDITIONAL_ALERT_EMAILS,
  MAX_COURSE_PREFERENCES,
  MAX_PLAYERS_PER_SEARCH,
  MAX_QUEUED_SEARCHES_PER_USER,
  MIN_COURSE_PREFERENCES,
  SEARCH_CADENCE_OPTIONS_MINUTES
} from "@/lib/validation/search-constraints";

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm time");
const DEFAULT_SEARCH_TIME_ZONE = "America/New_York";
const isValidSearchTimeZone = (value: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
};
const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(isValidSearchTimeZone, "Use a valid IANA time zone");

const selectedCourseSchema = z.object({
  offeringId: z.string().min(1).optional(),
  mode: z.enum(SEARCH_MODES).optional(),
  googlePlaceId: z.string().min(1).optional(),
  courseId: z.string().min(1).optional(),
  name: z.string().min(1),
  publicAccessStatus: z.enum(["PUBLIC", "UNVERIFIED"]).optional(),
  address: z.string().optional(),
  city: z.string().max(120).optional(),
  stateCode: z.string().max(2).optional(),
  stateName: z.string().max(120).optional(),
  county: z.string().max(120).optional(),
  countryCode: z.string().max(2).optional(),
  rank: z.number().int().min(1).max(MAX_COURSE_PREFERENCES),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timeZone: timeZoneSchema.optional(),
  distanceMeters: z.number().int().min(0).max(200_000).optional(),
  rating: z.number().min(0).max(5).optional(),
  phone: z.string().optional(),
  website: z.string().url().optional()
});

export const teeSearchDetailsSchema = z
  .object({
    mode: z.enum(SEARCH_MODES).default("OUTDOOR"),
    durationMinutes: z.number().int().min(30).max(480).refine((value) => value % 15 === 0).nullable().optional(),
    date: z.string().refine(isValidSearchCalendarDate, "Use a valid YYYY-MM-DD date"),
    startTime: timeSchema,
    endTime: timeSchema,
    userTimeZone: timeZoneSchema.default(DEFAULT_SEARCH_TIME_ZONE),
    players: z.number().int().min(1).max(MAX_SIMULATOR_PLAYERS),
    requestedLayoutHoles: z
      .union([z.literal(COURSE_LAYOUT_HOLE_OPTIONS[0]), z.literal(COURSE_LAYOUT_HOLE_OPTIONS[1])])
      .nullable()
      .optional(),
    cadenceMinutes: z
      .number()
      .int()
      .min(SEARCH_CADENCE_OPTIONS_MINUTES[0])
      .max(SEARCH_CADENCE_OPTIONS_MINUTES.at(-1) ?? 120)
      .default(DEFAULT_SEARCH_CADENCE_MINUTES),
    alertEmail: z.string().trim().toLowerCase().email("Use a valid alert email").optional(),
    additionalEmails: z
      .array(z.string().trim().toLowerCase().email("Use a valid email"))
      .max(MAX_ADDITIONAL_ALERT_EMAILS, `Add up to ${MAX_ADDITIONAL_ALERT_EMAILS} extra emails`)
      .default([])
  })
  .superRefine((value, context) => {
    if (value.mode === "SIMULATOR") {
      if (value.players > MAX_SIMULATOR_PLAYERS) {
        context.addIssue({ code: "custom", path: ["players"], message: "Select up to 8 players" });
      }
      if (value.durationMinutes == null) {
        context.addIssue({ code: "custom", path: ["durationMinutes"], message: "Choose a simulator session length" });
      }
      if (value.requestedLayoutHoles != null) {
        context.addIssue({ code: "custom", path: ["requestedLayoutHoles"], message: "Course layout does not apply to simulator sessions" });
      }
    } else {
      if (value.players > MAX_PLAYERS_PER_SEARCH) {
        context.addIssue({ code: "custom", path: ["players"], message: "Select up to 4 players" });
      }
      if (value.durationMinutes != null) {
        context.addIssue({ code: "custom", path: ["durationMinutes"], message: "Session length applies only to simulators" });
      }
    }
    if (value.endTime <= value.startTime) {
      context.addIssue({
        code: "custom",
        path: ["endTime"],
        message: "End time must be after start time"
      });
    }

    // Future-date eligibility is checked by the service after canonical
    // courses are resolved. Neither the server nor the golfer timezone owns it.
  });

export const teeSearchInputSchema = teeSearchDetailsSchema
  .extend({
    courses: z
      .array(selectedCourseSchema)
      .min(MIN_COURSE_PREFERENCES, "Select at least 1 course")
      .max(MAX_COURSE_PREFERENCES, "Select up to 5 courses")
  })
  .superRefine((value, context) => {
    if (value.mode === "SIMULATOR" && value.courses.some((course) => !course.offeringId)) {
      context.addIssue({ code: "custom", path: ["courses"], message: "Choose verified simulator venues" });
    }
    if (value.mode === "OUTDOOR" && value.courses.some((course) => course.offeringId || course.mode === "SIMULATOR")) {
      context.addIssue({ code: "custom", path: ["courses"], message: "Choose outdoor courses for this alert" });
    }

    const ranks = new Set(value.courses.map((course) => course.rank));
    if (ranks.size !== value.courses.length) {
      context.addIssue({
        code: "custom",
        path: ["courses"],
        message: "Course priorities must be unique"
      });
    }
  });

export type TeeSearchInput = z.infer<typeof teeSearchInputSchema>;
export type TeeSearchDetailsInput = z.infer<typeof teeSearchDetailsSchema>;
export type SelectedCourseInput = TeeSearchInput["courses"][number];

export function parseLocalDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}
