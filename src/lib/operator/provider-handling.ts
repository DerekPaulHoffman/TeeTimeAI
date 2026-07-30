type ProviderHandlingInput = {
  providerFamilyKey: string;
  monitoringMode: string;
  automationEligibility: string;
  bookingMethod: string;
};

export type ProviderHandling = {
  title: string;
  description: string;
};

export function getProviderHandling({
  providerFamilyKey,
  monitoringMode,
  automationEligibility,
  bookingMethod
}: ProviderHandlingInput): ProviderHandling {
  const provider = formatProvider(providerFamilyKey);

  if (monitoringMode === "LOCAL_READER_ONLY") {
    return {
      title: "Local reader is the tee-time data path",
      description: `The AI queues a local Chrome reader job for ${provider}. It opens the public booking page signed out, extracts the tee times, and returns normalized availability without entering checkout.`
    };
  }

  if (monitoringMode === "BROWSER_ONLY") {
    return {
      title: "Signed-out browser is the tee-time data path",
      description: `The AI opens ${provider}'s public booking surface in a signed-out browser, reads the visible tee times, and normalizes them for saved-alert matching.`
    };
  }

  if (monitoringMode === "CONTACT_ONLY") {
    return {
      title: "No automatic tee-time data is collected",
      description:
        bookingMethod === "PHONE_ONLY" || bookingMethod === "CONTACT_COURSE"
          ? `Tee Time Spot keeps ${provider} as the course's booking provider, but directs golfers to the course because availability requires a phone call or manual contact.`
          : `Tee Time Spot keeps ${provider} on the course record, but the saved final state prevents automatic reads. Golfers use the official course or booking link directly.`
    };
  }

  if (automationEligibility === "ALLOWED") {
    return {
      title: "Server adapter is the tee-time data path",
      description: `The AI will use Tee Time Spot's ${provider} adapter to read public signed-out availability, normalize the returned slots, and compare them with each golfer's saved alert.`
    };
  }

  if (providerFamilyKey === "SOURCE_MISSING") {
    return {
      title: "AI is identifying the provider",
      description:
        "No provider is saved yet. The AI checks the official links, identifies the tee-sheet system, and then uses an existing adapter or creates provider-support work for a reusable read path."
    };
  }

  return {
    title: "AI is verifying the provider connection",
    description: `The AI rechecks the official links and ${provider} metadata first. If the existing adapter is runnable it reads public signed-out availability; otherwise it creates provider-support work. It will not log in or enter checkout.`
  };
}

function formatProvider(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
