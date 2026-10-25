import { discoveryError } from "./course-discovery-client.mjs";
import { executeDiscoveryRecipe, prepareDiscoveryModelCatalog, runCourseDiscoveryWorker } from "./course-discovery-worker.mjs";
import { prepareCourseDiscoveryStagehandWorker, runCourseDiscoveryStagehandWorker } from "./course-discovery-stagehand-worker.mjs";

export const DISCOVERY_WORKER_MODES = Object.freeze(["STAGEHAND_SOL", "NATIVE_SOL", "REUSE_ONLY"]);

/** Controller selection is operator configuration, never model input.
 * REUSE_ONLY has no cold-claim or model-preparation capability. */
export function createCourseDiscoveryHandlers({ client, cwd, mode = "STAGEHAND_SOL",
  prepareStagehand = prepareCourseDiscoveryStagehandWorker, runStagehand = runCourseDiscoveryStagehandWorker,
  prepareNative = prepareDiscoveryModelCatalog, runNative = runCourseDiscoveryWorker,
  executeRecipe = executeDiscoveryRecipe } = {}) {
  if (!DISCOVERY_WORKER_MODES.includes(mode)) throw discoveryError("DISCOVERY_WORKER_MODE_INVALID");
  if (!client || typeof cwd !== "string" || !cwd) throw discoveryError("DISCOVERY_WORKER_CONFIGURATION_INVALID");
  let modelCatalogJson;
  const effectiveClient = mode === "REUSE_ONLY" ? { ...client, next: async () => ({ job: null }) } : client;
  return {
    mode,
    client: effectiveClient,
    prepareWorker: async () => {
      if (mode === "STAGEHAND_SOL") return prepareStagehand({ cwd });
      if (mode === "NATIVE_SOL") modelCatalogJson = prepareNative({ model: "gpt-6.1-sol" });
    },
    startWorker: options => {
      if (mode === "REUSE_ONLY") throw discoveryError("DISCOVERY_MODELS_DISABLED");
      if (mode === "STAGEHAND_SOL") return runStagehand({ ...options, client: effectiveClient, cwd, model: "gpt-6.1-sol" });
      return runNative({ ...options, client: effectiveClient, cwd, model: "gpt-6.1-sol", modelCatalogJson });
    },
    executeRecipe: options => executeRecipe({ ...options, cwd }),
  };
}
