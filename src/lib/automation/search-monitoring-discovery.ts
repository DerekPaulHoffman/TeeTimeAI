import { lookup as dnsLookup } from "node:dns/promises";
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions
} from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

import {
  applyBrowserDiscoveryToCourse,
  listRecentCourseAutomationDiscoveries,
  recordBrowserDiscovery,
  retireLegacyPolicyOnlyCourseBlock,
  type ActiveAutomationSearch
} from "@/lib/automation/db-service";
import {
  buildBrowserDiscovery,
  enrichCpsDiscovery,
  enrichChronogolfDiscovery,
  enrichTeesnapDiscovery,
  findCorroboratingAccessBarrier,
  keepPolicyOnlyDiscoveryActionable,
  sanitizeBrowserDiscoveryAccessEvidence,
  shouldQueueBrowserProbe,
  type BrowserDiscovery,
  type BrowserDiscoveryEvidence
} from "@/lib/automation/browser-discovery";
import { resolveProviderCapability } from "@/lib/automation/provider-capabilities";
import { runProviderFamilyTasks } from "@/lib/automation/provider-concurrency";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import {
  haveCompatibleCourseNames,
  normalizeCourseIdentityName
} from "@/lib/places/course-identity";
import { prisma } from "@/lib/prisma";

const DISCOVERY_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DISCOVERY_RETRY_DELAY_MS = 30 * 60 * 1000;
const MAX_DISCOVERY_ATTEMPTS_PER_DAY = 2;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 4;
const MAX_BOOKING_LINK_FOLLOWUPS = 2;
const MAX_HTML_BYTES = 1_500_000;
const ADDRESS_PINNED_REDIRECT_LIMIT = 4;
const LEGACY_POLICY_RECONCILIATION_MARKER = "legacy-policy-reconciliation";

type ResolvedPublicAddress = {
  address: string;
  family: 4 | 6;
};

type PinnedPublicRequest = {
  url: URL;
  address: string;
  family: 4 | 6;
  method: "GET" | "HEAD";
  headers: Headers;
  signal?: AbortSignal;
};

type NodeRequest = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void
) => ClientRequest;

type AddressPinnedPublicFetchDependencies = {
  resolveAddresses?: (hostname: string) => Promise<ResolvedPublicAddress[]>;
  requestPinned?: (input: PinnedPublicRequest) => Promise<Response>;
  requestNode?: NodeRequest;
  timeoutMs?: number;
};

const nonPublicNetworkBlockLists = buildNonPublicNetworkBlockLists();

export function createAddressPinnedPublicFetch(
  dependencies: AddressPinnedPublicFetchDependencies = {}
): typeof fetch {
  const resolveAddresses = dependencies.resolveAddresses ?? resolvePublicAddresses;
  const requestPinned = dependencies.requestPinned ??
    ((input: PinnedPublicRequest) =>
      requestPinnedPublicUrl(input, dependencies.requestNode));
  const timeoutMs = Math.max(1, dependencies.timeoutMs ?? FETCH_TIMEOUT_MS);

  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const requestInput = input instanceof Request ? input : null;
    const method = (init?.method ?? requestInput?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      throw new Error("Official-site discovery supports only safe read requests");
    }
    if (init?.body || requestInput?.body) {
      throw new Error("Official-site discovery requests cannot include a body");
    }
    const headers = new Headers(requestInput?.headers);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    if (
      headers.has("authorization") ||
      headers.has("proxy-authorization") ||
      headers.has("cookie")
    ) {
      throw new Error("Official-site discovery requests cannot include credentials");
    }
    headers.delete("host");
    headers.set("accept-encoding", "identity");
    const redirectMode = init?.redirect ?? requestInput?.redirect ?? "follow";
    const callerSignal = init?.signal ?? requestInput?.signal ?? undefined;
    const deadlineSignal = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, deadlineSignal])
      : deadlineSignal;
    let currentUrl = parseSafePublicUrl(
      requestInput?.url ?? (input instanceof URL ? input.toString() : String(input))
    );

    for (
      let redirectCount = 0;
      redirectCount <= ADDRESS_PINNED_REDIRECT_LIMIT;
      redirectCount += 1
    ) {
      const addresses = await resolveAddressesWithSignal(
        currentUrl.hostname,
        resolveAddresses,
        signal
      );
      const target = selectPinnedPublicAddress(addresses);
      const response = await waitForSignal(
        requestPinned({
          url: currentUrl,
          address: target.address,
          family: target.family,
          method,
          headers,
          signal
        }),
        signal
      );
      setResponseUrl(response, currentUrl.toString(), redirectCount > 0);

      if (response.status < 300 || response.status >= 400) {
        return response;
      }
      if (redirectMode === "manual") {
        return response;
      }
      if (redirectMode === "error") {
        throw new Error("Official site returned a redirect");
      }
      const location = response.headers.get("location");
      if (!location || redirectCount === ADDRESS_PINNED_REDIRECT_LIMIT) {
        throw new Error("Official site returned an incomplete redirect");
      }
      currentUrl = parseSafePublicUrl(new URL(location, currentUrl).toString());
    }

    throw new Error("Official site exceeded the redirect limit");
  }) as typeof fetch;
}

const addressPinnedPublicFetch = createAddressPinnedPublicFetch();

async function resolvePublicAddresses(hostname: string) {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({
    address: answer.address,
    family: answer.family as 4 | 6
  }));
}

function resolveAddressesWithSignal(
  hostname: string,
  resolveAddresses: (hostname: string) => Promise<ResolvedPublicAddress[]>,
  signal?: AbortSignal
) {
  const resolution = resolveAddresses(hostname);
  if (!signal) {
    return resolution;
  }
  return waitForSignal(resolution, signal);
}

function waitForSignal<T>(operation: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) {
    return Promise.reject(getAbortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(getAbortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function getAbortReason(signal: AbortSignal) {
  return signal.reason ?? new DOMException(
    "Official-site discovery timed out",
    "AbortError"
  );
}

function selectPinnedPublicAddress(addresses: ResolvedPublicAddress[]) {
  if (
    addresses.length === 0 ||
    addresses.some(
      ({ address, family }) =>
        isIP(address) !== family ||
        address.includes("%") ||
        (family === 4
          ? nonPublicNetworkBlockLists.ipv4.check(address, "ipv4")
          : nonPublicNetworkBlockLists.ipv6.check(address, "ipv6"))
    )
  ) {
    throw new Error("Official site resolved to a non-public network address");
  }
  return [...addresses].sort(
    (left, right) =>
      left.family - right.family || left.address.localeCompare(right.address)
  )[0];
}

function buildNonPublicNetworkBlockLists() {
  const ipv4 = new BlockList();
  const ipv6 = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4]
  ] as const) {
    ipv4.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["::", 96],
    ["::ffff:0:0", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 32],
    ["2001:2::", 48],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8]
  ] as const) {
    ipv6.addSubnet(network, prefix, "ipv6");
  }
  return { ipv4, ipv6 };
}

function requestPinnedPublicUrl(input: PinnedPublicRequest, requestNode?: NodeRequest) {
  const request = requestNode ?? ((
    input.url.protocol === "https:" ? httpsRequest : httpRequest
  ) as NodeRequest);
  const lookup = createPinnedLookup(input.address, input.family);
  const headers = Object.fromEntries(input.headers.entries());

  return new Promise<Response>((resolve, reject) => {
    const clientRequest = request(
      input.url,
      {
        method: input.method,
        headers,
        lookup,
        family: input.family,
        agent: false,
        signal: input.signal,
        ...(input.url.protocol === "https:" && isIP(input.url.hostname) === 0
          ? { servername: input.url.hostname }
          : {})
      },
      (incoming) => {
        const contentLength = Number(incoming.headers["content-length"] ?? 0);
        if (contentLength > MAX_HTML_BYTES) {
          incoming.destroy();
          reject(new Error("Official site page is too large to inspect safely"));
          return;
        }
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        incoming.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.length;
          if (totalBytes > MAX_HTML_BYTES) {
            incoming.destroy(
              new Error("Official site page is too large to inspect safely")
            );
            return;
          }
          chunks.push(buffer);
        });
        incoming.on("error", reject);
        incoming.on("end", () => {
          const status = incoming.statusCode;
          if (typeof status !== "number" || status < 200 || status > 599) {
            reject(new Error("Official site returned an invalid HTTP status"));
            return;
          }
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) {
              value.forEach((item) => responseHeaders.append(key, item));
            } else if (value !== undefined) {
              responseHeaders.set(key, String(value));
            }
          }
          try {
            resolve(
              new Response(
                input.method === "HEAD" || [204, 205, 304].includes(status)
                  ? null
                  : Buffer.concat(chunks),
                {
                  status,
                  statusText: incoming.statusMessage,
                  headers: responseHeaders
                }
              )
            );
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    clientRequest.once("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("Official site attempted an unsupported protocol upgrade"));
    });
    clientRequest.on("error", reject);
    clientRequest.end();
  });
}

function createPinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return ((
    _hostname: string,
    options: { all?: boolean } | number,
    callback: (...args: unknown[]) => void
  ) => {
    if (typeof options === "object" && options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  }) as LookupFunction;
}

function setResponseUrl(response: Response, url: string, redirected: boolean) {
  try {
    Object.defineProperties(response, {
      url: { configurable: true, value: url },
      redirected: { configurable: true, value: redirected }
    });
  } catch {
    // Response metadata is advisory; callers retain the validated request URL.
  }
}

class ProviderDiscoveryLeaseDeferredError extends Error {
  constructor() {
    super("Provider discovery capacity is temporarily unavailable");
    this.name = "ProviderDiscoveryLeaseDeferredError";
  }
}

type CollectedPageEvidence = Pick<
  BrowserDiscoveryEvidence,
  | "sourceUrl"
  | "finalUrl"
  | "observedUrls"
  | "linkCandidates"
  | "officialPage"
  | "visibleText"
  | "bookingSurfaceText"
  | "accessBarriers"
  | "corroboratedAccessBarrier"
>;

type RecentCourseAutomationDiscovery = Awaited<
  ReturnType<typeof listRecentCourseAutomationDiscoveries>
>[number];

type MonitoringDiscoveryCandidate = {
  course: ActiveAutomationSearch["preferences"][number]["course"];
  sourceUrl: string;
};

type RemediationDiscoveryContext = {
  courseIds: string[];
  dispatchedAt: Date;
};

async function resolveRemediationDiscoveryContext(
  search: ActiveAutomationSearch,
  now: Date
): Promise<RemediationDiscoveryContext | null> {
  const remediationDispatchVersion = search.remediationDispatchVersion;
  const checkLeaseExpiresAt = search.checkLeaseExpiresAt;
  if (
    !search.remediationDispatchKey ||
    remediationDispatchVersion === null ||
    (search.scheduleVersion !== remediationDispatchVersion &&
      search.scheduleVersion !== remediationDispatchVersion + 1) ||
    !search.checkLeaseToken ||
    !checkLeaseExpiresAt ||
    checkLeaseExpiresAt.getTime() <= now.getTime()
  ) {
    return null;
  }

  const preferenceCourseIds = search.preferences.map(
    (preference) => preference.course.id
  );
  if (preferenceCourseIds.length === 0) {
    return null;
  }

  const dispatches = await prisma.courseSupportBatchSearch.findMany({
    where: {
      teeSearchId: search.id,
      scheduleVersion: remediationDispatchVersion,
      removedAt: null,
      teeSearch: {
        is: {
          status: "ACTIVE",
          scheduleVersion: search.scheduleVersion,
          remediationDispatchKey: search.remediationDispatchKey,
          remediationDispatchVersion,
          checkLeaseToken: search.checkLeaseToken,
          checkLeaseExpiresAt: {
            equals: checkLeaseExpiresAt,
            gt: now
          }
        }
      },
      batch: {
        is: {
          status: "VERIFYING",
          recheckDispatchKey: search.remediationDispatchKey,
          releaseSha: { not: null },
          deployedAt: { not: null },
          recheckDispatchStartedAt: { not: null },
          recheckDispatchedAt: { not: null }
        }
      }
    },
    select: {
      scheduleVersion: true,
      removedAt: true,
      teeSearch: {
        select: {
          id: true,
          status: true,
          scheduleVersion: true,
          remediationDispatchKey: true,
          remediationDispatchVersion: true,
          checkLeaseToken: true,
          checkLeaseExpiresAt: true,
          preferences: {
            where: { courseId: { in: preferenceCourseIds } },
            select: { courseId: true }
          }
        }
      },
      batch: {
        select: {
          status: true,
          releaseSha: true,
          deployedAt: true,
          recheckDispatchKey: true,
          recheckDispatchStartedAt: true,
          recheckDispatchedAt: true,
          incidents: {
            where: {
              result: { not: "FINAL_DISPOSITION" },
              courseId: { in: preferenceCourseIds }
            },
            select: {
              courseId: true
            }
          }
        }
      }
    },
    take: 2
  });
  if (dispatches.length !== 1) {
    return null;
  }

  const dispatch = dispatches[0];
  const currentSearch = dispatch.teeSearch;
  if (
    dispatch.scheduleVersion !== remediationDispatchVersion ||
    dispatch.removedAt !== null ||
    !currentSearch ||
    currentSearch.id !== search.id ||
    currentSearch.status !== "ACTIVE" ||
    currentSearch.scheduleVersion !== search.scheduleVersion ||
    currentSearch.remediationDispatchKey !== search.remediationDispatchKey ||
    currentSearch.remediationDispatchVersion !== remediationDispatchVersion ||
    currentSearch.checkLeaseToken !== search.checkLeaseToken ||
    !currentSearch.checkLeaseExpiresAt ||
    currentSearch.checkLeaseExpiresAt.getTime() !==
      checkLeaseExpiresAt.getTime() ||
    currentSearch.checkLeaseExpiresAt.getTime() <= now.getTime() ||
    dispatch.batch.status !== "VERIFYING" ||
    dispatch.batch.recheckDispatchKey !== search.remediationDispatchKey ||
    !dispatch.batch.releaseSha ||
    !dispatch.batch.deployedAt ||
    !dispatch.batch.recheckDispatchStartedAt ||
    !dispatch.batch.recheckDispatchedAt
  ) {
    return null;
  }

  const currentPreferenceIds = new Set(
    currentSearch.preferences.map((preference) => preference.courseId)
  );
  const courseIds = [
    ...new Set(
      dispatch.batch.incidents
        .map((incident) => incident.courseId)
        .filter((courseId) => currentPreferenceIds.has(courseId))
    )
  ];
  if (courseIds.length === 0) {
    return null;
  }

  return {
    courseIds,
    dispatchedAt: dispatch.batch.recheckDispatchStartedAt
  };
}

export type SearchMonitoringDiscoveryResult = {
  attemptedCourseIds: string[];
  appliedCourseIds: string[];
  failedCourseIds: string[];
  deferredCourseIds: string[];
  retryCourseIds: string[];
};

export async function prepareSearchMonitoring(
  search: ActiveAutomationSearch,
  fetchImpl: typeof fetch | undefined = undefined,
  now = new Date()
): Promise<SearchMonitoringDiscoveryResult> {
  const publicFetch = fetchImpl ?? addressPinnedPublicFetch;
  const probeCourses = search.preferences
    .map((preference) => preference.course)
    .filter(
      (course) =>
        shouldQueueBrowserProbe(course) || isLegacyPolicyOnlyBlock(course)
    );
  const candidateInputs = probeCourses
    .map((course) => ({
      course,
      sourceUrl: getSafeMonitoringProbeUrl(course)
    }));
  const appliedCourseIds: string[] = [];
  for (const { course, sourceUrl } of candidateInputs) {
    if (sourceUrl || !isLegacyPolicyOnlyBlock(course)) {
      continue;
    }
    const expectedCourse = getMonitoringCourseExpectation(course);
    const retired = expectedCourse
      ? await retireLegacyPolicyOnlyCourseBlock(
          course.id,
          expectedCourse,
          getLegacyPolicyEvidencePreservation(course)
        )
      : null;
    if (retired) {
      appliedCourseIds.push(course.id);
    }
  }
  const candidates = candidateInputs
    .filter(
      (candidate): candidate is typeof candidate & { sourceUrl: string } =>
        Boolean(candidate.sourceUrl)
    );

  if (candidates.length === 0) {
    return {
      attemptedCourseIds: [],
      appliedCourseIds,
      failedCourseIds: [],
      deferredCourseIds: [],
      retryCourseIds: []
    };
  }

  const remediationContext = await resolveRemediationDiscoveryContext(
    search,
    now
  );
  const normalLookbackStartedAt = new Date(
    now.getTime() - DISCOVERY_LOOKBACK_MS
  );
  const requestedLookbackStartedAt = remediationContext
    ? new Date(
        Math.min(
          normalLookbackStartedAt.getTime(),
          remediationContext.dispatchedAt.getTime()
        ) - 1
      )
    : normalLookbackStartedAt;
  const recentDiscoveries = await listRecentCourseAutomationDiscoveries(
    candidates.map((candidate) => candidate.course.id),
    requestedLookbackStartedAt
  );
  const remediationCourseIds = new Set(remediationContext?.courseIds ?? []);
  const postDispatchDiscoveryCourseIds = new Set(
    remediationContext
      ? recentDiscoveries
          .filter(
            (discovery) =>
              remediationCourseIds.has(discovery.courseId) &&
              discovery.createdAt.getTime() >=
                remediationContext.dispatchedAt.getTime()
          )
          .map((discovery) => discovery.courseId)
      : []
  );
  const discoveriesByCourse = new Map<string, Date[]>();
  const recentDiscoveriesByCourse = new Map<
    string,
    RecentCourseAutomationDiscovery[]
  >();
  const previousEvidenceByCourse = new Map<string, unknown>();
  for (const discovery of recentDiscoveries
    .filter((candidate) => isFreshDiscovery(candidate.createdAt, now))
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())) {
    const attempts = discoveriesByCourse.get(discovery.courseId) ?? [];
    attempts.push(discovery.createdAt);
    discoveriesByCourse.set(discovery.courseId, attempts);
    const courseDiscoveries = recentDiscoveriesByCourse.get(discovery.courseId) ?? [];
    courseDiscoveries.push(discovery);
    recentDiscoveriesByCourse.set(discovery.courseId, courseDiscoveries);
    if (!previousEvidenceByCourse.has(discovery.courseId)) {
      previousEvidenceByCourse.set(discovery.courseId, discovery.evidence);
    }
  }

  const attemptedCourseIds: string[] = [];
  const failedCourseIds: string[] = [];
  const deferredCourseIds: string[] = [];
  const resolvedLegacyPolicyCourseIds = new Set<string>();
  const replayAppliedCourseIds = new Set<string>();

  for (const candidate of candidates) {
    if (
      (discoveriesByCourse.get(candidate.course.id)?.length ?? 0) <
      MAX_DISCOVERY_ATTEMPTS_PER_DAY
    ) {
      continue;
    }
    const replayed = replayRecentInspectedDiscovery(
      candidate,
      recentDiscoveriesByCourse.get(candidate.course.id) ?? [],
      now
    );
    if (!replayed) {
      continue;
    }
    const expectedCourse = getMonitoringCourseExpectation(candidate.course);
    const applied = expectedCourse
      ? await applyBrowserDiscoveryToCourse(replayed, expectedCourse)
      : await applyBrowserDiscoveryToCourse(replayed);
    if (applied) {
      await recordBrowserDiscovery(replayed);
      appliedCourseIds.push(candidate.course.id);
      replayAppliedCourseIds.add(candidate.course.id);
      if (
        isLegacyPolicyOnlyBlock(candidate.course) &&
        replacesLegacyPolicyOnlyBlock(replayed)
      ) {
        resolvedLegacyPolicyCourseIds.add(candidate.course.id);
      }
    }
  }

  const forcedPolicyReconciliationCourseIds = new Set(
    candidates
      .filter(({ course }) =>
        shouldForceLegacyPolicyReconciliation(
          course,
          discoveriesByCourse.get(course.id) ?? [],
          recentDiscoveriesByCourse.get(course.id) ?? [],
          now
        )
      )
      .map(({ course }) => course.id)
  );
  const dueCandidates = candidates.filter(({ course }) => {
    const attempts = discoveriesByCourse.get(course.id) ?? [];
    const remediationOverrideEligible = Boolean(
      remediationContext &&
        remediationCourseIds.has(course.id) &&
        !postDispatchDiscoveryCourseIds.has(course.id) &&
        !replayAppliedCourseIds.has(course.id)
    );
    return (
      forcedPolicyReconciliationCourseIds.has(course.id) ||
      shouldAttemptMonitoringDiscovery(attempts, now) ||
      remediationOverrideEligible
    );
  });
  const evidenceBySource = new Map<string, Promise<CollectedPageEvidence>>();
  const pageFetches = new Map<string, Promise<Awaited<ReturnType<typeof fetchPublicHtml>>>>();
  const wordpressContentFetches = new Map<string, Promise<string | null>>();

  await runProviderFamilyTasks(
    dueCandidates,
    ({ course, sourceUrl }) =>
      resolveProviderCapability({
        ...course,
        detectedBookingUrl: sourceUrl
      }).providerFamilyKey,
    async ({ course, sourceUrl }) => {
      const leasedFetch = createProviderLeasedDiscoveryFetch(publicFetch);
      const forcedPolicyReconciliation =
        forcedPolicyReconciliationCourseIds.has(course.id);
      const markAttempted = () => {
        if (!attemptedCourseIds.includes(course.id)) {
          attemptedCourseIds.push(course.id);
        }
      };
      try {
        const sourceKey = `${normalizeSourceKey(sourceUrl)}|${normalizeCourseLinkName(course.name)}`;
        let evidencePromise = evidenceBySource.get(sourceKey);
        if (!evidencePromise) {
          evidencePromise = collectOfficialSiteEvidence(
            sourceUrl,
            leasedFetch,
            course.name,
            pageFetches,
            wordpressContentFetches
          );
          evidenceBySource.set(sourceKey, evidencePromise);
        }
        const collected = await evidencePromise;
        const collectedWithCorroboration = {
          ...collected,
          corroboratedAccessBarrier:
            findCorroboratingAccessBarrier(
              previousEvidenceByCourse.get(course.id),
              collected.accessBarriers
            ) ?? undefined,
          courseId: course.id,
          courseName: course.name
        };
        const chronogolfDiscovery = await enrichChronogolfDiscovery(
          buildBrowserDiscovery(collectedWithCorroboration),
          leasedFetch
        );
        const cpsDiscovery = await enrichCpsDiscovery(
          chronogolfDiscovery,
          course.name,
          leasedFetch
        );
        const reasonAwareDiscovery = sanitizeBrowserDiscoveryAccessEvidence(
          keepPolicyOnlyDiscoveryActionable(
            await enrichTeesnapDiscovery(
              cpsDiscovery,
              course.name,
              leasedFetch
            )
          ),
          collected.accessBarriers
        );
        const discovery = forcedPolicyReconciliation
          ? markLegacyPolicyReconciliation(reasonAwareDiscovery)
          : reasonAwareDiscovery;
        markAttempted();
        await recordBrowserDiscovery(discovery);
        const expectedCourse = getMonitoringCourseExpectation(course);
        const replacesLegacyPolicy =
          isLegacyPolicyOnlyBlock(course) &&
          replacesLegacyPolicyOnlyBlock(discovery);
        const applied = isLegacyPolicyOnlyBlock(course) && !replacesLegacyPolicy
          ? null
          : expectedCourse
            ? await applyBrowserDiscoveryToCourse(discovery, expectedCourse)
            : await applyBrowserDiscoveryToCourse(discovery);
        if (applied) {
          appliedCourseIds.push(course.id);
          if (replacesLegacyPolicy) {
            resolvedLegacyPolicyCourseIds.add(course.id);
          }
        }
      } catch (error) {
        if (error instanceof ProviderDiscoveryLeaseDeferredError) {
          deferredCourseIds.push(course.id);
          return;
        }
        markAttempted();
        failedCourseIds.push(course.id);
        const failedDiscovery = buildFailedDiscovery({
          courseId: course.id,
          sourceUrl,
          detectedPlatform: course.detectedPlatform,
          message: error instanceof Error ? error.message : "Official-site discovery failed"
        });
        await recordBrowserDiscovery(
          forcedPolicyReconciliation
            ? markLegacyPolicyReconciliation(failedDiscovery)
            : failedDiscovery
        );
      }
    }
  );

  const attemptedCourseIdSet = new Set(attemptedCourseIds);
  for (const { course } of candidates) {
    if (
      !isLegacyPolicyOnlyBlock(course) ||
      resolvedLegacyPolicyCourseIds.has(course.id) ||
      (!attemptedCourseIdSet.has(course.id) &&
        !hasRecentLegacyPolicyReconciliation(
          recentDiscoveriesByCourse.get(course.id) ?? []
        ))
    ) {
      continue;
    }
    const expectedCourse = getMonitoringCourseExpectation(course);
    const retired = expectedCourse
      ? await retireLegacyPolicyOnlyCourseBlock(
          course.id,
          expectedCourse,
          getLegacyPolicyEvidencePreservation(course)
        )
      : null;
    if (retired && !appliedCourseIds.includes(course.id)) {
      appliedCourseIds.push(course.id);
    }
  }
  const appliedCourseIdSet = new Set(appliedCourseIds);
  const retryCourseIds = candidates
    .filter(({ course }) => {
      if (isLegacyPolicyOnlyBlock(course)) {
        const attempts = discoveriesByCourse.get(course.id) ?? [];
        const completedThisRun = attemptedCourseIdSet.has(course.id) ? 1 : 0;
        const postRunAttemptCount = attempts.length + completedThisRun;
        if (postRunAttemptCount >= MAX_DISCOVERY_ATTEMPTS_PER_DAY) {
          const alreadyMarked = hasRecentLegacyPolicyReconciliation(
            recentDiscoveriesByCourse.get(course.id) ?? []
          );
          const markedThisRun = Boolean(
            forcedPolicyReconciliationCourseIds.has(course.id) &&
            attemptedCourseIdSet.has(course.id)
          );
          return Boolean(
            !alreadyMarked &&
            !markedThisRun &&
            !appliedCourseIdSet.has(course.id)
          );
        }
      }
      const persistedAttempts = discoveriesByCourse.get(course.id)?.length ?? 0;
      const completedThisRun = attemptedCourseIdSet.has(course.id) ? 1 : 0;
      return persistedAttempts + completedThisRun < MAX_DISCOVERY_ATTEMPTS_PER_DAY;
    })
    .map(({ course }) => course.id);

  return {
    attemptedCourseIds,
    appliedCourseIds,
    failedCourseIds,
    deferredCourseIds,
    retryCourseIds
  };
}

function getSafeMonitoringProbeUrl(
  course: MonitoringDiscoveryCandidate["course"]
) {
  for (const candidate of [course.detectedBookingUrl, course.website]) {
    const safeUrl = readSafePublicUrl(candidate);
    if (safeUrl) {
      return parseSafePublicUrl(safeUrl).toString();
    }
  }
  return null;
}

function getMonitoringCourseExpectation(
  course: MonitoringDiscoveryCandidate["course"]
) {
  return course.updatedAt instanceof Date
    ? {
        updatedAt: course.updatedAt,
        detectedBookingUrl: course.detectedBookingUrl,
        bookingMethod: course.bookingMethod,
        automationEligibility: course.automationEligibility
      }
    : undefined;
}

function getLegacyPolicyEvidencePreservation(
  course: MonitoringDiscoveryCandidate["course"]
) {
  return {
    preserveWebsite: Boolean(
      course.website && readSafeCustomerReferenceUrl(course.website)
    ),
    preserveDetectedBookingUrl: Boolean(
      course.detectedBookingUrl &&
      readSafeCustomerReferenceUrl(course.detectedBookingUrl)
    ),
    preserveBookingMetadata: Boolean(
      course.bookingMetadata &&
      hasProviderCoherentPersistedMetadata(course)
    )
  };
}

function readSafeCustomerReferenceUrl(value: unknown) {
  const strictPublicUrl = readSafePublicUrl(value);
  if (strictPublicUrl) {
    return strictPublicUrl;
  }
  if (typeof value !== "string" || value.length > 2_048 || !value.trim()) {
    return null;
  }
  try {
    const url = new URL(value.trim());
    const hasInvalidPort = Boolean(
      url.port &&
      !(
        (url.protocol === "http:" && url.port === "80") ||
        (url.protocol === "https:" && url.port === "443")
      )
    );
    const decodedPath = decodePublicUrlPath(url.pathname);
    if (
      !decodedPath ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      hasInvalidPort ||
      url.hostname.endsWith(".") ||
      isPrivateHostname(url.hostname) ||
      isForbiddenProviderSurfaceHostname(url.hostname) ||
      url.search ||
      url.hash ||
      !isAllowedCredentialFreeCustomerPath(decodedPath)
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isAllowedCredentialFreeCustomerPath(pathname: string) {
  const segments = pathname
    .split(/[/;=]+/u)
    .map((segment) =>
      segment.normalize("NFKC").replace(/[^a-z0-9]/giu, "").toLowerCase()
    )
    .filter(Boolean);
  const accessRoots = new Set([
    "account",
    "accounts",
    "login",
    "member",
    "members",
    "membership",
    "myaccount",
    "signin",
    "signon"
  ]);
  const accessDestinations = new Set([
    "booking",
    "golf",
    "home",
    "reservations",
    "reservation",
    "teetime",
    "teetimes"
  ]);
  const queueRoots = new Set(["queue", "queueit", "waitingroom"]);
  const queueDestinations = new Set(["landing", "status", "wait"]);
  return Boolean(
    (segments.length === 1 &&
      (accessRoots.has(segments[0]!) || queueRoots.has(segments[0]!))) ||
    (segments.length === 2 &&
      ((accessRoots.has(segments[0]!) && accessDestinations.has(segments[1]!)) ||
        (queueRoots.has(segments[0]!) && queueDestinations.has(segments[1]!))))
  );
}

function hasProviderCoherentPersistedMetadata(
  course: MonitoringDiscoveryCandidate["course"]
) {
  if (
    !course.bookingMetadata ||
    !isPlainRecord(course.bookingMetadata) ||
    !hasOnlySafePersistedProviderMetadata(course.bookingMetadata)
  ) {
    return false;
  }
  const provider = resolveProviderCapability(course);
  const bookingBaseUrl = readSafePublicUrl(
    course.bookingMetadata.bookingBaseUrl
  );
  if (!provider.isRunnable || !bookingBaseUrl) {
    return false;
  }
  const bookingUrlProvider = resolveProviderCapability({
    detectedBookingUrl: bookingBaseUrl
  });
  if (
    !bookingUrlProvider.capability ||
    bookingUrlProvider.providerFamilyKey !== provider.providerFamilyKey
  ) {
    return false;
  }
  if (provider.providerFamilyKey !== "CPS") {
    return true;
  }
  const bookingUrl = parseSafePublicUrl(bookingBaseUrl);
  if (bookingUrl.protocol !== "https:") {
    return false;
  }
  for (const key of ["authorityBaseUrl", "onlineApi"] as const) {
    const endpoint = course.bookingMetadata[key];
    if (endpoint === undefined) {
      continue;
    }
    const safeEndpoint = readSafePublicUrl(endpoint);
    if (!safeEndpoint) {
      return false;
    }
    const endpointUrl = parseSafePublicUrl(safeEndpoint);
    if (
      endpointUrl.protocol !== "https:" ||
      endpointUrl.hostname !== bookingUrl.hostname ||
      endpointUrl.search ||
      endpointUrl.hash
    ) {
      return false;
    }
  }
  return true;
}

function hasOnlySafePersistedProviderMetadata(
  value: unknown,
  depth = 0,
  seen = new Set<object>()
): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (["boolean", "number"].includes(typeof value)) {
    return true;
  }
  if (typeof value === "string") {
    return !/^https?:/iu.test(value.trim()) || Boolean(readSafePublicUrl(value));
  }
  if (typeof value !== "object" || depth > 6 || seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return (
      value.length <= 100 &&
      value.every((item) =>
        hasOnlySafePersistedProviderMetadata(item, depth + 1, seen)
      )
    );
  }
  const entries = Object.entries(value);
  if (entries.length > 100) {
    return false;
  }
  return entries.every(([key, item]) => {
    const normalizedKey = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
    if (
      /(?:token|secret|password|credential|authorization|cookie|session|signature|apikey)/u.test(
        normalizedKey
      )
    ) {
      return item === null || item === undefined || item === "";
    }
    if (/(?:url|uri|endpoint|origin)$/u.test(normalizedKey)) {
      return typeof item === "string" && Boolean(readSafePublicUrl(item));
    }
    return hasOnlySafePersistedProviderMetadata(item, depth + 1, seen);
  });
}

function replacesLegacyPolicyOnlyBlock(discovery: BrowserDiscovery) {
  return Boolean(
    discovery.status === "LEARNED" ||
    (discovery.automationEligibility &&
      !(
        discovery.automationEligibility === "BLOCKED" &&
        discovery.automationReason === "AUTOMATION_PROHIBITED"
      ))
  );
}

function isLegacyPolicyOnlyBlock(
  course: Pick<
    MonitoringDiscoveryCandidate["course"],
    "automationEligibility" | "automationReason"
  >
) {
  return (
    course.automationEligibility === "BLOCKED" &&
    course.automationReason === "AUTOMATION_PROHIBITED"
  );
}

function shouldForceLegacyPolicyReconciliation(
  course: Pick<
    MonitoringDiscoveryCandidate["course"],
    "automationEligibility" | "automationReason"
  >,
  attempts: Date[],
  discoveries: RecentCourseAutomationDiscovery[],
  now: Date
) {
  return Boolean(
    isLegacyPolicyOnlyBlock(course) &&
    attempts.length >= MAX_DISCOVERY_ATTEMPTS_PER_DAY &&
    hasDiscoveryRetryDelayElapsed(attempts, now) &&
    !hasRecentLegacyPolicyReconciliation(discoveries)
  );
}

function hasRecentLegacyPolicyReconciliation(
  discoveries: RecentCourseAutomationDiscovery[]
) {
  return discoveries.some((discovery) => {
    if (!isPlainRecord(discovery.evidence)) {
      return false;
    }
    const learnedFrom = discovery.evidence.learnedFrom;
    return Boolean(
      typeof learnedFrom === "string" &&
      learnedFrom.split(":").includes(LEGACY_POLICY_RECONCILIATION_MARKER)
    );
  });
}

function markLegacyPolicyReconciliation(discovery: BrowserDiscovery): BrowserDiscovery {
  if (
    discovery.evidence.learnedFrom
      .split(":")
      .includes(LEGACY_POLICY_RECONCILIATION_MARKER)
  ) {
    return discovery;
  }
  return {
    ...discovery,
    evidence: {
      ...discovery.evidence,
      learnedFrom:
        `${discovery.evidence.learnedFrom}:${LEGACY_POLICY_RECONCILIATION_MARKER}`
    }
  };
}

function hasDiscoveryRetryDelayElapsed(attempts: Date[], now: Date) {
  const latestAttempt = attempts.reduce<Date | null>(
    (latest, attempt) => (!latest || attempt > latest ? attempt : latest),
    null
  );
  return !latestAttempt || now.getTime() - latestAttempt.getTime() >= DISCOVERY_RETRY_DELAY_MS;
}

export function shouldAttemptMonitoringDiscovery(attempts: Date[], now = new Date()) {
  if (attempts.length >= MAX_DISCOVERY_ATTEMPTS_PER_DAY) {
    return false;
  }

  return hasDiscoveryRetryDelayElapsed(attempts, now);
}

function replayRecentInspectedDiscovery(
  candidate: MonitoringDiscoveryCandidate,
  discoveries: RecentCourseAutomationDiscovery[],
  now: Date
) {
  if (hasCurrentCourseOnlineBookingEvidence(candidate.course)) {
    return null;
  }
  for (const discovery of discoveries
    .filter(
      (item) =>
        item.courseId === candidate.course.id &&
        isFreshDiscovery(item.createdAt, now)
    )
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())) {
    if (discovery.status === "FAILED") {
      continue;
    }
    if (discovery.status !== "INSPECTED") {
      return null;
    }
    if (isRejectedManualReplayEvidence(discovery)) {
      return null;
    }
    try {
      const evidence = readPersistedDiscoveryEvidence(candidate, discovery);
      if (!evidence) {
        return null;
      }
      const rebuilt = buildBrowserDiscovery(evidence);
      if (isTrustedReplayClassification(rebuilt)) {
        return rebuilt;
      }
      if (hasNewerOnlineBookingContradiction(rebuilt, evidence)) {
        return null;
      }
    } catch {
      // A corrupt durable snapshot is not proof and must not fail the live search check.
      return null;
    }
  }
  return null;
}

function isRejectedManualReplayEvidence(
  discovery: RecentCourseAutomationDiscovery
) {
  if (!isPlainRecord(discovery.evidence)) {
    return false;
  }
  const learnedFrom = discovery.evidence.learnedFrom;
  return Boolean(
    typeof learnedFrom === "string" &&
    learnedFrom.startsWith("official-phone-reservation-rejected:")
  );
}

function readPersistedDiscoveryEvidence(
  candidate: MonitoringDiscoveryCandidate,
  discovery: RecentCourseAutomationDiscovery
): BrowserDiscoveryEvidence | null {
  if (
    discovery.courseId !== candidate.course.id ||
    !candidate.course.name.trim() ||
    !isPlainRecord(discovery.evidence)
  ) {
    return null;
  }
  const sourceUrl = readSafePublicUrl(discovery.sourceUrl);
  if (!sourceUrl || !haveSameReplayHostname(candidate.sourceUrl, sourceUrl)) {
    return null;
  }
  const observedUrls = readSafeUrlList(discovery.evidence.observedUrls, 200);
  const finalUrl = readOptionalSafePublicUrl(discovery.evidence.finalUrl);
  const visibleText = readOptionalBoundedText(discovery.evidence.visibleText, 12_000);
  const accessBarriers = readOptionalAccessBarriers(discovery.evidence.accessBarriers);
  const bookingCallToAction = readOptionalBoolean(
    discovery.evidence.bookingCallToAction
  );
  if (
    !observedUrls ||
    finalUrl === null ||
    visibleText === null ||
    accessBarriers === null ||
    bookingCallToAction === null
  ) {
    return null;
  }
  if (
    !isCurrentBookingUrlRepresented(candidate.course.detectedBookingUrl, [
      sourceUrl,
      finalUrl,
      ...observedUrls
    ])
  ) {
    return null;
  }
  return {
    courseId: candidate.course.id,
    courseName: candidate.course.name,
    sourceUrl,
    ...(finalUrl ? { finalUrl } : {}),
    observedUrls,
    ...(visibleText !== undefined ? { visibleText } : {}),
    ...(accessBarriers ? { accessBarriers } : {}),
    ...(bookingCallToAction !== undefined ? { bookingCallToAction } : {})
  };
}

function hasCurrentCourseOnlineBookingEvidence(
  course: MonitoringDiscoveryCandidate["course"]
) {
  if (
    course.bookingMethod === "PUBLIC_ONLINE" ||
    course.automationEligibility === "ALLOWED"
  ) {
    return true;
  }
  const provider = resolveProviderCapability(course);
  if (provider.capability || provider.isRunnable || provider.evidenceConflict) {
    return true;
  }
  const currentBookingUrl = course.detectedBookingUrl?.trim();
  if (!currentBookingUrl) {
    return false;
  }
  try {
    return hasExplicitReplayTeeTimeDestination(parseSafePublicUrl(currentBookingUrl));
  } catch {
    return true;
  }
}

function isCurrentBookingUrlRepresented(
  currentBookingUrl: string | null,
  replayUrls: Array<string | undefined>
) {
  const current = currentBookingUrl?.trim();
  if (!current) {
    return true;
  }
  try {
    const normalizedCurrent = normalizeSourceKey(parseSafePublicUrl(current).toString());
    return replayUrls.some((value) => {
      if (!value) {
        return false;
      }
      try {
        return normalizeSourceKey(parseSafePublicUrl(value).toString()) === normalizedCurrent;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function isTrustedReplayClassification(discovery: BrowserDiscovery) {
  if (!Number.isFinite(discovery.confidence) || discovery.confidence < 0.8) {
    return false;
  }
  return (
    discovery.status === "VERIFIED" &&
    discovery.automationEligibility === "BLOCKED" &&
    discovery.automationReason === "NO_ONLINE_BOOKING" &&
    ["PHONE_ONLY", "CONTACT_COURSE", "WALK_IN"].includes(
      discovery.bookingMethod ?? ""
    )
  );
}

function hasNewerOnlineBookingContradiction(
  discovery: BrowserDiscovery,
  evidence: BrowserDiscoveryEvidence
) {
  if (
    discovery.bookingMethod === "PUBLIC_ONLINE" ||
    discovery.evidence.learnedFrom.startsWith("official-phone-reservation-rejected:")
  ) {
    return true;
  }
  if (hasReplayPositiveOnlineBookingText(evidence.visibleText ?? "")) {
    return true;
  }
  return evidence.observedUrls.some((url) => {
    if (resolveProviderCapability({ detectedBookingUrl: url }).capability) {
      return true;
    }
    const parsed = parseSafePublicUrl(url);
    if (hasExplicitReplayTeeTimeDestination(parsed)) {
      return true;
    }
    return false;
  });
}

function hasExplicitReplayTeeTimeDestination(url: URL) {
  return /(?:^|\/)(?:(?:book|reserve|schedule)[-_ ]+(?:a[-_ ]+)?)?tee[-_ ]?times?(?:[-_ ]+(?:booking|reservations?))?(?:\.(?:aspx?|php\d?|s?html?|xhtml|jspx?|cfm|cgi|do|action))?(?:\/|$)/i.test(
    url.pathname
  );
}

function hasReplayPositiveOnlineBookingText(value: string) {
  return normalizeReplayTeeTimeTypography(value).split(/[.!?\n]+/).some((statement) => {
    const normalized = statement.replace(/\s+/g, " ").trim();
    const hasExplicitTeeTimeText = /\btee\s*times?\b/i.test(normalized);
    if (
      /\b(?:no|not|never|without|do\s+not|does\s+not|cannot|can['’]t)\b.{0,60}\bonline\b/i.test(
        normalized
      ) ||
      /\bonline\s+(?:booking|reservations?|tee\s*times?)\b.{0,40}\b(?:not\s+available|unavailable|disabled)\b/i.test(
        normalized
      )
    ) {
      return false;
    }
    if (!hasExplicitTeeTimeText) {
      return false;
    }
    if (
      /\b(?:call(?:ing)?|phone)\b/i.test(normalized) &&
      !/\bonline\b/i.test(normalized)
    ) {
      return false;
    }
    return (
      /\bonline\b/i.test(normalized) ||
      /^(?:book|reserve|schedule|view|see|search|find|check|make)\b.{0,80}\btee\s*times?\b/i.test(
        normalized
      )
    );
  });
}

function normalizeReplayTeeTimeTypography(value: string) {
  return value.replace(
    /\btee(?:[\s\x2d\u00ad\u2010-\u2015\u2212])+(times?)\b/giu,
    "tee $1"
  );
}

function isFreshDiscovery(createdAt: Date, now: Date) {
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
    return false;
  }
  const ageMs = now.getTime() - createdAt.getTime();
  return ageMs >= 0 && ageMs < DISCOVERY_LOOKBACK_MS;
}

function readSafePublicUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2_048 || !value.trim()) {
    return null;
  }
  try {
    parseSafePublicUrl(value.trim());
    return value.trim();
  } catch {
    return null;
  }
}

function readOptionalSafePublicUrl(value: unknown) {
  return value === undefined || value === null ? undefined : readSafePublicUrl(value);
}

function readSafeUrlList(value: unknown, limit: number) {
  if (!Array.isArray(value) || value.length > limit) {
    return null;
  }
  const urls = value.map(readSafePublicUrl);
  return urls.some((url) => !url) ? null : (urls as string[]);
}

function readOptionalBoundedText(value: unknown, limit: number) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === "string" && value.length <= limit ? value : null;
}

function readOptionalBoolean(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === "boolean" ? value : null;
}

function readOptionalAccessBarriers(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > 20) {
    return null;
  }
  const barriers: NonNullable<BrowserDiscoveryEvidence["accessBarriers"]> = [];
  for (const barrier of value) {
    if (
      !isPlainRecord(barrier) ||
      (barrier.status !== 401 && barrier.status !== 403)
    ) {
      return null;
    }
    const url = readSafePublicUrl(barrier.url);
    if (!url) {
      return null;
    }
    barriers.push({ url, status: barrier.status });
  }
  return barriers;
}

function haveSameReplayHostname(left: string, right: string) {
  try {
    const normalize = (hostname: string) =>
      hostname.toLowerCase().replace(/^www\./u, "");
    return normalize(parseSafePublicUrl(left).hostname) === normalize(parseSafePublicUrl(right).hostname);
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function collectOfficialSiteEvidence(
  sourceUrl: string,
  fetchImpl: typeof fetch | undefined = undefined,
  courseName?: string,
  pageFetches = new Map<string, Promise<Awaited<ReturnType<typeof fetchPublicHtml>>>>(),
  wordpressContentFetches = new Map<string, Promise<string | null>>()
): Promise<CollectedPageEvidence> {
  const publicFetch = fetchImpl ?? addressPinnedPublicFetch;
  const fetchPage = (url: string) => {
    const key = normalizeSourceKey(url);
    let page = pageFetches.get(key);
    if (!page) {
      page = fetchPublicHtml(url, publicFetch);
      pageFetches.set(key, page);
    }
    return page;
  };
  const firstPage = await fetchPage(sourceUrl);
  const pages = [{
    ...firstPage,
    evidence: extractHtmlEvidence(firstPage.html, firstPage.finalUrl)
  }];
  let matchedCoursePage = courseName && doesPageUrlIdentifyCourse(
    firstPage.finalUrl,
    courseName
  )
    ? pages[0]
    : undefined;
  const visited = new Set([normalizeSourceKey(firstPage.finalUrl)]);
  const targetScopedOfficialRedirects: Array<{
    url: string;
    label: string;
  }> = [];
  let wordpressContentAttempted = false;

  for (let followup = 0; followup < MAX_BOOKING_LINK_FOLLOWUPS; followup += 1) {
    const linkCandidates = pages.flatMap((page) => page.evidence.linkCandidates);
    const unvisitedCandidates = linkCandidates.filter(
      (candidate) => !visited.has(normalizeSourceKey(candidate.url))
    );
    const followupCandidate =
      pickOfficialPolicyCandidate(unvisitedCandidates, firstPage.finalUrl) ??
      pickOfficialCourseDetailCandidate(
        unvisitedCandidates,
        courseName,
        firstPage.finalUrl
      ) ??
      pickLikelyBookingCandidate(
        unvisitedCandidates,
        firstPage.finalUrl,
        courseName
      ) ??
      pickPrivateClubInformationCandidate(
        unvisitedCandidates,
        pages.map((page) => page.evidence.visibleText).join(" "),
        firstPage.finalUrl
      );
    if (!followupCandidate) {
      break;
    }
    const followedLinkCandidate = linkCandidates.find(
      (candidate) =>
        normalizeSourceKey(candidate.url) ===
        normalizeSourceKey(followupCandidate)
    );
    const exactTargetOfficialRedirect =
      courseName &&
      followedLinkCandidate &&
      haveSameReplayHostname(
        firstPage.finalUrl,
        followedLinkCandidate.url
      ) &&
      doesProviderLinkLabelExactlyIdentifyCourse(
        followedLinkCandidate.label,
        courseName
      )
        ? followedLinkCandidate
        : undefined;
    const identifiesTargetCourse = Boolean(
      courseName &&
        doesFollowupIdentifyCourse(
          followupCandidate,
          linkCandidates,
          courseName
        )
    );
    visited.add(normalizeSourceKey(followupCandidate));

    try {
      const fetched = await fetchPage(followupCandidate);
      let extractedEvidence = extractHtmlEvidence(
        fetched.html,
        fetched.finalUrl
      );
      if (
        followedLinkCandidate &&
        !wordpressContentAttempted &&
        haveSameReplayHostname(firstPage.finalUrl, fetched.finalUrl) &&
        isBookingLikeOfficialFollowup(followedLinkCandidate)
      ) {
        wordpressContentAttempted = true;
        try {
          const renderedContent = await fetchWordPressRenderedPageContent(
            fetched.html,
            fetched.finalUrl,
            publicFetch,
            wordpressContentFetches
          );
          if (renderedContent) {
            extractedEvidence = mergeHtmlEvidence(
              extractedEvidence,
              extractHtmlEvidence(renderedContent, fetched.finalUrl)
            );
          }
        } catch (error) {
          if (error instanceof ProviderDiscoveryLeaseDeferredError) {
            throw error;
          }
          // WordPress content enrichment is optional; the fetched HTML remains valid evidence.
        }
      }
      const page = {
        ...fetched,
        evidence: extractedEvidence
      };
      pages.push(page);
      if (
        exactTargetOfficialRedirect &&
        !haveSameReplayHostname(firstPage.finalUrl, page.finalUrl)
      ) {
        targetScopedOfficialRedirects.push({
          url: page.finalUrl,
          label: exactTargetOfficialRedirect.label
        });
      }
      if (
        identifiesTargetCourse &&
        courseName &&
        doesPageUrlIdentifyCourse(page.finalUrl, courseName) &&
        haveSameReplayHostname(firstPage.finalUrl, page.finalUrl)
      ) {
        matchedCoursePage = page;
      }
      visited.add(normalizeSourceKey(page.finalUrl));
    } catch (error) {
      if (error instanceof ProviderDiscoveryLeaseDeferredError) {
        throw error;
      }
      // A failed PDF or booking shell must not prevent inspection of another official policy page.
      continue;
    }
  }

  const finalPage = pages.at(-1)!;
  const targetScopedOfficialLinks = matchedCoursePage && courseName
    ? uniqueLinkCandidates(
        [
          ...pages
            .filter((page) =>
              haveSameReplayHostname(firstPage.finalUrl, page.finalUrl)
            )
            .flatMap((page) => page.evidence.linkCandidates)
            .filter((candidate) =>
              !haveSameReplayHostname(firstPage.finalUrl, candidate.url) &&
              doesProviderLinkLabelExactlyIdentifyCourse(
                candidate.label,
                courseName
              )
            ),
          ...targetScopedOfficialRedirects
        ]
      )
    : [];
  return {
    sourceUrl,
    finalUrl: finalPage.finalUrl,
    observedUrls: uniqueStrings(
      pages.flatMap((page) => [page.finalUrl, ...page.evidence.observedUrls])
    ),
    linkCandidates: uniqueLinkCandidates(
      pages.flatMap((page) => page.evidence.linkCandidates)
    ).slice(0, 200),
    ...(matchedCoursePage && courseName
      ? {
          officialPage: {
            url: matchedCoursePage.finalUrl,
            linkCandidates: uniqueLinkCandidates(
              [
                ...matchedCoursePage.evidence.linkCandidates,
                ...targetScopedOfficialLinks
              ]
            ).slice(0, 200),
            courseName
          }
        }
      : {}),
    visibleText: pages.slice().reverse().map((page) => page.evidence.visibleText)
      .filter(Boolean)
      .join("\n")
      .slice(0, 12_000),
    bookingSurfaceText: pages
      .filter((page) => /(^|\.)app\.whoosh\.io$/i.test(new URL(page.finalUrl).hostname))
      .map((page) => page.evidence.visibleText)
      .filter(Boolean)
      .join("\n")
      .slice(0, 4_000),
    accessBarriers: pages
      .filter((page) => page.accessBarrier === "MANAGED_CHALLENGE")
      .map((page) => ({ url: page.finalUrl, status: 403 as const }))
  };
}

function doesFollowupIdentifyCourse(
  url: string,
  candidates: Array<{ url: string; label: string }>,
  courseName: string
) {
  if (doesPageUrlIdentifyCourse(url, courseName)) {
    return true;
  }
  const key = normalizeSourceKey(url);
  return candidates.some(
    (candidate) =>
      normalizeSourceKey(candidate.url) === key &&
      haveCompatibleCourseNames(courseName, candidate.label)
  );
}

function doesPageUrlIdentifyCourse(value: string, courseName: string) {
  try {
    const url = new URL(value);
    const decodedPath = decodeURIComponent(url.pathname);
    const pathIdentities = [
      ...(decodedPath.split("/").filter(Boolean).slice(-1)),
      decodedPath
    ].map((identity) =>
      identity
        .replace(/[-_]+/g, " ")
        .replace(/\btee\s*times?\b/gi, " ")
    );
    return pathIdentities.some((identity) =>
      haveCompatibleCourseNames(courseName, identity)
    );
  } catch {
    return false;
  }
}

async function fetchPublicHtml(sourceUrl: string, fetchImpl: typeof fetch) {
  const parsedSource = parseSafePublicUrl(sourceUrl);
  if (parsedSource.protocol === "http:") {
    const secureSource = new URL(parsedSource);
    secureSource.protocol = "https:";
    secureSource.port = "";
    const secureCandidates = [secureSource];
    if (secureSource.hostname.toLowerCase().startsWith("www.")) {
      const apexSource = new URL(secureSource);
      apexSource.hostname = secureSource.hostname.slice(4);
      secureCandidates.push(apexSource);
    }
    for (const candidate of secureCandidates) {
      try {
        return await fetchPublicHtmlFromUrl(candidate.toString(), fetchImpl);
      } catch (error) {
        if (error instanceof ProviderDiscoveryLeaseDeferredError) {
          throw error;
        }
        // Try the equivalent secure apex before the stored HTTP URL.
      }
    }
    return fetchPublicHtmlFromUrl(parsedSource.toString(), fetchImpl);
  }

  return fetchPublicHtmlFromUrl(parsedSource.toString(), fetchImpl);
}

function createProviderLeasedDiscoveryFetch(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    const providerFamilyKey = resolveProviderCapability({
      detectedBookingUrl: url
    }).providerFamilyKey;
    const execution = await runWithProviderRequestLease(providerFamilyKey, () =>
      fetchImpl(input, init)
    );
    if (!execution.acquired) {
      throw new ProviderDiscoveryLeaseDeferredError();
    }
    return execution.value;
  }) as typeof fetch;
}

async function fetchPublicHtmlFromUrl(sourceUrl: string, fetchImpl: typeof fetch) {
  let currentUrl = sourceUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5",
        "User-Agent": "TeeTimeSpot/1.0 (+https://teetimespot.com)"
      },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirectCount === MAX_REDIRECTS) {
        throw new Error("Official site returned an incomplete redirect");
      }
      currentUrl = parseSafePublicUrl(new URL(location, currentUrl).toString()).toString();
      continue;
    }

    const managedChallenge =
      response.status === 403 &&
      response.headers.get("cf-mitigated")?.toLowerCase() === "challenge";
    if (!response.ok && !managedChallenge) {
      throw new Error(`Official site returned HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type")?.toLowerCase();
    if (
      contentType &&
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml") &&
      !contentType.includes("text/plain")
    ) {
      throw new Error("Official site did not return an HTML page");
    }
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_HTML_BYTES) {
      throw new Error("Official site page is too large to inspect safely");
    }

    return {
      finalUrl: parseSafePublicUrl(response.url || currentUrl).toString(),
      html: (await response.text()).slice(0, MAX_HTML_BYTES),
      accessBarrier: managedChallenge ? ("MANAGED_CHALLENGE" as const) : undefined
    };
  }

  throw new Error("Official site exceeded the redirect limit");
}

async function fetchWordPressRenderedPageContent(
  sourceHtml: string,
  sourcePageUrl: string,
  fetchImpl: typeof fetch,
  contentFetches: Map<string, Promise<string | null>>
) {
  const apiUrl = findWordPressRenderedPageContentUrl(
    sourceHtml,
    sourcePageUrl
  );
  if (!apiUrl) {
    return null;
  }

  const cacheKey = `${normalizeSourceKey(apiUrl)}\u0000${normalizeSourceKey(sourcePageUrl)}`;
  let renderedContent = contentFetches.get(cacheKey);
  if (!renderedContent) {
    renderedContent = fetchWordPressRenderedPageContentFromUrl(
      apiUrl,
      sourcePageUrl,
      fetchImpl
    );
    contentFetches.set(cacheKey, renderedContent);
  }
  return renderedContent;
}

async function fetchWordPressRenderedPageContentFromUrl(
  apiUrl: string,
  sourcePageUrl: string,
  fetchImpl: typeof fetch
) {
  const response = await fetchImpl(apiUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": "TeeTimeSpot/1.0 (+https://teetimespot.com)"
    },
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`Official WordPress content returned HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (!contentType?.includes("application/json")) {
    throw new Error("Official WordPress content did not return JSON");
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_HTML_BYTES) {
    throw new Error("Official WordPress content is too large to inspect safely");
  }
  const body = await response.text();
  if (body.length > MAX_HTML_BYTES) {
    throw new Error("Official WordPress content exceeded the inspection limit");
  }
  const payload: unknown = JSON.parse(body);
  if (
    !isPlainRecord(payload) ||
    typeof payload.link !== "string" ||
    normalizeSourceKey(payload.link) !== normalizeSourceKey(sourcePageUrl) ||
    !isPlainRecord(payload.content) ||
    payload.content.protected !== false ||
    typeof payload.content.rendered !== "string"
  ) {
    throw new Error("Official WordPress content did not match the source page");
  }
  return payload.content.rendered;
}

function findWordPressRenderedPageContentUrl(
  sourceHtml: string,
  sourcePageUrl: string
) {
  const source = parseSafePublicUrl(sourcePageUrl);
  const decodedHtml = decodeHtmlEntities(sourceHtml);
  const candidates: string[] = [];
  for (const match of decodedHtml.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = readHtmlTagAttribute(tag, "rel")?.toLowerCase();
    const type = readHtmlTagAttribute(tag, "type")?.toLowerCase();
    const href = readHtmlTagAttribute(tag, "href");
    if (
      !rel?.split(/\s+/u).includes("alternate") ||
      type !== "application/json" ||
      !href
    ) {
      continue;
    }
    const resolved = resolveHttpUrl(href, source.toString());
    if (!resolved) {
      continue;
    }
    const candidate = parseSafePublicUrl(resolved);
    if (
      candidate.origin === source.origin &&
      /^\/wp-json\/wp\/v2\/pages\/[1-9]\d*\/?$/iu.test(candidate.pathname) &&
      !candidate.search &&
      !candidate.hash
    ) {
      candidates.push(candidate.toString());
    }
  }
  const uniqueCandidates = uniqueStrings(candidates);
  return uniqueCandidates.length === 1 ? uniqueCandidates[0] : null;
}

function readHtmlTagAttribute(tag: string, attribute: string) {
  const escapedAttribute = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(
    new RegExp(
      `(?:^|\\s)${escapedAttribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
      "i"
    )
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function isBookingLikeOfficialFollowup(candidate: {
  url: string;
  label: string;
}) {
  const parsed = parseSafePublicUrl(candidate.url);
  return /\b(?:book(?:ing)?|tee\s*times?|reservations?|reserve)\b/iu.test(
    `${candidate.label} ${parsed.pathname.replace(/[-_]+/gu, " ")}`
  );
}

function mergeHtmlEvidence(
  left: ReturnType<typeof extractHtmlEvidence>,
  right: ReturnType<typeof extractHtmlEvidence>
) {
  return {
    observedUrls: uniqueStrings([
      ...left.observedUrls,
      ...right.observedUrls
    ]),
    linkCandidates: uniqueLinkCandidates([
      ...left.linkCandidates,
      ...right.linkCandidates
    ]),
    visibleText: [left.visibleText, right.visibleText]
      .filter(Boolean)
      .join("\n")
      .slice(0, 12_000)
  };
}

function extractHtmlEvidence(html: string, pageUrl: string) {
  const observedUrls: string[] = [];
  const linkCandidates: Array<{ url: string; label: string }> = [];
  const decodedHtml = decodeHtmlEntities(html);
  const embeddedContent = decodeEmbeddedContent(decodedHtml);

  for (const match of decodedHtml.matchAll(
    /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi
  )) {
    const url = resolveHttpUrl(match[1] ?? match[2] ?? match[3], pageUrl);
    if (!url) {
      continue;
    }
    observedUrls.push(url);
    linkCandidates.push({ url, label: stripHtml(match[4] ?? "") });
  }

  for (const match of decodedHtml.matchAll(
    /\b(?:href|src|action)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi
  )) {
    const url = resolveHttpUrl(match[1] ?? match[2] ?? match[3], pageUrl);
    if (url) {
      observedUrls.push(url);
    }
  }

  for (const match of embeddedContent.matchAll(
    /"title"\s*:\s*"([^"]{1,160})"[\s\S]{0,600}?"(?:url|link)"\s*:\s*"([^"]+)"/gi
  )) {
    const url = resolveHttpUrl(match[2], pageUrl);
    if (!url) {
      continue;
    }
    observedUrls.push(url);
    linkCandidates.push({ url, label: match[1] });
  }

  for (const match of embeddedContent.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) {
    const url = resolveHttpUrl(match[0], pageUrl);
    if (url) {
      observedUrls.push(url);
    }
  }

  const widgetConfigs = [...decodedHtml.matchAll(
    /\bdata-widget-config\s*=\s*(?:"([^"]+)"|'([^']+)')/gi
  )]
    .map((match) => decodeWidgetConfig(match[1] ?? match[2]))
    .filter(Boolean)
    .join("\n");
  const relevantScripts = [...decodedHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1] ?? "")
    .filter((script) =>
      /window\.(?:courses|property|chronogolfSettings)|baseURL|courseId|schedule_id/i.test(script)
    )
    .join("\n")
    .slice(0, 8_000);
  const visibleText = [
    relevantScripts,
    widgetConfigs,
    stripHtml(
      decodedHtml
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<(?:style|nav|header)\b[^>]*>[\s\S]*?<\/(?:style|nav|header)>/gi, " ")
    )
  ]
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12_000);

  return {
    observedUrls: uniqueStrings(observedUrls),
    linkCandidates,
    visibleText
  };
}

function pickLikelyBookingCandidate(
  candidates: Array<{ url: string; label: string }>,
  currentUrl: string,
  courseName?: string
) {
  return candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreBookingCandidate(candidate, currentUrl, courseName)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.url;
}

function pickOfficialCourseDetailCandidate(
  candidates: Array<{ url: string; label: string }>,
  courseName: string | undefined,
  officialUrl: string
) {
  if (!courseName) {
    return undefined;
  }

  const officialOrigin = new URL(officialUrl).origin;
  const normalizedTarget = normalizeCourseLinkName(courseName);
  return candidates.find((candidate) => {
    const parsed = new URL(candidate.url);
    if (parsed.origin !== officialOrigin) {
      return false;
    }

    const normalizedLabel = normalizeCourseLinkName(
      candidate.label.replace(/\s*\([^)]*\)\s*$/u, "")
    );
    const pathSegment = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
    return (
      normalizedLabel === normalizedTarget ||
      normalizeCourseLinkName(pathSegment) === normalizedTarget ||
      haveCompatibleCourseNames(courseName, candidate.label) ||
      haveCompatibleCourseNames(courseName, pathSegment.replace(/[-_]+/g, " "))
    );
  })?.url;
}

function normalizeCourseLinkName(value: string) {
  return value.normalize("NFKD").replace(/[^a-z0-9]+/gi, "").toLowerCase();
}

function doesProviderLinkLabelExactlyIdentifyCourse(
  label: string,
  courseName: string
) {
  const courseLabel = label
    .replace(
      /^\s*(?:book(?:ing)?|reserve)(?:\s+(?:a|your))?\s+tee\s*times?(?:\s+(?:at|for))?(?:\s*[-:|]\s*|\s+)/i,
      ""
    )
    .replace(
      /\s*(?:[-:|]\s*)?(?:(?:general\s+public)\s+)?(?:tee\s*times?|online\s+booking|book\s+online|reservations?)\s*$/i,
      ""
    );
  return (
    Boolean(courseLabel.trim()) &&
    normalizeCourseLinkName(courseLabel) === normalizeCourseLinkName(courseName)
  );
}

function pickOfficialPolicyCandidate(
  candidates: Array<{ url: string; label: string }>,
  officialUrl: string
) {
  const officialOrigin = new URL(officialUrl).origin;
  return candidates
    .map((candidate) => {
      const parsed = new URL(candidate.url);
      const searchable = `${candidate.label} ${parsed.pathname}`;
      let score = 0;
      if (parsed.origin !== officialOrigin) {
        return { ...candidate, score: -1 };
      }
      if (/\bfaqs?\b/i.test(searchable)) {
        score += 50;
      }
      if (/\bterms? and conditions?\b|terms-and-conditions/i.test(searchable)) {
        score += 30;
      }
      if (/\b(?:registration|booking) instructions?\b/i.test(searchable)) {
        score += 20;
      }
      if (/\.(?:pdf|docx?)(?:$|[?#])/i.test(parsed.pathname)) {
        score -= 100;
      }
      return { ...candidate, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.url;
}

function pickPrivateClubInformationCandidate(
  candidates: Array<{ url: string; label: string }>,
  visibleText: string,
  currentUrl: string
) {
  if (!/\bPrivate Golf Club sites by MembersFirst\b/i.test(visibleText)) {
    return undefined;
  }

  const currentOrigin = new URL(currentUrl).origin;
  return candidates.find((candidate) => {
    const parsed = new URL(candidate.url);
    return (
      parsed.origin === currentOrigin &&
      (/^The Club$/i.test(candidate.label.trim()) || /\/public\/?$/i.test(parsed.pathname))
    );
  })?.url;
}

function scoreBookingCandidate(
  candidate: { url: string; label: string },
  currentUrl: string,
  courseName?: string
) {
  const parsed = new URL(candidate.url);
  const searchable = `${candidate.label} ${parsed.hostname} ${parsed.pathname} ${parsed.search}`;
  let score = 0;
  if (/foreupsoftware\.com|\.book\.teeitup\.(?:golf|com)|\.cps\.golf|\.teesnap\.net|fox\.tenfore\.golf/i.test(candidate.url)) {
    score += 100;
  }
  if (/tee.?times?/i.test(searchable)) {
    score += 25;
  }
  if (/book|reserve|reservation/i.test(searchable)) {
    score += 15;
  }
  if (
    courseName &&
    candidate.label &&
    haveCompatibleCourseNames(courseName, candidate.label)
  ) {
    score += 80;
  }
  if (courseName && parsed.hostname.endsWith(".cps.golf")) {
    const targetIdentity = normalizeCourseIdentityName(
      courseName.replace(/\b(?:and|at|of)\b/gi, " ")
    ).replace(/\s+/g, "");
    const tenant = parsed.hostname.split(".")[0]
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
    if (
      targetIdentity.length >= 4 &&
      (tenant.includes(targetIdentity) || targetIdentity.includes(tenant))
    ) {
      score += 80;
    }
  }
  if (normalizeSourceKey(candidate.url) === normalizeSourceKey(currentUrl)) {
    score -= 100;
  }
  if (/facebook\.com|instagram\.com|youtube\.com|linkedin\.com|twitter\.com|x\.com/i.test(parsed.hostname)) {
    score -= 100;
  }
  if (/\.(?:css|js|mjs|png|jpe?g|gif|webp|svg|ico|woff2?)(?:$|[?#])/i.test(parsed.pathname)) {
    score -= 100;
  }
  return score;
}

function parseSafePublicUrl(value: string) {
  const url = new URL(value);
  const hasInvalidPort = Boolean(
    url.port &&
    !(
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    )
  );
  if (
    !["http:", "https:"].includes(url.protocol) ||
    Boolean(url.username || url.password) ||
    hasInvalidPort ||
    url.hostname.endsWith(".") ||
    isPrivateHostname(url.hostname) ||
    isForbiddenProviderSurfaceHostname(url.hostname) ||
    hasSensitivePublicUrlState(url)
  ) {
    throw new Error("Official site URL is not a safe public HTTP address");
  }
  return url;
}

function isPrivateHostname(hostname: string) {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (
    !normalized.includes(".") ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".home") ||
    normalized.endsWith(".corp") ||
    normalized === "::1" ||
    (normalized.includes(":") &&
      (normalized.startsWith("fc") ||
        normalized.startsWith("fd") ||
        normalized.startsWith("fe80:"))) ||
    /^\d+$|^0x[\da-f]+$/i.test(normalized)
  ) {
    return true;
  }
  const ipv4 = normalized.split(".").map(Number);
  if (ipv4.length !== 4 || ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = ipv4;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function hasSensitivePublicUrlState(url: URL, nestingDepth = 0) {
  for (const [key, value] of url.searchParams) {
    const decodedKey = decodePublicUrlComponent(key);
    const decodedValue = decodePublicUrlComponent(value);
    if (
      !decodedKey ||
      decodedValue === null ||
      isSensitivePublicUrlKey(decodedKey) ||
      isContextualSensitivePublicUrlParameter(decodedKey, decodedValue, url) ||
      isOpaquePublicCredentialValue(decodedValue) ||
      hasUnsafeNestedPublicUrl(decodedValue, url, nestingDepth, decodedKey)
    ) {
      return true;
    }
  }
  const decodedPath = decodePublicUrlPath(url.pathname);
  if (!decodedPath) {
    return true;
  }
  const pathSegments = decodedPath
    .split(/[/;=]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const decodedHash = decodePublicUrlComponent(url.hash.slice(1));
  if (decodedHash === null) {
    return true;
  }
  if (hasSensitivePublicFragmentState(decodedHash, url, nestingDepth)) {
    return true;
  }
  const hashSegments = decodedHash
    .split(/[/;=?&]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return (
    pathSegments.some(isForbiddenPublicPathSegment) ||
    hasForbiddenAdjacentPublicPathSegments(pathSegments) ||
    hasRestrictedPublicBookingPathSegments(pathSegments) ||
    pathSegments.some((segment, index) =>
      (isOpaquePublicCredentialValue(segment) ||
        isOpaquePublicRedirectPathSegment(pathSegments, index)) &&
      !isAllowedPublicOpaquePathSegment(pathSegments, index)
    ) ||
    hashSegments.some(isForbiddenPublicPathSegment) ||
    hasForbiddenAdjacentPublicPathSegments(hashSegments) ||
    hasRestrictedPublicBookingPathSegments(hashSegments) ||
    hashSegments.some((segment, index) =>
      (isOpaquePublicCredentialValue(segment) ||
        isOpaquePublicRedirectPathSegment(hashSegments, index)) &&
      !isAllowedPublicOpaquePathSegment(hashSegments, index)
    )
  );
}

function hasForbiddenAdjacentPublicPathSegments(segments: string[]) {
  return segments.some((segment, index) => {
    if (index === 0) {
      return false;
    }
    const adjacent = `${segments[index - 1] ?? ""}${segment}`
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase();
    return isForbiddenCompactPublicSecurityRoute(adjacent);
  });
}

function hasRestrictedPublicBookingPathSegments(segments: string[]) {
  const normalized = segments.map((segment) =>
    segment
      .replace(/\.(?:aspx?|php\d?|s?html?|xhtml|jspx?|cfm|cgi|do|action)$/i, "")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase()
  );
  return normalized.some((segment, index) => {
    if (
      !/^(?:admins?|staff|members?|customers?|users?|clients?|partners?|employees?|secure|accounts?|myaccount|portal)(?:v?\d+)?$/.test(
        segment
      )
    ) {
      return false;
    }
    const tailSegments = normalized.slice(index + 1);
    return tailSegments.join("").includes("teetime") || tailSegments.some(
      (tailSegment) =>
        /^(?:book|booking|reserve|reservation|schedule|checkout|cart|portal|dashboard|account)$/.test(
          tailSegment
        )
    );
  });
}

function hasSensitivePublicFragmentState(
  value: string,
  parentUrl: URL,
  nestingDepth: number
) {
  const fragment = value.replace(/^\/+/, "");
  const queryLike = fragment.includes("?")
    ? fragment.slice(fragment.indexOf("?") + 1)
    : fragment;
  if (!queryLike.includes("=")) {
    return false;
  }
  return queryLike.split("&").some((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) {
      return false;
    }
    const key = decodePublicUrlComponent(part.slice(0, separator));
    const valuePart = decodePublicUrlComponent(part.slice(separator + 1));
    return (
      !key ||
      valuePart === null ||
      isSensitivePublicUrlKey(key) ||
      isContextualSensitivePublicUrlParameter(key, valuePart, parentUrl) ||
      isOpaquePublicCredentialValue(valuePart) ||
      hasUnsafeNestedPublicUrl(valuePart, parentUrl, nestingDepth, key)
    );
  });
}

function hasUnsafeNestedPublicUrl(
  value: string,
  parentUrl: URL,
  nestingDepth: number,
  parameterKey?: string
) {
  const trimmed = value.trim();
  if (
    nestingDepth >= 2 ||
    !(
      /^(?:https?:\/\/|\/\/|\/|\.\.?(?:\/|$))/i.test(trimmed) ||
      /^[^?#\s]+\/[^\s]*$/.test(trimmed) ||
      (parameterKey && isNavigationPublicUrlKey(parameterKey))
    )
  ) {
    return false;
  }
  try {
    const nested = new URL(trimmed, parentUrl);
    const hasInvalidPort = Boolean(
      nested.port &&
      !(
        (nested.protocol === "http:" && nested.port === "80") ||
        (nested.protocol === "https:" && nested.port === "443")
      )
    );
    return (
      !["http:", "https:"].includes(nested.protocol) ||
      Boolean(nested.username || nested.password) ||
      hasInvalidPort ||
      nested.hostname.endsWith(".") ||
      isPrivateHostname(nested.hostname) ||
      isForbiddenProviderSurfaceHostname(nested.hostname) ||
      hasSensitivePublicUrlState(nested, nestingDepth + 1)
    );
  } catch {
    return true;
  }
}

function isNavigationPublicUrlKey(value: string) {
  const normalized = value.normalize("NFKC").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return /^(?:url|uri|(?:next|continue|destination|dest|goto|return|redirect|success|cancel|callback|forward|target|relay)(?:to|url|uri|path|location|destination)?)$/.test(
    normalized
  );
}

function decodePublicUrlComponent(value: string) {
  let decoded = value;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        return decoded;
      }
      decoded = next;
    }
    return /%[0-9a-f]{2}/i.test(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

const decodePublicUrlPath = decodePublicUrlComponent;

function isForbiddenPublicPathSegment(value: string) {
  const normalized = value.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const tokens = getPublicSecurityTokens(value);
  const hasStrongSensitiveToken = tokens.some((token) =>
    /^(?:accounts?|myaccount|useraccount|memberaccount|customeraccount|login|signin|signup|logout|register|registration|session|jsessionid|signed|signature|token|auth\d*|authentication|authorize|authorization|oauth\d*|openid|oidc|sso\d*|saml|assertion|relaystate|ticket|credential|password|passwordless|secret|consent|mfa|2fa|webauthn|captcha|recaptcha|turnstile|queue|queueit|waitingroom|verify|verification|magiclink|invite|invitation|checkout)$/i.test(
      token
    )
  );
  const hasSensitiveFlowPair =
    tokens.some((token) =>
      /^(?:payment|pay|cart|purchase|order|challenge)$/i.test(token)
    ) &&
    tokens.some((token) =>
      /^(?:callback|redirect|flow|session|step|start|confirm|confirmation|verify|verification|response|request|status|page|wait|waiting|progress|acs|connect|provider|gateway|settings|reset|recover|recovery|forgot|checkout|booking|reservation)$/i.test(
        token
      )
    );
  const hasAccountSurfacePair =
    tokens.some((token) =>
      /^(?:admin|staff|member|customer|user)$/i.test(token)
    ) &&
    tokens.some((token) =>
      /^(?:account|dashboard|portal|profile|settings|login|signin)$/i.test(token)
    );
  const hasIdentityRecoveryPair =
    tokens.some((token) =>
      /^(?:forgot|reset|recover|recovery|confirm|confirmation|verify|verification)$/i.test(
        token
      )
    ) &&
    tokens.some((token) => /^(?:username|email|password|account)$/i.test(token));
  return (
    hasStrongSensitiveToken ||
    hasSensitiveFlowPair ||
    hasAccountSurfacePair ||
    hasIdentityRecoveryPair ||
    isForbiddenCompactPublicSecurityRoute(normalized) ||
    /^(?:checkout|securecheckout|payment|pay|cart|shoppingcart|purchase|order|myaccount|useraccount|memberaccount|customeraccount|account|accountlogin|accountsignin|accountsignup|accountportal|memberportal|customerportal|login|userlogin|memberlogin|customerlogin|loginredirect|signin|signup|logout|register|registration|createaccount|session|jsessionid|signed|signature|token|auth|authentication|authcallback|auth0|oauth\d*|oauthcallback|authorize|authorization|openid|oidc|sso|ssologin|saml|assertion|relaystate|ticket|credential|password|passwordless|resetpassword|passwordreset|secret|consent|mfa|2fa|webauthn|captcha|recaptcha|captchachallenge|turnstile|queue|queueit|waitingroom|challenge|challengeplatform|verify|verification|verifyemail|emailverification|magiclink|invite|invitation)$/.test(
      normalized
    ) ||
    /^(?:(?:forgot|reset|recover|recovery)(?:my)?(?:password|account)(?:confirm|confirmation)?|(?:password|account)(?:forgot|reset|recover|recovery|settings)(?:confirm|confirmation)?|(?:login|signin|auth|oauth\d*|oidc|sso)(?:callback|redirect|oidc|sso|oauth\d*)|(?:callback|redirect)(?:login|signin|auth|oauth\d*|oidc|sso)|(?:checkout|payment|captcha|recaptcha|queue|challenge)(?:session|flow|status|page|wait|waiting|redirect|response|confirm|confirmation|verify|verification|v\d+))$/.test(
      normalized
    )
  );
}

function isForbiddenCompactPublicSecurityRoute(normalized: string) {
  return (
    normalized.includes("login") ||
    /^(?:(?:admin|staff|member|customer|user|client|partner|employee|regional|secure)?(?:signon|logon))[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:saml|openid|oidc|oauth\d*|adfs|identity|idp|mfa|2fa|webauthn|captcha|recaptcha|hcaptcha|funcaptcha|turnstile|queue|queueit|waitingroom|checkout|authorize|authorization|authentication|signin|signup|logout|register|registration|password|session|token|magiclink|invite|invitation|verify|verification|wresult)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^auth\d*(?:callback|redirect|flow|session|step|start|confirm|confirmation|verify|verification|response|request|status|challenge|login|signin|provider|gateway|server|service|proxy)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^auth(?:n|z|enticate|entication|orize|orization)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:accounts?|myaccount|useraccount|memberaccount|customeraccount|clientaccount|partneraccount|employeeaccount|regionalaccount)(?:(?:login|signin|signup|portal|dashboard|profile|settings|callback|redirect|recovery|recover|reset|management|manage)[a-z0-9]*)?$/.test(
      normalized
    ) ||
    /^(?:login\d*|(?:admin|staff|member|customer|user|secure|portal|prod|tenant)login\d*)(?:callback|redirect|flow|session|step|start|portal|dashboard|secure|provider|gateway|us|eu|prod|dev|stage|staging|\d*)?$/.test(
      normalized
    ) ||
    /^(?:admin|staff|member|customer|user)(?:account|dashboard|portal|profile|settings|login|signin)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:members?|admin|staff|customer|user|client|partner|employee|regional|secure)(?:center|centre|booking|portal|dashboard|profile|settings|account)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:forgot|reset|recover|recovery|confirm|confirmation|verify|verification)(?:username|email|password|account)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:email|username)(?:verify|verification|confirm|confirmation|reset|recovery)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^billing(?:portal|account|history|settings|payment|invoices?|details?)?$/.test(
      normalized
    ) ||
    /^payment[a-z0-9]*$/.test(normalized) ||
    /^(?:credentials?|signature|signed(?:url)?|assertion|relaystate|consent|jsessionid|authcode|nonce|jwt|bearer)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:token|secret|ticket)[a-z0-9]*$/.test(normalized) ||
    /^(?:access|refresh|id|api|client|service|login|auth)(?:token|key|secret|ticket)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:pay(?:portal|account|method|ment)?|basket|shoppingbag|placeorder|completepurchase|orderhistory|purchasehistory|transactionhistory)$/.test(
      normalized
    ) ||
    /^(?:order|cart)(?:review|summary|confirm|confirmation|checkout|payment|billing)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:booking|reservation|cart)(?:payment|checkout)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:payment|pay|cart|purchase|order|challenge)(?:callback|redirect|flow|session|step|start|confirm|confirmation|verify|verification|response|request|status|page|wait|waiting|progress|checkout)[a-z0-9]*$/.test(
      normalized
    )
  );
}

function getPublicSecurityTokens(value: string) {
  return value
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSensitivePublicUrlKey(value: string) {
  const normalized = value.normalize("NFKC").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    /^(?:token|secret|nonce|jwt|ticket|loginticket|serviceticket|authorization|signature|signed|sig|credential|password|expires?|expiry|expiration|assertion|relaystate|saml(?:response|art)?|oauth(?:token|code|state|verifier)?|authcode|verificationcode|session(?:id|token|key|state)?|clientid|responsetype|redirecturi|granttype|scope|codechallenge|codeverifier|(?:access|auth|id|api|client)(?:token|key|secret))$/.test(
      normalized
    ) ||
    /^(?:saml|oauth|openid|oidc|auth|authentication|login)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:sigalg|openidmode|openidreturnto|openidclaimedid|openididentity|openidrealm|openidassochandle|openidresponse(?:nonce)?|samlrequest|oauthnonce|oauthcallback)$/.test(
      normalized
    ) ||
    /^(?:prompt|codechallengemethod|responsemode|wresult|wctx|wreply|wtrealm|wa)$/.test(
      normalized
    ) ||
    /^(?:csrf|csrftoken|xcsrftoken|csrfmiddlewaretoken|xsrf|xsrftoken|formkey|requestverificationtoken|antiforgerytoken|anticsrftoken|authenticitytoken|verificationtoken|checkoutsessionid|paymentintent|orderid|transactionid|invoiceid|cartid)$/.test(
      normalized
    ) ||
    /(?:password|credential|signature|authorization|assertion|relaystate)/.test(
      normalized
    )
  );
}

function isContextualSensitivePublicUrlParameter(key: string, value: string, url: URL) {
  const normalizedKey = key
    .normalize("NFKC")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  if (!/^(?:code|state|key)$/.test(normalizedKey)) {
    return false;
  }
  const hasAuthenticationContext = `${url.hostname}/${url.pathname}`
    .split(/[./_-]+/u)
    .map((segment) => segment.replace(/[^a-z0-9]/gi, "").toLowerCase())
    .some((segment) =>
      /^(?:callback(?:v?\d+)?|(?:auth(?:entication|orization|enticate|orize|n|z)?|oauth\d*|oidc|openid|saml|sso|signin|login)(?:callback(?:v?\d+)?)?)$/.test(
        segment
      )
    );
  const hasSensitiveCompanion = [...url.searchParams.keys()].some((candidate) => {
    const normalizedCandidate = candidate
      .normalize("NFKC")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase();
    return normalizedCandidate !== normalizedKey && isSensitivePublicUrlKey(candidate);
  });
  const hasSecretShapedValue = /(?:^|[^a-z0-9])(?:private|secret|token|credential|signature|session|nonce|ticket|auth)(?:[^a-z0-9]|$)/i.test(
    value
  );
  return hasAuthenticationContext || hasSensitiveCompanion || hasSecretShapedValue;
}

function isOpaquePublicCredentialValue(value: string) {
  return (
    /^(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9_-]{12,}$/i.test(value) ||
    /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(value) ||
    /^[A-Za-z0-9+/_-]{16,}={1,2}$/.test(value) ||
    (/^[A-Za-z0-9]{19,}$/.test(value) &&
      /[A-Za-z]/.test(value) &&
      /\d/.test(value)) ||
    (/^[A-Za-z]{19,}$/.test(value) &&
      /[a-z]/.test(value) &&
      /[A-Z]/.test(value))
  );
}

function isAllowedPublicOpaquePathSegment(segments: string[], index: number) {
  return (
    /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(
      segments[index] ?? ""
    ) &&
    /^(?:programs?|courses?)$/i.test(segments[index - 1] ?? "")
  );
}

function isOpaquePublicRedirectPathSegment(segments: string[], index: number) {
  return (
    /^(?:go|r|redirect|link|magic|invite|token)$/i.test(segments[index - 1] ?? "") &&
    /^[A-Za-z0-9_-]{16,}$/.test(segments[index] ?? "")
  );
}

function isForbiddenProviderSurfaceHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.+$/u, "");
  const hasForbiddenLabel = normalized.split(".").some((label) => {
    const compact = label.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const tokens = getPublicSecurityTokens(label);
    return (
      isForbiddenCompactPublicSecurityRoute(compact) ||
      /^(?:(?:secure|portal|customer|member|user|prod|tenant)?(?:accounts?|myaccount|login|signin|auth\d*|authentication|authorize|sso\d*|oauth\d*|oidc|idp|identity|checkout|queue|captcha|challenge|verify|register|registration)(?:secure|portal|gateway|provider|login)?|(?:accounts?|myaccount|login|signin|auth\d*|authentication|authorize|sso\d*|oauth\d*|oidc|idp|identity|checkout|queue|captcha|challenge|verify|register|registration)(?:secure|portal|gateway|provider))$/.test(
        compact
      ) ||
      tokens.some((token) =>
        /^(?:accounts?|myaccount|login\d*|signin|auth\d*|authentication|authorization|authorize|sso\d*|oauth\d*|openid|oidc|saml|adfs|idp|identity|identityserver|checkout|queue|queueit|waitingroom|captcha|recaptcha|hcaptcha|funcaptcha|turnstile|mfa|2fa|webauthn|verify|verification|register|registration)$/i.test(
          token
        )
      ) ||
      /^(?:(?:admin|staff|member|customer|user|secure|portal|prod|tenant)?(?:login\d*|accounts?|myaccount|auth\d*|authentication|authorization|authorize|sso\d*|oauth\d*|openid|oidc|saml|adfs|idp|identity(?:server|provider)?|checkout|queue|queueit|waitingroom|captcha|recaptcha|hcaptcha|funcaptcha|turnstile|challenge|mfa|2fa|webauthn|verify|verification|register|registration)(?:us|eu|prod|dev|stage|staging|secure|portal|gateway|provider|server|callback|redirect|flow|session|step|start|connect|progress|challenge|platform|dashboard|settings|acs|authnrequest|request|response|confirm|confirmation|verification|verify|\d*)?)$/.test(
        compact
      ) ||
      /^(?:admin|staff|member|customer|user)(?:account|dashboard|portal|profile|settings|login|signin)[a-z0-9]*$/.test(
        compact
      ) ||
      /^(?:arkose|arkoselabs|okta|onelogin|cloudflareaccess)$/.test(
        compact
      )
    );
  });
  return (
    hasForbiddenLabel ||
    normalized === "queue-it.net" ||
    normalized.endsWith(".queue-it.net") ||
    normalized === "challenges.cloudflare.com" ||
    normalized === "hcaptcha.com" ||
    normalized.endsWith(".hcaptcha.com") ||
    normalized === "funcaptcha.com" ||
    normalized.endsWith(".funcaptcha.com") ||
    normalized === "arkoselabs.com" ||
    normalized.endsWith(".arkoselabs.com") ||
    normalized === "auth0.com" ||
    normalized.endsWith(".auth0.com") ||
    normalized === "okta.com" ||
    normalized.endsWith(".okta.com") ||
    normalized === "onelogin.com" ||
    normalized.endsWith(".onelogin.com") ||
    normalized === "cloudflareaccess.com" ||
    normalized.endsWith(".cloudflareaccess.com")
  );
}

function resolveHttpUrl(value: string | undefined, baseUrl: string) {
  const normalized = value?.trim();
  if (
    !normalized ||
    normalized.startsWith("#") ||
    normalized.startsWith("mailto:") ||
    normalized.startsWith("tel:") ||
    normalized.includes("\\") ||
    /(?:%22|<%|%3c%25)/i.test(normalized)
  ) {
    return null;
  }
  try {
    const resolved = new URL(normalized, baseUrl).toString();
    if (/(?:%22|%3c%25)/i.test(resolved)) {
      return null;
    }
    return parseSafePublicUrl(resolved).toString();
  } catch {
    return null;
  }
}

function buildFailedDiscovery(input: {
  courseId: string;
  sourceUrl: string;
  detectedPlatform: string;
  message: string;
}): BrowserDiscovery {
  const detectedPlatform = [
    "FOREUP",
    "GOLFNOW",
    "TEEITUP",
    "CHRONOGOLF",
    "CLUB_CADDIE",
    "CUSTOM"
  ].includes(input.detectedPlatform)
    ? (input.detectedPlatform as BrowserDiscovery["detectedPlatform"])
    : "UNKNOWN";
  return {
    courseId: input.courseId,
    status: "FAILED",
    detectedPlatform,
    sourceUrl: input.sourceUrl,
    confidence: 0,
    evidence: {
      observedUrls: [input.sourceUrl],
      visibleText: input.message.slice(0, 500),
      learnedFrom: "official-site-fetch-failed"
    }
  };
}

function decodeWidgetConfig(value: string) {
  try {
    return Buffer.from(value, "base64").toString("utf8").slice(0, 8_000);
  } catch {
    return "";
  }
}

function decodeHtmlEntities(value: string) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function decodeEmbeddedContent(value: string) {
  return value
    .replace(/\\u003c/gi, "<")
    .replace(/\\u003e/gi, ">")
    .replace(/\\u003a/gi, ":")
    .replace(/\\u002f/gi, "/")
    .replace(/\\u0026/gi, "&")
    .replaceAll("\\/", "/")
    .replaceAll('\\"', '"');
}

function stripHtml(value: string) {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeSourceKey(value: string) {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (isTrackingQueryParameter(key)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  return url.toString();
}

function isTrackingQueryParameter(key: string) {
  return /^(?:utm_(?:campaign|content|id|medium|source|term)|_gl|dclid|fbclid|gclid|mc_cid|mc_eid|msclkid)$/i.test(
    key
  );
}

function uniqueStrings(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function uniqueLinkCandidates(values: Array<{ url: string; label: string }>) {
  const seen = new Set<string>();
  return values.filter((candidate) => {
    const key = `${candidate.url}\u0000${candidate.label}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
