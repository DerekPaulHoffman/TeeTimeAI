import type { Metadata } from "next";
import Image from "next/image";

import { TeeTimeIntake, type TeeTimeIntakeInitialValues } from "@/components/tee-time-intake";
import { hasClerkConfig } from "@/lib/env";
import {
  MAX_COURSE_SEARCH_RADIUS_MILES,
  MIN_COURSE_SEARCH_RADIUS_MILES
} from "@/lib/places/radius";
import { siteDescription } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Search Tee Times",
  description: siteDescription,
  alternates: {
    canonical: "/search"
  }
};

function valueOf(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SearchPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const players = Number(valueOf(params.players));
  const radius = Number(valueOf(params.radius));
  const latitude = Number(valueOf(params.latitude));
  const longitude = Number(valueOf(params.longitude));
  const holes = valueOf(params.holes);
  const initialValues: TeeTimeIntakeInitialValues = {
    location: valueOf(params.location),
    date: valueOf(params.date),
    startTime: valueOf(params.startTime),
    endTime: valueOf(params.endTime),
    players: Number.isInteger(players) && players >= 1 && players <= 4 ? players : undefined,
    radius:
      Number.isFinite(radius) &&
      radius >= MIN_COURSE_SEARCH_RADIUS_MILES &&
      radius <= MAX_COURSE_SEARCH_RADIUS_MILES
        ? radius
        : undefined,
    holes: holes === "9" || holes === "18" || holes === "any" ? holes : undefined,
    coordinates:
      Number.isFinite(latitude) && Number.isFinite(longitude)
        ? { latitude, longitude }
        : undefined
  };

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
      <TeeTimeIntake accountEnabled={hasClerkConfig()} initialValues={initialValues} />
    </main>
  );
}
