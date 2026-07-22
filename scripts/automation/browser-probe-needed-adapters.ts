import "./load-local-env";

import { chromium, type Page } from "playwright";

import {
  buildBrowserDiscovery,
  enrichBrowserDiscoveryWithProviderLease,
  evaluateBrowserDiscoveryMonitoringGate,
  findCorroboratingAccessBarrier,
  keepPolicyOnlyDiscoveryActionable,
  pickLikelyBookingHref,
  sanitizeBrowserDiscoveryAccessEvidence,
  type BrowserDiscoveryEvidence
} from "@/lib/automation/browser-discovery";
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
import { resolveCourseSupportIncident } from "@/lib/automation/support-incidents";
import { prisma } from "@/lib/prisma";

const PROMPT_VERSION = "tee-time-spot-browser-probe-v1";
const DEFAULT_LIMIT = 5;
const NAVIGATION_TIMEOUT_MS = 20_000;

async function main() {
  const limit = Number(process.env.BROWSER_PROBE_LIMIT ?? DEFAULT_LIMIT);
  const requestedCourseName = process.env.BROWSER_PROBE_COURSE_NAME?.trim();
  const run = await startAutomationRun(PROMPT_VERSION);
  const notes: string[] = [];

  try {
    const targets = await listBrowserProbeTargets(limit, requestedCourseName);
    notes.push(`Selected ${targets.length} browser probe targets.`);

    if (targets.length === 0) {
      if (requestedCourseName) {
        throw new Error("The requested browser-probe course was not eligible.");
      }
      await finishAutomationRun(run.id, { outcome: "no_op", notes: notes.join("\n") });
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
          const enrichment = await enrichBrowserDiscoveryWithProviderLease(
            buildBrowserDiscovery(evidence),
            target.course.name,
            runWithProviderRequestLease
          );
          if (!enrichment.acquired) {
            notes.push(
              `${target.course.name}: enrichment deferred by the provider concurrency guard.`
            );
            continue;
          }
          const discovery = sanitizeBrowserDiscoveryAccessEvidence(
            keepPolicyOnlyDiscoveryActionable(enrichment.discovery),
            evidence.accessBarriers
          );

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
              automationRunId: run.id,
              outcome: accessControlVerified
                ? "BLOCKED_AUTH"
                : directBookingVerified
                  ? "BLOCKED_POLICY"
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
          if (target.searchId) {
            await recordCourseProbe({
              searchId: target.searchId,
              courseId: target.course.id,
              automationRunId: run.id,
              outcome: "FETCH_FAILED",
              message: error instanceof Error ? error.message : "Browser probe failed"
            });
          }
          notes.push(
            `${target.course.name}: failed - ${error instanceof Error ? error.message : "unknown error"}`
          );
        } finally {
          await page.close().catch(() => undefined);
        }
      }
    } finally {
      await browser.close();
    }

    await finishAutomationRun(run.id, { outcome: "success", notes: notes.join("\n") });
  } catch (error) {
    await finishAutomationRun(run.id, {
      outcome: "failed",
      errors:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : { message: "Unknown browser probe failure" },
      notes: error instanceof Error ? error.stack ?? error.message : "Unknown browser probe failure"
    });
    throw error;
  }
}

async function collectBrowserEvidence(
  page: Page,
  input: Pick<
    BrowserDiscoveryEvidence,
    "courseId" | "courseName" | "sourceUrl" | "officialCourseWebsite"
  >
): Promise<BrowserDiscoveryEvidence> {
  const observedUrls = new Set<string>();
  const accessBarrierUrls = new Set<string>();
  const accessBarriers = new Map<string, 401 | 403>();

  page.on("request", (request) => {
    observedUrls.add(request.url());
  });
  page.on("response", (response) => {
    observedUrls.add(response.url());
    if ([401, 403].includes(response.status())) {
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
  const landingPageEvidence = await collectPageEvidence(page);

  await clickLikelyBookingLink(page);
  await trySelectSearchDate(page);
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  const destinationPageUrl = page.url();
  const destinationPageEvidence = await collectPageEvidence(page);
  const officialPageEvidence = haveSameOrigin(landingPageUrl, destinationPageUrl)
    ? {
        url: destinationPageUrl,
        evidence: destinationPageEvidence
      }
    : {
        url: landingPageUrl,
        evidence: landingPageEvidence
      };

  for (const url of [
    ...landingPageEvidence.anchors,
    ...landingPageEvidence.scripts,
    ...destinationPageEvidence.anchors,
    ...destinationPageEvidence.scripts
  ]) {
    observedUrls.add(url);
  }

  return {
    ...input,
    sourceUrl: officialPageEvidence.url,
    finalUrl: page.url(),
    observedUrls: [...observedUrls],
    linkCandidates: [
      ...landingPageEvidence.linkCandidates,
      ...destinationPageEvidence.linkCandidates
    ],
    officialPage: {
      url: officialPageEvidence.url,
      linkCandidates: officialPageEvidence.evidence.linkCandidates,
      courseName: input.courseName,
      visibleText: officialPageEvidence.evidence.visibleText.slice(0, 12_000)
    },
    accessBarrierUrls: [...accessBarrierUrls],
    accessBarriers: [...accessBarriers].map(([url, status]) => ({ url, status })),
    visibleText: [landingPageEvidence.visibleText, destinationPageEvidence.visibleText]
      .filter((text, index, values) => Boolean(text) && values.indexOf(text) === index)
      .join("\n")
  };
}

async function collectPageEvidence(page: Page) {
  return page.evaluate(() => {
    const anchorCandidates = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a[href]")
    )
      .map((anchor) => ({
        url: anchor.href,
        label: anchor.textContent?.replace(/\s+/g, " ").trim() ?? ""
      }))
      .filter((candidate) => Boolean(candidate.url))
      .slice(0, 80);
    const pageText = document.body?.innerText?.replace(/\s+/g, " ").trim() ?? "";
    const frameCandidates = /\b(?:book|reserve|reservation|tee.?times?)\b/i.test(pageText)
      ? Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe[src]"))
          .map((frame) => ({
            url: frame.src,
            label:
              frame.title?.replace(/\s+/g, " ").trim() ||
              frame.getAttribute("aria-label")?.replace(/\s+/g, " ").trim() ||
              "Embedded tee-time booking"
          }))
          .filter((candidate) => Boolean(candidate.url))
          .slice(0, 20)
      : [];
    const linkCandidates = [...anchorCandidates, ...frameCandidates].slice(0, 100);
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
    const widgetConfigs = Array.from(document.querySelectorAll<HTMLElement>("[data-widget-config]"))
      .map((element) => element.getAttribute("data-widget-config"))
      .filter((value): value is string => Boolean(value))
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
      linkCandidates,
      scripts,
      visibleText: [
        inlineCourseData,
        widgetConfigs,
        pageText.slice(0, 4000)
      ]
        .filter(Boolean)
        .join("\n")
    };
  });
}

function haveSameOrigin(left: string, right: string) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

async function clickLikelyBookingLink(page: Page) {
  const candidates = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .map((anchor) => ({
        href: anchor.href,
        text: anchor.textContent?.replace(/\s+/g, " ").trim() ?? ""
      }))
      .filter((anchor) =>
        /tee.?time|book|reserve|reservation|foreup|teeitup|golfnow|cps\.golf/i.test(
          `${anchor.text} ${anchor.href}`
        )
      )
  );
  const href = pickLikelyBookingHref(candidates, page.url());

  if (!href) {
    return;
  }

  await page.goto(href, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }).catch(
    () => undefined
  );
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
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
