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
  if (!(remaining > 0 && remaining <= 240000)) throw discoveryError("STAGEHAND_NATIVE_HOST_DEADLINE");
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
      completeGestureNavigation: targetId => channel.request({ action: "gesture_complete", targetId }),
      observeHistorySource: targetId => channel.request({ action: "history_source", targetId }),
      beforeAction: async (targetId, href, placeholder) => { const value = await channel.request({ action: "before", targetId, ...(href === undefined ? {} : { href }), ...(placeholder === undefined ? {} : { placeholder }) }); if (value.ready !== true) throw discoveryError("STAGEHAND_NATIVE_HOST_INVALID"); return value.witness; },
      observeFrameSources: targetId => channel.request({ action: "frames", targetId }),
      observeUniqueSource: targetId => channel.request({ action: "unique_source", targetId }),
      observeRootPublicWidget: targetId => channel.request({ action: "root_widget", targetId }),
      preparePublicBookingIntermediary: targetId => channel.request({ action: "intermediary_prepare", targetId }),
      completePublicBookingIntermediary: targetId => channel.request({ action: "intermediary_complete", targetId }),
      observeSourceReadiness: targetId => channel.request({ action: "readiness", targetId }),
      prepareFrameNavigation: (targetId, url) => channel.request({ action: "frame_prepare", targetId, url }),
      completeFrameNavigation: (targetId, url) => channel.request({ action: "frame_complete", targetId, url }),
      prepareNavigation: async url => { if ((await channel.request({ action: "navigate", url })).ready !== true) throw discoveryError("STAGEHAND_NATIVE_HOST_INVALID"); },
      snapshotFailure: async () => (await channel.request({ action: "diagnostic" })).ownedCdpFailure,
      snapshotFailures: async () => channel.request({ action: "diagnostic" }),
      close,
    };
  } catch (error) { await close(); throw error; }
}
