import { NextRequest } from "next/server";
import { z } from "zod";
import { completeRecipeExecution, recipeExecutionNeedsRepair } from "@/lib/course-discovery/runtime";
import { queueDiscoverySearchRecheck } from "@/lib/course-discovery/integration";
import { accessExecutionResultSchema } from "@/lib/course-discovery/recipe";
import { degradeRecipe } from "@/lib/course-discovery/service";
import { discoveryRequest, jobIdSchema } from "../../../_shared";

export const runtime = "nodejs";
const schema = z.object({ leaseToken: z.string().uuid(), result: accessExecutionResultSchema }).strict();
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return discoveryRequest(request, schema, async ({ leaseToken, result }) => {
    const id = jobIdSchema.parse((await context.params).id);
    const completed = await completeRecipeExecution(id, leaseToken, result);
    if (recipeExecutionNeedsRepair(result)) await degradeRecipe(completed.target, completed.recipeId);
    let recheckQueued = false;
    try { recheckQueued = await queueDiscoverySearchRecheck(completed.searchId, id); } catch { /* Durable evidence remains available to Workflow recovery. */ }
    return { completed: true, recheckQueued };
  });
}
