import type { Metadata } from "next";
import { ArrowRight, Bell, MapPin, Search } from "lucide-react";

import { HomeSearchForm } from "@/components/home-search-form";
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
          <p className="eyebrow">Never miss an open tee time</p>
          <h1>Tee Time Spot</h1>
          <p className="hero-copy">
            Pick the courses you want, tell us when you&apos;re free, and we&apos;ll email you
            the moment a spot opens up with a direct link to book it right then and there.
            No payment, no account, no friction.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" data-analytics-event="start_search_clicked" href="/search">
              <Search size={18} />
              Start a search
            </a>
            <a className="button button-secondary" data-analytics-event="dashboard_opened" href="/dashboard">
              View dashboard
              <ArrowRight size={18} />
            </a>
            <a className="button button-secondary" data-analytics-event="email_preview_opened" href="/email-preview">
              Preview email
            </a>
          </div>
        </div>
        <div className="hero-strip" aria-label="How Tee Time Spot works">
          <div className="hero-strip-item">
            <strong>Pick your courses</strong>
            <span>Choose up to 5 courses near you and rank your favorites.</span>
          </div>
          <div className="hero-strip-item">
            <strong>We keep watch</strong>
            <span>Sit back while Tee Time Spot checks for open slots.</span>
          </div>
          <div className="hero-strip-item">
            <strong>One tap to book</strong>
            <span>Your alert has a direct link to the official course page.</span>
          </div>
        </div>
      </section>

      <section className="section section-tight" id="start">
        <nav className="quick-jump-nav" aria-label="Page sections">
          <a href="#">Home</a>
          <a href="/search">Search</a>
          <a data-analytics-event="dashboard_opened" href="/dashboard">Dashboard</a>
          <a data-analytics-event="email_preview_opened" href="/email-preview">Email</a>
        </nav>
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
        <HomeSearchForm />
      </section>

      <section className="section flow-band">
        <div className="section-heading">
          <p className="eyebrow" style={{ color: "var(--fairway-dark)" }}>
            How it works
          </p>
          <h2>Stop refreshing the course website. Let us do it.</h2>
        </div>
        <div className="flow-grid">
          <div className="flow-step">
            <MapPin size={22} />
            <h3>Tell us your favorites</h3>
            <p>Find nearby public courses and rank the ones you would actually play.</p>
          </div>
          <div className="flow-step">
            <Bell size={22} />
            <h3>We watch quietly</h3>
            <p>Your course priority, date, time window, and player count guide every alert.</p>
          </div>
          <div className="flow-step">
            <ArrowRight size={22} />
            <h3>You grab the spot</h3>
            <p>Every alert sends you straight to the course tee sheet. You finish there.</p>
          </div>
        </div>
      </section>
    </main>
  );
}
