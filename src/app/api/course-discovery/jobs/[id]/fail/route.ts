import { NextRequest } from "next/server";
import { z } from "zod";
import { failDiscoveryJob } from "@/lib/course-discovery/service";
import { discoveryRequest, jobIdSchema, leaseBodySchema } from "../../../_shared";
import { parseWorkerTerminalDiagnostic } from "../../../../../../../scripts/automation/course-discovery-terminal-diagnostic.mjs";
import type { WorkerTerminalDiagnostic } from "../../../../../../../scripts/automation/course-discovery-terminal-diagnostic.d.mts";

const schema = leaseBodySchema.extend({ reason: z.enum(["TOOL_FAILURE", "UNSUPPORTED", "ACCESS_REQUIRED", "DEADLINE", "CANCELLED"]), retryable: z.boolean().default(false),
  terminalDiagnostic: z.custom<WorkerTerminalDiagnostic>(value => Boolean(parseWorkerTerminalDiagnostic(value))).optional() }).strict();
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return discoveryRequest(request, schema, async ({ leaseToken, reason, retryable, terminalDiagnostic }) => ({ job: await failDiscoveryJob(jobIdSchema.parse((await context.params).id), leaseToken, reason, retryable, terminalDiagnostic) }));
}
