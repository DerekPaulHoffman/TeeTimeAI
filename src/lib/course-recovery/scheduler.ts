import { start } from "workflow/api";
import { prisma } from "@/lib/prisma";
import { courseRecoveryWorkflow } from "@/workflows/course-recovery";
import { activateVerifiedRecoveryDemands, expireRecoveryDemands } from "./demand";
import { claimRecoveryRequest, failRecoveryAttempt, listDueRecoveryRequests } from "./service";

export async function startRecoveryRequest(id: string) {
  const claim = await claimRecoveryRequest(id);
  if (!claim) return "skipped" as const;
  try {
    const run = await start(courseRecoveryWorkflow, [claim]);
    await prisma.courseRecoveryRequest.updateMany({ where: { id, revision: claim.revision,
      status: "INVESTIGATING", leaseToken: claim.leaseToken }, data: { workflowRunId: run.runId } });
    return "started" as const;
  } catch {
    await failRecoveryAttempt(claim);
    return "failed" as const;
  }
}

export async function recoverDueCourseRecovery() {
  const demandCloseout = await expireRecoveryDemands();
  const due = await listDueRecoveryRequests();
  let started = 0;
  let failed = 0;
  let skipped = 0;
  for (const request of due) {
    try {
      const outcome = await startRecoveryRequest(request.id);
      if (outcome === "started") started += 1;
      else if (outcome === "failed") failed += 1;
      else skipped += 1;
    } catch { failed += 1; }
  }
  const pending = await prisma.courseRecoveryRequest.findMany({ where: { status: "VERIFIED",
    demands: { some: { status: "WAITING" } } }, take: 4, orderBy: { createdAt: "asc" }, select: { id: true } });
  for (const request of pending) {
    try { await activateVerifiedRecoveryDemands(request.id); } catch { failed += 1; }
  }
  return { considered: due.length, started, skipped, failed, demandRequestsConsidered: pending.length, demandCloseout };
}
