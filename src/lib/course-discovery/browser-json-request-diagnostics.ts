import { isSafePublicAvailabilityReadUrl } from "./public-availability-read-url";

const fieldCodes = {
  venue: "BROWSER_JSON_REQUEST_VENUE_MISMATCH",
  time_slot: "BROWSER_JSON_REQUEST_TIME_SLOT_MISMATCH",
  party_size: "BROWSER_JSON_REQUEST_PARTY_SIZE_MISMATCH",
  halo_size_interval: "BROWSER_JSON_REQUEST_HALO_SIZE_INTERVAL_MISMATCH",
  start_date: "BROWSER_JSON_REQUEST_START_DATE_MISMATCH",
  num_days: "BROWSER_JSON_REQUEST_NUM_DAYS_MISMATCH",
  channel: "BROWSER_JSON_REQUEST_CHANNEL_MISMATCH",
  selected_lang_code: "BROWSER_JSON_REQUEST_SELECTED_LANG_CODE_MISMATCH",
  picked_duration: "BROWSER_JSON_REQUEST_PICKED_DURATION_MISMATCH",
} as const;

export type BrowserJsonRequestMismatchCode = typeof fieldCodes[keyof typeof fieldCodes]
  | "BROWSER_JSON_REQUEST_MULTIPLE_FIELDS_MISMATCH"
  | "BROWSER_JSON_REQUEST_QUERY_ORDER_MISMATCH"
  | "BROWSER_JSON_REQUEST_URL_SERIALIZATION_MISMATCH"
  | `BROWSER_JSON_REQUEST_${"ACTUAL" | "SAVED"}_INPUT_MISMATCH`
  | `BROWSER_JSON_REQUEST_${"ACTUAL" | "SAVED"}_WINDOW_${"START" | "END" | "BOTH"}_UNCOVERED`
  | "BROWSER_JSON_REQUEST_OUTSIDE_CLOCK_SERIALIZATION_MISMATCH";
type RequestInput = { date: string; players: number; durationMinutes?: number; startTime: string; endTime: string };

/** Describes only an already-public SevenRooms range tuple. No URL, value,
 * permission, input match or response proof is returned. Invalid, duplicate,
 * unknown-key and foreign-source tuples remain outside this diagnostic role. */
export function describeBrowserJsonRequestMismatch(actual: { url: string; method: string },
  expected: { url: string; method: string }, bookingUrl: string,
  strictUrl: (value: string) => boolean, input?: RequestInput): BrowserJsonRequestMismatchCode | undefined {
  try {
    if (!isSafePublicAvailabilityReadUrl(actual.url, "fetch", actual.method, strictUrl) ||
        !isSafePublicAvailabilityReadUrl(expected.url, "fetch", expected.method, strictUrl) || !strictUrl(bookingUrl)) return;
    const booking = new URL(bookingUrl), observed = new URL(actual.url), saved = new URL(expected.url);
    const venue = /^\/reservations\/([a-z0-9]+(?:[-_][a-z0-9]+)*)$/u.exec(booking.pathname)?.[1];
    if (!bookingUrl.startsWith("https://www.sevenrooms.com/reservations/") ||
        booking.origin !== "https://www.sevenrooms.com" || booking.username || booking.password || booking.port || booking.hash ||
        !venue || observed.searchParams.get("venue") !== venue || saved.searchParams.get("venue") !== venue) return;
    if (input) {
      const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
      if (!/^[1-9]\d{3}-\d{2}-\d{2}$/u.test(input.date) || !clock.test(input.startTime) || !clock.test(input.endTime) ||
          input.startTime >= input.endTime || !Number.isInteger(input.players) || input.players < 1 || input.players > 4 ||
          !Number.isInteger(input.durationMinutes) || input.durationMinutes! < 15 || input.durationMinutes! > 480) return;
      const date = `${input.date.slice(5, 7)}-${input.date.slice(8)}-${input.date.slice(0, 4)}`;
      const tuples = [["ACTUAL", observed], ["SAVED", saved]] as const;
      for (const [side, tuple] of tuples)
        if (tuple.searchParams.get("party_size") !== String(input.players) || tuple.searchParams.get("picked_duration") !== String(input.durationMinutes) ||
            tuple.searchParams.get("start_date") !== date || tuple.searchParams.get("num_days") !== "1")
          return `BROWSER_JSON_REQUEST_${side}_INPUT_MISMATCH`;
      const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
      for (const [side, tuple] of tuples) {
        const center = minutes(tuple.searchParams.get("time_slot")!), radius = Number(tuple.searchParams.get("halo_size_interval")) * 15;
        const start = center - radius <= minutes(input.startTime), end = center + radius >= minutes(input.endTime);
        if (!start || !end) return `BROWSER_JSON_REQUEST_${side}_WINDOW_${!start && !end ? "BOTH" : !start ? "START" : "END"}_UNCOVERED`;
      }
      // Reproduce only the failed primary's existing validation comparison.
      // These codes never change its permission, match or response result.
      const withoutCenter = (url: string) => url.replace(/([?&]time_slot=)\d{2}:\d{2}(?=&|$)/u, "$1PUBLIC_CLOCK");
      return withoutCenter(actual.url) === withoutCenter(expected.url) ? undefined : "BROWSER_JSON_REQUEST_OUTSIDE_CLOCK_SERIALIZATION_MISMATCH";
    }
    // The existing closed URL guard proves both origins, paths, exact unique
    // query names and scalar syntax. Compare those public scalars only in RAM.
    const differences = (Object.keys(fieldCodes) as Array<keyof typeof fieldCodes>)
      .filter(key => observed.searchParams.get(key) !== saved.searchParams.get(key));
    if (differences.length > 1) return "BROWSER_JSON_REQUEST_MULTIPLE_FIELDS_MISMATCH";
    if (differences.length === 1) return fieldCodes[differences[0]];
    if (JSON.stringify([...observed.searchParams.keys()]) !== JSON.stringify([...saved.searchParams.keys()]))
      return "BROWSER_JSON_REQUEST_QUERY_ORDER_MISMATCH";
    if (actual.url !== expected.url) return "BROWSER_JSON_REQUEST_URL_SERIALIZATION_MISMATCH";
  } catch { /* Diagnostic failures never change the existing request outcome. */ }
}
