import { z } from "zod";

export const MIN_COURSE_PREFERENCES = 1;
export const MAX_COURSE_PREFERENCES = 5;

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm time");

const selectedCourseSchema = z.object({
  googlePlaceId: z.string().min(1).optional(),
  courseId: z.string().min(1).optional(),
  name: z.string().min(1),
  address: z.string().optional(),
  rank: z.number().int().min(1).max(MAX_COURSE_PREFERENCES),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  rating: z.number().min(0).max(5).optional(),
  phone: z.string().optional(),
  website: z.string().url().optional(),
  photoName: z.string().optional()
});

export const teeSearchInputSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD date"),
    startTime: timeSchema,
    endTime: timeSchema,
    players: z.number().int().min(1).max(8),
    cadenceMinutes: z.number().int().min(15).max(120).default(15),
    alertEmail: z.string().email("Use a valid alert email").optional(),
    courses: z
      .array(selectedCourseSchema)
      .min(MIN_COURSE_PREFERENCES, "Select at least 1 course")
      .max(MAX_COURSE_PREFERENCES, "Select up to 5 courses")
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
export type SelectedCourseInput = TeeSearchInput["courses"][number];

export function parseLocalDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day);
}
