import { NextRequest } from "next/server";
import { activateDiscoveryRecipe } from "@/lib/course-discovery/service";
import { queueDiscoveryTargetRechecks } from "@/lib/course-discovery/integration";
import { discoveryRequest, jobIdSchema, leaseBodySchema } from "../../../_shared";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return discoveryRequest(request, leaseBodySchema, async ({ leaseToken }) => {
    const activated = await activateDiscoveryRecipe(jobIdSchema.parse((await context.params).id), leaseToken);
    try { const recheck = await queueDiscoveryTargetRechecks(activated.target); return { ...activated, recheckQueued: recheck.queued > 0 }; }
    catch { return { ...activated, recheckQueued: false }; }
  });
}
