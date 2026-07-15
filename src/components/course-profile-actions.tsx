"use client";

import { Bell, ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";

import { trackWebsiteEvent } from "@/lib/engagement/client";
import { storeSearchPrefill, type SearchPrefill } from "@/lib/searches/search-prefill";

export function CourseProfileActions({
  slug,
  supported,
  selectedCourse,
  website,
  bookingUrl
}: {
  slug: string;
  supported: boolean;
  selectedCourse: NonNullable<SearchPrefill["selectedCourse"]>;
  website: string | null;
  bookingUrl: string | null;
}) {
  const router = useRouter();
  const officialLinks = [...new Map(
    [
      website ? { href: website, label: "Official course website" } : null,
      bookingUrl ? { href: bookingUrl, label: "Official booking page" } : null
    ].filter((link): link is { href: string; label: string } => Boolean(link)).map((link) => [link.href, link])
  ).values()];

  function startAlert() {
    trackWebsiteEvent({ name: "course_profile_alert_clicked", metadata: { slug } });
    storeSearchPrefill({
      location: [selectedCourse.city, selectedCourse.stateCode].filter(Boolean).join(", "),
      coordinates: { latitude: selectedCourse.latitude, longitude: selectedCourse.longitude },
      selectedCourse
    });
    router.push("/search");
  }

  return (
    <div className="knowledge-actions">
      {supported ? (
        <button className="button button-primary" onClick={startAlert} type="button">
          <Bell aria-hidden="true" size={17} />
          Create an alert here
        </button>
      ) : null}
      {officialLinks.map((link) => (
        <a
          className="button button-ghost"
          href={link.href}
          key={link.href}
          onClick={() => trackWebsiteEvent({ name: "course_profile_official_link_clicked", metadata: { slug } })}
          rel="noreferrer"
          target="_blank"
        >
          {link.label}
          <ExternalLink aria-hidden="true" size={15} />
        </a>
      ))}
    </div>
  );
}
