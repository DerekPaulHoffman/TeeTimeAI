import { describe, expect, it } from "vitest";

import {
  assertBrowserProbeExpectedDisposition,
  buildBrowserProbeDecisionTrace,
  finalizeBrowserEvidenceSnapshots,
  prepareBrowserPageEvidence,
  type RawBrowserPageEvidence
} from "@/lib/automation/browser-probe-evidence";
import { buildBrowserDiscovery } from "@/lib/automation/browser-discovery";

const fictionalCourse = {
  courseId: "fixture-course",
  courseName: "Example Night Golf Center",
  sourceUrl: "https://night-golf.example/golf",
  officialCourseWebsite: "https://night-golf.example/golf"
};

const emptyPage: RawBrowserPageEvidence = {
  anchors: [],
  accessControlDetected: false,
  structuredActionScripts: [],
  linkCandidates: [],
  scripts: [],
  visibleText: ""
};

describe("browser probe evidence pipeline", () => {
  it("retains structured official phone evidence across later empty hydration snapshots", () => {
    const landing = prepareBrowserPageEvidence(
      {
        ...emptyPage,
        visibleText:
          "Call the Pro Shop at 919-555-0142 to reserve a tee time.",
        structuredActionScripts: [
          String.raw`{\"actionButton\":{\"link\":{\"link\":{\"phone\":\"9195550142\"},\"type\":\"phone\"},\"label\":\"Call to Book a Tee Time\\n\",\"hidden\":false}}`
        ]
      },
      fictionalCourse.courseName
    );
    const emptyDestination = prepareBrowserPageEvidence(emptyPage);
    const evidence = finalizeBrowserEvidenceSnapshots({
      course: fictionalCourse,
      finalUrl: "https://night-golf.example/golf/rates",
      observedUrls: [],
      accessBarrierUrls: [],
      accessBarriers: [],
      landingPageUrl: fictionalCourse.sourceUrl,
      landingPageEvidence: landing,
      firstDestinationPageUrl: "https://night-golf.example/golf/rates",
      firstDestinationPageEvidence: emptyDestination,
      destinationPageUrl: "https://night-golf.example/golf/rates",
      destinationPageEvidence: emptyDestination
    });
    const discovery = buildBrowserDiscovery(evidence);
    const trace = buildBrowserProbeDecisionTrace(evidence, discovery);

    expect(evidence.officialPage?.visibleText).toContain("Call to Book a Tee Time");
    expect(trace.monitoringDisposition).toBe("MANUAL_FINAL");
    expect(trace.reasonCode).toBe("MANUAL_CLASSIFICATION_READY");
    expect(JSON.stringify(trace)).not.toContain(fictionalCourse.courseName);
    expect(JSON.stringify(trace)).not.toContain("9195550142");
    expect(JSON.stringify(trace)).not.toContain("night-golf.example");
  });

  it("preserves a bounded manual tee-time instruction beyond the leading page text", () => {
    const prepared = prepareBrowserPageEvidence(
      {
        ...emptyPage,
        visibleText: `${"Theme navigation and gallery text. ".repeat(220)}
          Tee Times. Tee Times are available Weekends: 6:00 A.M. - 11:00 A.M.
          Call: 508-555-0142 (The Clubhouse) and ask to speak to the starter.`
      },
      fictionalCourse.courseName
    );
    const evidence = finalizeBrowserEvidenceSnapshots({
      course: fictionalCourse,
      finalUrl: fictionalCourse.sourceUrl,
      observedUrls: [fictionalCourse.sourceUrl],
      accessBarrierUrls: [],
      accessBarriers: [],
      landingPageUrl: fictionalCourse.sourceUrl,
      landingPageEvidence: prepared,
      firstDestinationPageUrl: fictionalCourse.sourceUrl,
      firstDestinationPageEvidence: prepared,
      destinationPageUrl: fictionalCourse.sourceUrl,
      destinationPageEvidence: prepared
    });
    const discovery = buildBrowserDiscovery(evidence);

    expect(prepared.visibleText.length).toBeLessThanOrEqual(12_000);
    expect(discovery).toMatchObject({
      status: "VERIFIED",
      bookingMethod: "CONTACT_COURSE",
      automationReason: "NO_ONLINE_BOOKING",
      evidence: { learnedFrom: "official-phone-reservation-contact" }
    });
  });

  it("does not promote structured action evidence from a different website origin", () => {
    const landing = prepareBrowserPageEvidence({
      ...emptyPage,
      visibleText: fictionalCourse.courseName
    });
    const external = prepareBrowserPageEvidence(
      {
        ...emptyPage,
        structuredActionScripts: [
          String.raw`{\"actionButton\":{\"type\":\"phone\",\"hidden\":false,\"label\":\"Call to Book a Tee Time\",\"phone\":\"555-010-3333\"}}`
        ]
      },
      fictionalCourse.courseName
    );
    const evidence = finalizeBrowserEvidenceSnapshots({
      course: fictionalCourse,
      finalUrl: "https://booking.invalid/tee-times",
      observedUrls: [],
      accessBarrierUrls: [],
      accessBarriers: [],
      landingPageUrl: fictionalCourse.sourceUrl,
      landingPageEvidence: landing,
      firstDestinationPageUrl: "https://booking.invalid/tee-times",
      firstDestinationPageEvidence: external,
      destinationPageUrl: "https://booking.invalid/tee-times",
      destinationPageEvidence: external
    });

    expect(evidence.officialPage?.visibleText).not.toContain("555-010-3333");
  });

  it("fails a release expectation with redacted target ordinals", () => {
    const trace = {
      outcome: "inspected" as const,
      reasonCode: "NO_REUSABLE_PROVIDER_SIGNAL" as const,
      status: "INSPECTED" as const,
      detectedPlatform: "UNKNOWN" as const,
      monitoringDisposition: "ACTIONABLE" as const,
      confidenceBand: "LOW" as const,
      structuredPhoneActionFound: false,
      officialPageContextPresent: true,
      accessBarrierDetected: false
    };

    expect(() =>
      assertBrowserProbeExpectedDisposition("MANUAL_FINAL", [trace])
    ).toThrow("target ordinals 1");
  });
});
