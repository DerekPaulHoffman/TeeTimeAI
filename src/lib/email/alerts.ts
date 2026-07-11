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

export type TeeTimeAlertMatch = {
  courseName: string;
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
        : "Your daily Tee Time Spot update",
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
  const courseGroups = renderAlertCourseGroups(matches);
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

function renderAlertCourseGroups(matches: TeeTimeAlertMatch[]) {
  const groups = new Map<string, TeeTimeAlertMatch[]>();
  for (const match of matches) {
    const group = groups.get(match.courseName) ?? [];
    group.push(match);
    groups.set(match.courseName, group);
  }

  return [...groups.entries()]
    .map(([courseName, courseMatches]) => {
      const bookingUrl = courseMatches[0]?.bookingUrl ?? "";
      const date = courseMatches[0]
        ? courseMatches[0].startsAt.toLocaleDateString("en-US", {
            weekday: "long",
            month: "short",
            day: "numeric",
            timeZone: "America/New_York"
          })
        : "";
      const rows = courseMatches
        .map((match) => renderAlertMatchRow(match))
        .join("");
      const buttonLabel = matches.length === 1 ? "Book this tee time" : "Open official booking page";

      return `
        <div style="border:1px solid #d9e3dc;border-radius:10px;padding:18px;margin-bottom:14px">
          <p style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#147a52;margin:0 0 6px">Available now</p>
          <p style="font-size:18px;font-weight:800;margin:0">${escapeHtml(courseName)}</p>
          <p style="color:#5c6c64;font-size:13px;margin:3px 0 12px">${escapeHtml(date)}</p>
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

function renderAlertMatchRow(match: TeeTimeAlertMatch) {
  const time = match.startsAt.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York"
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
      <td style="border-top:1px solid #d9e3dc;padding:11px 0;font-size:19px;font-weight:800">${escapeHtml(time)}${newBadge}</td>
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

  const tokenAnchor = new Date(`${targetDate}T00:00:00.000Z`);
  return buildEmailStopUrls(searchId, {
    now: Number.isNaN(tokenAnchor.getTime()) ? undefined : tokenAnchor
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
