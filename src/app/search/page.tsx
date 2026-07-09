import type { Metadata } from "next";

import { TeeTimeIntake } from "@/components/tee-time-intake";
import { siteDescription } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Search Tee Times",
  description: siteDescription,
  alternates: {
    canonical: "/search"
  }
};

export default function SearchPage() {
  return (
    <main className="search-page">
      <div className="search-page-header">
        <p className="eyebrow" style={{ color: "var(--fairway-dark)" }}>
          New search
        </p>
        <h1>Choose the courses we should watch first.</h1>
        <p>
          Search nearby public courses, tap the ones you want, then rank your favorites so
          Tee Time Spot checks them in the right order.
        </p>
      </div>
      <TeeTimeIntake />
    </main>
  );
}
