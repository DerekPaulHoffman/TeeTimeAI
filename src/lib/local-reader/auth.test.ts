import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { signLocalReaderPayload } from "./contracts";
import { assertLocalReaderRequest } from "./auth";

const token = "local-reader-test-token-1234";

function signedRequest(input: {
  method: "GET" | "POST";
  url: string;
  body?: string;
  timestamp?: string;
}) {
  const timestamp = input.timestamp || String(Date.now());
  const url = new URL(input.url);
  const body = input.body || "";
  const signature = signLocalReaderPayload(
    token,
    `${input.method}\n${url.pathname}${url.search}\n${timestamp}\n${body}`
  );
  return new NextRequest(input.url, {
    method: input.method,
    body: body || undefined,
    headers: {
      "x-local-reader-timestamp": timestamp,
      "x-local-reader-signature": signature
    }
  });
}

describe("local reader device authentication", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("accepts an exact signed method, path, query, timestamp, and body", () => {
    vi.stubEnv("LOCAL_READER_DEVICE_TOKEN", token);
    const body = '{"jobId":"job-1"}';
    const request = signedRequest({
      method: "POST",
      url: "https://teetimespot.com/api/local-reader/jobs/job-1/result",
      body
    });

    expect(assertLocalReaderRequest(request, body)).toBeNull();
  });

  it("rejects stale or changed requests", () => {
    vi.stubEnv("LOCAL_READER_DEVICE_TOKEN", token);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T16:00:00.000Z"));
    const stale = signedRequest({
      method: "GET",
      url: "https://teetimespot.com/api/local-reader/jobs/next?deviceId=test",
      timestamp: String(Date.now() - 61_000)
    });
    const changed = signedRequest({
      method: "GET",
      url: "https://teetimespot.com/api/local-reader/jobs/next?deviceId=test"
    });

    expect(assertLocalReaderRequest(stale)?.status).toBe(401);
    expect(
      assertLocalReaderRequest(
        new NextRequest(
          "https://teetimespot.com/api/local-reader/jobs/next?deviceId=changed",
          { method: "GET", headers: changed.headers }
        )
      )?.status
    ).toBe(401);
  });
});
