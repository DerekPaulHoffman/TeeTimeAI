import { createHmac } from "node:crypto";
import type { ProviderRequestLease } from "@/lib/automation/provider-request-lease";

/** The trusted browser host signs coordination calls; provider bytes stay local. */
export function remoteProviderLease(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch) {
  const origin = new URL(env.COURSE_DISCOVERY_API_ORIGIN ?? "");
  const secret = env.LOCAL_READER_DEVICE_TOKEN?.replace(/^\uFEFF/u, "").trim();
  const jobId = env.COURSE_DISCOVERY_JOB_ID;
  const jobLeaseToken = env.COURSE_DISCOVERY_LEASE_TOKEN;
  const jobKind = env.COURSE_DISCOVERY_JOB_KIND;
  if (!secret || secret.length < 16 || !jobId || !jobLeaseToken || !["discovery", "execution"].includes(jobKind ?? "") ||
      origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
      (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname)))) throw new Error("PROVIDER_COORDINATION_UNAVAILABLE");
  async function post(payload: unknown) {
    const path = "/api/course-discovery/provider-lease";
    const body = JSON.stringify({ jobId, jobLeaseToken, jobKind, ...payload as object });
    const timestamp = String(Date.now());
    const signature = createHmac("sha256", secret!).update(`POST\n${path}\n${timestamp}\n${body}`).digest("hex");
    const response = await fetchImpl(new URL(path, origin), { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", "x-local-reader-timestamp": timestamp, "x-local-reader-signature": signature }, body });
    if (!response.ok) throw new Error("PROVIDER_COORDINATION_REJECTED");
    return await response.json() as { lease?: ProviderRequestLease | null };
  }
  return async function lease<T>(providerFamily: string, work: () => Promise<T>): Promise<{ acquired: true; value: Awaited<T> } | { acquired: false }> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { lease: acquired } = await post({ action: "acquire", providerFamily });
      if (acquired) {
        try { return { acquired: true, value: await work() }; }
        finally { await post({ action: "release", lease: acquired }); }
      }
      if (attempt < 7) await new Promise(resolve => setTimeout(resolve, 500));
    }
    return { acquired: false };
  };
}
