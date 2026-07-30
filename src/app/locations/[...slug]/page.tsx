import type { Metadata } from "next";
import "../../knowledge.css";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Bell, CalendarClock, MapPin } from "lucide-react";

import { KnowledgePageTracker } from "@/components/knowledge-page-tracker";
import { StructuredData } from "@/components/structured-data";
import { getLocationHub, loadQualifiedLocationHub } from "@/lib/course-profiles/locations";
import { absoluteUrl, buildPageMetadata } from "@/lib/seo";

type PageProps = { params: Promise<{ slug: string[] }> };
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const hub = getLocationHub((await params).slug);
  if (!hub) return {};
  const data = await loadQualifiedLocationHub(hub);
  if (!data) return {};
  return buildPageMetadata({ title: `Public Golf Tee Time Alerts in ${hub.name}`, description: hub.description, path: hub.path });
}

export default async function LocationHubPage({ params }: PageProps) {
  const hub = getLocationHub((await params).slug);
  if (!hub) notFound();
  const data = await loadQualifiedLocationHub(hub);
  if (!data) notFound();
  const parentPath = hub.county ? "/locations/connecticut" : null;
  const verifiedBookingWindows = data.courses.filter(
    (course) => course.bookingWindowDaysAhead !== null
  );
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "CollectionPage", "@id": `${absoluteUrl(hub.path)}#webpage`, url: absoluteUrl(hub.path), name: `Public golf tee time alerts in ${hub.name}`, description: hub.description, dateModified: data.lastVerifiedAt?.toISOString(), mainEntity: { "@id": `${absoluteUrl(hub.path)}#courses` } },
      { "@type": "ItemList", "@id": `${absoluteUrl(hub.path)}#courses`, numberOfItems: data.courses.length, itemListElement: data.courses.map((course, index) => ({ "@type": "ListItem", position: index + 1, name: course.name, url: absoluteUrl(`/courses/${course.profile?.canonicalSlug}`) })) },
      { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: absoluteUrl("/") }, ...(parentPath ? [{ "@type": "ListItem", position: 2, name: "Connecticut", item: absoluteUrl(parentPath) }] : []), { "@type": "ListItem", position: parentPath ? 3 : 2, name: hub.shortName, item: absoluteUrl(hub.path) }] }
    ]
  };

  return (
    <main className="knowledge-page location-hub-page">
      <KnowledgePageTracker kind="location" slug={hub.slug} />
      <StructuredData data={structuredData} />
      <section className="knowledge-hero location-hero">
        <div className="knowledge-hero-inner">
          <nav aria-label="Breadcrumb" className="knowledge-breadcrumbs"><Link href="/">Home</Link><span>/</span>{parentPath ? <><Link href={parentPath}>Connecticut</Link><span>/</span></> : null}<span>{hub.shortName}</span></nav>
          <div className="knowledge-hero-copy">
            <p className="eyebrow">Free local golf tee time alerts</p>
            <h1>Golf tee time alerts in {hub.name}</h1>
            <p className="knowledge-lede">{hub.description}</p>
            <div className="knowledge-pills">
              <span className="is-supported">{data.courses.length} public courses covered</span>
              <span>
                {data.knownBookingWindowCount} booking{" "}
                {data.knownBookingWindowCount === 1 ? "window" : "windows"} verified
              </span>
            </div>
            <Link className="button button-primary" href="/search">
              <Bell aria-hidden="true" size={17} />
              Create a {hub.shortName} alert
            </Link>
          </div>
          <aside className="knowledge-verification">
            <MapPin aria-hidden="true" size={25} />
            <strong>{data.courses.length} public courses covered</strong>
            <span>Choose from courses Tee Time Spot can check for matching openings.</span>
            <span>Last reviewed {formatDate(data.lastVerifiedAt)}</span>
          </aside>
        </div>
      </section>

      <section className="location-course-section">
        <div className="location-section-heading">
          <div>
            <p className="knowledge-kicker">Courses you can choose</p>
            <h2>Public courses with tee time alerts</h2>
          </div>
          <p>
            Choose from the courses below. We can check their public booking pages and email the
            official link when a matching opening appears.
          </p>
        </div>
        <div className="location-course-list">
          {data.courses.map((course, index) => (
            <Link href={`/courses/${course.profile?.canonicalSlug}`} key={course.id}>
              <span className="location-course-number">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <small>
                  {course.city}, {course.stateCode}
                </small>
                <strong>{course.name}</strong>
                <p>{course.profile?.accessSummary}</p>
              </div>
              <span className="location-course-status">Alerts available</span>
              <ArrowRight aria-hidden="true" size={18} />
            </Link>
          ))}
        </div>
      </section>

      <section className="location-considerations">
        <div>
          <p className="knowledge-kicker">Local booking considerations</p>
          <h2>Plan around the official release rule</h2>
          <p>Coverage does not make every course operate the same way. Confirm the current public rule before an important booking day.</p>
        </div>
        <div className="location-consideration-list">
          {hub.considerations.map((consideration) => <p key={consideration}><CalendarClock aria-hidden="true" size={21} />{consideration}</p>)}
          {verifiedBookingWindows.length > 0 ? (
            <div className="location-verified-windows">
              <strong>Verified course rules</strong>
              <ul>
                {verifiedBookingWindows.map((course) => (
                  <li key={course.id}>
                    <Link href={`/courses/${course.profile?.canonicalSlug}`}>{course.name}</Link>
                    <span>{course.bookingWindowDaysAhead} days ahead{course.bookingReleaseTimeLocal ? ` at ${course.bookingReleaseTimeLocal} local time` : ""}</span>
                    <small>Checked {formatDate(course.bookingWindowCheckedAt)}</small>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <Link href="/guides/public-golf-booking-windows">Read the public golf booking-window guide <ArrowRight size={15} /></Link>
        </div>
      </section>

      <section className="knowledge-final-cta">
        <div>
          <p className="eyebrow">One alert, ranked courses</p>
          <h2>Get alerts for the courses you would actually play</h2>
          <p>
            Choose up to five public courses and a future time window. We will email the official
            booking link when a matching opening appears.
          </p>
        </div>
        <Link className="button button-primary" href="/search">
          Start an alert <ArrowRight size={16} />
        </Link>
      </section>
    </main>
  );
}

function formatDate(value: Date | null) {
  return value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(value) : "not yet verified";
}
