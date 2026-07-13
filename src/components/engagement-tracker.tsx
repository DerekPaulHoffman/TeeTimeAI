"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

import { trackWebsiteEvent } from "@/lib/engagement/client";

export function EngagementTracker() {
  const pathname = usePathname();

  useEffect(() => {
    trackWebsiteEvent({
      name: "page_viewed",
      page: pathname
    });
  }, [pathname]);

  useEffect(() => {
    function handleTrackedClick(event: MouseEvent) {
      const target = event.target instanceof Element ? event.target : null;
      const element = target?.closest<HTMLElement>("[data-analytics-event]");
      const name = element?.dataset.analyticsEvent;

      if (
        !element ||
        (name !== "start_search_clicked" &&
          name !== "dashboard_opened" &&
          name !== "email_preview_opened")
      ) {
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
