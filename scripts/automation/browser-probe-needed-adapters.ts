import "./load-local-env";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  chromium,
  type Frame,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";

import {
  buildBrowserDiscovery,
  enrichBrowserDiscoveryWithProviderLease,
  evaluateBrowserDiscoveryMonitoringGate,
  findCorroboratingAccessBarrier,
  haveSamePublicWebsiteOrigin,
  isEvidenceOnlyOfficialBookingAccountLink,
  isKnownPublicSearchSurfaceUrl,
  isSafeManualEvidenceUrl,
  keepPolicyOnlyDiscoveryActionable,
  pickLikelyBookingHref,
  prioritizeBrowserDiscoveryLinks,
  sanitizeBrowserDiscoveryAccessEvidence,
  type BrowserDiscovery,
  type BrowserDiscoveryEvidence,
} from "@/lib/automation/browser-discovery";
import {
  assertBrowserProbeExpectedDisposition,
  buildBrowserButtonCandidates,
  buildBrowserNetworkContractFingerprint,
  buildBrowserFrameCandidates,
  buildBrowserFrameCandidatesFromHtml,
  buildBrowserProbeDecisionTrace,
  buildBrowserWidgetCandidates,
  classifyRenderedOfficialPageCourseIdentity,
  finalizeBrowserInvestigationEvidence,
  isRenderedUnprojectedSourceCandidateLocalityCorroborated,
  isRelevantBrowserAccessBarrierUrl,
  MAX_BROWSER_BOOKING_DESTINATION_VISITS,
  MAX_BROWSER_INVESTIGATION_DEPTH,
  MAX_BROWSER_SAME_ORIGIN_PAGE_VISITS,
  planBrowserInvestigationLinks,
  prepareBrowserPageEvidence,
  sanitizeBrowserAuditUrl,
  type BrowserBookingDestinationVisit,
  type BrowserInvestigationEvidence,
  type BrowserInvestigationMode,
  type BrowserInvestigationPageVisit,
  type BrowserNetworkContractFingerprint,
  type BrowserProbeDecisionTrace,
  type BrowserProbeExpectedDisposition,
} from "@/lib/automation/browser-probe-evidence";
import {
  applyBrowserDiscoveryToCourse,
  finishAutomationRun,
  listBrowserProbeTargets,
  recordBrowserDiscovery,
  startAutomationRun,
} from "@/lib/automation/db-service";
import {
  buildBrowserPlaybookTransition,
  loadCourseMonitoringPlaybookRuntime,
  recordRuntimePlaybookTransition,
} from "@/lib/automation/course-monitoring-playbook-runtime";
import {
  runGuardedCourseSupportBrowserMutation,
  type CourseSupportBrowserPersistenceFence,
  type CourseSupportBrowserPersistenceGuard,
} from "@/lib/automation/course-support-browser-stages";
import { resolveProviderCapability } from "@/lib/automation/provider-capabilities";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { getAutomationRuntimeVersion } from "@/lib/automation/runtime-version";
import { sanitizeResponderText } from "@/lib/automation/course-support-responder-policy";
import { shouldStopBrowserDiscovery } from "@/lib/automation/monitoring-strategy";
import { prisma } from "@/lib/prisma";

const PROMPT_VERSION = "tee-time-spot-browser-probe-v1";
const DEFAULT_LIMIT = 5;
const NAVIGATION_TIMEOUT_MS = 20_000;
const MAX_RENDERED_ANCHOR_CANDIDATES = 2_000;

export type BrowserProbeOptions = ReturnType<typeof parseOptions> & {
  beforePersist?: CourseSupportBrowserPersistenceGuard;
  persistenceFence?: CourseSupportBrowserPersistenceFence;
  deferTerminalCloseout?: boolean;
  persistSearchProbe?: boolean;
  mode?: BrowserInvestigationMode;
};

export async function runBrowserProbe(options: BrowserProbeOptions) {
  if (
    !options.dryRun &&
    (!options.persistenceFence ||
      options.deferTerminalCloseout !== true ||
      options.persistSearchProbe !== false)
  ) {
    throw new Error(
      "Persisted browser progression requires an owned responder batch and deferred closeout.",
    );
  }
  const requestedCourseName = options.courseName;
  const requestedCourseId = options.courseId;
  const runtimeVersion = resolveBrowserProbeRuntimeVersion(
    getAutomationRuntimeVersion(),
    options.persistenceFence,
  );
  const investigationMode = resolveBrowserInvestigationMode(options);
  const run = options.dryRun ? null : await startAutomationRun(PROMPT_VERSION);
  const notes: string[] = [];
  const traces: BrowserProbeDecisionTrace[] = [];
  let persistedCount = 0;

  try {
    const selection = resolveBrowserProbeTargetSelection(options);
    const targets = await listBrowserProbeTargets(
      selection.limit,
      selection.courseName,
      selection.courseId,
      selection.persistenceFence,
    );
    notes.push(`Selected ${targets.length} browser probe targets.`);

    if (targets.length === 0) {
      if (requestedCourseName || requestedCourseId) {
        throw new Error("The requested browser-probe course was not eligible.");
      }
      if (run) {
        await finishAutomationRun(run.id, {
          outcome: "no_op",
          notes: notes.join("\n"),
        });
      }
      writeDryRunTrace(options, traces);
      return { targetCount: 0, persistedCount: 0 };
    }

    const browser = await chromium.launch();
    try {
      for (const target of targets) {
        const context = await browser.newContext({ serviceWorkers: "block" });
        const page = await context.newPage();
        let playbookRuntime: Awaited<
          ReturnType<typeof loadCourseMonitoringPlaybookRuntime>
        > = null;
        const persistBrowserMutation = <T>(
          requireCurrentStage: boolean,
          mutate: () => Promise<T>,
        ) =>
          runGuardedCourseSupportBrowserMutation({
            courseId: target.course.id,
            requireCurrentStage,
            beforePersist: options.beforePersist,
            mutate,
          });
        try {
          playbookRuntime = options.dryRun
            ? null
            : await loadCourseMonitoringPlaybookRuntime(target.course.id);
          if (
            !options.dryRun &&
            (!playbookRuntime ||
              ![
                "RENDERED_BROWSER_DISCOVERY",
                "INDEPENDENT_CONFIRMATION",
              ].includes(playbookRuntime.assessment.nextStage ?? ""))
          ) {
            notes.push(
              `${target.course.name}: browser stage deferred until prior ordered checks finish.`,
            );
            continue;
          }
          const investigationObservedAt = new Date();
          const previousDiscovery =
            investigationMode === "INDEPENDENT" &&
            options.persistenceFence &&
            target.course.incidentConfirmedAt
              ? await prisma.courseAutomationDiscovery.findFirst({
                  where: {
                    courseId: target.course.id,
                    createdAt: { gte: target.course.incidentConfirmedAt },
                    AND: [
                      {
                        evidence: {
                          path: ["browserInvestigation", "mode"],
                          equals: "RENDERED",
                        },
                      },
                      {
                        evidence: {
                          path: ["browserInvestigation", "incidentCycle"],
                          equals: options.persistenceFence.cycle,
                        },
                      },
                      {
                        evidence: {
                          path: ["browserInvestigation", "runtimeVersion"],
                          equals: runtimeVersion,
                        },
                      },
                    ],
                  },
                  orderBy: { createdAt: "desc" },
                  select: { createdAt: true, evidence: true },
                })
              : null;
          const freshRenderedEvidence = getFreshRenderedCorroborationEvidence(
            previousDiscovery,
            {
              incidentCycle: options.persistenceFence?.cycle ?? null,
              runtimeVersion,
              confirmedAt: target.course.incidentConfirmedAt ?? null,
            },
          );
          const providerFamilyKey = resolveProviderCapability({
            detectedPlatform: target.course.detectedPlatform,
            providerFamilyKey: target.course.providerFamilyKey,
            detectedBookingUrl: target.course.detectedBookingUrl,
            website: target.course.website,
            bookingMetadata: target.course.bookingMetadata,
          }).providerFamilyKey;
          const providerExecution = await runWithProviderRequestLease(
            providerFamilyKey,
            () =>
              collectBrowserEvidence(
                page,
                {
                  courseId: target.course.id,
                  courseName: target.course.name,
                  address: target.course.address,
                  city: target.course.city,
                  stateCode: target.course.stateCode,
                  googlePlaceIdPresent: target.course.googlePlaceIdPresent,
                  sourceUrl: target.probeUrl,
                  officialCourseWebsite: target.course.website,
                  verifiedLayoutHoleCounts:
                    target.course.verifiedLayoutHoleCounts,
                },
                {
                  mode: investigationMode,
                  retainedBookingUrl: target.course.detectedBookingUrl,
                  unprojectedSourceCandidate:
                    target.unprojectedSourceCandidate === true,
                  auditContext: {
                    incidentCycle: options.persistenceFence?.cycle ?? null,
                    runtimeVersion,
                    observedAt: investigationObservedAt,
                  },
                },
              ),
          );
          if (!providerExecution.acquired) {
            if (options.dryRun) {
              throw new Error(
                "Provider concurrency guard deferred a dry-run target.",
              );
            }
            notes.push(
              `${target.course.name}: deferred by the provider concurrency guard.`,
            );
            continue;
          }
          const evidence = {
            ...providerExecution.value,
            corroboratedAccessBarrier:
              findCorroboratingAccessBarrier(
                freshRenderedEvidence,
                providerExecution.value.accessBarriers,
              ) ?? undefined,
          };
          const initialDiscovery = attachBrowserInvestigationAudit(
            buildBrowserDiscovery(evidence),
            evidence.browserInvestigation,
          );
          const enrichment = await enrichBrowserDiscoveryWithProviderLease(
            initialDiscovery,
            target.course.name,
            runWithProviderRequestLease,
          );
          if (!enrichment.acquired) {
            if (options.dryRun) {
              throw new Error(
                "Provider concurrency guard deferred dry-run enrichment.",
              );
            }
            notes.push(
              `${target.course.name}: enrichment deferred by the provider concurrency guard.`,
            );
            continue;
          }
          const actionableDiscovery = attachBrowserInvestigationAudit(
            sanitizeBrowserDiscoveryAccessEvidence(
              keepPolicyOnlyDiscoveryActionable(enrichment.discovery),
              evidence.accessBarriers,
            ),
            evidence.browserInvestigation,
          );
          const persistedDiscovery = retainOnlyPersistableBrowserUrls(
            actionableDiscovery,
            evidence,
          );

          if (options.dryRun) {
            traces.push(
              buildBrowserProbeDecisionTrace(evidence, actionableDiscovery),
            );
            continue;
          }

          await persistBrowserMutation(true, () =>
            recordBrowserDiscovery(
              persistedDiscovery,
              options.persistenceFence,
              runtimeVersion,
            ),
          );
          const observedMonitoringGate =
            evaluateBrowserDiscoveryMonitoringGate(actionableDiscovery);
          const accessControlObserved =
            observedMonitoringGate.disposition === "TECHNICAL_FINAL";
          // Shared persistence normalizes one technical browser observation
          // to actionable NEEDS_REVIEW while retaining learned metadata. It
          // never persists a BLOCKED technical final from this observation.
          const appliedCourse = await persistBrowserMutation(true, () =>
            applyBrowserDiscoveryToCourse(
              actionableDiscovery,
              undefined,
              options.persistenceFence,
              runtimeVersion,
            ),
          );
          if (!appliedCourse) {
            const currentCourse = await prisma.course.findUnique({
              where: { id: target.course.id },
              select: {
                providerFamilyKey: true,
                detectedPlatform: true,
                detectedBookingUrl: true,
                website: true,
                bookingMetadata: true,
              },
            });
            if (
              currentCourse &&
              resolveProviderCapability(currentCourse).isRunnable
            ) {
              notes.push(
                `${target.course.name}: stale browser result ignored because newer runnable provider evidence is already persisted.`,
              );
              continue;
            }
          }
          const directBookingObserved = Boolean(
            appliedCourse &&
            (observedMonitoringGate.disposition === "MANUAL_FINAL" ||
              observedMonitoringGate.disposition === "IDENTITY_FINAL"),
          );
          const browserTechnicalReason = accessControlObserved
            ? getBrowserTechnicalReason(actionableDiscovery.automationReason)
            : null;
          const browserFactualDisposition = directBookingObserved
            ? observedMonitoringGate.disposition === "IDENTITY_FINAL"
              ? ("IDENTITY_FINAL" as const)
              : ("MANUAL_DIRECT" as const)
            : null;
          const browserPlaybookRuntime = playbookRuntime;
          const playbookStage = browserPlaybookRuntime?.assessment.nextStage;
          const playbookResult =
            browserPlaybookRuntime &&
            (playbookStage === "RENDERED_BROWSER_DISCOVERY" ||
              playbookStage === "INDEPENDENT_CONFIRMATION")
              ? await persistBrowserMutation(true, () =>
                  recordRuntimePlaybookTransition(
                    browserPlaybookRuntime,
                    {
                      stage: playbookStage,
                      readPath:
                        playbookStage === "RENDERED_BROWSER_DISCOVERY"
                          ? "RENDERED_BROWSER"
                          : "INDEPENDENT_CONFIRMATION",
                      runtimeVersion,
                      source: "COURSE_SUPPORT_RESPONDER",
                      ...buildBrowserPlaybookTransition({
                        stage: playbookStage,
                        technicalReason: browserTechnicalReason,
                        localReaderTechnicalReason:
                          browserPlaybookRuntime.localReaderTechnicalReason,
                        factualDisposition: browserFactualDisposition,
                      }),
                    },
                    options.persistenceFence,
                  ),
                )
              : null;
          if (playbookResult?.recorded) {
            persistedCount += 1;
          }

          notes.push(
            `${target.course.name}: ${actionableDiscovery.status} ${actionableDiscovery.detectedPlatform} confidence=${actionableDiscovery.confidence}`,
          );
        } catch (error) {
          if (!options.dryRun) {
            playbookRuntime ??= await loadCourseMonitoringPlaybookRuntime(
              target.course.id,
            );
            const failurePlaybookRuntime = playbookRuntime;
            const failedStage = failurePlaybookRuntime?.assessment.nextStage;
            if (
              failurePlaybookRuntime &&
              (failedStage === "RENDERED_BROWSER_DISCOVERY" ||
                failedStage === "INDEPENDENT_CONFIRMATION")
            ) {
              const attemptCount =
                failurePlaybookRuntime.assessment.stages.find(
                  (stage) => stage.stage === failedStage,
                )?.attemptCount ?? 0;
              const failure = await persistBrowserMutation(true, () =>
                recordRuntimePlaybookTransition(
                  failurePlaybookRuntime,
                  {
                    stage: failedStage,
                    transition:
                      attemptCount < 1 ? "FAILED_RETRYABLE" : "FAILED_TERMINAL",
                    readPath:
                      failedStage === "RENDERED_BROWSER_DISCOVERY"
                        ? "RENDERED_BROWSER"
                        : "INDEPENDENT_CONFIRMATION",
                    evidenceKind: "TOOLING",
                    failureClass:
                      error instanceof Error && error.name === "TimeoutError"
                        ? "TIMEOUT"
                        : "NETWORK",
                    runtimeVersion,
                    source: "COURSE_SUPPORT_RESPONDER",
                  },
                  options.persistenceFence,
                ),
              );
              if (failure.recorded) {
                persistedCount += 1;
              }
            }
          }
          notes.push(
            `${target.course.name}: failed - ${error instanceof Error ? error.message : "unknown error"}`,
          );
          if (options.dryRun) {
            throw error;
          }
        } finally {
          await context.close().catch(() => undefined);
        }
      }
    } finally {
      await browser.close();
    }

    if (options.dryRun) {
      assertBrowserProbeExpectedDisposition(
        options.expectedDisposition,
        traces,
      );
      writeDryRunTrace(options, traces);
    } else {
      await finishAutomationRun(run!.id, {
        outcome: "success",
        notes: notes.join("\n"),
      });
    }
    return {
      targetCount: targets.length,
      persistedCount,
    };
  } catch (error) {
    if (run) {
      await finishAutomationRun(run.id, {
        outcome: "failed",
        errors:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : { message: "Unknown browser probe failure" },
        notes:
          error instanceof Error
            ? (error.stack ?? error.message)
            : "Unknown browser probe failure",
      });
    }
    throw error;
  }
}

export async function runBrowserProbeCli(
  args: string[],
  runner: (options: BrowserProbeOptions) => Promise<unknown> = runBrowserProbe,
) {
  const options = parseOptions(args);
  if (!options.dryRun) {
    throw new Error(
      "Direct browser probing is diagnostic-only; use --dry-run or the guarded course-support responder.",
    );
  }
  return runner({
    ...options,
    deferTerminalCloseout: true,
    persistSearchProbe: false,
  });
}

export function resolveBrowserProbeRuntimeVersion(
  ambientRuntimeVersion: string,
  persistenceFence?: CourseSupportBrowserPersistenceFence,
) {
  if (!persistenceFence) {
    return ambientRuntimeVersion;
  }
  if (
    ambientRuntimeVersion !== "local" &&
    ambientRuntimeVersion !== persistenceFence.runtimeVersion
  ) {
    throw new Error(
      "Browser progression runtime does not match the owned batch release.",
    );
  }
  return persistenceFence.runtimeVersion;
}

export function resolveBrowserInvestigationMode(
  options: Pick<BrowserProbeOptions, "mode" | "persistenceFence">,
): BrowserInvestigationMode {
  if (options.mode) {
    return options.mode;
  }
  return options.persistenceFence?.stage === "INDEPENDENT_CONFIRMATION"
    ? "INDEPENDENT"
    : "RENDERED";
}

export function resolveBrowserProbeTargetSelection(
  options: Pick<
    BrowserProbeOptions,
    "limit" | "courseName" | "courseId" | "persistenceFence"
  >,
) {
  return {
    limit: options.limit,
    courseName: options.courseName,
    courseId: options.courseId,
    persistenceFence: options.persistenceFence,
  };
}

export function getFreshRenderedCorroborationEvidence(
  discovery:
    | { createdAt: Date; evidence: unknown }
    | null
    | undefined,
  context: {
    incidentCycle: number | null;
    runtimeVersion: string;
    confirmedAt: Date | null;
  },
) {
  if (
    !discovery ||
    context.incidentCycle === null ||
    !context.confirmedAt ||
    discovery.createdAt.getTime() < context.confirmedAt.getTime() ||
    !discovery.evidence ||
    typeof discovery.evidence !== "object" ||
    Array.isArray(discovery.evidence)
  ) {
    return null;
  }
  const evidence = discovery.evidence as Record<string, unknown>;
  const audit = evidence.browserInvestigation;
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) {
    return null;
  }
  const record = audit as Record<string, unknown>;
  const observedAt =
    typeof record.observedAt === "string"
      ? new Date(record.observedAt)
      : null;
  if (
    record.mode !== "RENDERED" ||
    record.incidentCycle !== context.incidentCycle ||
    record.runtimeVersion !== context.runtimeVersion ||
    !observedAt ||
    !Number.isFinite(observedAt.getTime()) ||
    observedAt.getTime() < context.confirmedAt.getTime()
  ) {
    return null;
  }
  return discovery.evidence;
}

function attachBrowserInvestigationAudit(
  discovery: BrowserDiscovery,
  browserInvestigation: BrowserInvestigationEvidence["browserInvestigation"],
) {
  return {
    ...discovery,
    evidence: {
      ...discovery.evidence,
      browserInvestigation,
    },
  };
}

export function retainOnlyPersistableBrowserUrls(
  discovery: ReturnType<typeof attachBrowserInvestigationAudit>,
  evidence: BrowserInvestigationEvidence,
) {
  const retainedUrls = new Set(
    [
      evidence.sourceUrl,
      evidence.finalUrl,
      evidence.officialCourseWebsite,
      evidence.officialPage?.url,
      ...(evidence.linkCandidates?.map(({ url }) => url) ?? []),
      ...evidence.browserInvestigation.sameOriginPages.flatMap((visit) => [
        visit.requestedUrl,
        visit.finalUrl,
      ]),
      ...evidence.browserInvestigation.bookingDestinations.flatMap((visit) => [
        visit.requestedUrl,
        visit.finalUrl,
      ]),
      evidence.browserInvestigation.retainedInputs.officialWebsite,
      evidence.browserInvestigation.retainedInputs.sourceUrl,
      evidence.browserInvestigation.retainedInputs.bookingUrl,
      discovery.sourceUrl,
      discovery.bookingUrl,
      discovery.evidence.finalUrl,
      discovery.evidence.courseIdentityCorroboration?.officialPageUrl,
      discovery.evidence.courseIdentityCorroboration?.providerUrl,
    ].flatMap((value) => {
      const canonical = value ? canonicalBrowserPageOrCtaUrl(value) : null;
      return canonical ? [canonical] : [];
    }),
  );
  const sanitizeEvidenceUrl = (value: string) =>
    sanitizeBrowserAuditUrl(value) ?? "about:blank";
  const observedUrls = discovery.evidence.observedUrls
    .filter((value) => {
      const canonical = canonicalBrowserPageOrCtaUrl(value);
      return Boolean(canonical && retainedUrls.has(canonical));
    })
    .map(sanitizeEvidenceUrl)
    .filter((value, index, values) => values.indexOf(value) === index);
  const browserInvestigation = discovery.evidence.browserInvestigation;
  return {
    ...discovery,
    evidence: {
      ...discovery.evidence,
      ...(discovery.evidence.finalUrl
        ? { finalUrl: sanitizeEvidenceUrl(discovery.evidence.finalUrl) }
        : {}),
      observedUrls,
      ...(evidence.persistableVisibleText
        ? { visibleText: evidence.persistableVisibleText.slice(0, 12_000) }
        : { visibleText: undefined }),
      ...(discovery.evidence.accessBarriers
        ? {
            accessBarriers: discovery.evidence.accessBarriers.map((barrier) => ({
              ...barrier,
              url: sanitizeEvidenceUrl(barrier.url),
            })),
          }
        : {}),
      ...(discovery.evidence.courseIdentityCorroboration
        ? {
            courseIdentityCorroboration: {
              ...discovery.evidence.courseIdentityCorroboration,
              officialWebsiteUrl: sanitizeEvidenceUrl(
                discovery.evidence.courseIdentityCorroboration.officialWebsiteUrl,
              ),
              officialPageUrl: sanitizeEvidenceUrl(
                discovery.evidence.courseIdentityCorroboration.officialPageUrl,
              ),
              providerUrl: sanitizeEvidenceUrl(
                discovery.evidence.courseIdentityCorroboration.providerUrl,
              ),
            },
          }
        : {}),
      ...(browserInvestigation
        ? {
            browserInvestigation: {
              ...browserInvestigation,
              retainedInputs: {
                officialWebsite: browserInvestigation.retainedInputs.officialWebsite
                  ? sanitizeEvidenceUrl(
                      browserInvestigation.retainedInputs.officialWebsite,
                    )
                  : null,
                sourceUrl: sanitizeEvidenceUrl(
                  browserInvestigation.retainedInputs.sourceUrl,
                ),
                bookingUrl: browserInvestigation.retainedInputs.bookingUrl
                  ? sanitizeEvidenceUrl(
                      browserInvestigation.retainedInputs.bookingUrl,
                    )
                  : null,
              },
              sameOriginPages: browserInvestigation.sameOriginPages.map(
                (visit) => ({
                  ...visit,
                  requestedUrl: sanitizeEvidenceUrl(visit.requestedUrl),
                  finalUrl: sanitizeEvidenceUrl(visit.finalUrl),
                }),
              ),
              bookingDestinations:
                browserInvestigation.bookingDestinations.map((visit) => ({
                  ...visit,
                  requestedUrl: sanitizeEvidenceUrl(visit.requestedUrl),
                  finalUrl: sanitizeEvidenceUrl(visit.finalUrl),
                })),
            },
          }
        : {}),
    },
  };
}

function canonicalBrowserPageOrCtaUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    return isSafeRenderedBrowserInteractionDestination(url.toString(), value)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

async function main() {
  return runBrowserProbeCli(process.argv.slice(2));
}

function getBrowserTechnicalReason(automationReason: string | undefined) {
  if (automationReason === "ACCOUNT_REQUIRED") {
    return "ACCOUNT_REQUIRED" as const;
  }
  if (automationReason === "CAPTCHA_OR_QUEUE") {
    return "CAPTCHA_OR_QUEUE" as const;
  }
  return "OTHER_TECHNICAL_LIMITATION" as const;
}

function parseOptions(args: string[]) {
  const dryRun = args.includes("--dry-run");
  const traceJson = args.includes("--trace-json");
  const limitValue = readOption(args, "--limit");
  const limit = Number(
    limitValue ?? process.env.BROWSER_PROBE_LIMIT ?? DEFAULT_LIMIT,
  );
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) {
    throw new Error("--limit must be an integer from 1 through 5.");
  }
  const courseName =
    readOption(args, "--course-name") ??
    process.env.BROWSER_PROBE_COURSE_NAME?.trim();
  const courseId = readOption(args, "--course-id");
  if (courseName && courseId) {
    throw new Error("--course-name and --course-id cannot be combined.");
  }
  if (courseId && !/^[A-Za-z0-9_-]{1,80}$/u.test(courseId)) {
    throw new Error("--course-id is invalid.");
  }
  const expectedDisposition = readOption(args, "--expect-disposition") as
    BrowserProbeExpectedDisposition | undefined;
  if (
    expectedDisposition &&
    ![
      "ACTIONABLE",
      "MANUAL_FINAL",
      "IDENTITY_FINAL",
      "TECHNICAL_FINAL",
    ].includes(expectedDisposition)
  ) {
    throw new Error("--expect-disposition is not supported.");
  }
  if ((traceJson || expectedDisposition) && !dryRun) {
    throw new Error("--trace-json and --expect-disposition require --dry-run.");
  }

  return {
    courseName,
    courseId,
    dryRun,
    expectedDisposition,
    limit,
    traceJson,
  };
}

function readOption(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function writeDryRunTrace(
  options: ReturnType<typeof parseOptions>,
  traces: BrowserProbeDecisionTrace[],
) {
  if (!options.traceJson) {
    return;
  }
  console.log(
    JSON.stringify({
      outcome: traces.length > 0 ? "dry_run_complete" : "no_due_targets",
      targetCount: traces.length,
      expectedDisposition: options.expectedDisposition ?? null,
      targets: traces.map((trace, index) => ({
        ordinal: index + 1,
        ...trace,
      })),
    }),
  );
}

type MainFrameInteractionGuard = {
  isBlocked: () => boolean;
  getDeferredCrossOriginDestination: () => string | null;
  dispose: () => Promise<void>;
};

export function isSafeRenderedBrowserInteractionDestination(
  destinationUrl: string,
  officialPageUrl: string,
) {
  if (destinationUrl === "about:blank") {
    return true;
  }
  let destination: URL;
  try {
    destination = new URL(destinationUrl);
  } catch {
    return false;
  }
  return Boolean(
    isSafeManualEvidenceUrl(destination) &&
    !isKnownPublicSearchSurfaceUrl(destination) &&
    !isEvidenceOnlyOfficialBookingAccountLink(
      {
        url: destination.toString(),
        label: "Book a tee time",
      },
      officialPageUrl,
    ),
  );
}

export function isReadOnlyBrowserRequestMethod(method: string) {
  return ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

async function createMainFrameInteractionGuard(
  page: Page,
  officialPageUrl: string,
  options: { deferCrossOriginMainFrame?: boolean } = {},
): Promise<MainFrameInteractionGuard> {
  const mainFrame = page.mainFrame();
  let blocked = false;
  let deferredCrossOriginDestination: string | null = null;
  const observeDestination = (url: string) => {
    if (
      !blocked &&
      !isSafeRenderedBrowserInteractionDestination(url, officialPageUrl)
    ) {
      blocked = true;
    }
  };
  const isBlocked = () => {
    observeDestination(page.url());
    return blocked;
  };

  const onFrameNavigated = (frame: Frame) => {
    if (frame === mainFrame) {
      observeDestination(frame.url());
    }
  };
  const onRequest = (request: Request) => {
    if (request.isNavigationRequest() && request.frame() === mainFrame) {
      observeDestination(request.url());
    }
  };
  page.on("framenavigated", onFrameNavigated);
  page.on("request", onRequest);
  const routeHandler = async (route: Route) => {
    const request = route.request();
    if (!isReadOnlyBrowserRequestMethod(request.method())) {
      blocked = true;
      await route.abort("blockedbyclient").catch(() => undefined);
      return;
    }
    const isMainFrameNavigation =
      request.isNavigationRequest() && request.frame() === mainFrame;
    const shouldDeferCrossOriginNavigation = Boolean(
      options.deferCrossOriginMainFrame &&
      isMainFrameNavigation &&
      request.url() !== "about:blank" &&
      !haveSamePublicWebsiteOrigin(officialPageUrl, request.url()),
    );
    const isSafeRequestDestination =
      isSafeRenderedBrowserInteractionDestination(
        request.url(),
        officialPageUrl,
      );
    if (shouldDeferCrossOriginNavigation && isSafeRequestDestination) {
      deferredCrossOriginDestination ??= request.url();
      await route.abort("blockedbyclient").catch(() => undefined);
      return;
    }
    if (isMainFrameNavigation && !isSafeRequestDestination) {
      blocked = true;
    }
    if (!isSafeRequestDestination || (blocked && isMainFrameNavigation)) {
      await route.abort("blockedbyclient").catch(() => undefined);
      return;
    }
    await route.fallback().catch(() => undefined);
  };
  await page.route("**/*", routeHandler);

  return {
    isBlocked,
    getDeferredCrossOriginDestination: () => deferredCrossOriginDestination,
    dispose: async () => {
      page.off("framenavigated", onFrameNavigated);
      page.off("request", onRequest);
      await page.unroute("**/*", routeHandler).catch(() => undefined);
    },
  };
}

export async function collectBrowserEvidence(
  page: Page,
  input: Pick<
    BrowserDiscoveryEvidence,
    | "courseId"
    | "courseName"
    | "sourceUrl"
    | "officialCourseWebsite"
    | "verifiedLayoutHoleCounts"
  > & {
    address?: string | null;
    city?: string | null;
    stateCode?: string | null;
    googlePlaceIdPresent?: boolean;
  },
  options: {
    mode?: BrowserInvestigationMode;
    retainedBookingUrl?: string | null;
    unprojectedSourceCandidate?: boolean;
    auditContext?: {
      incidentCycle: number | null;
      runtimeVersion: string;
      observedAt: Date;
    };
  } = {},
): Promise<BrowserInvestigationEvidence> {
  const mode = options.mode ?? "RENDERED";
  const officialPageUrl = input.officialCourseWebsite ?? input.sourceUrl;
  const pageVisits: BrowserInvestigationPageVisit[] = [];
  const bookingDestinations: BrowserBookingDestinationVisit[] = [];
  const queuedSameOriginUrls = new Set<string>();
  const visitedSameOriginUrls = new Set<string>();
  const queuedBookingUrls = new Set<string>();
  const sameOriginQueue: Array<{
    url: string;
    label: string;
    depth: number;
    parentUrl: string | null;
    parentTrusted: boolean;
    requiresDirectIdentityMatch?: boolean;
  }> = [];
  const bookingQueue: Array<{
    url: string;
    label: string;
    sourcePageUrl: string | null;
    courseScoped: boolean;
  }> = [];

  const enqueueSameOrigin = (candidate: {
    url: string;
    label: string;
    depth: number;
    parentUrl: string | null;
    parentTrusted: boolean;
    requiresDirectIdentityMatch?: boolean;
  }) => {
    const normalized = normalizeSafeBrowserVisitUrl(
      candidate.url,
      officialPageUrl,
    );
    if (
      !normalized ||
      candidate.depth > MAX_BROWSER_INVESTIGATION_DEPTH ||
      !haveSamePublicWebsiteOrigin(officialPageUrl, normalized) ||
      queuedSameOriginUrls.has(normalized)
    ) {
      return;
    }
    queuedSameOriginUrls.add(normalized);
    sameOriginQueue.push({ ...candidate, url: normalized });
  };
  const enqueueBooking = (candidate: {
    url: string;
    label: string;
    sourcePageUrl: string | null;
    courseScoped: boolean;
  }) => {
    const normalized = normalizeSafeBrowserVisitUrl(
      candidate.url,
      officialPageUrl,
    );
    if (
      !normalized ||
      queuedBookingUrls.has(normalized)
    ) {
      return;
    }
    queuedBookingUrls.add(normalized);
    bookingQueue.push({ ...candidate, url: normalized });
  };

  const isExactBookingDestination = (url: string, label: string) =>
    planBrowserInvestigationLinks({
      pageUrl: officialPageUrl,
      officialPageUrl,
      courseName: input.courseName,
      sourceTrustedForCourse: true,
      candidates: [{ url, label }],
    }).bookingDestinations.length > 0;
  if (options.unprojectedSourceCandidate) {
    enqueueSameOrigin({
      url: officialPageUrl,
      label: input.courseName,
      depth: 0,
      parentUrl: null,
      parentTrusted: false,
      requiresDirectIdentityMatch: true,
    });
  } else if (isExactBookingDestination(officialPageUrl, input.courseName)) {
    enqueueBooking({
      url: officialPageUrl,
      label: input.courseName,
      sourcePageUrl: null,
      courseScoped: true,
    });
  } else {
    enqueueSameOrigin({
      url: officialPageUrl,
      label: input.courseName,
      depth: 0,
      parentUrl: null,
      parentTrusted: false,
    });
  }
  if (options.unprojectedSourceCandidate) {
    // The owner-only candidate is the same URL as officialPageUrl and remains
    // untrusted until its rendered course identity and locality match.
  } else if (isExactBookingDestination(input.sourceUrl, "Retained course source")) {
    enqueueBooking({
      url: input.sourceUrl,
      label: "Retained course source",
      sourcePageUrl: null,
      courseScoped: true,
    });
  } else if (haveSamePublicWebsiteOrigin(officialPageUrl, input.sourceUrl)) {
    enqueueSameOrigin({
      url: input.sourceUrl,
      label: input.courseName,
      depth: 0,
      parentUrl: null,
      parentTrusted: false,
    });
  } else {
    enqueueBooking({
      url: input.sourceUrl,
      label: "Retained course source",
      sourcePageUrl: null,
      courseScoped: true,
    });
  }
  if (options.retainedBookingUrl) {
    enqueueBooking({
      url: options.retainedBookingUrl,
      label: "Retained booking page",
      sourcePageUrl: null,
      courseScoped: true,
    });
  }

  const visitQueuedBookingDestinations = async () => {
    while (
      bookingQueue.length > 0 &&
      bookingDestinations.length < MAX_BROWSER_BOOKING_DESTINATION_VISITS
    ) {
      const candidate = bookingQueue.shift()!;
      const destinationPage = await createAdditionalInvestigationPage(page);
      try {
        bookingDestinations.push(
          await visitBookingDestination(destinationPage, {
            ...candidate,
            officialPageUrl,
            courseName: input.courseName,
          }),
        );
      } finally {
        if (destinationPage !== page) {
          await destinationPage.close().catch(() => undefined);
        }
      }
    }
  };

  if (mode === "INDEPENDENT") {
    await visitQueuedBookingDestinations();
  }

  let rootPageUsed = false;
  let sameOriginNavigationAttempts = 0;
  while (
    sameOriginQueue.length > 0 &&
    sameOriginNavigationAttempts < MAX_BROWSER_SAME_ORIGIN_PAGE_VISITS &&
    bookingDestinations.length < MAX_BROWSER_BOOKING_DESTINATION_VISITS
  ) {
    const candidate = sameOriginQueue.shift()!;
    if (visitedSameOriginUrls.has(candidate.url)) {
      continue;
    }
    visitedSameOriginUrls.add(candidate.url);
    sameOriginNavigationAttempts += 1;
    const visitPage = !rootPageUsed
      ? page
      : await createAdditionalInvestigationPage(page);
    rootPageUsed = true;
    try {
      const visit = await visitOfficialPage(visitPage, {
        requestedUrl: candidate.url,
        label: candidate.label,
        depth: candidate.depth,
        parentUrl: candidate.parentUrl,
        officialPageUrl,
        courseName: input.courseName,
        requiresDirectIdentityMatch: candidate.requiresDirectIdentityMatch,
      });
      const identityStatus = classifyRenderedOfficialPageCourseIdentity(
        visit.finalUrl,
        visit.evidence,
        input,
      );
      const directCandidateLocalityVerified = candidate.requiresDirectIdentityMatch
        ? isRenderedUnprojectedSourceCandidateLocalityCorroborated(visit.evidence, input)
        : true;
      const visitTrusted =
        (identityStatus === "MATCH" && directCandidateLocalityVerified) ||
        (identityStatus === "UNKNOWN" && candidate.parentTrusted);
      if (candidate.requiresDirectIdentityMatch) {
        pageVisits.push(visit);
      }
      if (visit.deferredBookingUrl) {
        enqueueBooking({
          url: visit.deferredBookingUrl,
          label: candidate.label || "Course booking page",
          sourcePageUrl: visit.finalUrl,
          courseScoped: candidate.requiresDirectIdentityMatch
            ? visitTrusted
            : candidate.parentTrusted || candidate.parentUrl === null,
        });
      }
      const finalUrlIsBookingDestination = isExactBookingDestination(
        visit.finalUrl,
        candidate.label,
      );
      if (
        !haveSamePublicWebsiteOrigin(officialPageUrl, visit.finalUrl) ||
        finalUrlIsBookingDestination
      ) {
        if (
          bookingDestinations.length < MAX_BROWSER_BOOKING_DESTINATION_VISITS
        ) {
          bookingDestinations.push({
            sourcePageUrl: candidate.parentUrl,
            requestedUrl: visit.requestedUrl,
            finalUrl: visit.finalUrl,
            label: candidate.label,
            courseScoped: candidate.requiresDirectIdentityMatch
              ? visitTrusted
              : candidate.parentTrusted || candidate.parentUrl === null,
            interactionBlocked: visit.interactionBlocked,
            evidence: visit.evidence,
            observedUrls: visit.observedUrls,
            successfulProviderUrls: visit.successfulProviderUrls,
            teeItUpFacilityResponses: visit.teeItUpFacilityResponses,
            accessBarriers: visit.accessBarriers,
            networkContracts: visit.networkContracts,
          });
        }
        continue;
      }
      if (!candidate.requiresDirectIdentityMatch) {
        pageVisits.push(visit);
      }
      const planned = planBrowserInvestigationLinks({
        pageUrl: visit.finalUrl,
        officialPageUrl,
        courseName: input.courseName,
        sourceTrustedForCourse: visitTrusted,
        candidates: visit.evidence.linkCandidates,
      });
      if (candidate.depth < MAX_BROWSER_INVESTIGATION_DEPTH) {
        for (const link of planned.sameOriginPages) {
          enqueueSameOrigin({
            ...link,
            depth: candidate.depth + 1,
            parentUrl: visit.finalUrl,
            parentTrusted: visitTrusted,
          });
        }
      }
      if (visitTrusted) {
        for (const link of planned.bookingDestinations) {
          enqueueBooking({
            ...link,
            sourcePageUrl: visit.finalUrl,
            courseScoped: true,
          });
        }
      }
    } finally {
      if (visitPage !== page) {
        await visitPage.close().catch(() => undefined);
      }
    }
  }

  await visitQueuedBookingDestinations();

  return finalizeBrowserInvestigationEvidence({
    course: input,
    mode,
    auditContext: options.auditContext,
    retainedBookingUrl: options.retainedBookingUrl,
    unprojectedSourceCandidate: options.unprojectedSourceCandidate,
    pageVisits,
    bookingDestinations,
  });
}

type BrowserPageObservation = {
  observedUrls: Set<string>;
  successfulProviderUrls: Set<string>;
  teeItUpFacilityResponses: Map<
    string,
    NonNullable<BrowserDiscoveryEvidence["teeItUpFacilityResponses"]>[number]
  >;
  responseReads: Promise<void>[];
  accessBarriers: Map<string, 401 | 403>;
  networkContracts: Map<string, BrowserNetworkContractFingerprint>;
};

async function createAdditionalInvestigationPage(rootPage: Page) {
  try {
    return await rootPage.context().newPage();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Please use browser.newContext()")
    ) {
      // `browser.newPage()` creates an implicit single-page context. Direct
      // diagnostic callers may still use that API, so retain the legacy
      // sequential-page behavior there. The persisted runner always creates
      // an explicit context and therefore isolates every destination.
      return rootPage;
    }
    throw error;
  }
}

function normalizeSafeBrowserVisitUrl(value: string, officialPageUrl: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    return isSafeRenderedBrowserInteractionDestination(
      url.toString(),
      officialPageUrl,
    )
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function observeBrowserPageNetwork(
  page: Page,
  officialSourceUrl: string,
): BrowserPageObservation {
  const observation: BrowserPageObservation = {
    observedUrls: new Set<string>(),
    successfulProviderUrls: new Set<string>(),
    teeItUpFacilityResponses: new Map(),
    responseReads: [],
    accessBarriers: new Map(),
    networkContracts: new Map(),
  };
  const retainFingerprint = (
    fingerprint: BrowserNetworkContractFingerprint | null,
  ) => {
    if (!fingerprint) {
      return;
    }
    const key = JSON.stringify({
      origin: fingerprint.origin,
      method: fingerprint.method,
      pathPattern: fingerprint.pathPattern,
      queryKeys: fingerprint.queryKeys,
      resourceType: fingerprint.resourceType,
    });
    const current = observation.networkContracts.get(key);
    if (!current || fingerprint.status !== null) {
      observation.networkContracts.set(key, fingerprint);
    }
  };

  page.on("request", (request) => {
    observation.observedUrls.add(request.url());
    retainFingerprint(
      buildBrowserNetworkContractFingerprint({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
      }),
    );
  });
  page.on("response", (response) => {
    const request = response.request();
    observation.observedUrls.add(response.url());
    retainFingerprint(
      buildBrowserNetworkContractFingerprint({
        url: response.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        status: response.status(),
      }),
    );
    if (
      response.ok() &&
      /^https:\/\/phx-api-be-east-1b\.kenna\.io\/alias\/[^/]+\/facilities(?:\?|$)/i.test(
        response.url(),
      )
    ) {
      observation.successfulProviderUrls.add(response.url());
      observation.responseReads.push(
        response
          .json()
          .then((value) => {
            const parsed = parseTeeItUpFacilityResponse(response.url(), value);
            if (parsed) {
              observation.teeItUpFacilityResponses.set(parsed.url, parsed);
            }
          })
          .catch(() => undefined),
      );
    }
    if (
      [401, 403].includes(response.status()) &&
      isRelevantBrowserAccessBarrierUrl({
        responseUrl: response.url(),
        currentPageUrl: page.url(),
        officialSourceUrl,
      })
    ) {
      observation.accessBarriers.set(
        response.url(),
        response.status() as 401 | 403,
      );
    }
  });
  return observation;
}

async function materializeBrowserPageObservation(
  observation: BrowserPageObservation,
) {
  await Promise.allSettled(observation.responseReads);
  return {
    observedUrls: [...observation.observedUrls],
    successfulProviderUrls: [...observation.successfulProviderUrls],
    teeItUpFacilityResponses: [
      ...observation.teeItUpFacilityResponses.values(),
    ],
    accessBarriers: [...observation.accessBarriers].map(([url, status]) => ({
      url,
      status,
    })),
    networkContracts: [...observation.networkContracts.values()],
  };
}

async function visitOfficialPage(
  page: Page,
  input: {
    requestedUrl: string;
    label: string;
    depth: number;
    parentUrl: string | null;
    officialPageUrl: string;
    courseName: string;
    requiresDirectIdentityMatch?: boolean;
  },
): Promise<BrowserInvestigationPageVisit> {
  const observation = observeBrowserPageNetwork(page, input.officialPageUrl);
  const interactionGuard = await createMainFrameInteractionGuard(
    page,
    input.officialPageUrl,
    { deferCrossOriginMainFrame: true },
  );
  await page
    .goto(input.requestedUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    })
    .catch(() => undefined);
  await page
    .waitForLoadState("networkidle", { timeout: 5_000 })
    .catch(() => undefined);
  const interactionBlocked = interactionGuard.isBlocked();
  const finalUrl =
    page.url() === "about:blank" ? input.requestedUrl : page.url();
  const evidence =
    interactionBlocked && page.url() === "about:blank"
      ? emptyPreparedBrowserPageEvidence()
      : await collectPageEvidence(
          page,
          haveSamePublicWebsiteOrigin(input.officialPageUrl, finalUrl)
            ? input.courseName
            : undefined,
          { allowStaticPageFetch: !interactionBlocked },
        ).catch(() => emptyPreparedBrowserPageEvidence());
  const network = await materializeBrowserPageObservation(observation);
  const deferredBookingUrl =
    interactionGuard.getDeferredCrossOriginDestination();
  await interactionGuard.dispose();
  return {
    requestedUrl: input.requestedUrl,
    finalUrl,
    label: input.label,
    depth: input.depth,
    parentUrl: input.parentUrl,
    requiresDirectIdentityMatch: input.requiresDirectIdentityMatch,
    interactionBlocked,
    deferredBookingUrl,
    evidence,
    ...network,
  };
}

async function visitBookingDestination(
  page: Page,
  input: {
    url: string;
    label: string;
    sourcePageUrl: string | null;
    courseScoped: boolean;
    officialPageUrl: string;
    courseName: string;
  },
): Promise<BrowserBookingDestinationVisit> {
  const observation = observeBrowserPageNetwork(page, input.officialPageUrl);
  const interactionGuard = await createMainFrameInteractionGuard(
    page,
    input.officialPageUrl,
  );
  await page
    .goto(input.url, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    })
    .catch(() => undefined);
  await page
    .waitForLoadState("networkidle", { timeout: 5_000 })
    .catch(() => undefined);
  let interactionBlocked = interactionGuard.isBlocked();
  let evidence =
    interactionBlocked && page.url() === "about:blank"
      ? emptyPreparedBrowserPageEvidence()
      : await collectPageEvidence(page, undefined, {
          allowStaticPageFetch: !interactionBlocked,
        }).catch(() => emptyPreparedBrowserPageEvidence());

  if (
    !interactionBlocked &&
    !shouldStopBrowserDiscovery({
      accessBarrierCount: observation.accessBarriers.size,
      accessControlDetected: evidence.accessControlDetected,
    })
  ) {
    await clickLikelyBookingLink(page, undefined, interactionGuard);
    await page
      .waitForLoadState("networkidle", { timeout: 5_000 })
      .catch(() => undefined);
    interactionBlocked = interactionGuard.isBlocked();
    if (!interactionBlocked) {
      const preDateEvidence = await collectPageEvidence(page).catch(
        () => evidence,
      );
      if (
        !shouldStopBrowserDiscovery({
          accessBarrierCount: observation.accessBarriers.size,
          accessControlDetected: preDateEvidence.accessControlDetected,
        })
      ) {
        await trySelectSearchDate(page, interactionGuard);
        await page
          .waitForLoadState("networkidle", { timeout: 5_000 })
          .catch(() => undefined);
      }
      evidence = await collectPageEvidence(page).catch(() => preDateEvidence);
      interactionBlocked = interactionGuard.isBlocked();
    }
  }

  const finalUrl = page.url() === "about:blank" ? input.url : page.url();
  const network = await materializeBrowserPageObservation(observation);
  await interactionGuard.dispose();
  return {
    sourcePageUrl: input.sourcePageUrl,
    requestedUrl: input.url,
    finalUrl,
    label: input.label,
    courseScoped: input.courseScoped,
    interactionBlocked,
    evidence,
    ...network,
  };
}

function emptyPreparedBrowserPageEvidence() {
  return prepareBrowserPageEvidence({
    accessControlDetected: false,
    anchors: [],
    linkCandidates: [],
    scripts: [],
    structuredActionScripts: [],
    visibleText: "",
  });
}

function parseTeeItUpFacilityResponse(
  responseUrl: string,
  value: unknown,
):
  | NonNullable<BrowserDiscoveryEvidence["teeItUpFacilityResponses"]>[number]
  | null {
  let url: URL;
  try {
    url = new URL(responseUrl);
  } catch {
    return null;
  }
  const alias = url.pathname.match(/^\/alias\/([^/]+)\/facilities$/u)?.[1];
  if (
    url.protocol !== "https:" ||
    url.hostname !== "phx-api-be-east-1b.kenna.io" ||
    url.username ||
    url.password ||
    url.port ||
    !alias ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(alias) ||
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 20
  ) {
    return null;
  }
  const facilityIds = value.map((facility) =>
    facility && typeof facility === "object" && !Array.isArray(facility)
      ? (facility as { id?: unknown }).id
      : undefined,
  );
  if (
    facilityIds.some(
      (facilityId) =>
        !Number.isSafeInteger(facilityId) || Number(facilityId) <= 0,
    ) ||
    new Set(facilityIds).size !== facilityIds.length
  ) {
    return null;
  }
  url.search = "";
  url.hash = "";
  return {
    url: url.toString(),
    alias,
    facilityIds: facilityIds as number[],
  };
}

async function collectPageEvidence(
  page: Page,
  officialCourseName?: string,
  options: { allowStaticPageFetch?: boolean } = {},
) {
  const evidence = await page.evaluate((maxAnchorCandidates) => {
    const anchorCandidates = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a[href]"),
    )
      .map((anchor) => ({
        url: anchor.href,
        label: anchor.textContent?.replace(/\s+/g, " ").trim() ?? "",
      }))
      .filter((candidate) => Boolean(candidate.url))
      .slice(0, maxAnchorCandidates);
    const rawPageText = document.body?.innerText ?? "";
    const pageText = rawPageText.replace(/\s+/g, " ").trim();
    const pageTitle = document.title?.replace(/\s+/g, " ").trim() ?? "";
    const identityCandidates = [
      pageTitle,
      ...Array.from(document.querySelectorAll<HTMLHeadingElement>("h1"))
        .map((heading) => heading.innerText.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 10),
    ].filter(
      (identity, index, values) =>
        Boolean(identity) && values.indexOf(identity) === index,
    );
    const localityCandidates = [
      ...Array.from(
        document.querySelectorAll<HTMLElement>(
          "address, [itemprop='address'], [class*='address' i], [class*='location' i]",
        ),
      )
        .map((element) =>
          (element.innerText || element.textContent || "")
            .replace(/\s+/g, " ")
            .trim(),
        )
        .filter(Boolean)
        .slice(0, 25),
      pageText.slice(0, 100_000),
    ];
    const accessControlDetected = Boolean(
      document.querySelector(
        [
          "iframe[src*='challenges.cloudflare.com']",
          "[name='cf-turnstile-response']",
          ".cf-turnstile",
          "#challenge-stage",
          "[data-sitekey][class*='captcha' i]",
        ].join(","),
      ) ||
      /^(?:just a moment|attention required|security check)$/i.test(
        pageTitle,
      ) ||
      /\b403200\s*client-dependent\s+cps\s+challenge\b/i.test(pageText),
    );
    const frameCandidateInputs =
      /\b(?:book|reserve|reservation|tee.?times?)\b/i.test(pageText)
        ? Array.from(
            document.querySelectorAll<HTMLIFrameElement>(
              "iframe[src], iframe[data-src]",
            ),
          )
            .map((frame) => ({
              src: frame.getAttribute("src"),
              dataSrc: frame.getAttribute("data-src"),
              title: frame.getAttribute("title"),
              ariaLabel: frame.getAttribute("aria-label"),
              baseUrl: document.baseURI,
            }))
            .slice(0, 20)
        : [];
    const buttonCandidateInputs = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    )
      .map((button) => ({
        label: (button.innerText || button.textContent || "")
          .replace(/\s+/g, " ")
          .trim(),
        type: button.getAttribute("type"),
        disabled: button.disabled,
        insideForm: Boolean(button.closest("form")),
        dataHref: button.getAttribute("data-href"),
        dataUrl:
          button.getAttribute("data-url") ??
          button.getAttribute("data-booking-url"),
        onClick: button.getAttribute("onclick"),
        baseUrl: document.baseURI,
      }))
      .slice(0, 100);
    const scripts = Array.from(
      document.querySelectorAll<HTMLScriptElement>("script[src]"),
    )
      .map((script) => script.src)
      .filter(Boolean)
      .slice(0, 80);
    const inlineCourseData = Array.from(
      document.querySelectorAll<HTMLScriptElement>("script:not([src])"),
    )
      .map((script) => script.textContent ?? "")
      .filter((text) =>
        /window\.(courses|property|chronogolfSettings)\s*=/.test(text),
      )
      .map((text) => text.slice(0, 5000))
      .join("\n")
      .slice(0, 8000);
    const structuredActionScripts = Array.from(
      document.querySelectorAll<HTMLScriptElement>("script:not([src])"),
    )
      .map((script) => script.textContent ?? "")
      .filter((text) => text.includes("actionButton"))
      .map((text) => text.slice(0, 100_000))
      .slice(0, 3);
    const widgetConfigInputs = Array.from(
      document.querySelectorAll<HTMLElement>("[data-widget-config]"),
    )
      .map((element) => element.getAttribute("data-widget-config"))
      .filter((value): value is string => Boolean(value))
      .slice(0, 50);
    const widgetConfigs = widgetConfigInputs
      .map((value) => {
        try {
          return atob(value);
        } catch {
          return "";
        }
      })
      .filter((text) => /baseURL|courseId|tee-time/i.test(text))
      .join("\n")
      .slice(0, 8000);
    return {
      accessControlDetected,
      identityCandidates,
      localityCandidates,
      frameCandidateInputs,
      buttonCandidateInputs,
      structuredActionScripts,
      linkCandidates: anchorCandidates,
      scripts,
      widgetConfigInputs,
      providerExtractionText: [inlineCourseData, widgetConfigs]
        .filter(Boolean)
        .join("\n"),
      visibleText: pageText.slice(0, 100_000),
    };
  }, MAX_RENDERED_ANCHOR_CANDIDATES);
  const {
    frameCandidateInputs,
    buttonCandidateInputs,
    widgetConfigInputs,
    linkCandidates: rawLinkCandidates,
    ...pageEvidence
  } = evidence;
  const anchorCandidates = prioritizeBrowserDiscoveryLinks(
    rawLinkCandidates,
    200,
  );
  const frameCandidates = buildBrowserFrameCandidates(frameCandidateInputs);
  const buttonCandidates = buildBrowserButtonCandidates(buttonCandidateInputs);
  const widgetCandidates = buildBrowserWidgetCandidates(widgetConfigInputs);
  const staticFrameCandidates =
    options.allowStaticPageFetch === false
      ? []
      : await collectStaticPageFrameCandidates(page, page.url());
  return prepareBrowserPageEvidence(
    {
      ...pageEvidence,
      anchors: [
        ...anchorCandidates.map((candidate) => candidate.url),
        ...frameCandidates.map((candidate) => candidate.url),
        ...buttonCandidates.map((candidate) => candidate.url),
        ...widgetCandidates.map((candidate) => candidate.url),
        ...staticFrameCandidates.map((candidate) => candidate.url),
      ],
      linkCandidates: [
        ...anchorCandidates,
        ...frameCandidates,
        ...buttonCandidates,
        ...widgetCandidates,
        ...staticFrameCandidates,
      ],
    },
    officialCourseName,
  );
}

async function clickLikelyBookingLink(
  page: Page,
  courseName?: string,
  interactionGuard?: MainFrameInteractionGuard,
) {
  if (interactionGuard?.isBlocked()) {
    return null;
  }
  const currentPageUrl = page.url();
  const { rawAnchorCandidates, frameCandidateInputs } = await page.evaluate(
    (maxAnchorCandidates) => ({
      rawAnchorCandidates: Array.from(
        document.querySelectorAll<HTMLAnchorElement>("a[href]"),
      )
        .map((anchor) => ({
          href: anchor.href,
          text: anchor.textContent?.replace(/\s+/g, " ").trim() ?? "",
        }))
        .slice(0, maxAnchorCandidates),
      frameCandidateInputs: Array.from(
        document.querySelectorAll<HTMLIFrameElement>(
          "iframe[src], iframe[data-src]",
        ),
      ).map((frame) => ({
        src: frame.getAttribute("src"),
        dataSrc: frame.getAttribute("data-src"),
        title: frame.getAttribute("title"),
        ariaLabel: frame.getAttribute("aria-label"),
        baseUrl: document.baseURI,
      })),
    }),
    MAX_RENDERED_ANCHOR_CANDIDATES,
  );
  const anchorCandidates = prioritizeBrowserDiscoveryLinks(
    rawAnchorCandidates.map(({ href, text }) => ({ url: href, label: text })),
    200,
  ).map(({ url, label }) => ({ href: url, text: label }));
  const frameCandidates = buildBrowserFrameCandidates(frameCandidateInputs).map(
    (candidate) => ({
      href: candidate.url,
      text: candidate.label,
    }),
  );
  const staticFrameCandidates = interactionGuard?.isBlocked()
    ? []
    : await collectStaticPageFrameCandidates(page, currentPageUrl);
  const href = pickLikelyBookingHref(
    [
      ...anchorCandidates,
      ...frameCandidates,
      ...staticFrameCandidates.map((candidate) => ({
        href: candidate.url,
        text: candidate.label,
      })),
    ],
    currentPageUrl,
    courseName,
  );

  if (!href || interactionGuard?.isBlocked()) {
    return null;
  }

  const selected =
    [...anchorCandidates, ...frameCandidates].find(
      (candidate) => candidate.href === href,
    ) ??
    staticFrameCandidates
      .map((candidate) => ({ href: candidate.url, text: candidate.label }))
      .find((candidate) => candidate.href === href);

  await page
    .goto(href, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    })
    .catch(() => undefined);
  return selected ?? { href, text: "Book a tee time" };
}

export async function collectStaticPageFrameCandidates(
  page: Page,
  pageUrl = page.url(),
) {
  try {
    const response = await page.request.get(pageUrl, {
      timeout: NAVIGATION_TIMEOUT_MS,
      maxRedirects: 0,
    });
    if (
      !response.ok() ||
      !/text\/html/i.test(response.headers()["content-type"] ?? "")
    ) {
      return [];
    }
    return buildBrowserFrameCandidatesFromHtml(await response.text(), pageUrl);
  } catch {
    return [];
  }
}

async function trySelectSearchDate(
  page: Page,
  interactionGuard: MainFrameInteractionGuard,
) {
  if (interactionGuard.isBlocked()) {
    return;
  }
  const expectedPageUrl = page.url();
  const dateInputLocator = page.locator("input[type='date']").first();
  const dateInputCount = await dateInputLocator.count().catch(() => 0);
  if (
    dateInputCount === 0 ||
    interactionGuard.isBlocked() ||
    page.url() !== expectedPageUrl
  ) {
    return;
  }
  const dateInput = await dateInputLocator
    .elementHandle({ timeout: 2_000 })
    .catch(() => null);
  if (
    !dateInput ||
    interactionGuard.isBlocked() ||
    page.url() !== expectedPageUrl
  ) {
    return;
  }

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const value = tomorrow.toISOString().slice(0, 10);
  await dateInput.fill(value, { timeout: 2_000 }).catch(() => undefined);
}

const directEntry = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (directEntry) {
  main()
    .catch((error) => {
      console.error(
        sanitizeResponderText(
          error instanceof Error ? error.message : "Browser probe failed.",
        ),
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
