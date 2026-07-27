import Image from "next/image";
import { currentUser } from "@clerk/nextjs/server";

import { StructuredData } from "@/components/structured-data";
import { TeeTimeIntake } from "@/components/tee-time-intake";
import { getClerkPublishableKey, hasClerkConfig } from "@/lib/env";
import {
  buildPageMetadata,
  buildPageStructuredData
} from "@/lib/seo";
import "leaflet/dist/leaflet.css";
import "../pricing.css";

const title = "Find Public Golf Tee Times & Set Free Alerts";
const description =
  "Search nearby public golf courses, rank up to five, and create a free email alert for your preferred date, time window, and group size.";
const path = "/search";

export const metadata = buildPageMetadata({
  title,
  description,
  path
});

export const searchStructuredData = buildPageStructuredData({
  name: title,
  description,
  path,
  type: "WebPage"
});

export default async function SearchPage() {
  const accountEnabled = hasClerkConfig();
  const clerkUser = accountEnabled ? await currentUser() : null;
  const accountEmail = clerkUser?.primaryEmailAddress?.emailAddress;

  return (
    <main className="search-page">
      <StructuredData data={searchStructuredData} />
      <div className="search-page-header">
        <Image
          alt=""
          className="search-page-header-image"
          fetchPriority="high"
          fill
          loading="eager"
          quality={50}
          sizes="100vw"
          src="https://images.unsplash.com/photo-1535131749006-b7f58c99034b?auto=format&fit=crop&w=2400&q=80"
        />
        <p className="eyebrow">Set up your alert</p>
        <h1>Tell us where and when you want to play.</h1>
        <p className="search-page-header-copy">
          Search nearby public golf courses and create a free tee-time alert.
          When a matching opening appears, we email the official booking link
          and you book directly with the course.
        </p>
      </div>
      <TeeTimeIntake
        accountEmail={accountEmail}
        accountEnabled={accountEnabled}
        accountSignedIn={Boolean(clerkUser)}
        clerkPublishableKey={getClerkPublishableKey()}
      />
    </main>
  );
}
