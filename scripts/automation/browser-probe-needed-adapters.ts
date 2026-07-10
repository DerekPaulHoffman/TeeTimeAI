import "./load-local-env";

import { chromium, type Page } from "playwright";

import { buildBrowserDiscovery, type BrowserDiscoveryEvidence } from "@/lib/automation/browser-discovery";
import {
  applyBrowserDiscoveryToCourse,
  finishAutomationRun,
  listBrowserProbeTargets,
  recordBrowserDiscovery,
  recordCourseProbe,
  startAutomationRun
} from "@/lib/automation/db-service";
import { prisma } from "@/lib/prisma";

const PROMPT_VERSION = "tee-time-spot-browser-probe-v1";
const DEFAULT_LIMIT = 5;
const NAVIGATION_TIMEOUT_MS = 20_000;

async function main() {
  const limit = Number(process.env.BROWSER_PROBE_LIMIT ?? DEFAULT_LIMIT);
  const run = await startAutomationRun(PROMPT_VERSION);
  const notes: string[] = [];

  try {
    const targets = await listBrowserProbeTargets(limit);
    notes.push(`Selected ${targets.length} browser probe targets.`);

    if (targets.length === 0) {
      await finishAutomationRun(run.id, { outcome: "no_op", notes: notes.join("\n") });
      return;
    }

    const browser = await chromium.launch();
    try {
      for (const target of targets) {
        const page = await browser.newPage();
        try {
          const evidence = await collectBrowserEvidence(page, {
            courseId: target.course.id,
            courseName: target.course.name,
            sourceUrl: target.probeUrl
          });
          const discovery = buildBrowserDiscovery(evidence);

          await recordBrowserDiscovery(discovery);
          await applyBrowserDiscoveryToCourse(discovery);
          await recordCourseProbe({
            searchId: target.searchId,
            courseId: target.course.id,
            automationRunId: run.id,
            outcome: discovery.status === "LEARNED" ? "NEEDS_ADAPTER" : "NEEDS_ADAPTER",
            message:
              discovery.status === "LEARNED"
                ? `Browser probe learned ${discovery.detectedPlatform} adapter metadata; rerun the poller to verify tee-sheet retrieval.`
                : `Browser probe inspected site but did not learn a reusable adapter yet.`,
            evidenceUrl: discovery.bookingUrl,
            rawSummary: {
              browserProbe: {
                status: discovery.status,
                detectedPlatform: discovery.detectedPlatform,
                apiEndpoint: discovery.apiEndpoint,
                confidence: discovery.confidence,
                learnedFrom: discovery.evidence.learnedFrom
              }
            }
          });

          notes.push(
            `${target.course.name}: ${discovery.status} ${discovery.detectedPlatform} confidence=${discovery.confidence}`
          );
        } catch (error) {
          await recordCourseProbe({
            searchId: target.searchId,
            courseId: target.course.id,
            automationRunId: run.id,
            outcome: "FETCH_FAILED",
            message: error instanceof Error ? error.message : "Browser probe failed"
          });
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
  input: Pick<BrowserDiscoveryEvidence, "courseId" | "courseName" | "sourceUrl">
): Promise<BrowserDiscoveryEvidence> {
  const observedUrls = new Set<string>();

  page.on("request", (request) => {
    observedUrls.add(request.url());
  });
  page.on("response", (response) => {
    observedUrls.add(response.url());
  });

  await page.goto(input.sourceUrl, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS
  });

  await clickLikelyBookingLink(page);
  await trySelectSearchDate(page);
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);

  const pageEvidence = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .map((anchor) => anchor.href)
      .filter(Boolean)
      .slice(0, 80);
    const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]"))
      .map((script) => script.src)
      .filter(Boolean)
      .slice(0, 80);
    const inlineCourseData = Array.from(document.querySelectorAll<HTMLScriptElement>("script:not([src])"))
      .map((script) => script.textContent ?? "")
      .filter((text) => /window\.(courses|property)\s*=/.test(text))
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
      scripts,
      visibleText: [
        document.body?.innerText?.replace(/\s+/g, " ").trim().slice(0, 2000),
        inlineCourseData,
        widgetConfigs
      ]
        .filter(Boolean)
        .join("\n")
    };
  });

  for (const url of [...pageEvidence.anchors, ...pageEvidence.scripts]) {
    observedUrls.add(url);
  }

  return {
    ...input,
    finalUrl: page.url(),
    observedUrls: [...observedUrls],
    visibleText: pageEvidence.visibleText
  };
}

async function clickLikelyBookingLink(page: Page) {
  const href = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .map((anchor) => ({
        href: anchor.href,
        text: anchor.textContent?.replace(/\s+/g, " ").trim() ?? ""
      }))
      .filter((anchor) => /tee.?time|book|reserve|reservation|foreup|teeitup|golfnow|cps\.golf/i.test(`${anchor.text} ${anchor.href}`))
      .map((anchor) => {
        const searchable = `${anchor.text} ${anchor.href}`;
        let score = 0;
        if (/foreupsoftware\.com|\.book\.teeitup\.golf|golfnow\.com|cps\.golf/i.test(anchor.href)) {
          score += 100;
        }
        if (/tee.?time/i.test(searchable)) {
          score += 20;
        }
        if (/book|reserve|reservation/i.test(searchable)) {
          score += 10;
        }
        if (/#$/.test(anchor.href)) {
          score -= 50;
        }
        return { ...anchor, score };
      })
      .sort((a, b) => b.score - a.score);

    return candidates[0]?.href ?? null;
  });

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
