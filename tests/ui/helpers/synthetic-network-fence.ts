import type { Page, Request } from "@playwright/test";

// Public shell links observed on the local search page and the pinned smoke
// course fixtures. A route alone never grants product/API read authority.
const SEARCH_SHELL_PATHS = new Set([
  "/", "/search", "/how-it-works", "/guides", "/dashboard", "/methodology",
  "/locations/connecticut", "/guides/tee-time-cancellation-alerts",
  "/guides/public-golf-booking-windows", "/guides/tee-time-alerts-vs-auto-booking",
  "/about", "/contact", "/privacy", "/terms",
  "/courses/tashua-knolls-golf-course-trumbull-ct", "/courses/bethpage-black-course-farmingdale-ny"
]);

function isShellRscRead(request: Request, url: URL) {
  const headers = request.headers();
  // Next 16 production prefetches use a segment header instead of a router
  // state tree. The captured static shell waterfall reads its tree, head,
  // root, route prefixes and page; Next's segment-cache/cache.js constructs
  // those headers. Restrict the segments to this already pinned shell route.
  const segment = headers["next-router-segment-prefetch"];
  const routeSegments = url.pathname.split("/").filter(Boolean);
  const allowedSegments = new Set(["/_tree", "/_head", "/_index",
    `${url.pathname === "/" ? "" : url.pathname}/__PAGE__`,
    ...routeSegments.map((_, index) => `/${routeSegments.slice(0, index + 1).join("/")}`)]);
  const isObservedSegmentPrefetch = headers["next-router-prefetch"] === "1" &&
    allowedSegments.has(segment);
  const isNavigationRead = Boolean(headers["next-router-state-tree"]) && !segment;
  const queryKeys = [...url.searchParams.keys()];
  return request.method() === "GET" && request.postData() === null &&
    SEARCH_SHELL_PATHS.has(url.pathname) && headers.rsc === "1" &&
    !headers["next-action"] &&
    (isNavigationRead || isObservedSegmentPrefetch) &&
    queryKeys.length === 1 && queryKeys[0] === "_rsc" &&
    /^[a-zA-Z0-9_-]{1,64}$/.test(url.searchParams.get("_rsc") ?? "");
}

const TRANSPARENT_TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"
);

export async function installSyntheticNetworkFence(page: Page, origin: string) {
  const unexpected: string[] = [];
  const shellReads: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const resource = request.resourceType();
    const reject = async () => {
      // Record bounded route context without credentials, query values or bodies.
      unexpected.push(`${request.method()} ${resource} ${url.origin}${url.pathname}`);
      await route.abort("blockedbyclient");
    };
    if (url.origin !== origin) {
      // Leaflet rendering is an explicit offline image fixture; no provider I/O.
      if (request.method() === "GET" && resource === "image" &&
          /^https:\/\/[abc]\.tile\.openstreetmap\.org$/.test(url.origin) &&
          /^\/\d{1,2}\/\d{1,7}\/\d{1,7}\.png$/.test(url.pathname) && !url.search &&
          !url.username && !url.password) {
        await route.fulfill({ contentType: "image/png", body: TRANSPARENT_TILE });
        return;
      }
      await reject();
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      // Test-specific, method-bound fixtures registered after this fence win.
      // Anything they did not explicitly handle must never reach application I/O.
      await reject();
      return;
    }
    if (["xhr", "fetch"].includes(resource)) {
      if (isShellRscRead(request, url)) {
        shellReads.push(url.pathname);
        await route.continue();
      } else await reject();
      return;
    }
    if (request.method() !== "GET") { await reject(); return; }
    await route.continue(); // Same-origin document, script, style, font and image assets.
  });
  return { unexpected, shellReads };
}
