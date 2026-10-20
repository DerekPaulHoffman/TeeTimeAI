import { prisma } from "@/lib/prisma";
import { queueSearchCheck, requestSearchRecheck } from "@/lib/automation/db-service";
import { consumeSearchScheduleQueueMessage } from "@/lib/automation/search-schedule-consumer";
import { recoverSearchScheduleStartFailure } from "@/lib/automation/search-recheck-queue";
import { isDiscoveryPilotSearch } from "./config";
import { attachRecipeResumeVersion } from "./runtime";
import type { DiscoveryTarget } from "./service";

/** Called only in the deployed API runtime. Local Codex never starts a Workflow. */
export async function queueDiscoverySearchRecheck(searchId: string, executionJobId?: string) {
  if (!await isDiscoveryPilotSearch(searchId)) return false;
  const current = await prisma.teeSearch.findUnique({ where: { id: searchId } });
  if (!current || current.status !== "ACTIVE") return false;
  if (current.checkStatus === "CHECKING" || current.checkStatus === "QUEUED") {
    // Also repairs a crash after queueing the new version but before the
    // completed proof was attached to it. The helper rechecks demand identity.
    if (executionJobId) await attachRecipeResumeVersion(executionJobId, current.scheduleVersion, current.id);
    await requestSearchRecheck(current.id, current.scheduleVersion);
    return true;
  }
  if (current.checkStatus !== "WAITING") return false;
  const queued = await queueSearchCheck(current.id, undefined, { scheduleVersion: current.scheduleVersion,
    updatedAt: current.updatedAt, observedAt: new Date(), checkStatus: "WAITING", workflowRunId: current.workflowRunId });
  if (!queued || "outcome" in queued) return false;
  // Publish the resume version before Workflow can consume the completed result.
  if (executionJobId) await attachRecipeResumeVersion(executionJobId, queued.scheduleVersion, current.id);
  const message = { searchId: queued.id, scheduleVersion: queued.scheduleVersion, trigger: "COURSE_REMEDIATED" as const };
  try { await consumeSearchScheduleQueueMessage(message); }
  catch { await recoverSearchScheduleStartFailure(message); }
  return true;
}

export async function queueDiscoveryTargetRechecks(target: DiscoveryTarget) {
  const preferences = await prisma.coursePreference.findMany({ where: { courseId: target.courseId,
    ...(target.offeringId ? { offeringId: target.offeringId } : { offeringId: null }), teeSearch: { status: "ACTIVE" } }, select: { teeSearchId: true } });
  let queued = 0;
  for (const id of new Set(preferences.map(preference => preference.teeSearchId))) {
    if (await queueDiscoverySearchRecheck(id)) queued++;
  }
  return { queued };
}
