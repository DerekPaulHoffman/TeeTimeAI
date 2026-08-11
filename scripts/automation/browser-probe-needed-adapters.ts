import "./load-local-env";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Page } from "@playwright/test";

import {
  buildBrowserDiscovery,
  enrichBrowserDiscoveryWithProviderLease,
  evaluateBrowserDiscoveryMonitoringGate,
  findCorroboratingAccessBarrier,
  haveSamePublicWebsiteOrigin,
  keepPolicyOnlyDiscoveryActionable,
  pickLikelyBookingHref,
  sanitizeBrowserDiscoveryAccessEvidence,
  type BrowserDiscoveryEvidence,
} from "@/lib/automation/browser-discovery";
import {
  assertBrowserProbeExpectedDisposition,
  buildBrowserFrameCandidates,
  buildBrowserFrameCandidatesFromHtml,
  buildBrowserProbeDecisionTrace,
  buildRedirectedProviderBookingCandidate,
  buildBrowserWidgetCandidates,
  finalizeBrowserEvidenceSnapshots,
  hasDistinctProviderBookingCandidate,
  isRelevantBrowserAccessBarrierUrl,
  prepareBrowserPageEvidence,
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

export type BrowserProbeOptions = ReturnType<typeof parseOptions> & {
  beforePersist?: CourseSupportBrowserPersistenceGuard;
  persistenceFence?: CourseSupportBrowserPersistenceFence;
  deferTerminalCloseout?: boolean;
  persistSearchProbe?: boolean;
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
  const limit = options.limit;
  const requestedCourseName = options.courseName;
  const requestedCourseId = options.courseId;
  const runtimeVersion = resolveBrowserProbeRuntimeVersion(
    getAutomationRuntimeVersion(),
    options.persistenceFence,
  );
  const run = options.dryRun ? null : await startAutomationRun(PROMPT_VERSION);
  const notes: string[] = [];
  const traces: BrowserProbeDecisionTrace[] = [];
  let persistedCount = 0;

  try {
    const targets = await listBrowserProbeTargets(
      limit,
      requestedCourseName,
      requestedCourseId,
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
        const page = await browser.newPage();
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
          const previousDiscovery =
            await prisma.courseAutomationDiscovery.findFirst({
              where: { courseId: target.course.id },
              orderBy: { createdAt: "desc" },
              select: { evidence: true },
            });
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
              collectBrowserEvidence(page, {
                courseId: target.course.id,
                courseName: target.course.name,
                sourceUrl: target.probeUrl,
                officialCourseWebsite: target.course.website,
              }),
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
                previousDiscovery?.evidence,
                providerExecution.value.accessBarriers,
              ) ?? undefined,
          };
          const initialDiscovery = buildBrowserDiscovery(evidence);
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
          const discovery = sanitizeBrowserDiscoveryAccessEvidence(
            keepPolicyOnlyDiscoveryActionable(enrichment.discovery),
            evidence.accessBarriers,
          );

          if (options.dryRun) {
            traces.push(buildBrowserProbeDecisionTrace(evidence, discovery));
            continue;
          }

          await persistBrowserMutation(true, () =>
            recordBrowserDiscovery(
              discovery,
              options.persistenceFence,
              runtimeVersion,
            ),
          );
          const observedMonitoringGate =
            evaluateBrowserDiscoveryMonitoringGate(discovery);
          const accessControlObserved =
            observedMonitoringGate.disposition === "TECHNICAL_FINAL";
          // Shared persistence normalizes one technical browser observation
          // to actionable NEEDS_REVIEW while retaining learned metadata. It
          // never persists a BLOCKED technical final from this observation.
          const appliedCourse = await persistBrowserMutation(true, () =>
            applyBrowserDiscoveryToCourse(
              discovery,
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
            ? getBrowserTechnicalReason(discovery.automationReason)
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
            `${target.course.name}: ${discovery.status} ${discovery.detectedPlatform} confidence=${discovery.confidence}`,
          );
        } catch (error) {
          if (!options.dryRun) {
            playbookRuntime ??=
              await loadCourseMonitoringPlaybookRuntime(target.course.id);
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
                      attemptCount < 1
                        ? "FAILED_RETRYABLE"
                        : "FAILED_TERMINAL",
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
          await page.close().catch(() => undefined);
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

async function collectBrowserEvidence(
  page: Page,
  input: Pick<
    BrowserDiscoveryEvidence,
    "courseId" | "courseName" | "sourceUrl" | "officialCourseWebsite"
  >,
): Promise<BrowserDiscoveryEvidence> {
  const observedUrls = new Set<string>();
  const successfulProviderUrls = new Set<string>();
  const accessBarrierUrls = new Set<string>();
  const accessBarriers = new Map<string, 401 | 403>();

  page.on("request", (request) => {
    observedUrls.add(request.url());
  });
  page.on("response", (response) => {
    observedUrls.add(response.url());
    if (
      response.ok() &&
      /^https:\/\/phx-api-be-east-1b\.kenna\.io\/alias\/[^/]+\/facilities(?:\?|$)/i.test(
        response.url(),
      )
    ) {
      successfulProviderUrls.add(response.url());
    }
    if (
      [401, 403].includes(response.status()) &&
      isRelevantBrowserAccessBarrierUrl({
        responseUrl: response.url(),
        currentPageUrl: page.url(),
        officialSourceUrl: input.sourceUrl,
      })
    ) {
      accessBarrierUrls.add(response.url());
      accessBarriers.set(response.url(), response.status() as 401 | 403);
    }
  });

  await page.goto(input.sourceUrl, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  await page
    .waitForLoadState("networkidle", { timeout: 5_000 })
    .catch(() => undefined);
  const landingPageUrl = page.url();
  const landingPageEvidence = await collectPageEvidence(page, input.courseName);
  if (
    shouldStopBrowserDiscovery({
      accessBarrierCount: accessBarriers.size,
      accessControlDetected: landingPageEvidence.accessControlDetected,
    })
  ) {
    return finalizeBrowserEvidence({
      input,
      page,
      observedUrls,
      successfulProviderUrls,
      accessBarrierUrls,
      accessBarriers,
      landingPageUrl,
      landingPageEvidence,
      firstDestinationPageUrl: landingPageUrl,
      firstDestinationPageEvidence: landingPageEvidence,
      destinationPageUrl: landingPageUrl,
      destinationPageEvidence: landingPageEvidence,
    });
  }

  const selectedBookingLink = await clickLikelyBookingLink(
    page,
    input.courseName,
  );
  await page
    .waitForLoadState("networkidle", { timeout: 5_000 })
    .catch(() => undefined);
  const firstDestinationPageUrl = page.url();
  const redirectedBookingCandidate = selectedBookingLink
    ? buildRedirectedProviderBookingCandidate({
        officialPageUrl: landingPageUrl,
        selectedUrl: selectedBookingLink.href,
        selectedLabel: selectedBookingLink.text,
        destinationUrl: firstDestinationPageUrl,
      })
    : null;
  const scopedLandingPageEvidence = redirectedBookingCandidate
    ? {
        ...landingPageEvidence,
        anchors: [
          ...new Set([
            ...landingPageEvidence.anchors,
            redirectedBookingCandidate.url,
          ]),
        ],
        linkCandidates: [
          ...landingPageEvidence.linkCandidates,
          redirectedBookingCandidate,
        ],
      }
    : landingPageEvidence;
  const firstDestinationPageEvidence = await collectPageEvidence(
    page,
    haveSamePublicWebsiteOrigin(landingPageUrl, firstDestinationPageUrl)
      ? input.courseName
      : undefined,
  );

  if (
    (!shouldStopBrowserDiscovery({
      accessBarrierCount: accessBarriers.size,
      accessControlDetected: firstDestinationPageEvidence.accessControlDetected,
    }) ||
      hasDistinctProviderBookingCandidate({
        linkCandidates: firstDestinationPageEvidence.linkCandidates,
        accessBarriers: [...accessBarriers].map(([url, status]) => ({
          url,
          status,
        })),
      })) &&
    haveSamePublicWebsiteOrigin(landingPageUrl, firstDestinationPageUrl)
  ) {
    await clickLikelyBookingLink(page);
    await page
      .waitForLoadState("networkidle", { timeout: 5_000 })
      .catch(() => undefined);
  }
  const preDatePageEvidence = await collectPageEvidence(
    page,
    haveSamePublicWebsiteOrigin(landingPageUrl, page.url())
      ? input.courseName
      : undefined,
  );
  if (
    !shouldStopBrowserDiscovery({
      accessBarrierCount: accessBarriers.size,
      accessControlDetected: preDatePageEvidence.accessControlDetected,
    })
  ) {
    await trySelectSearchDate(page);
  }
  await page
    .waitForLoadState("networkidle", { timeout: 5_000 })
    .catch(() => undefined);
  const destinationPageUrl = page.url();
  const destinationPageEvidence = await collectPageEvidence(
    page,
    haveSamePublicWebsiteOrigin(landingPageUrl, destinationPageUrl)
      ? input.courseName
      : undefined,
  );

  return finalizeBrowserEvidence({
    input,
    page,
    observedUrls,
    successfulProviderUrls,
    accessBarrierUrls,
    accessBarriers,
    landingPageUrl,
    landingPageEvidence: scopedLandingPageEvidence,
    firstDestinationPageUrl,
    firstDestinationPageEvidence,
    destinationPageUrl,
    destinationPageEvidence,
  });
}

function finalizeBrowserEvidence(input: {
  input: Pick<
    BrowserDiscoveryEvidence,
    "courseId" | "courseName" | "sourceUrl" | "officialCourseWebsite"
  >;
  page: Page;
  observedUrls: Set<string>;
  successfulProviderUrls: Set<string>;
  accessBarrierUrls: Set<string>;
  accessBarriers: Map<string, 401 | 403>;
  landingPageUrl: string;
  landingPageEvidence: Awaited<ReturnType<typeof collectPageEvidence>>;
  firstDestinationPageUrl: string;
  firstDestinationPageEvidence: Awaited<ReturnType<typeof collectPageEvidence>>;
  destinationPageUrl: string;
  destinationPageEvidence: Awaited<ReturnType<typeof collectPageEvidence>>;
}): BrowserDiscoveryEvidence {
  return finalizeBrowserEvidenceSnapshots({
    course: input.input,
    finalUrl: input.page.url(),
    observedUrls: [...input.observedUrls],
    successfulProviderUrls: [...input.successfulProviderUrls],
    accessBarrierUrls: [...input.accessBarrierUrls],
    accessBarriers: [...input.accessBarriers].map(([url, status]) => ({
      url,
      status,
    })),
    landingPageUrl: input.landingPageUrl,
    landingPageEvidence: input.landingPageEvidence,
    firstDestinationPageUrl: input.firstDestinationPageUrl,
    firstDestinationPageEvidence: input.firstDestinationPageEvidence,
    destinationPageUrl: input.destinationPageUrl,
    destinationPageEvidence: input.destinationPageEvidence,
  });
}

async function collectPageEvidence(page: Page, officialCourseName?: string) {
  const evidence = await page.evaluate(() => {
    const anchorCandidates = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a[href]"),
    )
      .map((anchor) => ({
        url: anchor.href,
        label: anchor.textContent?.replace(/\s+/g, " ").trim() ?? "",
      }))
      .filter((candidate) => Boolean(candidate.url))
      .slice(0, 200);
    const pageText =
      document.body?.innerText?.replace(/\s+/g, " ").trim() ?? "";
    const pageTitle = document.title?.replace(/\s+/g, " ").trim() ?? "";
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
    const linkCandidates = [...anchorCandidates];
    const anchors = linkCandidates.map((candidate) => candidate.url);
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
      anchors,
      accessControlDetected,
      frameCandidateInputs,
      structuredActionScripts,
      linkCandidates,
      scripts,
      widgetConfigInputs,
      visibleText: [inlineCourseData, widgetConfigs, pageText.slice(0, 100_000)]
        .filter(Boolean)
        .join("\n"),
    };
  });
  const { frameCandidateInputs, widgetConfigInputs, ...pageEvidence } =
    evidence;
  const frameCandidates = buildBrowserFrameCandidates(frameCandidateInputs);
  const widgetCandidates = buildBrowserWidgetCandidates(widgetConfigInputs);
  const staticFrameCandidates = await collectStaticPageFrameCandidates(page);
  return prepareBrowserPageEvidence(
    {
      ...pageEvidence,
      anchors: [
        ...pageEvidence.anchors,
        ...frameCandidates.map((candidate) => candidate.url),
        ...widgetCandidates.map((candidate) => candidate.url),
        ...staticFrameCandidates.map((candidate) => candidate.url),
      ],
      linkCandidates: [
        ...pageEvidence.linkCandidates,
        ...frameCandidates,
        ...widgetCandidates,
        ...staticFrameCandidates,
      ],
    },
    officialCourseName,
  );
}

async function clickLikelyBookingLink(page: Page, courseName?: string) {
  const { anchorCandidates, frameCandidateInputs } = await page.evaluate(
    () => ({
      anchorCandidates: Array.from(
        document.querySelectorAll<HTMLAnchorElement>("a[href]"),
      )
        .map((anchor) => ({
          href: anchor.href,
          text: anchor.textContent?.replace(/\s+/g, " ").trim() ?? "",
        }))
        .slice(0, 200),
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
  );
  const frameCandidates = buildBrowserFrameCandidates(frameCandidateInputs).map(
    (candidate) => ({
      href: candidate.url,
      text: candidate.label,
    }),
  );
  const staticFrameCandidates = await collectStaticPageFrameCandidates(page);
  const href = pickLikelyBookingHref(
    [
      ...anchorCandidates,
      ...frameCandidates,
      ...staticFrameCandidates.map((candidate) => ({
        href: candidate.url,
        text: candidate.label,
      })),
    ],
    page.url(),
    courseName,
  );

  if (!href) {
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

async function collectStaticPageFrameCandidates(page: Page) {
  try {
    const response = await page.request.get(page.url(), {
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    if (
      !response.ok() ||
      !/text\/html/i.test(response.headers()["content-type"] ?? "")
    ) {
      return [];
    }
    return buildBrowserFrameCandidatesFromHtml(
      await response.text(),
      page.url(),
    );
  } catch {
    return [];
  }
}

async function trySelectSearchDate(page: Page) {
  const dateInput = page.locator("input[type='date']").first();
  if ((await dateInput.count()) === 0) {
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
