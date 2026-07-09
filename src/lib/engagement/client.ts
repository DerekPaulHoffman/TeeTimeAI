import type { WebsiteEventInput } from "./engagement";

export function trackWebsiteEvent(event: WebsiteEventInput) {
  const payload = JSON.stringify({
    ...event,
    page: event.page ?? getCurrentPage()
  });

  if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
    const blob = new Blob([payload], { type: "application/json" });
    navigator.sendBeacon("/api/analytics/events", blob);
    return;
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

  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}
