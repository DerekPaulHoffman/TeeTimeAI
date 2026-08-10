import { describe, expect, it } from "vitest";

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
  it("preserves an official booking-subdomain redirect to a public provider landing", () => {
    expect(
      buildRedirectedProviderBookingCandidate({
        officialPageUrl: "https://course.example/",
        selectedUrl: "https://members.course.example/book-tee-times",
        selectedLabel: "Book Tee Times",
        destinationUrl:
          "https://foreupsoftware.com/index.php/booking/22687/11624#/teetimes"
      })
    ).toEqual({
      url: "https://foreupsoftware.com/index.php/booking/22687/11624#/teetimes",
      label: "Book Tee Times"
    });
  });

  it("rejects redirected provider evidence from an unrelated intermediary", () => {
    expect(
      buildRedirectedProviderBookingCandidate({
        officialPageUrl: "https://course.example/",
        selectedUrl: "https://unrelated.example/book-tee-times",
        selectedLabel: "Book Tee Times",
        destinationUrl:
          "https://foreupsoftware.com/index.php/booking/22687/11624#/teetimes"
      })
    ).toBeNull();
  });

  it("collects a public booking URL from a lazy iframe data source", () => {
    expect(
      buildBrowserFrameCandidates([
        {
          src: "",
          dataSrc: "/public-tee-times/",
          title: "",
          ariaLabel: "Book a tee time",
          baseUrl: "https://course.example/book/"
        }
      ])
    ).toEqual([
      {
        url: "https://course.example/public-tee-times/",
        label: "Book a tee time"
      }
    ]);
  });

  it("collects safe public booking URLs from encoded tee-time widget configuration", () => {
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64");

    expect(
      buildBrowserWidgetCandidates([
        encode({
          baseURL:
            "https://secure.east.prophetservices.com/SimsburyFarmsV3/Home/nIndex"
        }),
        encode({
          baseUrl:
            "https://cedar-ridge-golf-course-v2.book.teeitup.com/"
        })
      ])
    ).toEqual([
      {
        url:
          "https://secure.east.prophetservices.com/SimsburyFarmsV3/Home/nIndex",
        label: "Embedded tee-time booking"
      },
      {
        url: "https://cedar-ridge-golf-course-v2.book.teeitup.com/",
        label: "Embedded tee-time booking"
      }
    ]);
  });

  it("rejects unsafe or non-booking widget destinations", () => {
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64");

    expect(
      buildBrowserWidgetCandidates([
        "not-base64-json",
        encode({ baseURL: "http://secure.east.prophetservices.com/Course" }),
        encode({ baseURL: "https://user@example.com/course" }),
        encode({ baseURL: "https://secure.east.prophetservices.com/checkout" }),
        encode({ baseURL: "https://unknown-provider.example/tee-times" })
      ])
    ).toEqual([]);
  });

  it("rejects credentialed and non-web lazy iframe sources", () => {
    expect(
      buildBrowserFrameCandidates([
        {
          src: null,
          dataSrc: "https://user:secret@booking.example/",
          title: null,
          ariaLabel: null,
          baseUrl: "https://course.example/"
        },
        {
          src: "javascript:alert(1)",
          dataSrc: null,
          title: null,
          ariaLabel: null,
          baseUrl: "https://course.example/"
        }
      ])
    ).toEqual([]);
  });

  it("collects a lazy booking frame that client scripts may remove", () => {
    expect(
      buildBrowserFrameCandidatesFromHtml(
        `<main>Book a Tee Time</main>
         <iframe id="booking" data-src="/public-booking/" src=""
           aria-label="Public tee times"></iframe>`,
        "https://course.example/tee-times/"
      )
    ).toEqual([{
      url: "https://course.example/public-booking/",
      label: "Public tee times"
    }]);
  });

  it("ignores unrelated subresource barriers without ignoring provider barriers", () => {
    expect(
      isRelevantBrowserAccessBarrierUrl({
        responseUrl: "https://analytics.example/tracker",
        currentPageUrl: "https://course.example/tee-times",
        officialSourceUrl: "https://course.example/"
      })
    ).toBe(false);
    expect(
      isRelevantBrowserAccessBarrierUrl({
        responseUrl: "https://course.example/protected-script.js",
        currentPageUrl: "https://course.example/tee-times",
        officialSourceUrl: "https://course.example/"
      })
    ).toBe(true);
    expect(
      isRelevantBrowserAccessBarrierUrl({
        responseUrl:
          "https://phx-api-be-east-1b.kenna.io/alias/public-course/facilities",
        currentPageUrl: "https://course.example/tee-times",
        officialSourceUrl: "https://course.example/"
      })
    ).toBe(true);
  });

  it("follows only a booking candidate from a distinct provider family", () => {
    const teeItUpCandidate = [{
      url: "https://public-course.book.teeitup.golf/",
      label: "Book a tee time"
    }];
    expect(
      hasDistinctProviderBookingCandidate({
        linkCandidates: teeItUpCandidate,
        accessBarriers: [{
          url: "https://golfwithaccess.com/api/v0/auth/me",
          status: 401
        }]
      })
    ).toBe(true);
    expect(
      hasDistinctProviderBookingCandidate({
        linkCandidates: teeItUpCandidate,
        accessBarriers: [{
          url: "https://phx-api-be-east-1b.kenna.io/v2/tee-times",
          status: 403
        }]
      })
    ).toBe(false);
    expect(
      hasDistinctProviderBookingCandidate({
        linkCandidates: teeItUpCandidate,
        accessBarriers: [{
          url: "https://unknown-provider.example/protected",
          status: 403
        }]
      })
    ).toBe(false);
  });

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
      successfulProviderUrls: [],
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
      successfulProviderUrls: [],
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
      successfulProviderUrls: [],
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
      accessBarrierDetected: false,
      publicProviderReadDetected: false
    };

    expect(() =>
      assertBrowserProbeExpectedDisposition("MANUAL_FINAL", [trace])
    ).toThrow("target ordinals 1");
  });
});
