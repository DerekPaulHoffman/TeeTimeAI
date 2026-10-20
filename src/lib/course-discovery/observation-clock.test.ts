import { describe, expect, it } from "vitest";
import { isReaderObservationCurrent } from "./observation-clock";

describe("reader observation clock tolerance", () => {
  it.each([-2100, 0, 2100])("accepts a fresh observation with %ims reader skew without changing it", offset => {
    const observed = 10_100 + offset;
    expect(isReaderObservationCurrent(observed, 10_000, 10_200)).toBe(true);
    expect(observed).toBe(10_100 + offset);
  });
  it.each([4999, 15201, NaN, Infinity])("rejects stale or excessive future reader timestamps %s", observed => {
    expect(isReaderObservationCurrent(observed, 10_000, 10_200)).toBe(false);
  });
  it("rejects invalid or reversed server timestamps", () => {
    expect(isReaderObservationCurrent(10_000, NaN, 10_200)).toBe(false);
    expect(isReaderObservationCurrent(10_000, 10_200, 10_000)).toBe(false);
  });
});
