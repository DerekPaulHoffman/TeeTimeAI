import Link from "next/link";
import { ArrowRight } from "lucide-react";

import {
  EditorialCheck,
  EditorialChecklist,
  EditorialNote,
  EditorialPage,
  EditorialSection
} from "@/components/editorial-page";
import { buildPageMetadata, buildPageStructuredData } from "@/lib/seo";
import { isSimulatorModeEnabled } from "@/lib/simulators/config";

const title = "How to Book Indoor Golf Simulator Bays";
const description =
  "A practical guide to indoor golf bay prices, session lengths, group limits, booking windows, and cancellation rules—and how Tee Time Spot alerts work.";
const path = "/guides/booking-indoor-golf";

export const metadata = buildPageMetadata({ title, description, path, type: "article" });

const structuredData = buildPageStructuredData({
  name: title,
  description,
  path,
  type: "Article",
  datePublished: "2026-10-07",
  dateModified: "2026-10-07",
  breadcrumbs: [
    { name: "Home", path: "/" },
    { name: "Guides", path: "/guides" },
    { name: title, path }
  ]
});

export default function BookingIndoorGolfGuide() {
  const enabled = isSimulatorModeEnabled();

  return (
    <EditorialPage
      eyebrow="Indoor golf booking"
      title="How to book indoor golf simulator bays."
      intro="A simulator reservation is usually a bay and a block of time. Before you pay, check who the price covers, how long you have the bay, and which venue rules apply."
      summary="Compare the total bay cost, session length, and group rules on each venue's official booking page. Tee Time Spot can watch for a full one-hour opening at supported public rentals, then email a direct link so you can book with the venue."
      updated="October 7, 2026"
      breadcrumbs={[
        { href: "/", label: "Home" },
        { href: "/guides", label: "Guides" }
      ]}
      toc={[
        { id: "pricing", label: "Understand the price" },
        { id: "duration", label: "Choose a session length" },
        { id: "group", label: "Check group limits" },
        { id: "rules", label: "Read venue rules" },
        { id: "alerts", label: "Use an opening alert" },
        { id: "before-booking", label: "Check before booking" }
      ]}
      structuredData={structuredData}
    >
      <EditorialSection id="pricing" eyebrow="The price" title="Is the rate per bay or per person?">
        <p>
          Indoor golf pricing is venue-specific. A listed rate might cover an entire bay for one
          hour, charge each player separately, or apply only to a particular day or time. Some
          venues list extras such as club rental, food, or taxes separately. Read the price details
          on the official booking page before comparing two venues.
        </p>
        <EditorialNote label="Compare the full cost">
          <p>
            For a group, check the total price for your chosen time and the number of players who
            will attend. A low headline rate may describe one person or an off-peak hour.
          </p>
        </EditorialNote>
      </EditorialSection>

      <EditorialSection id="duration" eyebrow="The time" title="Book enough time for the session you want.">
        <p>
          Venues may offer different rental durations and start-time increments. Tee Time Spot
          currently looks for one continuous <strong>60-minute session in one bay</strong>. It
          will not combine two bays, treat a shorter gap as a match, or watch for longer sessions.
        </p>
        <p>
          If you want more or less than an hour, check the venue&apos;s own calendar. Leave time for
          check-in, setup, and the type of play your group plans; a one-hour rental is not a promise
          that a full virtual round will fit.
        </p>
      </EditorialSection>

      <EditorialSection id="group" eyebrow="The group" title="Check the venue's actual bay capacity.">
        <p>
          Tee Time Spot saves the usual 1-to-4 player choice as context for your plans. That choice
          does not verify how many people a simulator bay can hold and does not filter the calendar
          by capacity. Some venues distinguish players from guests or set different limits for a
          lesson, league, or private event. Confirm your group&apos;s fit with the venue before booking.
        </p>
      </EditorialSection>

      <EditorialSection id="rules" eyebrow="The fine print" title="Booking windows and cancellation terms vary.">
        <EditorialChecklist>
          <EditorialCheck>
            <strong>Booking window.</strong> Find out how far ahead the public can reserve, whether
            a membership changes access, and which local time the venue uses.
          </EditorialCheck>
          <EditorialCheck>
            <strong>Change or cancellation rule.</strong> Check the deadline, refund or credit
            policy, and what happens if your group arrives late.
          </EditorialCheck>
          <EditorialCheck>
            <strong>What is included.</strong> Check club rental, balls, simulator software, food
            minimums, and any age or supervision rules that matter to your group.
          </EditorialCheck>
          <EditorialCheck>
            <strong>Access.</strong> Make sure the rental is open to the public. A lesson, fitting,
            member-only bay, or private event is not the same as a public session.
          </EditorialCheck>
        </EditorialChecklist>
        <p>
          These details can change. Use the venue&apos;s current official site or contact the venue
          when the calendar or policy is unclear.
        </p>
      </EditorialSection>

      <EditorialSection id="alerts" eyebrow="A second look" title="Use an alert when a suitable hour is missing.">
        <p>
          Search for nearby indoor golf venues, rank up to five, and save your date and time window.
          Discovery works across the United States, but calendar monitoring depends on each
          venue&apos;s verified public rental offering and supported booking system. A venue may
          be selectable while support is pending; that status is not a report of no openings.
        </p>
        <p>
          At supported venues, Tee Time Spot checks for a complete one-hour bay session and emails
          the official booking link when a matching opening appears. Availability can change before
          you reach checkout. Tee Time Spot does not reserve, hold, or pay for a session.
        </p>
      </EditorialSection>

      <EditorialSection id="before-booking" eyebrow="Final check" title="Confirm the details on the official page.">
        <ol>
          <li>Open the venue&apos;s official site or its directly linked booking page.</li>
          <li>Confirm the address, local date, start and end time, and one-bay session length.</li>
          <li>Verify the total price, player or guest limit, and what the rental includes.</li>
          <li>Read cancellation, late-arrival, and payment terms before completing the booking.</li>
        </ol>
        {enabled ? (
          <section className="editorial-cta">
            <div>
              <p className="eyebrow">Indoor golf alerts</p>
              <h2>Watch for a full hour at a venue you like.</h2>
              <p>Choose your venues and time window. When monitoring is supported, we can email the official link for a matching opening.</p>
            </div>
            <Link
              className="button button-primary"
              data-analytics-event="start_search_clicked"
              data-analytics-mode="SIMULATOR"
              href="/search?mode=SIMULATOR"
            >
              Find simulator venues <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </section>
        ) : (
          <EditorialNote label="Simulator alerts are temporarily unavailable">
            <p>
              You can still use this guide to compare venues and check their official booking
              pages. Simulator search and alerts will return when the feature is available.
            </p>
          </EditorialNote>
        )}
      </EditorialSection>
    </EditorialPage>
  );
}
