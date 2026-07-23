import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { ArrowRight, Bell, CalendarClock, CheckCircle2, ExternalLink, MapPin } from "lucide-react";

import { CourseProfileActions } from "@/components/course-profile-actions";
import { KnowledgePageTracker } from "@/components/knowledge-page-tracker";
import { StructuredData } from "@/components/structured-data";
import { getBookingWindowPresentation, getPublicFacilityFacts, getUnsupportedAlertCopy } from "@/lib/course-profiles/presentation";
import { getPublishedCourseProfile, getRelatedSupportedCourses } from "@/lib/course-profiles/service";
import { absoluteUrl, buildPageMetadata } from "@/lib/seo";
import {
  buildCoursePriceEstimate,
  buildObservedBookableHoleSummary,
  getHeadlineBookableHoleCount,
  getHeadlineCoursePrice,
  type CoursePriceRange
} from "@/lib/pricing/course-prices";

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
  const bookingWindow = getBookingWindowPresentation(course);
  const courseType = formatCourseType(profile.courseType);
  const publicNotableFacts = getPublicFacilityFacts(profile.notableFacts);
  const bookingEvidence = {
    bookingFacts: course.bookingFacts,
    probes: [],
    matches: []
  };
  const priceEstimate = buildCoursePriceEstimate(bookingEvidence);
  const observedHoles = buildObservedBookableHoleSummary(bookingEvidence);
  const physicalHoleCount = getHeadlineBookableHoleCount(course.layoutHoleCounts);
  const bookableHoleCount =
    physicalHoleCount ?? getHeadlineBookableHoleCount(observedHoles.holeCounts);
  const headlinePrice = getHeadlineCoursePrice(
    priceEstimate,
    bookableHoleCount ? [bookableHoleCount] : []
  );
  const officialLinks = [...new Map(
    [
      course.website ? { href: course.website, label: "Official course website" } : null,
      course.detectedBookingUrl ? { href: course.detectedBookingUrl, label: "Official booking page" } : null
    ]
      .filter((link): link is { href: string; label: string } => Boolean(link))
      .map((link) => [link.href, link])
  ).values()];
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
    rating: course.rating ?? undefined,
    ratingObservedAt: course.ratingObservedAt?.toISOString(),
    par: course.par ?? undefined,
    parEvidenceUrl: course.parEvidenceUrl ?? undefined,
    parVerifiedAt: course.parVerifiedAt?.toISOString(),
    layoutHoleCounts: course.layoutHoleCounts.filter(
      (holes): holes is 9 | 18 => holes === 9 || holes === 18
    ),
    layoutHolesStatus: course.layoutHolesVerifiedAt ? "VERIFIED" as const : "UNVERIFIED" as const,
    layoutHolesEvidenceUrl: course.layoutHolesEvidenceUrl ?? undefined,
    layoutHolesVerifiedAt: course.layoutHolesVerifiedAt?.toISOString(),
    priceEstimate,
    bookableHoleCounts: observedHoles.holeCounts,
    bookableHoleCountsObservedAt: observedHoles.observedAt,
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
      <section className="knowledge-hero course-hero">
        <div className="knowledge-hero-inner">
          <nav aria-label="Breadcrumb" className="knowledge-breadcrumbs">
            <Link href="/">Home</Link><span>/</span>{hasConnecticutHub ? <><Link href="/locations/connecticut">Connecticut</Link><span>/</span></> : null}<span>{course.name}</span>
          </nav>
          <div className="knowledge-hero-copy">
            <p className="eyebrow">Course Guide</p>
            <h1>{course.name}</h1>
            <p className="knowledge-location"><MapPin aria-hidden="true" size={17} />{location}</p>
            <p className="knowledge-lede">{profile.accessSummary}</p>
            <div className="knowledge-pills">
              <span>{courseType}</span>
              <span>{course.isPublic ? "Public" : "Access restricted"}</span>
              {typeof course.rating === "number" ? (
                <span title={`Rating last observed ${formatDate(course.ratingObservedAt)}`}>
                  {course.rating.toFixed(1)} rating
                </span>
              ) : null}
              {bookableHoleCount ? (
                <span
                  title={
                    physicalHoleCount
                      ? `Physical layout verified ${formatDate(course.layoutHolesVerifiedAt)}`
                      : `Booking option last observed ${formatDateValue(observedHoles.observedAt)}`
                  }
                >
                  {bookableHoleCount}H
                </span>
              ) : null}
              {headlinePrice ? (
                <span
                  title={`Official ${headlinePrice.holes}-hole rates last observed ${formatDateValue(headlinePrice.range.observedAt ?? priceEstimate?.observedAt)}`}
                >
                  {formatCoursePriceRange(headlinePrice.range)}
                </span>
              ) : null}
            </div>
            <CourseProfileActions slug={profile.canonicalSlug} supported={supported} selectedCourse={selectedCourse} website={course.website} bookingUrl={course.detectedBookingUrl} showAlert={false} />
          </div>
        </div>
      </section>

      <div className="knowledge-layout">
        <article className="knowledge-article">
          <section>
            <p className="knowledge-kicker">Course overview</p>
            <h2>About {course.name}</h2>
            <p>{profile.overview}</p>
            <p>{profile.courseCharacter}</p>
            <SourceRefs sources={profile.sources} claims={["access", "overview", "course_character", "course_type"]} />
          </section>

          {publicNotableFacts.length > 0 ? <section>
            <p className="knowledge-kicker">At the facility</p>
            <h2>Facility highlights</h2>
            <ul className="knowledge-facts">{publicNotableFacts.map((fact) => <li key={fact}><CheckCircle2 aria-hidden="true" size={18} />{fact}</li>)}</ul>
            <SourceRefs sources={profile.sources} claims={profile.notableFacts.map((_, index) => `notable_fact_${index}`)} />
          </section> : null}

          <section>
            <p className="knowledge-kicker">Tee time booking</p>
            <h2>Booking at {course.name}</h2>
            <div className="knowledge-callout"><CalendarClock aria-hidden="true" size={24} /><div><strong>{bookingWindow.title}</strong><p>{bookingWindow.copy}</p>{bookingWindow.sourceUrl && bookingWindow.sourceLabel ? <a href={bookingWindow.sourceUrl} rel="noreferrer" target="_blank">{bookingWindow.sourceLabel} <ExternalLink aria-hidden="true" size={14} /></a> : null}</div></div>
            <p className="knowledge-date">Booking details reviewed {formatDate(course.bookingWindowCheckedAt ?? course.bookingWindowObservedAt ?? profile.profileVerifiedAt)}.</p>
          </section>

          <section>
            <p className="knowledge-kicker">Tee Time Spot alerts</p>
            <h2>Tee time alerts for {course.name}</h2>
            <p>{supported ? "Get notified when a public tee time matches your date, time, group size, and course preference." : getUnsupportedAlertCopy(course.automationReason, course.bookingAccessMode, course.bookingMethod)}</p>
            <p className="knowledge-date">Alert coverage reviewed {formatDate(course.intelligenceVerifiedAt ?? profile.profileVerifiedAt)}.</p>
            {supported ? <CourseProfileActions slug={profile.canonicalSlug} supported selectedCourse={selectedCourse} website={null} bookingUrl={null} /> : <Link className="button button-primary knowledge-inline-action" href="/search">Browse supported courses <ArrowRight size={16} /></Link>}
            <div className="knowledge-boundary">
              <Bell aria-hidden="true" size={22} />
              <div><strong>You book directly with the course.</strong><p>Tee Time Spot sends you to the official booking page; it does not reserve or book the tee time.</p></div>
            </div>
          </section>

          <section className="knowledge-references">
            <p className="knowledge-kicker">Course information</p>
            <h2>References</h2>
            <ul className="knowledge-reference-list">{profile.sources.map((source) => <li key={source.id}><a href={source.url} rel="noreferrer" target="_blank">{source.title}<ExternalLink aria-hidden="true" size={13} /></a><span>{source.publisher}</span></li>)}</ul>
            <p className="knowledge-date">Course information reviewed {verifiedLabel}.</p>
          </section>
        </article>

        <aside className="knowledge-aside">
          <h2>At a glance</h2>
          <dl><div><dt>Location</dt><dd>{location}</dd></div><div><dt>Access</dt><dd>{course.isPublic ? "Public" : "Restricted"}</dd></div><div><dt>Course type</dt><dd>{courseType}</dd></div>{typeof course.rating === "number" ? <div><dt>Rating</dt><dd>{course.rating.toFixed(1)} <small>last observed {formatDate(course.ratingObservedAt)}</small></dd></div> : null}{bookableHoleCount ? <div><dt>{physicalHoleCount ? "Physical layout" : "Booking options"}</dt><dd>{bookableHoleCount} holes</dd></div> : null}{headlinePrice ? <div><dt>Last observed rate</dt><dd>{formatCoursePriceRange(headlinePrice.range)} <small>{formatDateValue(headlinePrice.range.observedAt ?? priceEstimate?.observedAt)}</small></dd></div> : null}<div><dt>Tee time alerts</dt><dd>{supported ? "Available" : "Not currently available"}</dd></div></dl>
          <div className="knowledge-aside-links">{officialLinks.map((link) => <a href={link.href} key={link.href} rel="noreferrer" target="_blank">{link.label}<ArrowRight aria-hidden="true" size={14} /></a>)}</div>
        </aside>
      </div>

      {related.length > 0 ? <section className="knowledge-related"><div><p className="knowledge-kicker">Nearby coverage</p><h2>Other supported public courses nearby</h2></div><div className="knowledge-related-list">{related.map((item) => <Link href={`/courses/${item.profile?.canonicalSlug}`} key={item.id}><span>{item.city}, {item.stateCode}</span><strong>{item.name}</strong><small>{Math.round(item.distanceMiles)} miles away</small><ArrowRight aria-hidden="true" size={17} /></Link>)}</div></section> : null}

      <section className="knowledge-final-cta"><div><p className="eyebrow">Ready when an opening appears</p><h2>{supported ? `Watch ${course.name}` : "Build an alert around supported nearby courses"}</h2><p>Choose the courses and time window you can actually play. Tee Time Spot will email the official link when a matching opening appears.</p></div>{supported ? <CourseProfileActions slug={profile.canonicalSlug} supported selectedCourse={selectedCourse} website={null} bookingUrl={null} /> : <Link className="button button-primary" href="/search">Browse supported courses <ArrowRight size={16} /></Link>}</section>
    </main>
  );
}

function SourceRefs({ sources, claims }: { sources: Array<{ id: string; url: string; title: string; claimKeys: string[] }>; claims: string[] }) {
  const matching = sources.filter((source) => source.claimKeys.some((claim) => claims.includes(claim)));
  return matching.length > 0 ? <p className="knowledge-source-refs">Course details: {matching.map((source, index) => <span key={source.id}>{index > 0 ? ", " : ""}<a href={source.url} rel="noreferrer" target="_blank">{source.title}</a></span>)}</p> : null;
}

function formatCourseType(value: string | null) {
  return value ? value.toLowerCase().split("_").map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`).join(" ") : "Public golf course";
}

function formatDate(value: Date | null) {
  return value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(value) : "not yet verified";
}

function formatDateValue(value: string | undefined) {
  if (!value) return "an earlier check";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "an earlier check" : formatDate(date);
}

function formatCoursePriceRange(range: CoursePriceRange) {
  const format = (value: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: value % 100 === 0 ? 0 : 2
    }).format(value / 100);
  const minimum = format(range.minPriceCents);
  const maximum = format(range.maxPriceCents);
  return minimum === maximum ? minimum : `${minimum}–${maximum}`;
}
