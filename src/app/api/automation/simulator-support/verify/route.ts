import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertAutomationRequest } from "@/lib/api/automation-auth";
import { hasDatabaseConfig } from "@/lib/env";
import { getAutomationRuntimeVersion } from "@/lib/automation/runtime-version";
import { runSimulatorEngineeringVerification } from "@/lib/automation/simulator-support-engineering-verification";
import { classifySimulatorEngineeringVerificationFailure } from "@/lib/automation/simulator-support-engineering-verification-policy";

export const runtime = "nodejs";
export const maxDuration = 180;

const inputSchema = z.object({ assignmentRef: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
  token: z.string().min(1).max(128), revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict();

export async function POST(request: NextRequest) {
  const denied = assertAutomationRequest(request);
  if (denied) return denied;
  if (!hasDatabaseConfig()) return NextResponse.json({ error: "Simulator verification is temporarily unavailable." }, { status: 503 });
  const input = inputSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return NextResponse.json({ error: "Invalid simulator verification request." }, { status: 400 });
  const runtimeVersion = getAutomationRuntimeVersion();
  if (process.env.VERCEL_ENV !== "production" || !/^[a-f0-9]{40}$/u.test(runtimeVersion) ||
      !process.env.VERCEL_DEPLOYMENT_ID || !process.env.VERCEL_URL ||
      !["teetimespot.com", "www.teetimespot.com"].includes(request.nextUrl.hostname)) {
    return NextResponse.json({ error: "Simulator verification requires the current production release." }, { status: 503 });
  }
  try {
    const result = await runSimulatorEngineeringVerification(input.data, { runtimeVersion,
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID, deploymentUrl: `https://${process.env.VERCEL_URL}`,
      environment: process.env.VERCEL_ENV, host: request.nextUrl.hostname });
    return NextResponse.json(result);
  } catch (error) {
    // Owner/source/runtime fences and underlying errors are never public tokens or provider response bodies.
    const code = classifySimulatorEngineeringVerificationFailure(error);
    return NextResponse.json({ error: "Simulator verification could not complete; inspect the original worker before continuing.", code },
      { status: code === "VERIFICATION_FAILED" ? 503 : 409 });
  }
}
