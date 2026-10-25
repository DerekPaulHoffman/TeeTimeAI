import { discoveryError } from "./course-discovery-client.mjs";
import { createDiscoveryBrowser, validateDiscoveryRecipe, createDiscoveryAdapterObservation,
  bindDiscoveryRecipeIdentity, inspectedAdapterSourceEvidence, executeDiscoveryRecipe, verifyDiscoveryCandidate } from "./course-discovery-worker.mjs";
import { STAGEHAND_SOURCE_BUDGET_MS, stagehandWorkDeadline, publicStagehandJob, publicStagehandSourceUrl,
  validateStagehandSourceReport, createStagehandSourceCheckpoint, readStagehandSourceCheckpoint, stagehandSourceFailureCode } from "./course-discovery-stagehand-source.mjs";
import { inspectStagehandAdapter } from "./course-discovery-stagehand-inspection.mjs";
import { createStagehandGuardedBrowserHost } from "./course-discovery-stagehand-host.mjs";

const defaultSourceDiscover = async args => (await import("./stagehand/source-discovery.mjs")).sourceDiscover(args);
/** Readiness only; the supervisor performs this before claiming cold demand. */
export async function prepareCourseDiscoveryStagehandWorker({ cwd, prepareSourceDiscovery } = {}) {
  const prepare = prepareSourceDiscovery ?? (await import("./stagehand/source-discovery.mjs")).prepareSourceDiscovery;
  if (typeof prepare !== "function") throw discoveryError("STAGEHAND_SOURCE_READINESS_UNAVAILABLE");
  return prepare({ cwd });
}

function sourceMetrics(report) {
  const calls = Array.isArray(report?.metrics?.localCodexCalls) ? report.metrics.localCodexCalls.filter(call => call?.usage && call.model === "gpt-6.1-sol") : [];
  const tokenUsage = {};
  for (const field of ["totalTokens", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"])
    tokenUsage[field] = calls.reduce((sum, call) => sum + (Number.isSafeInteger(call.usage[field]) && call.usage[field] >= 0 ? call.usage[field] : 0), 0);
  return { modelCalls: calls.length, tokenUsage };
}

/** Source routing has no customer, provider, identity, inventory, or activation authority.
 * Only fresh native inspection and the existing server-issued verifier can create a method. */
export async function runCourseDiscoveryStagehandWorker({
  job, workDeadlineAt, client, cwd, signal, beforeActivate = async () => {}, afterActivate = async () => {},
  sourceDiscover = defaultSourceDiscover, browserFactory = createDiscoveryBrowser,
  guardedBrowserFactory = args => createStagehandGuardedBrowserHost(args),
  validateRecipe = args => validateDiscoveryRecipe({ cwd, ...args }),
  executeRecipe = args => executeDiscoveryRecipe({ cwd, helperEnvironment: client.helperEnvironment("discovery", job), ...args }),
  now = Date.now, model = "gpt-6.1-sol", onMetrics = () => {},
}) {
  if (model !== "gpt-6.1-sol") throw discoveryError("DISCOVERY_MODEL_NOT_ALLOWED");
  const deadline = stagehandWorkDeadline(job, workDeadlineAt), started = now();
  const check = () => {
    signal?.throwIfAborted();
    if (now() >= deadline) throw discoveryError("DISCOVERY_WORK_DEADLINE");
  };
  if (!job || !/^[A-Za-z0-9_-]{1,200}$/u.test(job.id ?? "") || typeof job.leaseToken !== "string" || job.leaseToken.length < 16 ||
      ![1, 2].includes(job.attempts) || !publicStagehandSourceUrl(job.request?.identity?.officialUrl) ||
      Date.parse(job.firstPickedUpAt) > now() + 5000) throw discoveryError("DISCOVERY_JOB_INVALID");
  const metrics = { model: "gpt-6.1-sol", reasoningEffort: "medium", framework: "Stagehand", frameworkRole: "SOURCE_DISCOVERY_ONLY",
    modelCalls: 0, tokenUsage: {}, sourceUsageRecordedLowerBound: true, sourceResumed: false, sourceElapsedMs: 0, fixedInspectionModelCalls: 0, replayModelCalls: 0, replayDurationsMs: [] };
  const publishMetrics = () => { try { onMetrics(structuredClone(metrics)); } catch { /* Diagnostic listeners confer no worker authority. */ } };
  let reference, checkpointTail = Promise.resolve(), activationAcknowledged = false;
  const checkpoint = (phase, replay) => {
    const progress = { phase, ...(replay ? { replay } : {}) };
    let value = { stagehandSource: reference, stagehandProgress: progress };
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > 32_000 && replay?.result?.diagnostic) {
      const { diagnostic: omitted, ...result } = replay.result;
      value = { stagehandSource: reference, stagehandProgress: { phase, replay: { ...replay, result } } };
      void omitted;
    }
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > 32_000) throw discoveryError("STAGEHAND_SOURCE_CHECKPOINT_LIMIT");
    return client.checkpoint(job.id, job.leaseToken, value, signal);
  };
  try {
    check();
    reference = readStagehandSourceCheckpoint(job, workDeadlineAt, now());
    let report;
    if (reference) {
      metrics.sourceResumed = true;
      report = reference.report;
    } else {
      // The database clock may be up to the admitted 5s ahead of this host.
      // Narrow the local work allowance; never move either original clock or
      // extend the source ceiling measured from the original first pickup.
      const sourceDeadline = Math.min(deadline, Date.parse(job.firstPickedUpAt) + STAGEHAND_SOURCE_BUDGET_MS, now() + STAGEHAND_SOURCE_BUDGET_MS);
      if (now() >= sourceDeadline) throw discoveryError("STAGEHAND_SOURCE_BUDGET_EXHAUSTED");
      const sourceSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.max(1, sourceDeadline - now()))]);
      report = await sourceDiscover({ job: publicStagehandJob(job), cwd, deadlineAt: new Date(sourceDeadline).toISOString(), signal: sourceSignal,
        createGuardedBrowser: ({ deadlineAt, signal }) => guardedBrowserFactory({ cwd, initialUrl: job.request.identity.officialUrl,
          timeZone: job.request.input.timeZone, deadlineAt, signal, helperEnvironment: client.helperEnvironment("discovery", job) }),
        onMetrics: partial => { Object.assign(metrics, sourceMetrics({ metrics: partial })); publishMetrics(); } });
      Object.assign(metrics, sourceMetrics(report));
      metrics.sourceElapsedMs = Math.max(0, now() - started);
      publishMetrics();
      check();
      if (sourceSignal.aborted || now() >= sourceDeadline) throw discoveryError("STAGEHAND_SOURCE_BUDGET_EXHAUSTED");
      const sourceFailure = stagehandSourceFailureCode(report, job);
      if (sourceFailure) throw discoveryError(sourceFailure);
      validateStagehandSourceReport(report, job);
      reference = createStagehandSourceCheckpoint(job, report);
      await checkpoint("SOURCE_EXPORTED");
    }
    check();
    // Checkpoint rows are revalidated as routing evidence before EVERY fresh native inspection.
    validateStagehandSourceReport(report, job);
    const prepared = await inspectStagehandAdapter({ report, adapterSourceProposal: report.adapterSourceProposal,
      job, client, cwd, workDeadlineAt: new Date(deadline).toISOString(), signal, now,
      worker: { createDiscoveryBrowser: browserFactory, validateDiscoveryRecipe: ({ recipe, signal }) => validateRecipe({ recipe, signal }),
        createDiscoveryAdapterObservation, bindDiscoveryRecipeIdentity, inspectedAdapterSourceEvidence },
      onReceipt: receipt => { metrics.inspection = receipt; publishMetrics(); } });
    check();
    const validation = await validateRecipe({ recipe: prepared.recipe, signal });
    if (validation.valid !== true) throw discoveryError("DISCOVERY_RECIPE_INVALID");
    await checkpoint("FIXED_INSPECTION_COMPLETE");
    const activation = await verifyDiscoveryCandidate({ client, job, recipe: prepared.recipe, sourceEvidence: prepared.sourceEvidence, signal, executeRecipe,
      onReplay: replay => {
        metrics.replayDurationsMs.push(replay.elapsedMs);
        publishMetrics();
        checkpointTail = checkpointTail.then(() => checkpoint("INDEPENDENT_REPLAY", replay)).catch(() => {});
      },
      beforeActivate: async () => { await checkpointTail; check(); await beforeActivate(); },
      afterActivate: () => { activationAcknowledged = true; return afterActivate({ metrics }); },
    });
    publishMetrics();
    return { outcome: "activated", activation, metrics };
  } catch (failure) {
    const error = failure instanceof Error ? failure : discoveryError("STAGEHAND_WORKER_FAILED");
    publishMetrics();
    error.discoveryMetrics = metrics;
    throw error;
  } finally {
    // No diagnostic write is started after the backend retires this lease.
    if (!activationAcknowledged) await checkpointTail;
  }
}
