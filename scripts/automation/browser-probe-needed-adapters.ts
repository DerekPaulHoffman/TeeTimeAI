import "./load-local-env";

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
  type BrowserDiscoveryEvidence
} from "@/lib/automation/browser-discovery";
import {
  assertBrowserProbeExpectedDisposition,
  buildBrowserFrameCandidates,
  buildBrowserFrameCandidatesFromHtml,
  buildBrowserProbeDecisionTrace,
  buildBrowserWidgetCandidates,
  finalizeBrowserEvidenceSnapshots,
  hasDistinctProviderBookingCandidate,
  isRelevantBrowserAccessBarrierUrl,
  prepareBrowserPageEvidence,
  type BrowserProbeDecisionTrace,
  type BrowserProbeExpectedDisposition
} from "@/lib/automation/browser-probe-evidence";
import {
  applyBrowserDiscoveryToCourse,
  finishAutomationRun,
  listBrowserProbeTargets,
  recordBrowserDiscovery,
  recordCourseProbe,
  startAutomationRun
} from "@/lib/automation/db-service";
import { resolveProviderCapability } from "@/lib/automation/provider-capabilities";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { sanitizeResponderText } from "@/lib/automation/course-support-responder-policy";
import { resolveCourseSupportIncident } from "@/lib/automation/support-incidents";
import { shouldStopBrowserDiscovery } from "@/lib/automation/monitoring-strategy";
import { prisma } from "@/lib/prisma";

const PROMPT_VERSION = "tee-time-spot-browser-probe-v1";
const DEFAULT_LIMIT = 5;
const NAVIGATION_TIMEOUT_MS = 20_000;

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const limit = options.limit;
  const requestedCourseName = options.courseName;
  const run = options.dryRun ? null : await startAutomationRun(PROMPT_VERSION);
  const notes: string[] = [];
  const traces: BrowserProbeDecisionTrace[] = [];

  try {
    const targets = await listBrowserProbeTargets(limit, requestedCourseName);
    notes.push(`Selected ${targets.length} browser probe targets.`);

    if (targets.length === 0) {
      if (requestedCourseName) {
        throw new Error("The requested browser-probe course was not eligible.");
      }
      if (run) {
        await finishAutomationRun(run.id, {
          outcome: "no_op",
          notes: notes.join("\n")
        });
      }
      writeDryRunTrace(options, traces);
      return;
    }

    const browser = await chromium.launch();
    try {
      for (const target of targets) {
        const page = await browser.newPage();
        try {
          const previousDiscovery = await prisma.courseAutomationDiscovery.findFirst({
            where: { courseId: target.course.id },
            orderBy: { createdAt: "desc" },
            select: { evidence: true }
          });
          const providerFamilyKey = resolveProviderCapability({
            detectedPlatform: target.course.detectedPlatform,
            providerFamilyKey: target.course.providerFamilyKey,
            detectedBookingUrl: target.course.detectedBookingUrl,
            website: target.course.website,
            bookingMetadata: target.course.bookingMetadata
          }).providerFamilyKey;
          const providerExecution = await runWithProviderRequestLease(
            providerFamilyKey,
            () =>
              collectBrowserEvidence(page, {
                courseId: target.course.id,
                courseName: target.course.name,
                sourceUrl: target.probeUrl,
                officialCourseWebsite: target.course.website
              })
          );
          if (!providerExecution.acquired) {
            if (options.dryRun) {
              throw new Error("Provider concurrency guard deferred a dry-run target.");
            }
            notes.push(
              `${target.course.name}: deferred by the provider concurrency guard.`
            );
            continue;
          }
          const evidence = {
            ...providerExecution.value,
            corroboratedAccessBarrier: findCorroboratingAccessBarrier(
              previousDiscovery?.evidence,
              providerExecution.value.accessBarriers
            ) ?? undefined
          };
          const initialDiscovery = buildBrowserDiscovery(evidence);
          const enrichment = await enrichBrowserDiscoveryWithProviderLease(
            initialDiscovery,
            target.course.name,
            runWithProviderRequestLease
          );
          if (!enrichment.acquired) {
            if (options.dryRun) {
              throw new Error(
                "Provider concurrency guard deferred dry-run enrichment."
              );
            }
            notes.push(
              `${target.course.name}: enrichment deferred by the provider concurrency guard.`
            );
            continue;
          }
          const discovery = sanitizeBrowserDiscoveryAccessEvidence(
            keepPolicyOnlyDiscoveryActionable(enrichment.discovery),
            evidence.accessBarriers
          );

          if (options.dryRun) {
            traces.push(buildBrowserProbeDecisionTrace(evidence, discovery));
            continue;
          }

          await recordBrowserDiscovery(discovery);
          const appliedCourse = await applyBrowserDiscoveryToCourse(discovery);
          if (!appliedCourse) {
            const currentCourse = await prisma.course.findUnique({
              where: { id: target.course.id },
              select: {
                providerFamilyKey: true,
                detectedPlatform: true,
                detectedBookingUrl: true,
                website: true,
                bookingMetadata: true
              }
            });
            if (currentCourse && resolveProviderCapability(currentCourse).isRunnable) {
              notes.push(
                `${target.course.name}: stale browser result ignored because newer runnable provider evidence is already persisted.`
              );
              continue;
            }
          }
          const observedMonitoringGate =
            evaluateBrowserDiscoveryMonitoringGate(discovery);
          const directBookingVerified = Boolean(
            appliedCourse &&
              (observedMonitoringGate.disposition === "MANUAL_FINAL" ||
                observedMonitoringGate.disposition === "IDENTITY_FINAL")
          );
          const accessControlVerified =
            Boolean(
              appliedCourse &&
                observedMonitoringGate.disposition === "TECHNICAL_FINAL"
            );
          const finalDispositionVerified =
            directBookingVerified || accessControlVerified;
          if (finalDispositionVerified) {
            await resolveCourseSupportIncident({
              courseId: target.course.id,
              resolution: "DIRECT_BOOKING_CLASSIFIED",
              message: accessControlVerified
                ? `${target.course.name} has a verified official booking path, but signed-out monitoring is not technically accessible without crossing the current access control.`
                : `${target.course.name} was verified as ${discovery.bookingMethod}; no public online tee sheet is currently available to monitor.`
            });
          }
          if (target.searchId) {
            await recordCourseProbe({
              searchId: target.searchId,
              courseId: target.course.id,
              automationRunId: run!.id,
              outcome: accessControlVerified
                ? "BLOCKED_AUTH"
                : directBookingVerified
                  ? "MANUAL_DIRECT"
                  : "NEEDS_ADAPTER",
              message:
                finalDispositionVerified
                  ? "Browser discovery verified a direct-booking-only disposition."
                  : discovery.status === "LEARNED"
                  ? `Browser probe learned ${discovery.detectedPlatform} adapter metadata; rerun the poller to verify tee-sheet retrieval.`
                  : `Browser probe inspected site but did not learn a reusable adapter yet.`,
              evidenceUrl: discovery.bookingUrl,
              rawSummary: {
                browserProbe: {
                  status: discovery.status,
                  detectedPlatform: discovery.detectedPlatform,
                  apiEndpoint: discovery.apiEndpoint,
                  automationReason: discovery.automationReason,
                  confidence: discovery.confidence,
                  learnedFrom: discovery.evidence.learnedFrom
                }
              }
            });
          }

          notes.push(
            `${target.course.name}: ${discovery.status} ${discovery.detectedPlatform} confidence=${discovery.confidence}`
          );
        } catch (error) {
          if (!options.dryRun && target.searchId) {
            await recordCourseProbe({
              searchId: target.searchId,
              courseId: target.course.id,
              automationRunId: run!.id,
              outcome: "FETCH_FAILED",
              message: error instanceof Error ? error.message : "Browser probe failed"
            });
          }
          notes.push(
            `${target.course.name}: failed - ${error instanceof Error ? error.message : "unknown error"}`
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
      assertBrowserProbeExpectedDisposition(options.expectedDisposition, traces);
      writeDryRunTrace(options, traces);
    } else {
      await finishAutomationRun(run!.id, {
        outcome: "success",
        notes: notes.join("\n")
      });
    }
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
            ? error.stack ?? error.message
            : "Unknown browser probe failure"
      });
    }
    throw error;
  }
}

function parseOptions(args: string[]) {
  const dryRun = args.includes("--dry-run");
  const traceJson = args.includes("--trace-json");
  const limitValue = readOption(args, "--limit");
  const limit = Number(
    limitValue ?? process.env.BROWSER_PROBE_LIMIT ?? DEFAULT_LIMIT
  );
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) {
    throw new Error("--limit must be an integer from 1 through 5.");
  }
  const courseName =
    readOption(args, "--course-name") ??
    process.env.BROWSER_PROBE_COURSE_NAME?.trim();
  const expectedDisposition = readOption(
    args,
    "--expect-disposition"
  ) as BrowserProbeExpectedDisposition | undefined;
  if (
    expectedDisposition &&
    ![
      "ACTIONABLE",
      "MANUAL_FINAL",
      "IDENTITY_FINAL",
      "TECHNICAL_FINAL"
    ].includes(expectedDisposition)
  ) {
    throw new Error("--expect-disposition is not supported.");
  }
  if ((traceJson || expectedDisposition) && !dryRun) {
    throw new Error(
      "--trace-json and --expect-disposition require --dry-run."
    );
  }

  return { courseName, dryRun, expectedDisposition, limit, traceJson };
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
  traces: BrowserProbeDecisionTrace[]
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
        ...trace
      }))
    })
  );
}

async function collectBrowserEvidence(
  page: Page,
  input: Pick<
    BrowserDiscoveryEvidence,
    "courseId" | "courseName" | "sourceUrl" | "officialCourseWebsite"
  >
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
        response.url()
      )
    ) {
      successfulProviderUrls.add(response.url());
    }
    if (
      [401, 403].includes(response.status()) &&
      isRelevantBrowserAccessBarrierUrl({
        responseUrl: response.url(),
        currentPageUrl: page.url(),
        officialSourceUrl: input.sourceUrl
      })
    ) {
      accessBarrierUrls.add(response.url());
      accessBarriers.set(response.url(), response.status() as 401 | 403);
    }
  });

  await page.goto(input.sourceUrl, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS
  });
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  const landingPageUrl = page.url();
  const landingPageEvidence = await collectPageEvidence(
    page,
    input.courseName
  );
  if (
    shouldStopBrowserDiscovery({
      accessBarrierCount: accessBarriers.size,
      accessControlDetected: landingPageEvidence.accessControlDetected
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
      destinationPageEvidence: landingPageEvidence
    });
  }

  await clickLikelyBookingLink(page);
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  const firstDestinationPageUrl = page.url();
  const firstDestinationPageEvidence = await collectPageEvidence(
    page,
    haveSamePublicWebsiteOrigin(landingPageUrl, firstDestinationPageUrl)
      ? input.courseName
      : undefined
  );

  if (
    (!shouldStopBrowserDiscovery({
      accessBarrierCount: accessBarriers.size,
      accessControlDetected: firstDestinationPageEvidence.accessControlDetected
    }) ||
      hasDistinctProviderBookingCandidate({
        linkCandidates: firstDestinationPageEvidence.linkCandidates,
        accessBarriers: [...accessBarriers].map(([url, status]) => ({
          url,
          status
        }))
      })) &&
    haveSamePublicWebsiteOrigin(landingPageUrl, firstDestinationPageUrl)
  ) {
    await clickLikelyBookingLink(page);
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  }
  const preDatePageEvidence = await collectPageEvidence(
    page,
    haveSamePublicWebsiteOrigin(landingPageUrl, page.url())
      ? input.courseName
      : undefined
  );
  if (
    !shouldStopBrowserDiscovery({
      accessBarrierCount: accessBarriers.size,
      accessControlDetected: preDatePageEvidence.accessControlDetected
    })
  ) {
    await trySelectSearchDate(page);
  }
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  const destinationPageUrl = page.url();
  const destinationPageEvidence = await collectPageEvidence(
    page,
    haveSamePublicWebsiteOrigin(landingPageUrl, destinationPageUrl)
      ? input.courseName
      : undefined
  );

  return finalizeBrowserEvidence({
    input,
    page,
    observedUrls,
    successfulProviderUrls,
    accessBarrierUrls,
    accessBarriers,
    landingPageUrl,
    landingPageEvidence,
    firstDestinationPageUrl,
    firstDestinationPageEvidence,
    destinationPageUrl,
    destinationPageEvidence
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
      status
    })),
    landingPageUrl: input.landingPageUrl,
    landingPageEvidence: input.landingPageEvidence,
    firstDestinationPageUrl: input.firstDestinationPageUrl,
    firstDestinationPageEvidence: input.firstDestinationPageEvidence,
    destinationPageUrl: input.destinationPageUrl,
    destinationPageEvidence: input.destinationPageEvidence
  });
}

async function collectPageEvidence(
  page: Page,
  officialCourseName?: string
) {
  const evidence = await page.evaluate(() => {
    const anchorCandidates = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a[href]")
    )
      .map((anchor) => ({
        url: anchor.href,
        label: anchor.textContent?.replace(/\s+/g, " ").trim() ?? ""
      }))
      .filter((candidate) => Boolean(candidate.url))
      .slice(0, 200);
    const pageText = document.body?.innerText?.replace(/\s+/g, " ").trim() ?? "";
    const pageTitle = document.title?.replace(/\s+/g, " ").trim() ?? "";
    const accessControlDetected = Boolean(
      document.querySelector(
        [
          "iframe[src*='challenges.cloudflare.com']",
          "[name='cf-turnstile-response']",
          ".cf-turnstile",
          "#challenge-stage",
          "[data-sitekey][class*='captcha' i]"
        ].join(",")
      ) ||
        /^(?:just a moment|attention required|security check)$/i.test(pageTitle) ||
        /\b403200\s*client-dependent\s+cps\s+challenge\b/i.test(pageText)
    );
    const frameCandidateInputs = /\b(?:book|reserve|reservation|tee.?times?)\b/i.test(pageText)
      ? Array.from(
          document.querySelectorAll<HTMLIFrameElement>(
            "iframe[src], iframe[data-src]"
          )
        )
          .map((frame) => ({
            src: frame.getAttribute("src"),
            dataSrc: frame.getAttribute("data-src"),
            title: frame.getAttribute("title"),
            ariaLabel: frame.getAttribute("aria-label"),
            baseUrl: document.baseURI
          }))
          .slice(0, 20)
      : [];
    const linkCandidates = [...anchorCandidates];
    const anchors = linkCandidates.map((candidate) => candidate.url);
    const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]"))
      .map((script) => script.src)
      .filter(Boolean)
      .slice(0, 80);
    const inlineCourseData = Array.from(document.querySelectorAll<HTMLScriptElement>("script:not([src])"))
      .map((script) => script.textContent ?? "")
      .filter((text) => /window\.(courses|property|chronogolfSettings)\s*=/.test(text))
      .map((text) => text.slice(0, 5000))
      .join("\n")
      .slice(0, 8000);
    const structuredActionScripts = Array.from(
      document.querySelectorAll<HTMLScriptElement>("script:not([src])")
    )
      .map((script) => script.textContent ?? "")
      .filter((text) => text.includes("actionButton"))
      .map((text) => text.slice(0, 100_000))
      .slice(0, 3);
    const widgetConfigInputs = Array.from(
      document.querySelectorAll<HTMLElement>("[data-widget-config]")
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
      visibleText: [
        inlineCourseData,
        widgetConfigs,
        pageText.slice(0, 100_000)
      ]
        .filter(Boolean)
        .join("\n")
    };
  });
  const {
    frameCandidateInputs,
    widgetConfigInputs,
    ...pageEvidence
  } = evidence;
  const frameCandidates = buildBrowserFrameCandidates(frameCandidateInputs);
  const widgetCandidates = buildBrowserWidgetCandidates(widgetConfigInputs);
  const staticFrameCandidates = await collectStaticPageFrameCandidates(page);
  return prepareBrowserPageEvidence({
    ...pageEvidence,
    anchors: [
      ...pageEvidence.anchors,
      ...frameCandidates.map((candidate) => candidate.url),
      ...widgetCandidates.map((candidate) => candidate.url),
      ...staticFrameCandidates.map((candidate) => candidate.url)
    ],
    linkCandidates: [
      ...pageEvidence.linkCandidates,
      ...frameCandidates,
      ...widgetCandidates,
      ...staticFrameCandidates
    ]
  }, officialCourseName);
}

async function clickLikelyBookingLink(page: Page) {
  const { anchorCandidates, frameCandidateInputs } = await page.evaluate(() => ({
    anchorCandidates:
    Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .map((anchor) => ({
        href: anchor.href,
        text: anchor.textContent?.replace(/\s+/g, " ").trim() ?? ""
      }))
      .filter((anchor) =>
        /tee.?time|book|reserve|reservation|foreup|teeitup|golfnow|cps\.golf/i.test(
          `${anchor.text} ${anchor.href}`
        )
      ),
    frameCandidateInputs: Array.from(
      document.querySelectorAll<HTMLIFrameElement>(
        "iframe[src], iframe[data-src]"
      )
    ).map((frame) => ({
      src: frame.getAttribute("src"),
      dataSrc: frame.getAttribute("data-src"),
      title: frame.getAttribute("title"),
      ariaLabel: frame.getAttribute("aria-label"),
      baseUrl: document.baseURI
    }))
  }));
  const frameCandidates = buildBrowserFrameCandidates(
    frameCandidateInputs
  ).map((candidate) => ({
    href: candidate.url,
    text: candidate.label
  }));
  const staticFrameCandidates = await collectStaticPageFrameCandidates(page);
  const href = pickLikelyBookingHref(
    [
      ...anchorCandidates,
      ...frameCandidates,
      ...staticFrameCandidates.map((candidate) => ({
        href: candidate.url,
        text: candidate.label
      }))
    ],
    page.url()
  );

  if (!href) {
    return;
  }

  await page.goto(href, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }).catch(
    () => undefined
  );
}

async function collectStaticPageFrameCandidates(page: Page) {
  try {
    const response = await page.request.get(page.url(), {
      timeout: NAVIGATION_TIMEOUT_MS
    });
    if (
      !response.ok() ||
      !/text\/html/i.test(response.headers()["content-type"] ?? "")
    ) {
      return [];
    }
    return buildBrowserFrameCandidatesFromHtml(
      await response.text(),
      page.url()
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

main()
  .catch((error) => {
    console.error(
      sanitizeResponderText(
        error instanceof Error ? error.message : "Browser probe failed."
      )
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
