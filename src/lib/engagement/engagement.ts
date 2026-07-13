import { z } from "zod";
import { Prisma } from "@prisma/client";

import { sanitizePagePath } from "@/lib/engagement/page-path";
import { discoverySources } from "@/lib/engagement/discovery-source";
import { websiteTrafficClasses } from "@/lib/engagement/traffic-class";
import { prisma } from "@/lib/prisma";

export const websiteEventNames = [
  "page_viewed",
  "start_search_clicked",
  "dashboard_opened",
  "email_preview_opened",
  "course_discovery_completed",
  "course_discovery_failed",
  "search_submitted",
  "search_submission_failed",
  "feedback_opened",
  "feedback_submitted"
] as const;

const trafficClassSchema = z.enum(websiteTrafficClasses).optional().default("UNCLASSIFIED");
const discoverySourceSchema = z.enum(discoverySources).optional();
const pageSchema = z
  .string()
  .trim()
  .max(2000)
  .transform((value) => sanitizePagePath(value))
  .optional();
const clickMetadataSchema = z
  .object({
    label: z.string().trim().min(1).max(120)
  })
  .strict();
const searchMetadataSchema = z
  .object({
    selectedCourseCount: z.number().int().min(0).max(5),
    players: z.number().int().min(1).max(4),
    requestedLayoutHoles: z.union([z.literal(9), z.literal(18), z.null()]).optional()
  })
  .strict();
const courseDiscoveryMetadataSchema = z
  .object({
    radiusMiles: z.number().int().min(5).max(30)
  })
  .strict();

const eventBase = {
  page: pageSchema,
  discoverySource: discoverySourceSchema,
  trafficClass: trafficClassSchema
};

export const websiteEventInputSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("page_viewed"), ...eventBase }).strict(),
  z.object({ name: z.literal("feedback_opened"), ...eventBase }).strict(),
  z.object({ name: z.literal("start_search_clicked"), ...eventBase, metadata: clickMetadataSchema }).strict(),
  z.object({ name: z.literal("dashboard_opened"), ...eventBase, metadata: clickMetadataSchema }).strict(),
  z.object({ name: z.literal("email_preview_opened"), ...eventBase, metadata: clickMetadataSchema }).strict(),
  z
    .object({
      name: z.literal("course_discovery_completed"),
      ...eventBase,
      metadata: courseDiscoveryMetadataSchema.extend({
        resultCount: z.number().int().min(0).max(60),
        demo: z.boolean()
      })
    })
    .strict(),
  z
    .object({
      name: z.literal("course_discovery_failed"),
      ...eventBase,
      metadata: courseDiscoveryMetadataSchema.extend({
        stage: z.enum(["GEOCODE", "DISCOVERY"]),
        responseStatus: z.number().int().min(100).max(599).optional()
      })
    })
    .strict(),
  z.object({ name: z.literal("search_submitted"), ...eventBase, metadata: searchMetadataSchema }).strict(),
  z
    .object({
      name: z.literal("search_submission_failed"),
      ...eventBase,
      metadata: searchMetadataSchema.extend({
        responseStatus: z.number().int().min(100).max(599)
      })
    })
    .strict(),
  z
    .object({
      name: z.literal("feedback_submitted"),
      ...eventBase,
      metadata: z
        .object({ sentiment: z.enum(["like", "dislike", "broken"]) })
        .strict()
    })
    .strict()
]);

export const websiteFeedbackInputSchema = z
  .object({
    sentiment: z.enum(["like", "dislike", "broken"]),
    message: z.string().trim().max(2000).optional().default(""),
    page: pageSchema,
    trafficClass: trafficClassSchema,
    contactEmail: z
      .string()
      .trim()
      .toLowerCase()
      .email("Use a valid email")
      .optional()
      .or(z.literal("").transform(() => undefined))
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sentiment === "broken" && !value.message) {
      context.addIssue({
        code: "custom",
        path: ["message"],
        message: "Tell us what broke so we can fix it."
      });
    }
  })
  .transform((value) => ({
    ...value,
    message: value.message || undefined
  }));

export type WebsiteEventInput = z.input<typeof websiteEventInputSchema>;
export type WebsiteFeedbackInput = z.input<typeof websiteFeedbackInputSchema>;

export async function createWebsiteEvent(input: unknown) {
  const event = websiteEventInputSchema.parse(input);
  const eventMetadata = getEventMetadata(event);

  return prisma.websiteEvent.create({
    data: {
      name: event.name,
      page: event.page,
      metadata: eventMetadata as Prisma.InputJsonObject | undefined,
      trafficClass: event.trafficClass
    }
  });
}

function getEventMetadata(event: z.output<typeof websiteEventInputSchema>) {
  const metadata = "metadata" in event ? event.metadata : undefined;

  if (!event.discoverySource) {
    return metadata;
  }

  return {
    ...metadata,
    discoverySource: event.discoverySource
  };
}

export async function submitWebsiteFeedback(input: unknown) {
  const feedback = websiteFeedbackInputSchema.parse(input);

  return prisma.websiteFeedback.create({
    data: {
      sentiment: feedback.sentiment.toUpperCase() as "LIKE" | "DISLIKE" | "BROKEN",
      message: feedback.message,
      page: feedback.page,
      contactEmail: feedback.contactEmail,
      trafficClass: feedback.trafficClass
    }
  });
}
