import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const productionRoots = ["src", "scripts"];
const destructiveEvidenceWrite =
  /\b(?:courseAutomationDiscovery|courseMonitoringEvent)\s*\.\s*(?:update|updateMany|delete|deleteMany|upsert)\s*\(/gu;

function listProductionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return listProductionTypeScriptFiles(path);
    }
    if (![".ts", ".tsx"].includes(extname(entry.name)) || /\.test\.tsx?$/u.test(entry.name)) {
      return [];
    }
    return [path];
  });
}

describe("course evidence retention contract", () => {
  it("keeps accepted discovery and monitoring evidence append-only", () => {
    const destructiveWrites = productionRoots.flatMap((root) =>
      listProductionTypeScriptFiles(join(repositoryRoot, root)).flatMap((file) => {
        const matches = [...readFileSync(file, "utf8").matchAll(destructiveEvidenceWrite)];
        return matches.map((match) => ({
          file: relative(repositoryRoot, file).replaceAll("\\", "/"),
          operation: match[0]
        }));
      })
    );

    expect(destructiveWrites).toEqual([]);
  });
});
