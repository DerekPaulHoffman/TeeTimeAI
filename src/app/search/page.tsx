import { currentUser } from "@clerk/nextjs/server";

import { StructuredData } from "@/components/structured-data";
import { TeeTimeIntake } from "@/components/tee-time-intake";
import { getClerkPublishableKey, hasClerkConfig } from "@/lib/env";
import { isSimulatorModeEnabled } from "@/lib/simulators/config";
import "leaflet/dist/leaflet.css";
import "../pricing.css";

import {
  searchPageMetadata,
  searchStructuredData
} from "./search-page-seo";

export const metadata = searchPageMetadata;

export default async function SearchPage({ searchParams }: { searchParams?: Promise<{ mode?: string }> } = {}) {
  const requestedMode = (await searchParams)?.mode;
  const simulatorEnabled = isSimulatorModeEnabled();
  const simulatorSelected = requestedMode?.toUpperCase() === "SIMULATOR" && simulatorEnabled;
  const accountEnabled = hasClerkConfig();
  const clerkUser = accountEnabled ? await currentUser() : null;
  const accountEmail = clerkUser?.primaryEmailAddress?.emailAddress;

  return (
    <main className="search-page">
      <StructuredData data={searchStructuredData} />
      <TeeTimeIntake
        showPageHeader
        simulatorEnabled={simulatorEnabled}
        initialValues={{ mode: simulatorSelected ? "SIMULATOR" : "OUTDOOR" }}
        accountEmail={accountEmail}
        accountEnabled={accountEnabled}
        accountSignedIn={Boolean(clerkUser)}
        clerkPublishableKey={getClerkPublishableKey()}
      />
    </main>
  );
}
