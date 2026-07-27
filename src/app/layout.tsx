import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { Inter } from "next/font/google";
import Image from "next/image";
import Link from "next/link";

import { AuthNav } from "@/components/auth-nav";
import { EngagementTracker } from "@/components/engagement-tracker";
import { FeedbackWidget } from "@/components/feedback-widget";
import { SiteFooter } from "@/components/site-footer";
import { SiteObservability } from "@/components/site-observability";
import { getClerkPublishableKey } from "@/lib/env";
import {
  absoluteUrl,
  getSiteVerification,
  siteDescription,
  siteName,
  siteUrl,
  socialImageAlt,
  socialImagePath,
  socialTitle
} from "@/lib/seo";
import "./globals.css";
import "./shell.css";

const inter = Inter({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-inter"
});

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
    title: socialTitle,
    description: siteDescription,
    url: absoluteUrl("/"),
    siteName,
    images: [
      {
        url: absoluteUrl(socialImagePath),
        width: 1200,
        height: 630,
        alt: socialImageAlt
      }
    ],
    locale: "en_US",
    type: "website"
  },
  twitter: {
    card: "summary_large_image",
    title: socialTitle,
    description: siteDescription,
    images: [absoluteUrl(socialImagePath)]
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

export default async function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  const clerkPublishableKey = getClerkPublishableKey();
  const clerkEnabled = Boolean(clerkPublishableKey);
  const { userId } = clerkEnabled ? await auth() : { userId: null };

  return (
    <html data-scroll-behavior="smooth" lang="en">
      <body className={inter.variable}>
        <div className="site-shell">
            <header className="topbar">
              <Link className="brand" href="/" aria-label="Tee Time Spot home">
                <span className="brand-mark" aria-hidden="true">
                  <Image alt="" height={38} priority src="/icon.svg" width={38} />
                </span>
                <span className="brand-text">Tee Time Spot</span>
              </Link>
              <AuthNav
                clerkEnabled={clerkEnabled}
                publishableKey={clerkPublishableKey}
                userId={userId}
              />
            </header>
            <EngagementTracker />
            {children}
            <FeedbackWidget />
            <SiteFooter />
        </div>
        <SiteObservability enabled={Boolean(process.env.VERCEL_URL)} />
      </body>
    </html>
  );
}
