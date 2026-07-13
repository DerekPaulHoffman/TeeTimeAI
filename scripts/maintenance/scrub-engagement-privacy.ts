import "../automation/load-local-env";

import { pathToFileURL } from "node:url";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

const REQUIRED_CONFIRMATION = "strip-query-hash-and-search-id";

type AggregateCounts = {
  eventPages: number;
  feedbackPages: number;
  eventMetadataSearchIds: number;
};

export async function scrubEngagementPrivacy() {
  if (process.env.CONFIRM_ENGAGEMENT_PRIVACY_SCRUB !== REQUIRED_CONFIRMATION) {
    throw new Error(
      `Set CONFIRM_ENGAGEMENT_PRIVACY_SCRUB=${REQUIRED_CONFIRMATION} to run this maintenance operation.`
    );
  }

  return prisma.$transaction(async (transaction) => {
    const before = await countSensitiveEngagementFields(transaction);

    const eventPagesUpdated = await transaction.$executeRaw`
      UPDATE "WebsiteEvent"
      SET "page" = CASE
        WHEN NULLIF(
          regexp_replace(
            regexp_replace("page", '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*', ''),
            '[?#].*$',
            ''
          ),
          ''
        ) IS NULL THEN '/'
        WHEN regexp_replace(
          regexp_replace("page", '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*', ''),
          '[?#].*$',
          ''
        ) LIKE '/%' THEN regexp_replace(
          regexp_replace("page", '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*', ''),
          '[?#].*$',
          ''
        )
        ELSE '/' || regexp_replace(
          regexp_replace("page", '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*', ''),
          '[?#].*$',
          ''
        )
      END
      WHERE "page" IS NOT NULL
        AND ("page" LIKE '%?%' OR "page" LIKE '%#%' OR "page" ~ '^[A-Za-z][A-Za-z0-9+.-]*://')
    `;

    const feedbackPagesUpdated = await transaction.$executeRaw`
      UPDATE "WebsiteFeedback"
      SET "page" = CASE
        WHEN NULLIF(
          regexp_replace(
            regexp_replace("page", '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*', ''),
            '[?#].*$',
            ''
          ),
          ''
        ) IS NULL THEN '/'
        WHEN regexp_replace(
          regexp_replace("page", '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*', ''),
          '[?#].*$',
          ''
        ) LIKE '/%' THEN regexp_replace(
          regexp_replace("page", '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*', ''),
          '[?#].*$',
          ''
        )
        ELSE '/' || regexp_replace(
          regexp_replace("page", '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*', ''),
          '[?#].*$',
          ''
        )
      END
      WHERE "page" IS NOT NULL
        AND ("page" LIKE '%?%' OR "page" LIKE '%#%' OR "page" ~ '^[A-Za-z][A-Za-z0-9+.-]*://')
    `;

    const eventMetadataUpdated = await transaction.$executeRaw`
      UPDATE "WebsiteEvent"
      SET "metadata" = ("metadata"::jsonb - 'searchId')
      WHERE jsonb_typeof("metadata"::jsonb) = 'object'
        AND "metadata"::jsonb ? 'searchId'
    `;

    const after = await countSensitiveEngagementFields(transaction);
    return {
      before,
      updated: {
        eventPages: eventPagesUpdated,
        feedbackPages: feedbackPagesUpdated,
        eventMetadataSearchIds: eventMetadataUpdated
      },
      after
    };
  });
}

async function countSensitiveEngagementFields(
  transaction: Prisma.TransactionClient
): Promise<AggregateCounts> {
  const [counts] = await transaction.$queryRaw<AggregateCounts[]>`
    SELECT
      (
        SELECT COUNT(*)::int
        FROM "WebsiteEvent"
        WHERE "page" IS NOT NULL
          AND ("page" LIKE '%?%' OR "page" LIKE '%#%' OR "page" ~ '^[A-Za-z][A-Za-z0-9+.-]*://')
      ) AS "eventPages",
      (
        SELECT COUNT(*)::int
        FROM "WebsiteFeedback"
        WHERE "page" IS NOT NULL
          AND ("page" LIKE '%?%' OR "page" LIKE '%#%' OR "page" ~ '^[A-Za-z][A-Za-z0-9+.-]*://')
      ) AS "feedbackPages",
      (
        SELECT COUNT(*)::int
        FROM "WebsiteEvent"
        WHERE jsonb_typeof("metadata"::jsonb) = 'object'
          AND "metadata"::jsonb ? 'searchId'
      ) AS "eventMetadataSearchIds"
  `;

  return counts;
}

async function main() {
  const counts = await scrubEngagementPrivacy();
  console.log(JSON.stringify(counts, null, 2));
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Engagement privacy scrub failed");
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
