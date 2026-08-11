import { createHash } from "node:crypto";

import { Resend, type ErrorResponse } from "resend";

import { getRenderedAvailabilityTimes, renderCustomerEmail } from "@/lib/email/customer-email";
import { isVercelProduction } from "@/lib/env";
import { isSearchEmailDeliveryEnabled } from "@/lib/email/delivery-policy";
import {
  getCustomerCourseMonitoringStatus,
  renderSearchStatusHtml,
  type SearchStatusEmailInput
} from "@/lib/email/search-status";
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
  const deliveryKind =
    input.kind === "setup"
      ? "SETUP"
      : input.kind === "daily"
        ? "DAILY"
        : input.kind === "outage"
          ? "MONITORING_OUTAGE"
          : input.kind === "recovery"
            ? "MONITORING_RECOVERY"
            : "MONITORING_STATUS_UPDATE";
  if (!isSearchEmailDeliveryEnabled(deliveryKind)) {
    console.info("[email:status-disabled]", {
      recipientRef: createLogReference(input.to),
      searchRef: createLogReference(input.searchId),
      kind: input.kind
    });
    return { id: "suppressed", deliveryStatus: "dry_run" };
  }

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
    subject: getSearchStatusEmailSubject(input),
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
  if (!apiKey || !from || !to) {
    console.info("[email:automation-health-not-configured]", {
      workerKey: input.workerKey,
      event: input.event
    });
    return { deliveryStatus: "not_configured" };
  }
  if (shouldDryRunRecipient(to)) {
    console.warn("[email:automation-health-dry-run]", {
      recipientRef: createLogReference(to),
      workerKey: input.workerKey,
      event: input.event
    });
    return { id: "dry-run", deliveryStatus: "dry_run" };
  }

  const email = {
    from,
    to,
    subject:
      input.event === "overdue"
        ? "Action needed: Tee Time Spot worker is overdue"
        : "Recovered: Tee Time Spot worker is healthy again",
    html: renderAutomationWorkerHealthHtml(input)
  };
  const result = await new Resend(apiKey).emails.send(email, {
    headers: {
      "Idempotency-Key": getAutomationWorkerHealthIdempotencyKey(input)
    }
  });
  if (result.error) {
    throw new EmailDeliveryNotAcceptedError(result.error.message, result.error.name);
  }
  return { ...result.data, deliveryStatus: "sent" };
}

export function getSearchStatusEmailSubject(
  input: Pick<SearchStatusEmailInput, "kind" | "courses">
) {
  if (
    input.courses.some(
      (course) =>
        getCustomerCourseMonitoringStatus(course) === "NEEDS_HUMAN_REVIEW"
    )
  ) {
    return "Manual review needed; your alert remains active";
  }
  return input.kind === "setup"
    ? "Your Tee Time Spot alert is active"
    : input.kind === "daily"
      ? "Your morning Tee Time Spot update"
      : input.kind === "outage"
        ? "Your alert is active while automatic checks retry"
        : input.kind === "recovery"
          ? "Automatic tee-time checks have resumed"
          : "A course status has been confirmed";
}

export function getAutomationWorkerHealthIdempotencyKey(
  input: AutomationWorkerHealthEmailInput
) {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        workerKey: input.workerKey,
        event: input.event,
        expectedAt: input.expectedAt.toISOString()
      })
    )
    .digest("hex")
    .slice(0, 32);
  return `tee-time-worker-health-${digest}`;
}

export function renderAutomationWorkerHealthHtml(
  input: AutomationWorkerHealthEmailInput
) {
  const overdueMinutes = Math.max(
    0,
    Math.round(
      (input.observedAt.getTime() - input.expectedAt.getTime()) / 60_000
    )
  );
  const heading =
    input.event === "overdue"
      ? "Automation worker needs attention"
      : "Automation worker recovered";
  const detail =
    input.event === "overdue"
      ? `The worker was ${overdueMinutes} minute${overdueMinutes === 1 ? "" : "s"} overdue when checked.`
      : "The worker reported healthy activity again.";
  return `
    <div style="background:#f7f4eb;padding:24px;font-family:Inter,Arial,sans-serif;color:#14231d;line-height:1.5">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #d9e3dc;border-radius:12px;overflow:hidden">
        <div style="background:#14231d;color:#ffffff;padding:18px 22px">
          <strong>Tee Time Spot operations</strong>
        </div>
        <div style="padding:22px">
          <h1 style="font-size:24px;line-height:1.2;margin:0 0 16px">${escapeOperatorEmailHtml(heading)}</h1>
          <p><strong>Worker:</strong> ${escapeOperatorEmailHtml(input.workerKey)}</p>
          <p>${escapeOperatorEmailHtml(detail)}</p>
          <p><strong>Expected activity by:</strong> ${escapeOperatorEmailHtml(input.expectedAt.toISOString())}</p>
          <p><strong>Observed:</strong> ${escapeOperatorEmailHtml(input.observedAt.toISOString())}</p>
        </div>
      </div>
    </div>
  `;
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

function escapeOperatorEmailHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function createLogReference(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
