import { chromium, type APIResponse, type Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";

import {
  collectBrowserEvidence,
  collectStaticPageFrameCandidates,
  getPersistableBrowserOperationFailure,
  isReadOnlyBrowserRequestMethod,
  isSafeRenderedBrowserInteractionDestination,
  retainOnlyPersistableBrowserUrls,
  runPersistableBrowserOperation,
} from "../../../scripts/automation/browser-probe-needed-adapters";
import { buildBrowserDiscovery } from "./browser-discovery";

function managedProtectionHtml(reference: string, extra = "") {
  return `<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1><p>You don't have permission to access this server.</p><p>Reference #18.${reference}</p><p>https://errors.edgesuite.net/18.${reference}</p>${extra}</body></html>`;
}

describe("rendered browser navigation safety", () => {
  it("surfaces a transient navigation failure instead of returning completable evidence", async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const officialPageUrl = "https://network-failure-course.example/";
      await context.route("https://network-failure-course.example/**", (route) =>
        route.abort("internetdisconnected"),
      );

      let caught: unknown;
      try {
        await runPersistableBrowserOperation(() =>
          collectBrowserEvidence(page, {
            courseId: "network-failure-course",
            courseName: "Network Failure Golf Course",
            sourceUrl: officialPageUrl,
            officialCourseWebsite: officialPageUrl,
          }),
        );
      } catch (error) {
        caught = error;
      }

      expect(getPersistableBrowserOperationFailure(caught)).toBe("NETWORK");
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  it("surfaces evidence-collection programming errors without tagging or completing them", async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const officialPageUrl = "https://programming-failure-course.example/";
      const programmingError = new SyntaxError("Unexpected string");
      await context.route("https://programming-failure-course.example/**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<html><title>Programming Failure Golf Course</title><body><h1>Programming Failure Golf Course</h1></body></html>",
        }),
      );
      vi.spyOn(page.request, "get").mockResolvedValue({
        ok: () => false,
      } as APIResponse);
      vi.spyOn(page, "evaluate").mockRejectedValueOnce(programmingError);

      let caught: unknown;
      try {
        await runPersistableBrowserOperation(() =>
          collectBrowserEvidence(page, {
            courseId: "programming-failure-course",
            courseName: "Programming Failure Golf Course",
            sourceUrl: officialPageUrl,
            officialCourseWebsite: officialPageUrl,
          }),
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(programmingError);
      expect(getPersistableBrowserOperationFailure(caught)).toBeNull();
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  it("keeps usable partial evidence after a Playwright navigation timeout", async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const officialPageUrl = "https://partial-timeout-course.example/";
      await context.route("https://partial-timeout-course.example/**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<html><title>Partial Timeout Golf Course</title><body><h1>Partial Timeout Golf Course</h1></body></html>",
        }),
      );
      vi.spyOn(page.request, "get").mockResolvedValue({
        ok: () => false,
      } as APIResponse);
      await page.goto(officialPageUrl, { waitUntil: "domcontentloaded" });
      const timeoutError = Object.assign(
        new Error("page.goto: Timeout 20000ms exceeded."),
        {
          name: "TimeoutError",
          stack:
            "TimeoutError: page.goto: Timeout 20000ms exceeded.\n    at node_modules/playwright-core/lib/client/frame.js:1:1",
        },
      );
      vi.spyOn(page, "goto").mockRejectedValueOnce(timeoutError);

      const evidence = await runPersistableBrowserOperation(() =>
        collectBrowserEvidence(page, {
          courseId: "partial-timeout-course",
          courseName: "Partial Timeout Golf Course",
          sourceUrl: officialPageUrl,
          officialCourseWebsite: officialPageUrl,
        }),
      );

      expect(evidence.browserInvestigation.sameOriginPages).toHaveLength(1);
      expect(evidence.browserInvestigation.sameOriginPages[0]?.finalUrl).toBe(
        officialPageUrl,
      );
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  it("allows only read-only HTTP methods", () => {
    expect(isReadOnlyBrowserRequestMethod("GET")).toBe(true);
    expect(isReadOnlyBrowserRequestMethod("head")).toBe(true);
    expect(isReadOnlyBrowserRequestMethod("OPTIONS")).toBe(true);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "CONNECT"]) {
      expect(isReadOnlyBrowserRequestMethod(method)).toBe(false);
    }
  });

  it.each([
    "https://www.google.co.uk/search?q=target+golf+course",
    "https://uk.search.yahoo.com/search?p=target+golf+course",
    "https://maps.google.ca/?q=target+golf+course",
  ])("does not navigate a regional search-result surface as course evidence", (url) => {
    expect(
      isSafeRenderedBrowserInteractionDestination(
        url,
        "https://target-course.example/",
      ),
    ).toBe(false);
  });

  it("aborts every non-read request before the destination handler receives it", async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const officialPageUrl = "https://method-safe-course.example/";
      const attemptedMethods: string[] = [];
      const servedMutationMethods: string[] = [];
      vi.spyOn(page.request, "get").mockResolvedValue({
        ok: () => false,
      } as APIResponse);
      page.on("request", (request) => {
        if (new URL(request.url()).pathname === "/mutation") {
          attemptedMethods.push(request.method());
        }
      });
      await context.route("https://method-safe-course.example/**", async (route) => {
        const request = route.request();
        if (new URL(request.url()).pathname === "/mutation") {
          servedMutationMethods.push(request.method());
          await route.fulfill({ status: 204, body: "" });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<html><title>Method Safe Golf Course</title><body><h1>Method Safe Golf Course</h1><script>for (const method of ["POST", "PUT", "PATCH", "DELETE"]) fetch("/mutation", { method, body: "must-not-leave" }).catch(() => undefined);</script></body></html>`,
        });
      });

      const evidence = await collectBrowserEvidence(page, {
        courseId: "method-safe-course",
        courseName: "Method Safe Golf Course",
        sourceUrl: officialPageUrl,
        officialCourseWebsite: officialPageUrl,
      });

      expect(new Set(attemptedMethods)).toEqual(
        new Set(["POST", "PUT", "PATCH", "DELETE"]),
      );
      expect(servedMutationMethods).toEqual([]);
      expect(
        evidence.browserInvestigation.sameOriginPages[0]?.interactionBlocked,
      ).toBe(true);
      expect(evidence.browserInvestigation.restrictedNetworkObserved).toBe(
        true,
      );
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);
  it("treats account destinations as evidence-only interaction boundaries", () => {
    const officialPageUrl = "https://official-course.example/";

    expect(
      isSafeRenderedBrowserInteractionDestination(
        "https://booking-provider.example/book/tee-times?course=123",
        officialPageUrl,
      ),
    ).toBe(true);
    expect(
      isSafeRenderedBrowserInteractionDestination(
        "https://booking-provider.example/sign-in",
        officialPageUrl,
      ),
    ).toBe(false);
    expect(
      isSafeRenderedBrowserInteractionDestination(
        "https://booking-provider.example/account/login?returnUrl=%2Ftee-times",
        officialPageUrl,
      ),
    ).toBe(false);
  });

  it("does not interact with or navigate beyond a booking redirect to sign-in", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const officialPageUrl = "https://official-course.example/";
      const safeBookingUrl = "https://booking-provider.example/book";
      const signInUrl = "https://booking-provider.example/sign-in";
      const staticPageRequests: Array<{
        url: string;
        maxRedirects: number | undefined;
      }> = [];
      const navigationAttempts: string[] = [];
      let dateInteractionServed = false;
      let signInResponseServed = false;

      vi.spyOn(page.request, "get").mockImplementation(async (url, options) => {
        staticPageRequests.push({
          url: url.toString(),
          maxRedirects: options?.maxRedirects,
        });
        return { ok: () => false } as APIResponse;
      });
      page.on("request", (request) => {
        if (
          request.isNavigationRequest() &&
          request.frame() === page.mainFrame()
        ) {
          navigationAttempts.push(request.url());
        }
      });
      await page.route("https://official-course.example/**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<html><head><title>Official Course Golf Club</title></head><body><h1>Official Course Golf Club</h1><a href="${safeBookingUrl}">Book Official Course Tee Times</a></body></html>`,
        });
      });
      await page.route("https://booking-provider.example/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/book") {
          await route.fulfill({
            status: 302,
            headers: { location: signInUrl },
            body: "",
          });
          return;
        }
        if (url.pathname === "/sign-in") {
          signInResponseServed = true;
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: `<html><head><title>Sign in</title></head><body><h1>Sign in to view tee times</h1><input type="date" id="tee-date"><script>document.querySelector('#tee-date').addEventListener('input', () => fetch('/date-interaction', { method: 'POST' }));</script></body></html>`,
          });
          return;
        }
        if (url.pathname === "/date-interaction") {
          dateInteractionServed = true;
          await route.fulfill({ status: 204, body: "" });
          return;
        }
        await route.abort();
      });

      const evidence = await collectBrowserEvidence(page, {
        courseId: "official-course",
        courseName: "Official Course Golf Club",
        sourceUrl: officialPageUrl,
        officialCourseWebsite: officialPageUrl,
      });

      expect(evidence.finalUrl).not.toBe(signInUrl);
      expect(page.url()).not.toBe(signInUrl);
      expect(signInResponseServed).toBe(false);
      expect(dateInteractionServed).toBe(false);
      expect(staticPageRequests).not.toContainEqual(
        expect.objectContaining({ url: signInUrl }),
      );
      expect(staticPageRequests).toEqual(
        expect.arrayContaining([expect.objectContaining({ maxRedirects: 0 })]),
      );
      expect(navigationAttempts).toContain(signInUrl);
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("aborts account URLs in iframes, subresources, and fetch requests", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ serviceWorkers: "block" });
      const officialPageUrl = "https://official-course.example/";
      const restrictedUrls = [
        "https://booking-provider.example/account/login",
        "https://booking-provider.example/member/login/avatar.png",
        "https://booking-provider.example/sign-in",
        "https://booking-provider.example/account/main-login",
      ];
      const safeBookingUrl = "https://booking-provider.example/book";
      const attemptedRestrictedRequests: string[] = [];
      const servedRestrictedRequests: string[] = [];

      vi.spyOn(page.request, "get").mockResolvedValue({
        ok: () => false,
      } as APIResponse);
      page.on("request", (request) => {
        if (restrictedUrls.includes(request.url())) {
          attemptedRestrictedRequests.push(request.url());
        }
      });
      await page.route("https://official-course.example/**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<html><head><title>Official Course Golf Club</title></head><body><h1>Official Course Golf Club</h1><a href="${safeBookingUrl}">Book Official Course Tee Times</a><iframe src="${restrictedUrls[0]}"></iframe><img src="${restrictedUrls[1]}"><script>fetch("${restrictedUrls[2]}").catch(() => undefined);</script></body></html>`,
        });
      });
      await page.route("https://booking-provider.example/**", async (route) => {
        if (route.request().url() === safeBookingUrl) {
          await route.fulfill({
            status: 302,
            headers: { location: restrictedUrls[3] },
            body: "",
          });
          return;
        }
        servedRestrictedRequests.push(route.request().url());
        await route.fulfill({ status: 200, body: "must not be served" });
      });

      const evidence = await collectBrowserEvidence(page, {
        courseId: "official-course-subresources",
        courseName: "Official Course Golf Club",
        sourceUrl: officialPageUrl,
        officialCourseWebsite: officialPageUrl,
      });

      expect(evidence.finalUrl).toBe(officialPageUrl);
      expect(servedRestrictedRequests).toEqual([]);
      expect(attemptedRestrictedRequests).toEqual(
        expect.arrayContaining(restrictedUrls),
      );
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("retains a coarse restricted-network signal from an unknown official root with an auth iframe", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ serviceWorkers: "block" });
      const officialPageUrl =
        "https://neutral-golf.example/course-information";
      const authFrameUrl = "https://booking-provider.example/signin";
      const attemptedAuthRequests: string[] = [];
      let authFrameServed = false;

      vi.spyOn(page.request, "get").mockResolvedValue({
        ok: () => false,
      } as APIResponse);
      page.on("request", (request) => {
        if (request.url() === authFrameUrl) {
          attemptedAuthRequests.push(request.url());
        }
      });
      await page.route(officialPageUrl, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<html><head><title>Welcome</title></head><body><p>Public golf information.</p><iframe src="${authFrameUrl}"></iframe></body></html>`,
        });
      });
      await page.route(authFrameUrl, async (route) => {
        authFrameServed = true;
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "must not be served",
        });
      });

      const evidence = await collectBrowserEvidence(page, {
        courseId: "unknown-identity-course",
        courseName: "Target Course Golf Club",
        sourceUrl: officialPageUrl,
        officialCourseWebsite: officialPageUrl,
      });

      expect(evidence.browserInvestigation).toMatchObject({
        restrictedNetworkObserved: true,
        sameOriginPages: [
          expect.objectContaining({
            identityStatus: "UNKNOWN",
            trustedForCourse: false,
          }),
        ],
      });
      expect(attemptedAuthRequests).toContain(authFrameUrl);
      expect(authFrameServed).toBe(false);
      expect(
        JSON.stringify(evidence.browserInvestigation.networkContracts),
      ).not.toContain("signin");
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("does not follow a static-page fetch redirect to an account destination", async () => {
    const officialPageUrl = "https://official-course.example/";
    const accountUrl = "https://booking-provider.example/sign-in";
    const get = vi.fn().mockResolvedValue({
      ok: () => false,
      status: () => 302,
      headers: () => ({ location: accountUrl }),
    } as APIResponse);
    const page = {
      url: () => officialPageUrl,
      request: { get },
    } as unknown as Page;

    await expect(
      collectStaticPageFrameCandidates(page, officialPageUrl),
    ).resolves.toEqual([]);

    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(officialPageUrl, {
      timeout: 20_000,
      maxRedirects: 0,
    });
    expect(get).not.toHaveBeenCalledWith(accountUrl, expect.anything());
  }, 30_000);

  it("does not self-attest a rendered sibling page as the target course", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ serviceWorkers: "block" });
      const siblingPageUrl = "https://official-course.example/sibling-course";
      const siblingBookingUrl =
        "https://shared-courses.book.teeitup.com/?course=999";
      const accountRedirectUrl =
        "https://shared-courses.book.teeitup.com/account/login";
      let accountRedirectServed = false;

      vi.spyOn(page.request, "get").mockResolvedValue({
        ok: () => false,
      } as APIResponse);
      await page.route(siblingPageUrl, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<html><head><title>Sibling Course Golf Club</title></head><body><nav>Target Course Golf Club</nav><h1>Sibling Course Golf Club</h1><a href="${siblingBookingUrl}">Book a tee time</a></body></html>`,
        });
      });
      await page.route(siblingBookingUrl, async (route) => {
        await route.fulfill({
          status: 302,
          headers: { location: accountRedirectUrl },
          body: "",
        });
      });
      await page.route(accountRedirectUrl, async (route) => {
        accountRedirectServed = true;
        await route.fulfill({ status: 200, body: "must not be served" });
      });

      const evidence = await collectBrowserEvidence(page, {
        courseId: "target-course",
        courseName: "Target Course Golf Club",
        sourceUrl: siblingPageUrl,
        officialCourseWebsite: siblingPageUrl,
      });
      const discovery = buildBrowserDiscovery(evidence);

      expect(accountRedirectServed).toBe(false);
      expect(evidence.officialPage?.courseName).toBeUndefined();
      expect(discovery).toMatchObject({
        status: "INSPECTED",
        detectedPlatform: "TEEITUP",
        evidence: { learnedFrom: "teeitup-target-scope-unconfirmed" },
      });
      expect(discovery.apiMetadata).toBeUndefined();
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("bounds breadth-first official investigation to 12 attempts at depth two and three booking destinations", async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const officialPageUrl = "https://bounded-course.example/";
      const officialNavigationUrls: string[] = [];
      const bookingNavigationUrls: string[] = [];
      vi.spyOn(page.request, "get").mockResolvedValue({
        ok: () => false,
      } as APIResponse);
      context.on("request", (request) => {
        if (!request.isNavigationRequest()) {
          return;
        }
        if (request.url().startsWith("https://bounded-course.example/")) {
          officialNavigationUrls.push(request.url());
        }
        if (/^https:\/\/booking-\d+\.example\//u.test(request.url())) {
          bookingNavigationUrls.push(request.url());
        }
      });
      await context.route(
        "https://bounded-course.example/**",
        async (route) => {
          const pathname = new URL(route.request().url()).pathname;
          const depthTwoLinks = Array.from(
            { length: 10 },
            (_, index) =>
              `<a href="${pathname}rates-${index}">Golf rates ${index}</a>`,
          ).join("");
          const rootLinks = [
            `<a href="/section-1/">Golf information one</a>`,
            `<a href="/section-2/">Golf information two</a>`,
            ...Array.from(
              { length: 5 },
              (_, index) =>
                `<a href="https://booking-${index}.example/tee-times">Book Bounded Course Golf Club tee times</a>`,
            ),
          ].join("");
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: `<html><title>Bounded Course Golf Club</title><body><h1>Bounded Course Golf Club</h1>${pathname === "/" ? rootLinks : depthTwoLinks}</body></html>`,
          });
        },
      );
      await context.route(
        /^https:\/\/booking-\d+\.example\//u,
        async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: "<html><title>Public tee times</title><body>Public tee times</body></html>",
          });
        },
      );

      const evidence = await collectBrowserEvidence(page, {
        courseId: "bounded-course",
        courseName: "Bounded Course Golf Club",
        sourceUrl: officialPageUrl,
        officialCourseWebsite: officialPageUrl,
      });

      expect(officialNavigationUrls).toHaveLength(12);
      expect(evidence.browserInvestigation.sameOriginPages).toHaveLength(12);
      expect(
        Math.max(
          ...evidence.browserInvestigation.sameOriginPages.map(
            ({ depth }) => depth,
          ),
        ),
      ).toBe(2);
      expect(new Set(bookingNavigationUrls)).toHaveLength(3);
      expect(evidence.browserInvestigation.bookingDestinations).toHaveLength(3);
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  it("stops after three neutral links redirect to booking destinations", async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const officialPageUrl = "https://redirect-cap-course.example/";
      const neutralNavigationUrls: string[] = [];
      const bookingLandingUrls: string[] = [];
      vi.spyOn(page.request, "get").mockResolvedValue({
        ok: () => false,
      } as APIResponse);
      context.on("request", (request) => {
        if (
          request.isNavigationRequest() &&
          /\/golf\/rates-\d+$/u.test(new URL(request.url()).pathname)
        ) {
          neutralNavigationUrls.push(request.url());
        }
        if (
          request.isNavigationRequest() &&
          /\/tee-times-\d+$/u.test(new URL(request.url()).pathname)
        ) {
          bookingLandingUrls.push(request.url());
        }
      });
      await context.route("https://redirect-cap-course.example/**", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === "/") {
          const links = Array.from(
            { length: 20 },
            (_, index) =>
              `<a href="/golf/rates-${index}">Golf rates ${index}</a>`,
          ).join("");
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: `<html><title>Redirect Cap Golf Course</title><body><h1>Redirect Cap Golf Course</h1>${links}</body></html>`,
          });
          return;
        }
        const neutralMatch = /^\/golf\/rates-(\d+)$/u.exec(pathname);
        if (neutralMatch) {
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: `<html><title>Redirect Cap Golf Course rates</title><body><h1>Redirect Cap Golf Course rates</h1><script src="/redirect-app.js?index=${neutralMatch[1]}"></script></body></html>`,
          });
          return;
        }
        if (pathname === "/api/availability") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: "{}",
          });
          return;
        }
        if (pathname === "/redirect-app.js") {
          const index = new URL(route.request().url()).searchParams.get("index");
          await route.fulfill({
            status: 200,
            contentType: "application/javascript",
            body: `fetch('/api/availability?authToken=private-canary').finally(() => { location.href = '/tee-times-${index}' })`
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<html><title>Redirect Cap Golf Course tee times</title><body><h1>Redirect Cap Golf Course tee times</h1></body></html>",
        });
      });

      const evidence = await collectBrowserEvidence(page, {
        courseId: "redirect-cap-course",
        courseName: "Redirect Cap Golf Course",
        sourceUrl: officialPageUrl,
        officialCourseWebsite: officialPageUrl,
      });

      // Redirects cannot bypass the shared three-destination navigation cap.
      // Each neutral request still counts toward the separate same-origin cap.
      expect(neutralNavigationUrls).toHaveLength(3);
      expect(bookingLandingUrls).toHaveLength(3);
      expect(evidence.browserInvestigation.bookingDestinations).toHaveLength(3);
      expect(evidence.browserInvestigation.restrictedNetworkObserved).toBe(true);
      expect(
        JSON.stringify(evidence.browserInvestigation.networkContracts),
      ).not.toContain("private-canary");
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  it("shares one three-visit budget across same-origin and external booking destinations", async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const officialPageUrl = "https://shared-cap-course.example/";
      const bookingNavigations: string[] = [];
      vi.spyOn(page.request, "get").mockResolvedValue({
        ok: () => false,
      } as APIResponse);
      context.on("request", (request) => {
        if (
          request.isNavigationRequest() &&
          (/\/book\/tee-times-/u.test(request.url()) ||
            /^https:\/\/external-booking-\d+\.example\//u.test(request.url()))
        ) {
          bookingNavigations.push(request.url());
        }
      });
      await context.route("https://shared-cap-course.example/**", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body:
            pathname === "/"
              ? `<html><title>Shared Cap Golf Course</title><body><h1>Shared Cap Golf Course</h1>
                 <a href="/golf/rates">Golf rates</a>
                 <a href="/book/tee-times-1">View tee times one</a>
                 <a href="https://external-booking-1.example/tee-times">View tee times two</a>
                 <a href="/book/tee-times-2">View tee times three</a>
                 <a href="https://external-booking-2.example/tee-times">View tee times four</a>
                 <a href="/book/tee-times-3">View tee times five</a>
                 </body></html>`
              : `<html><title>Shared Cap Golf Course</title><body><h1>Shared Cap Golf Course</h1>Public tee times</body></html>`,
        });
      });
      await context.route(/^https:\/\/external-booking-\d+\.example\//u, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<html><title>Public tee times</title><body>Public tee times</body></html>",
        });
      });

      const evidence = await collectBrowserEvidence(page, {
        courseId: "shared-cap-course",
        courseName: "Shared Cap Golf Course",
        sourceUrl: officialPageUrl,
        officialCourseWebsite: officialPageUrl,
      });

      expect(new Set(bookingNavigations)).toHaveLength(3);
      expect(evidence.browserInvestigation.bookingDestinations).toHaveLength(3);
      expect(
        evidence.browserInvestigation.bookingDestinations.some(({ finalUrl }) =>
          finalUrl.startsWith("https://shared-cap-course.example/"),
        ),
      ).toBe(true);
      expect(
        evidence.browserInvestigation.bookingDestinations.some(({ finalUrl }) =>
          finalUrl.startsWith("https://external-booking-1.example/"),
        ),
      ).toBe(true);
      expect(
        evidence.browserInvestigation.sameOriginPages.some(({ finalUrl }) =>
          /\/book\/tee-times-/u.test(finalUrl),
        ),
      ).toBe(false);
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  it("inspects safe CTA button URLs without submitting forms", async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const officialPageUrl = "https://button-course.example/";
      const safeButtonUrl =
        "https://button-course.example/book/tee-times?course=8675309&date=private-date-canary";
      const servedFormMethods: string[] = [];
      vi.spyOn(page.request, "get").mockResolvedValue({
        ok: () => false,
      } as APIResponse);
      await context.route("https://button-course.example/**", async (route) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (pathname === "/reserve") {
          servedFormMethods.push(request.method());
          await route.fulfill({ status: 204, body: "" });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body:
            pathname === "/"
              ? `<html><title>Button Golf Course</title><body><h1>Button Golf Course</h1><button type="button" data-url="${safeButtonUrl}">View Tee Times</button><form method="post" action="/reserve"><button type="submit" data-url="/reserve">Book Tee Times</button></form></body></html>`
              : "<html><title>Public tee times</title><body>Public tee times</body></html>",
        });
      });

      const evidence = await collectBrowserEvidence(page, {
        courseId: "button-course",
        courseName: "Button Golf Course",
        sourceUrl: officialPageUrl,
        officialCourseWebsite: officialPageUrl,
      });

      expect(servedFormMethods).toEqual([]);
      expect(evidence.browserInvestigation.bookingDestinations).toContainEqual(
        expect.objectContaining({
          requestedUrl:
            "https://button-course.example/book/tee-times?course=&date=",
        }),
      );
      expect(JSON.stringify(evidence.browserInvestigation)).not.toContain(
        "8675309",
      );
      expect(JSON.stringify(evidence.browserInvestigation)).not.toContain(
        "private-date-canary",
      );
      const persisted = retainOnlyPersistableBrowserUrls(
        {
          courseId: "button-course",
          status: "INSPECTED" as const,
          detectedPlatform: "UNKNOWN" as const,
          sourceUrl: officialPageUrl,
          bookingUrl: safeButtonUrl,
          confidence: 0.8,
          evidence: {
            finalUrl: safeButtonUrl,
            observedUrls: [safeButtonUrl],
            learnedFrom: "test-exact-booking-selector",
            courseIdentityCorroboration: {
              kind: "OFFICIAL_COURSE_PROVIDER_LINK" as const,
              officialWebsiteUrl: officialPageUrl,
              officialPageUrl: officialPageUrl,
              providerUrl: safeButtonUrl,
            },
            browserInvestigation: evidence.browserInvestigation,
          },
        },
        evidence,
      );
      expect(persisted.bookingUrl).toBe(safeButtonUrl);
      expect(persisted.evidence.finalUrl).toBe(
        "https://button-course.example/book/tee-times?course=&date=",
      );
      expect(persisted.evidence.courseIdentityCorroboration?.providerUrl).toBe(
        "https://button-course.example/book/tee-times?course=&date=",
      );
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  it("persists page evidence and sanitized contracts without raw network query values", async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const officialPageUrl = "https://privacy-course.example/";
      const availabilityUrl =
        "https://privacy-course.example/api/availability?course=8675309&date=private-date-canary";
      const credentialUrl =
        "https://analytics.example/collect?authToken=must-not-persist";
      vi.spyOn(page.request, "get").mockResolvedValue({
        ok: () => false,
      } as APIResponse);
      await context.route(
        "https://privacy-course.example/**",
        async (route) => {
          if (new URL(route.request().url()).pathname === "/api/availability") {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ secretPayload: "must-not-persist" }),
            });
            return;
          }
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: `<html><title>Privacy Course Golf Club</title><body><h1>Privacy Course Golf Club</h1><script>window.property = { "secretPayload": "widget-secret", "courseId": 8675309 }; fetch(${JSON.stringify(availabilityUrl)}); fetch(${JSON.stringify(credentialUrl)}).catch(() => undefined);</script></body></html>`,
          });
        },
      );

      const evidence = await collectBrowserEvidence(page, {
        courseId: "privacy-course",
        courseName: "Privacy Course Golf Club",
        sourceUrl: officialPageUrl,
        officialCourseWebsite: officialPageUrl,
      });
      const discovery = buildBrowserDiscovery(evidence);
      const persisted = retainOnlyPersistableBrowserUrls(
        {
          ...discovery,
          evidence: {
            ...discovery.evidence,
            browserInvestigation: evidence.browserInvestigation,
          },
        },
        evidence,
      );
      const persistedJson = JSON.stringify(persisted);
      const contractJson = JSON.stringify(
        evidence.browserInvestigation.networkContracts,
      );

      expect(evidence.observedUrls).toContain(availabilityUrl);
      expect(persisted.evidence.observedUrls).not.toContain(availabilityUrl);
      expect(persistedJson).not.toContain("8675309");
      expect(persistedJson).not.toContain("private-date-canary");
      expect(persistedJson).not.toContain("must-not-persist");
      expect(persistedJson).not.toContain("secretPayload");
      expect(persistedJson).not.toContain("widget-secret");
      expect(contractJson).toContain('"queryKeys":["course","date"]');
      expect(contractJson).not.toContain("8675309");
      expect(contractJson).not.toContain("private-date-canary");
      expect(contractJson).not.toContain("analytics.example");
      expect(
        persisted.evidence.browserInvestigation.restrictedNetworkObserved,
      ).toBe(true);
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  it("persists only the bounded marker for an HTTP 200 managed root and stops interaction", async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const officialPageUrl = "https://managed-root-course.example/";
      const navigationRequests: string[] = [];
      const staticPageGet = vi.spyOn(page.request, "get").mockResolvedValue({
        ok: () => false,
      } as APIResponse);
      context.on("request", (request) => {
        if (
          request.isNavigationRequest() &&
          request.frame() === page.mainFrame()
        ) {
          navigationRequests.push(request.url());
        }
      });
      await context.route(
        "https://managed-root-course.example/**",
        async (route) => {
          const pathname = new URL(route.request().url()).pathname;
          if (pathname === "/after-marker") {
            await route.fulfill({
              status: 200,
              contentType: "text/html",
              body: "<html><body>must-not-visit-after-marker</body></html>",
            });
            return;
          }
          if (pathname === "/date-interaction") {
            await route.fulfill({ status: 204, body: "" });
            return;
          }
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: managedProtectionHtml(
              "positive-root-secret",
              '<a href="/after-marker">Book tee times</a><input type="date" oninput="fetch(\'/date-interaction\', {method: \'POST\'})">',
            ),
          });
        },
      );

      const evidence = await collectBrowserEvidence(page, {
        courseId: "managed-root-course",
        courseName: "Managed Root Golf Course",
        sourceUrl: officialPageUrl,
        officialCourseWebsite: officialPageUrl,
      });
      const discovery = buildBrowserDiscovery(evidence);
      const persistenceInput = {
        ...discovery,
        evidence: {
          ...discovery.evidence,
          renderedAccessControls:
            discovery.evidence.renderedAccessControls?.map((control) => ({
              ...control,
            })),
          browserInvestigation: evidence.browserInvestigation,
        },
      } as Parameters<typeof retainOnlyPersistableBrowserUrls>[0];
      Object.assign(persistenceInput.evidence.renderedAccessControls?.[0] ?? {}, {
        runtimeCanary: "must-not-persist-runtime-extra",
      });
      const persisted = retainOnlyPersistableBrowserUrls(
        persistenceInput,
        evidence,
      );
      const serialized = JSON.stringify({ evidence, persisted });

      expect(evidence.renderedAccessControls).toEqual([
        {
          kind: "MANAGED_PROTECTION_DOCUMENT",
          scope: "RETAINED_ROOT",
          url: officialPageUrl,
        },
      ]);
      expect(evidence.linkCandidates).toEqual([]);
      expect(evidence.visibleText).toBe("");
      expect(evidence.persistableVisibleText).toBe("");
      expect(discovery).toMatchObject({
        status: "BLOCKED",
        automationReason: "CAPTCHA_OR_QUEUE",
        evidence: {
          learnedFrom: "rendered-managed-protection-document",
        },
      });
      expect(persisted.evidence.renderedAccessControls).toEqual(
        evidence.renderedAccessControls,
      );
      expect(staticPageGet).not.toHaveBeenCalled();
      expect(navigationRequests).toEqual([officialPageUrl]);
      expect(serialized).not.toContain("positive-root-secret");
      expect(serialized).not.toContain("Access Denied");
      expect(serialized).not.toContain("Reference #");
      expect(serialized).not.toContain("errors.edgesuite.net");
      expect(serialized).not.toContain("must-not-persist-runtime-extra");
      expect(serialized).not.toContain("must-not-visit-after-marker");
      expect(serialized).not.toContain("date-interaction");
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  it("prefers a managed retained booking target when both retained targets are protected", async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const officialPageUrl = "https://retained-target-course.example/";
      const retainedBookingUrl =
        "https://retained-booking.example/tee-times?course=raw-course-id#calendar";
      const navigationRequests: string[] = [];
      const staticPageGet = vi.spyOn(page.request, "get").mockResolvedValue({
        ok: () => false,
      } as APIResponse);
      context.on("request", (request) => {
        if (request.isNavigationRequest()) {
          navigationRequests.push(request.url());
        }
      });
      await context.route(
        "https://retained-target-course.example/**",
        async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: managedProtectionHtml("retained-root-secret"),
          });
        },
      );
      await context.route(
        "https://retained-booking.example/**",
        async (route) => {
          const pathname = new URL(route.request().url()).pathname;
          if (pathname === "/after-marker") {
            await route.fulfill({
              status: 200,
              contentType: "text/html",
              body: "<html><body>must-not-visit-retained-marker-link</body></html>",
            });
            return;
          }
          if (pathname === "/date-interaction") {
            await route.fulfill({ status: 204, body: "" });
            return;
          }
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: managedProtectionHtml(
              "retained-booking-secret",
              '<a href="/after-marker">Book another time</a><input type="date" oninput="fetch(\'/date-interaction\', {method: \'POST\'})">',
            ),
          });
        },
      );

      const evidence = await collectBrowserEvidence(
        page,
        {
          courseId: "retained-target-course",
          courseName: "Retained Target Golf Course",
          sourceUrl: officialPageUrl,
          officialCourseWebsite: officialPageUrl,
        },
        { retainedBookingUrl },
      );
      const discovery = buildBrowserDiscovery(evidence);
      const persisted = retainOnlyPersistableBrowserUrls(
        {
          ...discovery,
          evidence: {
            ...discovery.evidence,
            browserInvestigation: evidence.browserInvestigation,
          },
        },
        evidence,
      );
      const serialized = JSON.stringify({ evidence, persisted });
      const persistedEvidenceJson = JSON.stringify(persisted.evidence);

      expect(evidence.linkCandidates).toEqual([]);
      expect(evidence.retainedBookingTarget).toEqual({
        kind: "RETAINED_COURSE_BOOKING_TARGET",
        url: retainedBookingUrl,
      });
      expect(evidence.renderedAccessControls).toEqual([
        {
          kind: "MANAGED_PROTECTION_DOCUMENT",
          scope: "RETAINED_ROOT",
          url: officialPageUrl,
        },
        {
          kind: "MANAGED_PROTECTION_DOCUMENT",
          scope: "COURSE_SCOPED_BOOKING",
          url: "https://retained-booking.example/tee-times",
        },
      ]);
      expect(discovery).toMatchObject({
        status: "BLOCKED",
        bookingUrl: retainedBookingUrl,
        bookingMethod: "PUBLIC_ONLINE",
        automationReason: "CAPTCHA_OR_QUEUE",
        evidence: {
          renderedAccessControls: [
            {
              kind: "MANAGED_PROTECTION_DOCUMENT",
              scope: "COURSE_SCOPED_BOOKING",
              url: "https://retained-booking.example/tee-times",
            },
          ],
          learnedFrom: "rendered-managed-protection-document",
        },
      });
      expect(persisted.evidence.renderedAccessControls).toEqual([
        {
          kind: "MANAGED_PROTECTION_DOCUMENT",
          scope: "COURSE_SCOPED_BOOKING",
          url: "https://retained-booking.example/tee-times",
        },
      ]);
      expect(persisted.bookingUrl).toBe(retainedBookingUrl);
      expect(staticPageGet).not.toHaveBeenCalled();
      expect(navigationRequests).not.toContain(
        "https://retained-booking.example/after-marker",
      );
      expect(
        JSON.stringify(evidence.renderedAccessControls),
      ).not.toContain("raw-course-id");
      expect(persistedEvidenceJson).not.toContain("raw-course-id");
      expect(persistedEvidenceJson).not.toContain("#calendar");
      expect(serialized).not.toContain("retained-root-secret");
      expect(serialized).not.toContain("retained-booking-secret");
      expect(serialized).not.toContain("Access Denied");
      expect(serialized).not.toContain("Reference #");
      expect(serialized).not.toContain("errors.edgesuite.net");
      expect(serialized).not.toContain("date-interaction");
      expect(serialized).not.toContain("must-not-visit-retained-marker-link");
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  it("rejects prose and non-main-document managed-protection lookalikes", async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const staticPageGet = vi.spyOn(page.request, "get").mockResolvedValue({
        ok: () => false,
      } as APIResponse);
      await context.route(
        "https://managed-negative-course.example/**",
        async (route) => {
          const pathname = new URL(route.request().url()).pathname;
          if (pathname === "/xhr-denial") {
            await route.fulfill({
              status: 200,
              contentType: "text/plain",
              body: managedProtectionHtml("xhr-secret"),
            });
            return;
          }
          if (pathname === "/frame-denial") {
            await route.fulfill({
              status: 200,
              contentType: "text/html",
              body: managedProtectionHtml("frame-secret"),
            });
            return;
          }
          if (pathname === "/denial.js") {
            await route.fulfill({
              status: 200,
              contentType: "application/javascript",
              body: "/* Access Denied. Reference #18.asset-secret. https://errors.edgesuite.net/18.asset-secret */",
            });
            return;
          }
          if (pathname === "/prose") {
            await route.fulfill({
              status: 200,
              contentType: "text/html",
              body: managedProtectionHtml("prose-secret").replace(
                "<title>Access Denied</title>",
                "<title>The Challenge</title>",
              ),
            });
            return;
          }
          if (pathname === "/title-only") {
            await route.fulfill({
              status: 200,
              contentType: "text/html",
              body: "<html><head><title>Access Denied</title></head><body><p>Course access information.</p></body></html>",
            });
            return;
          }
          if (pathname === "/iframe") {
            await route.fulfill({
              status: 200,
              contentType: "text/html",
              body: '<html><head><title>Managed Negative Golf Course</title></head><body><h1>Managed Negative Golf Course</h1><iframe src="/frame-denial"></iframe></body></html>',
            });
            return;
          }
          if (pathname === "/xhr") {
            await route.fulfill({
              status: 200,
              contentType: "text/html",
              body: '<html><head><title>Managed Negative Golf Course</title></head><body><h1>Managed Negative Golf Course</h1><script>fetch("/xhr-denial")</script></body></html>',
            });
            return;
          }
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: '<html><head><title>Managed Negative Golf Course</title></head><body><h1>Managed Negative Golf Course</h1><script src="/denial.js"></script></body></html>',
          });
        },
      );

      for (const pathname of [
        "/prose",
        "/title-only",
        "/iframe",
        "/xhr",
        "/asset",
      ]) {
        const sourceUrl = `https://managed-negative-course.example${pathname}`;
        const evidence = await collectBrowserEvidence(page, {
          courseId: "managed-negative-course",
          courseName: "Managed Negative Golf Course",
          sourceUrl,
          officialCourseWebsite: sourceUrl,
        });
        const discovery = buildBrowserDiscovery(evidence);

        expect(evidence.renderedAccessControls).toBeUndefined();
        expect(discovery.evidence.learnedFrom).not.toBe(
          "rendered-managed-protection-document",
        );
        expect(discovery.automationReason).not.toBe("CAPTCHA_OR_QUEUE");
      }
      expect(staticPageGet).toHaveBeenCalled();
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  it("keeps an HTTP 403 managed response on the existing access-barrier path", async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const sourceUrl =
        "https://managed-course.ezlinksgolf.com/index.html#/search";
      const scriptCanaryUrl =
        "https://managed-course.ezlinksgolf.com/raw-script-canary.js?reference=must-not-persist-subresource-403";
      let scriptCanaryServed = false;
      const staticPageGet = vi.spyOn(page.request, "get").mockResolvedValue({
        ok: () => false,
      } as APIResponse);
      await context.route(
        "https://managed-course.ezlinksgolf.com/**",
        async (route) => {
          if (new URL(route.request().url()).pathname === "/raw-script-canary.js") {
            scriptCanaryServed = true;
            await route.fulfill({
              status: 403,
              contentType: "application/javascript",
              body: "window.rawSubresourceCanary = 'must-not-persist-subresource-body';",
            });
            return;
          }
          await route.fulfill({
            status: 403,
            contentType: "text/html",
            body: managedProtectionHtml(
              "existing-403-secret",
              `<a href="https://errors.edgesuite.net/raw-link-canary">raw-link-canary</a><script>window.property = {"rawProviderCanary":"must-not-persist-403"};</script><script src="${scriptCanaryUrl}"></script>`,
            ),
          });
        },
      );

      const evidence = await collectBrowserEvidence(page, {
        courseId: "managed-course",
        courseName: "Managed Course Golf Club",
        sourceUrl,
        officialCourseWebsite: null,
      });
      const accessBarrier = evidence.accessBarriers[0];
      const discovery = buildBrowserDiscovery({
        ...evidence,
        linkCandidates: [{ url: sourceUrl, label: "Book tee times" }],
        corroboratedAccessBarrier: accessBarrier,
      });
      const persisted = retainOnlyPersistableBrowserUrls(
        {
          ...discovery,
          evidence: {
            ...discovery.evidence,
            browserInvestigation: evidence.browserInvestigation,
          },
        },
        evidence,
      );
      const serialized = JSON.stringify({ evidence, persisted });

      expect(evidence.renderedAccessControls).toBeUndefined();
      expect(scriptCanaryServed).toBe(true);
      expect(evidence.linkCandidates).toEqual([]);
      expect(evidence.visibleText).toBe("");
      expect(evidence.persistableVisibleText).toBe("");
      expect(evidence.browserInvestigation.networkContracts).toEqual([]);
      expect(accessBarrier).toEqual({
        url: "https://managed-course.ezlinksgolf.com/index.html",
        status: 403,
      });
      expect(evidence.accessBarriers).toEqual([accessBarrier]);
      expect(discovery).toMatchObject({
        status: "BLOCKED",
        automationReason: "CAPTCHA_OR_QUEUE",
        evidence: {
          learnedFrom: "known-provider-public-landing-access-barrier",
        },
      });
      expect(persisted.evidence.renderedAccessControls).toBeUndefined();
      expect(persisted.evidence.visibleText).toBeUndefined();
      expect(serialized).not.toContain("existing-403-secret");
      expect(serialized).not.toContain("Access Denied");
      expect(serialized).not.toContain("Reference #");
      expect(serialized).not.toContain("errors.edgesuite.net");
      expect(serialized).not.toContain("raw-link-canary");
      expect(serialized).not.toContain("must-not-persist-403");
      expect(serialized).not.toContain("raw-script-canary");
      expect(serialized).not.toContain("must-not-persist-subresource-403");
      expect(serialized).not.toContain("must-not-persist-subresource-body");
      expect(staticPageGet).not.toHaveBeenCalled();
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  it("does not wait for a missing date input on an ordinary official page", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ serviceWorkers: "block" });
      const officialPageUrl =
        "https://official-course.example/ordinary-golf-course";
      vi.spyOn(page.request, "get").mockResolvedValue({
        ok: () => false,
      } as APIResponse);
      await page.route(officialPageUrl, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<html><title>Ordinary Golf Course</title><body><h1>Ordinary Golf Course</h1><p>Tee-time information is coming soon.</p></body></html>",
        });
      });

      const evidence = await collectBrowserEvidence(page, {
        courseId: "ordinary-golf-course",
        courseName: "Ordinary Golf Course",
        sourceUrl: officialPageUrl,
        officialCourseWebsite: officialPageUrl,
      });

      expect(evidence.officialPage?.courseName).toBe("Ordinary Golf Course");
    } finally {
      await browser.close();
    }
  }, 8_000);

  it("does not trust a known-provider owner source candidate for the wrong course", async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const sourceUrl =
        "https://foreupsoftware.com/index.php/booking/22687/11624";
      vi.spyOn(page.request, "get").mockResolvedValue({
        ok: () => false,
      } as APIResponse);
      await context.route("https://foreupsoftware.com/**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<html><title>Wrong Golf Club</title><body><h1>Wrong Golf Club</h1><p>900 Other Road, Elsewhere, CA</p></body></html>",
        });
      });

      const evidence = await collectBrowserEvidence(
        page,
        {
          courseId: "target-golf-club",
          courseName: "Target Golf Club",
          address: "100 Main Street",
          city: "Targetville",
          stateCode: "MA",
          sourceUrl,
          officialCourseWebsite: null,
        },
        { unprojectedSourceCandidate: true },
      );
      const discovery = buildBrowserDiscovery(evidence);

      expect(evidence.browserInvestigation.sameOriginPages).toEqual([
        expect.objectContaining({
          identityStatus: "CONFLICT",
          localityCorroborated: false,
          trustedForCourse: false,
        }),
      ]);
      expect(evidence.browserInvestigation.identityAuthority.source).toBe(
        "UNPROJECTED_OWNER_SOURCE_CANDIDATE",
      );
      expect(evidence.browserInvestigation.bookingDestinations).toEqual([]);
      expect(evidence.browserInvestigation.networkContracts).toEqual([]);
      expect(discovery).toMatchObject({
        status: "INSPECTED",
        detectedPlatform: "UNKNOWN",
        confidence: 0,
        evidence: {
          learnedFrom: "unprojected-source-candidate-identity-unverified",
          observedUrls: [],
        },
      });
      expect(discovery).not.toHaveProperty("bookingUrl");
      expect(discovery).not.toHaveProperty("apiMetadata");
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);

  it("trusts a known-provider owner source candidate after exact identity and locality match", async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const sourceUrl =
        "https://foreupsoftware.com/index.php/booking/22687/11624";
      vi.spyOn(page.request, "get").mockResolvedValue({
        ok: () => false,
      } as APIResponse);
      await context.route("https://foreupsoftware.com/**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<html><title>Target Golf Club</title><body><h1>Target Golf Club</h1><p>100 Main Street, Targetville, MA</p></body></html>",
        });
      });

      const evidence = await collectBrowserEvidence(
        page,
        {
          courseId: "target-golf-club",
          courseName: "Target Golf Club",
          address: "100 Main Street",
          city: "Targetville",
          stateCode: "MA",
          sourceUrl,
          officialCourseWebsite: null,
        },
        { unprojectedSourceCandidate: true },
      );
      const discovery = buildBrowserDiscovery(evidence);

      expect(evidence.browserInvestigation.sameOriginPages).toEqual([
        expect.objectContaining({
          identityStatus: "MATCH",
          localityCorroborated: true,
          trustedForCourse: true,
        }),
      ]);
      expect(evidence.browserInvestigation.identityAuthority.source).toBe(
        "UNPROJECTED_OWNER_SOURCE_CANDIDATE",
      );
      expect(discovery).toMatchObject({
        status: "LEARNED",
        detectedPlatform: "FOREUP",
        apiMetadata: {
          scheduleId: 11624,
        },
      });
      expect(discovery.bookingUrl).toBe(`${sourceUrl}#/teetimes`);
    } finally {
      await context.close();
      await browser.close();
    }
  }, 30_000);
});
