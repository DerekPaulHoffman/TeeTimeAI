import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const execute = promisify(execFile);
const reject = code => { throw Object.assign(new Error(code), { code }); };

function latestRuntimeCi(runtimeVersion, runs) {
  if (!/^[a-f0-9]{40}$/u.test(runtimeVersion ?? '')) reject('INVALID_RUNTIME_VERSION');
  const exactRuns = Array.isArray(runs) ? runs.filter(run => run.headSha === runtimeVersion) : [];
  // A branch pass cannot mask a later main failure. Reruns retain their run id,
  // so order by the current attempt's start time before using the id as a tie-break.
  if (!exactRuns.length || exactRuns.some(run => typeof run.startedAt !== 'string' || !Number.isFinite(Date.parse(run.startedAt)) ||
      !Number.isSafeInteger(run.databaseId) || run.databaseId <= 0 ||
      !Number.isSafeInteger(run.attempt) || run.attempt <= 0)) reject('RUNTIME_CI_REQUIRED');
  return exactRuns.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) ||
    b.databaseId - a.databaseId || b.attempt - a.attempt)[0];
}

export function validateDiscoveryRuntimeCi(runtimeVersion, runs) {
  const ci = latestRuntimeCi(runtimeVersion, runs);
  if (ci.status !== 'completed' || ci.conclusion !== 'success') reject('RUNTIME_CI_REQUIRED');
  return { runtimeVersion, runId: ci.databaseId, attempt: ci.attempt, conclusion: 'success' };
}

export function validateDiscoveryRuntimeRelease({ runtimeVersion, runs, deployments, inspections }) {
  const ci = validateDiscoveryRuntimeCi(runtimeVersion, runs);
  const candidate = deployments?.filter(d => d.meta?.githubCommitSha === runtimeVersion &&
    d.meta.githubCommitRef === 'main' && d.meta.githubDeployment === '1' && d.meta.branchAlias && d.url)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!candidate || candidate.state !== 'READY' || !Number.isFinite(candidate.createdAt)) reject('RUNTIME_GIT_DEPLOYMENT_REQUIRED');
  const aliases = ['teetimespot.com', 'www.teetimespot.com'];
  if (!Array.isArray(inspections) || inspections.length !== 2 ||
      aliases.some(alias => !inspections.some(item => item.alias === alias && item.inspection?.readyState === 'READY' &&
        item.inspection.url === candidate.url && /^dpl_[A-Za-z0-9]+$/u.test(item.inspection.id ?? ''))) ||
      inspections[0].inspection.id !== inspections[1].inspection.id) reject('RUNTIME_CANONICAL_ALIASES_REQUIRED');
  return { runtimeVersion, ciRunId: ci.runId, ciConclusion: 'success', deployment: {
    source: 'git', state: 'READY', commitSha: runtimeVersion, aliases,
    deploymentId: inspections[0].inspection.id, deploymentUrl: `https://${candidate.url}`,
    deployedAt: new Date(candidate.createdAt).toISOString() } };
}

const pendingCi = run => ['queued', 'in_progress', 'pending', 'waiting', 'requested'].includes(run.status) &&
  (run.conclusion === '' || run.conclusion === null);

/** Only read-only CI observation repeats. Never runs an updater, job, provider
 * read or mutation. A failed/malformed run or source/deployment mismatch stops. */
export async function waitForDiscoveryRuntimeRelease({ runtimeVersion, readRuns, readDeploymentEvidence }, dependencies = {}) {
  const now = dependencies.now ?? Date.now, sleep = dependencies.sleep ?? delay;
  const waitMs = dependencies.waitMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 10 * 60_000 || !Number.isFinite(now())) reject('INVALID_RUNTIME_PROOF_ARGUMENT');
  const deadline = now() + waitMs;
  const wait = async () => {
    const remaining = deadline - now();
    if (!Number.isFinite(remaining) || remaining <= 0) reject('RUNTIME_CI_PENDING_TIMEOUT');
    await sleep(Math.min(15_000, remaining));
  };
  while (true) {
    const runs = await readRuns(), ci = latestRuntimeCi(runtimeVersion, runs);
    if (pendingCi(ci)) { await wait(); continue; }
    if (ci.status !== 'completed' || ci.conclusion !== 'success') reject('RUNTIME_CI_REQUIRED');
    const evidence = await readDeploymentEvidence();
    // A newly started exact-head main run or rerun must not be hidden by the
    // earlier success observed before deployment inspection.
    const confirmed = await readRuns();
    if (pendingCi(latestRuntimeCi(runtimeVersion, confirmed))) { await wait(); continue; }
    return validateDiscoveryRuntimeRelease({ runtimeVersion, runs: confirmed, deployments: evidence.deployments, inspections: evidence.inspections });
  }
}

async function jsonCommand(command, args) {
  const { stdout } = await execute(command, args, { encoding: 'utf8', timeout: 120000,
    maxBuffer: 1024 * 1024, windowsHide: true });
  return JSON.parse(stdout);
}
function vercel(args) {
  if (args.some(arg => !/^[A-Za-z0-9_./:=,-]+$/u.test(arg))) reject('INVALID_RUNTIME_PROOF_ARGUMENT');
  return process.platform === 'win32'
    ? jsonCommand(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', ['npx', 'vercel', ...args].join(' ')])
    : jsonCommand('npx', ['vercel', ...args]);
}
async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--runtime-sha' || !/^[a-f0-9]{40}$/u.test(process.argv[3])) reject('INVALID_RUNTIME_VERSION');
  const runtimeVersion = process.argv[3];
  const proof = await waitForDiscoveryRuntimeRelease({ runtimeVersion,
    readRuns: () => jsonCommand(process.platform === 'win32' ? 'gh.exe' : 'gh', ['run', 'list', '--workflow', 'verify.yml', '--commit', runtimeVersion,
      '--json', 'databaseId,headSha,status,conclusion,startedAt,attempt', '--limit', '10']),
    readDeploymentEvidence: async () => {
      const [list, inspections] = await Promise.all([
        vercel(['ls', '--environment', 'production', '--meta', `githubCommitSha=${runtimeVersion}`, '--format', 'json', '--limit', '20']),
        Promise.all(['teetimespot.com', 'www.teetimespot.com'].map(async alias => ({ alias,
          inspection: await vercel(['inspect', alias, '--format', 'json']) }))),
      ]);
      return { deployments: list.deployments, inspections };
    } });
  process.stdout.write(JSON.stringify(proof) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const allowed = ['INVALID_RUNTIME_VERSION', 'RUNTIME_CI_REQUIRED', 'RUNTIME_CI_PENDING_TIMEOUT',
      'RUNTIME_GIT_DEPLOYMENT_REQUIRED', 'RUNTIME_CANONICAL_ALIASES_REQUIRED', 'INVALID_RUNTIME_PROOF_ARGUMENT'];
    const reasonCode = allowed.includes(error?.code) ? error.code : 'RUNTIME_RELEASE_PROOF_UNAVAILABLE';
    process.stdout.write(JSON.stringify({ schemaVersion: 1, outcome: 'blocked', reasonCode }) + '\n');
    process.stderr.write(reasonCode + '\n'); process.exitCode = 1;
  });
}
