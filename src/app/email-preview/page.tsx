import type { Metadata } from "next";
import { Bell, CalendarCheck2, Clock3, ExternalLink, Mail, Search } from "lucide-react";

import { renderAlertHtml } from "@/lib/email/alerts";
import { renderSearchStatusHtml } from "@/lib/email/search-status";

export const metadata: Metadata = {
  title: "Email Preview",
  description: "Preview Tee Time Spot search updates and match alerts.",
  robots: {
    index: false,
    follow: false
  }
};

const previewStopUrls = {
  booked: "https://teetimespot.com/alerts/stop?token=preview-booked",
  cancelled: "https://teetimespot.com/alerts/stop?token=preview-cancelled"
};

const previewAlert = {
  to: "preview@teetimespot.com",
  searchId: "preview-search",
  matches: [
    {
      courseName: "Tashua Knolls Golf Course",
      startsAt: new Date("2026-07-15T13:50:00-04:00"),
      availableSpots: 3,
      priceCents: 5500,
      holes: 18,
      bookingUrl: "https://foreupsoftware.com/index.php/booking/19765/2431",
      isNew: true
    }
  ],
  stopUrls: previewStopUrls
};

const previewStatus = {
  searchId: "preview-search",
  to: "preview@teetimespot.com",
  kind: "setup" as const,
  targetDate: "2026-07-15",
  startTime: "07:30",
  endTime: "09:00",
  players: 2,
  checkedAt: new Date("2026-07-10T08:15:00-04:00"),
  courses: [
    {
      courseId: "fairview-farm",
      courseName: "Fairview Farm Golf Course",
      outcome: "BLOCKED_POLICY" as const,
      availableMatches: 0,
      bookingUrl: "https://fairviewfarmgc.com/",
      phone: "(860) 689-1000",
      bookingMethod: "PHONE_ONLY" as const,
      bookingAccess: "OFFICIAL_SITE" as const
    },
    {
      courseId: "oak-lane",
      courseName: "Oak Lane Country Club",
      outcome: "NEEDS_ADAPTER" as const,
      availableMatches: 0,
      bookingUrl: "https://example.com/oak-lane"
    },
    {
      courseId: "fairchild",
      courseName: "Fairchild Wheeler Golf Course",
      outcome: "MATCH_FOUND" as const,
      availableMatches: 2,
      bookingUrl:
        "https://fairchild-wheeler-red-course.book.teeitup.golf/?date=2026-07-15",
      availability: {
        visibleSlotCount: 12,
        playerEligibleSlotCount: 10
      },
      matchingTimes: [
        {
          startsAt: "2026-07-15T07:40:00-04:00",
          availableSpots: 4,
          priceCents: 6700,
          holes: 18
        },
        {
          startsAt: "2026-07-15T08:10:00-04:00",
          availableSpots: 2,
          priceCents: 6700,
          holes: 18
        }
      ]
    },
    {
      courseId: "tashua",
      courseName: "Tashua Knolls Golf Course",
      outcome: "NO_MATCH" as const,
      availableMatches: 0,
      bookingUrl: "https://foreupsoftware.com/index.php/booking/19765/2431",
      availability: {
        visibleSlotCount: 18,
        playerEligibleSlotCount: 18,
        closestAfter: "2026-07-15T16:50"
      }
    },
    {
      courseId: "richter",
      courseName: "Richter Park Golf Course",
      outcome: "NO_MATCH" as const,
      availableMatches: 0,
      bookingUrl: "https://richterpark.cps.golf/",
      availability: {
        visibleSlotCount: 9,
        playerEligibleSlotCount: 9,
        closestBefore: "2026-07-15T07:10"
      }
    },
    {
      courseId: "whitney",
      courseName: "Whitney Farms Golf Course",
      outcome: "NO_MATCH" as const,
      availableMatches: 0,
      availability: { visibleSlotCount: 4, playerEligibleSlotCount: 0 }
    },
    {
      courseId: "vue",
      courseName: "The VUE CT",
      outcome: "NO_MATCH" as const,
      availableMatches: 0,
      availability: { visibleSlotCount: 0, playerEligibleSlotCount: 0 }
    }
  ],
  stopUrls: previewStopUrls
};

export default function EmailPreviewPage() {
  const statusHtml = renderSearchStatusHtml(previewStatus);
  const alertHtml = renderAlertHtml(previewAlert);

  return (
    <main className="preview-page">
      <div className="preview-header">
        <div>
          <p className="eyebrow" style={{ color: "var(--fairway-dark)" }}>
            What your emails look like
          </p>
          <h1>Useful updates, without inbox noise.</h1>
          <p className="meta">
            We send one setup report after your first check, at most one course-status update per
            day, and an instant email only when a new time opens inside your exact range.
          </p>
        </div>
        <a className="button button-secondary" href={previewAlert.matches[0].bookingUrl}>
          Official booking page
          <ExternalLink size={18} />
        </a>
      </div>

      <section className="preview-grid email-preview-layout" aria-label="Search status email preview">
        <div className="preview-card email-browser-card">
          <div className="email-browser-chrome">
            <span />
            <span />
            <span />
            <strong>Search update from Tee Time Spot - preview@teetimespot.com</strong>
          </div>
          <iframe
            className="email-frame email-status-frame"
            title="Rendered search status email"
            srcDoc={statusHtml}
          />
        </div>

        <aside className="preview-card preview-sidebar">
          <h2>What the status report tells you</h2>
          <div className="delivery-step">
            <CalendarCheck2 size={18} />
            <div>
              <strong>One report when your search starts</strong>
              <p className="meta">It confirms what each selected course showed on the first check.</p>
            </div>
          </div>
          <div className="delivery-step">
            <Search size={18} />
            <div>
              <strong>Clear monitoring status</strong>
              <p className="meta">
                Each priority is marked fully monitored, we’re working on it, official-site only,
                or phone only before the latest availability detail.
              </p>
            </div>
          </div>
          <div className="delivery-step">
            <Mail size={18} />
            <div>
              <strong>At most one daily update</strong>
              <p className="meta">Repeated checks stay silent when nothing useful has changed.</p>
            </div>
          </div>
          <div className="alert alert-info">
            <Bell size={17} />
            <span>
              Status reports are separate from match alerts. A new qualifying opening still gets
              an immediate email.
            </span>
          </div>
        </aside>
      </section>

      <div className="preview-header preview-section-header">
        <div>
          <p className="eyebrow" style={{ color: "var(--fairway-dark)" }}>
            Instant match alert
          </p>
          <h2>A new time opened in your range.</h2>
          <p className="meta">
            This email is reserved for a genuinely new matching slot and includes the official
            booking link.
          </p>
        </div>
      </div>

      <section className="preview-grid email-preview-layout" aria-label="Instant match email preview">
        <div className="preview-card email-browser-card">
          <div className="email-browser-chrome">
            <span />
            <span />
            <span />
            <strong>Match alert from Tee Time Spot - preview@teetimespot.com</strong>
          </div>
          <iframe
            className="email-frame"
            title="Rendered tee time alert email"
            srcDoc={alertHtml}
          />
        </div>

        <aside className="preview-card preview-sidebar">
          <h2>How the match alert works</h2>
          <div className="delivery-step">
            <Mail size={18} />
            <div>
              <strong>Instant only for a new match</strong>
              <p className="meta">It must fit your date, time window, and player count.</p>
            </div>
          </div>
          <div className="delivery-step">
            <ExternalLink size={18} />
            <div>
              <strong>Direct booking link</strong>
              <p className="meta">
                One click goes straight to the course&apos;s booking page. No payment from us,
                ever.
              </p>
            </div>
          </div>

          <div className="matched-alert-card">
            <h3>This alert matched</h3>
            <dl className="preview-data">
              <div>
                <dt>Date</dt>
                <dd>Wed, Jul 15</dd>
              </div>
              <div>
                <dt>Window</dt>
                <dd>1:40 - 4:00 PM</dd>
              </div>
              <div>
                <dt>Golfers</dt>
                <dd>{previewAlert.matches[0].availableSpots} players</dd>
              </div>
              <div>
                <dt>Sent to</dt>
                <dd>{previewAlert.to}</dd>
              </div>
            </dl>
          </div>

          <div className="alert alert-info">
            <Bell size={17} />
            <span>
              Tee times go fast. The link in your email is live the moment we send it, so check
              your inbox and book quickly.
            </span>
          </div>
          <div className="mini-pill preview-time-pill">
            <Clock3 size={13} />
            Email-only alerts for v1
          </div>
        </aside>
      </section>
    </main>
  );
}
