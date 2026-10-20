import { NextRequest } from "next/server";
import { heartbeatDiscoveryJob } from "@/lib/course-discovery/service";
import { discoveryRequest, jobIdSchema, leaseBodySchema } from "../../../_shared";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return discoveryRequest(request, leaseBodySchema, async ({ leaseToken }) => ({ job: await heartbeatDiscoveryJob(jobIdSchema.parse((await context.params).id), leaseToken) }));
}
