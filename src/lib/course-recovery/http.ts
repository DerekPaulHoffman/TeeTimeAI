import { createHmac, randomBytes } from "node:crypto";
const processSalt = randomBytes(32);
/** Daily, expiring abuse keys; development deliberately groups all callers. */
export function recoverySourceBucket(request: Request, now = new Date()) {
  const source = process.env.VERCEL ? (request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ?? "unknown") : "local";
  return createHmac("sha256", process.env.CRON_SECRET ?? processSalt)
    .update(`${now.toISOString().slice(0, 10)}|${source}`).digest("hex");
}

export async function readRecoveryJson(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Enter the course name and town.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      size += value.value.byteLength;
      if (size > 4096) throw new Error("The course request is too large.");
      chunks.push(value.value);
    }
  } finally { await reader.cancel(); }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(joined)) as unknown;
}

export function isRecoverySameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}
