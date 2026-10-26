import { createInterface } from "node:readline";
import { z } from "zod";
import { createGuardedStagehandSourceBrowser } from "../../src/lib/course-discovery/stagehand-source-browser";
import { remoteProviderLease } from "../../src/lib/course-discovery/remote-provider-lease";
import { isSafeRecipeUrl } from "../../src/lib/course-discovery/recipe";

const command = z.discriminatedUnion("action", [
  z.object({ id: z.number().int().positive(), action: z.literal("start") }).strict(),
  z.object({ id: z.number().int().positive(), action: z.literal("assert"), ids: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u)).min(1).max(8) }).strict(),
  z.object({ id: z.number().int().positive(), action: z.literal("before"), targetId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u), href: z.string().max(2048).optional() }).strict(),
  z.object({ id: z.number().int().positive(), action: z.literal("frames"), targetId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u) }).strict(),
  z.object({ id: z.number().int().positive(), action: z.literal("frame_prepare"), targetId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u), url: z.string().max(2048).refine(isSafeRecipeUrl) }).strict(),
  z.object({ id: z.number().int().positive(), action: z.literal("frame_complete"), targetId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u), url: z.string().max(2048).refine(isSafeRecipeUrl) }).strict(),
  z.object({ id: z.number().int().positive(), action: z.literal("navigate"), url: z.string().max(2048).refine(isSafeRecipeUrl) }).strict(),
  z.object({ id: z.number().int().positive(), action: z.literal("finish") }).strict(),
  z.object({ id: z.number().int().positive(), action: z.literal("diagnostic") }).strict(),
]);
const code = (error: unknown) => error instanceof Error && ["STAGEHAND_GUARDED_SOURCE_REJECTED", "OWNED_STAGEHAND_CDP_UNAVAILABLE",
  "OWNED_PUBLIC_CDP_UNAVAILABLE", "PROVIDER_COORDINATION_UNAVAILABLE"].includes(error.message) ? error.message : "STAGEHAND_NATIVE_HOST_FAILED";
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== "--deadline" || args[2] !== "--official-url" || args[4] !== "--time-zone" ||
      !isSafeRecipeUrl(args[3]) || process.env.COURSE_DISCOVERY_BROWSER_TRANSPORT !== "NATIVE_CHROME") throw Error("STAGEHAND_NATIVE_HOST_FAILED");
  const deadlineAt = new Date(args[1]);
  const requestLease = remoteProviderLease();
  const host = await createGuardedStagehandSourceBrowser({ deadlineAt, initialUrl: args[3], timeZone: args[5] }, { requestLease });
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const stop = () => { reader.close(); void host.close(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  const timer = setTimeout(stop, Math.max(1, deadlineAt.getTime() - Date.now()));
  try {
    for await (const line of reader) {
      let id: number | null = null;
      try {
        if (Buffer.byteLength(line) > 16384) throw Error("STAGEHAND_NATIVE_HOST_FAILED");
        const value = command.parse(JSON.parse(line)); id = value.id;
        const result = value.action === "start" ? { kind: host.kind, cdpUrl: host.cdpUrl, targetId: host.targetId }
          : value.action === "assert" ? { guarded: await host.assertGuardedTargets(value.ids) }
          : value.action === "before" ? { ready: true, witness: await host.beforeAction(value.targetId, value.href) }
          : value.action === "frames" ? await host.observeFrameSources(value.targetId)
          : value.action === "frame_prepare" ? await host.prepareFrameNavigation(value.targetId, value.url)
          : value.action === "frame_complete" ? await host.completeFrameNavigation(value.targetId, value.url)
          : value.action === "navigate" ? (await host.prepareNavigation(value.url), { ready: true })
          : value.action === "diagnostic" ? host.snapshotFailures()
          : await host.close();
        // This private controller pipe is never connected to a model/report.
        process.stdout.write(JSON.stringify({ id, ok: true, result }) + "\n");
        if (value.action === "finish") break;
      } catch (error) { process.stdout.write(JSON.stringify({ id, ok: false, error: code(error) }) + "\n"); }
    }
  } finally { clearTimeout(timer); process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); reader.close(); await host.close(); }
}
void main().catch(error => { process.stderr.write(code(error) + "\n"); process.exitCode = 1; });
