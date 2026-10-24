import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCourseDiscoveryClient, discoveryError } from "./course-discovery-client.mjs";
import { executeDiscoveryRecipe, noVerifiedRecipeDiagnostic, prepareDiscoveryModelCatalog, runCourseDiscoveryWorker } from "./course-discovery-worker.mjs";

export const DISCOVERY_POLL_MS = 15_000;
export const DISCOVERY_HEARTBEAT_MS = 15_000;
export const DISCOVERY_CONCURRENCY = 3;
export const DISCOVERY_WORK_BUDGET_MS = 12 * 60_000;
export const DISCOVERY_CLOCK_SKEW_MS = 5_000;
export const DISCOVERY_MODEL_OVERLOAD_COOLDOWN_MS = 45_000;
export function discoveryWorkDeadline(job) {
  const firstPickup = Date.parse(job.firstPickedUpAt);
  const absolute = Date.parse(job.deadlineAt);
  return Math.min(absolute, (Number.isFinite(firstPickup) ? firstPickup : absolute - 15 * 60_000) + DISCOVERY_WORK_BUDGET_MS);
}

export function validateClaimedDiscoveryJob(job, now = Date.now()) {
  const firstPickup = Date.parse(job?.firstPickedUpAt);
  const deadline = Date.parse(job?.deadlineAt);
  if (!job || typeof job.id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/u.test(job.id) ||
      typeof job.leaseToken !== "string" || job.leaseToken.length < 16 ||
      !Number.isInteger(job.attempts) || job.attempts < 1 || job.attempts > 2 ||
      !Number.isFinite(firstPickup) || !Number.isFinite(deadline) || deadline <= now ||
      deadline <= firstPickup || deadline - firstPickup > 15 * 60_000 || firstPickup > now + DISCOVERY_CLOCK_SKEW_MS ||
      !job.request?.identity || !job.request?.target || !job.request?.input) {
    throw discoveryError("DISCOVERY_JOB_INVALID");
  }
  return job;
}

export function validateClaimedRecipeExecution(job, now = Date.now()) {
  // The server owns the exact three-minute expiry. Allow only a bounded
  // cross-machine clock offset here; never change the received deadline.
  if (!job || typeof job.id !== "string" || typeof job.leaseToken !== "string" || !job.recipe || !job.input ||
      !(Date.parse(job.deadlineAt) > now) || Date.parse(job.deadlineAt) - now > 3 * 60_000 + DISCOVERY_CLOCK_SKEW_MS)
    throw discoveryError("DISCOVERY_EXECUTION_INVALID");
  return job;
}

/** Polling, leases and deadlines are controller-owned, independent of inference. */
export function createCourseDiscoverySupervisor({ client, startWorker, executeRecipe, prepareWorker, workerId = `discovery-${randomUUID()}`,
  now = Date.now, onEvent = () => {}, timers = { setInterval, clearInterval, setTimeout, clearTimeout } }) {
  const active = new Map();
  let stopped = false;
  let polling = false;
  let pollTimer;
  let pollPromise;
  let workerPrepared = false;
  let preparation;
  const ensureWorkerPrepared = async () => {
    if (workerPrepared) return;
    try {
      preparation ??= Promise.resolve().then(() => prepareWorker?.());
      await preparation;
      workerPrepared = true;
    } catch (error) {
      preparation = undefined;
      throw error;
    }
  };
  const emit = (event, detail = {}) => onEvent({ event, active: active.size, ...detail });

  function launch(job, execution = false) {
    const controller = new AbortController();
    const entry = { controller, promise: null, settled: false, heartbeatPending: false,
      heartbeatPromise: null, activationPreparing: false, activationReady: false };
    const key = `${execution ? "execution" : "discovery"}:${job.id}`;
    const jobEvent = { jobId: job.id, kind: execution ? "execution" : "discovery",
      firstPickedUpAt: job.firstPickedUpAt ?? null, startedAt: new Date(now()).toISOString(), deadlineAt: job.deadlineAt,
      ...(!execution ? { workDeadlineAt: new Date(discoveryWorkDeadline(job)).toISOString() } : {}),
      ...(job.coldStart ? { coldStart: job.coldStart } : {}) };
    active.set(key, entry);
    let failureReason = "TOOL_FAILURE";
    const deadlineTimer = timers.setTimeout(() => {
      failureReason = "DEADLINE";
      controller.abort(discoveryError("DISCOVERY_DEADLINE"));
    }, Math.max(0, (execution ? Date.parse(job.deadlineAt) : discoveryWorkDeadline(job)) - now()));
    let leaseTimer;
    const renewLocalLease = expiresAt => {
      if (execution) return;
      timers.clearTimeout(leaseTimer);
      const parsed = Date.parse(expiresAt);
      entry.leaseExpiresAt = Math.min(Date.parse(job.deadlineAt), Number.isFinite(parsed) ? parsed : now() + 90_000);
      leaseTimer = timers.setTimeout(() => controller.abort(discoveryError("DISCOVERY_LEASE_EXPIRED")), Math.max(1, entry.leaseExpiresAt - now()));
    };
    renewLocalLease(job.leaseExpiresAt);
    const heartbeatTimer = timers.setInterval(() => {
      if (execution || entry.settled || entry.activationPreparing || entry.heartbeatPending || controller.signal.aborted) return;
      entry.heartbeatPending = true;
      entry.heartbeatPromise = (async () => {
        try {
          const acknowledged = await client.heartbeat(job.id, job.leaseToken, controller.signal);
          if (!controller.signal.aborted) renewLocalLease(acknowledged?.job?.leaseExpiresAt);
        } catch (error) {
          if (controller.signal.aborted || entry.settled) return;
          if (error?.code === "DISCOVERY_LEASE_REJECTED" || error?.status === 409) controller.abort(discoveryError("DISCOVERY_LEASE_REJECTED"));
          else if (now() >= entry.leaseExpiresAt) controller.abort(discoveryError("DISCOVERY_LEASE_EXPIRED"));
          else emit("heartbeat_retry_pending", { ...jobEvent });
        }
        finally { entry.heartbeatPending = false; }
      })();
    }, DISCOVERY_HEARTBEAT_MS);
    const cancelled = new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason ?? discoveryError("DISCOVERY_CANCELLED")), { once: true }));
    cancelled.catch(() => {});
    let activationAcknowledgedAt;
    let activationAcknowledgedMs;
    let acknowledgedMetrics;
    let postActivationTimer;
    let postActivationBudgetExpired = false;
    let rejectPostActivationCleanup;
    const postActivationCleanup = new Promise((_, reject) => { rejectPostActivationCleanup = reject; });
    postActivationCleanup.catch(() => {});
    const assertLiveActivationFences = () => {
      if (!controller.signal.aborted && now() >= entry.leaseExpiresAt) controller.abort(discoveryError("DISCOVERY_LEASE_EXPIRED"));
      if (!controller.signal.aborted && discoveryWorkDeadline(job) <= now()) {
        failureReason = "DEADLINE";
        controller.abort(discoveryError("DISCOVERY_DEADLINE"));
      }
      controller.signal.throwIfAborted();
    };
    const beforeActivate = async () => {
      // Activation retires the server lease. Stop new heartbeats and drain the
      // existing request before its final CAS; expiry/deadline timers stay live.
      if (activationAcknowledgedAt) throw discoveryError("DISCOVERY_ALREADY_ACTIVATED");
      entry.activationPreparing = true;
      timers.clearInterval(heartbeatTimer);
      if (entry.heartbeatPromise) await Promise.race([entry.heartbeatPromise, cancelled]);
      assertLiveActivationFences();
      entry.activationReady = true;
    };
    const afterActivate = ({ metrics } = {}) => {
      // Only the trusted worker calls this after the server activation ACK.
      // A late ACK cannot resurrect a pre-existing lease/deadline cancellation.
      if (!entry.activationReady || entry.heartbeatPending || activationAcknowledgedAt ||
          !metrics || typeof metrics !== "object" || Array.isArray(metrics)) throw discoveryError("DISCOVERY_ACTIVATION_ACK_INVALID");
      assertLiveActivationFences();
      acknowledgedMetrics = structuredClone(metrics);
      activationAcknowledgedMs = now();
      activationAcknowledgedAt = new Date(activationAcknowledgedMs).toISOString();
      timers.clearTimeout(deadlineTimer);
      timers.clearTimeout(leaseTimer);
      postActivationTimer = timers.setTimeout(() => {
        postActivationBudgetExpired = true;
        rejectPostActivationCleanup(discoveryError("DISCOVERY_POST_ACTIVATION_CLEANUP_PENDING"));
      }, 5_000);
    };
    let running;
    let workerSettled = false;
    let settledWorkerOutcome;
    let settledWorkerMetrics;
    let endedEvent;
    let activatedEvent;
    entry.promise = (async () => {
      try {
        if (execution) {
          running = Promise.resolve().then(() => executeRecipe({ recipe: job.recipe, input: job.input, trustedContext: job.trustedContext, deadlineAt: job.deadlineAt,
            helperEnvironment: client.helperEnvironment?.("execution", job), signal: controller.signal }));
          const result = await Promise.race([running, cancelled]);
          await client.executionResult(job.id, job.leaseToken, result, controller.signal);
          emit("execution_completed", { ...jobEvent, completedAt: new Date(now()).toISOString() });
        } else {
          if (discoveryWorkDeadline(job) <= now()) { failureReason = "DEADLINE"; throw discoveryError("DISCOVERY_WORK_DEADLINE"); }
          running = Promise.resolve().then(() => startWorker({ job, workDeadlineAt: new Date(discoveryWorkDeadline(job)).toISOString(), signal: controller.signal, beforeActivate, afterActivate }));
          // Cancellation can win the outer race while the worker is collecting
          // final usage during cleanup. Retain that result without changing the
          // supervisor's lease outcome or claiming activation from a 409.
          running.then(outcome => { workerSettled = true; settledWorkerOutcome = outcome; settledWorkerMetrics = outcome?.metrics; },
            error => { workerSettled = true; settledWorkerMetrics = error?.discoveryMetrics; });
          const outcome = await Promise.race([running, cancelled, postActivationCleanup]);
          if (outcome?.outcome !== "activated") throw discoveryError("DISCOVERY_NO_VERIFIED_RECIPE");
          activatedEvent = { ...jobEvent, completedAt: new Date(now()).toISOString(), metrics: outcome.metrics };
        }
      } catch (error) {
        if (!execution && !activationAcknowledgedAt && job.attempts === 1 && error?.code === "DISCOVERY_TURN_FAILED" &&
            error?.discoveryMetrics?.modelFailure?.errorCategory === "serverOverloaded") {
          // Delay only the existing retry. Keep this owned lease and heartbeat
          // live; cancellation and the original work deadline still win.
          let cooldownTimer;
          try {
            assertLiveActivationFences();
            await Promise.race([
              new Promise(done => { cooldownTimer = timers.setTimeout(done,
                Math.min(DISCOVERY_MODEL_OVERLOAD_COOLDOWN_MS, discoveryWorkDeadline(job) - now())); }),
              cancelled, postActivationCleanup,
            ]);
            if (!activationAcknowledgedAt) assertLiveActivationFences();
          } catch (cooldownError) { error = cooldownError; }
          finally { timers.clearTimeout(cooldownTimer); }
        }
        if (activationAcknowledgedAt) {
          // The backend activation is durable even if local cleanup fails or
          // exceeds its own budget. Never send fail after its acknowledged CAS.
          activatedEvent = { ...jobEvent, completedAt: new Date(now()).toISOString() };
        } else {
          if (!execution && !stopped && !["DISCOVERY_LEASE_REJECTED", "DISCOVERY_LEASE_EXPIRED"].includes(error?.code)) {
            if (error?.code === "DISCOVERY_ACCESS_REQUIRED") failureReason = "ACCESS_REQUIRED";
            else if (error?.code === "DISCOVERY_UNSUPPORTED") failureReason = "UNSUPPORTED";
            try { await client.fail(job.id, job.leaseToken, failureReason, failureReason === "TOOL_FAILURE"); }
            catch { /* A stale lease must never be rebound or retried locally. */ }
          }
          endedEvent = { ...jobEvent, completedAt: new Date(now()).toISOString(),
            ...(error?.discoveryMetrics ? { metrics: error.discoveryMetrics } : {}),
            ...(error?.code === "DISCOVERY_NO_VERIFIED_RECIPE" ? {
              diagnosticCode: "NO_VERIFIED_RECIPE", diagnosticReason: noVerifiedRecipeDiagnostic(error.discoveryDiagnostic?.evidence).reason,
            } : {}),
            code: /^[A-Z_]+$/u.test(error?.code ?? "") ? error.code : "DISCOVERY_WORKER_FAILED" };
        }
      } finally {
        entry.settled = true;
        timers.clearInterval(heartbeatTimer);
        timers.clearTimeout(deadlineTimer);
        timers.clearTimeout(leaseTimer);
        timers.clearTimeout(postActivationTimer);
        if (!controller.signal.aborted) controller.abort(discoveryError("DISCOVERY_ATTEMPT_FINISHED"));
        // Keep the slot until cooperative process cleanup completes, bounded if a worker wedges.
        let cleanupTimer;
        const cleanupMs = activationAcknowledgedAt ? Math.max(0, 5_000 - (now() - activationAcknowledgedMs)) : 5_000;
        if (!postActivationBudgetExpired && cleanupMs > 0) {
          await Promise.race([running?.catch(() => {}), new Promise(done => { cleanupTimer = timers.setTimeout(done, cleanupMs); })]);
        }
        timers.clearTimeout(cleanupTimer);
        if (activatedEvent) {
          if (activationAcknowledgedAt) {
            const finalMetrics = !postActivationBudgetExpired && workerSettled && settledWorkerOutcome?.outcome === "activated" &&
              settledWorkerMetrics && typeof settledWorkerMetrics === "object" && !Array.isArray(settledWorkerMetrics);
            emit("activated", { ...activatedEvent, activationAcknowledgedAt, metrics: finalMetrics
              ? { ...structuredClone(settledWorkerMetrics), metricsFinal: true }
              : { ...acknowledgedMetrics, metricsFinal: false, cleanupWarning: "POST_ACTIVATION_CLEANUP_PENDING" } });
          } else emit("activated", activatedEvent);
        }
        if (endedEvent) emit("attempt_ended", { ...endedEvent,
          ...(endedEvent.metrics ?? settledWorkerMetrics ? { metrics: endedEvent.metrics ?? settledWorkerMetrics } : {}) });
        active.delete(key);
      }
    })();
  }

  async function tick() {
    if (stopped || polling) return;
    polling = true;
    try {
      while (!stopped && active.size < DISCOVERY_CONCURRENCY) {
        if (client.nextExecution && executeRecipe) {
          const { job: execution } = await client.nextExecution(workerId);
          if (execution && !stopped) {
            validateClaimedRecipeExecution(execution, now());
            if (active.has(`execution:${execution.id}`)) { emit("duplicate_claim_rejected"); break; }
            launch(execution, true);
            continue;
          }
        }
        // Warm recipes need no model catalog. Prepare cold-worker capability
        // before claiming a job so a local prerequisite cannot consume an attempt.
        await ensureWorkerPrepared();
        if (stopped) break;
        const { job } = await client.next(workerId);
        if (!job || stopped) break;
        validateClaimedDiscoveryJob(job, now());
        if (active.has(`discovery:${job.id}`)) { emit("duplicate_claim_rejected"); break; }
        launch(job);
      }
    } catch (error) {
      emit("poll_failed", { code: /^[A-Z_]+$/u.test(error?.code ?? "") ? error.code : "DISCOVERY_API_UNAVAILABLE" });
    } finally { polling = false; emit("poll_completed", { observedAt: new Date(now()).toISOString() }); }
  }
  return {
    get activeCount() { return active.size; },
    tick() { pollPromise = tick(); return pollPromise; },
    start() {
      if (stopped || pollTimer) throw discoveryError("DISCOVERY_SUPERVISOR_ALREADY_STARTED");
      emit("supervisor_started", { observedAt: new Date(now()).toISOString() });
      pollTimer = timers.setInterval(() => { pollPromise = tick(); }, DISCOVERY_POLL_MS);
      pollPromise = tick();
      return pollPromise;
    },
    async stop() {
      stopped = true;
      timers.clearInterval(pollTimer);
      for (const entry of active.values()) entry.controller.abort(discoveryError("DISCOVERY_CANCELLED"));
      await pollPromise;
      await Promise.allSettled([...active.values()].map(entry => entry.promise));
    },
  };
}

async function main() {
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const client = createCourseDiscoveryClient({
    baseUrl: process.env.COURSE_DISCOVERY_API_ORIGIN,
    deviceToken: process.env.LOCAL_READER_DEVICE_TOKEN,
    browserTransport: process.env.COURSE_DISCOVERY_BROWSER_TRANSPORT ?? "PINNED_HTTP",
  });
  let modelCatalogJson;
  const supervisor = createCourseDiscoverySupervisor({ client,
    prepareWorker: () => { modelCatalogJson = prepareDiscoveryModelCatalog(); },
    startWorker: options => runCourseDiscoveryWorker({ ...options, client, cwd, modelCatalogJson }),
    executeRecipe: options => executeDiscoveryRecipe({ ...options, cwd }),
    onEvent: event => process.stdout.write(`${JSON.stringify(event)}\n`),
  });
  const stop = () => { void supervisor.stop().then(() => { process.exitCode = 0; }); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await supervisor.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${error.code ?? "DISCOVERY_SUPERVISOR_FAILED"}\n`); process.exitCode = 1; });
}
