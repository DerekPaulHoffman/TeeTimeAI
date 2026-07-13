import type { Metadata } from "next";
import Link from "next/link";
import { Flag } from "lucide-react";

import { OptionalClerkProvider } from "@/components/optional-clerk-provider";
import { AuthNav } from "@/components/auth-nav";
import { EngagementTracker } from "@/components/engagement-tracker";
import { FeedbackWidget } from "@/components/feedback-widget";
import { SiteFooter } from "@/components/site-footer";
import { SiteObservability } from "@/components/site-observability";
import { hasClerkConfig } from "@/lib/env";
import {
  absoluteUrl,
  getSiteVerification,
  siteDescription,
  siteName,
  siteUrl
} from "@/lib/seo";
import "leaflet/dist/leaflet.css";
import "./globals.css";
import "./pricing.css";
import "./editorial.css";

export const metadata: Metadata = {
  metadataBase: siteUrl,
  applicationName: siteName,
  title: {
    default: `${siteName} | Public Golf Tee Time Alerts`,
    template: `%s | ${siteName}`
  },
  description: siteDescription,
  keywords: [
    "tee time alerts",
    "public golf tee times",
    "golf tee time finder",
    "golf course alerts",
    "tee time notifications"
  ],
  alternates: {
    canonical: "/"
  },
  openGraph: {
    title: `${siteName} | Public Golf Tee Time Alerts`,
    description: siteDescription,
    url: absoluteUrl("/"),
    siteName,
    images: [
      {
        url: absoluteUrl("/opengraph-image"),
        width: 1200,
        height: 630,
        alt: "Tee Time Spot public golf tee time alerts"
      }
    ],
    locale: "en_US",
    type: "website"
  },
  twitter: {
    card: "summary_large_image",
    title: `${siteName} | Public Golf Tee Time Alerts`,
    description: siteDescription,
    images: [absoluteUrl("/opengraph-image")]
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1
    }
  },
  verification: getSiteVerification(),
  category: "sports"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const clerkEnabled = hasClerkConfig();

  return (
    <html lang="en">
      <body>
        <OptionalClerkProvider enabled={clerkEnabled}>
          <div className="site-shell">
            <header className="topbar">
              <Link className="brand" href="/" aria-label="Tee Time Spot home">
                <span className="brand-mark" aria-hidden="true">
                  <Flag size={18} />
                </span>
                <span className="brand-text">Tee Time Spot</span>
              </Link>
              <AuthNav clerkEnabled={clerkEnabled} />
            </header>
            <EngagementTracker />
            {children}
            <FeedbackWidget />
            <SiteFooter />
          </div>
        </OptionalClerkProvider>
        <SiteObservability enabled={Boolean(process.env.VERCEL_URL)} />
      </body>
    </html>
  );
}
