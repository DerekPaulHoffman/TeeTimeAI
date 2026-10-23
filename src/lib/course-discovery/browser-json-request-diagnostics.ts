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
  | "BROWSER_JSON_REQUEST_URL_SERIALIZATION_MISMATCH";

/** Describes only an already-public SevenRooms range tuple. No URL, value,
 * permission, input match or response proof is returned. Invalid, duplicate,
 * unknown-key and foreign-source tuples remain outside this diagnostic role. */
export function describeBrowserJsonRequestMismatch(actual: { url: string; method: string },
  expected: { url: string; method: string }, bookingUrl: string,
  strictUrl: (value: string) => boolean): BrowserJsonRequestMismatchCode | undefined {
  try {
    if (!isSafePublicAvailabilityReadUrl(actual.url, "fetch", actual.method, strictUrl) ||
        !isSafePublicAvailabilityReadUrl(expected.url, "fetch", expected.method, strictUrl) || !strictUrl(bookingUrl)) return;
    const booking = new URL(bookingUrl), observed = new URL(actual.url), saved = new URL(expected.url);
    const venue = /^\/reservations\/([a-z0-9]+(?:[-_][a-z0-9]+)*)$/u.exec(booking.pathname)?.[1];
    if (!bookingUrl.startsWith("https://www.sevenrooms.com/reservations/") ||
        booking.origin !== "https://www.sevenrooms.com" || booking.username || booking.password || booking.port || booking.hash ||
        !venue || observed.searchParams.get("venue") !== venue || saved.searchParams.get("venue") !== venue) return;
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
