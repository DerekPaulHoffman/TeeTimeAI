import { NextRequest } from "next/server";
import { z } from "zod";
import { discoverySourceEvidenceSchema, discoveryVerificationDurationSchema, proposeDiscoveryRecipe } from "@/lib/course-discovery/service";
import { discoveryRequest, jobIdSchema, leaseBodySchema } from "../../../_shared";

const schema = leaseBodySchema.extend({ recipe: z.unknown(), sourceEvidence: discoverySourceEvidenceSchema.optional(),
  verificationDurationMinutes: discoveryVerificationDurationSchema.optional() }).strict();
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return discoveryRequest(request, schema, async ({ leaseToken, recipe, sourceEvidence, verificationDurationMinutes }) => {
    const id = jobIdSchema.parse((await context.params).id);
    return verificationDurationMinutes === undefined ? proposeDiscoveryRecipe(id, leaseToken, recipe, sourceEvidence)
      : proposeDiscoveryRecipe(id, leaseToken, recipe, sourceEvidence, verificationDurationMinutes);
  });
}
