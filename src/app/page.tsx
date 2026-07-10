import type { Metadata } from "next";
import { ArrowRight, Bell, Check, MapPin, Search } from "lucide-react";

import { DiscordMark } from "@/components/discord-mark";
import { HomeSearchForm } from "@/components/home-search-form";
import { discordInviteUrl } from "@/lib/community";
import { absoluteUrl, siteDescription, siteName } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Public Golf Tee Time Alerts",
  description: siteDescription,
  alternates: {
    canonical: "/"
  }
};

const homeStructuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${absoluteUrl("/")}#organization`,
      name: siteName,
      url: absoluteUrl("/")
    },
    {
      "@type": "WebSite",
      "@id": `${absoluteUrl("/")}#website`,
      name: siteName,
      url: absoluteUrl("/"),
      description: siteDescription,
      publisher: {
        "@id": `${absoluteUrl("/")}#organization`
      },
      inLanguage: "en-US"
    },
    {
      "@type": "WebApplication",
      "@id": `${absoluteUrl("/")}#app`,
      name: siteName,
      url: absoluteUrl("/"),
      applicationCategory: "SportsApplication",
      operatingSystem: "Web",
      description: siteDescription,
      isAccessibleForFree: true,
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD"
      }
    }
  ]
};

export default function HomePage() {
  return (
    <main>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(homeStructuredData).replace(/</g, "\\u003c")
        }}
      />
      <section className="hero">
        <div className="hero-content">
          <p className="eyebrow">For public course golfers</p>
          <h1>
            Stop settling
            <br className="mobile-hero-break" /> for
            <br />
            your backup course.
          </h1>
          <p className="hero-copy">
            Your favorites were full, so you booked your third choice. We watch your top
            picks around the clock — the moment a spot opens, you get a direct link to grab
            it and play where you actually wanted.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" data-analytics-event="start_search_clicked" href="/search">
              <Search size={16} />
              Find my tee time
            </a>
            <a className="button button-secondary" data-analytics-event="dashboard_opened" href="/dashboard">
              My alerts
              <ArrowRight size={16} />
            </a>
          </div>
        </div>
        <div className="hero-strip" aria-label="How Tee Time Spot works">
          <div className="hero-strip-item">
            <strong>Rank your top 5 courses</strong>
            <span>Tell us where you&apos;d rather play — #1 gets watched hardest</span>
          </div>
          <div className="hero-strip-item">
            <strong>Book a backup, wait for us</strong>
            <span>We check every few minutes so you don&apos;t have to keep refreshing</span>
          </div>
          <div className="hero-strip-item">
            <strong>Switch to your first choice</strong>
            <span>Cancel the backup, click the link in your email, and play where you wanted</span>
          </div>
        </div>
      </section>

      <section className="scenario-section" aria-labelledby="scenario-heading">
        <div className="scenario-inner">
          <p className="eyebrow" id="scenario-heading">A real example</p>
          <div className="scenario-grid">
            <article className="scenario-card scenario-plan">
              <p className="scenario-label">The plan</p>
              <div className="scenario-course">
                <span>1</span>
                <strong>Pinebrook Golf Club</strong>
                <em>Full</em>
              </div>
              <div className="scenario-course">
                <span>2</span>
                <strong>Ridgecrest Links</strong>
                <em>Full</em>
              </div>
              <div className="scenario-backup">
                <span aria-hidden="true">😞</span>
                <div>
                  <small>Booked instead:</small>
                  <strong>Maplewood Municipal</strong>
                </div>
              </div>
            </article>

            <article className="scenario-card scenario-alert-card">
              <span className="scenario-bell" aria-hidden="true"><Bell size={18} /></span>
              <p className="scenario-label">We found it — we notified you</p>
              <h2>New tee time at Ridgecrest Links — your #2 pick just opened up</h2>
              <p>Sat 2:10 PM · 3 players · Direct booking link below</p>
              <span className="scenario-book-link">Book now →</span>
            </article>

            <article className="scenario-card scenario-result">
              <p className="scenario-label">What the user did</p>
              <div className="scenario-result-step">
                <span aria-hidden="true"><Check size={12} /></span>
                <p>Cancelled their Maplewood Municipal tee time</p>
              </div>
              <div className="scenario-result-step">
                <span aria-hidden="true"><Check size={12} /></span>
                <p>Clicked the link we sent and booked Ridgecrest Links</p>
              </div>
              <div className="scenario-result-step">
                <span aria-hidden="true"><Check size={12} /></span>
                <p>Played their first choice — not the backup</p>
              </div>
              <div className="scenario-finish">
                <span aria-hidden="true">🎉</span>
                <p>We found it. We told them. They switched. That&apos;s the whole thing.</p>
              </div>
            </article>
          </div>
        </div>
      </section>

      <section className="section section-tight" id="start">
        <div className="section-heading">
          <p className="eyebrow" style={{ color: "var(--fairway-dark)" }}>
            Set up your alert
          </p>
          <h2>Tell us where and when you want to play.</h2>
          <p>
            Pick your courses, set the day and time you&apos;re free, and we&apos;ll send you an
            email the moment a spot opens up.
          </p>
        </div>
        <div className="home-intake-layout">
          <HomeSearchForm />
          <aside className="home-course-summary">
            <span className="home-course-summary-icon" aria-hidden="true">
              <MapPin size={18} />
            </span>
            <h3>Your courses</h3>
            <p>
              Pick up to 5 courses and put your top choice first — that&apos;s where we&apos;ll
              look hardest.
            </p>
            <div>No courses selected yet</div>
            <a className="button button-primary" href="/search">
              <Search size={15} />
              Find my tee time
            </a>
            <small>We&apos;ll alert you the moment your first choice opens up.</small>
          </aside>
        </div>
      </section>

      <section className="section flow-band how-it-works-section">
        <div className="section-heading">
          <p className="eyebrow" style={{ color: "var(--fairway-dark)" }}>
            How it works
          </p>
          <h2>Four steps from backup plan to where you actually wanted.</h2>
        </div>
        <div className="how-steps-grid">
          <div className="flow-step">
            <span>01</span>
            <div>
              <h3>Rank your top 5 courses</h3>
              <p>
                Search public courses near you. Pick the ones you&apos;d kill to play and
                order them by preference — #1 is your dream, #5 is fine.
              </p>
            </div>
          </div>
          <div className="flow-step">
            <span>02</span>
            <div>
              <h3>Tell us your window</h3>
              <p>Choose the day, your available time range, and how many players. We handle the rest.</p>
            </div>
          </div>
          <div className="flow-step">
            <span>03</span>
            <div>
              <h3>Book a backup and wait</h3>
              <p>
                Grab whatever&apos;s available so you have a round. We&apos;ll check your top picks
                around the clock while you wait.
              </p>
            </div>
          </div>
          <div className="flow-step">
            <span>04</span>
            <div>
              <h3>Switch to your first choice</h3>
              <p>
                When a spot opens up, you get an email with a direct booking link. Cancel
                the backup, click the link, and play where you actually wanted.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="community-section" aria-labelledby="community-heading">
        <div className="community-card">
          <div className="community-copy">
            <div>
              <div className="community-eyebrow">
                <span aria-hidden="true"><DiscordMark size={22} /></span>
                <p>Help shape Tee Time Spot</p>
              </div>
              <h2 id="community-heading">Built with golfers, not just for them.</h2>
              <p>
                Share feedback, suggest features, swap public-course tips, and help us make
                Tee Time Spot more useful.
              </p>
            </div>
            <div className="community-action">
              <a href={discordInviteUrl} rel="noreferrer" target="_blank">
                Join the Discord →
              </a>
              <span>Free to join</span>
            </div>
          </div>
          <div className="community-points">
            <p><span aria-hidden="true">💬</span>Tell us what&apos;s working — and what isn&apos;t</p>
            <p><span aria-hidden="true">💡</span>Suggest and discuss new features</p>
            <p><span aria-hidden="true">⛳</span>Share public-course tips with local golfers</p>
            <p><span aria-hidden="true">🔔</span>Hear about the latest Tee Time Spot updates</p>
          </div>
        </div>
      </section>
    </main>
  );
}
