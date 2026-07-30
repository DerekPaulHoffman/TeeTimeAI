import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { StructuredData } from "@/components/structured-data";
import { buildPageMetadata, buildPageStructuredData } from "@/lib/seo";

const title = "Golf Tee Time Alerts and Booking Guides";
const description =
  "Practical guides to golf tee time alerts, last-minute tee times, cancellation alerts, public booking windows, and direct booking.";
const path = "/guides";

export const metadata = buildPageMetadata({ title, description, path });

const structuredData = buildPageStructuredData({
  name: title,
  description,
  path,
  type: "CollectionPage",
  dateModified: "2026-07-13"
});

const guides = [
  {
    href: "/guides/tee-time-cancellation-alerts",
    title: "How golf tee time cancellation alerts work",
    description:
      "Why public golf openings reappear, what an alert can observe, and how to act without assuming the slot is guaranteed."
  },
  {
    href: "/guides/public-golf-booking-windows",
    title: "A golfer's guide to public booking windows",
    description:
      "How advance windows vary, why release times matter, and how to build a better first-booking and backup plan."
  },
  {
    href: "/guides/tee-time-alerts-vs-auto-booking",
    title: "Tee-time alerts vs. auto-booking",
    description:
      "A clear comparison of notification tools and services that attempt to reserve or purchase a tee time for the golfer."
  }
] as const;

export default function GuidesPage() {
  return (
    <main className="guide-index">
      <StructuredData data={structuredData} />
      <header className="guide-index-header">
        <p className="eyebrow">The public golf field guide</p>
        <h1>Golf tee time alerts and booking guides.</h1>
        <p>
          Clear answers about public tee time releases, last-minute openings, cancellation alerts,
          and booking tools.
          Every guide preserves the same boundary: the course controls inventory and the golfer
          completes the booking.
        </p>
      </header>
      <section aria-label="Tee time guides" className="guide-list">
        {guides.map((guide, index) => (
          <Link className="guide-list-item" href={guide.href} key={guide.href}>
            <span className="guide-list-number">0{index + 1}</span>
            <span>
              <h2>{guide.title}</h2>
              <p>{guide.description}</p>
            </span>
            <ArrowRight aria-hidden="true" size={20} />
          </Link>
        ))}
      </section>
      <aside className="guide-index-principle">
        <strong>Tee Time Spot is alert-only.</strong>
        <p>
          We can help you notice a matching public opening. We do not hold inventory, enter
          checkout, or book for you. Always confirm the live details and policies on the official
          course booking page.
        </p>
      </aside>
    </main>
  );
}
