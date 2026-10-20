import { createHmac } from "node:crypto";

const PREFIX = "/api/course-discovery/jobs";
const ID = /^[A-Za-z0-9_-]{1,200}$/u;

export function discoveryError(code, extra = {}) {
  return Object.assign(new Error(code), { code, ...extra });
}

function identifier(value) {
  if (typeof value !== "string" || !ID.test(value)) throw discoveryError("INVALID_DISCOVERY_ID");
  return value;
}

/** The device token belongs to the controller; never pass this client to a model. */
export function createCourseDiscoveryClient({ baseUrl, deviceToken, browserTransport = "PINNED_HTTP", fetchImpl = fetch, now = Date.now, timeoutMs = 10_000 }) {
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/" ||
      (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))) {
    throw discoveryError("INVALID_DISCOVERY_ORIGIN");
  }
  const secret = deviceToken?.replace(/^\uFEFF/u, "").trim();
  if (!secret || secret.length < 16) throw discoveryError("DISCOVERY_DEVICE_TOKEN_REQUIRED");
  if (!["PINNED_HTTP", "NATIVE_CHROME"].includes(browserTransport)) throw discoveryError("INVALID_DISCOVERY_BROWSER_TRANSPORT");
  async function post(path, payload, signal) {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 200_000) throw discoveryError("DISCOVERY_REQUEST_TOO_LARGE");
    const timestamp = String(now());
    const signature = createHmac("sha256", secret).update(`POST\n${path}\n${timestamp}\n${body}`).digest("hex");
    let response;
    try {
      response = await fetchImpl(new URL(path, base), {
        method: "POST", redirect: "error", cache: "no-store",
        headers: { "content-type": "application/json", "x-local-reader-timestamp": timestamp, "x-local-reader-signature": signature },
        body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw discoveryError(signal?.aborted ? "DISCOVERY_CANCELLED" : "DISCOVERY_API_UNAVAILABLE");
    }
    if (!response.ok) throw discoveryError(response.status === 409 ? "DISCOVERY_LEASE_REJECTED" : "DISCOVERY_API_REJECTED", { status: response.status });
    const reader = response.body?.getReader();
    let text = "";
    if (reader) {
      const decoder = new TextDecoder();
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1_000_000) { await reader.cancel(); throw discoveryError("DISCOVERY_RESPONSE_TOO_LARGE"); }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally { reader.releaseLock(); }
    }
    try { return JSON.parse(text); } catch { throw discoveryError("DISCOVERY_RESPONSE_INVALID"); }
  }
  const jobPost = (id, action, payload, signal) => post(`${PREFIX}/${identifier(id)}/${action}`, payload, signal);
  return {
    helperEnvironment: (kind, job) => {
      if (!["discovery", "execution"].includes(kind)) throw discoveryError("INVALID_DISCOVERY_JOB_KIND");
      return { COURSE_DISCOVERY_API_ORIGIN: base.origin, LOCAL_READER_DEVICE_TOKEN: secret,
        COURSE_DISCOVERY_JOB_ID: identifier(job.id), COURSE_DISCOVERY_LEASE_TOKEN: job.leaseToken, COURSE_DISCOVERY_JOB_KIND: kind,
        COURSE_DISCOVERY_BROWSER_TRANSPORT: browserTransport };
    },
    nextExecution: (workerId, signal) => post("/api/course-discovery/executions/next", { workerId: identifier(workerId) }, signal),
    executionResult: (id, leaseToken, result, signal) => post(`/api/course-discovery/executions/${identifier(id)}/result`, { leaseToken, result }, signal),
    next: (workerId, signal) => post(`${PREFIX}/next`, { workerId: identifier(workerId) }, signal),
    heartbeat: (id, leaseToken, signal) => jobPost(id, "heartbeat", { leaseToken }, signal),
    checkpoint: (id, leaseToken, checkpoint, signal) => jobPost(id, "checkpoint", { leaseToken, checkpoint }, signal),
    candidate: (id, leaseToken, recipe, signal, sourceEvidence) => jobPost(id, "candidate", { leaseToken, recipe,
      ...(sourceEvidence ? { sourceEvidence } : {}) }, signal),
    verification: (id, challengeId, leaseToken, proof, signal) => jobPost(id, `verification/${identifier(challengeId)}`, { leaseToken, ...proof }, signal),
    activate: (id, leaseToken, signal) => jobPost(id, "activate", { leaseToken }, signal),
    fail: (id, leaseToken, reason, retryable = true, signal) => jobPost(id, "fail", { leaseToken, reason, retryable }, signal),
  };
}
