import "./load-local-env";

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { reactivateSyntheticTestSearch, type SyntheticReactivationResult } from "@/lib/automation/synthetic-test-reactivation";
import { prisma } from "@/lib/prisma";

type Dependencies = {
  environment: string | undefined;
  readGit: (args: string[]) => string;
  reactivate: typeof reactivateSyntheticTestSearch;
};

export async function runSyntheticReactivationCommand(
  args: string[],
  rawInput: unknown,
  dependencies: Dependencies = {
    environment: process.env.VERCEL_ENV,
    readGit: (gitArgs) => execFileSync("git", gitArgs, {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
    reactivate: reactivateSyntheticTestSearch,
  },
) {
  const apply = args.includes("--apply");
  const environmentIndex = args.indexOf("--environment");
  const environment = environmentIndex >= 0 ? args[environmentIndex + 1] : undefined;
  if (!environment || !["production", "preview"].includes(environment) ||
      dependencies.environment !== environment ||
      args.length !== (apply ? 3 : 2) ||
      args.filter((arg) => arg === "--apply").length > 1 ||
      args.filter((arg) => arg === "--environment").length !== 1) {
    throw new Error("An exact wrapped environment and optional --apply are required");
  }
  const branch = dependencies.readGit(["branch", "--show-current"]);
  const runtimeVersion = dependencies.readGit(["rev-parse", "HEAD"]);
  if (!branch || ["main", "master", "HEAD"].includes(branch) ||
      !/^[a-f0-9]{40}$/.test(runtimeVersion) ||
      dependencies.readGit(["status", "--porcelain"]) ||
      dependencies.readGit(["rev-parse", "origin/main"]) !== runtimeVersion) {
    throw new Error("A clean exact-main checkout on the owned named task branch is required");
  }
  return dependencies.reactivate(rawInput, { apply, runtimeVersion });
}

/** Standalone CLI only: native ORM diagnostics must never expose the selected row. */
export async function runSyntheticReactivationCli(
  work: () => Promise<SyntheticReactivationResult>,
  cleanup: () => Promise<void>,
  streams: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    stderr: Pick<NodeJS.WriteStream, "write">;
  } = process,
): Promise<number> {
  const originalStdout = streams.stdout.write;
  const originalStderr = streams.stderr.write;
  const writeAggregate = originalStdout.bind(streams.stdout);
  const quietWrite = (...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === "function") queueMicrotask(() => callback());
    return true;
  };
  let result: SyntheticReactivationResult | undefined;
  let failed = false;
  streams.stdout.write = quietWrite;
  streams.stderr.write = quietWrite;
  try {
    result = await work();
  } catch {
    failed = true;
  } finally {
    try { await cleanup(); }
    catch { failed = true; }
    streams.stdout.write = originalStdout;
    streams.stderr.write = originalStderr;
  }
  writeAggregate(`${JSON.stringify(failed || !result
    ? { outcome: "UNKNOWN", code: "SYNTHETIC_REACTIVATION_FAILED" }
    : result)}\n`);
  return failed || !result ? 1 : 0;
}

async function main() {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 8192) throw new Error("Input exceeds bounded operator scope");
    chunks.push(buffer);
  }
  return runSyntheticReactivationCommand(
    process.argv.slice(2), JSON.parse(Buffer.concat(chunks).toString("utf8")),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSyntheticReactivationCli(main, () => prisma.$disconnect()).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    process.exitCode = 1;
  });
}
