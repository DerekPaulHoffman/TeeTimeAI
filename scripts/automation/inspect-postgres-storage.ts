import { Prisma } from "@prisma/client";

import { prisma } from "../../src/lib/prisma";

type StorageRow = {
  relation: string;
  rowCount: bigint;
  totalBytes: bigint;
};

const storageQuery = Prisma.sql`
  SELECT 'CourseProbe' AS relation,
    COUNT(*)::bigint AS "rowCount",
    pg_total_relation_size('"CourseProbe"')::bigint AS "totalBytes"
  FROM "CourseProbe"
  UNION ALL
  SELECT 'CourseAutomationDiscovery', COUNT(*)::bigint,
    pg_total_relation_size('"CourseAutomationDiscovery"')::bigint
  FROM "CourseAutomationDiscovery"
  UNION ALL
  SELECT 'CourseMonitoringEvent', COUNT(*)::bigint,
    pg_total_relation_size('"CourseMonitoringEvent"')::bigint
  FROM "CourseMonitoringEvent"
  UNION ALL
  SELECT 'AutomationRun', COUNT(*)::bigint,
    pg_total_relation_size('"AutomationRun"')::bigint
  FROM "AutomationRun"
  UNION ALL
  SELECT 'WebsiteEvent', COUNT(*)::bigint,
    pg_total_relation_size('"WebsiteEvent"')::bigint
  FROM "WebsiteEvent"
  UNION ALL
  SELECT 'WebsiteFeedback', COUNT(*)::bigint,
    pg_total_relation_size('"WebsiteFeedback"')::bigint
  FROM "WebsiteFeedback"
  UNION ALL
  SELECT 'LocalReaderJob', COUNT(*)::bigint,
    pg_total_relation_size('"LocalReaderJob"')::bigint
  FROM "LocalReaderJob"
  ORDER BY 1
`;

function formatBytes(bytes: bigint) {
  const mebibytes = Number(bytes) / (1024 * 1024);
  return `${mebibytes.toFixed(2)} MiB`;
}

async function run() {
  const rows = await prisma.$queryRaw<StorageRow[]>(storageQuery);
  const result = rows.map((row) => ({
    relation: row.relation,
    rowCount: row.rowCount.toString(),
    totalBytes: row.totalBytes.toString(),
    totalSize: formatBytes(row.totalBytes)
  }));

  console.log(
    JSON.stringify(
      {
        inspectedAt: new Date().toISOString(),
        retentionApplied: false,
        relations: result
      },
      null,
      2
    )
  );
}

run()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Could not inspect Postgres storage"
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
