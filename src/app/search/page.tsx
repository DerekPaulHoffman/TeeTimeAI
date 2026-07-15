import Image from "next/image";

import { TeeTimeIntake } from "@/components/tee-time-intake";
import { hasClerkConfig } from "@/lib/env";
import { buildPageMetadata } from "@/lib/seo";

export const metadata = buildPageMetadata({
  title: "Search Tee Times",
  description:
    "Search nearby public golf courses, rank up to five, and set a free email alert for the date, time window, and group size you want.",
  path: "/search"
});

export default function SearchPage() {
  return (
    <main className="search-page">
      <div className="search-page-header">
        <Image
          alt=""
          className="search-page-header-image"
          fetchPriority="high"
          fill
          loading="eager"
          quality={75}
          sizes="100vw"
          src="https://images.unsplash.com/photo-1535131749006-b7f58c99034b?auto=format&fit=crop&w=2400&q=80"
        />
        <p className="eyebrow">Set up your alert</p>
        <h1>Tell us where and when you want to play.</h1>
      </div>
      <TeeTimeIntake accountEnabled={hasClerkConfig()} />
    </main>
  );
}
