// @vitest-environment node
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { discoveryProcessEnvironment } from "../../../scripts/automation/course-discovery-worker.mjs";

describe("compiled direct public protocol inspection", () => {
  it("performs two exact anonymous reads under signed leases without Chrome and rejects extra tool data before reads", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "direct-protocol-cli-")), secret = "synthetic-device-coordination-secret";
    const source = { bookingUrl: "https://www.sevenrooms.com/reservations/examplegolf?duration-picker=true", venueName: "Example Indoor Golf",
      venueAddress: "12 Public Road, Springfield, NC 27601, USA", timeZone: "America/New_York" };
    const input = { date: "2030-01-02", players: 2, durationMinutes: 60, timeZone: source.timeZone, startTime: "10:00", endTime: "20:00" };
    const providerReads: Array<{ path: string; method?: string; authorization: boolean; cookie: boolean }> = [];
    const coordination: string[] = [];
    const server = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/course-discovery/provider-lease") {
        let body = ""; for await (const chunk of request) body += chunk;
        const expected = createHmac("sha256", secret).update(`POST\n${request.url}\n${request.headers["x-local-reader-timestamp"]}\n${body}`).digest("hex");
        if (expected !== request.headers["x-local-reader-signature"]) { response.writeHead(401); response.end("{}"); return; }
        const value = JSON.parse(body); coordination.push(value.action);
        response.end(JSON.stringify(value.action === "release" ? { released: true } :
          { lease: { providerFamilyKey: value.providerFamily, globalSlot: 0, leaseToken: "00000000-0000-4000-8000-000000000001" } }));
        return;
      }
      providerReads.push({ path: request.url ?? "", method: request.method, authorization: Boolean(request.headers.authorization), cookie: Boolean(request.headers.cookie) });
      if (request.url?.startsWith("/api-yoa/dining/venue_info?")) {
        response.end(JSON.stringify({ status: 200, data: { venue_info: { name: source.venueName, url_key: "examplegolf", timezone: source.timeZone,
          address: "12 Public Road", city: "Springfield", state: "NC", postal_code: "27601", country_code: "US", private_payload: "PRIVATE_METADATA_SENTINEL" } } }));
      } else {
        response.end(JSON.stringify({ status: 200, data: { availability: { [input.date]: [{ times: [
          { type: "book", access_persistent_id: "PRIVATE_RESOURCE_SENTINEL_A", public_time_slot_description: "Happy Hour Rental", duration: 60, time_iso: "2030-01-02 12:00:00" },
          { type: "book", access_persistent_id: "PRIVATE_RESOURCE_SENTINEL_B", public_time_slot_description: "Peak Rental", duration: 60, time_iso: "2030-01-02 17:00:00" },
          { type: "request" },
        ] }] } } }));
      }
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const port = (server.address() as { port: number }).port, preload = join(temporary, "fixture.mjs");
    // Test-only transport sends every provider byte to the owned loopback wire.
    // Production guards and signed provider coordination remain unchanged.
    writeFileSync(preload, `import https from 'node:https';
import dns from 'node:dns/promises';
import cp from 'node:child_process';
import {request} from 'node:http';
import {syncBuiltinESMExports} from 'node:module';
const spawn=cp.spawn;cp.spawn=function(executable,...rest){if(/(?:chrome|chromium|firefox|msedge)(?:\\.exe)?$/i.test(String(executable))){process.stderr.write('UNEXPECTED_BROWSER_LAUNCH');throw Error('NO_BROWSER_ALLOWED');}return spawn.call(this,executable,...rest);};
dns.lookup=async()=>[{address:'93.184.215.14',family:4}];
https.request=(url,options,callback)=>request(new URL(url.pathname+url.search,'http://127.0.0.1:${port}'),{method:options.method,headers:options.headers},callback);
syncBuiltinESMExports();
`);
    async function execute(payload: object) {
      const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, "--import", "tsx", resolve("scripts/automation/course-discovery-browser.ts"),
        "--inspect-public-protocol", "--deadline", new Date(Date.now() + 40_000).toISOString()], { cwd: process.cwd(), windowsHide: true,
        env: { ...discoveryProcessEnvironment(), TSX_TSCONFIG_PATH: resolve("tsconfig.json"), COURSE_DISCOVERY_API_ORIGIN: `http://127.0.0.1:${port}`,
          LOCAL_READER_DEVICE_TOKEN: secret, COURSE_DISCOVERY_JOB_ID: "fixture-job", COURSE_DISCOVERY_LEASE_TOKEN: "00000000-0000-4000-8000-000000000002", COURSE_DISCOVERY_JOB_KIND: "discovery" },
        stdio: ["pipe", "pipe", "pipe"] });
      let output = "", error = "";
      child.stdout.on("data", chunk => { output += chunk; if (output.length > 40_000) child.kill(); });
      child.stderr.on("data", chunk => { error += String(chunk).slice(0, 2000); });
      const timer = setTimeout(() => child.kill(), 20_000);
      try {
        const closed = once(child, "close"); child.stdin.end(JSON.stringify(payload) + "\n");
        const [code] = await closed; expect(code, error).toBe(0); expect(error).not.toContain("UNEXPECTED_BROWSER_LAUNCH");
        return JSON.parse(output.trim());
      } finally { clearTimeout(timer); child.kill(); }
    }
    try {
      const reply = await execute({ id: 1, source, input });
      expect(reply.ok).toBe(true); expect(reply.id).toBe(1);
      expect(reply.result.observation).toMatchObject({ completeRequestedDate: true, publicRequests: 2, availableRentalRows: 2 });
      expect(reply.result.observation.publicResponseBytes).toBeGreaterThan(0);
      expect(reply.result.observation.publicResponseBytes).toBeLessThanOrEqual(4_000_000);
      expect(reply.result.responseRows.expectedRentalLabels).toEqual(["Happy Hour Rental", "Peak Rental"]);
      expect(JSON.stringify(reply)).not.toMatch(/PRIVATE_|2030-01-02 12:00:00|authorization|cookie|browserTransport/u);
      expect(coordination).toEqual(["acquire", "release", "acquire", "release"]);
      expect(providerReads).toHaveLength(2); expect(providerReads.every(r => r.method === "GET" && !r.authorization && !r.cookie)).toBe(true);
      expect(providerReads[0].path).toBe("/api-yoa/dining/venue_info?venue_url_key=examplegolf&widget_type=RESERVATIONS&modify_upgrades=false");
      expect(providerReads[1].path).toBe("/api-yoa/availability/widget/range?venue=examplegolf&time_slot=12:00&party_size=2&halo_size_interval=64&start_date=01-02-2030&num_days=1&channel=SEVENROOMS_WIDGET&selected_lang_code=en&picked_duration=60");
      const invalid = await execute({ id: 2, source, input, headers: { authorization: "PRIVATE_ARGUMENT_SENTINEL" } });
      expect(invalid).toMatchObject({ id: 2, ok: false, error: "BROWSER_ACTION_SCHEMA_INVALID" });
      expect(JSON.stringify(invalid)).not.toContain("PRIVATE_ARGUMENT_SENTINEL"); expect(providerReads).toHaveLength(2);
      const wrongZone = await execute({ id: 3, source: { ...source, timeZone: "UTC" }, input });
      expect(wrongZone).toMatchObject({ id: 3, ok: false, error: "SEVENROOMS_INPUT_UNVERIFIED" }); expect(providerReads).toHaveLength(2);
    } finally {
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
      if (dirname(temporary) !== resolve(tmpdir()) || !temporary.startsWith(join(tmpdir(), "direct-protocol-cli-"))) throw new Error("UNOWNED_TEST_DIRECTORY");
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 35_000);
});
