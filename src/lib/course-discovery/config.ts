import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";

type PilotReader = Pick<Prisma.TransactionClient, "courseDiscoveryPilotEnrollment" | "teeSearch">;

/** GENERAL is a deliberate post-acceptance switch. Missing configuration keeps
 * the bounded pilot behavior; an unknown mode never broadens admission. */
export function isGeneralDiscoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COURSE_DISCOVERY_ENABLED === "true" && env.COURSE_DISCOVERY_ROLLOUT_MODE === "GENERAL";
}

function isPilotRollout(env: NodeJS.ProcessEnv) {
  return env.COURSE_DISCOVERY_ROLLOUT_MODE === undefined || env.COURSE_DISCOVERY_ROLLOUT_MODE === "PILOT";
}

const realDemandWhere = { trafficClass: { notIn: ["TEST", "AUTOMATION"] }, syntheticMultiCycle: false,
  mode: { in: ["OUTDOOR", "SIMULATOR"] } } satisfies Prisma.TeeSearchWhereInput;

/** Rollout is off until the runtime and either bounded pilot or explicit general mode are prepared. */
export function discoveryPilotSearchIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = (env.COURSE_DISCOVERY_PILOT_SEARCH_IDS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (values.length > 3 || values.some(value => !/^[A-Za-z0-9_-]{1,128}$/u.test(value))) return [];
  return [...new Set(values)];
}

export type AutomaticDiscoveryPilot = { ownerUserId: string; targetKeys: string[]; cohortId: string; runId?: string };
export type DiscoveryPilotTargetSearch = { mode: string; preferences: Array<{
  courseId: string; offeringId?: string | null; course?: { googlePlaceId: string | null } | null;
}> };

/** Explicit search IDs retain precedence; the two enrollment modes never add up. */
export function automaticDiscoveryPilot(env: NodeJS.ProcessEnv = process.env): AutomaticDiscoveryPilot | null {
  if (env.COURSE_DISCOVERY_ENABLED !== "true" || !isPilotRollout(env) || env.COURSE_DISCOVERY_PILOT_SEARCH_IDS?.trim()) return null;
  const ownerUserId = env.COURSE_DISCOVERY_PILOT_OWNER_USER_ID?.trim() ?? "";
  const runId = env.COURSE_DISCOVERY_PILOT_RUN_ID?.trim() ?? "";
  const targetKeys = (env.COURSE_DISCOVERY_PILOT_TARGET_KEYS ?? "").split(",").map(value => value.trim()).filter(Boolean).sort();
  if (runId && !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(runId)) return null;
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(ownerUserId) || targetKeys.length !== 3 || new Set(targetKeys).size !== 3 ||
    targetKeys.some(key => !/^(?:(?:course|offering):[A-Za-z0-9_-]{1,128}|place:[A-Za-z0-9_-]{1,256}:(?:OUTDOOR|SIMULATOR))$/u.test(key))) return null;
  // An operator may name a new, separately recorded three-alert experiment.
  // Omit the property entirely for existing deployments to retain their hash.
  const cohortId = createHash("sha256").update(JSON.stringify({ ownerUserId, targetKeys, ...(runId ? { runId } : {}) })).digest("hex");
  return { ownerUserId, targetKeys, cohortId, ...(runId ? { runId } : {}) };
}

async function readerOrDefault(reader?: PilotReader): Promise<PilotReader> {
  return reader ?? (await import("@/lib/prisma")).prisma;
}
/** One resolved preference must match exactly one configured identity. An
 * internal ID and a place alias for the same preference cannot consume two slots. */
export function matchingDiscoveryPilotTargetKey(search: DiscoveryPilotTargetSearch, configuredKeys: readonly string[]) {
  if (!["OUTDOOR", "SIMULATOR"].includes(search.mode) || search.preferences.length !== 1) return null;
  const target = search.preferences[0];
  if ((search.mode === "SIMULATOR") !== Boolean(target.offeringId)) return null;
  const keys = [target.offeringId ? `offering:${target.offeringId}` : `course:${target.courseId}`];
  if (target.course?.googlePlaceId) keys.push(`place:${target.course.googlePlaceId}:${search.mode}`);
  const matches = configuredKeys.filter(key => keys.includes(key));
  return matches.length === 1 ? matches[0] : null;
}

export async function isDiscoveryPilotSearch(searchId: string, env: NodeJS.ProcessEnv = process.env, reader?: PilotReader): Promise<boolean> {
  if (env.COURSE_DISCOVERY_ENABLED !== "true") return false;
  if (isGeneralDiscoveryEnabled(env)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(searchId)) return false;
    const client = await readerOrDefault(reader);
    return Boolean(await client.teeSearch.findFirst({ where: { id: searchId, ...realDemandWhere }, select: { id: true } }));
  }
  if (!isPilotRollout(env)) return false;
  if (env.COURSE_DISCOVERY_PILOT_SEARCH_IDS?.trim()) return discoveryPilotSearchIds(env).includes(searchId);
  const pilot = automaticDiscoveryPilot(env);
  if (!pilot) return false;
  const client = await readerOrDefault(reader);
  const enrolled = await client.courseDiscoveryPilotEnrollment.findUnique({ where: { searchId },
    select: { cohortId: true, ownerUserId: true, targetKey: true } });
  if (!enrolled || enrolled.cohortId !== pilot.cohortId || enrolled.ownerUserId !== pilot.ownerUserId || !pilot.targetKeys.includes(enrolled.targetKey)) return false;
  const search = await client.teeSearch.findFirst({ where: { id: searchId, userId: pilot.ownerUserId,
    trafficClass: { notIn: ["TEST", "AUTOMATION"] }, syntheticMultiCycle: false },
    select: { id: true, mode: true, preferences: { select: { courseId: true, offeringId: true, course: { select: { googlePlaceId: true } } } } } });
  return Boolean(search && matchingDiscoveryPilotTargetKey(search, pilot.targetKeys) === enrolled.targetKey);
}

/** Current existing searches only; quota receipts themselves are never deleted. */
export async function activeDiscoveryPilotSearchIds(env: NodeJS.ProcessEnv = process.env, reader?: PilotReader): Promise<string[]> {
  if (env.COURSE_DISCOVERY_ENABLED !== "true") return [];
  if (isGeneralDiscoveryEnabled(env)) {
    const client = await readerOrDefault(reader);
    const rows = await client.teeSearch.findMany({ where: { status: "ACTIVE", ...realDemandWhere }, select: { id: true } });
    return rows.map(row => row.id);
  }
  if (!isPilotRollout(env)) return [];
  if (env.COURSE_DISCOVERY_PILOT_SEARCH_IDS?.trim()) return discoveryPilotSearchIds(env);
  const pilot = automaticDiscoveryPilot(env);
  if (!pilot) return [];
  const client = await readerOrDefault(reader);
  const enrolled = await client.courseDiscoveryPilotEnrollment.findMany({ where: { cohortId: pilot.cohortId,
    ownerUserId: pilot.ownerUserId, targetKey: { in: pilot.targetKeys } }, select: { searchId: true, targetKey: true }, take: 3 });
  if (!enrolled.length) return [];
  const searches = await client.teeSearch.findMany({ where: { id: { in: enrolled.map(row => row.searchId) }, userId: pilot.ownerUserId,
    trafficClass: { notIn: ["TEST", "AUTOMATION"] }, syntheticMultiCycle: false },
    select: { id: true, mode: true, preferences: { select: { courseId: true, offeringId: true, course: { select: { googlePlaceId: true } } } } } });
  const targetBySearch = new Map(enrolled.map(row => [row.searchId, row.targetKey]));
  return searches.filter(row => matchingDiscoveryPilotTargetKey(row, pilot.targetKeys) === targetBySearch.get(row.id)).map(row => row.id);
}

export function isCourseDiscoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isGeneralDiscoveryEnabled(env) || env.COURSE_DISCOVERY_ENABLED === "true" && isPilotRollout(env) &&
    (discoveryPilotSearchIds(env).length > 0 || automaticDiscoveryPilot(env) !== null);
}
