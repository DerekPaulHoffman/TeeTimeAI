import { NextRequest } from "next/server";
import { z } from "zod";
import { checkpointDiscoveryJob } from "@/lib/course-discovery/service";
import { discoveryRequest, jobIdSchema, leaseBodySchema } from "../../../_shared";

const schema = leaseBodySchema.extend({ checkpoint: z.json() }).strict();
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return discoveryRequest(request, schema, async ({ leaseToken, checkpoint }) => ({ job: await checkpointDiscoveryJob(jobIdSchema.parse((await context.params).id), leaseToken, checkpoint) }));
}
