import { Prisma } from "@prisma/client";

import type { EmailStopReason } from "@/lib/email/search-actions";
import { prisma } from "@/lib/prisma";

export async function getEmailStopSearchSummary(searchId: string) {
  return prisma.teeSearch.findUnique({
    where: { id: searchId },
    select: {
      id: true,
      date: true,
      startTime: true,
      endTime: true,
      players: true,
      status: true,
      preferences: {
        orderBy: { rank: "asc" },
        select: {
          rank: true,
          course: { select: { name: true } }
        }
      }
    }
  });
}

export async function stopTeeSearchFromEmail(searchId: string, reason: EmailStopReason) {
  return prisma.$transaction(async (transaction) => {
    const search = await transaction.teeSearch.findUnique({
      where: { id: searchId },
      select: { id: true, status: true }
    });

    if (!search) {
      return null;
    }

    if (search.status !== "ACTIVE" && search.status !== "PAUSED") {
      return { ...search, changed: false };
    }

    const status = reason === "booked" ? "COMPLETED" : "CANCELLED";
    const stoppedAt = new Date();
    const updated = await transaction.teeSearch.update({
      where: { id: searchId },
      data: {
        status,
        scheduleVersion: { increment: 1 },
        checkStatus: "STOPPED",
        nextCheckAt: null,
        workflowRunId: null,
        lastCheckOutcome:
          reason === "booked"
            ? "Stopped from email after the golfer booked."
            : "Cancelled from an email alert."
      },
      select: { id: true, status: true }
    });

    await transaction.teeTimeMatch.updateMany({
      where: {
        teeSearchId: searchId,
        alertStatus: "PENDING"
      },
      data: {
        alertStatus: "SUPPRESSED",
        sentAt: stoppedAt
      }
    });

    await transaction.websiteEvent.create({
      data: {
        name: reason === "booked" ? "search_stopped_booked" : "search_stopped_cancelled",
        page: "/alerts/stop",
        metadata: {
          searchId,
          reason
        } satisfies Prisma.InputJsonObject
      }
    });

    return { ...updated, changed: true };
  });
}
