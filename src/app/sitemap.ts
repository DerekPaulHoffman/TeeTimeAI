import type { MetadataRoute } from "next";

import { absoluteUrl } from "@/lib/seo";
import { LOCATION_HUBS, loadQualifiedLocationHub } from "@/lib/course-profiles/locations";
import { PUBLIC_COURSE_PROFILE_STATUSES } from "@/lib/course-profiles/service";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const STATIC_ROUTES = [
  "/",
  "/search",
  "/how-it-works",
  "/about",
  "/methodology",
  "/guides",
  "/guides/tee-time-cancellation-alerts",
  "/guides/public-golf-booking-windows",
  "/guides/tee-time-alerts-vs-auto-booking",
  "/contact",
  "/privacy",
  "/terms"
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [profiles, locationResults] = await Promise.all([
    prisma.courseProfile.findMany({
      where: {
        status: { in: [...PUBLIC_COURSE_PROFILE_STATUSES] },
        course: { isPublic: true }
      },
      orderBy: { canonicalSlug: "asc" },
      select: { canonicalSlug: true, updatedAt: true }
    }),
    Promise.all(Object.values(LOCATION_HUBS).map(async (hub) => ({ hub, data: await loadQualifiedLocationHub(hub) })))
  ]);

  return [
    ...STATIC_ROUTES.map((path) => ({ url: absoluteUrl(path) })),
    ...profiles.map((profile) => ({ url: absoluteUrl(`/courses/${profile.canonicalSlug}`), lastModified: profile.updatedAt })),
    ...locationResults
      .filter((result) => result.data)
      .map((result) => ({ url: absoluteUrl(result.hub.path), ...(result.data?.lastModifiedAt ? { lastModified: result.data.lastModifiedAt } : {}) }))
  ];
}

export { STATIC_ROUTES };
