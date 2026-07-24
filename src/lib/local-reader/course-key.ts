export function getLocalReaderCourseKey(bookingUrl: string | null | undefined) {
  try {
    const url = new URL(bookingUrl || "");
    return url.protocol === "https:" &&
      url.hostname === "grassyhill.cps.golf" &&
      /^\/(?:onlineresweb(?:\/search-teetime)?\/?)?$/u.test(url.pathname)
      ? ("grassy-hill" as const)
      : null;
  } catch {
    return null;
  }
}
