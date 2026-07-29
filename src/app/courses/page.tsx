import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Bell } from "lucide-react";

import "../knowledge.css";
import { StructuredData } from "@/components/structured-data";
import { listPublishedCourseAlertProfiles } from "@/lib/course-profiles/service";
import { absoluteUrl, buildPageMetadata } from "@/lib/seo";

const title = "Public Golf Course Tee Time Alerts";
const description =
  "Browse public golf courses with free tee time alerts. Choose a course, date, time window, and group size, then book directly on the official course site.";
const path = "/courses";

export const metadata: Metadata = buildPageMetadata({ title, description, path });
export const dynamic = "force-dynamic";

export default async function CourseAlertsPage() {
  const profiles = await listPublishedCourseAlertProfiles();
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        "@id": `${absoluteUrl(path)}#webpage`,
        url: absoluteUrl(path),
        name: title,
        description,
        mainEntity: { "@id": `${absoluteUrl(path)}#course-list` }
      },
      {
        "@type": "ItemList",
        "@id": `${absoluteUrl(path)}#course-list`,
        numberOfItems: profiles.length,
        itemListElement: profiles.map((profile, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: `${profile.course.name} tee time alerts`,
          url: absoluteUrl(`/courses/${profile.canonicalSlug}`)
        }))
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${absoluteUrl(path)}#breadcrumbs`,
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: absoluteUrl("/") },
          { "@type": "ListItem", position: 2, name: "Course tee time alerts", item: absoluteUrl(path) }
        ]
      }
    ]
  };

  return (
    <main className="knowledge-page">
      <StructuredData data={structuredData} />
      <section className="knowledge-hero course-alerts-hero">
        <div className="knowledge-hero-inner">
          <nav aria-label="Breadcrumb" className="knowledge-breadcrumbs">
            <Link href="/">Home</Link><span>/</span><span>Course alerts</span>
          </nav>
          <div className="knowledge-hero-copy">
            <p className="eyebrow">Free email alerts</p>
            <h1>Public golf course tee time alerts</h1>
            <p className="knowledge-lede">
              Pick the public courses you want to play, choose your date and time window, and
              get an email when a matching opening appears. You always book on the official
              course site.
            </p>
            <Link className="button button-primary knowledge-inline-action" href="/search">
              Create a tee time alert <ArrowRight aria-hidden="true" size={16} />
            </Link>
          </div>
        </div>
      </section>

      <section className="location-course-section">
        <div className="location-section-heading">
          <div>
            <p className="knowledge-kicker">Courses we can watch</p>
            <h2>Find tee time alerts by course</h2>
          </div>
          <p>
            Each page explains the course, known booking window, official booking link, and
            current alert coverage. Availability stays first come, first served.
          </p>
        </div>
        <div className="location-course-list">
          {profiles.map((profile, index) => (
            <Link href={`/courses/${profile.canonicalSlug}`} key={profile.canonicalSlug}>
              <span className="location-course-number">{String(index + 1).padStart(2, "0")}</span>
              <span>
                <small>{[profile.course.city, profile.course.stateCode].filter(Boolean).join(", ")}</small>
                <strong>{profile.course.name} tee time alerts</strong>
                <p>{profile.accessSummary}</p>
              </span>
              <span className="location-course-status"><Bell aria-hidden="true" size={13} /> Alerts available</span>
              <ArrowRight aria-hidden="true" size={18} />
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
