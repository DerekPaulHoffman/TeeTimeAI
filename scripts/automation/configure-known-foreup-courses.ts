import "./load-local-env";

import { prisma } from "@/lib/prisma";

const knownForeupCourses = [
  {
    name: "Longshore Golf Course",
    detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/23148/12897#/teetimes",
    policyNotes:
      "Official tee-times page says all tee times must be booked online; ForeUp Guests (Public) booking class exposes alert-only public inventory.",
    bookingMetadata: {
      scheduleId: 12897,
      bookingClassId: 52697,
      bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/23148/12897#/teetimes"
    }
  },
  {
    name: "Oak Hills Park Golf Course",
    detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
    policyNotes:
      "Official site says public tee time reservations can be made online 8 days in advance; alert-only polling only.",
    bookingMetadata: {
      scheduleId: 11739,
      bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes"
    }
  }
];

async function main() {
  const results = [];

  for (const course of knownForeupCourses) {
    const result = await prisma.course.updateMany({
      where: { name: course.name },
      data: {
        detectedPlatform: "FOREUP",
        automationEligibility: "ALLOWED",
        bookingMethod: "PUBLIC_ONLINE",
        automationReason: "NONE",
        intelligenceVerifiedAt: new Date(),
        intelligenceConfidence: 1,
        detectedBookingUrl: course.detectedBookingUrl,
        policyNotes: course.policyNotes,
        bookingMetadata: course.bookingMetadata
      }
    });

    results.push({ name: course.name, updated: result.count });
  }

  console.log(JSON.stringify({ results }, null, 2));
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
