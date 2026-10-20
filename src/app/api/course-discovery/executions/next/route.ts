import { NextRequest } from "next/server";
import { z } from "zod";
import { claimNextRecipeExecution } from "@/lib/course-discovery/runtime";
import { discoveryRequest } from "../../_shared";

export const runtime = "nodejs";
const schema = z.object({ workerId: z.string().min(3).max(100).regex(/^[A-Za-z0-9._-]+$/u) }).strict();
export async function POST(request: NextRequest) {
  return discoveryRequest(request, schema, async ({ workerId }) => ({ job: await claimNextRecipeExecution(workerId) }));
}
