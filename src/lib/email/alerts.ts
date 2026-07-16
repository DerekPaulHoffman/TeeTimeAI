import { createHash } from "node:crypto";

import { Resend } from "resend";

import { renderCustomerEmail } from "@/lib/email/customer-email";
import { isVercelProduction } from "@/lib/env";
import {
  renderSearchStatusHtml,
  type SearchStatusEmailInput
} from "@/lib/email/search-status";
import {
  buildEmailStopUrls,
  type EmailStopUrls
} from "@/lib/email/search-actions";
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

export type CourseSupportOperatorEmailInput = {
  event: "opened" | "escalated" | "resolved";
  incidentId: string;
  cycle: number;
  courseId: string;
  courseName: string;
  platform: string;
  bookingUrl?: string | null;
  firstAffectedSearchId?: string | null;
  affectedSearchCount: number;
  kind: string;
  message?: string | null;
  nextAction?: string | null;
  firstSeenAt: Date;
  resolution?: string | null;
  resolutionMessage?: string | null;
};

export type CourseSupportOperatorSummaryInput = {
  incidents: Array<{
    incidentId: string;
    cycle: number;
    courseId: string;
    courseName: string;
    platform: string;
    bookingUrl?: string | null;
    firstAffectedSearchId?: string | null;
    affectedSearchCount: number;
    kind: string;
    message?: string | null;
    nextAction?: string | null;
    firstSeenAt: Date;
  }>;
};

export type OperatorEmailDelivery = EmailDelivery | {
  deliveryStatus: "not_configured";
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
    buildStableEmailStopUrls(
      input.searchId,
      input.matches[0]?.startsAt.toISOString().slice(0, 10)
    );
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
    throw new Error(result.error.message);
  }

  return { ...result.data, deliveryStatus: "sent" };
}

export async function sendSearchStatusEmail(
  input: SearchStatusEmailInput
): Promise<EmailDelivery> {
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
    throw new Error(result.error.message);
  }

  return { ...result.data, deliveryStatus: "sent" };
}

export async function sendCourseSupportOperatorEmail(
  input: CourseSupportOperatorEmailInput
): Promise<OperatorEmailDelivery> {
  const apiKey = normalizeEmailEnvValue(process.env.RESEND_API_KEY);
  const from = normalizeEmailEnvValue(process.env.ALERT_EMAIL_FROM);
  const to = normalizeEmailEnvValue(process.env.OPERATOR_ALERT_EMAIL);

  if (!to) {
    console.error("[email:operator-not-configured]", {
      incidentRef: createLogReference(input.incidentId),
      courseRef: createLogReference(input.courseId),
      event: input.event
    });
    return { deliveryStatus: "not_configured" };
  }

  if (!apiKey || !from || shouldDryRunRecipient(to)) {
    console.warn("[email:operator-dry-run]", {
      recipientRef: createLogReference(to),
      incidentRef: createLogReference(input.incidentId),
      courseRef: createLogReference(input.courseId),
      event: input.event
    });
    return { id: "dry-run", deliveryStatus: "dry_run" };
  }

  const email = {
    from,
    to,
    subject: getCourseSupportOperatorSubject(input),
    html: renderCourseSupportOperatorHtml(input)
  };
  const result = await new Resend(apiKey).emails.send(email, {
    idempotencyKey: `course-support/${input.incidentId}/${input.cycle}/${input.event}`
  });

  if (result.error) {
    throw new Error(result.error.message);
  }

  return { ...result.data, deliveryStatus: "sent" };
}

export async function sendCourseSupportOperatorSummaryEmail(
  input: CourseSupportOperatorSummaryInput
): Promise<OperatorEmailDelivery> {
  const apiKey = normalizeEmailEnvValue(process.env.RESEND_API_KEY);
  const from = normalizeEmailEnvValue(process.env.ALERT_EMAIL_FROM);
  const to = normalizeEmailEnvValue(process.env.OPERATOR_ALERT_EMAIL);

  if (!to) {
    console.error("[email:operator-summary-not-configured]", {
      incidentRefs: input.incidents.map((incident) =>
        createLogReference(incident.incidentId)
      )
    });
    return { deliveryStatus: "not_configured" };
  }

  if (!apiKey || !from || shouldDryRunRecipient(to)) {
    console.warn("[email:operator-summary-dry-run]", {
      recipientRef: createLogReference(to),
      incidents: input.incidents.length
    });
    return { id: "dry-run", deliveryStatus: "dry_run" };
  }

  const sortedIncidents = [...input.incidents].sort((left, right) =>
    left.incidentId.localeCompare(right.incidentId)
  );
  const scope = createHash("sha256")
    .update(sortedIncidents.map((incident) => `${incident.incidentId}:${incident.cycle}`).join("|"))
    .digest("hex")
    .slice(0, 24);
  const email = {
    from,
    to,
    subject: `${sortedIncidents.length} concrete course blocker${sortedIncidents.length === 1 ? "" : "s"} need your input`,
    html: renderCourseSupportOperatorSummaryHtml({ incidents: sortedIncidents })
  };
  const result = await new Resend(apiKey).emails.send(email, {
    idempotencyKey: `course-support-summary/${scope}`
  });

  if (result.error) {
    throw new Error(result.error.message);
  }

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
  const contentHash = createHash("sha256")
    .update(JSON.stringify(email))
    .digest("hex")
    .slice(0, 24);

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

export function renderCourseSupportOperatorHtml(input: CourseSupportOperatorEmailInput) {
  const eventLabel =
    input.event === "opened"
      ? "New course monitoring incident"
      : input.event === "escalated"
        ? "Course monitoring needs human review"
        : "Course monitoring incident resolved";
  const resolution = input.resolution
    ? `<p><strong>Resolution:</strong> ${escapeHtml(input.resolution.replaceAll("_", " ").toLowerCase())}</p>`
    : "";
  const resolutionMessage = input.resolutionMessage
    ? `<p><strong>Resolution notes:</strong> ${escapeHtml(input.resolutionMessage)}</p>`
    : "";
  const bookingLink = input.bookingUrl
    ? `<p><a href="${escapeHtml(input.bookingUrl)}" style="color:#087746;font-weight:800">Inspect official course surface →</a></p>`
    : "";

  return `
    <div style="background:#f4efe5;padding:24px;font-family:Inter,Arial,sans-serif;color:#14231d;line-height:1.5">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #d9e3dc;border-radius:12px;overflow:hidden">
        <div style="background:#111d18;color:#ffffff;padding:18px 22px">
          <div style="font-weight:800;font-size:18px">Tee Time Spot operations</div>
          <div style="color:rgba(255,255,255,.68);font-size:13px">${escapeHtml(eventLabel)}</div>
        </div>
        <div style="padding:22px">
          <h1 style="font-size:24px;line-height:1.15;margin:0 0 16px">${escapeHtml(input.courseName)}</h1>
          <p><strong>Status event:</strong> ${escapeHtml(input.event)}</p>
          <p><strong>Incident:</strong> ${escapeHtml(input.incidentId)} · cycle ${input.cycle}</p>
          <p><strong>Course ID:</strong> ${escapeHtml(input.courseId)}</p>
          <p><strong>Detected platform:</strong> ${escapeHtml(input.platform)}</p>
          <p><strong>Issue:</strong> ${escapeHtml(input.kind.replaceAll("_", " ").toLowerCase())}</p>
          <p><strong>First affected search:</strong> ${escapeHtml(input.firstAffectedSearchId ?? "unknown")}</p>
          <p><strong>Affected active searches when opened:</strong> ${input.affectedSearchCount}</p>
          <p><strong>First seen:</strong> ${escapeHtml(input.firstSeenAt.toISOString())}</p>
          ${input.message ? `<p><strong>Evidence:</strong> ${escapeHtml(input.message)}</p>` : ""}
          ${input.nextAction ? `<p><strong>Next action:</strong> ${escapeHtml(input.nextAction)}</p>` : ""}
          ${resolution}
          ${resolutionMessage}
          ${bookingLink}
        </div>
      </div>
    </div>
  `;
}

export function renderCourseSupportOperatorSummaryHtml(
  input: CourseSupportOperatorSummaryInput
) {
  const groups = new Map<string, CourseSupportOperatorSummaryInput["incidents"]>();
  for (const incident of input.incidents) {
    const provider = getSupportProviderLabel(incident.platform, incident.bookingUrl);
    const group = groups.get(provider) ?? [];
    group.push(incident);
    groups.set(provider, group);
  }
  const sections = [...groups.entries()]
    .map(([provider, incidents]) => {
      const rows = incidents
        .map((incident) => {
          const bookingLink = incident.bookingUrl
            ? `<p style="margin:8px 0 0"><a href="${escapeHtml(incident.bookingUrl)}" style="color:#087746;font-weight:800">Inspect official course surface &rarr;</a></p>`
            : "";
          return `
            <div style="border-top:1px solid #e5ebe7;padding:14px 0">
              <p style="font-size:16px;font-weight:800;margin:0">${escapeHtml(incident.courseName)}</p>
              <p style="color:#53645c;font-size:13px;margin:4px 0 0">${escapeHtml(incident.kind.replaceAll("_", " ").toLowerCase())} &middot; first seen ${escapeHtml(incident.firstSeenAt.toISOString())}</p>
              ${incident.message ? `<p style="margin:8px 0 0"><strong>Evidence:</strong> ${escapeHtml(incident.message)}</p>` : ""}
              ${incident.nextAction ? `<p style="margin:8px 0 0"><strong>Next action:</strong> ${escapeHtml(incident.nextAction)}</p>` : ""}
              ${bookingLink}
            </div>
          `;
        })
        .join("");
      return `
        <div style="margin-top:18px">
          <h2 style="font-size:18px;margin:0 0 4px">${escapeHtml(provider)} &middot; ${incidents.length} course${incidents.length === 1 ? "" : "s"}</h2>
          ${rows}
        </div>
      `;
    })
    .join("");

  return `
    <div style="background:#f4efe5;padding:24px;font-family:Inter,Arial,sans-serif;color:#14231d;line-height:1.5">
      <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #d9e3dc;border-radius:12px;overflow:hidden">
        <div style="background:#111d18;color:#ffffff;padding:18px 22px">
          <div style="font-weight:800;font-size:18px">Tee Time Spot operations</div>
          <div style="color:rgba(255,255,255,.68);font-size:13px">Automated adapter remediation reached an external blocker</div>
        </div>
        <div style="padding:22px">
          <h1 style="font-size:24px;line-height:1.15;margin:0 0 10px">A concrete blocker needs your input</h1>
          <p style="margin:0;color:#53645c">The autonomous remediation run inspected the official provider, attempted the safe public paths available to it, and could not continue without the specific external action below.</p>
          ${sections}
        </div>
      </div>
    </div>
  `;
}

function getSupportProviderLabel(platform: string, bookingUrl?: string | null) {
  if (platform !== "UNKNOWN") {
    return platform;
  }
  try {
    return bookingUrl ? new URL(bookingUrl).hostname : "Unknown provider";
  } catch {
    return "Unknown provider";
  }
}

function getCourseSupportOperatorSubject(input: CourseSupportOperatorEmailInput) {
  if (input.event === "opened") {
    return `Action needed: monitoring gap at ${input.courseName}`;
  }
  if (input.event === "escalated") {
    return `Human review needed: ${input.courseName}`;
  }
  return `Resolved: ${input.courseName} monitoring incident`;
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
  const heading = newWindowCount === 1
    ? "A tee time just opened!"
    : "New tee times just opened!";
  const intro = matches.length === 1
    ? "We found a tee time matching your search. Open the course's official booking page before it's gone."
    : `We found matching tee times across ${courseCount} course${courseCount === 1 ? "" : "s"}. Book what's available now — we'll keep watching your priorities.`;
  const firstMatch = matches[0];
  const fallbackTimeZone = normalizeTimeZone(
    firstMatch?.courseTimeZone,
    DEFAULT_TIME_ZONE
  );
  const targetDate = input.targetDate
    ?? (firstMatch ? getCourseLocalDateKey(firstMatch.startsAt, fallbackTimeZone) : "1970-01-01");
  const startTime = input.startTime
    ?? (firstMatch ? formatTime24(firstMatch.startsAt, fallbackTimeZone) : "00:00");
  const lastMatch = matches.at(-1);
  const endTime = input.endTime
    ?? (lastMatch ? formatTime24(lastMatch.startsAt, fallbackTimeZone) : startTime);

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
  return [
    values.get("year"),
    values.get("month"),
    values.get("day"),
    values.get("hour")
  ];
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
