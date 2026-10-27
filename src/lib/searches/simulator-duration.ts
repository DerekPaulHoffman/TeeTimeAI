/** Null is an unrestricted session length; undefined remains a legacy default. */
export function simulatorDurationMatches(requested: number | null | undefined, actual: number) {
  return Number.isInteger(actual) && actual >= 30 && actual <= 480 && actual % 15 === 0 &&
    (requested == null || requested === actual);
}

export function simulatorDurationsForSearch(
  requested: number | null,
  supported: readonly number[],
  startTime = "00:00",
  endTime = "24:00",
) {
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const windowMinutes = minutes(endTime) - minutes(startTime);
  return [...new Set(supported)].filter(duration =>
    simulatorDurationMatches(requested, duration) && duration <= windowMinutes
  ).sort((a, b) => a - b);
}
