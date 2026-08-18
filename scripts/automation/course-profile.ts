import "./load-local-env";

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  MAX_BOOKING_WINDOW_DAYS_AHEAD,
  normalizeReleaseTime
} from "@/lib/courses/booking-window";
import { recordCourseBookingWindowEvidence,
  recordCoursePhysicalLayoutEvidence } from "@/lib/automation/db-service";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { isSafeManualEvidenceUrl } from "@/lib/automation/browser-discovery";
import { normalizeLayoutHoleCounts } from "@/lib/courses/course-layout";
import {
  haveCompatibleOfficialPageCourseNames,
  isConflictingOfficialPageCourseIdentity,
  isOfficialOrganizationIdentityCorroboratedByUrl,
  normalizeOfficialPagePresentationIdentity
} from "@/lib/places/course-identity";
import { applyCourseProfileDraft, createCourseProfileSlugAlias, getCourseProfileResearchPacket, listCourseProfileQueue } from "@/lib/course-profiles/service";
import { prisma } from "@/lib/prisma";

export function parseCourseProfileCommand(args: readonly string[]) {
  const action = args[0];
  const apply = args.includes("--apply");
  const value = (option: string) => {
    const index = args.indexOf(option);
    return index >= 0 ? args[index + 1] : undefined;
  };
  if (action === "queue") return { action, limit: Number(value("--limit") ?? 3) } as const;
  if (action === "cohort") return { action } as const;
  if (action === "verify-profiles") {
    const stateCode = value("--state")?.trim().toUpperCase();
    if (!stateCode || !/^[A-Z]{2}$/.test(stateCode)) {
      throw new Error("verify-profiles requires a two-letter --state");
    }
    return { action, stateCode } as const;
  }
  if (action === "research") {
    const courseId = value("--course-id");
    if (!courseId) throw new Error("research requires --course-id");
    return { action, courseId } as const;
  }
  if (action === "booking-window") {
    const courseId = value("--course-id");
    const daysAheadValue = value("--days-ahead");
    const releaseTimeValue = value("--release-time");
    const evidenceUrl = value("--evidence-url");
    if (!courseId || daysAheadValue === undefined || !evidenceUrl) {
      throw new Error(
        "booking-window requires --course-id, --days-ahead, and --evidence-url"
      );
    }
    const daysAhead = Number(daysAheadValue);
    if (
      !Number.isInteger(daysAhead) ||
      daysAhead < 0 ||
      daysAhead > MAX_BOOKING_WINDOW_DAYS_AHEAD
    ) {
      throw new Error(
        `--days-ahead must be an integer from 0 to ${MAX_BOOKING_WINDOW_DAYS_AHEAD}`
      );
    }
    const releaseTimeLocal = releaseTimeValue
      ? normalizeReleaseTime(releaseTimeValue)
      : null;
    if (releaseTimeValue && !releaseTimeLocal) {
      throw new Error("--release-time must be a valid course-local time");
    }
    let parsedEvidenceUrl: URL;
    try {
      parsedEvidenceUrl = new URL(evidenceUrl);
    } catch {
      throw new Error("--evidence-url must be an HTTP(S) URL");
    }
    if (
      !/^https?:$/.test(parsedEvidenceUrl.protocol) ||
      parsedEvidenceUrl.username ||
      parsedEvidenceUrl.password ||
      /^(?:localhost|127\.|0\.0\.0\.0$|\[?::1\]?$)/i.test(parsedEvidenceUrl.hostname)
    ) {
      throw new Error("--evidence-url must be an HTTP(S) URL");
    }
    return {
      action,
      courseId,
      daysAhead,
      releaseTimeLocal,
      evidenceUrl: parsedEvidenceUrl.toString(),
      apply
    } as const;
  }
  if (action === "physical-layout") {
    const courseId = value("--course-id");
    const holesValue = value("--holes");
    const evidenceUrl = value("--evidence-url");
    const verifiedAtValue = value("--verified-at");
    if (!courseId || !holesValue || !evidenceUrl || !verifiedAtValue) {
      throw new Error(
        "physical-layout requires --course-id, --holes, --evidence-url, and --verified-at"
      );
    }
    const requestedHoleCounts = holesValue
      .split(",")
      .map((entry) => Number(entry.trim()));
    const holeCounts = normalizeLayoutHoleCounts(requestedHoleCounts);
    if (
      holeCounts.length === 0 ||
      holeCounts.length !== requestedHoleCounts.length
    ) {
      throw new Error("--holes must contain unique 9 and/or 18 values");
    }
    const parsedEvidenceUrl = parsePublicEvidenceUrl(evidenceUrl);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(verifiedAtValue)) {
      throw new Error(
        "--verified-at must be a calendar date in YYYY-MM-DD form"
      );
    }
    const verifiedAt = new Date(`${verifiedAtValue}T00:00:00.000Z`);
    if (
      !Number.isFinite(verifiedAt.getTime()) ||
      verifiedAt.toISOString().slice(0, 10) !== verifiedAtValue
    ) {
      throw new Error(
        "--verified-at must be a calendar date in YYYY-MM-DD form"
      );
    }
    if (verifiedAt.getTime() > Date.now()) {
      throw new Error("--verified-at cannot be in the future");
    }
    return {
      action,
      courseId,
      holeCounts,
      evidenceUrl: parsedEvidenceUrl.toString(),
      verifiedAt,
      apply
    } as const;
  }
  if (action === "alias") {
    const courseId = value("--course-id");
    const slug = value("--slug");
    if (!courseId || !slug) throw new Error("alias requires --course-id and --slug");
    return { action, courseId, slug, apply } as const;
  }
  if (action === "upsert") return { action, apply, file: value("--file") } as const;
  throw new Error(
    'Expected "cohort", "queue", "research", "verify-profiles", "booking-window", "physical-layout", "alias", or "upsert"');
}

function parsePublicEvidenceUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("--evidence-url must be an HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    /^(?:localhost|127\.|0\.0\.0\.0$|\[?::1\]?$)/iu.test(parsed.hostname) ||
    !isSafeManualEvidenceUrl(parsed)
  ) {
    throw new Error("--evidence-url must be an HTTP(S) URL");
  }
  return parsed;
}

export async function executeCourseProfileCommand(command: ReturnType<typeof parseCourseProfileCommand>, stdin = process.stdin,
  fetchImpl?: typeof fetch) {
  if (command.action === "cohort") {
    return prisma.course.findMany({
      where: { automationEligibility: "ALLOWED", address: { contains: "CT" } },
      orderBy: { name: "asc" },
      select: {
        id: true, googlePlaceId: true, name: true, address: true, latitude: true, longitude: true,
        website: true, detectedBookingUrl: true, bookingWindowEvidenceUrl: true,
        bookingWindowDaysAhead: true, bookingReleaseTimeLocal: true
      }
    });
  }
  if (command.action === "queue") return listCourseProfileQueue(command.limit);
  if (command.action === "research") return getCourseProfileResearchPacket(command.courseId);
  if (command.action === "verify-profiles") {
    const courses = await prisma.course.findMany({
      where: {
        automationEligibility: "ALLOWED",
        OR: [
          { stateCode: command.stateCode },
          { address: { contains: `, ${command.stateCode}` } }
        ]
      },
      select: {
        profile: {
          select: {
            id: true,
            sources: { select: { id: true } }
          }
        }
      }
    });
    const missingProfiles = courses.filter((course) => !course.profile).length;
    const missingSources = courses.filter(
      (course) => course.profile && course.profile.sources.length === 0
    ).length;
    return {
      stateCode: command.stateCode,
      courses: courses.length,
      profiles: courses.length - missingProfiles,
      missingProfiles,
      missingSources,
      valid: missingProfiles === 0 && missingSources === 0
    };
  }
  if (command.action === "booking-window") {
    const course = await prisma.course.findUnique({
      where: { id: command.courseId },
      select: {
        id: true,
        name: true,
        bookingWindowDaysAhead: true,
        bookingReleaseTimeLocal: true,
        bookingWindowSource: true,
        bookingWindowConfidence: true,
        bookingWindowEvidenceUrl: true,
        bookingWindowCheckedAt: true,
        bookingWindowObservedAt: true
      }
    });
    if (!course) throw new Error(`Course ${command.courseId} was not found`);

    const proposed = {
      bookingWindowDaysAhead: command.daysAhead,
      bookingReleaseTimeLocal: command.releaseTimeLocal,
      bookingWindowSource: "OFFICIAL_BOOKING_PAGE" as const,
      bookingWindowConfidence: 1,
      bookingWindowEvidenceUrl: command.evidenceUrl
    };
    if (!command.apply) {
      return { apply: false, course, proposed };
    }

    const observedAt = new Date();
    const updated = await recordCourseBookingWindowEvidence({
      courseId: command.courseId,
      evidence: {
        daysAhead: command.daysAhead,
        releaseTimeLocal: command.releaseTimeLocal,
        source: "OFFICIAL_BOOKING_PAGE",
        confidence: 1,
        evidenceUrl: command.evidenceUrl
      },
      observedAt,
      source: "OPERATOR_CLI"
    });
    return {
      apply: true,
      course: {
        id: updated.id,
        name: updated.name,
        bookingWindowDaysAhead: updated.bookingWindowDaysAhead,
        bookingReleaseTimeLocal: updated.bookingReleaseTimeLocal,
        bookingWindowSource: updated.bookingWindowSource,
        bookingWindowConfidence: updated.bookingWindowConfidence,
        bookingWindowEvidenceUrl: updated.bookingWindowEvidenceUrl,
        bookingWindowCheckedAt: updated.bookingWindowCheckedAt,
        bookingWindowObservedAt: updated.bookingWindowObservedAt
      }
    };
  }
  if (command.action === "physical-layout") {
    const course = await prisma.course.findUnique({
      where: { id: command.courseId },
      select: {
        id: true,
        name: true,
        layoutHoleCounts: true,
        layoutHolesEvidenceUrl: true,
        layoutHolesVerifiedAt: true,
        updatedAt: true
      }
    });
    if (!course) throw new Error(`Course ${command.courseId} was not found`);

    const source = await fetchPhysicalLayoutEvidence(
      command.evidenceUrl,
      fetchImpl ?? createPhysicalLayoutEvidenceFetch()
    );
    if (
      !doesOfficialPageCorroboratePhysicalLayout(
        source.html,
        course.name,
        command.holeCounts,
        source.finalUrl
      )
    ) {
      throw new Error(
        "The physical-layout source title/H1 does not corroborate the exact course and requested hole count"
      );
    }

    const proposed = {
      layoutHoleCounts: command.holeCounts,
      layoutHolesEvidenceUrl: source.finalUrl,
      layoutHolesVerifiedAt: command.verifiedAt
    };
    if (!command.apply) {
      return { apply: false, course, proposed };
    }

    const updated = await recordCoursePhysicalLayoutEvidence({
      courseId: command.courseId,
      holeCounts: command.holeCounts,
      evidenceUrl: source.finalUrl,
      verifiedAt: command.verifiedAt,
      expectedUpdatedAt: course.updatedAt,
      expectedName: course.name,
      source: "OPERATOR_CLI"
    });
    return {
      apply: true,
      course: {
        id: updated.id,
        name: updated.name,
        layoutHoleCounts: updated.layoutHoleCounts,
        layoutHolesEvidenceUrl: updated.layoutHolesEvidenceUrl,
        layoutHolesVerifiedAt: updated.layoutHolesVerifiedAt
      }
    };
  }
  if (command.action === "alias") return createCourseProfileSlugAlias(command.courseId, command.slug, command.apply);
  const input = command.file ? await readFile(command.file, "utf8") : await readStdin(stdin);
  return applyCourseProfileDraft(JSON.parse(input) as unknown, command.apply);
}

function createPhysicalLayoutEvidenceFetch() {
  return createAddressPinnedPublicFetchTransport({
    parseUrl: (value) => parsePublicEvidenceUrl(value),
    maxResponseBytes: 1_500_000,
    redirectLimit: 0,
    timeoutMs: 10_000
  });
}

async function fetchPhysicalLayoutEvidence(
  sourceUrl: string,
  fetchImpl: typeof fetch
) {
  let currentUrl = parsePublicEvidenceUrl(sourceUrl).toString();
  for (let redirectCount = 0; redirectCount <= 4; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9",
        "User-Agent":
          "Tee Time Spot course evidence verifier (+https://teetimespot.com/)"
      }
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirectCount === 4) {
        throw new Error(
          "The physical-layout evidence source returned an incomplete redirect"
        );
      }
      currentUrl = parsePublicEvidenceUrl(
        new URL(location, currentUrl).toString()
      ).toString();
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `The physical-layout evidence source returned HTTP ${response.status}`
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (
      contentType &&
      !/\b(?:text\/html|application\/xhtml\+xml)\b/iu.test(contentType)
    ) {
      throw new Error(
        "The physical-layout evidence source is not an HTML page"
      );
    }
    const html = await response.text();
    if (Buffer.byteLength(html, "utf8") > 1_500_000) {
      throw new Error(
        "The physical-layout evidence source is too large to inspect safely"
      );
    }
    return { finalUrl: currentUrl, html };
  }
  throw new Error(
    "The physical-layout evidence source exceeded the redirect limit"
  );
}

function doesOfficialPageCorroboratePhysicalLayout(
  html: string,
  courseName: string,
  holeCounts: readonly (9 | 18)[],
  pageUrl: string
) {
  const identities = [
    ...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/giu),
    ...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/giu)
  ]
    .map((match) => decodeHtmlText(match[1] ?? ""))
    .filter(Boolean);
  if (identities.length === 0) {
    return false;
  }

  const identityStatuses = identities.map((identity) => {
    const variants = getOfficialIdentityVariants(identity);
    const statuses = variants.map((variant) => {
      if (
        haveCompatibleOfficialPageCourseNames(courseName, variant) ||
        holeCounts.some((holes) =>
          doesIdentityMatchVerifiedPhysicalLayout(courseName, variant, holes)
        )
      ) {
        return "MATCH" as const;
      }
      if (isOfficialOrganizationIdentityCorroboratedByUrl(variant, pageUrl)) {
        return "ABSENT" as const;
      }
      return isConflictingOfficialPageCourseIdentity(courseName, variant)
        ? ("CONFLICT" as const)
        : ("ABSENT" as const);
    });
    if (statuses.includes("CONFLICT")) {
      return "CONFLICT" as const;
    }
    return statuses.includes("MATCH")
      ? ("MATCH" as const)
      : ("ABSENT" as const);
  });
  if (identityStatuses.includes("CONFLICT")) {
    return false;
  }
  return holeCounts.every((holes) =>
    identities.some((identity) =>
      getOfficialIdentityVariants(identity).some((variant) =>
        doesIdentityMatchVerifiedPhysicalLayout(courseName, variant, holes)
      )
    )
  );
}

function doesIdentityMatchVerifiedPhysicalLayout(
  courseName: string,
  pageIdentity: string,
  holes: 9 | 18
) {
  const words = holes === 9 ? "nine" : "eighteen";
  const qualifier = new RegExp(
    `\\b(?:${holes}|${words})(?:\\s*[- ]?\\s*holes?)?\\b`,
    "iu"
  );
  if (!qualifier.test(pageIdentity)) {
    return false;
  }
  const unqualified = pageIdentity
    .replace(qualifier, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return haveCompatibleOfficialPageCourseNames(courseName, unqualified);
}

function getOfficialIdentityVariants(identity: string) {
  const segments = identity
    .split(/\s+(?:\||[–—]|-\s)\s*/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return (segments.length > 1 ? segments : [identity])
    .map(normalizeOfficialPagePresentationIdentity)
    .filter(
      (value, index, values): value is string =>
        Boolean(value) && values.indexOf(value) === index
    );
}

function decodeHtmlText(value: string) {
  return value
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;|&#38;/giu, "&")
    .replace(/&quot;|&#34;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;|&#60;/giu, "<")
    .replace(/&gt;|&#62;/giu, ">")
    .replace(/\s+/gu, " ")
    .trim();
}

function readStdin(stream: NodeJS.ReadableStream) {
  return new Promise<string>((resolve, reject) => {
    let input = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { input += chunk; });
    stream.on("end", () => resolve(input));
    stream.on("error", reject);
  });
}

async function main() {
  const result = await executeCourseProfileCommand(parseCourseProfileCommand(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : "Course profile command failed"); process.exitCode = 1; }).finally(() => prisma.$disconnect());
}
