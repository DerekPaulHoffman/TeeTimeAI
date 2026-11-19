import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("production tsx loader can serialize browser control extraction without module helpers", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx",
    fileURLToPath(new URL("./fixtures/interactive-browser-runtime.ts", import.meta.url))], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8", windowsHide: true,
    timeout: 25_000, maxBuffer: 20_000,
    env: { ...process.env, DATABASE_URL: "", DATABASE_URL_UNPOOLED: "" },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const value = JSON.parse(result.stdout.trim());
  assert.equal(value.completed, true);
  assert.equal(value.controls, 2);
  assert.equal(value.providerRequests, 0);
  assert.equal(value.databaseReads, 0);
});
