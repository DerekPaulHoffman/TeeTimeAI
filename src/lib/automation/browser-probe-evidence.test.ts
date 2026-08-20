import { describe, expect, it } from "vitest";

import {
  assertBrowserProbeExpectedDisposition,
  buildBrowserNetworkContractFingerprint,
  buildBrowserButtonCandidates,
  buildBrowserFrameCandidates,
  buildBrowserFrameCandidatesFromHtml,
  buildBrowserProbeDecisionTrace,
  buildRedirectedProviderBookingCandidate,
  buildBrowserWidgetCandidates,
  classifyRenderedOfficialPageCourseIdentity,
  finalizeBrowserInvestigationEvidence,
  finalizeBrowserEvidenceSnapshots,
  hasDistinctProviderBookingCandidate,
  isRelevantBrowserAccessBarrierUrl,
  isRenderedUnprojectedSourceCandidateLocalityCorroborated,
  planBrowserInvestigationLinks,
  prepareBrowserPageEvidence,
  sanitizeBrowserAuditUrl,
  type RawBrowserPageEvidence,
} from "@/lib/automation/browser-probe-evidence";
import { buildBrowserDiscovery } from "@/lib/automation/browser-discovery";

const fictionalCourse = {
  courseId: "fixture-course",
  courseName: "Example Night Golf Center",
  sourceUrl: "https://night-golf.example/golf",
  officialCourseWebsite: "https://night-golf.example/golf",
};

const emptyPage: RawBrowserPageEvidence = {
  anchors: [],
  accessControlDetected: false,
  structuredActionScripts: [],
  linkCandidates: [],
  scripts: [],
  visibleText: "",
};

describe("browser probe evidence pipeline", () => {
  it("preserves an official booking-subdomain redirect to a public provider landing", () => {
    expect(
      buildRedirectedProviderBookingCandidate({
        officialPageUrl: "https://course.example/",
        selectedUrl: "https://members.course.example/book-tee-times",
        selectedLabel: "Book Tee Times",
        destinationUrl:
          "https://foreupsoftware.com/index.php/booking/22687/11624#/teetimes",
      }),
    ).toEqual({
      url: "https://foreupsoftware.com/index.php/booking/22687/11624#/teetimes",
      label: "Book Tee Times",
    });
  });

  it("rejects redirected provider evidence from an unrelated intermediary", () => {
    expect(
      buildRedirectedProviderBookingCandidate({
        officialPageUrl: "https://course.example/",
        selectedUrl: "https://unrelated.example/book-tee-times",
        selectedLabel: "Book Tee Times",
        destinationUrl:
          "https://foreupsoftware.com/index.php/booking/22687/11624#/teetimes",
      }),
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
          baseUrl: "https://course.example/book/",
        },
      ]),
    ).toEqual([
      {
        url: "https://course.example/public-tee-times/",
        label: "Book a tee time",
      },
    ]);
  });

  it("collects safe public booking URLs from encoded tee-time widget configuration", () => {
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64");

    expect(
      buildBrowserWidgetCandidates([
        encode({
          baseURL:
            "https://secure.east.prophetservices.com/SimsburyFarmsV3/Home/nIndex",
        }),
        encode({
          baseUrl: "https://cedar-ridge-golf-course-v2.book.teeitup.com/",
        }),
      ]),
    ).toEqual([
      {
        url: "https://secure.east.prophetservices.com/SimsburyFarmsV3/Home/nIndex",
        label: "Embedded tee-time booking",
      },
      {
        url: "https://cedar-ridge-golf-course-v2.book.teeitup.com/",
        label: "Embedded tee-time booking",
      },
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
        encode({ baseURL: "https://unknown-provider.example/tee-times" }),
      ]),
    ).toEqual([]);
  });

  it("extracts safe booking destinations only from non-submitting CTA buttons", () => {
    const base = {
      disabled: false,
      baseUrl: "https://course.example/",
      dataHref: null,
      dataUrl: null,
      onClick: null,
    };
    expect(
      buildBrowserButtonCandidates([
        {
          ...base,
          label: "View Tee Times",
          type: "button",
          insideForm: false,
          dataUrl: "/tee-times?course=123",
        },
        {
          ...base,
          label: "Book Tee Times",
          type: "submit",
          insideForm: true,
          dataUrl: "/reserve",
        },
        {
          ...base,
          label: "Confirm and Pay for Tee Time",
          type: "button",
          insideForm: false,
          onClick: "window.location='/checkout'",
        },
      ]),
    ).toEqual([
      {
        url: "https://course.example/tee-times?course=123",
        label: "View Tee Times",
      },
    ]);
  });

  it("stores URL shapes with query keys but no query values", () => {
    const shaped = sanitizeBrowserAuditUrl(
      "https://course.example/tee-times?date=2026-09-01&course=8675309#slots",
    );

    expect(shaped).toBe("https://course.example/tee-times?course=&date=");
    expect(shaped).not.toContain("2026-09-01");
    expect(shaped).not.toContain("8675309");
  });

  it("rejects credentialed and non-web lazy iframe sources", () => {
    expect(
      buildBrowserFrameCandidates([
        {
          src: null,
          dataSrc: "https://user:secret@booking.example/",
          title: null,
          ariaLabel: null,
          baseUrl: "https://course.example/",
        },
        {
          src: "javascript:alert(1)",
          dataSrc: null,
          title: null,
          ariaLabel: null,
          baseUrl: "https://course.example/",
        },
      ]),
    ).toEqual([]);
  });

  it("collects a lazy booking frame that client scripts may remove", () => {
    expect(
      buildBrowserFrameCandidatesFromHtml(
        `<main>Book a Tee Time</main>
         <iframe id="booking" data-src="/public-booking/" src=""
           aria-label="Public tee times"></iframe>`,
        "https://course.example/tee-times/",
      ),
    ).toEqual([
      {
        url: "https://course.example/public-booking/",
        label: "Public tee times",
      },
    ]);
  });

  it("ignores unrelated subresource barriers without ignoring provider barriers", () => {
    expect(
      isRelevantBrowserAccessBarrierUrl({
        responseUrl: "https://analytics.example/tracker",
        currentPageUrl: "https://course.example/tee-times",
        officialSourceUrl: "https://course.example/",
      }),
    ).toBe(false);
    expect(
      isRelevantBrowserAccessBarrierUrl({
        responseUrl: "https://course.example/protected-script.js",
        currentPageUrl: "https://course.example/tee-times",
        officialSourceUrl: "https://course.example/",
      }),
    ).toBe(true);
    expect(
      isRelevantBrowserAccessBarrierUrl({
        responseUrl:
          "https://phx-api-be-east-1b.kenna.io/alias/public-course/facilities",
        currentPageUrl: "https://course.example/tee-times",
        officialSourceUrl: "https://course.example/",
      }),
    ).toBe(true);
  });

  it("follows only a booking candidate from a distinct provider family", () => {
    const teeItUpCandidate = [
      {
        url: "https://public-course.book.teeitup.golf/",
        label: "Book a tee time",
      },
    ];
    expect(
      hasDistinctProviderBookingCandidate({
        linkCandidates: teeItUpCandidate,
        accessBarriers: [
          {
            url: "https://golfwithaccess.com/api/v0/auth/me",
            status: 401,
          },
        ],
      }),
    ).toBe(true);
    expect(
      hasDistinctProviderBookingCandidate({
        linkCandidates: teeItUpCandidate,
        accessBarriers: [
          {
            url: "https://phx-api-be-east-1b.kenna.io/v2/tee-times",
            status: 403,
          },
        ],
      }),
    ).toBe(false);
    expect(
      hasDistinctProviderBookingCandidate({
        linkCandidates: teeItUpCandidate,
        accessBarriers: [
          {
            url: "https://unknown-provider.example/protected",
            status: 403,
          },
        ],
      }),
    ).toBe(false);
  });

  it("retains structured official phone evidence across later empty hydration snapshots", () => {
    const landing = prepareBrowserPageEvidence(
      {
        ...emptyPage,
        identityCandidates: [fictionalCourse.courseName],
        visibleText: "Call the Pro Shop at 919-555-0142 to reserve a tee time.",
        structuredActionScripts: [
          String.raw`{\"actionButton\":{\"link\":{\"link\":{\"phone\":\"9195550142\"},\"type\":\"phone\"},\"label\":\"Call to Book a Tee Time\\n\",\"hidden\":false}}`,
        ],
      },
      fictionalCourse.courseName,
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
      destinationPageEvidence: emptyDestination,
    });
    const discovery = buildBrowserDiscovery(evidence);
    const trace = buildBrowserProbeDecisionTrace(evidence, discovery);

    expect(evidence.officialPage?.visibleText).toContain(
      "Call to Book a Tee Time",
    );
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
          Call: 508-555-0142 (The Clubhouse) and ask to speak to the starter.`,
      },
      fictionalCourse.courseName,
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
      destinationPageEvidence: prepared,
    });
    const discovery = buildBrowserDiscovery(evidence);

    expect(prepared.visibleText.length).toBeLessThanOrEqual(12_000);
    expect(discovery).toMatchObject({
      status: "VERIFIED",
      bookingMethod: "CONTACT_COURSE",
      automationReason: "NO_ONLINE_BOOKING",
      evidence: { learnedFrom: "official-phone-reservation-contact" },
    });
  });

  it("does not promote structured action evidence from a different website origin", () => {
    const landing = prepareBrowserPageEvidence({
      ...emptyPage,
      visibleText: fictionalCourse.courseName,
    });
    const external = prepareBrowserPageEvidence(
      {
        ...emptyPage,
        structuredActionScripts: [
          String.raw`{\"actionButton\":{\"type\":\"phone\",\"hidden\":false,\"label\":\"Call to Book a Tee Time\",\"phone\":\"555-010-3333\"}}`,
        ],
      },
      fictionalCourse.courseName,
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
      destinationPageEvidence: external,
    });

    expect(evidence.officialPage?.visibleText).not.toContain("555-010-3333");
  });

  it("keeps cross-origin booking-surface text separate from official-page text", () => {
    const accountUrl = "https://accounts.example/tenant/sign-in";
    const landing = prepareBrowserPageEvidence({
      ...emptyPage,
      linkCandidates: [{ url: accountUrl, label: "Book Tee Time" }],
      visibleText: `${fictionalCourse.courseName}. Book Tee Time.`,
    });
    const accountSurface = prepareBrowserPageEvidence({
      ...emptyPage,
      visibleText: `${fictionalCourse.courseName}. Sign in with your account to book the tee time.`,
    });
    const externalEvidence = finalizeBrowserEvidenceSnapshots({
      course: fictionalCourse,
      finalUrl: accountUrl,
      observedUrls: [accountUrl],
      successfulProviderUrls: [],
      accessBarrierUrls: [],
      accessBarriers: [],
      landingPageUrl: fictionalCourse.sourceUrl,
      landingPageEvidence: landing,
      firstDestinationPageUrl: accountUrl,
      firstDestinationPageEvidence: accountSurface,
      destinationPageUrl: accountUrl,
      destinationPageEvidence: accountSurface,
    });
    const sameOriginEvidence = finalizeBrowserEvidenceSnapshots({
      course: fictionalCourse,
      finalUrl: `${fictionalCourse.sourceUrl}/rates`,
      observedUrls: [],
      successfulProviderUrls: [],
      accessBarrierUrls: [],
      accessBarriers: [],
      landingPageUrl: fictionalCourse.sourceUrl,
      landingPageEvidence: landing,
      firstDestinationPageUrl: `${fictionalCourse.sourceUrl}/rates`,
      firstDestinationPageEvidence: landing,
      destinationPageUrl: `${fictionalCourse.sourceUrl}/rates`,
      destinationPageEvidence: landing,
    });

    expect(externalEvidence.bookingSurfaceText).toBe(
      `${fictionalCourse.courseName}. Sign in with your account to book the tee time.`,
    );
    expect(externalEvidence.officialPage?.visibleText).not.toContain(
      "Sign in with your account",
    );
    expect(sameOriginEvidence.bookingSurfaceText).toBeUndefined();
  });

  it("does not let a verified landing page authorize a later same-origin sibling page", () => {
    const targetUrl = "https://courses.example/target-course";
    const siblingUrl = "https://courses.example/sibling-course";
    const siblingBookingUrl =
      "https://shared-courses.book.teeitup.com/?course=999";
    const target = prepareBrowserPageEvidence({
      ...emptyPage,
      identityCandidates: ["Target Course Golf Club"],
      localityCandidates: ["100 Fairway Drive, Phoenix, AZ"],
      visibleText: "Target Course Golf Club",
    });
    const sibling = prepareBrowserPageEvidence({
      ...emptyPage,
      identityCandidates: ["Sibling Course Golf Club"],
      linkCandidates: [{ url: siblingBookingUrl, label: "Book a tee time" }],
      visibleText: "Target Course Golf Club\nSibling Course Golf Club",
    });

    const evidence = finalizeBrowserEvidenceSnapshots({
      course: {
        courseId: "target-course",
        courseName: "Target Course Golf Club",
        sourceUrl: targetUrl,
        officialCourseWebsite: targetUrl,
      },
      finalUrl: siblingUrl,
      observedUrls: [targetUrl, siblingUrl],
      successfulProviderUrls: [],
      accessBarrierUrls: [],
      accessBarriers: [],
      landingPageUrl: targetUrl,
      landingPageEvidence: target,
      firstDestinationPageUrl: siblingUrl,
      firstDestinationPageEvidence: sibling,
      destinationPageUrl: siblingUrl,
      destinationPageEvidence: sibling,
    });
    const discovery = buildBrowserDiscovery(evidence);

    expect(evidence.officialPage).toMatchObject({
      url: targetUrl,
      courseName: "Target Course Golf Club",
      linkCandidates: [],
    });
    expect(discovery).not.toMatchObject({
      status: "LEARNED",
      detectedPlatform: "TEEITUP",
    });
  });

  it("lets an abbreviated sibling title veto an otherwise exact target URL path", () => {
    const targetUrl = "https://courses.example/aguila-golf-course.html";
    const siblingBookingUrl =
      "https://shared-courses.book.teeitup.com/?course=999";
    const sibling = prepareBrowserPageEvidence({
      ...emptyPage,
      identityCandidates: ["Aguila 9"],
      linkCandidates: [{ url: siblingBookingUrl, label: "Book a tee time" }],
      visibleText: "Aguila 9",
    });

    const evidence = finalizeBrowserEvidenceSnapshots({
      course: {
        courseId: "aguila",
        courseName: "Aguila Golf Course",
        sourceUrl: targetUrl,
        officialCourseWebsite: targetUrl,
      },
      finalUrl: targetUrl,
      observedUrls: [targetUrl, siblingBookingUrl],
      successfulProviderUrls: [],
      accessBarrierUrls: [],
      accessBarriers: [],
      landingPageUrl: targetUrl,
      landingPageEvidence: sibling,
      firstDestinationPageUrl: targetUrl,
      firstDestinationPageEvidence: sibling,
      destinationPageUrl: targetUrl,
      destinationPageEvidence: sibling,
    });
    const discovery = buildBrowserDiscovery(evidence);

    expect(evidence.officialPage?.courseName).toBeUndefined();
    expect(discovery).toMatchObject({
      status: "INSPECTED",
      detectedPlatform: "TEEITUP",
      evidence: { learnedFrom: "teeitup-target-scope-unconfirmed" },
    });
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it("lets a conflicting sibling H1 veto a matching decorated rendered title", () => {
    const targetUrl = "https://courses.example/aguila-golf-course.html";
    const siblingBookingUrl =
      "https://city-of-phoenix-golf-courses.book.teeitup.com/?course=999";
    const page = prepareBrowserPageEvidence({
      ...emptyPage,
      identityCandidates: [
        "Aguila Golf Course | Phoenix Golf Courses",
        "Aguila 9",
      ],
      linkCandidates: [{ url: siblingBookingUrl, label: "Book a tee time" }],
      visibleText: "Aguila Golf Course. Aguila 9.",
    });

    const evidence = finalizeBrowserEvidenceSnapshots({
      course: {
        courseId: "aguila",
        courseName: "Aguila Golf Course",
        sourceUrl: targetUrl,
        officialCourseWebsite: targetUrl,
      },
      finalUrl: targetUrl,
      observedUrls: [targetUrl, siblingBookingUrl],
      successfulProviderUrls: [],
      accessBarrierUrls: [],
      accessBarriers: [],
      landingPageUrl: targetUrl,
      landingPageEvidence: page,
      firstDestinationPageUrl: targetUrl,
      firstDestinationPageEvidence: page,
      destinationPageUrl: targetUrl,
      destinationPageEvidence: page,
    });

    expect(evidence.officialPage?.courseName).toBeUndefined();
    expect(buildBrowserDiscovery(evidence)).toMatchObject({
      status: "INSPECTED",
      detectedPlatform: "TEEITUP",
    });
  });

  it("uses singleton verified layout evidence for the live rendered Aguila 18 page", () => {
    const targetUrl =
      "https://www.phoenix.gov/parks/golf/aguila-golf-course.html";
    const bookingUrl =
      "https://city-of-phoenix-golf-courses.book.teeitup.com/?course=287";
    const page = prepareBrowserPageEvidence({
      ...emptyPage,
      identityCandidates: [
        "Aguila 18 Golf Course | City of Phoenix",
        "Aguila 18 Golf Course",
      ],
      linkCandidates: [{ url: bookingUrl, label: "Book a tee time" }],
      visibleText: "Aguila 18 Golf Course. Book a tee time.",
    });

    const evidence = finalizeBrowserEvidenceSnapshots({
      course: {
        courseId: "aguila",
        courseName: "Aguila Golf Course",
        sourceUrl: targetUrl,
        officialCourseWebsite: targetUrl,
        verifiedLayoutHoleCounts: [18],
      },
      finalUrl: targetUrl,
      observedUrls: [targetUrl, bookingUrl],
      successfulProviderUrls: [],
      accessBarrierUrls: [],
      accessBarriers: [],
      landingPageUrl: targetUrl,
      landingPageEvidence: page,
      firstDestinationPageUrl: targetUrl,
      firstDestinationPageEvidence: page,
      destinationPageUrl: targetUrl,
      destinationPageEvidence: page,
    });

    expect(evidence.officialPage).toMatchObject({
      url: targetUrl,
      courseName: "Aguila Golf Course",
    });
    expect(buildBrowserDiscovery(evidence)).toMatchObject({
      status: "LEARNED",
      detectedPlatform: "TEEITUP",
      bookingUrl,
      apiMetadata: { facilityIds: [287] },
    });
  });

  it("rejects a compound rendered title whose suffix identifies a sibling", () => {
    const targetUrl = "https://courses.example/aguila-golf-course.html";
    const bookingUrl =
      "https://city-of-phoenix-golf-courses.book.teeitup.com/?course=999";
    const page = prepareBrowserPageEvidence({
      ...emptyPage,
      identityCandidates: ["Aguila Golf Course | Aguila 9"],
      linkCandidates: [{ url: bookingUrl, label: "Book a tee time" }],
      visibleText: "Aguila Golf Course. Aguila 9.",
    });
    const evidence = finalizeBrowserEvidenceSnapshots({
      course: {
        courseId: "aguila",
        courseName: "Aguila Golf Course",
        sourceUrl: targetUrl,
        officialCourseWebsite: targetUrl,
      },
      finalUrl: targetUrl,
      observedUrls: [bookingUrl],
      successfulProviderUrls: [],
      accessBarrierUrls: [],
      accessBarriers: [],
      landingPageUrl: targetUrl,
      landingPageEvidence: page,
      firstDestinationPageUrl: targetUrl,
      firstDestinationPageEvidence: page,
      destinationPageUrl: targetUrl,
      destinationPageEvidence: page,
    });

    expect(evidence.officialPage?.courseName).toBeUndefined();
    expect(buildBrowserDiscovery(evidence).status).not.toBe("LEARNED");
  });

  it("lets a disjoint sibling title veto an otherwise exact target URL path", () => {
    const targetUrl = "https://courses.example/aguila-golf-course.html";
    const siblingBookingUrl =
      "https://shared-courses.book.teeitup.com/?course=999";
    const sibling = prepareBrowserPageEvidence({
      ...emptyPage,
      identityCandidates: ["Cave Creek"],
      linkCandidates: [{ url: siblingBookingUrl, label: "Book a tee time" }],
      visibleText: "Cave Creek",
    });

    const evidence = finalizeBrowserEvidenceSnapshots({
      course: {
        courseId: "aguila",
        courseName: "Aguila Golf Course",
        sourceUrl: targetUrl,
        officialCourseWebsite: targetUrl,
      },
      finalUrl: targetUrl,
      observedUrls: [targetUrl, siblingBookingUrl],
      successfulProviderUrls: [],
      accessBarrierUrls: [],
      accessBarriers: [],
      landingPageUrl: targetUrl,
      landingPageEvidence: sibling,
      firstDestinationPageUrl: targetUrl,
      firstDestinationPageEvidence: sibling,
      destinationPageUrl: targetUrl,
      destinationPageEvidence: sibling,
    });
    const discovery = buildBrowserDiscovery(evidence);

    expect(evidence.officialPage?.courseName).toBeUndefined();
    expect(discovery).toMatchObject({
      status: "INSPECTED",
      detectedPlatform: "TEEITUP",
      evidence: { learnedFrom: "teeitup-target-scope-unconfirmed" },
    });
    expect(discovery.apiMetadata).toBeUndefined();
  });

  it.each([
    "Papago",
    "Papago City Golf Courses",
    "Aguila 9 Golf Courses",
    "Cave Creek Municipal Golf Course",
  ])(
    "lets rendered sibling identity %s veto an exact target URL path",
    (identity) => {
      const targetUrl =
        "https://www.phoenix.gov/parks/golf/aguila-golf-course.html";
      const siblingBookingUrl =
        "https://city-of-phoenix-golf-courses.book.teeitup.com/?course=999";
      const sibling = prepareBrowserPageEvidence({
        ...emptyPage,
        identityCandidates: [identity],
        linkCandidates: [{ url: siblingBookingUrl, label: "Book a tee time" }],
        visibleText: identity,
      });
      const evidence = finalizeBrowserEvidenceSnapshots({
        course: {
          courseId: "aguila",
          courseName: "Aguila Golf Course",
          sourceUrl: targetUrl,
          officialCourseWebsite: targetUrl,
        },
        finalUrl: targetUrl,
        observedUrls: [targetUrl, siblingBookingUrl],
        successfulProviderUrls: [],
        accessBarrierUrls: [],
        accessBarriers: [],
        landingPageUrl: targetUrl,
        landingPageEvidence: sibling,
        firstDestinationPageUrl: targetUrl,
        firstDestinationPageEvidence: sibling,
        destinationPageUrl: targetUrl,
        destinationPageEvidence: sibling,
      });

      expect(evidence.officialPage?.courseName).toBeUndefined();
      expect(buildBrowserDiscovery(evidence).status).not.toBe("LEARNED");
    },
  );

  it("plans human-grade official pages while requiring course scope for external booking links", () => {
    const planned = planBrowserInvestigationLinks({
      pageUrl: "https://course.example/",
      officialPageUrl: "https://course.example/",
      courseName: "Target Course Golf Club",
      sourceTrustedForCourse: false,
      candidates: [
        { url: "/golf/rates", label: "Golf rates" },
        { url: "/membership", label: "Membership and public access" },
        {
          url: "https://booking.example/tee-times",
          label: "Book Target Course Golf Club tee times",
        },
        {
          url: "https://unrelated.example/tee-times",
          label: "Book another course",
        },
        { url: "/account/login", label: "Member login" },
        { url: "/book/tee-times", label: "View tee times" },
      ],
    });

    expect(planned.sameOriginPages.map(({ url }) => url)).toEqual([
      "https://course.example/membership",
      "https://course.example/golf/rates",
    ]);
    expect(planned.bookingDestinations).toEqual([
      expect.objectContaining({
        url: "https://booking.example/tee-times",
        purpose: "BOOKING",
      }),
      expect.objectContaining({
        url: "https://course.example/book/tee-times",
        purpose: "BOOKING",
      }),
    ]);
  });

  it("requires locality corroboration before a rendered identity can match", () => {
    const pageWithoutLocality = prepareBrowserPageEvidence({
      ...emptyPage,
      identityCandidates: ["Target Course Golf Club"],
      visibleText: "Target Course Golf Club public tee times.",
    });
    const pageWithLocality = prepareBrowserPageEvidence({
      ...emptyPage,
      identityCandidates: ["Target Course Golf Club"],
      localityCandidates: ["100 Fairway Drive, Phoenix, AZ"],
      visibleText: "Target Course Golf Club public tee times.",
    });
    const course = {
      courseName: "Target Course Golf Club",
      address: "100 Fairway Drive",
      city: "Phoenix",
      stateCode: "AZ",
      googlePlaceIdPresent: true,
    };

    expect(
      classifyRenderedOfficialPageCourseIdentity(
        "https://course.example/target-course",
        pageWithoutLocality,
        course,
      ),
    ).toBe("UNKNOWN");
    expect(
      classifyRenderedOfficialPageCourseIdentity(
        "https://course.example/target-course",
        pageWithLocality,
        course,
      ),
    ).toBe("MATCH");
  });

  it("requires exact stored street, city, and state for an unprojected source candidate", () => {
    const course = {
      address: "100 Fairway Drive, Springfield, MA 01103",
      city: "Springfield",
      stateCode: "MA",
    };
    const exact = prepareBrowserPageEvidence({
      ...emptyPage,
      identityCandidates: ["Target Course Golf Club"],
      localityCandidates: ["100 Fairway Dr, Springfield, Massachusetts"],
      visibleText: "Target Course Golf Club public tee times.",
    });
    const wrongState = prepareBrowserPageEvidence({
      ...emptyPage,
      identityCandidates: ["Target Course Golf Club"],
      localityCandidates: ["100 Fairway Drive, Springfield, CA"],
      visibleText: "Target Course Golf Club public tee times.",
    });
    const stateOnly = prepareBrowserPageEvidence({
      ...emptyPage,
      identityCandidates: ["Target Course Golf Club"],
      localityCandidates: ["MA"],
      visibleText: "Target Course Golf Club public tee times.",
    });

    expect(
      isRenderedUnprojectedSourceCandidateLocalityCorroborated(exact, course),
    ).toBe(true);
    expect(
      isRenderedUnprojectedSourceCandidateLocalityCorroborated(wrongState, course),
    ).toBe(false);
    expect(
      isRenderedUnprojectedSourceCandidateLocalityCorroborated(stateOnly, course),
    ).toBe(false);
  });

  it("fails closed when an unprojected source candidate lacks city-state authority", () => {
    const page = prepareBrowserPageEvidence({
      ...emptyPage,
      identityCandidates: ["Target Course Golf Club"],
      localityCandidates: ["100 Fairway Drive, MA"],
      visibleText: "Target Course Golf Club public tee times.",
    });

    expect(
      isRenderedUnprojectedSourceCandidateLocalityCorroborated(page, {
        address: "100 Fairway Drive",
        city: null,
        stateCode: "MA",
      }),
    ).toBe(false);
  });

  it("does not mistake an ordinary word for a two-letter state locality", () => {
    const generic = prepareBrowserPageEvidence({
      ...emptyPage,
      identityCandidates: ["Target Course Golf Club"],
      visibleText: "Play golf in every season.",
    });
    const located = prepareBrowserPageEvidence({
      ...emptyPage,
      identityCandidates: ["Target Course Golf Club"],
      localityCandidates: ["Indianapolis, IN"],
      visibleText: "Play golf in every season.",
    });
    const course = {
      courseName: "Target Course Golf Club",
      stateCode: "IN",
    };

    expect(
      classifyRenderedOfficialPageCourseIdentity(
        "https://course.example/target-course",
        generic,
        course,
      ),
    ).toBe("UNKNOWN");
    expect(
      classifyRenderedOfficialPageCourseIdentity(
        "https://course.example/target-course",
        located,
        course,
      ),
    ).toBe("MATCH");
  });

  it("stores network contracts without path identifiers, query values, or payloads", () => {
    const fingerprint = buildBrowserNetworkContractFingerprint({
      url: "https://api.booking.example/v2/facilities/8675309/tee-times?course=4455&date=2026-09-01",
      method: "POST",
      resourceType: "fetch",
      status: 200,
    });

    expect(fingerprint).toEqual({
      origin: "https://api.booking.example",
      method: "POST",
      pathPattern: "/v2/facilities/:number/tee-times",
      queryKeys: ["course", "date"],
      resourceType: "fetch",
      status: 200,
    });
    expect(JSON.stringify(fingerprint)).not.toContain("8675309");
    expect(JSON.stringify(fingerprint)).not.toContain("4455");
    expect(JSON.stringify(fingerprint)).not.toContain("2026-09-01");
  });

  it("aggregates only target-course pages and relevant network contracts", () => {
    const rootUrl = "https://courses.example/target-course";
    const neutralUrl = "https://courses.example/golf/rates";
    const siblingUrl = "https://courses.example/sibling-course";
    const bookingUrl = "https://booking.example/tee-times?course=4455";
    const target = prepareBrowserPageEvidence({
      ...emptyPage,
      identityCandidates: ["Target Course Golf Club"],
      localityCandidates: ["100 Fairway Drive, Phoenix, AZ"],
      linkCandidates: [{ url: bookingUrl, label: "Book a tee time" }],
      visibleText: "Target Course Golf Club is open to the public.",
    });
    const neutral = prepareBrowserPageEvidence({
      ...emptyPage,
      visibleText: "Daily-fee rates and booking instructions.",
    });
    const sibling = prepareBrowserPageEvidence({
      ...emptyPage,
      identityCandidates: ["Sibling Course Golf Club"],
      linkCandidates: [
        {
          url: "https://sibling.book.teeitup.com/?course=999",
          label: "Book a tee time",
        },
      ],
      visibleText: "Sibling Course Golf Club is private.",
    });
    const evidence = finalizeBrowserInvestigationEvidence({
      course: {
        courseId: "target-course",
        courseName: "Target Course Golf Club",
        sourceUrl: rootUrl,
        officialCourseWebsite: rootUrl,
        address: "100 Fairway Drive",
        city: "Phoenix",
        stateCode: "AZ",
        googlePlaceIdPresent: true,
      },
      mode: "INDEPENDENT",
      auditContext: {
        incidentCycle: 4,
        runtimeVersion: "a".repeat(40),
        observedAt: new Date("2026-08-20T12:00:00.000Z"),
      },
      retainedBookingUrl: bookingUrl,
      pageVisits: [
        {
          requestedUrl: rootUrl,
          finalUrl: rootUrl,
          label: "Target Course Golf Club",
          depth: 0,
          parentUrl: null,
          interactionBlocked: false,
          evidence: target,
          networkContracts: [
            {
              origin: "https://courses.example",
              method: "GET",
              pathPattern: "/target-course",
              queryKeys: [],
              resourceType: "document",
              status: 200,
            },
            {
              origin: "https://analytics.example",
              method: "GET",
              pathPattern: "/collect",
              queryKeys: ["event"],
              resourceType: "fetch",
              status: 204,
            },
          ],
        },
        {
          requestedUrl: neutralUrl,
          finalUrl: neutralUrl,
          label: "Golf rates",
          depth: 1,
          parentUrl: rootUrl,
          interactionBlocked: false,
          evidence: neutral,
        },
        {
          requestedUrl: siblingUrl,
          finalUrl: siblingUrl,
          label: "Sibling course",
          depth: 1,
          parentUrl: rootUrl,
          interactionBlocked: false,
          evidence: sibling,
        },
      ],
      bookingDestinations: [
        {
          sourcePageUrl: rootUrl,
          requestedUrl: bookingUrl,
          finalUrl: bookingUrl,
          label: "Book a tee time",
          courseScoped: true,
          interactionBlocked: false,
          evidence: prepareBrowserPageEvidence({
            ...emptyPage,
            visibleText: "Public tee times",
          }),
          networkContracts: [
            {
              origin: "https://booking.example",
              method: "GET",
              pathPattern: "/api/availability",
              queryKeys: ["course", "date"],
              resourceType: "fetch",
              status: 200,
            },
            {
              origin: "https://fonts.example",
              method: "GET",
              pathPattern: "/font.woff2",
              queryKeys: [],
              resourceType: "font",
              status: 200,
            },
          ],
        },
      ],
    });

    expect(evidence.officialPage?.visibleText).toContain(
      "Target Course Golf Club is open to the public.",
    );
    expect(evidence.officialPage?.visibleText).toContain(
      "Daily-fee rates and booking instructions.",
    );
    expect(evidence.officialPage?.visibleText).not.toContain("is private");
    expect(evidence.officialPage?.linkCandidates).not.toContainEqual(
      expect.objectContaining({
        url: "https://sibling.book.teeitup.com/?course=999",
      }),
    );
    expect(evidence.browserInvestigation).toMatchObject({
      mode: "INDEPENDENT",
      identityAuthority: {
        source: "RETAINED_OFFICIAL_WEBSITE",
        localityEvidencePresent: true,
        placeEvidencePresent: true,
      },
      incidentCycle: 4,
      runtimeVersion: "a".repeat(40),
      observedAt: "2026-08-20T12:00:00.000Z",
    });
    expect(
      evidence.browserInvestigation.sameOriginPages.map(
        ({ identityStatus, trustedForCourse }) => ({
          identityStatus,
          trustedForCourse,
        }),
      ),
    ).toEqual([
      { identityStatus: "MATCH", trustedForCourse: true },
      { identityStatus: "UNKNOWN", trustedForCourse: true },
      { identityStatus: "CONFLICT", trustedForCourse: false },
    ]);
    expect(
      evidence.browserInvestigation.networkContracts.map(
        ({ origin }) => origin,
      ),
    ).toEqual(["https://courses.example", "https://booking.example"]);
    expect(JSON.stringify(evidence.browserInvestigation)).not.toContain(
      "Phoenix",
    );
    expect(JSON.stringify(evidence.browserInvestigation)).not.toContain(
      "Fairway",
    );
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
      publicProviderReadDetected: false,
    };

    expect(() =>
      assertBrowserProbeExpectedDisposition("MANUAL_FINAL", [trace]),
    ).toThrow("target ordinals 1");
  });
});
