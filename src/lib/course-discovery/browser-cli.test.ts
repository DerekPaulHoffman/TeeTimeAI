// @vitest-environment node
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { discoveryProcessEnvironment, validateDiscoveryRecipe } from "../../../scripts/automation/course-discovery-worker.mjs";

const hasBrowser = process.platform === "win32"
  ? existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
  : existsSync(chromium.executablePath());

describe("pure recipe validation CLI", () => {
  it("returns bounded selector feedback without a browser, API credentials, or payload values", async () => {
    const recipe = { schemaVersion: 1, target: { kind: "OUTDOOR", courseId: "c" }, engine: "BROWSER_DOM",
      source: { officialUrl: "https://example.org/", bookingUrl: "https://example.org/times", venueName: "Public golf", timeZone: "UTC", providerFamily: "EXAMPLE" },
      pageUrl: "https://example.org/times", permittedRoutes: [{ origin: "https://example.org", path: "/times", methods: ["GET"] }], steps: [],
      availabilityResponse: { url: "https://example.org/times?date={{date}}", method: "GET", date: { source: "QUERY", path: "date" } },
      proof: { venue: { selector: "h1" }, date: { selector: "#date" }, complete: { selector: "div:has(.SECRET_SENTINEL)" } },
      slots: { collection: { selector: ".slot" }, startsAt: { selector: "time" }, availableSpots: { selector: ".spots" } } };
    const invalid = await validateDiscoveryRecipe({ cwd: process.cwd(), recipe });
    expect(invalid).toMatchObject({ valid: false, issues: [expect.objectContaining({ path: "proof.complete.selector", message: "Expected a bounded public display selector" })] });
    expect(JSON.stringify(invalid)).not.toContain("SECRET_SENTINEL");
    recipe.proof.complete.selector = "#complete";
    expect(await validateDiscoveryRecipe({ cwd: process.cwd(), recipe })).toEqual({ valid: true });
  }, 20_000);
});

describe.runIf(hasBrowser)("compiled discovery browser CLI", () => {
  it("runs the actual tsx entrypoint with isolated public fixtures and signed local coordination", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "discovery-cli-test-"));
    const secret = "local-test-device-authentication";
    const html = '<!doctype html><html><body><h1>Fixture simulator</h1><label for="duration">Duration</label>' +
      '<select id="duration"><option value="30">30 minutes</option><option value="60">60 minutes</option></select>' +
      '<article id="rental">1 hour<button id="choose">Book</button></article><a href="/times">View times</a></body></html>';
    let signedRequests = 0;
    const server = createServer(async (request, response) => {
      if (request.url === "/api/course-discovery/provider-lease") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const signature = createHmac("sha256", secret).update(`POST\n${request.url}\n${request.headers["x-local-reader-timestamp"]}\n${body}`).digest("hex");
        if (request.headers["x-local-reader-signature"] !== signature) { response.writeHead(401); response.end(); return; }
        signedRequests++;
        const input = JSON.parse(body);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(input.action === "release" ? { released: true } :
          { lease: { providerFamilyKey: input.providerFamily, globalSlot: 0, leaseToken: "00000000-0000-4000-8000-000000000001" } }));
      } else { response.setHeader("content-type", "text/html"); response.end(html); }
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    // This preload belongs only to the test subprocess. It replaces outbound
    // transport with a local fixture without weakening production URL guards.
    const preload = join(temporary, "fixture.mjs");
    writeFileSync(preload, `import https from 'node:https';
import dns from 'node:dns/promises';
import { request } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
dns.lookup = async () => [{ address: '93.184.215.14', family: 4 }];
https.request = (url, options, callback) => request(new URL(url.pathname + url.search, 'http://127.0.0.1:${port}'), { method: options.method, headers: options.headers }, callback);
syncBuiltinESMExports();
`);
    const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, "--import", "tsx",
      resolve("scripts/automation/course-discovery-browser.ts"), "--deadline", new Date(Date.now() + 30_000).toISOString(),
      "--initial-urls", '["https://example.org/simulator"]', "--venue-official-url", "https://example.org/simulator"], {
      cwd: process.cwd(), windowsHide: true, env: { ...discoveryProcessEnvironment(),
        COURSE_DISCOVERY_API_ORIGIN: `http://127.0.0.1:${port}`, LOCAL_READER_DEVICE_TOKEN: secret,
        COURSE_DISCOVERY_JOB_ID: "fixture-job", COURSE_DISCOVERY_LEASE_TOKEN: "00000000-0000-4000-8000-000000000002", COURSE_DISCOVERY_JOB_KIND: "discovery" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    const closed = once(child, "close");
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += String(chunk).slice(0, 2000); });
    const request = async (value: object) => {
      const reply = once(lines, "line"); child.stdin.write(`${JSON.stringify(value)}\n`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const [line] = await Promise.race([reply, closed.then(() => { throw new Error(`Browser helper exited: ${stderr}`); }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Browser helper did not reply: ${stderr}`)), 15_000); })]);
        return JSON.parse(line);
      } finally { clearTimeout(timer); }
    };
    try {
      const opened = await request({ id: 1, action: "open", url: "https://example.org/simulator" });
      expect(opened.ok, stderr).toBe(true);
      expect(opened.result.text).toContain("Fixture simulator");
      const duration = opened.result.controls.find((control: { selector: string }) => control.selector === '[id="duration"]');
      expect(duration.options).toHaveLength(2);
      expect(opened.result.controls.find((control: { selector: string }) => control.selector === '[id="choose"]')).toMatchObject({ kind: "product", product: { selector: '[id="rental"]', durationMinutes: 60 } });
      const malformed = await request({ id: 20, action: "click", selector: "#PRIVATE_VALUE" });
      expect(malformed).toMatchObject({ ok: false, error: "BROWSER_ACTION_SCHEMA_INVALID",
        issues: expect.arrayContaining([expect.objectContaining({ path: "target" })]) });
      expect(JSON.stringify(malformed)).not.toContain("PRIVATE_VALUE");
      const selected = await request({ id: 2, action: "select", target: duration.target, option: "60" });
      expect(selected.ok, stderr).toBe(true);
      const finished = await request({ id: 3, action: "finish" });
      expect(finished.ok, stderr).toBe(true);
      child.stdin.end();
      const [code] = await closed;
      expect(code, stderr).toBe(0);
      expect(signedRequests).toBeGreaterThanOrEqual(2);
    } finally {
      lines.close(); child.kill();
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 40_000);
});
