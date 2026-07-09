import type { Metadata } from "next";
import { Bell, Clock3, ExternalLink, Mail, Search } from "lucide-react";

import { renderAlertHtml } from "@/lib/email/alerts";

export const metadata: Metadata = {
  title: "Email Preview",
  description: "Preview a Tee Time Spot alert email.",
  robots: {
    index: false,
    follow: false
  }
};

const previewAlert = {
  to: "preview@teetimespot.com",
  courseName: "Tashua Knolls Golf Course",
  startsAt: new Date("2026-07-15T17:50:00-04:00"),
  availableSpots: 3,
  bookingUrl: "https://foreupsoftware.com/index.php/booking/19765/2431"
};

export default function EmailPreviewPage() {
  const html = renderAlertHtml(previewAlert);

  return (
    <main className="preview-page">
      <div className="preview-header">
        <div>
          <p className="eyebrow" style={{ color: "var(--fairway-dark)" }}>
            What your alert looks like
          </p>
          <h1>Your tee time is waiting.</h1>
          <p className="meta">
            The moment a spot opens up at one of your courses, this is the email that lands in
            your inbox with a direct link to book it right then and there.
          </p>
        </div>
        <a className="button button-secondary" href={previewAlert.bookingUrl}>
          Official booking page
          <ExternalLink size={18} />
        </a>
      </div>

      <section className="preview-grid email-preview-layout" aria-label="Alert preview details">
        <div className="preview-card email-browser-card">
          <div className="email-browser-chrome">
            <span />
            <span />
            <span />
            <strong>Alert from Tee Time Spot - preview@teetimespot.com</strong>
          </div>
          <iframe
            className="email-frame"
            title="Rendered tee time alert email"
            srcDoc={html}
          />
        </div>

        <aside className="preview-card preview-sidebar">
          <h2>How it gets to you</h2>
          <div className="delivery-step">
            <Search size={18} />
            <div>
              <strong>We watch 24/7</strong>
              <p className="meta">As soon as a slot opens at one of your courses, we catch it.</p>
            </div>
          </div>
          <div className="delivery-step">
            <Mail size={18} />
            <div>
              <strong>Instant email</strong>
              <p className="meta">You get an email right away. No app, no checking, no waiting.</p>
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
                <dd>{previewAlert.availableSpots} players</dd>
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
