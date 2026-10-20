// @vitest-environment node
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { remoteProviderLease } from "./remote-provider-lease";

const env = { COURSE_DISCOVERY_API_ORIGIN: "http://127.0.0.1:3105", LOCAL_READER_DEVICE_TOKEN: "isolated-test-token-not-production",
  COURSE_DISCOVERY_JOB_ID: "fixture-job", COURSE_DISCOVERY_LEASE_TOKEN: "f383640c-c171-43da-a775-edc1d939490a", COURSE_DISCOVERY_JOB_KIND: "discovery" };
describe("remote coordination keeps provider requests local", () => {
  it("signs only coordination calls and releases its lease after failure", async () => {
    const fetcher = vi.fn(async (_url, request) => {
      const body = JSON.parse(String(request?.body));
      const headers = new Headers(request?.headers);
      const timestamp = headers.get("x-local-reader-timestamp");
      expect(headers.get("x-local-reader-signature")).toBe(createHmac("sha256", env.LOCAL_READER_DEVICE_TOKEN).update(`POST\n/api/course-discovery/provider-lease\n${timestamp}\n${request?.body}`).digest("hex"));
      expect(body.jobId).toBe(env.COURSE_DISCOVERY_JOB_ID);
      return Response.json(body.action === "acquire" ? { lease: { providerFamilyKey: "EXAMPLE", globalSlot: 0, leaseToken: "b2fc0e82-dfa8-4ff7-b6b1-2fa4fa86f787" } } : { released: true });
    });
    const lease = remoteProviderLease(env, fetcher as typeof fetch);
    await expect(lease("EXAMPLE", async () => { throw new Error("provider down"); })).rejects.toThrow("provider down");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(env.COURSE_DISCOVERY_API_ORIGIN))).toBe(true);
  });
  it("never starts provider work when coordination fails", async () => {
    const work = vi.fn();
    await expect(remoteProviderLease(env, vi.fn(async () => new Response("", { status: 409 })))("EXAMPLE", work)).rejects.toThrow("PROVIDER_COORDINATION_REJECTED");
    expect(work).not.toHaveBeenCalled();
  });
  it("fails closed before doing work when credentials or origin are absent", () => {
    expect(() => remoteProviderLease({})).toThrow();
    expect(() => remoteProviderLease({ ...env, COURSE_DISCOVERY_API_ORIGIN: "http://public.example.com" })).toThrow();
  });
});
