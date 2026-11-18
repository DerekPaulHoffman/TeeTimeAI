import { NextRequest } from "next/server";
import { z } from "zod";
import { claimNextDiscoveryJob } from "@/lib/course-discovery/service";
import { discoveryRequest } from "../../_shared";

const schema = z.object({ workerId: z.string().min(3).max(100).regex(/^[a-zA-Z0-9._-]+$/u),
  runtimeVersion: z.string().regex(/^[a-f0-9]{40}$/u).optional() }).strict();
export async function POST(request: NextRequest) {
  return discoveryRequest(request, schema, async ({ workerId, runtimeVersion }) => ({ job: await claimNextDiscoveryJob(workerId, runtimeVersion) }));
}
