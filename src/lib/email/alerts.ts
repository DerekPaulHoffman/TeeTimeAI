import { createHash } from "node:crypto";

import { Resend, type ErrorResponse } from "resend";

import { getRenderedAvailabilityTimes, renderCustomerEmail } from "@/lib/email/customer-email";
import { isVercelProduction } from "@/lib/env";
import { renderSearchStatusHtml, type SearchStatusEmailInput } from "@/lib/email/search-status";
import { buildEmailStopUrls, type EmailStopUrls } from "@/lib/email/search-actions";
import { DEFAULT_TIME_ZONE, normalizeTimeZone } from "@/lib/timezones";

export type TeeTimeAlertMatch = {
  courseId?: string;
  courseName: string;
  courseRank?: number;
  courseAddress?: string;
  courseTimeZone?: string;
  startsAt: Date;
  availableSpots: number;
  bookingUrl: string;
  priceCents?: number | null;
  holes?: number | null;
  bookableHoleCounts?: Array<9 | 18>;
  factLine?: string;
  courseGuideUrl?: string;
  isNew?: boolean;
};

export type TeeTimeAlertInput = {
  to: string;
  searchId: string;
  matches: TeeTimeAlertMatch[];
  userTimeZone?: string;
  idempotencyKey?: string;
  stableIdempotencyKey?: string;
  stopUrls?: EmailStopUrls;
  targetDate?: string;
  startTime?: string;
  endTime?: string;
  players?: number;
  requestedLayoutHoles?: 9 | 18 | null;
  checkedAt?: Date;
  assetBaseUrl?: string;
};

export function getRenderedTeeTimeAlertMatchIds(
  matches: Array<TeeTimeAlertMatch & { matchId: string }>
) {
  const courseGroups = new Map<string, Array<TeeTimeAlertMatch & { matchId: string }>>();
  for (const match of matches) {
    const key = match.courseId ?? `${match.courseRank ?? "x"}:${match.courseName}`;
    const group = courseGroups.get(key) ?? [];
    group.push(match);
    courseGroups.set(key, group);
  }

  return [...courseGroups.values()].flatMap((courseMatches) => {
    return getRenderedAvailabilityTimes(courseMatches, courseMatches[0]?.courseTimeZone).map(
      (match) => match.matchId
    );
  });
}

type TeeTimeAlertWindow = {
  matches: TeeTimeAlertMatch[];
  startsAt: Date;
  endsAt: Date;
};

export type EmailDelivery =
  | {
      id: string;
      deliveryStatus: "dry_run";
    }
  | {
      id?: string;
      deliveryStatus: "sent";
    };

export class EmailDeliveryConfigurationError extends Error {
  readonly code = "EMAIL_DELIVERY_NOT_CONFIGURED";
  readonly retryable = true;

  constructor() {
    super("Email delivery is temporarily unavailable.");
    this.name = "EmailDeliveryConfigurationError";
  }
}

export class EmailDeliveryNotAcceptedError extends Error {
  readonly code = "EMAIL_DELIVERY_NOT_ACCEPTED";
  readonly retryable = true;
  readonly providerCode: ErrorResponse["name"] | null;

  constructor(message: string, providerCode: ErrorResponse["name"] | null = null) {
    super(message);
    this.name = "EmailDeliveryNotAcceptedError";
    this.providerCode = providerCode;
  }
}

export type OperatorEmailDelivery =
  | EmailDelivery
  | {
      deliveryStatus: "not_configured";
    };

export type AutomationWorkerHealthEmailInput = {
  workerKey: string;
  event: "overdue" | "recovered";
  expectedAt: Date;
  observedAt: Date;
};

export async function sendTeeTimeAlert(input: TeeTimeAlertInput): Promise<EmailDelivery> {
  const apiKey = normalizeEmailEnvValue(process.env.RESEND_API_KEY);
  const from = normalizeEmailEnvValue(process.env.ALERT_EMAIL_FROM);

  if (shouldDryRunRecipient(input.to)) {
    console.warn("[email:dry-run]", {
      recipientRef: createLogReference(input.to),
      searchRef: createLogReference(input.searchId),
      matchingTimes: input.matches.length,
      courses: new Set(input.matches.map((match) => match.courseName)).size
    });
    return { id: "dry-run", deliveryStatus: "dry_run" };
  }
  if (!apiKey || !from) {
    if (isVercelProduction()) {
      throw new EmailDeliveryConfigurationError();
    }
    console.warn("[email:not-configured-dry-run]", {
      recipientRef: createLogReference(input.to),
      searchRef: createLogReference(input.searchId),
      matchingTimes: input.matches.length
    });
    return { id: "dry-run", deliveryStatus: "dry_run" };
  }

  const resend = new Resend(apiKey);
  const stopUrls =
    input.stopUrls ??
    buildStableEmailStopUrls(input.searchId, input.matches[0]?.startsAt.toISOString().slice(0, 10));
  const email = {
    from,
    to: input.to,
    subject: getMatchAlertSubject(input.matches),
    html: renderAlertHtml({
      ...input,
      stopUrls
    })
  };
  const result = await resend.emails.send(
    email,
    input.stableIdempotencyKey || input.idempotencyKey
      ? {
          headers: {
            "Idempotency-Key":
              input.stableIdempotencyKey ??
              buildContentScopedEmailIdempotencyKey(input.idempotencyKey!, email)
          }
        }
      : undefined
  );

  if (result.error) {
    throw new EmailDeliveryNotAcceptedError(result.error.message, result.error.name);
  }

  return { ...result.data, deliveryStatus: "sent" };
}

export async function sendSearchStatusEmail(input: SearchStatusEmailInput): Promise<EmailDelivery> {
  const apiKey = normalizeEmailEnvValue(process.env.RESEND_API_KEY);
  const from = normalizeEmailEnvValue(process.env.ALERT_EMAIL_FROM);

  if (shouldDryRunRecipient(input.to)) {
    console.warn("[email:status-dry-run]", {
      recipientRef: createLogReference(input.to),
      searchRef: createLogReference(input.searchId),
      kind: input.kind,
      targetDate: input.targetDate,
      courses: input.courses.length
    });
    return { id: "dry-run", deliveryStatus: "dry_run" };
  }
  if (!apiKey || !from) {
    if (isVercelProduction()) {
      throw new EmailDeliveryConfigurationError();
    }
    console.warn("[email:status-not-configured-dry-run]", {
      recipientRef: createLogReference(input.to),
      searchRef: createLogReference(input.searchId),
      kind: input.kind,
      targetDate: input.targetDate
    });
    return { id: "dry-run", deliveryStatus: "dry_run" };
  }

  const email = {
    from,
    to: input.to,
    subject:
      input.kind === "setup"
        ? "Your Tee Time Spot search is active"
        : "Your morning Tee Time Spot update",
    html: renderSearchStatusHtml({
      ...input,
      stopUrls: input.stopUrls ?? buildStableEmailStopUrls(input.searchId, input.targetDate)
    })
  };
  const result = await new Resend(apiKey).emails.send(
    email,
    input.stableIdempotencyKey || input.idempotencyKey
      ? {
          headers: {
            "Idempotency-Key":
              input.stableIdempotencyKey ??
              buildContentScopedEmailIdempotencyKey(input.idempotencyKey!, email)
          }
        }
      : undefined
  );

  if (result.error) {
    throw new EmailDeliveryNotAcceptedError(result.error.message, result.error.name);
  }

  return { ...result.data, deliveryStatus: "sent" };
}

export async function sendAutomationWorkerHealthEmail(
  input: AutomationWorkerHealthEmailInput
): Promise<OperatorEmailDelivery> {
  const apiKey = normalizeEmailEnvValue(process.env.RESEND_API_KEY);
  const from = normalizeEmailEnvValue(process.env.ALERT_EMAIL_FROM);
  const to = normalizeEmailEnvValue(process.env.OPERATOR_ALERT_EMAIL);
  if (!to) return { deliveryStatus: "not_configured" };
  if (!apiKey || !from || shouldDryRunRecipient(to)) {
    return { id: "dry-run", deliveryStatus: "dry_run" };
  }

  const recovered = input.event === "recovered";
  const subject = recovered
    ? `Automation worker recovered: ${input.workerKey}`
    : `Automation worker overdue: ${input.workerKey}`;
  const html = [
    "<h1>Tee Time Spot automation health</h1>",
    `<p><strong>${escapeHtml(input.workerKey)}</strong> is ${recovered ? "reporting normally again" : "past its expected cadence"}.</p>`,
    `<p>Expected checkpoint: ${escapeHtml(input.expectedAt.toISOString())}<br>Observed: ${escapeHtml(input.observedAt.toISOString())}</p>`,
    "<p>Golfer search scheduling remains independently owned by Vercel Workflow and the recovery cron.</p>"
  ].join("");
  const result = await new Resend(apiKey).emails.send(
    { from, to, subject, html },
    {
      idempotencyKey: `automation-worker/${input.workerKey}/${input.event}/${input.expectedAt.toISOString()}`
    }
  );
  if (result.error) throw new Error(result.error.message);
  return { ...result.data, deliveryStatus: "sent" };
}

export function normalizeEmailEnvValue(value?: string) {
  return value?.replace(/\uFEFF/g, "").trim();
}

export function buildContentScopedEmailIdempotencyKey(
  baseKey: string,
  email: { from: string; to: string; subject: string; html: string }
) {
  const scopeHash = createHash("sha256").update(baseKey).digest("hex").slice(0, 16);
  const contentHash = createHash("sha256").update(JSON.stringify(email)).digest("hex").slice(0, 24);

  return `tee-time-email-${scopeHash}-${contentHash}`;
}

export function shouldDryRunRecipient(email: string) {
  const domain = email.split("@")[1]?.toLowerCase();

  return (
    !domain ||
    domain === "example.com" ||
    domain === "example.net" ||
    domain === "example.org" ||
    domain === "invalid" ||
    domain === "test" ||
    domain.endsWith(".local") ||
    domain.endsWith(".invalid") ||
    domain.endsWith(".test")
  );
}

export function renderAlertHtml(input: TeeTimeAlertInput) {
  const matches = [...input.matches].sort(
    (left, right) => left.startsAt.getTime() - right.startsAt.getTime()
  );
  const courseGroups = new Map<string, TeeTimeAlertMatch[]>();
  for (const match of matches) {
    const key = match.courseId ?? `${match.courseRank ?? "x"}:${match.courseName}`;
    const group = courseGroups.get(key) ?? [];
    group.push(match);
    courseGroups.set(key, group);
  }
  const availabilityCourses = [...courseGroups.entries()]
    .map(([courseId, courseMatches], index) => {
      const first = courseMatches[0];
      return {
        courseId,
        courseName: first?.courseName ?? "Golf course",
        rank: first?.courseRank ?? index + 1,
        courseAddress: first?.courseAddress,
        courseTimeZone: first?.courseTimeZone,
        bookingUrl: first?.bookingUrl,
        factLine: first?.factLine,
        courseGuideUrl: first?.courseGuideUrl,
        times: courseMatches.map((match) => ({
          startsAt: match.startsAt,
          availableSpots: match.availableSpots,
          priceCents: match.priceCents,
          holes: match.holes,
          bookableHoleCounts: match.bookableHoleCounts,
          isNew: match.isNew === true
        }))
      };
    })
    .sort((left, right) => left.rank - right.rank);
  const newMatches = matches.filter((match) => match.isNew === true);
  const subjectMatches = newMatches.length > 0 ? newMatches : matches;
  const newWindowCount = groupAlertMatchesIntoWindows(subjectMatches).length;
  const courseCount = courseGroups.size;
  const heading = newWindowCount === 1 ? "A tee time just opened!" : "New tee times just opened!";
  const intro =
    matches.length === 1
      ? "We found a tee time matching your search. Open the course's official booking page before it's gone."
      : `We found matching tee times across ${courseCount} course${courseCount === 1 ? "" : "s"}. Book what's available now — we'll keep watching your priorities.`;
  const firstMatch = matches[0];
  const fallbackTimeZone = normalizeTimeZone(firstMatch?.courseTimeZone, DEFAULT_TIME_ZONE);
  const targetDate =
    input.targetDate ??
    (firstMatch ? getCourseLocalDateKey(firstMatch.startsAt, fallbackTimeZone) : "1970-01-01");
  const startTime =
    input.startTime ?? (firstMatch ? formatTime24(firstMatch.startsAt, fallbackTimeZone) : "00:00");
  const lastMatch = matches.at(-1);
  const endTime =
    input.endTime ?? (lastMatch ? formatTime24(lastMatch.startsAt, fallbackTimeZone) : startTime);

  return renderCustomerEmail({
    variant: "instant",
    heading,
    intro,
    preheader: "A new tee time matches your Tee Time Spot search.",
    summary: {
      targetDate,
      startTime,
      endTime,
      players: input.players ?? 1,
      requestedLayoutHoles: input.requestedLayoutHoles
    },
    availabilityCourses,
    checkedAt: input.checkedAt,
    userTimeZone: input.userTimeZone,
    stopUrls: input.stopUrls,
    assetBaseUrl: input.assetBaseUrl
  });
}

export function getMatchAlertSubject(matches: TeeTimeAlertMatch[]) {
  const newMatches = matches.filter((match) => match.isNew === true);
  const subjectMatches = newMatches.length > 0 ? newMatches : matches;
  const courseNames = [...new Set(subjectMatches.map((match) => match.courseName))];
  const windowCount = groupAlertMatchesIntoWindows(subjectMatches).length;
  if (windowCount === 1) {
    return `A tee time window opened at ${courseNames[0]}`;
  }
  if (courseNames.length === 1) {
    return `New tee time windows opened at ${courseNames[0]}`;
  }
  return "New matching tee time windows opened up";
}

function groupAlertMatchesIntoWindows(matches: TeeTimeAlertMatch[]) {
  const groups = new Map<string, TeeTimeAlertMatch[]>();

  for (const match of [...matches].sort(
    (left, right) => left.startsAt.getTime() - right.startsAt.getTime()
  )) {
    const courseTimeZone = normalizeTimeZone(match.courseTimeZone, DEFAULT_TIME_ZONE);
    const key = `${match.courseName}:${courseTimeZone}:${getCourseLocalHourKey(
      match.startsAt,
      courseTimeZone
    )}`;
    const group = groups.get(key) ?? [];
    group.push(match);
    groups.set(key, group);
  }

  return [...groups.values()].map<TeeTimeAlertWindow>((windowMatches) => ({
    matches: windowMatches,
    startsAt: windowMatches[0].startsAt,
    endsAt: windowMatches[windowMatches.length - 1].startsAt
  }));
}

function formatTime24(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("hour") ?? "00"}:${values.get("minute") ?? "00"}`;
}

function getCourseLocalDateKey(date: Date, timeZone: string) {
  return getCourseLocalDateTimeParts(date, timeZone).slice(0, 3).join("-");
}

function getCourseLocalHourKey(date: Date, timeZone: string) {
  return getCourseLocalDateTimeParts(date, timeZone).join("-");
}

function getCourseLocalDateTimeParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    timeZone
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return [values.get("year"), values.get("month"), values.get("day"), values.get("hour")];
}

function buildStableEmailStopUrls(searchId: string, targetDate?: string) {
  if (!targetDate) {
    return buildEmailStopUrls(searchId);
  }

  const searchDateStart = new Date(`${targetDate}T00:00:00.000Z`);
  const expiresAt = new Date(searchDateStart);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + 8);
  return buildEmailStopUrls(searchId, {
    expiresAt: Number.isNaN(expiresAt.getTime()) ? undefined : expiresAt
  });
}

function createLogReference(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}
