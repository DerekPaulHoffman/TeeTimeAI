"use client";

import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

import { sanitizePagePath } from "@/lib/engagement/page-path";
import { detectWebsiteTrafficClass } from "@/lib/engagement/traffic-class";

type ObservableUrlEvent = {
  url: string;
};

/**
 * Keeps provider telemetry aggregate-only: synthetic traffic is excluded and
 * query strings/fragments never leave the browser.
 */
export function sanitizeObservabilityEvent<T extends ObservableUrlEvent>(event: T): T | null {
  if (detectWebsiteTrafficClass() !== "PUBLIC") {
    return null;
  }

  const pathname = sanitizePagePath(event.url);
  if (!pathname || typeof window === "undefined") {
    return null;
  }

  try {
    const eventUrl = new URL(event.url, window.location.origin);
    if (eventUrl.origin !== window.location.origin) {
      return null;
    }
  } catch {
    return null;
  }

  return {
    ...event,
    url: new URL(pathname, window.location.origin).toString()
  };
}

export function SiteObservability({ enabled }: { enabled: boolean }) {
  if (!enabled) {
    return null;
  }

  return (
    <>
      <Analytics
        beforeSend={(event: BeforeSendEvent) => sanitizeObservabilityEvent(event)}
      />
      <SpeedInsights beforeSend={(event) => sanitizeObservabilityEvent(event)} />
    </>
  );
}
