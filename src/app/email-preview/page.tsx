import type { Metadata } from "next";
import { Bell, ExternalLink, Mail } from "lucide-react";

import { EmailPreviewFrame } from "@/components/email-preview-frame";
import {
  renderAlertHtml,
  type TeeTimeAlertInput
} from "@/lib/email/alerts";
import {
  renderSearchStatusHtml,
  type SearchStatusEmailInput
} from "@/lib/email/search-status";

export const metadata: Metadata = {
  title: "Email Preview",
  description: "Preview one complete Tee Time Spot customer email.",
  robots: {
    index: false,
    follow: false
  }
};

type EmailPreviewPageProps = {
  searchParams: Promise<{
    variant?: string;
  }>;
};

type PreviewVariant = "morning" | "setup" | "instant";

const previewVariants = ["morning", "setup", "instant"] as const;

const previewStopUrls = {
  booked: "/alerts/stop?token=preview-booked",
  cancelled: "/alerts/stop?token=preview-cancelled"
};

const previewCourses: SearchStatusEmailInput["courses"] = [
  {
    courseId: "pinebrook",
    courseName: "Pinebrook Golf Club",
    rank: 1,
    courseAddress: "1 Pinebrook Drive, Glastonbury, CT 06033, United States",
    timeZone: "America/New_York",
    outcome: "MATCH_FOUND",
    availableMatches: 3,
    bookingUrl: "https://example.com/pinebrook-booking",
    bookingMethod: "PUBLIC_ONLINE",
    bookingAccess: "BOOKING_PAGE",
    availability: {
      visibleSlotCount: 14,
      playerEligibleSlotCount: 12
    },
    matchingTimes: [
      {
        startsAt: "2026-07-18T07:42:00-04:00",
        availableSpots: 4,
        priceCents: 5800,
        bookableHoleCounts: [9, 18],
        isNew: true
      },
      {
        startsAt: "2026-07-18T08:05:00-04:00",
        availableSpots: 3,
        priceCents: 6200,
        holes: 18,
        isNew: false
      },
      {
        startsAt: "2026-07-18T08:20:00-04:00",
        availableSpots: 4,
        priceCents: 6200,
        holes: 18,
        isNew: false
      }
    ]
  },
  {
    courseId: "ridgecrest",
    courseName: "Ridgecrest Golf Course",
    rank: 2,
    courseAddress: "220 Ridge Road, Orange, CT 06477, USA",
    timeZone: "America/New_York",
    outcome: "MATCH_FOUND",
    availableMatches: 2,
    bookingUrl: "https://example.com/ridgecrest-booking",
    bookingMethod: "PUBLIC_ONLINE",
    bookingAccess: "BOOKING_PAGE",
    availability: {
      visibleSlotCount: 10,
      playerEligibleSlotCount: 8
    },
    matchingTimes: [
      {
        startsAt: "2026-07-18T08:12:00-04:00",
        availableSpots: 2,
        priceCents: 5400,
        holes: 18,
        isNew: true
      },
      {
        startsAt: "2026-07-18T08:36:00-04:00",
        availableSpots: 4,
        priceCents: 5400,
        holes: 18,
        isNew: false
      }
    ]
  },
  {
    courseId: "cedar-valley",
    courseName: "Cedar Valley Golf Course",
    rank: 3,
    courseAddress: "95 Cedar Lane, New Haven, CT 06511",
    timeZone: "America/New_York",
    outcome: "NO_MATCH",
    availableMatches: 0,
    bookingUrl: "https://example.com/cedar-valley",
    bookingMethod: "PUBLIC_ONLINE",
    bookingAccess: "BOOKING_PAGE",
    availability: {
      visibleSlotCount: 18,
      playerEligibleSlotCount: 18,
      closestAfter: "2026-07-18T11:10:00-04:00"
    }
  },
  {
    courseId: "lakeview",
    courseName: "Lakeview Municipal Golf Course",
    rank: 4,
    courseAddress: "16 Lakeview Road, Hartford, CT 06106",
    timeZone: "America/New_York",
    outcome: "NO_MATCH",
    availableMatches: 0,
    bookingUrl: "https://example.com/lakeview",
    bookingWindow: {
      releaseDate: "2026-07-11",
      releaseTimeLocal: "07:00",
      opensAt: "2026-07-11T07:00:00-04:00",
      timeZone: "America/New_York",
      exactTime: true
    }
  },
  {
    courseId: "meadow-hills",
    courseName: "Meadow Hills Golf Course",
    rank: 5,
    courseAddress: "400 Meadow Street, Branford, CT 06405",
    timeZone: "America/New_York",
    outcome: "NEEDS_ADAPTER",
    availableMatches: 0,
    bookingUrl: "https://example.com/meadow-hills"
  }
];

const baseStatusPreview = {
  searchId: "preview-search",
  to: "preview@teetimespot.com",
  targetDate: "2026-07-18",
  startTime: "07:30",
  endTime: "09:00",
  players: 2,
  requestedLayoutHoles: 18 as const,
  userTimeZone: "America/New_York",
  checkedAt: new Date("2026-07-15T08:15:00-04:00"),
  courses: previewCourses,
  stopUrls: previewStopUrls,
  assetBaseUrl: ""
};

const previewAlert: TeeTimeAlertInput = {
  to: "preview@teetimespot.com",
  searchId: "preview-search",
  matches: previewCourses.flatMap((course) =>
    (course.matchingTimes ?? []).map((match) => ({
      courseId: course.courseId,
      courseName: course.courseName,
      courseRank: course.rank,
      courseAddress: course.courseAddress,
      courseTimeZone: course.timeZone,
      startsAt: new Date(match.startsAt),
      availableSpots: match.availableSpots,
      bookingUrl: course.bookingUrl ?? "https://teetimespot.com",
      priceCents: match.priceCents,
      holes: match.holes,
      bookableHoleCounts: match.bookableHoleCounts,
      isNew: match.isNew
    }))
  ),
  targetDate: baseStatusPreview.targetDate,
  startTime: baseStatusPreview.startTime,
  endTime: baseStatusPreview.endTime,
  players: baseStatusPreview.players,
  requestedLayoutHoles: baseStatusPreview.requestedLayoutHoles,
  userTimeZone: baseStatusPreview.userTimeZone,
  checkedAt: baseStatusPreview.checkedAt,
  stopUrls: previewStopUrls,
  assetBaseUrl: ""
};

export default async function EmailPreviewPage({
  searchParams
}: EmailPreviewPageProps) {
  const requestedVariant = (await searchParams).variant;
  const variant: PreviewVariant =
    requestedVariant === "setup" || requestedVariant === "instant"
      ? requestedVariant
      : "morning";
  const isInstant = variant === "instant";
  const statusPreview: SearchStatusEmailInput = {
    ...baseStatusPreview,
    kind: variant === "setup" ? "setup" : "daily"
  };
  const emailHtml = isInstant
    ? renderAlertHtml(previewAlert)
    : renderSearchStatusHtml(statusPreview);
  const title = variant === "setup"
    ? "Setup report"
    : variant === "instant"
      ? "Instant alert"
      : "Morning update";
  const subject = variant === "setup"
    ? "Your Tee Time Spot search is active"
    : variant === "instant"
      ? "New tee times opened at your priority courses"
      : "Your morning Tee Time Spot update";

  return (
    <main className="preview-page">
      <div className="preview-header">
        <div>
          <p className="eyebrow" style={{ color: "var(--fairway-dark)" }}>
            Full customer email
          </p>
          <h1>{title}</h1>
          <p className="meta">
            This is the complete email body, rendered with the same HTML and data shape used for
            production delivery.
          </p>
        </div>
        <a className="button button-secondary" href={previewAlert.matches[0]?.bookingUrl}>
          Official booking page
          <ExternalLink size={18} />
        </a>
      </div>

      <nav aria-label="Email variants" className="email-preview-tabs">
        {previewVariants.map((option) => (
          <a
            aria-current={variant === option ? "page" : undefined}
            className={variant === option ? "button button-dark" : "button button-secondary"}
            href={option === "morning" ? "/email-preview" : `/email-preview?variant=${option}`}
            key={option}
          >
            {option === "morning" ? "Morning" : option === "setup" ? "Setup" : "Instant"}
          </a>
        ))}
      </nav>

      <section className="preview-grid email-preview-layout" aria-label={`${title} email preview`}>
        <div className="preview-card email-browser-card">
          <div className="email-browser-chrome">
            <span />
            <span />
            <span />
            <strong>{subject} — preview@teetimespot.com</strong>
          </div>
          <EmailPreviewFrame
            className="email-frame email-status-frame"
            initialHeight={isInstant ? 1320 : 2480}
            key={variant}
            srcDoc={emailHtml}
            title={`Rendered ${title.toLowerCase()} email`}
          />
        </div>

        <aside className="preview-card preview-sidebar">
          <h2>Production behavior</h2>
          <div className="delivery-step">
            <Mail size={18} />
            <div>
              <strong>One real template at a time</strong>
              <p className="meta">
                Switch variants above without stacking or cutting off another email.
              </p>
            </div>
          </div>
          <div className="delivery-step">
            <Bell size={18} />
            <div>
              <strong>Truthful availability</strong>
              <p className="meta">
                Only persisted pending matches receive a NEW badge; earlier availability stays
                grouped into hourly windows.
              </p>
            </div>
          </div>
          <div className="alert alert-info">
            Setup and morning updates include every selected course&apos;s monitoring state.
            Instant alerts stay focused on matching availability.
          </div>
        </aside>
      </section>
    </main>
  );
}
