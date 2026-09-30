import { execFileSync } from "node:child_process";
import { loadCourseSupportAcceptanceReasons, runAcceptanceReasonsDiagnostic,
  unavailableAcceptanceReasons } from "@/lib/operator/course-support-acceptance-reasons";

async function read(sourceSha: string) {
  const [{ PrismaClient }, { PrismaNeon }, { PrismaPg }, { resolveRuntimeDatabaseUrl }, { isLocalPostgresUrl }] = await Promise.all([
    import("@prisma/client"), import("@prisma/adapter-neon"), import("@prisma/adapter-pg"),
    import("@/lib/database-url"), import("@/lib/prisma"),
  ]);
  const connectionString = resolveRuntimeDatabaseUrl();
  const adapter = isLocalPostgresUrl(connectionString)
    ? new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 })
    : new PrismaNeon({ connectionString });
  const database = new PrismaClient({ adapter, log: [] });
  try { return await loadCourseSupportAcceptanceReasons(database, sourceSha); }
  finally { await database.$disconnect().catch(() => undefined); }
}

async function main() {
  const result = await runAcceptanceReasonsDiagnostic({ args: process.argv.slice(2) }, {
    loadEnvironment: () => import("./load-local-env"),
    getDatabaseUrl: () => process.env.DATABASE_URL,
    readGitSourceSha: () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(),
    isCheckoutClean: () => !execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(),
    read,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "UNAVAILABLE") process.exitCode = 1;
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify(unavailableAcceptanceReasons({ sourceSha: null, reason: "READ_FAILED" }))}\n`);
  process.exitCode = 1;
});
