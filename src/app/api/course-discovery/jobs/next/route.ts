import { NextRequest } from "next/server";
import { z } from "zod";
import { claimNextDiscoveryJob } from "@/lib/course-discovery/service";
import { discoveryRequest } from "../../_shared";

const schema = z.object({ workerId: z.string().min(3).max(100).regex(/^[a-zA-Z0-9._-]+$/u) }).strict();
export async function POST(request: NextRequest) {
  return discoveryRequest(request, schema, async ({ workerId }) => ({ job: await claimNextDiscoveryJob(workerId) }));
}
