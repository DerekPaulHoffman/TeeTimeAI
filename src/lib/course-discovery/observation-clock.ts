/** Only reader-produced timestamps cross machine clocks. Server lease,
 * deadline and receipt times never receive this allowance. */
export const READER_CLOCK_SKEW_MS = 5_000;

export function isReaderObservationCurrent(observed: number, issued: number, received: number) {
  return [observed, issued, received].every(Number.isFinite) && received >= issued &&
    observed >= issued - READER_CLOCK_SKEW_MS && observed <= received + READER_CLOCK_SKEW_MS;
}
