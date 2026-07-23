import type { EmailStopUrls } from "@/lib/email/search-actions";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";
import { absoluteUrl } from "@/lib/seo";
import {
  DEFAULT_TIME_ZONE,
  normalizeTimeZone,
  zonedDateTimeToDate
} from "@/lib/timezones";

export const MAX_EMAIL_AVAILABILITY_PILLS_PER_COURSE = 16;

export type CustomerEmailVariant = "setup" | "morning" | "instant";

export type CustomerEmailSearchSummary = {
  targetDate: string;
  startTime: string;
  endTime: string;
  players: number;
  requestedLayoutHoles?: 9 | 18 | null;
};

export type CustomerEmailAvailabilityTime = {
  startsAt: Date | string;
  availableSpots: number;
  priceCents?: number | null;
  holes?: number | null;
  bookableHoleCounts?: Array<9 | 18>;
  isNew?: boolean;
};

export type CustomerEmailAvailabilityCourse = {
  courseId?: string;
  courseName: string;
  rank: number;
  courseAddress?: string;
  courseTimeZone?: string;
  bookingUrl?: string;
  factLine?: string;
  courseGuideUrl?: string;
  times: CustomerEmailAvailabilityTime[];
};

export type CustomerEmailMonitoringTone =
  | "monitored"
  | "scheduled"
  | "adding"
  | "retrying"
  | "direct";

export type CustomerEmailMonitoringCourse = {
  courseName: string;
  rank: number;
  courseAddress?: string;
  badgeLabel: string;
  detail: string;
  tone: CustomerEmailMonitoringTone;
  bookingUrl?: string;
  bookingLinkLabel?: string;
  phone?: string;
  factLine?: string;
  courseGuideUrl?: string;
};

export type CustomerEmailRenderInput = {
  variant: CustomerEmailVariant;
  heading: string;
  intro: string;
  preheader: string;
  summary: CustomerEmailSearchSummary;
  availabilityCourses: CustomerEmailAvailabilityCourse[];
  monitoringCourses?: CustomerEmailMonitoringCourse[];
  checkedAt?: Date;
  userTimeZone?: string;
  stopUrls?: EmailStopUrls;
  assetBaseUrl?: string;
  showCadenceNote?: boolean;
};

const EMAIL_COLORS = {
  cream: "#f7f4eb",
  dark: "#14231d",
  orange: "#d9862f",
  line: "#d9e3dc",
  muted: "#5c6c64",
  paleMuted: "#aab9b2",
  blueBackground: "#e6f3f7",
  blueBorder: "#c5dce6",
  blueText: "#174152"
} as const;

export function renderCustomerEmail(input: CustomerEmailRenderInput) {
  const availability = input.availabilityCourses
    .filter((course) => course.times.length > 0)
    .sort((left, right) => left.rank - right.rank)
    .map((course) => renderAvailabilityCard(course, input.userTimeZone, input.assetBaseUrl))
    .join("");
  const monitoring = input.monitoringCourses?.length
    ? renderMonitoringSection(input)
    : "";
  const safety = availability
    ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;margin:0 0 28px">
        <tr>
          <td style="background:${EMAIL_COLORS.blueBackground};border:1px solid ${EMAIL_COLORS.blueBorder};border-radius:14px;color:${EMAIL_COLORS.blueText};font-family:Inter,Arial,sans-serif;font-size:13px;line-height:20px;padding:14px 16px">
            Those buttons go straight to each course's own booking page. Tee Time Spot never books, holds, or handles payment or personal info. Availability is first come, first served. Click, book, play. &#9971;
          </td>
        </tr>
      </table>
    `
    : "";
  const standaloneStopControls = monitoring ? "" : renderEmailStopControls(input.stopUrls);
  const footerUnsubscribe = input.stopUrls?.cancelled
    ? `<a href="${escapeHtml(input.stopUrls.cancelled)}" style="color:rgba(255,255,255,.72);font-weight:700;text-decoration:underline">Unsubscribe</a>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="x-apple-disable-message-reformatting">
    <title>${escapeHtml(input.heading)}</title>
    <style>
      body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
      table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
      img { -ms-interpolation-mode: bicubic; border: 0; display: block; height: auto; line-height: 100%; outline: none; text-decoration: none; }
      table { border-collapse: collapse !important; }
      @media only screen and (max-width: 620px) {
        .email-outer { padding: 0 !important; }
        .email-shell-cell { padding: 0 !important; }
        .email-card { border-radius: 0 !important; }
        .email-pad { padding-left: 16px !important; padding-right: 16px !important; }
        .summary-cell { display: inline-block !important; width: 50% !important; box-sizing: border-box !important; }
        .time-pill-cell { display: inline-block !important; width: 50% !important; box-sizing: border-box !important; }
        .course-location { display: block !important; padding-top: 8px !important; text-align: left !important; white-space: normal !important; }
        .footer-copy, .footer-link { display: block !important; text-align: left !important; width: 100% !important; }
        .footer-link { padding-top: 8px !important; }
      }
    </style>
  </head>
  <body style="background:${EMAIL_COLORS.cream};margin:0;padding:0">
    <div style="display:none;font-size:1px;color:${EMAIL_COLORS.cream};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${escapeHtml(input.preheader)}</div>
    <table class="email-outer" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${EMAIL_COLORS.cream};border-collapse:collapse;padding:24px;width:100%">
      <tr>
        <td class="email-shell-cell" align="center" style="padding:24px">
          <table class="email-card" role="presentation" width="680" cellpadding="0" cellspacing="0" style="background:${EMAIL_COLORS.cream};border:1px solid ${EMAIL_COLORS.line};border-collapse:separate!important;border-radius:16px;max-width:680px;overflow:hidden;width:100%">
            ${renderBrandBar()}
            ${renderHero(input)}
            ${renderSearchSummary(input.summary)}
            <tr>
              <td class="email-pad" style="padding:28px 32px 0">
                ${availability}
                ${safety}
                ${monitoring}
                ${standaloneStopControls}
              </td>
            </tr>
            <tr>
              <td style="background:${EMAIL_COLORS.dark};padding:16px 20px">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td class="footer-copy" style="color:rgba(255,255,255,.68);font-family:Inter,Arial,sans-serif;font-size:11px;line-height:17px">You're getting this because you set up an alert on teetimespot.com</td>
                    <td class="footer-link" align="right" style="font-family:Inter,Arial,sans-serif;font-size:11px;line-height:17px">${footerUnsubscribe}</td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function renderEmailStopControls(stopUrls?: EmailStopUrls) {
  if (!stopUrls) {
    return "";
  }

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:24px 0 28px">
      <tr>
        <td align="center" style="border-top:1px solid ${EMAIL_COLORS.line};padding-top:24px">
          <p style="color:${EMAIL_COLORS.dark};font-family:Inter,Arial,sans-serif;font-size:14px;font-weight:700;line-height:21px;margin:0 0 3px">Done with this alert?</p>
          <p style="color:${EMAIL_COLORS.muted};font-family:Inter,Arial,sans-serif;font-size:12px;line-height:18px;margin:0 0 14px">Save it or cancel it &mdash; either way we'll stop these results.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;max-width:360px">
            <tr>
              <td align="center" bgcolor="#147a52" style="background:#147a52;border-radius:14px">
                <a href="${escapeHtml(stopUrls.booked)}" style="color:#ffffff;display:block;font-family:Inter,Arial,sans-serif;font-size:13px;font-weight:800;line-height:20px;padding:12px 16px;text-decoration:none">I booked &mdash; stop these results</a>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding-top:10px">
                <a href="${escapeHtml(stopUrls.cancelled)}" style="color:#a33b35;font-family:Inter,Arial,sans-serif;font-size:12px;font-weight:700;line-height:18px;text-decoration:underline">Cancel this alert</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
}

export function formatCompactCourseLocation(address?: string | null) {
  if (!address?.trim()) {
    return "";
  }

  const parts = address.split(",").map((part) => part.trim()).filter(Boolean);
  const hasCountry = /^(usa|united states)$/i.test(parts.at(-1) ?? "");
  const stateIndex = parts.length - (hasCountry ? 2 : 1);
  const cityIndex = stateIndex - 1;
  const state = parts[stateIndex]?.match(/\b[A-Z]{2}\b/)?.[0];
  if (cityIndex >= 0 && state) {
    return `${parts[cityIndex]}, ${state}`;
  }

  return parts.length > 1 ? parts.slice(-2).join(", ") : parts[0] ?? "";
}

function renderBrandBar() {
  return `
    <tr>
      <td style="background:${EMAIL_COLORS.dark};padding:16px 20px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="color:#ffffff;font-family:Inter,Arial,sans-serif;font-size:17px;font-weight:800;line-height:20px">Tee Time Spot</td>
            <td align="right" style="color:rgba(255,255,255,.58);font-family:Inter,Arial,sans-serif;font-size:11px;line-height:17px">teetimespot.com</td>
          </tr>
        </table>
      </td>
    </tr>
  `;
}

function renderHero(input: CustomerEmailRenderInput) {
  const badge = input.variant === "setup"
    ? "SEARCH IS ACTIVE"
    : input.variant === "morning"
      ? "MORNING UPDATE"
      : "NEW TEE TIME ALERT";

  return `
    <tr>
      <td class="email-pad" style="padding:28px 32px 24px">
        <span style="background:${EMAIL_COLORS.orange};border-radius:999px;color:#ffffff;display:inline-block;font-family:Inter,Arial,sans-serif;font-size:10px;font-weight:800;letter-spacing:1px;line-height:15px;margin:0 0 16px;padding:4px 12px">${badge}</span>
        <h1 style="color:${EMAIL_COLORS.dark};font-family:Inter,Arial,sans-serif;font-size:24px;font-weight:800;line-height:29px;margin:0 0 8px">${escapeHtml(input.heading)}</h1>
        <p style="color:${EMAIL_COLORS.muted};font-family:Inter,Arial,sans-serif;font-size:14px;line-height:22px;margin:0">${escapeHtml(input.intro)}</p>
      </td>
    </tr>
  `;
}

function renderSearchSummary(summary: CustomerEmailSearchSummary) {
  const cells = [
    ["DATE", formatSearchDate(summary.targetDate)],
    ["SEARCH WINDOW", `${formatClockTime(summary.startTime)} &ndash; ${formatClockTime(summary.endTime)} course local`],
    ["COURSE LAYOUT", summary.requestedLayoutHoles ? `${summary.requestedLayoutHoles} Holes` : "Any layout"],
    ["GOLFERS", String(summary.players)]
  ];

  return `
    <tr>
      <td style="border-bottom:1px solid #e8eeeb;border-top:1px solid #e8eeeb">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed">
          <tr>
            ${cells.map(([label, value], index) => `
              <td class="summary-cell" width="25%" style="${index > 0 ? "border-left:1px solid #e8eeeb;" : ""}padding:12px 20px;vertical-align:top">
                <p style="color:${EMAIL_COLORS.paleMuted};font-family:Inter,Arial,sans-serif;font-size:9px;font-weight:800;letter-spacing:.9px;line-height:14px;margin:0">${label}</p>
                <p style="color:${EMAIL_COLORS.dark};font-family:Inter,Arial,sans-serif;font-size:13px;font-weight:600;line-height:18px;margin:1px 0 0">${value}</p>
              </td>
            `).join("")}
          </tr>
        </table>
      </td>
    </tr>
  `;
}

function renderAvailabilityCard(
  course: CustomerEmailAvailabilityCourse,
  userTimeZone?: string,
  assetBaseUrl?: string
) {
  const timeZone = normalizeTimeZone(course.courseTimeZone, DEFAULT_TIME_ZONE);
  const normalizedTimes = normalizeAvailabilityTimes(course.times, timeZone);
  const visibleTimes = selectVisibleAvailabilityTimes(normalizedTimes);
  const hiddenTimeCount = normalizedTimes.length - visibleTimes.length;
  const date = visibleTimes[0]?.startsAtDate.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone
  }) ?? "";
  const bodyRows = chunkAvailabilityTimes(visibleTimes)
    .map((row) => renderAvailabilityPillRow(row, timeZone, userTimeZone))
    .join("");
  const overflow = hiddenTimeCount > 0
    ? `<p style="color:${EMAIL_COLORS.muted};font-family:Inter,Arial,sans-serif;font-size:12px;line-height:18px;margin:8px 4px 0">${hiddenTimeCount} more tee time${hiddenTimeCount === 1 ? " is" : "s are"} available on the official booking page.</p>`
    : "";
  const price = formatPriceRange(
    visibleTimes.flatMap((time) => time.priceCents == null ? [] : [time.priceCents])
  );
  const holes = [...new Set(visibleTimes.flatMap((time) => [
    ...(time.bookableHoleCounts ?? []),
    ...(time.holes ? [time.holes] : [])
  ]))].filter((value): value is 9 | 18 => value === 9 || value === 18)
    .sort((left, right) => left - right);
  const holesLabel = holes.length > 0
    ? `${holes.join("/")} holes`
    : "";
  const metaItems = [
    price
      ? `<span style="color:${EMAIL_COLORS.dark};font-weight:700">${price}</span>`
      : "",
    holesLabel
      ? `<span>${holesLabel}</span>`
      : "",
    `<span>${date} &middot; course local time</span>`
  ].filter(Boolean);
  const meta = metaItems.join(
    `<span style="color:${EMAIL_COLORS.line};padding:0 8px">&middot;</span>`
  );
  const safeBookingUrl = getSafeCustomerBookingUrl(course.bookingUrl);
  const factLine = course.factLine
    ? `
      <tr>
        <td style="background:#ffffff;color:${EMAIL_COLORS.dark};font-family:Inter,Arial,sans-serif;font-size:12px;font-weight:700;line-height:19px;padding:12px 20px">
          ${escapeHtml(course.factLine)}
        </td>
      </tr>
    `
    : "";
  const cta = safeBookingUrl
    ? `
      <tr>
        <td style="padding:16px 20px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td align="center" bgcolor="${EMAIL_COLORS.orange}" style="background:${EMAIL_COLORS.orange};border-radius:14px">
                <a href="${escapeHtml(safeBookingUrl)}" style="color:#1d1309;display:block;font-family:Inter,Arial,sans-serif;font-size:14px;font-weight:800;line-height:21px;padding:12px 16px;text-decoration:none">${course.times.length === 1 ? "Book this tee time" : "Open official booking page"}</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    `
    : "";
  const courseGuideLink = course.courseGuideUrl
    ? `
      <tr>
        <td align="center" style="padding:0 20px 16px">
          <a href="${escapeHtml(absoluteUrl(course.courseGuideUrl))}" style="color:#087746;display:inline-block;font-family:Inter,Arial,sans-serif;font-size:12px;font-weight:800;line-height:18px;text-decoration:none">Course Guide &rarr;</a>
        </td>
      </tr>
    `
    : "";

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid ${EMAIL_COLORS.line};border-collapse:separate!important;border-radius:16px;margin:0 0 20px;overflow:hidden">
      ${renderCoursePhotoHeader({
        badge: `&#10022; AVAILABLE NOW &middot; PRIORITY ${course.rank}`,
        badgeColor: "#6dbf9c",
        courseName: course.courseName,
        courseAddress: course.courseAddress,
        rank: course.rank,
        subline: date,
        assetBaseUrl
      })}
      ${factLine}
      <tr>
        <td style="background:#f7f9f7;border-bottom:1px solid #e8eeeb;color:${EMAIL_COLORS.muted};font-family:Inter,Arial,sans-serif;font-size:12px;line-height:18px;padding:9px 20px">
          ${meta}
        </td>
      </tr>
      <tr>
        <td style="padding:12px 16px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate!important;table-layout:fixed">
            ${bodyRows}
          </table>
          ${overflow}
        </td>
      </tr>
      ${cta}
      ${courseGuideLink}
    </table>
  `;
}

function renderAvailabilityPillRow(
  times: Array<CustomerEmailAvailabilityTime & { startsAtDate: Date }>,
  courseTimeZone: string,
  userTimeZone?: string
) {
  const cells = times.map((time) =>
    renderAvailabilityPill(time, courseTimeZone, userTimeZone)
  );
  while (cells.length < 4) {
    cells.push(
      '<td class="time-pill-cell" width="25%" style="box-sizing:border-box;padding:4px;vertical-align:top"></td>'
    );
  }

  return `<tr>${cells.join("")}</tr>`;
}

function renderAvailabilityPill(
  time: CustomerEmailAvailabilityTime & { startsAtDate: Date },
  courseTimeZone: string,
  userTimeZone?: string
) {
  const normalizedUserTimeZone = normalizeTimeZone(userTimeZone, courseTimeZone);
  const primaryTime = formatAvailabilityTime(time.startsAtDate, courseTimeZone);
  const userLocalTime = normalizedUserTimeZone === courseTimeZone
    ? ""
    : `${formatAvailabilityTime(time.startsAtDate, normalizedUserTimeZone, true)} for you`;
  const userNote = userLocalTime
    ? `<span style="color:${time.isNew ? "rgba(255,255,255,.58)" : EMAIL_COLORS.muted};display:block;font-size:9px;font-weight:500;line-height:13px;margin-top:2px">${escapeHtml(userLocalTime)}</span>`
    : "";
  const newBadge = time.isNew
    ? `<span style="color:${EMAIL_COLORS.orange};display:inline-block;font-size:8px;font-weight:800;letter-spacing:.64px;line-height:12px;margin-left:6px;vertical-align:1px">NEW</span>`
    : "";
  const background = time.isNew ? EMAIL_COLORS.dark : "#eaf3ee";
  const border = time.isNew ? "#1f7a4d" : "#c8e6d2";
  const textColor = time.isNew ? "#6dbf9c" : "#1f7a4d";

  return `
    <td class="time-pill-cell" width="25%" style="box-sizing:border-box;padding:4px;vertical-align:top">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate!important">
        <tr>
          <td align="center" bgcolor="${background}" style="background:${background};border:1px solid ${border};border-radius:10px;font-family:Inter,Arial,sans-serif;line-height:18px;padding:8px 6px;white-space:nowrap">
            <span style="color:${textColor};font-size:12px;font-weight:${time.isNew ? 700 : 500}">${escapeHtml(primaryTime)}</span>${newBadge}${userNote}
          </td>
        </tr>
      </table>
    </td>
  `;
}

function renderMonitoringSection(input: CustomerEmailRenderInput) {
  const cards = [...(input.monitoringCourses ?? [])]
    .sort((left, right) => left.rank - right.rank)
    .map((course) => renderMonitoringCard(course, input.assetBaseUrl))
    .join("");
  const cadence = input.showCadenceNote === false
    ? ""
    : `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 0">
        <tr>
          <td style="background:#f2f4f2;border:1px solid #e8eeeb;border-radius:14px;color:${EMAIL_COLORS.muted};font-family:Inter,Arial,sans-serif;font-size:12px;line-height:19px;padding:12px 16px">
            We only send an instant email when a new time matches your exact date, time window, and player count. Otherwise, you'll receive at most one morning status update per day.
          </td>
        </tr>
      </table>
    `;
  const checkedAt = input.checkedAt
    ? `<p style="color:${EMAIL_COLORS.paleMuted};font-family:Inter,Arial,sans-serif;font-size:11px;line-height:17px;margin:12px 0 0">Last checked on ${escapeHtml(formatCheckedAt(input.checkedAt, input.userTimeZone))}</p>`
    : "";

  return `
    <div style="padding-top:0">
      <h2 style="color:${EMAIL_COLORS.dark};font-family:Inter,Arial,sans-serif;font-size:18px;font-weight:800;line-height:27px;margin:0 0 4px">What we're watching for you</h2>
      <p style="color:${EMAIL_COLORS.muted};font-family:Inter,Arial,sans-serif;font-size:13px;line-height:21px;margin:0 0 20px">Here's the status of each course on your list. Some we monitor automatically &mdash; others need you to check directly.</p>
      ${cards}
      ${cadence}
      ${checkedAt}
      ${renderEmailStopControls(input.stopUrls)}
    </div>
  `;
}

function renderMonitoringCard(course: CustomerEmailMonitoringCourse, assetBaseUrl?: string) {
  const toneColor = {
    monitored: "#6dbf9c",
    scheduled: "#79b7cd",
    adding: "#d9862f",
    retrying: "#e28b82",
    direct: "#e3b566"
  }[course.tone];
  const safeBookingUrl = getSafeCustomerBookingUrl(course.bookingUrl);
  const bookingLink = safeBookingUrl
    ? `<a href="${escapeHtml(safeBookingUrl)}" style="color:#087746;display:inline-block;font-family:Inter,Arial,sans-serif;font-size:12px;font-weight:800;line-height:18px;margin:10px 16px 0 0;text-decoration:none">${escapeHtml(course.bookingLinkLabel ?? "Open official site")} &rarr;</a>`
    : "";
  const phoneHref = course.phone ? formatTelephoneHref(course.phone) : "";
  const phoneLink = phoneHref
    ? `<a href="${escapeHtml(phoneHref)}" style="color:#087746;display:inline-block;font-family:Inter,Arial,sans-serif;font-size:12px;font-weight:800;line-height:18px;margin:10px 0 0;text-decoration:none">Call ${escapeHtml(course.phone ?? "the course")} &rarr;</a>`
    : "";
  const courseGuideLink = course.courseGuideUrl
    ? `<a href="${escapeHtml(absoluteUrl(course.courseGuideUrl))}" style="color:#087746;display:inline-block;font-family:Inter,Arial,sans-serif;font-size:12px;font-weight:800;line-height:18px;margin:10px 16px 0 0;text-decoration:none">Course Guide &rarr;</a>`
    : "";
  const factLine = course.factLine
    ? `<p style="color:${EMAIL_COLORS.dark};font-family:Inter,Arial,sans-serif;font-size:12px;font-weight:700;line-height:19px;margin:0 0 8px">${escapeHtml(course.factLine)}</p>`
    : "";

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid ${EMAIL_COLORS.line};border-collapse:separate!important;border-radius:16px;margin:0 0 12px;overflow:hidden">
      ${renderCoursePhotoHeader({
        badge: `PRIORITY ${course.rank} &middot; ${escapeHtml(course.badgeLabel)}`,
        badgeColor: toneColor,
        courseName: course.courseName,
        courseAddress: course.courseAddress,
        rank: course.rank,
        assetBaseUrl
      })}
      <tr>
        <td style="background:#ffffff;color:${EMAIL_COLORS.muted};font-family:Inter,Arial,sans-serif;font-size:13px;line-height:20px;padding:16px 20px">
          ${factLine}
          &bull; ${escapeHtml(course.detail)}
          ${bookingLink || phoneLink || courseGuideLink ? `<div>${bookingLink}${courseGuideLink}${phoneLink}</div>` : ""}
        </td>
      </tr>
    </table>
  `;
}

function renderCoursePhotoHeader(input: {
  badge: string;
  badgeColor: string;
  courseName: string;
  courseAddress?: string;
  rank: number;
  subline?: string;
  assetBaseUrl?: string;
}) {
  const assetUrl = getCourseAssetUrl(input.rank, input.assetBaseUrl);
  const location = formatCompactCourseLocation(input.courseAddress);
  const locationCell = location
    ? `<td class="course-location" align="right" style="color:rgba(255,255,255,.52);font-family:Inter,Arial,sans-serif;font-size:11px;line-height:17px;white-space:nowrap">&#128205; ${escapeHtml(location)}</td>`
    : "";

  return `
    <tr>
      <td background="${escapeHtml(assetUrl)}" bgcolor="${EMAIL_COLORS.dark}" style="background-color:${EMAIL_COLORS.dark};background-image:url('${escapeHtml(assetUrl)}');background-position:center;background-repeat:no-repeat;background-size:cover;height:104px">
        <!--[if gte mso 9]>
        <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:614px;height:104px;">
          <v:fill type="frame" src="${escapeHtml(assetUrl)}" color="${EMAIL_COLORS.dark}" />
          <v:textbox inset="0,0,0,0">
        <![endif]-->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="height:104px">
          <tr>
            <td style="padding:16px 20px;vertical-align:top">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:top">
                    <span style="background:rgba(109,191,156,.18);border-radius:999px;color:${input.badgeColor};display:inline-block;font-family:Inter,Arial,sans-serif;font-size:9px;font-weight:800;letter-spacing:.9px;line-height:14px;margin:0 0 8px;padding:2px 8px">${input.badge}</span>
                    <p style="color:#ffffff;font-family:Inter,Arial,sans-serif;font-size:17px;font-weight:800;line-height:20px;margin:0">${escapeHtml(input.courseName)}</p>
                    ${input.subline ? `<p style="color:rgba(255,255,255,.58);font-family:Inter,Arial,sans-serif;font-size:12px;line-height:18px;margin:2px 0 0">${input.subline}</p>` : ""}
                  </td>
                  ${locationCell}
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <!--[if gte mso 9]>
          </v:textbox>
        </v:rect>
        <![endif]-->
      </td>
    </tr>
  `;
}

function normalizeAvailabilityTimes<T extends CustomerEmailAvailabilityTime>(
  times: T[],
  timeZone: string
): Array<T & { startsAtDate: Date }> {
  return times
    .map((time) => ({
      ...time,
      startsAtDate: time.startsAt instanceof Date
        ? time.startsAt
        : zonedDateTimeToDate(time.startsAt, timeZone)
    }))
    .filter((time) => !Number.isNaN(time.startsAtDate.getTime()))
    .sort((left, right) => left.startsAtDate.getTime() - right.startsAtDate.getTime());
}

function selectVisibleAvailabilityTimes<
  T extends CustomerEmailAvailabilityTime & { startsAtDate: Date }
>(times: T[]) {
  return [...times]
    .sort(
      (left, right) =>
        Number(right.isNew === true) - Number(left.isNew === true) ||
        left.startsAtDate.getTime() - right.startsAtDate.getTime()
    )
    .slice(0, MAX_EMAIL_AVAILABILITY_PILLS_PER_COURSE)
    .sort((left, right) => left.startsAtDate.getTime() - right.startsAtDate.getTime());
}

function chunkAvailabilityTimes<
  T extends CustomerEmailAvailabilityTime & { startsAtDate: Date }
>(times: T[]) {
  const rows: T[][] = [];
  for (let index = 0; index < times.length; index += 4) {
    rows.push(times.slice(index, index + 4));
  }
  return rows;
}

export function getRenderedAvailabilityStartTimes(
  times: CustomerEmailAvailabilityTime[],
  timeZone?: string
) {
  return getRenderedAvailabilityTimes(times, timeZone).map((match) =>
    match.startsAtDate.getTime()
  );
}

export function getRenderedAvailabilityTimes<
  T extends CustomerEmailAvailabilityTime
>(times: T[], timeZone?: string) {
  const normalizedTimeZone = normalizeTimeZone(timeZone, DEFAULT_TIME_ZONE);
  return selectVisibleAvailabilityTimes(
    normalizeAvailabilityTimes(times, normalizedTimeZone)
  );
}

function formatAvailabilityTime(
  startsAt: Date,
  timeZone: string,
  includeWeekday = false
) {
  return startsAt.toLocaleString("en-US", {
    ...(includeWeekday ? { weekday: "short" as const } : {}),
    hour: "numeric",
    minute: "2-digit",
    timeZone
  });
}

function formatCheckedAt(value: Date, timeZone?: string) {
  const normalizedTimeZone = normalizeTimeZone(timeZone, DEFAULT_TIME_ZONE);
  const date = value.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: normalizedTimeZone
  });
  const time = value.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: normalizedTimeZone,
    timeZoneName: "short"
  });
  return `${date} at ${time}`;
}

function formatSearchDate(value: string) {
  return new Date(`${value}T12:00:00.000Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  });
}

function formatClockTime(value: string) {
  const [hours = 0, minutes = 0] = value.split(":").map(Number);
  const suffix = hours >= 12 ? "PM" : "AM";
  return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function getCourseAssetUrl(rank: number, assetBaseUrl?: string) {
  const assetPath = `/email/course-card-${rank % 2 === 0 ? 2 : 1}.png`;
  if (assetBaseUrl === "") {
    return assetPath;
  }
  if (assetBaseUrl) {
    return new URL(assetPath, assetBaseUrl).toString();
  }
  return absoluteUrl(assetPath);
}

function formatPriceRange(prices: number[]) {
  if (prices.length === 0) {
    return null;
  }
  const minimum = Math.min(...prices);
  const maximum = Math.max(...prices);
  return minimum === maximum
    ? formatPrice(minimum)
    : `${formatPrice(minimum)}&ndash;${formatPrice(maximum)}`;
}

function formatPrice(priceCents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: priceCents % 100 === 0 ? 0 : 2
  }).format(priceCents / 100);
}

function formatTelephoneHref(phone: string) {
  const normalized = phone.trim().replace(/(?!^\+)[^\d]/g, "");
  return normalized ? `tel:${normalized}` : "";
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
