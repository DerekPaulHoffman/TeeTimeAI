import { enrichBrowserDiscoveryWithProviderLease, type BrowserDiscovery } from "@/lib/automation/browser-discovery";
import { finalizeBrowserInvestigationEvidence, prepareBrowserPageEvidence } from "@/lib/automation/browser-probe-evidence";
import { isCorroboratedOfficialSourcePage, validateOfficialSourceResult, type OfficialSourceJob, type OfficialSourceResult } from "./official-source-contracts";

/** Consumed only by the owned verifier after validating its live job/owner fence.
 * The structured fragments below were observed on one page; they are not a
 * reconstruction of the page body or evidence inherited from another course.
 */
export async function discoverFromOfficialSource(input: {
  job: OfficialSourceJob;
  result: OfficialSourceResult;
  cycle: number;
  runtimeVersion: string;
  stage: "RENDERED_BROWSER_DISCOVERY" | "INDEPENDENT_CONFIRMATION";
  now: Date;
  runWithProviderLease: Parameters<typeof enrichBrowserDiscoveryWithProviderLease>[2];
  fetchImpl?: typeof fetch;
}) {
  const { job, result } = validateOfficialSourceResult(input.job, input.result, input.now);
  const pages = result.pages.filter(page => isCorroboratedOfficialSourcePage(page, job.course));
  // Do not combine two separately scoped course pages into one identity.
  const selected = pages.filter(page => page.bookingLinks.length > 0);
  if (selected.length !== 1) return { status: "UNRESOLVED" as const };
  const page = selected[0];
  const visibleText = [page.courseName, page.street, page.city, page.stateCode].filter(Boolean).join(" ");
  const observedAt = new Date(result.observedAt);
  const evidence = finalizeBrowserInvestigationEvidence({
    course: { courseId: job.course.id, courseName: job.course.name,
      sourceUrl: job.sourceUrl, officialCourseWebsite: job.course.website,
      address: job.course.address, city: job.course.city, stateCode: job.course.stateCode },
    mode: input.stage === "INDEPENDENT_CONFIRMATION" ? "INDEPENDENT" : "RENDERED",
    auditContext: { incidentCycle: input.cycle, runtimeVersion: input.runtimeVersion, observedAt },
    providerRequestObserved: true, bookingNavigationAttempts: 0, bookingDestinations: [],
    pageVisits: [{ requestedUrl: page.pageUrl, finalUrl: page.pageUrl, label: page.courseName!,
      depth: result.pages.indexOf(page) === 0 ? 0 : 1,
      parentUrl: result.pages.indexOf(page) === 0 ? null : result.pages[0].pageUrl,
      requiresDirectIdentityMatch: true, interactionBlocked: false,
      evidence: prepareBrowserPageEvidence({ anchors: [], scripts: [], structuredActionScripts: [],
        accessControlDetected: false, managedProtectionTemplateDetected: false, managedProtectionDocumentDetected: false,
        linkCandidates: page.bookingLinks, identityCandidates: [page.courseName!],
        localityCandidates: [visibleText], visibleText }),
    }],
  });
  // A strictly validated TeeItUp destination is a family clue, not facility
  // metadata. Do not pretend the provider landing was visited or trust its ID.
  const initial: BrowserDiscovery = { courseId: job.course.id, sourceUrl: job.sourceUrl,
    status: "INSPECTED", detectedPlatform: "TEEITUP", confidence: 0.2,
    evidence: { learnedFrom: "signed-official-source-links", observedUrls: [page.pageUrl] } };
  const enrichment = await enrichBrowserDiscoveryWithProviderLease(initial, job.course.name,
    input.runWithProviderLease, input.fetchImpl ?? fetch, {
      course: job.course,
      observation: { courseId: job.course.id, pageUrl: page.pageUrl, observedAt, visibleText, links: page.bookingLinks },
    });
  if (!enrichment.acquired) return { status: "DEFERRED" as const };
  return {
    status: "OBSERVED" as const,
    discovery: { ...enrichment.discovery, evidence: { ...enrichment.discovery.evidence,
      browserInvestigation: evidence.browserInvestigation,
      officialSourceReader: { jobId: job.id, contextKey: job.contextKey, readerVersion: result.readerVersion, observedAt: result.observedAt },
    } },
    evidence,
  };
}
