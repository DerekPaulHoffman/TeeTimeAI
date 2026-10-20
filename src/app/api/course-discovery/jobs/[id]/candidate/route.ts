import { NextRequest } from "next/server";
import { z } from "zod";
import { discoverySourceEvidenceSchema, proposeDiscoveryRecipe } from "@/lib/course-discovery/service";
import { discoveryRequest, jobIdSchema, leaseBodySchema } from "../../../_shared";

const schema = leaseBodySchema.extend({ recipe: z.unknown(), sourceEvidence: discoverySourceEvidenceSchema.optional() }).strict();
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return discoveryRequest(request, schema, async ({ leaseToken, recipe, sourceEvidence }) =>
    proposeDiscoveryRecipe(jobIdSchema.parse((await context.params).id), leaseToken, recipe, sourceEvidence));
}
