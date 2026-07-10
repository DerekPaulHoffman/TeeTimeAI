import type { Metadata } from "next";

import { TeeTimeIntake, type TeeTimeIntakeInitialValues } from "@/components/tee-time-intake";
import { hasClerkConfig } from "@/lib/env";
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
    radius: Number.isFinite(radius) && radius >= 1 && radius <= 50 ? radius : undefined,
    holes: holes === "9" || holes === "18" || holes === "any" ? holes : undefined,
    coordinates:
      Number.isFinite(latitude) && Number.isFinite(longitude)
        ? { latitude, longitude }
        : undefined
  };

  return (
    <main className="search-page">
      <div className="search-page-header">
        <p className="eyebrow">Set up your alert</p>
        <h1>Tell us where and when you want to play.</h1>
      </div>
      <TeeTimeIntake accountEnabled={hasClerkConfig()} initialValues={initialValues} />
    </main>
  );
}
