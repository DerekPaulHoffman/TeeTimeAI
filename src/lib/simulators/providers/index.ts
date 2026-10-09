import { fetchGolfLounge18Availability } from "./golf-lounge-18";
import { fetchGolfBookAvailability } from "./golfbook";
import { fetchAcuitySimulatorAvailability } from "./acuity";
import { fetchYourGolfBookingAvailability } from "./your-golf-booking";
import { fetchUScheduleAvailability } from "./uschedule";
import { SimulatorAvailabilityError, type SimulatorAvailabilityInput } from "./types";

export type { SimulatorAvailabilityInput, SimulatorAvailabilityResult, SimulatorAvailabilitySlot, SimulatorProviderOffering } from "./types";
export { SimulatorAvailabilityError } from "./types";

export const RUNNABLE_SIMULATOR_PROVIDER_FAMILIES = ["GOLF_LOUNGE_18", "GOLFBOOK", "ACUITY", "YOUR_GOLF_BOOKING", "USCHEDULE"] as const;

export function fetchSimulatorAvailability(input: SimulatorAvailabilityInput, fetchImpl: typeof fetch = fetch) {
  if (input.offering.providerFamilyKey === "GOLF_LOUNGE_18") {
    return fetchGolfLounge18Availability(input, fetchImpl);
  }
  if (input.offering.providerFamilyKey === "GOLFBOOK") {
    return fetchGolfBookAvailability(input, fetchImpl);
  }
  if (input.offering.providerFamilyKey === "ACUITY") {
    return fetchAcuitySimulatorAvailability(input, fetchImpl);
  }
  if (input.offering.providerFamilyKey === "YOUR_GOLF_BOOKING") {
    return fetchYourGolfBookingAvailability(input, fetchImpl);
  }
  if (input.offering.providerFamilyKey === "USCHEDULE") {
    return fetchUScheduleAvailability(input, fetchImpl);
  }
  throw new SimulatorAvailabilityError("UNSUPPORTED_PROVIDER", "Public simulator availability support is still being verified for this booking source");
}
