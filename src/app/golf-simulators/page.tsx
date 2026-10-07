import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Clock3, ExternalLink, Mail, MapPin } from "lucide-react";

import { StructuredData } from "@/components/structured-data";
import { buildPageMetadata, buildPageStructuredData } from "@/lib/seo";
import { isSimulatorModeEnabled } from "@/lib/simulators/config";

import "./simulators.css";

const title = "Find Indoor Golf Simulators Near You";
const description =
  "Discover nearby indoor golf simulator venues, rank your favorites, and get email alerts for supported one-hour sessions. Book directly with the venue.";
const path = "/golf-simulators";

export const metadata = buildPageMetadata({ title, description, path });

const structuredData = buildPageStructuredData({
  name: title,
  description,
  path,
  type: "WebPage",
  breadcrumbs: [
    { name: "Home", path: "/" },
    { name: "Indoor golf simulators", path }
  ]
});

const searchHref = "/search?mode=SIMULATOR";

export default function GolfSimulatorsPage() {
  const enabled = isSimulatorModeEnabled();

  return (
    <main className="simulators-page">
      <StructuredData data={structuredData} />
      <section className="simulators-hero" aria-labelledby="simulators-title">
        <Image
          alt="Illustrative indoor golf simulator bay with a golfer practicing"
          className="simulators-hero-image"
          src="/images/indoor-golf-simulator-hero.webp"
          fill
          priority
          sizes="100vw"
        />
        <div className="simulators-hero-shade" aria-hidden="true" />
        <div className="simulators-hero-content">
          <p className="simulators-brand">Tee Time Spot</p>
          <p className="simulators-kicker">Indoor golf, on your time</p>
          <h1 id="simulators-title">Find indoor golf simulators near you.</h1>
          <p className="simulators-hero-copy">
            Discover local bays, choose the venues you like, and watch for a full one-hour session
            that fits your plans. You book direct on the official site.
          </p>
          {enabled ? (
            <Link
              className="button button-primary simulators-primary-cta"
              data-analytics-event="start_search_clicked"
              data-analytics-mode="SIMULATOR"
              href={searchHref}
            >
              Find simulator venues <ArrowRight size={17} aria-hidden="true" />
            </Link>
          ) : (
            <p className="simulators-unavailable" role="status">
              Simulator search and alerts are temporarily unavailable. You can still use this page
              to plan your next indoor session.
            </p>
          )}
        </div>
        <p className="simulators-image-caption">Illustrative image; venue availability varies.</p>
      </section>

      <section className="simulators-intro" aria-labelledby="simulators-intro-title">
        <p className="eyebrow">The useful part</p>
        <h2 id="simulators-intro-title">One place to start. The venue handles the booking.</h2>
        <p>
          Browse likely indoor golf venues across the United States. Where public rental and calendar
          access are verified, Tee Time Spot can check for a complete 60-minute bay session and email
          the official booking link when one fits your saved date and time window.
        </p>
      </section>

      <section className="simulators-steps" aria-label="How indoor golf alerts work">
        <div className="simulators-step">
          <span className="simulators-step-number">01</span>
          <MapPin size={26} strokeWidth={1.5} aria-hidden="true" />
          <h2>Find your venues</h2>
          <p>Search a location and rank up to five nearby simulator venues you would visit.</p>
        </div>
        <div className="simulators-step">
          <span className="simulators-step-number">02</span>
          <Clock3 size={26} strokeWidth={1.5} aria-hidden="true" />
          <h2>Save your window</h2>
          <p>Choose a future date and time range. Each simulator alert looks for one full hour in one bay.</p>
        </div>
        <div className="simulators-step">
          <span className="simulators-step-number">03</span>
          <Mail size={26} strokeWidth={1.5} aria-hidden="true" />
          <h2>Book with the venue</h2>
          <p>At supported venues, a matching opening can trigger an email. Follow the official link and book direct.</p>
        </div>
      </section>

      <section className="simulators-coverage" aria-labelledby="simulators-coverage-title">
        <div>
          <p className="eyebrow">Clear expectations</p>
          <h2 id="simulators-coverage-title">Discovery reaches farther than alert coverage.</h2>
        </div>
        <div className="simulators-coverage-copy">
          <p>
            A venue may appear in search before we have verified its public rentals or can check
            its booking calendar. You can save that venue in your alert; we will tell you when
            support is still pending and will only send opening alerts after its public rental and
            availability checks are ready.
          </p>
          <p>
            Prices, session lengths, group limits, and booking rules vary by venue. Availability is
            first come, first served. Confirm the details on the official booking page before paying.
          </p>
          <Link className="simulators-text-link" href="/guides/booking-indoor-golf">
            Read the indoor golf booking guide <ExternalLink size={16} aria-hidden="true" />
          </Link>
        </div>
      </section>

      <section className="simulators-faq" aria-labelledby="simulators-faq-title">
        <div className="simulators-faq-inner">
          <p className="eyebrow">Good to know</p>
          <h2 id="simulators-faq-title">Before you head to the bay.</h2>
          <div className="simulators-faq-list">
            <div>
              <h3>Can I book the simulator here?</h3>
              <p>No. Tee Time Spot sends an alert with the official booking link. You choose and pay for the session directly with the venue.</p>
            </div>
            <div>
              <h3>What length of session does an alert watch for?</h3>
              <p>One continuous 60-minute session in one bay. Check the venue&apos;s calendar if you need a different duration.</p>
            </div>
            <div>
              <h3>Does selecting four players confirm the bay fits four?</h3>
              <p>No. The player count saves your plans but does not verify or filter for a venue&apos;s capacity. Confirm the limit with the venue.</p>
            </div>
            <div>
              <h3>Why can I save a venue that is not sending openings yet?</h3>
              <p>You can save your preferred venues while public rental and calendar support are checked. We will explain when support is pending; a pending venue is not a report that its bays are full.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="simulators-final" aria-labelledby="simulators-final-title">
        <p className="eyebrow">Ready for a bay?</p>
        <h2 id="simulators-final-title">Spend less time checking calendars.</h2>
        {enabled ? (
          <Link
            className="button button-primary"
            data-analytics-event="start_search_clicked"
            data-analytics-mode="SIMULATOR"
            href={searchHref}
          >
            Find simulator venues <ArrowRight size={17} aria-hidden="true" />
          </Link>
        ) : (
          <p>Simulator search and alerts are temporarily unavailable. Check back later.</p>
        )}
      </section>
    </main>
  );
}
