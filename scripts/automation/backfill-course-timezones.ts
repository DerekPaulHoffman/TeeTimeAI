import "./load-local-env";

import { pathToFileURL } from "node:url";

import { prisma } from "@/lib/prisma";
import { getTimeZoneForCoordinates } from "@/lib/timezones";

export async function backfillCourseTimeZones() {
  const courses = await prisma.course.findMany({
    select: {
      id: true,
      latitude: true,
      longitude: true,
      timeZone: true
    }
  });
  let updated = 0;

  for (const course of courses) {
    const timeZone = getTimeZoneForCoordinates(course.latitude, course.longitude);
    if (timeZone === course.timeZone) {
      continue;
    }

    await prisma.course.update({
      where: { id: course.id },
      data: { timeZone }
    });
    updated += 1;
  }

  return { inspected: courses.length, updated };
}

async function main() {
  console.log(JSON.stringify(await backfillCourseTimeZones(), null, 2));
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
