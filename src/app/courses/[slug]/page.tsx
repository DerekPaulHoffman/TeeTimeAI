import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { ArrowRight, Bell, CalendarClock, CheckCircle2, ExternalLink, MapPin, ShieldCheck } from "lucide-react";

import { CourseProfileActions } from "@/components/course-profile-actions";
import { KnowledgePageTracker } from "@/components/knowledge-page-tracker";
import { StructuredData } from "@/components/structured-data";
import { getPublishedCourseProfile, getRelatedSupportedCourses } from "@/lib/course-profiles/service";
import { absoluteUrl, buildPageMetadata } from "@/lib/seo";

type PageProps = { params: Promise<{ slug: string }> };

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const result = await getPublishedCourseProfile(slug);
  if (!result) return {};
  const { course, overview } = result.profile;
  const place = [course.city, course.stateCode].filter(Boolean).join(", ");
  return buildPageMetadata({
    title: `${course.name} Tee Time Alerts${place ? ` in ${place}` : ""}`,
    description: overview?.slice(0, 155) ?? `Public-access and tee-time alert details for ${course.name}.`,
    path: `/courses/${result.profile.canonicalSlug}`
  });
}

export default async function CourseProfilePage({ params }: PageProps) {
  const { slug } = await params;
  const result = await getPublishedCourseProfile(slug);
  if (!result) notFound();
  if (result.redirectSlug) permanentRedirect(`/courses/${result.redirectSlug}`);

  const { profile } = result;
  const { course } = profile;
  const related = await getRelatedSupportedCourses(course);
  const supported = course.automationEligibility === "ALLOWED";
  const path = `/courses/${profile.canonicalSlug}`;
  const location = [course.city, course.stateCode].filter(Boolean).join(", ");
  const hasConnecticutHub = course.stateCode === "CT";
  const verifiedLabel = formatDate(profile.profileVerifiedAt);
  const bookingWindow = getBookingWindowCopy(course);
  const courseType = formatCourseType(profile.courseType);
  const selectedCourse = {
    courseId: course.id,
    googlePlaceId: course.googlePlaceId ?? course.id,
    name: course.name,
    address: course.address ?? undefined,
    city: course.city ?? undefined,
    stateCode: course.stateCode ?? undefined,
    stateName: course.stateName ?? undefined,
    county: course.county ?? undefined,
    countryCode: course.countryCode ?? undefined,
    latitude: course.latitude,
    longitude: course.longitude,
    timeZone: course.timeZone,
    website: course.website ?? undefined,
    profileUrl: path
  };

  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "GolfCourse",
        "@id": `${absoluteUrl(path)}#course`,
        name: course.name,
        description: profile.overview,
        url: absoluteUrl(path),
        publicAccess: course.isPublic,
        address: {
          "@type": "PostalAddress",
          streetAddress: course.address,
          addressLocality: course.city,
          addressRegion: course.stateCode,
          addressCountry: course.countryCode
        },
        geo: { "@type": "GeoCoordinates", latitude: course.latitude, longitude: course.longitude },
        telephone: course.phone,
        sameAs: [course.website, course.detectedBookingUrl].filter(Boolean)
      },
      {
        "@type": "WebPage",
        "@id": `${absoluteUrl(path)}#webpage`,
        url: absoluteUrl(path),
        name: `${course.name} tee time alerts`,
        description: profile.overview,
        datePublished: profile.publishedAt?.toISOString(),
        dateModified: profile.updatedAt.toISOString(),
        mainEntity: { "@id": `${absoluteUrl(path)}#course` },
        breadcrumb: { "@id": `${absoluteUrl(path)}#breadcrumbs` }
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${absoluteUrl(path)}#breadcrumbs`,
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: absoluteUrl("/") },
          ...(hasConnecticutHub ? [{ "@type": "ListItem", position: 2, name: "Connecticut courses", item: absoluteUrl("/locations/connecticut") }] : []),
          { "@type": "ListItem", position: hasConnecticutHub ? 3 : 2, name: course.name, item: absoluteUrl(path) }
        ]
      }
    ]
  };

  return (
    <main className="knowledge-page">
      <KnowledgePageTracker kind="course" slug={profile.canonicalSlug} />
      <StructuredData data={structuredData} />
      <section className="knowledge-hero">
        <div className="knowledge-hero-inner">
          <nav aria-label="Breadcrumb" className="knowledge-breadcrumbs">
            <Link href="/">Home</Link><span>/</span>{hasConnecticutHub ? <><Link href="/locations/connecticut">Connecticut</Link><span>/</span></> : null}<span>{course.name}</span>
          </nav>
          <div className="knowledge-hero-copy">
            <p className="eyebrow">Public golf course profile</p>
            <h1>{course.name}</h1>
            <p className="knowledge-location"><MapPin aria-hidden="true" size={17} />{location}</p>
            <p className="knowledge-lede">{profile.accessSummary}</p>
            <div className="knowledge-pills">
              <span>{courseType}</span>
              <span>{course.isPublic ? "Public access" : "Access restricted"}</span>
              <span className={supported ? "is-supported" : "is-limited"}>{supported ? "Alerts supported" : "Alerts not currently supported"}</span>
            </div>
            <CourseProfileActions slug={profile.canonicalSlug} supported={supported} selectedCourse={selectedCourse} website={course.website} bookingUrl={course.detectedBookingUrl} />
          </div>
          <aside className="knowledge-verification" aria-label="Profile verification">
            <ShieldCheck aria-hidden="true" size={25} />
            <strong>Source-backed profile</strong>
            <span>Last verified {verifiedLabel}</span>
            <span>{profile.sources.length} supporting {profile.sources.length === 1 ? "source" : "sources"}</span>
          </aside>
        </div>
      </section>

      <div className="knowledge-layout">
        <article className="knowledge-article">
          <section>
            <p className="knowledge-kicker">About the course</p>
            <h2>What Tee Time Spot understands about {course.name}</h2>
            <p>{profile.overview}</p>
            <p>{profile.courseCharacter}</p>
            {profile.notableFacts.length > 0 ? <ul className="knowledge-facts">{profile.notableFacts.map((fact) => <li key={fact}><CheckCircle2 aria-hidden="true" size={18} />{fact}</li>)}</ul> : null}
            <SourceRefs sources={profile.sources} claims={["access", "overview", "course_character", "course_type", ...profile.notableFacts.map((_, index) => `notable_fact_${index}`)]} />
          </section>

          <section>
            <p className="knowledge-kicker">Booking window</p>
            <h2>When tee times are released</h2>
            <div className="knowledge-callout"><CalendarClock aria-hidden="true" size={24} /><div><strong>{bookingWindow.title}</strong><p>{bookingWindow.copy}</p>{bookingWindow.sourceUrl ? <a href={bookingWindow.sourceUrl} rel="noreferrer" target="_blank">View the official evidence <ExternalLink aria-hidden="true" size={14} /></a> : null}</div></div>
            <p className="knowledge-date">Booking information last checked {formatDate(course.bookingWindowCheckedAt ?? course.bookingWindowObservedAt)}.</p>
          </section>

          <section>
            <p className="knowledge-kicker">Alert coverage</p>
            <h2>{supported ? "What Tee Time Spot checks here" : "Why alerts are limited here"}</h2>
            <p>{supported ? "Tee Time Spot can check the course’s policy-safe public booking surface for openings that match a saved date, time window, player count, and verified course-layout preference." : getUnsupportedCopy(course.automationReason)}</p>
            <p className="knowledge-date">Alert support last checked {formatDate(course.intelligenceVerifiedAt ?? profile.profileVerifiedAt)}.</p>
            <div className="knowledge-boundary">
              <Bell aria-hidden="true" size={22} />
              <div><strong>We find the opening. You book directly.</strong><p>Tee Time Spot never reserves, pays, enters checkout, uses verification codes, bypasses captchas or queues, or guarantees that a tee time will still be available.</p></div>
            </div>
          </section>

          <section>
            <p className="knowledge-kicker">Sources</p>
            <h2>Where these course facts come from</h2>
            <ol className="knowledge-sources">{profile.sources.map((source) => <li key={source.id}><a href={source.url} rel="noreferrer" target="_blank">{source.title}<ExternalLink aria-hidden="true" size={13} /></a><span>{source.publisher} · accessed {formatDate(source.accessedAt)}</span><p>{source.evidenceSummary}</p></li>)}</ol>
          </section>
        </article>

        <aside className="knowledge-aside">
          <strong>Course facts</strong>
          <dl><div><dt>Location</dt><dd>{location}</dd></div><div><dt>Access</dt><dd>{course.isPublic ? "Public" : "Restricted"}</dd></div><div><dt>Course type</dt><dd>{courseType}</dd></div><div><dt>Alerts</dt><dd>{supported ? "Supported" : "Not currently supported"}</dd></div><div><dt>Profile verified</dt><dd>{verifiedLabel}</dd></div></dl>
          {course.website ? <a href={course.website} rel="noreferrer" target="_blank">Official website <ArrowRight aria-hidden="true" size={14} /></a> : null}
        </aside>
      </div>

      {related.length > 0 ? <section className="knowledge-related"><div><p className="knowledge-kicker">Nearby coverage</p><h2>Other supported public courses nearby</h2></div><div className="knowledge-related-list">{related.map((item) => <Link href={`/courses/${item.profile?.canonicalSlug}`} key={item.id}><span>{item.city}, {item.stateCode}</span><strong>{item.name}</strong><small>{Math.round(item.distanceMiles)} miles away</small><ArrowRight aria-hidden="true" size={17} /></Link>)}</div></section> : null}

      <section className="knowledge-final-cta"><div><p className="eyebrow">Ready when an opening appears</p><h2>{supported ? `Watch ${course.name}` : "Build an alert around supported nearby courses"}</h2><p>Choose the courses and time window you can actually play. Tee Time Spot will email the official link when a matching opening appears.</p></div>{supported ? <CourseProfileActions slug={profile.canonicalSlug} supported selectedCourse={selectedCourse} website={null} bookingUrl={null} /> : <Link className="button button-primary" href="/search">Browse supported courses <ArrowRight size={16} /></Link>}</section>
    </main>
  );
}

function SourceRefs({ sources, claims }: { sources: Array<{ id: string; url: string; publisher: string; claimKeys: string[] }>; claims: string[] }) {
  const matching = sources.filter((source) => source.claimKeys.some((claim) => claims.includes(claim)));
  return matching.length > 0 ? <p className="knowledge-source-refs">Sources: {matching.map((source, index) => <span key={source.id}>{index > 0 ? ", " : ""}<a href={source.url} rel="noreferrer" target="_blank">{source.publisher}</a></span>)}</p> : null;
}

function getBookingWindowCopy(course: { bookingWindowDaysAhead: number | null; bookingReleaseTimeLocal: string | null; bookingWindowEvidenceUrl: string | null }) {
  if (course.bookingWindowDaysAhead === null) return { title: "Release rule not yet verified", copy: "Tee Time Spot has not found enough official evidence to state a dependable booking window for this course. Check the official site before planning around a release time.", sourceUrl: null };
  const time = course.bookingReleaseTimeLocal ? ` at ${course.bookingReleaseTimeLocal} course-local time` : "";
  return { title: `${course.bookingWindowDaysAhead}-day booking window`, copy: `The currently verified rule indicates that public inventory can open ${course.bookingWindowDaysAhead} days ahead${time}. Rules can change, and the official booking page remains authoritative.`, sourceUrl: course.bookingWindowEvidenceUrl };
}

function getUnsupportedCopy(reason: string) {
  const copy: Record<string, string> = {
    NO_ONLINE_BOOKING: "The course does not currently expose a supported public online tee-time surface.",
    ACCOUNT_REQUIRED: "The available booking flow requires an account-specific session, which Tee Time Spot does not use.",
    AUTOMATION_PROHIBITED: "The course or provider does not permit the kind of automated public checking Tee Time Spot uses.",
    CAPTCHA_OR_QUEUE: "The booking flow uses an access control, captcha, or queue that Tee Time Spot will not bypass."
  };
  return copy[reason] ?? "Tee Time Spot has not verified a policy-safe public availability source for automatic alerts at this course.";
}

function formatCourseType(value: string | null) {
  return value ? value.toLowerCase().split("_").map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`).join(" ") : "Public golf course";
}

function formatDate(value: Date | null) {
  return value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(value) : "not yet verified";
}
