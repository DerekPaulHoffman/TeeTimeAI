import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import {
  LOCAL_READER_COURSES,
  localReaderJobSchema,
  localReaderResultSchema,
  serializeSignedPayload,
  signLocalReaderPayload,
  validateLocalReaderResultForJob,
  verifyLocalReaderSignature,
  type LocalReaderJob,
  type LocalReaderResult
} from "../../src/lib/local-reader/contracts";

const host = "127.0.0.1";
const port = Number(process.env.LOCAL_READER_MOCK_PORT || 4317);
const deviceSecret = process.env.LOCAL_READER_DEVICE_TOKEN || "";
const leaseDurationMs = 60_000;

if (deviceSecret.length < 16) {
  throw new Error("Set LOCAL_READER_DEVICE_TOKEN to at least 16 characters");
}

type JobRecord = {
  job: LocalReaderJob;
  status: "PENDING" | "LEASED" | "COMPLETED";
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  result: LocalReaderResult | null;
};

const jobs = new Map<string, JobRecord>();

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 128 * 1024) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function hasDeviceAuthorization(request: IncomingMessage, serializedBody = "") {
  const signature = String(request.headers["x-local-reader-signature"] || "");
  const timestamp = String(request.headers["x-local-reader-timestamp"] || "");
  if (!/^\d{13}$/u.test(timestamp)) return false;
  if (Math.abs(Date.now() - Number(timestamp)) > 60_000) return false;
  return verifyLocalReaderSignature(
    deviceSecret,
    `${request.method}\n${request.url}\n${timestamp}\n${serializedBody}`,
    signature
  );
}

function signResponse(request: IncomingMessage, payload: unknown) {
  const serialized = serializeSignedPayload(payload);
  const timestamp = String(Date.now());
  return {
    payload,
    timestamp,
    signature: signLocalReaderPayload(
      deviceSecret,
      `${request.method}\n${request.url}\n${timestamp}\n${serialized}`
    )
  };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${host}:${port}`);

    if (request.method === "POST" && url.pathname === "/jobs") {
      const body = await readBody(request);
      if (!hasDeviceAuthorization(request, body)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      const input = JSON.parse(body) as { targetDate?: unknown; players?: unknown };
      const requestedAt = new Date();
      const job = localReaderJobSchema.parse({
        id: randomUUID(),
        courseKey: "grassy-hill",
        targetDate: input.targetDate,
        players: input.players,
        requestedAt: requestedAt.toISOString(),
        expiresAt: new Date(requestedAt.getTime() + 5 * 60_000).toISOString(),
        bookingUrl: LOCAL_READER_COURSES["grassy-hill"].bookingUrl
      });
      jobs.set(job.id, {
        job,
        status: "PENDING",
        leaseToken: null,
        leaseExpiresAt: null,
        result: null
      });
      sendJson(response, 201, signResponse(request, { jobId: job.id, status: "PENDING" }));
      return;
    }

    if (
      request.method === "GET" &&
      (url.pathname === "/jobs/next" ||
        url.pathname === "/api/local-reader/jobs/next")
    ) {
      if (!hasDeviceAuthorization(request)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      const now = Date.now();
      const record = [...jobs.values()].find(
        (candidate) =>
          Date.parse(candidate.job.expiresAt) > now &&
          (candidate.status === "PENDING" ||
            (candidate.status === "LEASED" && (candidate.leaseExpiresAt || 0) <= now))
      );
      if (!record) {
        sendJson(
          response,
          200,
          url.pathname.startsWith("/api/") ? { job: null } : signResponse(request, { job: null })
        );
        return;
      }
      record.status = "LEASED";
      record.leaseToken = randomUUID();
      record.leaseExpiresAt = now + leaseDurationMs;
      const job = { ...record.job, leaseToken: record.leaseToken };
      sendJson(
        response,
        200,
        url.pathname.startsWith("/api/") ? { job } : signResponse(request, { job })
      );
      return;
    }

    const resultMatch =
      /^\/jobs\/([^/]+)\/result$/u.exec(url.pathname) ||
      /^\/api\/local-reader\/jobs\/([^/]+)\/result$/u.exec(url.pathname);
    if (request.method === "POST" && resultMatch) {
      const body = await readBody(request);
      if (!hasDeviceAuthorization(request, body)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      const record = jobs.get(resultMatch[1]);
      const leaseToken = String(request.headers["x-local-reader-lease"] || "");
      if (
        !record ||
        record.status !== "LEASED" ||
        (record.leaseExpiresAt || 0) <= Date.now() ||
        (url.pathname.startsWith("/api/") && leaseToken !== record.leaseToken)
      ) {
        sendJson(response, 409, { error: "job_not_leased" });
        return;
      }
      const result = localReaderResultSchema.parse(JSON.parse(body));
      try {
        validateLocalReaderResultForJob(record.job, result);
      } catch {
        sendJson(response, 409, { error: "job_mismatch" });
        return;
      }
      record.result = result;
      record.status = "COMPLETED";
      record.leaseToken = null;
      record.leaseExpiresAt = null;
      sendJson(
        response,
        200,
        url.pathname.startsWith("/api/")
          ? { status: record.status }
          : signResponse(request, { status: record.status })
      );
      return;
    }

    const statusMatch = /^\/jobs\/([^/]+)$/u.exec(url.pathname);
    if (request.method === "GET" && statusMatch) {
      if (!hasDeviceAuthorization(request)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      const record = jobs.get(statusMatch[1]);
      if (!record) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      sendJson(
        response,
        200,
        signResponse(request, {
          jobId: record.job.id,
          status: record.status,
          result: record.result
        })
      );
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "invalid_request"
    });
  }
});

server.listen(port, host, () => {
  console.log(`Local reader proof backend listening on http://${host}:${port}`);
});
