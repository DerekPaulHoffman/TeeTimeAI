import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const execute = promisify(execFile);
const reject = code => { throw Object.assign(new Error(code), { code }); };

export function validateDiscoveryRuntimeRelease({ runtimeVersion, runs, deployments, inspections }) {
  if (!/^[a-f0-9]{40}$/u.test(runtimeVersion ?? '')) reject('INVALID_RUNTIME_VERSION');
  const ci = runs?.find(run => run.headSha === runtimeVersion && run.status === 'completed' && run.conclusion === 'success');
  if (!ci || !Number.isSafeInteger(ci.databaseId)) reject('RUNTIME_CI_REQUIRED');
  const candidate = deployments?.filter(d => d.meta?.githubCommitSha === runtimeVersion &&
    d.meta.githubCommitRef === 'main' && d.meta.githubDeployment === '1' && d.meta.branchAlias && d.url)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!candidate || candidate.state !== 'READY' || !Number.isFinite(candidate.createdAt)) reject('RUNTIME_GIT_DEPLOYMENT_REQUIRED');
  const aliases = ['teetimespot.com', 'www.teetimespot.com'];
  if (!Array.isArray(inspections) || inspections.length !== 2 ||
      aliases.some(alias => !inspections.some(item => item.alias === alias && item.inspection?.readyState === 'READY' &&
        item.inspection.url === candidate.url && /^dpl_[A-Za-z0-9]+$/u.test(item.inspection.id ?? ''))) ||
      inspections[0].inspection.id !== inspections[1].inspection.id) reject('RUNTIME_CANONICAL_ALIASES_REQUIRED');
  return { runtimeVersion, ciRunId: ci.databaseId, ciConclusion: 'success', deployment: {
    source: 'git', state: 'READY', commitSha: runtimeVersion, aliases,
    deploymentId: inspections[0].inspection.id, deploymentUrl: `https://${candidate.url}`,
    deployedAt: new Date(candidate.createdAt).toISOString() } };
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
  const [runs, list, inspections] = await Promise.all([
    jsonCommand(process.platform === 'win32' ? 'gh.exe' : 'gh', ['run', 'list', '--workflow', 'verify.yml', '--commit', runtimeVersion,
      '--json', 'databaseId,headSha,status,conclusion', '--limit', '10']),
    vercel(['ls', '--environment', 'production', '--meta', `githubCommitSha=${runtimeVersion}`, '--format', 'json', '--limit', '20']),
    Promise.all(['teetimespot.com', 'www.teetimespot.com'].map(async alias => ({ alias,
      inspection: await vercel(['inspect', alias, '--format', 'json']) }))),
  ]);
  process.stdout.write(JSON.stringify(validateDiscoveryRuntimeRelease({ runtimeVersion, runs, deployments: list.deployments, inspections })) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write((/^[A-Z_]{1,80}$/u.test(error?.code ?? '') ? error.code : 'RUNTIME_RELEASE_PROOF_UNAVAILABLE') + '\n'); process.exitCode = 1; });
}
