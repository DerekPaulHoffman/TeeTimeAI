import "./load-local-env";

import { getLocalReaderCourseKey } from "@/lib/local-reader/course-key";
import { queueLocalReaderCourseVerification } from "@/lib/local-reader/service";
import { prisma } from "@/lib/prisma";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const targetDate = readRequiredOption(args, "--target-date");
  const players = Number(readOption(args, "--players") ?? "1");
  const excludedKeys = new Set(readOptions(args, "--exclude-key"));
  const onlyKeys = new Set(readOptions(args, "--only-key"));
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(targetDate)) {
    throw new Error("--target-date must use YYYY-MM-DD.");
  }
  if (!Number.isInteger(players) || players < 1 || players > 4) {
    throw new Error("--players must be an integer from 1 through 4.");
  }

  const courses = await prisma.course.findMany({
    where: {
      bookingAccessMode: "CAPTCHA_OR_QUEUE",
      detectedBookingUrl: { not: null }
    },
    select: {
      id: true,
      detectedBookingUrl: true
    }
  });
  const eligible = courses
    .map((course) => {
      const bookingUrl = course.detectedBookingUrl ?? "";
      return {
        id: course.id,
        bookingUrl,
        courseKey: getLocalReaderCourseKey(bookingUrl)
      };
    })
    .filter(
      (
        course
      ): course is typeof course & {
        courseKey: NonNullable<typeof course.courseKey>;
      } =>
        course.courseKey !== null &&
        !excludedKeys.has(course.courseKey) &&
        (onlyKeys.size === 0 || onlyKeys.has(course.courseKey))
    );

  let queued = 0;
  if (apply) {
    for (const course of eligible) {
      const job = await queueLocalReaderCourseVerification({
        courseId: course.id,
        targetDate,
        players,
        bookingUrl: course.bookingUrl
      });
      if (job) queued += 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry_run",
        targetDate,
        players,
        eligibleCount: eligible.length,
        queuedCount: queued,
        excludedCount: courses.length - eligible.length
      },
      null,
      2
    )
  );
}

function readRequiredOption(args: string[], name: string) {
  const value = readOption(args, name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function readOption(args: string[], name: string) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1]?.trim();
}

function readOptions(args: string[], name: string) {
  return args.flatMap((value, index) =>
    value === name && args[index + 1]?.trim() ? [args[index + 1].trim()] : []
  );
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch((error) => {
    console.error(
      JSON.stringify({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "LOCAL_READER_VERIFICATION_FAILED"
      })
    );
    process.exitCode = 1;
  });
