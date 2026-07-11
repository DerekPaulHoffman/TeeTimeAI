import { prisma } from "@/lib/prisma";

async function main() {
  const user = await prisma.user.upsert({
    where: { clerkUserId: "local-demo-user" },
    update: { email: "demo@teetimespot.local" },
    create: {
      clerkUserId: "local-demo-user",
      email: "demo@teetimespot.local"
    }
  });

  const tashua = await prisma.course.upsert({
    where: { googlePlaceId: "demo-tashua-knolls" },
    update: {
      detectedPlatform: "FOREUP",
      automationEligibility: "ALLOWED",
      bookingMethod: "PUBLIC_ONLINE",
      automationReason: "NONE",
      intelligenceVerifiedAt: new Date(),
      intelligenceConfidence: 1,
      detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/21017#/teetimes",
      bookingMetadata: {
        scheduleId: 6654,
        bookingClassId: 14910,
        bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/21017#/teetimes"
      }
    },
    create: {
      googlePlaceId: "demo-tashua-knolls",
      name: "Tashua Knolls Golf Course",
      address: "40 Tashua Knolls Ln, Trumbull, CT",
      latitude: 41.242,
      longitude: -73.209,
      rating: 4.4,
      website: "https://www.tashuaknolls.com",
      detectedPlatform: "FOREUP",
      automationEligibility: "ALLOWED",
      bookingMethod: "PUBLIC_ONLINE",
      automationReason: "NONE",
      intelligenceVerifiedAt: new Date(),
      intelligenceConfidence: 1,
      detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/21017#/teetimes",
      bookingMetadata: {
        scheduleId: 6654,
        bookingClassId: 14910,
        bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/21017#/teetimes"
      }
    }
  });

  const smith = await prisma.course.upsert({
    where: { googlePlaceId: "demo-smith-richardson" },
    update: {
      detectedPlatform: "FOREUP",
      automationEligibility: "ALLOWED",
      bookingMethod: "PUBLIC_ONLINE",
      automationReason: "NONE",
      intelligenceVerifiedAt: new Date(),
      intelligenceConfidence: 1,
      detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/21120/6992#/teetimes",
      bookingMetadata: {
        scheduleId: 6992,
        bookingClassId: 8436,
        bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/21120/6992#/teetimes"
      }
    },
    create: {
      googlePlaceId: "demo-smith-richardson",
      name: "H. Smith Richardson Golf Course",
      address: "2425 Morehouse Hwy, Fairfield, CT",
      latitude: 41.1906,
      longitude: -73.2704,
      rating: 4.3,
      website: "https://www.hsmithrichardsongolf.com",
      detectedPlatform: "FOREUP",
      automationEligibility: "ALLOWED",
      bookingMethod: "PUBLIC_ONLINE",
      automationReason: "NONE",
      intelligenceVerifiedAt: new Date(),
      intelligenceConfidence: 1,
      detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/21120/6992#/teetimes",
      bookingMetadata: {
        scheduleId: 6992,
        bookingClassId: 8436,
        bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/21120/6992#/teetimes"
      }
    }
  });

  await prisma.course.upsert({
    where: { googlePlaceId: "demo-oak-hills" },
    update: {
      detectedPlatform: "FOREUP",
      automationEligibility: "ALLOWED",
      bookingMethod: "PUBLIC_ONLINE",
      automationReason: "NONE",
      intelligenceVerifiedAt: new Date(),
      intelligenceConfidence: 1,
      detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
      policyNotes:
        "Official site says public tee time reservations can be made online 8 days in advance; alert-only polling only.",
      bookingMetadata: {
        scheduleId: 11739,
        bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes"
      }
    },
    create: {
      googlePlaceId: "demo-oak-hills",
      name: "Oak Hills Park Golf Course",
      address: "165 Fillow St, Norwalk, CT",
      latitude: 41.1151,
      longitude: -73.4394,
      rating: 4.2,
      phone: "(203) 838-0303",
      website: "https://www.oakhillsgc.com",
      detectedPlatform: "FOREUP",
      automationEligibility: "ALLOWED",
      bookingMethod: "PUBLIC_ONLINE",
      automationReason: "NONE",
      intelligenceVerifiedAt: new Date(),
      intelligenceConfidence: 1,
      detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes",
      policyNotes:
        "Official site says public tee time reservations can be made online 8 days in advance; alert-only polling only.",
      bookingMetadata: {
        scheduleId: 11739,
        bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes"
      }
    }
  });

  const date = new Date();
  date.setDate(date.getDate() + 7);
  date.setHours(0, 0, 0, 0);

  await prisma.teeSearch.create({
    data: {
      userId: user.id,
      date,
      startTime: "13:40",
      endTime: "16:00",
      players: 3,
      cadenceMinutes: 15,
      preferences: {
        create: [
          { courseId: tashua.id, rank: 1 },
          { courseId: smith.id, rank: 2 }
        ]
      }
    }
  });

  console.log("Seeded demo ForeUP courses and one active search.");
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
