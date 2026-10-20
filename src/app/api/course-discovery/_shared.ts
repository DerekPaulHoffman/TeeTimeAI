import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hasDatabaseConfig } from "@/lib/env";
import { assertLocalReaderRequest } from "@/lib/local-reader/auth";
import { DiscoveryConflictError } from "@/lib/course-discovery/service";

export const leaseBodySchema = z.object({ leaseToken: z.string().uuid() }).strict();
export const jobIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/u);
export async function discoveryRequest<T>(request: NextRequest, schema: z.ZodType<T>, operation: (body: T) => Promise<unknown>) {
  const body = await request.text();
  const auth = assertLocalReaderRequest(request, body);
  if (auth) return auth;
  if (!hasDatabaseConfig()) return NextResponse.json({ error: "Course discovery is unavailable." }, { status: 503 });
  if (Buffer.byteLength(body, "utf8") > 131_072) return NextResponse.json({ error: "Invalid discovery request." }, { status: 400 });
  try {
    const result = await operation(schema.parse(JSON.parse(body)));
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const invalid = error instanceof z.ZodError || error instanceof SyntaxError;
    const conflict = error instanceof DiscoveryConflictError;
    return NextResponse.json({ error: invalid ? "Invalid discovery request." : conflict ? "Course discovery state changed." : "Course discovery is unavailable." },
      { status: invalid ? 400 : conflict ? 409 : 503, headers: { "cache-control": "no-store" } });
  }
}
