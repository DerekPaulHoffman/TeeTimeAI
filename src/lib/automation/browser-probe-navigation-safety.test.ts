import { chromium, type APIResponse, type Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";

import {
  collectBrowserEvidence,
  collectStaticPageFrameCandidates,
  isSafeRenderedBrowserInteractionDestination,
} from "../../../scripts/automation/browser-probe-needed-adapters";
import { buildBrowserDiscovery } from "./browser-discovery";

describe("rendered browser navigation safety", () => {
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

  it(
    "does not interact with or navigate beyond a booking redirect to sign-in",
    async () => {
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
          expect.arrayContaining([
            expect.objectContaining({ maxRedirects: 0 }),
          ]),
        );
        expect(navigationAttempts).toContain(signInUrl);
      } finally {
        await browser.close();
      }
    },
    30_000,
  );

  it(
    "aborts account URLs in iframes, subresources, and fetch requests",
    async () => {
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
    },
    30_000,
  );

  it(
    "does not follow a static-page fetch redirect to an account destination",
    async () => {
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
      expect(get).not.toHaveBeenCalledWith(
        accountUrl,
        expect.anything(),
      );
    },
    30_000,
  );

  it(
    "does not self-attest a rendered sibling page as the target course",
    async () => {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ serviceWorkers: "block" });
        const siblingPageUrl =
          "https://official-course.example/sibling-course";
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
    },
    30_000,
  );

  it(
    "does not wait for a missing date input on an ordinary official page",
    async () => {
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

        expect(evidence.officialPage?.courseName).toBe(
          "Ordinary Golf Course",
        );
      } finally {
        await browser.close();
      }
    },
    8_000,
  );
});
