export type SimulatorProviderOffering = {
  id: string;
  courseId: string;
  bookingUrl: string;
  providerFamilyKey: string | null;
  providerMetadata: unknown;
  maxPartySize: number | null;
  supportedDurationsMinutes: number[];
};

export type SimulatorAvailabilityInput = {
  offering: SimulatorProviderOffering;
  /** A calendar date in the venue's timezone, never the recipient's timezone. */
  date: string;
  durationMinutes: number;
  partySize: number;
  timeZone: string;
};

export type SimulatorAvailabilitySlot = {
  sourceId: string;
  offeringId: string;
  /** ANY denotes provider-computed pooled availability, not a named bay. */
  resourceId: string;
  productId: string;
  startsAt: Date;
  endsAt: Date;
  maxPartySize: number | null;
  bookingUrl: string;
};

export type SimulatorAvailabilityResult = {
  slots: SimulatorAvailabilitySlot[];
  complete: true;
  observedAt: Date;
  evidenceUrl: string;
};

export type SimulatorAvailabilityErrorCode =
  | "INVALID_SOURCE"
  | "INVALID_REQUEST"
  | "UNSUPPORTED_PROVIDER"
  | "UNSUPPORTED_DURATION"
  | "PARTY_TOO_LARGE"
  | "PUBLIC_SESSION_REQUIRED"
  | "HTTP_ERROR"
  | "SCHEMA_CHANGED";

/** Errors contain bounded classifications, never provider bodies or session data. */
export class SimulatorAvailabilityError extends Error {
  constructor(
    readonly code: SimulatorAvailabilityErrorCode,
    message: string,
    readonly retryable = false,
    readonly httpStatus?: number,
    readonly retryAfter?: string | null
  ) {
    super(message);
    this.name = "SimulatorAvailabilityError";
  }
}
