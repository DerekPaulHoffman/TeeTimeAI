import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  LOCAL_READER_COURSE_KEYS,
  getLocalReaderCourse,
  isAllowedLocalReaderUrl,
  type DynamicCpsCourseKey,
  type DynamicChronogolfCourseKey,
  type DynamicEzLinksCourseKey,
  type DynamicMemberSportsCourseKey,
  type DynamicTenForeCourseKey,
  type DynamicWebTracCourseKey
} from "./course-key";

export { LOCAL_READER_COURSES, isAllowedLocalReaderUrl } from "./course-key";

const dynamicCpsCourseKeySchema = z.custom<DynamicCpsCourseKey>(
  (value) =>
    typeof value === "string" &&
    /^cps:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cps\.golf$/u.test(value),
  "Expected a safe CPS tenant key"
);

const dynamicTenForeCourseKeySchema = z.custom<DynamicTenForeCourseKey>(
  (value) => typeof value === "string" && /^tenfore:[a-z0-9][a-z0-9-]{0,127}$/u.test(value),
  "Expected a safe TenFore tenant key"
);

const dynamicChronogolfCourseKeySchema = z.custom<DynamicChronogolfCourseKey>(
  (value) => typeof value === "string" && /^chronogolf:[a-z0-9][a-z0-9-]{0,127}$/u.test(value),
  "Expected a safe Chronogolf club key"
);

const dynamicEzLinksCourseKeySchema = z.custom<DynamicEzLinksCourseKey>(
  (value) =>
    typeof value === "string" &&
    /^ezlinks:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ezlinksgolf\.com$/u.test(value),
  "Expected a safe EZLinks tenant key"
);

const dynamicWebTracCourseKeySchema = z.custom<DynamicWebTracCourseKey>(
  (value) =>
    typeof value === "string" &&
    /^webtrac:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myvscloud\.com$/u.test(value),
  "Expected a safe MyVSCloud WebTrac tenant key"
);

const dynamicMemberSportsCourseKeySchema = z.custom<DynamicMemberSportsCourseKey>(
  (value) =>
    typeof value === "string" &&
    /^membersports:[1-9]\d{0,9}:[1-9]\d{0,9}$/u.test(value) &&
    value
      .slice("membersports:".length)
      .split(":")
      .every((part) => Number(part) <= 2_147_483_647),
  "Expected a safe MemberSports course key"
);

export const localReaderCourseKeySchema = z.union([
  z.enum(LOCAL_READER_COURSE_KEYS),
  dynamicCpsCourseKeySchema,
  dynamicChronogolfCourseKeySchema,
  dynamicTenForeCourseKeySchema,
  dynamicEzLinksCourseKeySchema,
  dynamicWebTracCourseKeySchema,
  dynamicMemberSportsCourseKeySchema
]);

const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "Expected a YYYY-MM-DD local date");

export const localReaderJobSchema = z
  .object({
    id: z.string().min(1).max(128),
    courseKey: localReaderCourseKeySchema,
    targetDate: localDateSchema,
    players: z.number().int().min(1).max(4),
    requestedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    courseName: z.string().min(1).max(160),
    bookingUrl: z.string().url(),
    cardTextIncludes: z.array(z.string().min(1).max(80)).max(4),
    requiredCapability: z
      .object({
        key: z.string().min(1).max(80),
        parserVersion: z.number().int().min(1).max(1000)
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((job, context) => {
    const course = getLocalReaderCourse(job.courseKey, job.courseName);
    if (!course) {
      context.addIssue({
        code: "custom",
        message: "The course is not available to the local reader",
        path: ["courseKey"]
      });
      return;
    }
    if (!isAllowedLocalReaderUrl(job.courseKey, job.bookingUrl)) {
      context.addIssue({
        code: "custom",
        message: "The booking URL is not allowlisted for this course",
        path: ["bookingUrl"]
      });
    }
    if (job.courseName !== course.courseName) {
      context.addIssue({
        code: "custom",
        message: "The course name is not allowlisted for this course",
        path: ["courseName"]
      });
    }
    if (JSON.stringify(job.cardTextIncludes) !== JSON.stringify(course.cardTextIncludes)) {
      context.addIssue({
        code: "custom",
        message: "The card filter is not allowlisted for this course",
        path: ["cardTextIncludes"]
      });
    }
    if (Date.parse(job.expiresAt) <= Date.parse(job.requestedAt)) {
      context.addIssue({
        code: "custom",
        message: "The job must expire after it was requested",
        path: ["expiresAt"]
      });
    }
  });

export const localReaderSlotSchema = z
  .object({
    startsAtLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u),
    timeLabel: z.string().min(1).max(20),
    holes: z
      .array(z.union([z.literal(9), z.literal(18)]))
      .min(1)
      .max(2),
    minimumPlayers: z.number().int().min(1).max(4),
    availableSpots: z.number().int().min(1).max(4),
    priceCents: z.number().int().min(0).nullable(),
    cartIncluded: z.boolean()
  })
  .strict();

export const localReaderResultSchema = z
  .object({
    jobId: z.string().min(1).max(128),
    courseKey: localReaderCourseKeySchema,
    status: z.enum([
      "AVAILABLE",
      "NO_AVAILABILITY",
      "ACCESS_CHALLENGE",
      "PAGE_MISMATCH",
      "READER_ERROR"
    ]),
    observedAt: z.string().datetime(),
    pageUrl: z.string().url(),
    pageTitle: z.string().min(1).max(200),
    slots: z.array(localReaderSlotSchema).max(200),
    readerVersion: z.string().min(1).max(64)
  })
  .strict()
  .superRefine((result, context) => {
    if (!isAllowedLocalReaderUrl(result.courseKey, result.pageUrl)) {
      context.addIssue({
        code: "custom",
        message: "The result URL is not allowlisted for this course",
        path: ["pageUrl"]
      });
    }
    if (result.status === "AVAILABLE" && result.slots.length === 0) {
      context.addIssue({
        code: "custom",
        message: "An AVAILABLE result must contain at least one slot",
        path: ["slots"]
      });
    }
    if (result.status !== "AVAILABLE" && result.slots.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Only an AVAILABLE result may contain slots",
        path: ["slots"]
      });
    }
  });

export type LocalReaderJob = z.infer<typeof localReaderJobSchema>;
export type LocalReaderResult = z.infer<typeof localReaderResultSchema>;

export function validateLocalReaderResultForJob(
  jobValue: LocalReaderJob,
  resultValue: LocalReaderResult
) {
  const job = localReaderJobSchema.parse(jobValue);
  const result = localReaderResultSchema.parse(resultValue);
  if (result.jobId !== job.id || result.courseKey !== job.courseKey) {
    throw new Error("The result does not belong to the leased job");
  }
  const observedAt = Date.parse(result.observedAt);
  if (observedAt < Date.parse(job.requestedAt) || observedAt > Date.parse(job.expiresAt)) {
    throw new Error("The result observation is outside the job lifetime");
  }
  for (const slot of result.slots) {
    if (!slot.startsAtLocal.startsWith(`${job.targetDate}T`)) {
      throw new Error("A returned slot is outside the requested local date");
    }
    if (job.players < slot.minimumPlayers || job.players > slot.availableSpots) {
      throw new Error("A returned slot cannot accommodate the requested players");
    }
  }
  return { job, result };
}

export function serializeSignedPayload(payload: unknown) {
  return JSON.stringify(payload);
}

export function signLocalReaderPayload(secret: string, serializedPayload: string) {
  if (secret.length < 16) {
    throw new Error("Local reader secrets must contain at least 16 characters");
  }
  return createHmac("sha256", secret).update(serializedPayload).digest("hex");
}

export function verifyLocalReaderSignature(
  secret: string,
  serializedPayload: string,
  signature: string
) {
  if (!/^[a-f0-9]{64}$/u.test(signature)) return false;
  const expected = Buffer.from(signLocalReaderPayload(secret, serializedPayload), "hex");
  const received = Buffer.from(signature, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
