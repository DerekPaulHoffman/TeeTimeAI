import { NextRequest } from "next/server";
import { z } from "zod";
import { recordDiscoveryVerification } from "@/lib/course-discovery/service";
import { accessExecutionInputSchema, accessExecutionResultSchema } from "@/lib/course-discovery/recipe";
import { discoveryRequest, jobIdSchema, leaseBodySchema } from "../../../../_shared";

const schema = leaseBodySchema.extend({ recipeHash: z.string().regex(/^[a-f0-9]{64}$/u), input: accessExecutionInputSchema, result: accessExecutionResultSchema }).strict();
export async function POST(request: NextRequest, context: { params: Promise<{ id: string; challengeId: string }> }) {
  return discoveryRequest(request, schema, async body => {
    const { id, challengeId } = await context.params;
    return recordDiscoveryVerification({ ...body, jobId: jobIdSchema.parse(id), challengeId: z.string().uuid().parse(challengeId) });
  });
}
