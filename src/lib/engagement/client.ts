import type { WebsiteEventInput } from "./engagement";
import { sanitizePagePath } from "./page-path";
import { detectWebsiteTrafficClass } from "./traffic-class";

export function trackWebsiteEvent(event: WebsiteEventInput) {
  const payload = JSON.stringify({
    ...event,
    page: sanitizePagePath(event.page) ?? getCurrentPage(),
    trafficClass: detectWebsiteTrafficClass()
  });

  if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
    try {
      const blob = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon("/api/analytics/events", blob)) {
        return;
      }
    } catch {
      // Fall through to a keepalive request when beacon queuing is unavailable.
    }
  }

  void fetch("/api/analytics/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true
  }).catch(() => {
    // Analytics should never block the product workflow.
  });
}

function getCurrentPage() {
  if (typeof window === "undefined") {
    return undefined;
  }

  return sanitizePagePath(window.location.pathname);
}
