import type { Metadata } from "next";
import "./editorial.css";
import Link from "next/link";
import { ArrowRight, Bell, Check, Search } from "lucide-react";

import { DiscordMark } from "@/components/discord-mark";
import { StructuredData } from "@/components/structured-data";
import { discordInviteUrl } from "@/lib/community";
import { absoluteUrl, siteDefinition, siteDescription, siteName } from "@/lib/seo";

export const metadata: Metadata = {
  title: {
    absolute: "Tee Time Spot | Free Public Golf Tee Time Alerts"
  },
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
      url: absoluteUrl("/"),
      description: siteDescription,
      logo: absoluteUrl("/icon.svg"),
      sameAs: [discordInviteUrl],
      knowsAbout: [
        "public golf courses",
        "golf tee time alerts",
        "public golf booking windows",
        "tee time cancellations"
      ]
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
      "@type": "WebPage",
      "@id": `${absoluteUrl("/")}#webpage`,
      name: "Tee Time Spot | Free Public Golf Tee Time Alerts",
      url: absoluteUrl("/"),
      description: siteDescription,
      isPartOf: {
        "@id": `${absoluteUrl("/")}#website`
      },
      about: {
        "@id": `${absoluteUrl("/")}#app`
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
      featureList: [
        "Rank one to five preferred public golf courses",
        "Choose a future date, time window, and group size",
        "Receive email alerts when matching tee times open",
        "Open the official course booking link and book directly"
      ],
      audience: {
        "@type": "Audience",
        audienceType: "Public golf course players"
      },
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
      <StructuredData data={homeStructuredData} />
      <section className="hero">
        <div className="hero-content">
          <p className="eyebrow">Free public golf tee time alerts</p>
          <h1>
            Golf tee time alerts for the courses you want to play.
          </h1>
          <p className="hero-copy">
            Choose up to five public golf courses and a time window. When a cancellation or new
            tee time matches, Tee Time Spot emails the official booking link. You review the
            details and book directly with the course.
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
          <Link
            className="hero-strip-item"
            data-analytics-event="start_search_clicked"
            href="/search"
          >
            <strong>Tell us your courses</strong>
            <span>Pick the public courses you want to play and rank them by priority.</span>
            <ArrowRight aria-hidden="true" className="hero-strip-arrow" size={18} />
          </Link>
          <Link
            className="hero-strip-item"
            data-analytics-event="start_search_clicked"
            href="/search"
          >
            <strong>Book what you can now</strong>
            <span>See what&apos;s currently available and grab a tee time to hold your day.</span>
            <ArrowRight aria-hidden="true" className="hero-strip-arrow" size={18} />
          </Link>
          <Link
            className="hero-strip-item"
            data-analytics-event="start_search_clicked"
            href="/search"
          >
            <strong>We&apos;ll alert you when a priority opens</strong>
            <span>
              If your top picks are full, we check their public booking pages and email you when a
              matching spot opens.
            </span>
            <ArrowRight aria-hidden="true" className="hero-strip-arrow" size={18} />
          </Link>
        </div>
      </section>

      <section className="scenario-section" aria-labelledby="scenario-heading">
        <div className="scenario-inner">
          <p className="eyebrow" id="scenario-heading">An example alert journey</p>
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
              <p className="scenario-label">A matching public opening appeared</p>
              <h2>New tee time at Ridgecrest Links — your #2 pick just opened up</h2>
              <p>Sat 2:10 PM · 3 players · Official booking link below</p>
              <span className="scenario-book-link">Open official booking page →</span>
            </article>

            <article className="scenario-card scenario-result">
              <p className="scenario-label">The golfer stayed in control</p>
              <div className="scenario-result-step">
                <span aria-hidden="true"><Check size={12} /></span>
                <p>Reviewed the live time, price, holes, and course policy</p>
              </div>
              <div className="scenario-result-step">
                <span aria-hidden="true"><Check size={12} /></span>
                <p>Opened the official link and completed the booking directly</p>
              </div>
              <div className="scenario-result-step">
                <span aria-hidden="true"><Check size={12} /></span>
                <p>Managed any existing plans under the other course&apos;s rules</p>
              </div>
              <div className="scenario-finish">
                <span aria-hidden="true">⛳</span>
                <p>We found the opening. The golfer made every booking decision.</p>
              </div>
            </article>
          </div>
        </div>
      </section>

      <section className="section section-tight" id="start">
        <div className="home-search-cta">
          <div className="section-heading">
            <p className="eyebrow" style={{ color: "var(--fairway-dark)" }}>
              Public golf tee time alerts
            </p>
            <h2>Find public golf tee times near you.</h2>
            <p className="home-search-cta-copy">
              Choose your preferred courses, date, time, and group size. Tee Time Spot checks
              public booking pages and emails you a direct link to the official booking page.
            </p>
          </div>
          <Link className="button button-primary home-search-cta-button" href="/search">
            <Search size={16} />
            Find a tee time
          </Link>
        </div>
      </section>

      <section className="section flow-band how-it-works-section">
        <div className="section-heading">
          <p className="eyebrow" style={{ color: "var(--fairway-dark)" }}>
            How it works
          </p>
          <h2>Four steps from course preference to official booking page.</h2>
        </div>
        <div className="how-steps-grid">
          <div className="flow-step">
            <span>01</span>
            <div>
              <h3>Rank your top 5 courses</h3>
              <p>
                Search nearby likely-public courses. Choose one to five and order them by genuine
                preference.
              </p>
            </div>
          </div>
          <div className="flow-step">
            <span>02</span>
            <div>
              <h3>Tell us your window</h3>
              <p>Choose a future date, your available time range, and one to four players.</p>
            </div>
          </div>
          <div className="flow-step">
            <span>03</span>
            <div>
              <h3>We check public booking pages</h3>
              <p>
                Available public booking pages are checked on your alert&apos;s schedule. We never
                bypass accounts, captchas, queues, or other access controls.
              </p>
            </div>
          </div>
          <div className="flow-step">
            <span>04</span>
            <div>
              <h3>You review and book direct</h3>
              <p>
                A match email opens the official booking surface. Confirm that the time is still
                available and complete the booking yourself.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="home-trust-section" aria-labelledby="home-trust-heading">
        <div className="home-trust-inner">
          <div className="home-trust-heading">
            <div>
              <p className="eyebrow" style={{ color: "var(--fairway-dark)" }}>
                Clear by design
              </p>
              <h2 id="home-trust-heading">Know what is watched, what is sent, and who books.</h2>
            </div>
            <p>{siteDefinition}</p>
          </div>
          <div className="home-trust-links">
            <Link href="/how-it-works">
              <strong>How Tee Time Spot works</strong>
              <span>Follow the path from ranked courses to the official booking page.</span>
              <ArrowRight aria-hidden="true" size={18} />
            </Link>
            <Link href="/methodology">
              <strong>Monitoring methodology</strong>
              <span>See how we identify public courses, check availability, and handle access limits.</span>
              <ArrowRight aria-hidden="true" size={18} />
            </Link>
            <Link href="/locations/connecticut">
              <strong>Connecticut golf tee time alerts</strong>
              <span>Browse public courses where Tee Time Spot can check for matching openings.</span>
              <ArrowRight aria-hidden="true" size={18} />
            </Link>
            <Link href="/guides">
              <strong>Public golf guides</strong>
              <span>Learn about booking windows, cancellation alerts, and last-minute tee times.</span>
              <ArrowRight aria-hidden="true" size={18} />
            </Link>
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
