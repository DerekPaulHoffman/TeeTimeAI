"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

import { trackWebsiteEvent } from "@/lib/engagement/client";
import type { WebsiteEventInput } from "@/lib/engagement/engagement";

export function EngagementTracker() {
  const pathname = usePathname();

  useEffect(() => {
    const search = window.location.search;
    const hash = window.location.hash;
    trackWebsiteEvent({
      name: "page_viewed",
      page: `${pathname}${search}${hash}`
    });
  }, [pathname]);

  useEffect(() => {
    function handleTrackedClick(event: MouseEvent) {
      const target = event.target instanceof Element ? event.target : null;
      const element = target?.closest<HTMLElement>("[data-analytics-event]");
      const name = element?.dataset.analyticsEvent as WebsiteEventInput["name"] | undefined;

      if (!element || !name) {
        return;
      }

      trackWebsiteEvent({
        name,
        metadata: {
          label: element.innerText.trim().slice(0, 120)
        }
      });
    }

    document.addEventListener("click", handleTrackedClick);
    return () => document.removeEventListener("click", handleTrackedClick);
  }, []);

  return null;
}
