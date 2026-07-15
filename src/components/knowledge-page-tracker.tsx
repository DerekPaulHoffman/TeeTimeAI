"use client";

import { useEffect } from "react";

import { trackWebsiteEvent } from "@/lib/engagement/client";

export function KnowledgePageTracker({ kind, slug }: { kind: "course" | "location"; slug: string }) {
  useEffect(() => {
    trackWebsiteEvent({
      name: kind === "course" ? "course_profile_viewed" : "location_page_viewed",
      metadata: { slug }
    });
  }, [kind, slug]);
  return null;
}
