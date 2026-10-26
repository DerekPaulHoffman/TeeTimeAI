import { discoveryError } from "./course-discovery-client.mjs";
import { createDiscoveryBrowser, validateDiscoveryRecipe, createDiscoveryAdapterObservation,
  bindDiscoveryRecipeIdentity, inspectedAdapterSourceEvidence, executeDiscoveryRecipe, verifyDiscoveryCandidate } from "./course-discovery-worker.mjs";
import { STAGEHAND_SOURCE_BUDGET_MS, stagehandWorkDeadline, publicStagehandJob, publicStagehandSourceUrl,
  validateStagehandSourceReport, createStagehandSourceCheckpoint, readStagehandSourceCheckpoint, stagehandSourceFailureCode } from "./course-discovery-stagehand-source.mjs";
import { inspectStagehandAdapter } from "./course-discovery-stagehand-inspection.mjs";
import { createStagehandGuardedBrowserHost } from "./course-discovery-stagehand-host.mjs";
import { createStagehandFailureCheckpoint, packStagehandCheckpoint, readStagehandFailure } from "./course-discovery-stagehand-failure.mjs";

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
  let reference, report, lastProgress, checkpointTail = Promise.resolve(), activationAcknowledged = false, checkpointLeaseRetired = false, phase = "SOURCE_RESUME";
  let failureEvidence = readStagehandFailure(job, now());
  const checkpoint = (phase, replay) => {
    const progress = { phase, ...(replay ? { replay } : {}) };
    lastProgress = progress;
    const value = packStagehandCheckpoint({ reference, failure: failureEvidence, progress });
    return client.checkpoint(job.id, job.leaseToken, value, signal).catch(error => {
      if (["DISCOVERY_LEASE_REJECTED", "DISCOVERY_LEASE_EXPIRED"].includes(error?.code)) checkpointLeaseRetired = true;
      throw error;
    });
  };
  try {
    check();
    reference = readStagehandSourceCheckpoint(job, workDeadlineAt, now());
    if (reference) {
      metrics.sourceResumed = true;
      report = reference.report;
    } else {
      phase = "SOURCE_DISCOVERY";
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
      phase = "SOURCE_VALIDATION";
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
    phase = "FIXED_INSPECTION";
    const prepared = await inspectStagehandAdapter({ report, adapterSourceProposal: report.adapterSourceProposal,
      job, client, cwd, workDeadlineAt: new Date(deadline).toISOString(), signal, now,
      worker: { createDiscoveryBrowser: browserFactory, validateDiscoveryRecipe: ({ recipe, signal }) => validateRecipe({ recipe, signal }),
        createDiscoveryAdapterObservation, bindDiscoveryRecipeIdentity, inspectedAdapterSourceEvidence },
      onReceipt: receipt => { metrics.inspection = receipt; publishMetrics(); } });
    check();
    phase = "RECIPE_VALIDATION";
    const validation = await validateRecipe({ recipe: prepared.recipe, signal });
    if (validation.valid !== true) throw discoveryError("DISCOVERY_RECIPE_INVALID");
    await checkpoint("FIXED_INSPECTION_COMPLETE");
    phase = "REPLAY";
    const activation = await verifyDiscoveryCandidate({ client, job, recipe: prepared.recipe, sourceEvidence: prepared.sourceEvidence, signal, executeRecipe,
      onReplay: replay => {
        metrics.replayDurationsMs.push(replay.elapsedMs);
        publishMetrics();
        checkpointTail = checkpointTail.then(() => checkpoint("INDEPENDENT_REPLAY", replay)).catch(() => {});
      },
      beforeActivate: async () => { await checkpointTail; check(); phase = "ACTIVATION"; await beforeActivate(); },
      afterActivate: () => { activationAcknowledged = true; return afterActivate({ metrics }); },
    });
    publishMetrics();
    return { outcome: "activated", activation, metrics };
  } catch (failure) {
    const error = failure instanceof Error ? failure : discoveryError("STAGEHAND_WORKER_FAILED");
    // Finish any queued replay checkpoint first. Diagnostic persistence can
    // neither renew authority nor replace the original failure.
    checkpointTail = checkpointTail.then(async () => {
      if (activationAcknowledged || checkpointLeaseRetired) { metrics.failureCheckpoint = "SKIPPED_RETIRED"; return; }
      if (signal?.aborted) { metrics.failureCheckpoint = "SKIPPED_ABORTED"; return; }
      if (["DISCOVERY_LEASE_REJECTED", "DISCOVERY_LEASE_EXPIRED"].includes(error.code)) { metrics.failureCheckpoint = "SKIPPED_RETIRED"; return; }
      if (now() >= deadline) { metrics.failureCheckpoint = "SKIPPED_DEADLINE"; return; }
      const value = createStagehandFailureCheckpoint({ job, report, error, phase, metrics, reference, progress: lastProgress, previous: failureEvidence, now: now(), startedAt: started });
      await client.checkpoint(job.id, job.leaseToken, value, signal);
      failureEvidence = value.stagehandFailure; metrics.failureCheckpoint = "SAVED";
    }).catch(() => { metrics.failureCheckpoint = "NOT_PERSISTED"; });
    await checkpointTail;
    publishMetrics();
    error.discoveryMetrics = metrics;
    throw error;
  } finally {
    // No diagnostic write is started after the backend retires this lease.
    if (!activationAcknowledged) await checkpointTail;
  }
}
