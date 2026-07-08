import { ArrowRight, Bell, MapPin, Search } from "lucide-react";

import { TeeTimeIntake } from "@/components/tee-time-intake";

export default function HomePage() {
  return (
    <main>
      <section className="hero">
        <div className="hero-content">
          <p className="eyebrow">Public-course tee time alerts</p>
          <h1>Tee Time Spot</h1>
          <p className="hero-copy">
            Rank the courses you actually want, set a date and time window, and get alerted
            when a matching tee time appears.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href="#start">
              <Search size={18} />
              Start a search
            </a>
            <a className="button button-secondary" href="/dashboard">
              View dashboard
              <ArrowRight size={18} />
            </a>
          </div>
        </div>
        <div className="hero-strip" aria-label="How Tee Time Spot works">
          <div className="hero-strip-item">
            <strong>1-5 courses</strong>
            <span>Rank nearby public courses by preference.</span>
          </div>
          <div className="hero-strip-item">
            <strong>15 min checks</strong>
            <span>Known adapters poll for matching slots.</span>
          </div>
          <div className="hero-strip-item">
            <strong>Alert only</strong>
            <span>You finish booking on the official site.</span>
          </div>
        </div>
      </section>

      <section className="section section-tight" id="start">
        <div className="section-heading">
          <p className="eyebrow" style={{ color: "var(--fairway-dark)" }}>
            Build your watchlist
          </p>
          <h2>Tell us where and when you want to play.</h2>
          <p>
            Tee Time Spot stores your preferences as a searchable queue. The Codex loop checks
            supported courses, records what happened, and only emails when a new qualifying
            slot appears.
          </p>
        </div>
        <TeeTimeIntake />
      </section>

      <section className="section flow-band">
        <div className="section-heading">
          <p className="eyebrow" style={{ color: "var(--fairway-dark)" }}>
            Alert-first automation
          </p>
          <h2>No checkout bots. No mystery bookings.</h2>
        </div>
        <div className="flow-grid">
          <div className="flow-step">
            <MapPin size={22} />
            <h3>Discover courses</h3>
            <p>Google Places finds nearby public-course candidates from your location.</p>
          </div>
          <div className="flow-step">
            <Bell size={22} />
            <h3>Watch ranked demand</h3>
            <p>The database keeps course priority, time window, player count, and run state.</p>
          </div>
          <div className="flow-step">
            <ArrowRight size={22} />
            <h3>Book officially</h3>
            <p>Alerts link back to the course tee sheet. Payment and accounts stay there.</p>
          </div>
        </div>
      </section>
    </main>
  );
}
