import { z } from "zod";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export const websiteEventNames = [
  "page_viewed",
  "start_search_clicked",
  "dashboard_opened",
  "email_preview_opened",
  "search_submitted",
  "search_submission_failed",
  "feedback_opened",
  "feedback_submitted"
] as const;

export const websiteEventInputSchema = z.object({
  name: z.enum(websiteEventNames),
  page: z.string().trim().max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const websiteFeedbackInputSchema = z
  .object({
    sentiment: z.enum(["like", "dislike", "broken"]),
    message: z.string().trim().max(2000).optional().default(""),
    page: z.string().trim().max(500).optional(),
    contactEmail: z
      .string()
      .trim()
      .toLowerCase()
      .email("Use a valid email")
      .optional()
      .or(z.literal("").transform(() => undefined))
  })
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

export type WebsiteEventInput = z.infer<typeof websiteEventInputSchema>;
export type WebsiteFeedbackInput = z.infer<typeof websiteFeedbackInputSchema>;

export async function createWebsiteEvent(input: WebsiteEventInput) {
  const event = websiteEventInputSchema.parse(input);

  return prisma.websiteEvent.create({
    data: {
      name: event.name,
      page: event.page,
      metadata: event.metadata as Prisma.InputJsonObject | undefined
    }
  });
}

export async function submitWebsiteFeedback(input: WebsiteFeedbackInput) {
  const feedback = websiteFeedbackInputSchema.parse(input);

  return prisma.websiteFeedback.create({
    data: {
      sentiment: feedback.sentiment.toUpperCase() as "LIKE" | "DISLIKE" | "BROKEN",
      message: feedback.message,
      page: feedback.page,
      contactEmail: feedback.contactEmail
    }
  });
}
