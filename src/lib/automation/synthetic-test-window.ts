import type { WebsiteTrafficClass } from "@prisma/client";
import { z } from "zod";

import { isSyntheticWebsiteTrafficClass } from "@/lib/engagement/traffic-class";

export const SYNTHETIC_MULTI_CYCLE_LIFETIME_MS = 18 * 60 * 60 * 1000;
export const DEFAULT_SYNTHETIC_TEST_WINDOW_MINUTES = 60;

const canonicalTimestamp = z.string().refine((value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
});

export const syntheticTestWindowSchema = z.object({
  schemaVersion: z.literal(1),
  alertGeneration: z.number().int().nonnegative().safe(),
  activatedAt: canonicalTimestamp,
  expiresAt: canonicalTimestamp,
}).strict().refine((window) => {
  const duration = Date.parse(window.expiresAt) - Date.parse(window.activatedAt);
  return duration > 0 && duration <= SYNTHETIC_MULTI_CYCLE_LIFETIME_MS;
});

export type SyntheticTestWindow = z.infer<typeof syntheticTestWindowSchema>;

export function getSyntheticMultiCycleExpiresAt(timing: {
  createdAt: Date;
  trafficClass: WebsiteTrafficClass;
  syntheticMultiCycle: boolean;
  alertGeneration?: number;
  syntheticTestWindow?: unknown;
}, now = new Date()): Date | null {
  if (!isSyntheticWebsiteTrafficClass(timing.trafficClass) || !timing.syntheticMultiCycle) {
    return null;
  }
  if (!Number.isFinite(timing.createdAt.getTime()) || !Number.isFinite(now.getTime())) {
    return new Date(0);
  }
  const originalExpiry = new Date(timing.createdAt.getTime() + SYNTHETIC_MULTI_CYCLE_LIFETIME_MS);
  if (timing.syntheticTestWindow === null || timing.syntheticTestWindow === undefined) {
    return originalExpiry;
  }
  const parsed = syntheticTestWindowSchema.safeParse(timing.syntheticTestWindow);
  if (!parsed.success) return new Date(0);
  const activatedAt = new Date(parsed.data.activatedAt);
  if (activatedAt < timing.createdAt || activatedAt > now) return new Date(0);
  // Ordinary edits increment alertGeneration, but never renew operator authority.
  if (parsed.data.alertGeneration !== timing.alertGeneration) return originalExpiry;
  return new Date(parsed.data.expiresAt);
}
