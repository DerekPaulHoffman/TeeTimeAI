import "../automation/load-local-env";

import { prisma } from "@/lib/prisma";

const email = `codex-fivecourse-${Date.now()}@example.com`;

async function main() {
  const sourceSearch = await prisma.teeSearch.findFirst({
    where: {
      status: "ACTIVE",
      preferences: {
        some: {}
      }
    },
    orderBy: {
      createdAt: "desc"
    },
    include: {
      preferences: {
        orderBy: { rank: "asc" },
        take: 5,
        include: { course: true }
      }
    }
  });

  if (!sourceSearch || sourceSearch.preferences.length < 5) {
    throw new Error("No existing active five-course search is available to clone.");
  }

  const user = await prisma.user.upsert({
    where: { clerkUserId: `guest:${email}` },
    update: { email },
    create: {
      clerkUserId: `guest:${email}`,
      email
    }
  });

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  const search = await prisma.teeSearch.create({
    data: {
      userId: user.id,
      date: tomorrow,
      startTime: sourceSearch.startTime,
      endTime: sourceSearch.endTime,
      players: sourceSearch.players,
      cadenceMinutes: sourceSearch.cadenceMinutes,
      preferences: {
        create: sourceSearch.preferences.map((preference, index) => ({
          rank: index + 1,
          courseId: preference.courseId
        }))
      }
    },
    include: {
      preferences: {
        orderBy: { rank: "asc" },
        include: { course: true }
      }
    }
  });

  console.log(
    JSON.stringify(
      {
        email,
        searchId: search.id,
        date: search.date.toISOString().slice(0, 10),
        window: `${search.startTime}-${search.endTime}`,
        players: search.players,
        courses: search.preferences.map((preference) => ({
          rank: preference.rank,
          courseId: preference.courseId,
          name: preference.course.name,
          platform: preference.course.detectedPlatform,
          eligibility: preference.course.automationEligibility,
          hasBookingMetadata: preference.course.bookingMetadata !== null
        }))
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
