import { ExternalLink } from "lucide-react";

import { renderAlertHtml } from "@/lib/email/alerts";

const previewAlert = {
  to: "preview@teetimespot.com",
  courseName: "Tashua Knolls Golf Course",
  startsAt: new Date("2026-07-15T17:50:00.000Z"),
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
            Alert email preview
          </p>
          <h1>New tee time alert</h1>
          <p className="meta">
            This renders the same HTML sent by the alert worker, using fixed sample data and
            no email side effects.
          </p>
        </div>
        <a className="button button-secondary" href={previewAlert.bookingUrl}>
          Official booking page
          <ExternalLink size={18} />
        </a>
      </div>

      <section className="preview-grid" aria-label="Alert preview details">
        <div className="preview-card">
          <h2>Message data</h2>
          <dl className="preview-data">
            <div>
              <dt>Course</dt>
              <dd>{previewAlert.courseName}</dd>
            </div>
            <div>
              <dt>Time</dt>
              <dd>{previewAlert.startsAt.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Players</dt>
              <dd>{previewAlert.availableSpots}</dd>
            </div>
            <div>
              <dt>Recipient</dt>
              <dd>{previewAlert.to}</dd>
            </div>
          </dl>
        </div>

        <div className="preview-card">
          <h2>Email HTML</h2>
          <iframe
            className="email-frame"
            title="Rendered tee time alert email"
            srcDoc={html}
          />
        </div>
      </section>
    </main>
  );
}
