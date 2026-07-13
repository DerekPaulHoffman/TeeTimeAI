import { createHash } from "node:crypto";

import { Resend } from "resend";

import {
  renderEmailStopControls,
  renderSearchStatusHtml,
  type SearchStatusEmailInput
} from "@/lib/email/search-status";
import {
  buildEmailStopUrls,
  type EmailStopUrls
} from "@/lib/email/search-actions";
import { DEFAULT_TIME_ZONE, normalizeTimeZone } from "@/lib/timezones";

export type TeeTimeAlertMatch = {
  courseName: string;
  courseTimeZone?: string;
  startsAt: Date;
  availableSpots: number;
  bookingUrl: string;
  priceCents?: number | null;
  holes?: number | null;
  isNew?: boolean;
};

export type TeeTimeAlertInput = {
  to: string;
  searchId: string;
  matches: TeeTimeAlertMatch[];
  userTimeZone?: string;
  idempotencyKey?: string;
  stopUrls?: EmailStopUrls;
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

export type OperatorEmailDelivery = EmailDelivery | {
  deliveryStatus: "not_configured";
};

export async function sendTeeTimeAlert(input: TeeTimeAlertInput): Promise<EmailDelivery> {
  const apiKey = normalizeEmailEnvValue(process.env.RESEND_API_KEY);
  const from = normalizeEmailEnvValue(process.env.ALERT_EMAIL_FROM);

  if (!apiKey || !from || shouldDryRunRecipient(input.to)) {
    console.warn("[email:dry-run]", {
      to: input.to,
      searchId: input.searchId,
      matchingTimes: input.matches.length,
      courses: new Set(input.matches.map((match) => match.courseName)).size
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
    input.idempotencyKey
      ? {
          headers: {
            "Idempotency-Key": buildContentScopedEmailIdempotencyKey(
              input.idempotencyKey,
              email
            )
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

  if (!apiKey || !from || shouldDryRunRecipient(input.to)) {
    console.warn("[email:status-dry-run]", {
      to: input.to,
      kind: input.kind,
      targetDate: input.targetDate,
      courses: input.courses.length
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
    input.idempotencyKey
      ? {
          headers: {
            "Idempotency-Key": buildContentScopedEmailIdempotencyKey(
              input.idempotencyKey,
              email
            )
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
      incidentId: input.incidentId,
      courseId: input.courseId,
      event: input.event
    });
    return { deliveryStatus: "not_configured" };
  }

  if (!apiKey || !from || shouldDryRunRecipient(to)) {
    console.warn("[email:operator-dry-run]", {
      to,
      incidentId: input.incidentId,
      courseId: input.courseId,
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
  const newMatchCount = matches.filter((match) => match.isNew !== false).length;
  const courseCount = new Set(matches.map((match) => match.courseName)).size;
  const heading = newMatchCount === 1 ? "A spot just opened up!" : "New tee times just opened up!";
  const summary =
    matches.length === 1
      ? "We found a tee time that matches your search. Open the official course page before it is gone."
      : `${matches.length} matching tee times are currently available across ${courseCount} course${courseCount === 1 ? "" : "s"}.`;
  const courseGroups = renderAlertCourseGroups(matches, input.userTimeZone);
  const stopControls = renderEmailStopControls(input.stopUrls);

  return `
    <div style="background:#f4efe5;padding:24px;font-family:Inter,Arial,sans-serif;color:#14231d;line-height:1.5">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #d9e3dc;border-radius:12px;overflow:hidden">
        <div style="background:#111d18;color:#ffffff;padding:18px 22px">
          <div style="font-weight:800;font-size:18px">Tee Time Spot</div>
          <div style="color:rgba(255,255,255,.68);font-size:13px">teetimespot.com</div>
        </div>
        <div style="background:linear-gradient(90deg,rgba(17,29,24,.92),rgba(17,29,24,.7)),url('https://images.unsplash.com/photo-1535131749006-b7f58c99034b?auto=format&fit=crop&w=1200&q=80') center/cover;color:#ffffff;padding:34px 22px">
          <div style="display:inline-block;background:#e28a2f;color:#1d1309;border-radius:999px;padding:7px 11px;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase">
            New tee time alert
          </div>
          <h1 style="font-size:30px;line-height:1.05;margin:18px 0 12px">${heading}</h1>
          <p style="margin:0;color:rgba(255,255,255,.82)">${escapeHtml(summary)}</p>
        </div>
        <div style="padding:22px">
          ${courseGroups}
          <div style="background:#e6f3f7;border-radius:10px;color:#174152;padding:14px 16px;font-size:14px">
            Every button goes to the course’s official booking page. Tee Time Spot never books,
            holds, or handles payment. Availability is first come, first served.
          </div>
          ${stopControls}
        </div>
        <div style="background:#111d18;color:rgba(255,255,255,.72);padding:18px 22px;font-size:13px">
          You’re getting this because you set up an alert on teetimespot.com.
        </div>
      </div>
    </div>
  `;
}

function renderAlertCourseGroups(matches: TeeTimeAlertMatch[], userTimeZone?: string) {
  const groups = new Map<string, TeeTimeAlertMatch[]>();
  for (const match of matches) {
    const groupKey = `${match.courseName}:${normalizeTimeZone(match.courseTimeZone)}`;
    const group = groups.get(groupKey) ?? [];
    group.push(match);
    groups.set(groupKey, group);
  }

  return [...groups.entries()]
    .map(([, courseMatches]) => {
      const courseName = courseMatches[0]?.courseName ?? "Golf course";
      const courseTimeZone = normalizeTimeZone(
        courseMatches[0]?.courseTimeZone,
        DEFAULT_TIME_ZONE
      );
      const bookingUrl = courseMatches[0]?.bookingUrl ?? "";
      const date = courseMatches[0]
        ? courseMatches[0].startsAt.toLocaleDateString("en-US", {
            weekday: "long",
            month: "short",
            day: "numeric",
            timeZone: courseTimeZone
          })
        : "";
      const rows = courseMatches
        .map((match) => renderAlertMatchRow(match, userTimeZone))
        .join("");
      const buttonLabel = matches.length === 1 ? "Book this tee time" : "Open official booking page";

      return `
        <div style="border:1px solid #d9e3dc;border-radius:10px;padding:18px;margin-bottom:14px">
          <p style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#147a52;margin:0 0 6px">Available now</p>
          <p style="font-size:18px;font-weight:800;margin:0">${escapeHtml(courseName)}</p>
          <p style="color:#5c6c64;font-size:13px;margin:3px 0 12px">${escapeHtml(date)} - course local time (${escapeHtml(courseTimeZone)})</p>
          <table role="presentation" style="border-collapse:collapse;width:100%">
            ${rows}
          </table>
          <p style="margin:14px 0 0">
            <a href="${escapeHtml(bookingUrl)}" style="display:block;background:#e28a2f;color:#1d1309;padding:13px 16px;border-radius:999px;text-align:center;text-decoration:none;font-weight:800">
              ${buttonLabel}
            </a>
          </p>
        </div>
      `;
    })
    .join("");
}

function renderAlertMatchRow(match: TeeTimeAlertMatch, userTimeZone?: string) {
  const courseTimeZone = normalizeTimeZone(match.courseTimeZone, DEFAULT_TIME_ZONE);
  const normalizedUserTimeZone = normalizeTimeZone(userTimeZone, courseTimeZone);
  const time = match.startsAt.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: courseTimeZone,
    timeZoneName: "short"
  });
  const userLocalTime =
    normalizedUserTimeZone === courseTimeZone
      ? null
      : match.startsAt.toLocaleString("en-US", {
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
          timeZone: normalizedUserTimeZone,
          timeZoneName: "short"
        });
  const details = [
    `${match.availableSpots} spot${match.availableSpots === 1 ? "" : "s"}`,
    match.priceCents != null ? formatPrice(match.priceCents) : null,
    match.holes ? `${match.holes} holes` : null
  ].filter(Boolean);
  const newBadge = match.isNew === false
    ? ""
    : '<span style="background:#e2f1e7;border-radius:999px;color:#105338;font-size:10px;font-weight:800;margin-left:7px;padding:3px 6px;vertical-align:2px">NEW</span>';

  return `
    <tr>
      <td style="border-top:1px solid #d9e3dc;padding:11px 0;font-size:19px;font-weight:800">${escapeHtml(time)}${newBadge}${userLocalTime ? `<div style="color:#5c6c64;font-size:11px;font-weight:500;margin-top:2px">${escapeHtml(userLocalTime)} for you</div>` : ""}</td>
      <td style="border-top:1px solid #d9e3dc;padding:11px 0;text-align:right;color:#4e5d56;font-size:13px">${escapeHtml(details.join(" · "))}</td>
    </tr>
  `;
}

function getMatchAlertSubject(matches: TeeTimeAlertMatch[]) {
  const newMatches = matches.filter((match) => match.isNew !== false);
  const subjectMatches = newMatches.length > 0 ? newMatches : matches;
  const courseNames = [...new Set(subjectMatches.map((match) => match.courseName))];
  if (subjectMatches.length === 1) {
    return `A spot opened up at ${courseNames[0]}`;
  }
  if (courseNames.length === 1) {
    return `${subjectMatches.length} tee times opened at ${courseNames[0]}`;
  }
  return `${subjectMatches.length} matching tee times opened up`;
}

function formatPrice(priceCents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: priceCents % 100 === 0 ? 0 : 2
  }).format(priceCents / 100);
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
