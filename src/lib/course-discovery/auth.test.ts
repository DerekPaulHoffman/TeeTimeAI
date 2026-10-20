// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signLocalReaderPayload } from "@/lib/local-reader/contracts";
import { assertLocalReaderRequest } from "@/lib/local-reader/auth";
import { assertCourseDiscoveryRequest } from "./auth";

const readerToken = "existing-reader-fixture-token-12345";
const discoveryToken = "separate-discovery-fixture-token-67890";
function signedRequest(path: string, token = discoveryToken, body = "{}", timestamp = String(Date.now())) {
  return new NextRequest(`https://teetimespot.com${path}`, { method: "POST", body, headers: {
    "x-local-reader-timestamp": timestamp,
    "x-local-reader-signature": signLocalReaderPayload(token, `POST\n${path}\n${timestamp}\n${body}`),
  } });
}
beforeEach(() => {
  vi.stubEnv("LOCAL_READER_DEVICE_TOKEN", readerToken);
  vi.stubEnv("COURSE_DISCOVERY_DEVICE_TOKEN", discoveryToken);
});
afterEach(() => vi.unstubAllEnvs());

describe("scoped course discovery device authentication", () => {
  it.each(["/api/course-discovery/jobs/next", "/api/course-discovery/executions/next", "/api/course-discovery/executions/job1/result", "/api/course-discovery/provider-lease"])(
    "accepts the dedicated credential only on the learning namespace: %s", path => {
      expect(assertCourseDiscoveryRequest(signedRequest(path), "{}")).toBeNull();
      expect(assertCourseDiscoveryRequest(signedRequest(path, readerToken), "{}")?.status).toBe(401);
    });
  it.each(["/api/local-reader/jobs/next", "/api/automation/poll", "/api/course-discovery-other/jobs/next", "/api/course-discovery"])(
    "rejects a correctly signed request outside the learning namespace: %s", path => {
      expect(assertCourseDiscoveryRequest(signedRequest(path), "{}")?.status).toBe(401);
    });
  it("does not authorize the installed reader with the dedicated credential", () => {
    const path = "/api/local-reader/jobs/job1/result";
    expect(assertLocalReaderRequest(signedRequest(path), "{}")?.status).toBe(401);
    expect(assertLocalReaderRequest(signedRequest(path, readerToken), "{}")).toBeNull();
  });
  it("falls back only while the dedicated environment setting is absent", () => {
    vi.stubEnv("COURSE_DISCOVERY_DEVICE_TOKEN", undefined);
    const path = "/api/course-discovery/jobs/next";
    expect(assertCourseDiscoveryRequest(signedRequest(path, readerToken), "{}")).toBeNull();
    for (const configured of ["", " ", "too-short"]) {
      vi.stubEnv("COURSE_DISCOVERY_DEVICE_TOKEN", configured);
      expect(assertCourseDiscoveryRequest(signedRequest(path, readerToken), "{}")?.status).toBe(503);
    }
  });
  it("preserves body, query and timestamp signature binding", () => {
    const path = "/api/course-discovery/jobs/next";
    expect(assertCourseDiscoveryRequest(signedRequest(path), '{"changed":true}')?.status).toBe(401);
    const original = signedRequest(`${path}?mode=one`);
    expect(assertCourseDiscoveryRequest(new NextRequest(`https://teetimespot.com${path}?mode=two`, {
      method: "POST", body: "{}", headers: original.headers,
    }), "{}")?.status).toBe(401);
    expect(assertCourseDiscoveryRequest(signedRequest(path, discoveryToken, "{}", String(Date.now() - 61_000)), "{}")?.status).toBe(401);
  });
});
