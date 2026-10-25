import { join } from "node:path";
import { discoveryError } from "./course-discovery-client.mjs";
import { createDiscoveryProcess, discoveryProcessEnvironment } from "./course-discovery-worker.mjs";

/** Private guarded browser attachment. No caller may serialize this capability into model data. */
export async function createStagehandGuardedBrowserHost({ cwd, initialUrl, timeZone, deadlineAt, helperEnvironment, signal,
  processFactory = createDiscoveryProcess }) {
  if (helperEnvironment?.COURSE_DISCOVERY_BROWSER_TRANSPORT !== "NATIVE_CHROME" ||
      helperEnvironment.COURSE_DISCOVERY_JOB_KIND !== "discovery" || !helperEnvironment.COURSE_DISCOVERY_JOB_ID ||
      typeof helperEnvironment.COURSE_DISCOVERY_LEASE_TOKEN !== "string" || !helperEnvironment.COURSE_DISCOVERY_LEASE_TOKEN)
    throw discoveryError("STAGEHAND_NATIVE_HOST_SCOPE_INVALID");
  const remaining = Date.parse(deadlineAt) - Date.now();
  if (!(remaining > 0 && remaining <= 120000)) throw discoveryError("STAGEHAND_NATIVE_HOST_DEADLINE");
  const channel = processFactory({ executable: process.execPath,
    args: [join(cwd, "node_modules/tsx/dist/cli.mjs"), join(cwd, "scripts/automation/course-discovery-stagehand-browser.ts"),
      "--deadline", deadlineAt, "--official-url", initialUrl, "--time-zone", timeZone], cwd,
    environment: { ...discoveryProcessEnvironment(), ...helperEnvironment }, signal, timeoutMs: Math.min(30000, remaining) });
  let closing;
  const close = () => closing ??= (async () => {
    let receipt = { browserClosed: false, providerRequestsDrained: false };
    try { receipt = await channel.request({ action: "finish" }); } catch { /* Never infer browser closure from child exit alone. */ }
    finally { await channel.close(); }
    return receipt;
  })();
  try {
    const attachment = await channel.request({ action: "start" });
    if (attachment?.kind !== "OWNED_GUARDED_STAGEHAND_CONTEXT" ||
        !/^ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/devtools\/browser\/[a-f0-9-]{20,80}$/u.test(attachment.cdpUrl ?? "") ||
        !/^[A-Za-z0-9_-]{1,200}$/u.test(attachment.targetId ?? "")) throw discoveryError("STAGEHAND_NATIVE_HOST_INVALID");
    return {
      ...attachment,
      assertGuardedTargets: async ids => (await channel.request({ action: "assert", ids })).guarded === true,
      beforeAction: async (targetId, href) => { if ((await channel.request({ action: "before", targetId, ...(href === undefined ? {} : { href }) })).ready !== true) throw discoveryError("STAGEHAND_NATIVE_HOST_INVALID"); },
      prepareNavigation: async url => { if ((await channel.request({ action: "navigate", url })).ready !== true) throw discoveryError("STAGEHAND_NATIVE_HOST_INVALID"); },
      close,
    };
  } catch (error) { await close(); throw error; }
}
