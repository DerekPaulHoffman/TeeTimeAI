// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { inspectExistingAdapter } from "./existing-adapter-executor";
import { getFixedAdapterReadDiagnostic } from "./fixed-adapter-read-diagnostic";
import { venueProofMatches } from "./executor";
import { createDiscoveryProcess, safeFixedAdapterReadDiagnostic, safeBrowserFailureDiagnostics } from "../../../scripts/automation/course-discovery-worker.mjs";
const source = { officialUrl: "https://example.org/", bookingUrl: "https://example.book.teeitup.com/", venueName: "Example Golf Club",
  venueAddress: "10 Example Road, Example, NY 12345, USA", timeZone: "America/New_York" };
const deps = { venueMatches: venueProofMatches, requestLease: async <T>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() }) };
const diagnostic = { stage: "RESPONSE_HEADERS", role: "TEEITUP_DIRECTORY", httpStatus: 503, responseRedirected: false,
  responseUrlMatches: true, elapsedMs: 15_000, responseBytes: null, transportCode: "NONE" };
describe("fixed TeeItUp directory transport diagnostics", () => {
  it.each([302, 500, 503])("retains HTTP %i without body/headers/URL or changing rejection", async status => {
    let error: unknown;
    try { await inspectExistingAdapter(source, { ...deps, fetch: async () => new Response("PRIVATE_BODY", { status, headers: { location: "https://private.example/", authorization: "PRIVATE" } }) }); }
    catch (value) { error = value; }
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe("ADAPTER_TRANSPORT_FAILED");
    expect(getFixedAdapterReadDiagnostic(error)).toMatchObject({ stage: "RESPONSE_HEADERS", role: "TEEITUP_DIRECTORY", httpStatus: status,
      responseRedirected: false, responseUrlMatches: null, responseBytes: null, transportCode: "NONE" });
    expect(JSON.stringify(getFixedAdapterReadDiagnostic(error))).not.toMatch(/PRIVATE|https:/u);
    expect(getFixedAdapterReadDiagnostic(new Error("ADAPTER_TRANSPORT_FAILED"))).toBeUndefined();
  });
  it("retains unexpected response URL as a boolean and the unchanged primary", async () => {
    const response = Response.json([]); Object.defineProperty(response, "url", { value: "https://foreign.example/private" });
    let error: unknown; try { await inspectExistingAdapter(source, { ...deps, fetch: async () => response }); } catch (e) { error = e; }
    expect((error as Error).message).toBe("ADAPTER_TRANSPORT_FAILED");
    expect(getFixedAdapterReadDiagnostic(error)).toMatchObject({ httpStatus: 200, responseUrlMatches: false, stage: "RESPONSE_HEADERS" });
  });
  it.each(["ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "PRIVATE_TOKEN"])('preserves the original transport error and closes its code: %s', async code => {
    const original = Object.assign(Error("PRIVATE_MESSAGE https://private.example"), { code });
    await expect(inspectExistingAdapter(source, { ...deps, fetch: async () => { throw original; } })).rejects.toBe(original);
    const value = getFixedAdapterReadDiagnostic(original)!;
    expect(value).toMatchObject({ stage: "TRANSPORT", httpStatus: null, responseRedirected: null, responseUrlMatches: null,
      transportCode: code === "PRIVATE_TOKEN" ? "UNKNOWN" : code });
    value.httpStatus = 599; expect(getFixedAdapterReadDiagnostic(original)?.httpStatus).toBeNull();
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE|https:/u);
  });
  it("does not expose provider body on schema/identity rejection or treat a response as authority", async () => {
    let error: unknown; try { await inspectExistingAdapter(source, { ...deps, fetch: async () => Response.json({ PRIVATE_BODY: "PRIVATE" }) }); } catch (e) { error = e; }
    expect((error as Error).message).toBe("ADAPTER_CONFIGURATION_UNVERIFIED");
    expect(getFixedAdapterReadDiagnostic(error)).toMatchObject({ stage: "RESPONSE_BODY", httpStatus: 200 });
    expect(JSON.stringify(getFixedAdapterReadDiagnostic(error))).not.toContain("PRIVATE");
  });
  it("strips private extras and rejects missing/malformed/bounded fields", () => {
    expect(safeFixedAdapterReadDiagnostic({ ...diagnostic, url: "PRIVATE", body: "PRIVATE", cookie: "PRIVATE" })).toEqual(diagnostic);
    for (const change of [{ role: "PRIVATE" }, { stage: "PRIVATE" }, { transportCode: "PRIVATE" }, { httpStatus: 999 }, { responseBytes: 600_001 }, { elapsedMs: -1 }, { responseRedirected: "PRIVATE" }, { responseUrlMatches: undefined }])
      expect(safeFixedAdapterReadDiagnostic({ ...diagnostic, ...change })).toBeUndefined();
    const getter = { ...diagnostic }; Object.defineProperty(getter, "httpStatus", { get() { throw Error("PRIVATE"); } });
    expect(safeFixedAdapterReadDiagnostic(getter)).toBeUndefined();
    expect(safeBrowserFailureDiagnostics({ adapterRead: diagnostic }).adapterRead).toEqual(diagnostic);
  });
  it("carries the original failure through the actual child decoder and closed diagnostic projection", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: 0 });
    const channel = createDiscoveryProcess({ executable: "unused", args: [], cwd: "unused", environment: {}, spawnProcess: () => child });
    const pending = channel.request({ action: "inspect_adapter" });
    child.stdout.write(JSON.stringify({ id: 1, ok: false, error: "ADAPTER_TRANSPORT_FAILED", diagnostics: { adapterRead: { ...diagnostic, body: "PRIVATE" } } }) + "\n");
    await expect(pending).rejects.toMatchObject({ code: "ADAPTER_TRANSPORT_FAILED", details: { browserDiagnostics: { adapterRead: diagnostic } } });
    await channel.close(); child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
  });
});
