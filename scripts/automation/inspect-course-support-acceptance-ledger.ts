import {
  buildUnavailableAcceptanceLedger,
  loadCourseSupportAcceptanceLedger,
  runCourseSupportAcceptanceLedgerDiagnostic,
} from "@/lib/automation/course-support-acceptance-ledger";

async function main() {
  const observedAt = new Date();
  const result = await runCourseSupportAcceptanceLedgerDiagnostic({
    args: process.argv.slice(2), observedAt,
  }, {
    loadEnvironment: () => import("./load-local-env"),
    getDatabaseUrl: () => process.env.DATABASE_URL,
    read: () => readLedger(observedAt),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "UNKNOWN") process.exitCode = 1;
}

async function readLedger(observedAt: Date) {
  const [{ PrismaClient }, { PrismaNeon }, { PrismaPg }, { resolveRuntimeDatabaseUrl }, { isLocalPostgresUrl }] = await Promise.all([
    import("@prisma/client"), import("@prisma/adapter-neon"), import("@prisma/adapter-pg"),
    import("@/lib/database-url"), import("@/lib/prisma"),
  ]);
  const connectionString = resolveRuntimeDatabaseUrl();
  const adapter = isLocalPostgresUrl(connectionString)
    ? new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 })
    : new PrismaNeon({ connectionString });
  // A dedicated silent client prevents ORM error logging from leaking query data.
  const database = new PrismaClient({ adapter, log: [] });
  try {
    return await loadCourseSupportAcceptanceLedger(database, observedAt);
  } finally {
    await database.$disconnect().catch(() => undefined);
  }
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify(buildUnavailableAcceptanceLedger(new Date(), "READ_FAILED"))}\n`);
  process.exitCode = 1;
});
