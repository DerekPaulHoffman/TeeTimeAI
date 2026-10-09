import { isSimulatorPostRepairResearchReadDue, type SimulatorResearchBlockedRoute } from "./simulator-support-research-policy";
import { assertSimulatorSupportDeployment, isValidSimulatorSupportClaim, type SimulatorSupportClaim } from "./simulator-support-policy";

const BACKOFF_MS = 60 * 60_000;
const key = (route: SimulatorResearchBlockedRoute) => `${new URL(route.url).href}:${route.rendered}`;
const clock = (route: SimulatorResearchBlockedRoute) => route.observedAt ? Date.parse(route.observedAt) : NaN;
const hasReceipt = (route: SimulatorResearchBlockedRoute) => Boolean(route.requestId &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(route.requestId) && Number.isFinite(clock(route)));
const toolingFailure = (route: SimulatorResearchBlockedRoute) => route.httpStatus === 0 &&
  route.failure?.stage === "PUBLIC_READ" && ["BUDGET", "BROWSER", "TOOLING", "UNKNOWN"].includes(route.failure.category);
export const isProtectedSimulatorResearchDenial = (route: SimulatorResearchBlockedRoute) => [401, 403, 404].includes(route.httpStatus) ||
  (route.accessControls?.length ?? 0) > 0 || Boolean(route.failure && !toolingFailure(route)) ||
  route.httpStatus === 0 && !toolingFailure(route);
const sameFailure = (actual: SimulatorResearchBlockedRoute, copied: SimulatorResearchBlockedRoute) =>
  actual.httpStatus === copied.httpStatus && JSON.stringify(actual.failure) === JSON.stringify(copied.failure) &&
  (!copied.requestId || actual.requestId === copied.requestId) && (!copied.observedAt || actual.observedAt === copied.observedAt) &&
  actual.researchImplementationVersion === copied.researchImplementationVersion && actual.renderWarning === copied.renderWarning &&
  JSON.stringify(actual.configurationDiagnostic) === JSON.stringify(copied.configurationDiagnostic);

/** Call only with the registered claim and current source loaded by the owned server path.
 * deployedAt is deployment creation metadata, not the later observed READY clock.
 */
export function getSimulatorPostRepairResearchBoundary(input: {
  claim: SimulatorSupportClaim; baseSha: string; sourceFingerprint: string; now: Date;
}): Date | null {
  const { claim, baseSha, sourceFingerprint, now } = input;
  if (!Number.isFinite(now.getTime()) || !/^[a-f0-9]{40}$/iu.test(baseSha) ||
      !/^[a-f0-9]{64}$/iu.test(sourceFingerprint) || !isValidSimulatorSupportClaim(claim) ||
      claim.sourceFingerprint !== sourceFingerprint || claim.phase !== "VERIFYING" ||
      typeof claim.releaseSha !== "string" || claim.releaseSha.toLowerCase() === baseSha.toLowerCase() ||
      !claim.plannedPaths.includes("src/lib/automation/simulator-support-research.ts") || !claim.deployment) return null;
  try {
    assertSimulatorSupportDeployment(claim.deployment, claim.releaseSha, now);
    const boundary = new Date(claim.deployment.deployedAt);
    return boundary.getTime() >= Date.parse(claim.claimedAt) ? boundary : null;
  } catch {
    return null;
  }
}

/** Actual, already source-filtered owned receipts may prove a tooling route recovered.
 * A successful page permits only later bounded investigation, never monitoring proof.
 */
export function selectRecoveredSimulatorResearchRoutes(input: {
  actualRoutes: readonly SimulatorResearchBlockedRoute[];
  inheritedRoutes: readonly SimulatorResearchBlockedRoute[];
  now: Date;
  postRepairResearchBoundary?: Date | null;
}) {
  const recovered = new Map<string, SimulatorResearchBlockedRoute>();
  const evaluated = new Set<string>();
  const positives = input.actualRoutes.filter(route => route.rendered && route.outcome === "READ" &&
    route.httpStatus >= 200 && route.httpStatus < 300 && !route.failure && hasReceipt(route) &&
    route.accessControlsObserved === true && route.accessControls?.length === 0 &&
    // Older durable public receipts did not retain the optional warning/version.
    // Their observed access and original receipt can authorize another bounded
    // investigation without inventing the missing collector diagnostics.
    (route.renderComplete === true ? route.renderWarning === undefined :
      route.renderComplete === false && (route.renderWarning === undefined || route.renderWarning.startsWith("SECONDARY_"))))
    .sort((left, right) => clock(right) - clock(left));
  for (const positive of positives) {
    const routeKey = key(positive);
    if (evaluated.has(routeKey)) continue;
    evaluated.add(routeKey);
    const actual = input.actualRoutes.filter(route => key(route) === routeKey);
    if (clock(positive) > input.now.getTime() - BACKOFF_MS &&
        !isSimulatorPostRepairResearchReadDue(positive, input.now, input.postRepairResearchBoundary, actual)) continue;
    const inherited = input.inheritedRoutes.filter(route => key(route) === routeKey);
    if ([...actual, ...inherited].some(isProtectedSimulatorResearchDenial)) continue;
    const failures = actual.filter(toolingFailure);
    if (!failures.length && !inherited.some(toolingFailure)) continue;
    if (failures.some(route => !hasReceipt(route) || route.requestId === positive.requestId || clock(route) >= clock(positive))) continue;
    if (inherited.some(route => {
      if (route.observedAt && (!Number.isFinite(clock(route)) || clock(route) > clock(positive))) return true;
      if (!toolingFailure(route)) return false;
      // A copied clock cannot supply authority. Find the exact original failed
      // receipt in the same bounded current-source history, preserving unknowns.
      const matches = actual.filter(original => toolingFailure(original) && sameFailure(original, route));
      return !matches.length || matches.some(original => !hasReceipt(original) || clock(original) >= clock(positive));
    })) continue;
    recovered.set(routeKey, positive);
  }
  return recovered;
}
