import { z } from "zod";
import type { CourseCandidate } from "@/lib/places/google";

export const recoveryInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  town: z.string().trim().min(2).max(120),
  address: z.string().trim().min(3).max(200).optional(),
  officialWebsite: z.string().trim().url().max(500).refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash &&
      ![...url.searchParams.keys()].some(key => /token|session|(?:^|[_-])code(?:$|[_-])|api.?key|auth|sig(?:nature)?|password|credential|secret/iu.test(key));
  }, "Use the public official website without credentials.").optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
}).strict().refine(value => (value.latitude === undefined) === (value.longitude === undefined), {
  message: "Provide both coordinates together.",
});

export type RecoveryInput = z.infer<typeof recoveryInputSchema>;
export type RecoveryStatus = "QUEUED" | "INVESTIGATING" | "RETRY_WAIT" | "VERIFIED" | "NEEDS_DETAILS" | "NOT_PUBLIC" | "UNRESOLVED" | "ACCESS_LIMITED";
export type RecoveryInvestigation = {
  status: "VERIFIED";
  course: CourseCandidate & { website: string; publicAccessStatus: "PUBLIC" };
  bookingUrl: string | null;
  evidenceUrl: string;
  evidenceSummary: string;
} | {
  status: "NEEDS_DETAILS" | "NOT_PUBLIC" | "UNRESOLVED" | "ACCESS_LIMITED";
  reason: string;
  evidenceUrl?: string;
  evidenceSummary: string;
};

export type RecoveryView = {
  id: string;
  status: RecoveryStatus;
  message: string;
  question: string | null;
  course: CourseCandidate | null;
  nextAttemptAt: string | null;
  officialSiteUrl?: string | null;
};

export type RecoveryWorkflowInput = { requestId: string; revision: number; leaseToken: string };
export const RECOVERY_LEASE_MS = 5 * 60 * 1000;
export const RECOVERY_RETRY_MS = [2 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
export const RECOVERY_MAX_ATTEMPTS = 5;
export const RECOVERY_MAX_DUE = 4;
