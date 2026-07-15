import { z } from "zod";

export const MIN_COURSE_PREFERENCES = 1;
export const MAX_COURSE_PREFERENCES = 5;
export const MAX_PLAYERS_PER_SEARCH = 4;
export const MAX_QUEUED_SEARCHES_PER_USER = 3;
export const MAX_ADDITIONAL_ALERT_EMAILS = 3;
export const SEARCH_CADENCE_OPTIONS_MINUTES = [5, 15, 30, 60, 120] as const;
export const DEFAULT_SEARCH_CADENCE_MINUTES = 5;
export const COURSE_LAYOUT_HOLE_OPTIONS = [9, 18] as const;

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
  googlePlaceId: z.string().min(1).optional(),
  courseId: z.string().min(1).optional(),
  name: z.string().min(1),
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
  rating: z.number().min(0).max(5).optional(),
  phone: z.string().optional(),
  website: z.string().url().optional()
});

export const teeSearchDetailsSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD date"),
    startTime: timeSchema,
    endTime: timeSchema,
    userTimeZone: timeZoneSchema.default(DEFAULT_SEARCH_TIME_ZONE),
    players: z.number().int().min(1).max(MAX_PLAYERS_PER_SEARCH),
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
    additionalEmails: z
      .array(z.string().trim().toLowerCase().email("Use a valid email"))
      .max(MAX_ADDITIONAL_ALERT_EMAILS, `Add up to ${MAX_ADDITIONAL_ALERT_EMAILS} extra emails`)
      .default([])
  })
  .superRefine((value, context) => {
    if (value.endTime <= value.startTime) {
      context.addIssue({
        code: "custom",
        path: ["endTime"],
        message: "End time must be after start time"
      });
    }

    const selectedDate = parseLocalDate(value.date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (selectedDate <= today) {
      context.addIssue({
        code: "custom",
        path: ["date"],
        message: "Search date must be in the future"
      });
    }
  });

export const teeSearchInputSchema = teeSearchDetailsSchema
  .extend({
    alertEmail: z.string().email("Use a valid alert email").optional(),
    courses: z
      .array(selectedCourseSchema)
      .min(MIN_COURSE_PREFERENCES, "Select at least 1 course")
      .max(MAX_COURSE_PREFERENCES, "Select up to 5 courses")
  })
  .superRefine((value, context) => {

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
  return new Date(year, month - 1, day);
}
