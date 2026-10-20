import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { claimProviderRequestLease, releaseProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { DiscoveryConflictError } from "@/lib/course-discovery/service";
import { discoveryRequest, jobIdSchema } from "../_shared";

export const runtime = "nodejs";
const family = z.string().min(1).max(253).regex(/^[A-Za-z0-9._-]+$/u);
const lease = z.object({ providerFamilyKey: family, globalSlot: z.number().int().min(0).max(1), leaseToken: z.string().uuid() }).strict();
const schema = z.object({ jobId: jobIdSchema, jobKind: z.enum(["discovery", "execution"]), jobLeaseToken: z.string().uuid(),
  action: z.enum(["acquire", "release"]), providerFamily: family.optional(), lease: lease.optional() }).strict();
export async function POST(request: NextRequest) {
  return discoveryRequest(request, schema, async input => {
    const row = input.jobKind === "discovery"
      ? await prisma.courseDiscoveryJob.findUnique({ where: { id: input.jobId } })
      : await prisma.localReaderJob.findFirst({ where: { id: input.jobId, purpose: "RECIPE_CHECK" } });
    if (!row || row.leaseToken !== input.jobLeaseToken) throw new DiscoveryConflictError();
    if (input.action === "release") {
      if (!input.lease) throw new DiscoveryConflictError();
      await releaseProviderRequestLease(input.lease);
      return { released: true };
    }
    if (!input.providerFamily || !row.leaseExpiresAt || row.leaseExpiresAt <= new Date() || !["RUNNING", "LEASED"].includes(row.status)) throw new DiscoveryConflictError();
    return { lease: await claimProviderRequestLease(input.providerFamily) };
  });
}
